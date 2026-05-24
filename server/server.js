const express = require('express');
const axios = require('axios');
const protobuf = require('protobufjs');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');

const app = express();
app.use(cors());
const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIST_DIR = path.resolve(__dirname, '../client/dist');

const MTA_FEED_URLS = [
    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si',
];
const STATIC_GTFS_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip';
const TOP_SHAPES_PER_ROUTE = 4;
const FEED_REFRESH_MS = 5000;
const DEFAULT_SEGMENT_TRAVEL_SECONDS = 90;
const MIN_IN_TRANSIT_PROGRESS = 0.08;
const MAX_IN_TRANSIT_PROGRESS = 0.92;
const VEHICLE_STATUS_IN_TRANSIT_TO = 2;

// Configure Protobuf to handle imports automatically
const root = new protobuf.Root();

root.resolvePath = (origin, target) => {
    return path.join(__dirname, 'proto', target);
};

// Now load the files
root.loadSync(["com/google/transit/realtime/gtfs-realtime.proto", "gtfs-realtime-NYCT.proto"]);
const FeedMessage = root.lookupType("transit_realtime.FeedMessage");

let stopsLookupPromise;
let routeLinesPromise;
let staticGtfsZipPromise;
let stationsPromise;
let latestFeedSnapshot = { header: null, entity: [] };
let latestFeedMeta = {
    updatedAt: null,
    source: 'startup',
    feedCount: 0,
    mergedEntities: 0,
    dedupedEntities: 0,
    withGps: 0,
    estimatedInTransit: 0,
    stopFallback: 0,
};
let feedRefreshInFlight = null;
let feedRefreshTimer = null;
const tripMotionState = new Map();
const TRIP_MOTION_TTL_MS = 30 * 60 * 1000;

const ROUTE_COLOR_FALLBACK = {
    '1': 'EE352E',
    '2': 'EE352E',
    '3': 'EE352E',
    '4': '00933C',
    '5': '00933C',
    '6': '00933C',
    '6X': '00933C',
    '7': 'B933AD',
    A: '2850AD',
    C: '2850AD',
    E: '2850AD',
    H: '808183',
    B: 'FF6319',
    D: 'FF6319',
    F: 'FF6319',
    M: 'FF6319',
    FS: '808183',
    G: '6CBE45',
    J: '996633',
    Z: '996633',
    L: 'A7A9AC',
    N: 'FCCC0A',
    Q: 'FCCC0A',
    R: 'FCCC0A',
    W: 'FCCC0A',
    GS: '808183',
    SI: '0039A6',
};

function normalizeStopId(stopId) {
    if (!stopId) return '';
    return String(stopId).trim();
}

function normalizeStationId(stopId) {
    return normalizeStopId(stopId).replace(/[NSEW]$/i, '');
}

