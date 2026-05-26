# Raspberry Pi Deployment Guide (Step-by-Step)

Goal: host this app on your Raspberry Pi and access it from anywhere at nyctrain.alexandercoyne.com.

This app is configured to run as one Node service:
- frontend served by Express
- API served at /api/*

That means your reverse proxy only needs to send traffic to one port on the Pi (3000 by default).

---

## 0) What You Need Before Starting

- Raspberry Pi running and reachable on your network
- SSH access to the Pi
- Your domain DNS access (alexandercoyne.com)
- Your reverse proxy UI (same one used for n8n.alexandercoyne.com)

Optional but recommended:
- static DHCP reservation for the Pi on your router
- dynamic DNS if your home public IP changes often

---

## 1) SSH Into the Pi

From your laptop:

```bash
ssh pi@<your-pi-lan-ip>
```

If you forgot the Pi IP:

```bash
ping raspberrypi.local
```

Quick checks once logged in:

```bash
hostname
pwd
```

---

## 2) Verify Node/NPM on the Pi

```bash
node -v
npm -v
```

If either command fails, install Node 20 LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## 3) Put the Project on the Pi

If not already cloned:

```bash
cd ~
git clone <your-repo-url> project-subwayviewer
```

If already cloned:

```bash
cd ~/project-subwayviewer
git pull
```

---

## 4) Install and Build Frontend

```bash
cd ~/project-subwayviewer/client
npm install
npm run build
```

Confirm build output exists:

```bash
ls -la ~/project-subwayviewer/client/dist
```

You should see index.html and assets.

---

## 5) Install Server Dependencies and Test Locally on Pi

```bash
cd ~/project-subwayviewer/server
npm install
PORT=3000 npm run start
```

Leave it running for this test and open another SSH tab to the Pi.

In the second tab:

```bash
curl -I http://127.0.0.1:3000
curl http://127.0.0.1:3000/api/trains | head
```

If those work, stop the test server in the first tab with Ctrl+C.

Important:
- do not run npm run start from ~/project-subwayviewer root
- run it from ~/project-subwayviewer/server or use npm --prefix

---

## 6) Run as a Background Service (systemd)

Copy service template:

```bash
sudo cp ~/project-subwayviewer/server/nyctrain.service.example /etc/systemd/system/nyctrain.service
```

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable nyctrain
sudo systemctl start nyctrain
sudo systemctl status nyctrain --no-pager
```

Live logs:

```bash
journalctl -u nyctrain -f
```

You want to see:
- Translator server running on http://localhost:3000
- Snapshot updated ...

---

## 7) DNS Setup

In your DNS provider for alexandercoyne.com:

1. Create A record:
	- host/name: nyctrain
	- value: your home public IPv4
2. Save and wait for propagation.

Check from terminal:

```bash
dig +short nyctrain.alexandercoyne.com
```

It should return your public IP.

---

## 8) Router Port Forwarding

On your router:

1. Forward TCP 80 -> Pi (or reverse proxy host) port 80
2. Forward TCP 443 -> Pi (or reverse proxy host) port 443

If your reverse proxy is on the same Pi as n8n, use that same target.

---

## 9) Reverse Proxy Host (Same Pattern as n8n)

In your reverse proxy UI, add a new host:

- Domain: nyctrain.alexandercoyne.com
- Forward host: 127.0.0.1
- Forward port: 3000
- Websockets: on (safe default)
- Block common exploits: on
- SSL certificate: request/enable
- Force HTTPS: on

No path rewrites needed.

---

## 10) Final Verification (External)

From mobile data (not home Wi-Fi), open:

- https://nyctrain.alexandercoyne.com

Then verify API path in browser:

- https://nyctrain.alexandercoyne.com/api/trains

If both work, deployment is complete.

---

## Updating Later (Quick Routine)

```bash
cd ~/project-subwayviewer
git pull

cd ~/project-subwayviewer/client
npm install
npm run build

cd ~/project-subwayviewer/server
npm install
sudo systemctl restart nyctrain
sudo systemctl status nyctrain --no-pager
```

## 11) Auto-Deploy From GitHub

If you want the Pi to pull new commits automatically and go live, use the deploy script and timer included in this repo.

On the Pi:

```bash
cd ~/project-subwayviewer
cp server/nyctrain-deploy.service.example /etc/systemd/system/nyctrain-deploy.service
cp server/nyctrain-deploy.timer.example /etc/systemd/system/nyctrain-deploy.timer

# Optional: override defaults for username/repo path/branch
# sudo editor /etc/systemd/system/nyctrain-deploy.service
# Set DEPLOY_REPO_ROOT, DEPLOY_USER, DEPLOY_BRANCH to your environment.

sudo systemctl daemon-reload
sudo systemctl enable --now nyctrain-deploy.timer
sudo systemctl status nyctrain-deploy.timer --no-pager
```

What it does:
- checks GitHub for new commits every minute
- pulls changes only when `origin/main` moved
- rebuilds the client
- refreshes server dependencies
- restarts the `nyctrain` service so the site is live again

The deploy service runs as root, but it performs the Git and build work as the `pi` user so the repository stays owned by your normal account.

If you prefer manual deploys, keep this timer disabled and just run the quick routine above after each push.

---

## Troubleshooting Checklist

### Problem: npm run start fails from project root
Cause: wrong working directory.

Use:

```bash
cd ~/project-subwayviewer/server
npm run start
```

### Problem: domain loads reverse proxy error page
- DNS may still be propagating
- proxy host may target wrong port
- nyctrain service may be down

Check:

```bash
sudo systemctl status nyctrain --no-pager
curl -I http://127.0.0.1:3000
```

### Problem: HTTPS certificate fails
- Ensure DNS points to current public IP
- Ensure ports 80/443 are forwarded
- Ensure no other service is blocking ACME challenge

### Problem: no train data
Check server logs:

```bash
journalctl -u nyctrain -f
```

You should see periodic snapshot updates.

---

## Architecture Notes

- Frontend API calls are same-origin (/api/...) in production.
- Local dev uses Vite proxy from /api to http://localhost:3000.
- Server can serve frontend build automatically when client/dist exists.
