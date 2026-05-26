import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, CircleMarker, Tooltip, Polyline, Pane, ZoomControl, useMap } from 'react-leaflet';
import axios from 'axios';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

const PARALLEL_LINE_SPACING_METERS = 9;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const TRAINS_REFRESH_MS = 1000;
const ANIMATION_TICK_MS = 200;
const METERS_PER_DEG_LAT = 111320;
const BACKWARD_PROGRESS_TOLERANCE = 0.03;
const MOVING_POSITION_HOLD_MS = 12000;
const MAX_TRAIN_SPEED_MPS = 45;
const MIN_POSITION_STEP_METERS = 6;
const MOVEMENT_STATE_CACHE = new Map();
const MOTION_PLAN_SELECTION_CACHE = new Map();
const DEFAULT_CENTER = [40.7128, -74.0060];
const DEFAULT_ZOOM = 12;
const LOCATE_ZOOM = 15;
const SEARCH_STATION_ZOOM = 15;
const SEARCH_TRAIN_ZOOM = 14;
const STATION_LINE_MATCH_THRESHOLD_METERS = 140;

const BASEMAPS = {
  light: {
    base: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
    labels: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
    markerBorder: '#ffffff',
    stationFill: '#1f1f1f',
  },
  dark: {
    base: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    labels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
    markerBorder: '#0f141a',
    stationFill: '#d5dae0',
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isFiniteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRenderablePath(path) {
  return Array.isArray(path) && path.length > 1;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function metersPerDegLngAtLat(lat) {
  return Math.max(1, METERS_PER_DEG_LAT * Math.cos(toRad(lat)));
}

function toXYMeters(lat, lng, originLat) {
  return {
    x: lng * metersPerDegLngAtLat(originLat),
    y: lat * METERS_PER_DEG_LAT,
  };
}

function pointToLatLng(point) {
  if (!point) {
    return null;
  }

  const latitude = Number(point.latitude);
  const longitude = Number(point.longitude);
  if (!isFiniteCoordinate(latitude) || !isFiniteCoordinate(longitude)) {
    return null;
  }

  return [latitude, longitude];
}

function buildPathMetrics(path) {
  const cumulative = [0];

  for (let i = 1; i < path.length; i += 1) {
    const prev = path[i - 1];
    const curr = path[i];
    const avgLat = (prev[0] + curr[0]) / 2;
    const prevXY = toXYMeters(prev[0], prev[1], avgLat);
    const currXY = toXYMeters(curr[0], curr[1], avgLat);
    const segmentLength = Math.hypot(currXY.x - prevXY.x, currXY.y - prevXY.y);
    cumulative.push(cumulative[cumulative.length - 1] + segmentLength);
  }

  return {
    path,
    cumulative,
    totalLength: cumulative[cumulative.length - 1],
  };
}

function projectPointToPolyline(metrics, latLng) {
  const path = metrics.path;
  let best = null;

  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const originLat = (a[0] + b[0]) / 2;

    const aXY = toXYMeters(a[0], a[1], originLat);
    const bXY = toXYMeters(b[0], b[1], originLat);
    const pXY = toXYMeters(latLng[0], latLng[1], originLat);

    const abx = bXY.x - aXY.x;
    const aby = bXY.y - aXY.y;
    const apx = pXY.x - aXY.x;
    const apy = pXY.y - aXY.y;
    const ab2 = abx * abx + aby * aby;

    const t = ab2 > 0 ? clamp((apx * abx + apy * aby) / ab2, 0, 1) : 0;
    const projX = aXY.x + abx * t;
    const projY = aXY.y + aby * t;
    const distance = Math.hypot(pXY.x - projX, pXY.y - projY);
    const distanceAlong = metrics.cumulative[i] + Math.sqrt(ab2) * t;

    if (!best || distance < best.distance) {
      best = { distance, distanceAlong };
    }
  }

  return best;
}

function pointAtDistanceAlongPolyline(metrics, distanceAlong) {
  const { path, cumulative, totalLength } = metrics;
  if (path.length < 2 || totalLength <= 0) {
    return path[0] || null;
  }

  const clamped = clamp(distanceAlong, 0, totalLength);

  for (let i = 0; i < cumulative.length - 1; i += 1) {
    const segStart = cumulative[i];
    const segEnd = cumulative[i + 1];
    if (clamped <= segEnd || i === cumulative.length - 2) {
      const segmentLength = Math.max(segEnd - segStart, 1e-6);
      const t = clamp((clamped - segStart) / segmentLength, 0, 1);
      const a = path[i];
      const b = path[i + 1];
      return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ];
    }
  }

  return path[path.length - 1];
}

function toRenderableTrainEntity(entity) {
  const vehicle = entity?.vehicle;
  const position = vehicle?.position;
  const trip = vehicle?.trip;
  const routeId = String(trip?.routeId || '').trim();

  if (!vehicle || !position || !trip || !routeId) {
    return null;
  }

  if (!isFiniteCoordinate(position.latitude) || !isFiniteCoordinate(position.longitude)) {
    return null;
  }

  const trainId = trip['.transit_realtime.nyctTripDescriptor']?.trainId || null;
  const tripId = String(trip.tripId || '').trim() || null;
  const stableId = String(trainId || (tripId ? `${routeId}:${tripId}` : '') || entity.id || `${routeId}-unknown`);

  return {
    id: stableId,
    routeId,
    trainId,
    tripId,
    latitude: position.latitude,
    longitude: position.longitude,
    positionSource: vehicle.positionSource || null,
    estimatedFromPosition: vehicle.estimatedFromPosition || null,
    estimatedToPosition: vehicle.estimatedToPosition || null,
    estimatedFromStopId: vehicle.estimatedFromStopId || null,
    estimatedToStopId: vehicle.estimatedToStopId || null,
    estimatedSegmentStartSec: vehicle.estimatedSegmentStartSec ?? null,
    estimatedSegmentEndSec: vehicle.estimatedSegmentEndSec ?? null,
    estimatedMinutesToNextStop: vehicle.estimatedMinutesToNextStop ?? null,
    estimatedFirstStopId: vehicle.estimatedFirstStopId ?? null,
    estimatedFirstStopDepartureSec: vehicle.estimatedFirstStopDepartureSec ?? null,
  };
}

function limitPositionStep(previousPosition, candidatePosition, previousUpdatedAtMs, nowMs) {
  if (!previousPosition || !Array.isArray(candidatePosition)) {
    return candidatePosition;
  }

  const dtMs = Math.max(ANIMATION_TICK_MS, nowMs - (previousUpdatedAtMs || nowMs));
  const maxStepMeters = Math.max(MIN_POSITION_STEP_METERS, (dtMs / 1000) * MAX_TRAIN_SPEED_MPS);

  const avgLat = (previousPosition[0] + candidatePosition[0]) / 2;
  const prevXY = toXYMeters(previousPosition[0], previousPosition[1], avgLat);
  const candXY = toXYMeters(candidatePosition[0], candidatePosition[1], avgLat);
  const dx = candXY.x - prevXY.x;
  const dy = candXY.y - prevXY.y;
  const distance = Math.hypot(dx, dy);

  if (!Number.isFinite(distance) || distance <= maxStepMeters) {
    return candidatePosition;
  }

  const t = maxStepMeters / distance;
  return [
    previousPosition[0] + (candidatePosition[0] - previousPosition[0]) * t,
    previousPosition[1] + (candidatePosition[1] - previousPosition[1]) * t,
  ];
}

function getEstimatedSegmentKey(train) {
  const fromStopId = String(train.estimatedFromStopId || '').trim();
  const toStopId = String(train.estimatedToStopId || '').trim();
  if (fromStopId && toStopId) {
    return `${fromStopId}->${toStopId}`;
  }

  const from = train.estimatedFromPosition;
  const to = train.estimatedToPosition;
  if (!from || !to) {
    return null;
  }

  const fromLat = Number(from.latitude);
  const fromLng = Number(from.longitude);
  const toLat = Number(to.latitude);
  const toLng = Number(to.longitude);
  if (!isFiniteCoordinate(fromLat) || !isFiniteCoordinate(fromLng) || !isFiniteCoordinate(toLat) || !isFiniteCoordinate(toLng)) {
    return null;
  }

  return `${fromLat.toFixed(5)},${fromLng.toFixed(5)}->${toLat.toFixed(5)},${toLng.toFixed(5)}`;
}

function getTimeProgress(train, nowMs) {
  const startSec = Number(train.estimatedSegmentStartSec);
  const endSec = Number(train.estimatedSegmentEndSec);

  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return null;
  }

  const startMs = startSec * 1000;
  const endMs = endSec * 1000;
  return clamp((nowMs - startMs) / (endMs - startMs), 0.02, 0.98);
}