function lookupStop(stopLookup, stopId) {
    const normalized = normalizeStopId(stopId);
    if (!normalized) return null;

    const direct = stopLookup.get(normalized);
    if (direct) return direct;

    // Realtime stop ids occasionally include a directional suffix.
    const withoutDirection = normalized.replace(/[NSEW]$/i, '');
    return stopLookup.get(withoutDirection) || null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function toUnixSeconds(value) {
    if (value == null) return null;

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    if (typeof value === 'object') {
        if (typeof value.toNumber === 'function') {
            const parsed = value.toNumber();
            return Number.isFinite(parsed) ? parsed : null;
        }

        if (typeof value.low === 'number') {
            return Number.isFinite(value.low) ? value.low : null;
        }
    }

    return null;
}

function interpolatePosition(fromPoint, toPoint, progress) {
    return {
        latitude: fromPoint.latitude + (toPoint.latitude - fromPoint.latitude) * progress,
        longitude: fromPoint.longitude + (toPoint.longitude - fromPoint.longitude) * progress,
    };
}

function isVehicleInTransit(vehicle) {
    return (
        vehicle?.currentStatus === 'IN_TRANSIT_TO' ||
        vehicle?.currentStatus === VEHICLE_STATUS_IN_TRANSIT_TO
    );
}

function getTripMotionKey(vehicle) {
    const trip = vehicle?.trip || {};
    const tripId = String(trip.tripId || '').trim();
    const routeId = String(trip.routeId || '').trim();

    if (!tripId) {
        return null;
    }

    return `${routeId}:${tripId}`;
}

function clonePlain(value) {
    if (!value) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function mergeEntityRecords(existingEntity, incomingEntity) {
    if (!existingEntity) {
        return {
            id: incomingEntity.id,
            isDeleted: Boolean(incomingEntity.isDeleted),
            vehicle: clonePlain(incomingEntity.vehicle),
            tripUpdate: clonePlain(incomingEntity.tripUpdate),
            alert: clonePlain(incomingEntity.alert),
        };
    }

    return {
        id: existingEntity.id || incomingEntity.id,
        isDeleted: Boolean(existingEntity.isDeleted || incomingEntity.isDeleted),
        vehicle: existingEntity.vehicle || clonePlain(incomingEntity.vehicle),
        tripUpdate: existingEntity.tripUpdate || clonePlain(incomingEntity.tripUpdate),
        alert: existingEntity.alert || clonePlain(incomingEntity.alert),
    };
}

function mergeFeedEntities(decodedFeeds) {
    const mergedEntities = decodedFeeds.flatMap((feed) => feed.entity || []);
    const dedupedEntityMap = new Map();

    for (const entity of mergedEntities) {
        if (!entity || !entity.id) {
            continue;
        }

        const existing = dedupedEntityMap.get(entity.id);
        dedupedEntityMap.set(entity.id, mergeEntityRecords(existing, entity));
    }

    return {
        mergedEntities,
        dedupedEntities: Array.from(dedupedEntityMap.values()),
    };
}

function buildTripUpdatesByTripKey(entities) {
    const tripUpdatesByTripKey = new Map();

    for (const entity of entities) {
        const tripUpdate = entity?.tripUpdate;
        if (!tripUpdate) {
            continue;
        }

        const tripKey = getTripKeyFromTripUpdate(tripUpdate);
        if (!tripKey) {
            continue;
        }

        tripUpdatesByTripKey.set(tripKey, tripUpdate);
    }

    return tripUpdatesByTripKey;
}

function enrichVehiclePosition(vehicle, tripUpdatesByTripKey, stopLookup, nowMs) {
    if (!vehicle) {
        return null;
    }

    const hasGps =
        vehicle.position &&
        Number.isFinite(vehicle.position.latitude) &&
        Number.isFinite(vehicle.position.longitude);
    if (hasGps) {
        return 'gps';
    }

    const tripKey = getTripMotionKey(vehicle);
    const tripUpdate = tripKey ? tripUpdatesByTripKey.get(tripKey) : null;

    const estimated =
        applyTripUpdateEstimatedPosition(vehicle, tripUpdate, stopLookup, nowMs) ||
        applyEstimatedInTransitPosition(vehicle, stopLookup, nowMs);
    if (estimated) {
        return 'estimated_between_stops';
    }

    const stopMatch = lookupStop(stopLookup, vehicle.stopId);
    if (!stopMatch) {
        return null;
    }

    vehicle.position = {
        latitude: stopMatch.latitude,
        longitude: stopMatch.longitude,
    };
    vehicle.positionSource = 'stop_lookup';
    if (stopMatch.stopName) {
        vehicle.resolvedStopName = stopMatch.stopName;
    }

    return 'stop_lookup';
}

function pruneTripMotionState(nowMs) {
    for (const [tripKey, state] of tripMotionState.entries()) {
        if (!state || !Number.isFinite(state.changedAtMs)) {
            tripMotionState.delete(tripKey);
            continue;
        }

        if (nowMs - state.changedAtMs > TRIP_MOTION_TTL_MS) {
            tripMotionState.delete(tripKey);
        }
    }
}

function getTripKeyFromTripUpdate(tripUpdate) {
    const trip = tripUpdate?.trip || {};
    const tripId = String(trip.tripId || '').trim();
    const routeId = String(trip.routeId || '').trim();

    if (!tripId) {
        return null;
    }

    return `${routeId}:${tripId}`;
}

function getStopUpdateTimeWindow(stopUpdate) {
    const arrivalSec = toUnixSeconds(stopUpdate?.arrival?.time);
    const departureSec = toUnixSeconds(stopUpdate?.departure?.time);
    const startSec = departureSec ?? arrivalSec;
    const endSec = arrivalSec ?? departureSec;

    return {
        startSec,
        endSec,
    };
}

function getSegmentProgress(startSec, endSec, nowSec) {
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
        return clamp((nowSec - startSec) / (endSec - startSec), MIN_IN_TRANSIT_PROGRESS, MAX_IN_TRANSIT_PROGRESS);
    }

    return clamp(MIN_IN_TRANSIT_PROGRESS, MIN_IN_TRANSIT_PROGRESS, MAX_IN_TRANSIT_PROGRESS);
}

function applyTripUpdateEstimatedPosition(vehicle, tripUpdate, stopLookup, nowMs) {
    if (!vehicle || !tripUpdate) {
        return false;
    }

    const stopUpdates = Array.isArray(tripUpdate.stopTimeUpdate)
        ? tripUpdate.stopTimeUpdate
        : [];

    if (stopUpdates.length < 2) {
        return false;
    }

    const currentStopId = normalizeStopId(vehicle.stopId);
    if (!currentStopId) {
        return false;
    }

    const nowSec = Math.floor(nowMs / 1000);
    const normalizedUpdates = stopUpdates
        .map((stopUpdate) => ({
            stopId: normalizeStopId(stopUpdate?.stopId),
            ...getStopUpdateTimeWindow(stopUpdate),
        }))
        .filter((stopUpdate) => stopUpdate.stopId);

    if (normalizedUpdates.length < 2) {
        return false;
    }

    let fromIndex = normalizedUpdates.findIndex((stopUpdate) => stopUpdate.stopId === currentStopId);
    if (fromIndex < 0) {
        return false;
    }

    if (fromIndex >= normalizedUpdates.length - 1) {
        fromIndex = normalizedUpdates.length - 2;
    }

    const fromUpdate = normalizedUpdates[fromIndex];
    const toUpdate = normalizedUpdates[fromIndex + 1];
    if (!fromUpdate || !toUpdate) {
        return false;
    }

    const fromStop = lookupStop(stopLookup, fromUpdate.stopId);
    const toStop = lookupStop(stopLookup, toUpdate.stopId);
    if (!fromStop || !toStop) {
        return false;
    }

    let segmentStartSec = fromUpdate.startSec;
    let segmentEndSec = toUpdate.endSec;

    let progress = getSegmentProgress(segmentStartSec, segmentEndSec, nowSec);
    if (!Number.isFinite(segmentStartSec) || !Number.isFinite(segmentEndSec)) {
        // Time values are occasionally omitted; use a gentle default so trains appear between stops.
        segmentStartSec = nowSec;
        segmentEndSec = nowSec + DEFAULT_SEGMENT_TRAVEL_SECONDS;
        progress = clamp((nowSec % DEFAULT_SEGMENT_TRAVEL_SECONDS) / DEFAULT_SEGMENT_TRAVEL_SECONDS, MIN_IN_TRANSIT_PROGRESS, MAX_IN_TRANSIT_PROGRESS);
    }

    vehicle.position = interpolatePosition(fromStop, toStop, progress);
    vehicle.positionSource = 'estimated_between_stops';
    vehicle.estimatedProgress = Number(progress.toFixed(3));
    vehicle.estimatedFromStopId = fromUpdate.stopId;
    vehicle.estimatedToStopId = toUpdate.stopId;
    vehicle.estimatedFromPosition = {
        latitude: fromStop.latitude,
        longitude: fromStop.longitude,
    };
    vehicle.estimatedToPosition = {
        latitude: toStop.latitude,
        longitude: toStop.longitude,
    };
    vehicle.estimatedSegmentStartSec = segmentStartSec;
    vehicle.estimatedSegmentEndSec = segmentEndSec;
    vehicle.estimatedComputedAtMs = nowMs;
    return true;
}

function applyEstimatedInTransitPosition(vehicle, stopLookup, nowMs) {
    const tripKey = getTripMotionKey(vehicle);
    const currentStopId = normalizeStopId(vehicle.stopId);

    if (!tripKey || !currentStopId) {
        return false;
    }

    const previousState = tripMotionState.get(tripKey) || null;
    const state = previousState || {
        previousStopId: null,
        currentStopId,
        changedAtMs: nowMs,
    };

    if (state.currentStopId !== currentStopId) {
        state.previousStopId = state.currentStopId;
        state.currentStopId = currentStopId;
        state.changedAtMs = nowMs;
    }

    tripMotionState.set(tripKey, state);

    if (!isVehicleInTransit(vehicle)) {
        return false;
    }

    const fromStopId = normalizeStopId(state.previousStopId);
    const toStopId = normalizeStopId(state.currentStopId);

    if (!fromStopId || !toStopId || fromStopId === toStopId) {
        return false;
    }

    const fromStop = lookupStop(stopLookup, fromStopId);
    const toStop = lookupStop(stopLookup, toStopId);

    if (!fromStop || !toStop) {
        return false;
    }

    const elapsedSeconds = (nowMs - state.changedAtMs) / 1000;
    const rawProgress = elapsedSeconds / DEFAULT_SEGMENT_TRAVEL_SECONDS;
    const progress = clamp(rawProgress, MIN_IN_TRANSIT_PROGRESS, MAX_IN_TRANSIT_PROGRESS);
    const segmentStartSec = Math.floor(state.changedAtMs / 1000);
    const segmentEndSec = segmentStartSec + DEFAULT_SEGMENT_TRAVEL_SECONDS;

    vehicle.position = interpolatePosition(fromStop, toStop, progress);
    vehicle.positionSource = 'estimated_between_stops';
    vehicle.estimatedProgress = Number(progress.toFixed(3));
    vehicle.estimatedFromStopId = fromStopId;
    vehicle.estimatedToStopId = toStopId;
    vehicle.estimatedFromPosition = {
        latitude: fromStop.latitude,
        longitude: fromStop.longitude,
    };
    vehicle.estimatedToPosition = {
        latitude: toStop.latitude,
        longitude: toStop.longitude,
    };
    vehicle.estimatedSegmentStartSec = segmentStartSec;
    vehicle.estimatedSegmentEndSec = segmentEndSec;
    vehicle.estimatedComputedAtMs = nowMs;
    return true;
}

async function loadStopsLookup() {
    const zip = await getStaticGtfsZip();
    const records = parseCsvEntry(zip, 'stops.txt');

    const stopLookup = new Map();
    for (const row of records) {
        const stopId = normalizeStopId(row.stop_id);
        const latitude = Number(row.stop_lat);
        const longitude = Number(row.stop_lon);

        if (!stopId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            continue;
        }

        stopLookup.set(stopId, {
            latitude,
            longitude,
            stopName: row.stop_name || null,
        });
    }

    console.log(`Static GTFS loaded. Found ${stopLookup.size} stop coordinates.`);
    return stopLookup;
}

async function loadStations() {
    const zip = await getStaticGtfsZip();
    const records = parseCsvEntry(zip, 'stops.txt');

    const stationsById = new Map();

    for (const row of records) {
        const stopId = normalizeStopId(row.stop_id);
        const stationId = normalizeStationId(stopId);
        const latitude = Number(row.stop_lat);
        const longitude = Number(row.stop_lon);
        const stopName = String(row.stop_name || '').trim();
        const locationType = String(row.location_type || '0').trim();
        const parentStation = String(row.parent_station || '').trim();

        if (!stationId || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !stopName) {
            continue;
        }

        // Prefer station-level rows when available; otherwise keep first child stop.
        const isStationRow = locationType === '1';
        const hasNoParent = !parentStation;
        if (!isStationRow && !hasNoParent && stationsById.has(stationId)) {
            continue;
        }

        if (!stationsById.has(stationId) || isStationRow) {
            stationsById.set(stationId, {
                stationId,
                name: stopName,
                latitude,
                longitude,
            });
        }
    }

    const stations = Array.from(stationsById.values());
    console.log(`Static GTFS loaded. Built ${stations.length} stations.`);
    return stations;
}

function parseCsvEntry(zip, entryName) {
    const entry = zip.getEntry(entryName);
    if (!entry) {
        throw new Error(`${entryName} not found in static GTFS archive`);
    }

    return parse(entry.getData().toString('utf8'), {
        columns: true,
        skip_empty_lines: true,
    });
}

function normalizeRouteColor(routeId, rawColor) {
    const cleaned = String(rawColor || '').trim().replace(/^#/, '').toUpperCase();
    if (/^[0-9A-F]{6}$/.test(cleaned)) {
        return cleaned;
    }

    return ROUTE_COLOR_FALLBACK[routeId] || '666666';
}

function createCanonicalPathSignature(path) {
    if (!Array.isArray(path) || path.length === 0) {
        return '';
    }

    const sampleSize = 24;
    const step = Math.max(1, Math.floor(path.length / sampleSize));
    const sampled = [];

    for (let i = 0; i < path.length; i += step) {
        const [lat, lon] = path[i];
        sampled.push(`${lat.toFixed(4)},${lon.toFixed(4)}`);
    }

    const [lastLat, lastLon] = path[path.length - 1];
    const lastPoint = `${lastLat.toFixed(4)},${lastLon.toFixed(4)}`;
    if (sampled[sampled.length - 1] !== lastPoint) {
        sampled.push(lastPoint);
    }

    const forward = sampled.join('|');
    const reverse = sampled.slice().reverse().join('|');
    return forward < reverse ? forward : reverse;
}

function buildRouteLines(routesRows, tripsRows, shapesRows) {
    const routeStyles = new Map();
    for (const route of routesRows) {
        const routeId = String(route.route_id || '').trim();
        if (!routeId) continue;

        routeStyles.set(routeId, {
            routeId,
            routeShortName: route.route_short_name || routeId,
            routeLongName: route.route_long_name || null,
            color: normalizeRouteColor(routeId, route.route_color),
        });
    }

    const shapeCountsByRoute = new Map();
    for (const trip of tripsRows) {
        const routeId = String(trip.route_id || '').trim();
        const shapeId = String(trip.shape_id || '').trim();
        if (!routeId || !shapeId) continue;

        if (!shapeCountsByRoute.has(routeId)) {
            shapeCountsByRoute.set(routeId, new Map());
        }

        const routeShapeCounts = shapeCountsByRoute.get(routeId);
        routeShapeCounts.set(shapeId, (routeShapeCounts.get(shapeId) || 0) + 1);
    }

    const selectedShapesByRoute = new Map();
    const neededShapeIds = new Set();
    for (const [routeId, shapeCounts] of shapeCountsByRoute.entries()) {
        const selectedShapeIds = Array.from(shapeCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, TOP_SHAPES_PER_ROUTE)
            .map(([shapeId]) => shapeId);

        selectedShapesByRoute.set(routeId, selectedShapeIds);
        for (const shapeId of selectedShapeIds) {
            neededShapeIds.add(shapeId);
        }
    }

    const shapePoints = new Map();
    for (const row of shapesRows) {
        const shapeId = String(row.shape_id || '').trim();
        if (!neededShapeIds.has(shapeId)) continue;

        const lat = Number(row.shape_pt_lat);
        const lon = Number(row.shape_pt_lon);
        const sequence = Number(row.shape_pt_sequence);

        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(sequence)) {
            continue;
        }

        if (!shapePoints.has(shapeId)) {
            shapePoints.set(shapeId, []);
        }

        shapePoints.get(shapeId).push({
            lat,
            lon,
            sequence,
        });
    }

    const lines = [];
    for (const [routeId, selectedShapeIds] of selectedShapesByRoute.entries()) {
        const routeStyle = routeStyles.get(routeId) || {
            routeId,
            routeShortName: routeId,
            routeLongName: null,
            color: normalizeRouteColor(routeId),
        };

        const paths = [];
        const seenSignatures = new Set();
        for (const shapeId of selectedShapeIds) {
            const points = shapePoints.get(shapeId);
            if (!points || points.length < 2) continue;

            const ordered = points
                .slice()
                .sort((a, b) => a.sequence - b.sequence)
                .map((p) => [p.lat, p.lon]);

            if (ordered.length > 1) {
                const signature = createCanonicalPathSignature(ordered);
                if (signature && seenSignatures.has(signature)) {
                    continue;
                }

                if (signature) {
                    seenSignatures.add(signature);
                }

                paths.push(ordered);
            }
        }

        if (paths.length > 0) {
            lines.push({
                routeId: routeStyle.routeId,
                routeShortName: routeStyle.routeShortName,
                routeLongName: routeStyle.routeLongName,
                color: routeStyle.color,
                paths,
            });
        }
    }

    return lines;
}

async function loadRouteLines() {
    const zip = await getStaticGtfsZip();
    const routesRows = parseCsvEntry(zip, 'routes.txt');
    const tripsRows = parseCsvEntry(zip, 'trips.txt');
    const shapesRows = parseCsvEntry(zip, 'shapes.txt');

    const lines = buildRouteLines(routesRows, tripsRows, shapesRows);
    console.log(`Static GTFS loaded. Built ${lines.length} route lines.`);
    return lines;
}

async function getStaticGtfsZip() {
    if (!staticGtfsZipPromise) {
        staticGtfsZipPromise = axios
            .get(STATIC_GTFS_URL, {
                responseType: 'arraybuffer',
                timeout: 30000,
            })
            .then((response) => new AdmZip(Buffer.from(response.data)));
    }

    return staticGtfsZipPromise;
}

async function getStopsLookup() {
    if (!stopsLookupPromise) {
        stopsLookupPromise = loadStopsLookup();
    }
    return stopsLookupPromise;
}

async function getRouteLines() {
    if (!routeLinesPromise) {
        routeLinesPromise = loadRouteLines();
    }
    return routeLinesPromise;
}

async function getStations() {
    if (!stationsPromise) {
        stationsPromise = loadStations();
    }
    return stationsPromise;
}

async function refreshFeedSnapshot(source = 'interval') {
    if (feedRefreshInFlight) {
        return feedRefreshInFlight;
    }

    feedRefreshInFlight = (async () => {
        const stopLookup = await getStopsLookup();
        const nowMs = Date.now();

        const feedResponses = await Promise.all(
            MTA_FEED_URLS.map((url) =>
                axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 20000,
                })
            )
        );

        const decodedFeeds = feedResponses.map((response) =>
            FeedMessage.decode(new Uint8Array(response.data))
        );

        const {
            mergedEntities,
            dedupedEntities: entities,
        } = mergeFeedEntities(decodedFeeds);

        const tripUpdatesByTripKey = buildTripUpdatesByTripKey(entities);

        const firstFeed = decodedFeeds[0] || {};
        const feed = {
            header: firstFeed.header || null,
            entity: entities,
        };

        let withGps = 0;
        let estimatedInTransit = 0;
        let stopFallback = 0;

        for (const entity of entities) {
            const vehicle = entity.vehicle;
            const sourceUsed = enrichVehiclePosition(vehicle, tripUpdatesByTripKey, stopLookup, nowMs);
            if (sourceUsed === 'gps') {
                withGps += 1;
                continue;
            }

            if (sourceUsed === 'estimated_between_stops') {
                estimatedInTransit += 1;
                continue;
            }

            if (sourceUsed === 'stop_lookup') {
                stopFallback += 1;
            }
        }

        pruneTripMotionState(nowMs);

        latestFeedSnapshot = feed;
        latestFeedMeta = {
            updatedAt: new Date(nowMs).toISOString(),
            source,
            feedCount: decodedFeeds.length,
            mergedEntities: mergedEntities.length,
            dedupedEntities: entities.length,
            withGps,
            estimatedInTransit,
            stopFallback,
        };

        console.log(
            `Snapshot updated. source=${source}, feedCount=${decodedFeeds.length}, entities=${entities.length}, GPS=${withGps}, estimated=${estimatedInTransit}, stopFallback=${stopFallback}`
        );
    })();

    try {
        await feedRefreshInFlight;
    } finally {
        feedRefreshInFlight = null;
    }
}

