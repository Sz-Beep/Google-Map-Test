// NYC Parade Navigation Agent — server
//   Google Maps JS (browser key) for display, Google Routes API (server key)
//   for every route and every remap. Parade/closure/transit knowledge and
//   live feeds decide which Google routes are actually usable.

import express from "express";
import { randomUUID } from "node:crypto";
import { createGoogle } from "./lib/google.js";
import { plan } from "./lib/planner.js";
import * as feedsMod from "./lib/feeds.js";
import * as clock from "./lib/clock.js";
import { stateAt, reportPosition } from "./lib/parade.js";
import { createWatcher } from "./lib/watcher.js";
import * as reports from "./lib/reports.js";
import { readScreenshot, visionEnabled } from "./lib/vision.js";

const { GOOGLE_MAPS_BROWSER_KEY, GOOGLE_ROUTES_SERVER_KEY, GOOGLE_MAP_ID = "DEMO_MAP_ID", PORT = 3000,
  CLOCK_MODE = "sim", OPERATOR_TOKEN } = process.env;
// CLOCK_MODE=live for the real day: real time, and visitors can't move the shared clock.
if (!GOOGLE_MAPS_BROWSER_KEY || !GOOGLE_ROUTES_SERVER_KEY) {
  console.error("Missing keys. Copy .env.example to .env and fill in both keys (the demo key can go in both).");
  process.exit(1);
}

const google = createGoogle(GOOGLE_ROUTES_SERVER_KEY);
const feeds = feedsMod.feeds;
feedsMod.start();
if (CLOCK_MODE === "live") clock.set({ mode: "live" });
const watcher = createWatcher({ google, feeds, clock, reports: reports.forEngine });
const plans = new Map(); // planId -> plan (kept 2 h)

const app = express();
app.set("trust proxy", true); // behind Cloud Run / Render load balancers
app.use("/api/reports/read", express.json({ limit: "8mb" }));
app.use(express.json({ limit: "50kb" }));
app.use(express.static("public"));

app.get("/api/config", (_q, res) => res.json({ browserKey: GOOGLE_MAPS_BROWSER_KEY, mapId: GOOGLE_MAP_ID, vision: visionEnabled(), kinds: reports.KINDS, clockLocked: CLOCK_MODE === "live" }));

// Clock (sim lets you replay parade morning)
app.get("/api/clock", (_q, res) => res.json(clock.get()));
app.post("/api/clock", (q, res) => {
  if (CLOCK_MODE === "live") return res.status(403).json({ error: "Live site: the clock follows real time." });
  res.json(clock.set(q.body ?? {}));
});

// Parade + closures + station rules at a moment
app.get("/api/parade", (q, res) => res.json(stateAt(q.query.t ? Number(q.query.t) : clock.now())));

// Live position report (operator, broadcast watcher, or crowd report)
app.post("/api/parade/position", (q, res) => {
  if (OPERATOR_TOKEN && q.get("x-operator-token") !== OPERATOR_TOKEN) return res.status(401).json({ error: "Operator token required." });
  const { lat, lng, which } = q.body ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "lat/lng required" });
  res.json(reportPosition({ lat, lng, which, time: clock.now() }));
});

// Live feeds + their health
app.get("/api/alerts", (_q, res) => res.json(feedsMod.snapshot(clock.now())));

// Plan a trip
app.post("/api/plan", async (q, res) => {
  try {
    const b = q.body ?? {};
    const req = {
      origin: wp(b.origin), destination: wp(b.destination), mode: b.mode,
      departAt: b.departAt ? Date.parse(b.departAt) : undefined,
      arriveBy: b.arriveBy ? Date.parse(b.arriveBy) : undefined,
      wheelchair: !!b.wheelchair, transitPreference: b.transitPreference || undefined,
    };
    if (!req.departAt && !req.arriveBy) req.departAt = clock.now();
    const result = await plan(req, { google, feeds, reports: reports.forEngine, now: clock.now() });
    const id = randomUUID();
    plans.set(id, result);
    setTimeout(() => plans.delete(id), 2 * 3600e3).unref();
    res.json({ id, ...result });
  } catch (e) {
    res.status(e instanceof BadInput ? 400 : 502).json({ error: e.message });
  }
});