function formatUnixSeconds(seconds) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return new Date(numeric * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getAnimatedTrainPosition(train, nowMs, motionPlanByTrainId) {
  if (train.positionSource !== 'estimated_between_stops') {
    return [train.latitude, train.longitude];
  }

  const progress = getTimeProgress(train, nowMs);
  if (!Number.isFinite(progress)) {
    return [train.latitude, train.longitude];
  }

  const pathPlan = motionPlanByTrainId.get(train.id);
  if (pathPlan) {
    const distanceAlong =
      pathPlan.fromDistanceAlong +
      (pathPlan.toDistanceAlong - pathPlan.fromDistanceAlong) * progress;
    const pathPoint = pointAtDistanceAlongPolyline(pathPlan.metrics, distanceAlong);
    if (pathPoint) {
      return pathPoint;
    }
  }

  // Keep estimated trains anchored to known track geometry when no motion plan exists.
  return [train.latitude, train.longitude];
}

function routeIdCandidates(routeId) {
  const raw = String(routeId || '').trim().toUpperCase();
  if (!raw) {
    return [];
  }

  const candidates = new Set([raw]);
  candidates.add(raw.replace(/X$/, ''));
  candidates.add(raw.replace(/[^A-Z0-9]/g, ''));

  return Array.from(candidates).filter(Boolean);
}

function getMetricsListForRoute(routePathMetrics, routeId) {
  const candidates = routeIdCandidates(routeId);
  for (const candidate of candidates) {
    const metricsList = routePathMetrics.get(candidate);
    if (Array.isArray(metricsList) && metricsList.length) {
      return metricsList;
    }
  }

  return null;
}

function stabilizeEstimatedPosition(train, candidatePosition, nowMs, movementState) {
  const stateMap = movementState;
  const previousState = stateMap.get(train.id) || null;
  const segmentKey = getEstimatedSegmentKey(train);
  const progress = getTimeProgress(train, nowMs);

  if (!Number.isFinite(progress) || !segmentKey) {
    return candidatePosition;
  }

  if (
    previousState &&
    previousState.segmentKey === segmentKey &&
    progress + BACKWARD_PROGRESS_TOLERANCE < previousState.progress
  ) {
    return previousState.position;
  }

  const stabilizedCandidate = limitPositionStep(
    previousState?.position,
    candidatePosition,
    previousState?.updatedAtMs,
    nowMs
  );

  stateMap.set(train.id, {
    segmentKey,
    progress,
    position: stabilizedCandidate,
    updatedAtMs: nowMs,
    wasEstimated: true,
  });

  return stabilizedCandidate;
}

function stabilizeNonEstimatedPosition(train, candidatePosition, nowMs, movementState) {
  const stateMap = movementState;
  const previousState = stateMap.get(train.id) || null;

  if (
    previousState?.wasEstimated &&
    Number.isFinite(previousState.updatedAtMs) &&
    nowMs - previousState.updatedAtMs <= MOVING_POSITION_HOLD_MS
  ) {
    return previousState.position;
  }

  const stabilizedCandidate = limitPositionStep(
    previousState?.position,
    candidatePosition,
    previousState?.updatedAtMs,
    nowMs
  );

  stateMap.set(train.id, {
    segmentKey: null,
    progress: null,
    position: stabilizedCandidate,
    updatedAtMs: nowMs,
    wasEstimated: false,
  });

  return stabilizedCandidate;
}

function toRenderableLineSegments(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }

  return lines.flatMap((line) => {
    const routeId = String(line?.routeId || '').trim();
    const color = String(line?.color || '').trim();
    if (!routeId || !color) {
      return [];
    }

    return (line.paths || [])
      .filter(isRenderablePath)
      .map((path, idx) => ({
        routeId,
        color,
        path,
        key: `${routeId}-${idx}`,
        corridorKey: createCorridorKey(path),
      }));
  });
}

