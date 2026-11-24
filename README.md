# NYC Parade Nav

A navigation agent for New Yorkers who need to get across Manhattan during the 100th Macy's Thanksgiving Day Parade (Thu Nov 26, 2026). It's built entirely on Google Maps Platform: the Maps JavaScript API draws the map, and the Routes API plans every route and every re-route.

Google gives the agent its routes. The agent then checks each one against the parade clock, the time-windowed closures, the MTA station rules and live feeds, at the moment you'd reach each point. When a route is blocked, it re-routes by asking Google again with a crossing point, an open corridor or a different station. See **PARADE_AGENT.md** for the design.

## Run it

```bash
cp .env.example .env      # put your Maps Demo Key in BOTH Google lines
npm install
npm start                 # http://localhost:3000
npm test                  # outline scenarios + pass criteria, offline
```
Requires Node 20.6 or later.

## Using it

- **Clock:** The app starts in *simulated* parade morning (8:00 a.m. Nov 26). Drag the slider or change the speed to watch the parade move. Crossings turn green, amber or red as it passes. Click **Live** for real time.
- **Scenarios:** One-click versions of the outline's test plan: Dev at 9:00, 10:30 and 12:15, the wheelchair trip from Chelsea to the UES, and the driver from the West 70s to Penn.
- **Results:** When Google's own route is blocked, it's drawn as a red dotted line with ⛔ pins showing where and when. The agent's options are listed with every blocker and warning, each linked to its source.
- **📸 Report a blocker:** Pin the spot, add a photo or a screenshot (a barricade, a closed entrance, an MTA or NYPD post), and post it. The server reads the image, if `ANTHROPIC_API_KEY` is set, and pushes the report to every open browser at once. The agent also re-checks everyone's watched trips.
  - One report shows as a warning. A second person confirming it makes it a blocker, and affected routes get re-planned.
  - Reports expire after 30–60 minutes unless someone taps "Still there."
  - Images are never stored.
- **Watch this trip:** The agent re-checks your route every 15 seconds and pushes "leave soon" and "reroute" alerts. Sharing your location is optional and is deleted when the trip ends.

## Put it on the web

See **DEPLOY.md**. A single Cloud Run command gives you a public URL.

## Files

```
server.js            API: /plan /parade /alerts /clock /watch (SSE)
lib/parade.js        route, parade clock, closures, crossings, MTA station rules (all sourced)
lib/blockers.js      replays a Google route in time and finds blockers
lib/planner.js       Google call → check → remap (via waypoints / stitched legs / wait) → rank
lib/google.js        Routes API client (field-masked)
lib/feeds.js         MTA alerts, elevators, ADA stations, 511NY, NYC permitted events
lib/watcher.js       live trip monitoring + notifications
lib/reports.js       community reports: confirm/expire, live fan-out
lib/vision.js        reads a screenshot into a structured blocker (Claude API)
test/                scenario tests with a fake Google (no network needed)
```

## Demo key notes

- Google's demo-key page lists map display and Compute Routes as supported, within daily caps and with no charges.
- If the map loads but planning fails with a permission error, the demo key doesn't cover routing for your account. You'll need a billing-enabled key.
- Before anyone else uses the app, switch to separate browser and server keys with restrictions.