async function ensureFeedSnapshotReady() {
    if (!latestFeedSnapshot.entity || latestFeedSnapshot.entity.length === 0) {
        await refreshFeedSnapshot('request_warmup');
    }
}

function startFeedRefreshLoop() {
    if (feedRefreshTimer) {
        return;
    }

    refreshFeedSnapshot('startup').catch((error) => {
        console.error('Initial snapshot refresh failed:', error.message);
    });

    feedRefreshTimer = setInterval(() => {
        refreshFeedSnapshot('interval').catch((error) => {
            console.error('Snapshot refresh failed:', error.message);
        });
    }, FEED_REFRESH_MS);
}

app.get('/api/lines', async (req, res) => {
    try {
        const lines = await getRouteLines();
        res.json({
            lineCount: lines.length,
            lines,
        });
    } catch (error) {
        console.error('Line Loading Error:', error.message);
        res.status(500).send('Error loading subway lines');
    }
});

app.get('/api/stations', async (req, res) => {
    try {
        const stations = await getStations();
        res.json({
            stationCount: stations.length,
            stations,
        });
    } catch (error) {
        console.error('Station Loading Error:', error.message);
        res.status(500).send('Error loading stations');
    }
});

app.get('/api/trains', async (req, res) => {
    try {
        await ensureFeedSnapshotReady();
        res.json({
            ...latestFeedSnapshot,
            meta: latestFeedMeta,
        });
    } catch (error) {
        console.error("Decoding/Fetching Error:", error.message);
        res.status(500).send("Error processing MTA data");
    }
});

if (fs.existsSync(path.join(CLIENT_DIST_DIR, 'index.html'))) {
    app.use(express.static(CLIENT_DIST_DIR));

    app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
        res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'));
    });
}

startFeedRefreshLoop();

app.listen(PORT, () => {
    console.log(`Translator server running on http://localhost:${PORT}`);
    if (fs.existsSync(path.join(CLIENT_DIST_DIR, 'index.html'))) {
        console.log(`Serving frontend from ${CLIENT_DIST_DIR}`);
    }
});