function createCorridorKey(path) {
  if (!Array.isArray(path) || path.length < 2) {
    return 'unknown';
  }

  const sampleSize = 20;
  const step = Math.max(1, Math.floor(path.length / sampleSize));
  const sampled = [];

  for (let i = 0; i < path.length; i += step) {
    const [lat, lng] = path[i];
    sampled.push(`${lat.toFixed(3)},${lng.toFixed(3)}`);
  }

  const [lastLat, lastLng] = path[path.length - 1];
  const lastPoint = `${lastLat.toFixed(3)},${lastLng.toFixed(3)}`;
  if (sampled[sampled.length - 1] !== lastPoint) {
    sampled.push(lastPoint);
  }

  const forward = sampled.join('|');
  const reverse = sampled.slice().reverse().join('|');
  return forward < reverse ? forward : reverse;
}

function getParallelOffsetMeters(routeId, corridorKey, corridorLaneMap) {
  const routeLanes = corridorLaneMap.get(corridorKey);
  if (!routeLanes || !routeLanes.has(routeId)) {
    return 0;
  }

  const laneIndex = routeLanes.get(routeId);
  const laneCount = routeLanes.size;
  const center = (laneCount - 1) / 2;
  return (laneIndex - center) * PARALLEL_LINE_SPACING_METERS;
}

function offsetPath(path, offsetMeters) {
  if (!offsetMeters || !Array.isArray(path) || path.length < 2) {
    return path;
  }

  const metersPerDegLat = 111320;

  return path.map((point, index) => {
    const [lat, lng] = point;
    const prev = path[Math.max(index - 1, 0)];
    const next = path[Math.min(index + 1, path.length - 1)];

    const avgLatRad = ((prev[0] + next[0]) / 2) * (Math.PI / 180);
    const metersPerDegLng = Math.max(1, metersPerDegLat * Math.cos(avgLatRad));

    const dx = (next[1] - prev[1]) * metersPerDegLng;
    const dy = (next[0] - prev[0]) * metersPerDegLat;
    const length = Math.hypot(dx, dy);

    if (!length) {
      return point;
    }

    const nx = -dy / length;
    const ny = dx / length;
    const offsetEastMeters = nx * offsetMeters;
    const offsetNorthMeters = ny * offsetMeters;

    const dLat = offsetNorthMeters / metersPerDegLat;
    const dLng = offsetEastMeters / metersPerDegLng;

    return [lat + dLat, lng + dLng];
  });
}