// Watch a chosen option: Server-Sent Events push "leave_soon" / "reroute"
app.post("/api/watch", (q, res) => {
  const p = plans.get(q.body?.planId);
  const option = p?.options.find((o) => o.id === q.body?.optionId);
  if (!option) return res.status(404).json({ error: "Plan expired — plan again." });
  res.json({ watchId: watcher.start(p.request, option) });
});
app.get("/api/watch/:id/stream", (q, res) => { if (!watcher.stream(q.params.id, res)) res.status(404).end(); });
app.post("/api/watch/:id/position", (q, res) => res.json({ ok: watcher.position(q.params.id, q.body ?? {}) }));
app.delete("/api/watch/:id", (q, res) => res.json({ ok: watcher.end(q.params.id, "Stopped by you — location deleted.") }));

// --- Community reports: screenshot → structured blocker → everyone, live ----
const live = new Set();
app.get("/api/live", (q, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  live.add(res);
  q.on("close", () => live.delete(res));
});
setInterval(() => live.forEach((r) => r.write(": ping\n\n")), 25e3).unref();
reports.onChange((ev) => {
  for (const r of live) r.write(`data: ${JSON.stringify(ev)}\n\n`);
  watcher.tick().catch(() => {}); // re-check watched trips right away
});

const hits = new Map(); // ip -> timestamps
function limited(q, res, max, windowMs) {
  const now = Date.now(), list = (hits.get(q.ip) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) { res.status(429).json({ error: "Too many reports from you just now — try again in a few minutes." }); return true; }
  list.push(now); hits.set(q.ip, list); return false;
}
const reporterId = (b) => String(b?.reporter ?? "").slice(0, 64) || "anon";

app.get("/api/reports", (_q, res) => res.json(reports.active(clock.now()).map(reports.publicView)));

app.post("/api/reports/read", async (q, res) => {
  if (limited(q, res, 10, 10 * 60e3)) return;
  try {
    const { image, mediaType, note } = q.body ?? {};
    if (!image) return res.status(400).json({ error: "No image." });
    const out = await readScreenshot({ base64: String(image).replace(/^data:[^,]+,/, ""), mediaType, note });
    res.json(out ?? { kind: null, summary: null, disabled: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/api/reports", (q, res) => {
  if (limited(q, res, 6, 10 * 60e3)) return;
  const b = q.body ?? {};
  if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return res.status(400).json({ error: "Drop a pin first." });
  if (b.lat < 40.68 || b.lat > 40.88 || b.lng < -74.03 || b.lng > -73.9) return res.status(400).json({ error: "Reports are for Manhattan only." });
  const extracted = b.extracted && typeof b.extracted === "object" ? {
    summary: String(b.extracted.summary ?? "").slice(0, 200), where: b.extracted.where ? String(b.extracted.where).slice(0, 120) : null,
    until: b.extracted.until ? String(b.extracted.until).slice(0, 60) : null, sourceSeen: b.extracted.sourceSeen ? String(b.extracted.sourceSeen).slice(0, 60) : null,
  } : null;
  res.json(reports.add({ lat: b.lat, lng: b.lng, kind: b.kind, note: b.note, extracted, reporter: reporterId(b), time: clock.now() }));
});

app.post("/api/reports/:id/vote", (q, res) => {
  if (limited(q, res, 30, 10 * 60e3)) return;
  const r = reports.confirm(q.params.id, { reporter: reporterId(q.body), still: !!q.body?.still, time: clock.now() });
  r ? res.json(r) : res.status(404).json({ error: "Report expired." });
});

class BadInput extends Error {}
function wp(v) {
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, 300);
  if (v && Number.isFinite(v.lat) && Number.isFinite(v.lng)) return { lat: v.lat, lng: v.lng };
  throw new BadInput("origin and destination must be an address or {lat, lng}");
}

app.listen(PORT, () => console.log(`NYC Parade Nav running at http://localhost:${PORT}`));