function squaredDistanceToSegmentMeters(point, segA, segB) {
  const avgLat = (segA[0] + segB[0]) / 2;
  const metersPerDegLng = Math.max(1, METERS_PER_DEG_LAT * Math.cos((avgLat * Math.PI) / 180));

  const px = point[1] * metersPerDegLng;
  const py = point[0] * METERS_PER_DEG_LAT;
  const ax = segA[1] * metersPerDegLng;
  const ay = segA[0] * METERS_PER_DEG_LAT;
  const bx = segB[1] * metersPerDegLng;
  const by = segB[0] * METERS_PER_DEG_LAT;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;

  const t = ab2 > 0 ? clamp((apx * abx + apy * aby) / ab2, 0, 1) : 0;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function buildPathBounds(path) {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;

  for (const [lat, lng] of path) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }

  return { minLat, maxLat, minLng, maxLng };
}

function stationNearBounds(station, bounds, thresholdMeters) {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const latPad = thresholdMeters / METERS_PER_DEG_LAT;
  const lngPad = thresholdMeters / Math.max(1, METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180));

  return (
    station.latitude >= bounds.minLat - latPad &&
    station.latitude <= bounds.maxLat + latPad &&
    station.longitude >= bounds.minLng - lngPad &&
    station.longitude <= bounds.maxLng + lngPad
  );
}

function minDistanceToPathMeters(station, path) {
  if (!Array.isArray(path) || path.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  const point = [station.latitude, station.longitude];
  let minSq = Number.POSITIVE_INFINITY;

  for (let i = 0; i < path.length - 1; i += 1) {
    const sq = squaredDistanceToSegmentMeters(point, path[i], path[i + 1]);
    if (sq < minSq) {
      minSq = sq;
    }
  }

  return Math.sqrt(minSq);
}

const trainBadgeIconCache = new Map();

function getTrainBadgeIcon(routeId, routeColor) {
  const label = String(routeId || '?').toUpperCase();
  const color = routeColor || '#2f2f2f';
  const cacheKey = `${label}-${color}`;

  if (trainBadgeIconCache.has(cacheKey)) {
    return trainBadgeIconCache.get(cacheKey);
  }

  const fontSize = label.length > 2 ? 10 : 12;
  const icon = L.divIcon({
    className: 'train-badge-icon',
    html: `<div style="
      width: 24px;
      height: 24px;
      border-radius: 999px;
      background: ${color};
      border: 2px solid #ffffff;
      color: #ffffff;
      font-weight: 700;
      font-size: ${fontSize}px;
      font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      line-height: 20px;
      text-align: center;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.16);
      ">${label}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  trainBadgeIconCache.set(cacheKey, icon);
  return icon;
}

function MapInstanceBridge({ onReady }) {
  const map = useMap();

  useEffect(() => {
    onReady(map);
    return () => onReady(null);
  }, [map, onReady]);

  return null;
}

const AnimatedTrainsPane = React.memo(function AnimatedTrainsPane({
  trains,
  motionPlanByTrainId,
  routeColorMap,
}) {
  const [animationNowMs, setAnimationNowMs] = useState(() => Date.now());
  const lastProfileLogRef = useRef(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setAnimationNowMs(Date.now());
    }, ANIMATION_TICK_MS);

    return () => clearInterval(interval);
  }, []);

  const animatedTrains = useMemo(() => {
    return trains.map((train) => {
      const candidate = getAnimatedTrainPosition(train, animationNowMs, motionPlanByTrainId);
      const stabilized =
        train.positionSource === 'estimated_between_stops'
          ? stabilizeEstimatedPosition(train, candidate, animationNowMs, MOVEMENT_STATE_CACHE)
          : stabilizeNonEstimatedPosition(train, candidate, animationNowMs, MOVEMENT_STATE_CACHE);

      const [latitude, longitude] = stabilized;
      return {
        ...train,
        latitude,
        longitude,
      };
    });
  }, [trains, animationNowMs, motionPlanByTrainId]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const now = Date.now();
    if (now - lastProfileLogRef.current < 5000) {
      return;
    }

    lastProfileLogRef.current = now;
    console.debug('[perf] animated-trains-pane', {
      trains: animatedTrains.length,
      tickMs: ANIMATION_TICK_MS,
    });
  }, [animatedTrains]);

  return (
    <Pane name="trains-pane" style={{ zIndex: 650 }}>
      {animatedTrains.map((train) => {
        const routeId = train.routeId;
        const routeColor = routeColorMap.get(routeId) || '#2f2f2f';

        return (
          <Marker
            key={train.id}
            pane="trains-pane"
            position={[train.latitude, train.longitude]}
            icon={getTrainBadgeIcon(routeId, routeColor)}
          >
            <Tooltip direction="top" offset={[0, -2]} opacity={0.95}>
              <div><strong>{routeId}</strong> • {train.trainId || 'N/A'}</div>
              {Number.isFinite(train.estimatedMinutesToNextStop) ? (
                <div>Next stop in {train.estimatedMinutesToNextStop} min</div>
              ) : null}
              {train.estimatedFirstStopId ? (
                <div>
                  Started from {train.estimatedFirstStopId}
                  {formatUnixSeconds(train.estimatedFirstStopDepartureSec)
                    ? ` at ${formatUnixSeconds(train.estimatedFirstStopDepartureSec)}`
                    : ''}
                </div>
              ) : null}
            </Tooltip>
          </Marker>
        );
      })}
    </Pane>
  );
});

function App() {
  const [trains, setTrains] = useState([]);
  const [lines, setLines] = useState([]);
  const [stations, setStations] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') {
      return 'light';
    }

    const stored = window.localStorage.getItem('subwayviewer-theme');
    return stored === 'dark' ? 'dark' : 'light';
  });
  const [selectedRouteIds, setSelectedRouteIds] = useState(() => new Set());
  const [routeFilterTouched, setRouteFilterTouched] = useState(false);
  const [mapInstance, setMapInstance] = useState(null);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [userLocation, setUserLocation] = useState(null);
  const [focusedStationId, setFocusedStationId] = useState(null);

  const isDark = theme === 'dark';
  const basemap = isDark ? BASEMAPS.dark : BASEMAPS.light;

  const routeColorMap = useMemo(
    () => new Map(lines.map((line) => [line.routeId, `#${line.color}`])),
    [lines]
  );

  const lineSegments = useMemo(() => toRenderableLineSegments(lines), [lines]);
  const routeIds = useMemo(
    () => Array.from(new Set(lines.map((line) => String(line.routeId || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [lines]
  );

  const effectiveSelectedRouteIds = useMemo(() => {
    if (!routeFilterTouched) {
      return new Set(routeIds);
    }

    return selectedRouteIds;
  }, [routeFilterTouched, routeIds, selectedRouteIds]);

  const stationRouteMap = useMemo(() => {
    const byStation = new Map();
    const indexedSegments = lineSegments.map((segment) => ({
      routeId: segment.routeId,
      path: segment.path,
      bounds: buildPathBounds(segment.path),
    }));

    for (const station of stations) {
      const routeHits = new Set();
      let closestRouteId = null;
      let closestDistance = Number.POSITIVE_INFINITY;

      for (const segment of indexedSegments) {
        if (!stationNearBounds(station, segment.bounds, STATION_LINE_MATCH_THRESHOLD_METERS)) {
          continue;
        }

        const minDistance = minDistanceToPathMeters(station, segment.path);
        if (minDistance < closestDistance) {
          closestDistance = minDistance;
          closestRouteId = segment.routeId;
        }

        if (minDistance <= STATION_LINE_MATCH_THRESHOLD_METERS) {
          routeHits.add(segment.routeId);
        }
      }

      if (!routeHits.size && closestRouteId) {
        routeHits.add(closestRouteId);
      }

      byStation.set(station.stationId, routeHits);
    }

    return byStation;
  }, [stations, lineSegments]);

  const stationFocusRouteIds = useMemo(() => {
    if (!focusedStationId) {
      return null;
    }

    const routes = stationRouteMap.get(focusedStationId);
    return routes && routes.size ? routes : null;
  }, [focusedStationId, stationRouteMap]);

  const activeRouteIds = stationFocusRouteIds || effectiveSelectedRouteIds;

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }

    if (typeof window !== 'undefined') {
      window.localStorage.setItem('subwayviewer-theme', theme);
    }
  }, [theme]);

  const routePathMetrics = useMemo(() => {
    const byRoute = new Map();

    for (const segment of lineSegments) {
      const aliases = routeIdCandidates(segment.routeId);
      for (const alias of aliases) {
        if (!byRoute.has(alias)) {
          byRoute.set(alias, []);
        }
      }

      const metrics = buildPathMetrics(segment.path);
      for (const alias of aliases) {
        byRoute.get(alias).push(metrics);
      }
    }

    return byRoute;
  }, [lineSegments]);

  const motionPlanByTrainId = useMemo(() => {
    const plans = new Map();
    const seenTrainIds = new Set();

    for (const train of trains) {
      seenTrainIds.add(train.id);

      if (train.positionSource !== 'estimated_between_stops') {
        continue;
      }

      const fromLatLng = pointToLatLng(train.estimatedFromPosition);
      const toLatLng = pointToLatLng(train.estimatedToPosition);
      if (!fromLatLng || !toLatLng) {
        continue;
      }

      let metricsList = getMetricsListForRoute(routePathMetrics, train.routeId);
      if (!Array.isArray(metricsList) || !metricsList.length) {
        continue;
      }

      const segmentKey = getEstimatedSegmentKey(train);
      const cachedSelection = MOTION_PLAN_SELECTION_CACHE.get(train.id) || null;
      const canPreferCached = cachedSelection && segmentKey && cachedSelection.segmentKey === segmentKey;

      let best = null;
      for (const metrics of metricsList) {
        const fromProjection = projectPointToPolyline(metrics, fromLatLng);
        const toProjection = projectPointToPolyline(metrics, toLatLng);
        if (!fromProjection || !toProjection) {
          continue;
        }

        const alongDelta = Math.abs(toProjection.distanceAlong - fromProjection.distanceAlong);
        let score = fromProjection.distance + toProjection.distance + (alongDelta < 5 ? 250 : 0);

        if (canPreferCached && cachedSelection.metrics !== metrics) {
          score += 160;
        }

        if (canPreferCached && cachedSelection.metrics === metrics) {
          score -= 20;
        }

        if (!best || score < best.score) {
          best = {
            score,
            metrics,
            fromDistanceAlong: fromProjection.distanceAlong,
            toDistanceAlong: toProjection.distanceAlong,
          };
        }
      }

      if (best) {
        plans.set(train.id, {
          metrics: best.metrics,
          fromDistanceAlong: best.fromDistanceAlong,
          toDistanceAlong: best.toDistanceAlong,
        });

        MOTION_PLAN_SELECTION_CACHE.set(train.id, {
          metrics: best.metrics,
          segmentKey,
          updatedAtMs: Date.now(),
        });
      }
    }

    for (const trainId of MOTION_PLAN_SELECTION_CACHE.keys()) {
      if (!seenTrainIds.has(trainId)) {
        MOTION_PLAN_SELECTION_CACHE.delete(trainId);
      }
    }

    return plans;
  }, [trains, routePathMetrics]);

  const corridorLaneMap = useMemo(() => {
    const corridorRoutes = new Map();

    for (const segment of lineSegments) {
      if (!corridorRoutes.has(segment.corridorKey)) {
        corridorRoutes.set(segment.corridorKey, new Set());
      }
      corridorRoutes.get(segment.corridorKey).add(segment.routeId);
    }

    const laneMap = new Map();
    for (const [corridorKey, routesSet] of corridorRoutes.entries()) {
      const orderedRoutes = Array.from(routesSet).sort((a, b) => a.localeCompare(b));
      const routeToLane = new Map();
      orderedRoutes.forEach((routeId, laneIndex) => {
        routeToLane.set(routeId, laneIndex);
      });
      laneMap.set(corridorKey, routeToLane);
    }

    return laneMap;
  }, [lineSegments]);

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const filteredLineSegments = useMemo(
    () => lineSegments.filter((segment) => activeRouteIds.has(segment.routeId)),
    [lineSegments, activeRouteIds]
  );

  const shiftedLineSegments = useMemo(
    () =>
      filteredLineSegments.map((segment) => {
        const offsetMeters = getParallelOffsetMeters(
          segment.routeId,
          segment.corridorKey,
          corridorLaneMap
        );

        return {
          ...segment,
          shiftedPath: offsetPath(segment.path, offsetMeters),
        };
      }),
    [filteredLineSegments, corridorLaneMap]
  );

  const filteredStations = useMemo(() => {
    if (!normalizedSearch) {
      return stations;
    }

    return stations.filter((station) => {
      const name = String(station.name || '').toLowerCase();
      const stationId = String(station.stationId || '').toLowerCase();
      return name.includes(normalizedSearch) || stationId.includes(normalizedSearch);
    });
  }, [stations, normalizedSearch]);

  const renderedLinePolylines = useMemo(
    () =>
      shiftedLineSegments.map((segment) => (
        <React.Fragment key={segment.key}>
          <Polyline
            positions={segment.shiftedPath}
            pathOptions={{
              color: basemap.markerBorder,
              weight: 6,
              opacity: isDark ? 0.7 : 0.85,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
          <Polyline
            positions={segment.shiftedPath}
            pathOptions={{
              color: `#${segment.color}`,
              weight: 3,
              opacity: 0.92,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
        </React.Fragment>
      )),
    [shiftedLineSegments, basemap.markerBorder, isDark]
  );

  const renderedStationMarkers = useMemo(
    () =>
      filteredStations.map((station) => (
        <CircleMarker
          key={station.stationId}
          center={[station.latitude, station.longitude]}
          radius={focusedStationId === station.stationId ? 6 : 4.2}
          eventHandlers={{
            click: () => {
              setFocusedStationId((prev) => (prev === station.stationId ? null : station.stationId));
            },
          }}
          pathOptions={{
            color: focusedStationId === station.stationId ? '#2e8cff' : basemap.markerBorder,
            weight: focusedStationId === station.stationId ? 2.2 : 1.5,
            fillColor: basemap.stationFill,
            fillOpacity: 0.95,
          }}
        >
          <Tooltip direction="top" offset={[0, -2]} opacity={0.95}>
            {station.name}
          </Tooltip>
        </CircleMarker>
      )),
    [filteredStations, basemap.markerBorder, basemap.stationFill, focusedStationId]
  );

  useEffect(() => {
    let cancelled = false;

    async function fetchStaticMapData() {
      try {
        const [linesRes, stationsRes] = await Promise.all([
          axios.get(`${API_BASE_URL}/api/lines`),
          axios.get(`${API_BASE_URL}/api/stations`),
        ]);

        if (cancelled) {
          return;
        }

        setLines(Array.isArray(linesRes.data?.lines) ? linesRes.data.lines : []);
        setStations(Array.isArray(stationsRes.data?.stations) ? stationsRes.data.stations : []);
      } catch (error) {
        console.error('Error fetching static map data:', error);
      }
    }

    fetchStaticMapData();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchTrains() {
      try {
        const res = await axios.get(`${API_BASE_URL}/api/trains`);
        if (cancelled) {
          return;
        }

        const entities = Array.isArray(res.data?.entity) ? res.data.entity : [];
        const activeTrains = entities
          .map(toRenderableTrainEntity)
          .filter(Boolean);

        setTrains(activeTrains);
      } catch (error) {
        console.error('Error fetching train data:', error);
      }
    }

    fetchTrains();
    const interval = setInterval(fetchTrains, TRAINS_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const activeTrainIds = new Set(trains.map((train) => train.id));
    const stateMap = MOVEMENT_STATE_CACHE;

    for (const trainId of stateMap.keys()) {
      if (!activeTrainIds.has(trainId)) {
        stateMap.delete(trainId);
      }
    }
  }, [trains]);

  useEffect(() => {
    return () => {
      MOVEMENT_STATE_CACHE.clear();
      MOTION_PLAN_SELECTION_CACHE.clear();
    };
  }, []);

  const visibleTrains = useMemo(() => {
    return trains.filter((train) => {
      if (!activeRouteIds.has(train.routeId)) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const routeId = String(train.routeId || '').toLowerCase();
      const trainId = String(train.trainId || '').toLowerCase();
      return routeId.includes(normalizedSearch) || trainId.includes(normalizedSearch);
    });
  }, [trains, activeRouteIds, normalizedSearch]);

  const searchResults = useMemo(() => {
    if (!normalizedSearch) {
      return [];
    }

    const stationMatches = filteredStations.slice(0, 6).map((station) => ({
      id: `station-${station.stationId}`,
      label: station.name,
      detail: `Station ${station.stationId}`,
      kind: 'station',
      targetLatLng: [station.latitude, station.longitude],
    }));

    const trainMatches = visibleTrains.slice(0, 6).map((train) => ({
      id: `train-${train.id}`,
      label: `${train.routeId} train`,
      detail: train.trainId ? `Train ${train.trainId}` : 'In service',
      kind: 'train',
      targetLatLng: [train.latitude, train.longitude],
    }));

    return [...stationMatches, ...trainMatches].slice(0, 10);
  }, [normalizedSearch, filteredStations, visibleTrains]);

  function focusSearchResult(item) {
    if (!item || !Array.isArray(item.targetLatLng) || !mapInstance) {
      return;
    }

    const zoom = item.kind === 'station' ? SEARCH_STATION_ZOOM : SEARCH_TRAIN_ZOOM;
    mapInstance.flyTo(item.targetLatLng, Math.max(zoom, mapInstance.getZoom()), {
      animate: true,
      duration: 0.8,
    });

    if (item.kind === 'station') {
      const stationId = String(item.id || '').replace(/^station-/, '');
      setFocusedStationId(stationId || null);
      setMenuOpen(false);
    }
  }

  function toggleRoute(routeId) {
    setRouteFilterTouched(true);
    setSelectedRouteIds((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) {
        next.delete(routeId);
      } else {
        next.add(routeId);
      }
      return next;
    });
  }

  function selectAllRoutes() {
    setRouteFilterTouched(true);
    setSelectedRouteIds(new Set(routeIds));
  }

  function clearAllRoutes() {
    setRouteFilterTouched(true);
    setSelectedRouteIds(new Set());
  }

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  function handleLocateMe() {
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported on this device.');
      return;
    }

    setIsLocating(true);
    setLocationError('');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latLng = [position.coords.latitude, position.coords.longitude];
        setUserLocation(latLng);
        setIsLocating(false);
        if (mapInstance) {
          const targetZoom = Math.max(LOCATE_ZOOM, mapInstance.getZoom());
          mapInstance.flyTo(latLng, targetZoom, { animate: true, duration: 0.8 });
        }
      },
      (error) => {
        setIsLocating(false);
        setLocationError(error?.message || 'Unable to fetch your location.');
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    );
  }

  return (
    <div className={`app-shell ${isDark ? 'dark' : 'light'}`}>
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        className="map-view"
        zoomControl={false}
      >
        <MapInstanceBridge onReady={setMapInstance} />
        <ZoomControl position="bottomright" />
        <TileLayer
          key={`${theme}-base`}
          url={basemap.base}
          attribution='&copy; OpenStreetMap contributors &copy; CARTO'
        />
        <TileLayer
          key={`${theme}-labels`}
          url={basemap.labels}
          opacity={0.82}
          attribution='&copy; OpenStreetMap contributors &copy; CARTO'
        />

        <Pane name="lines-pane" style={{ zIndex: 390 }}>
          {renderedLinePolylines}
        </Pane>

        <Pane name="stations-pane" style={{ zIndex: 500 }}>
          {renderedStationMarkers}
        </Pane>

        <AnimatedTrainsPane
          trains={visibleTrains}
          motionPlanByTrainId={motionPlanByTrainId}
          routeColorMap={routeColorMap}
        />

        {userLocation && (
          <Pane name="user-pane" style={{ zIndex: 710 }}>
            <CircleMarker
              center={userLocation}
              radius={8}
              pathOptions={{
                color: '#ffffff',
                fillColor: '#2e8cff',
                fillOpacity: 0.95,
                weight: 2,
              }}
            >
              <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>
                You are here
              </Tooltip>
            </CircleMarker>
          </Pane>
        )}
      </MapContainer>

      <div className="top-controls">
        <button
          type="button"
          className="menu-toggle"
          onClick={() => setMenuOpen((prev) => !prev)}
          aria-label="Toggle map menu"
          aria-expanded={menuOpen}
        >
          <span />
          <span />
          <span />
        </button>
      </div>

      {focusedStationId ? (
        <div className="station-focus-chip">
          <span>
            Station focus
          </span>
          <button type="button" onClick={() => setFocusedStationId(null)}>
            Clear
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className="locate-button"
        onClick={handleLocateMe}
        aria-label="Locate me"
        disabled={isLocating}
      >
        <span className={`locate-icon ${isLocating ? 'locating' : ''}`} aria-hidden="true">
          <span className="locate-ring" />
          <span className="locate-dot" />
          <span className="locate-cross locate-cross-h" />
          <span className="locate-cross locate-cross-v" />
        </span>
      </button>

      {locationError ? <div className="location-error">{locationError}</div> : null}

      <aside className={`side-menu ${menuOpen ? 'open' : ''}`}>
        <div className="menu-header">
          <h2>Map Controls</h2>
          <button type="button" className="close-menu" onClick={() => setMenuOpen(false)} aria-label="Close menu">
            x
          </button>
        </div>

        <div className="menu-section">
          <button type="button" className="theme-toggle" onClick={toggleTheme}>
            {isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          </button>
        </div>

        <div className="menu-section">
          <label htmlFor="map-search" className="section-label">Search trains or stations</label>
          <input
            id="map-search"
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Try 4, A, Times Sq, 127..."
          />
          {normalizedSearch && (
            <div className="search-results">
              {searchResults.length ? (
                searchResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`search-item ${item.kind}`}
                    onClick={() => focusSearchResult(item)}
                  >
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                  </button>
                ))
              ) : (
                <div className="search-empty">No trains or stations match your query.</div>
              )}
            </div>
          )}
        </div>

        <div className="menu-section">
          <div className="route-header">
            <span className="section-label">Filter by train route</span>
            <div className="route-actions">
              <button type="button" onClick={selectAllRoutes}>All</button>
              <button type="button" onClick={clearAllRoutes}>None</button>
            </div>
          </div>
          <div className="route-grid">
            {routeIds.map((routeId) => {
              const selected = activeRouteIds.has(routeId);
              const color = routeColorMap.get(routeId) || '#2f2f2f';

              return (
                <button
                  key={routeId}
                  type="button"
                  className={`route-chip ${selected ? 'selected' : ''}`}
                  onClick={() => toggleRoute(routeId)}
                  style={{
                    '--route-color': color,
                  }}
                >
                  {routeId}
                </button>
              );
            })}
          </div>
        </div>

        <div className="menu-section stats-row">
          <div>
            <strong>{visibleTrains.length}</strong>
            <span>Visible trains</span>
          </div>
          <div>
            <strong>{filteredStations.length}</strong>
            <span>Visible stations</span>
          </div>
        </div>
      </aside>

      {menuOpen ? <button className="menu-backdrop" aria-label="Close menu backdrop" onClick={() => setMenuOpen(false)} /> : null}
    </div>
  );
}

export default App;
