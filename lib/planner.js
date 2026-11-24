// The agent loop for one trip:
//   1. ask Google for its routes (+ alternatives)
//   2. replay each against parade-day blockers
//   3. if nothing is clean, remap with Google: force a crossing point or a
//      corridor with via-waypoints, stitch walk+transit legs around closed
//      stations, or move the departure until the blocker clears
//   4. rank, pick one, and compute "leave by"

import { analyzeRoute, fmt } from "./blockers.js";
import { decode, dist } from "./geo.js";
import { CROSSINGS, AROUND, DRIVE_VIAS, HOPS } from "./parade.js";

const MIN = 60e3;
const BUFFER = 10 * MIN; // parade-day slack on "leave by"
const secs = (d) => parseInt(String(d ?? "0").replace("s", ""), 10) || 0;

export async function plan(req, { google, feeds, reports = null, now = Date.now(), budget = 8 }) {
  const mode = ["TRANSIT", "WALK", "BICYCLE", "DRIVE"].includes(req.mode) ? req.mode : "TRANSIT";
  const ctx = { google, feeds, reports, wheelchair: !!req.wheelchair, calls: 0, budget };
  const departAt = req.departAt ?? (req.arriveBy ? null : now);
  const options = [];

  // 1–2. Google's own answer
  const base = await call(ctx, { origin: req.origin, destination: req.destination, mode, departAt, arriveBy: req.arriveBy,
    transit: { routingPreference: req.transitPreference } });
  if (!base.length) throw new Error(ctx.lastError ? `Google Routes API: ${ctx.lastError}` : "Google returned no routes for this trip.");
  base.forEach((route, i) => {
    const dep = departAt ?? deriveDepart(route, req.arriveBy);
    options.push(option(`g${i}`, i === 0 ? "Google's suggested route" : `Google alternative ${i}`, "google",
      [{ mode, route }], dep, ctx));
  });

  const o = firstPoint(base[0]), d = lastPoint(base[0]);
  const dep0 = options[0].analysis.departAt;

  // 3. Remap only if Google's routes are all blocked
  if (!options.some((x) => x.analysis.clear)) {
    const blocked = options[0].analysis.blockers;
    if (mode === "TRANSIT") await remapTransit(req, ctx, options, { o, d, dep0, blocked });
    else if (mode === "DRIVE") await remapVia(req, ctx, options, { o, d, dep0, mode, candidates: DRIVE_VIAS.map((v) => ({ ...v, vias: v.vias })) });
    else await remapVia(req, ctx, options, { o, d, dep0, mode,
      candidates: [...CROSSINGS, ...AROUND].map((c) => ({ ...c, vias: [c.address] })) });
    await waitOption(req, ctx, options, { mode, dep0 });
  }

  // 4. Rank: clean first, then earliest arrival, then least walking
  const ranked = [...options].sort((a, b) =>
    (b.analysis.clear - a.analysis.clear) ||
    (a.analysis.arriveAt - b.analysis.arriveAt) ||
    (a.analysis.walkMeters - b.analysis.walkMeters));
  const best = ranked.find((x) => x.analysis.clear) ?? null;
  const google0 = options[0];

  let leaveBy = null, late = false;
  if (best) {
    leaveBy = best.analysis.departAt - (req.arriveBy ? BUFFER : 0);
    if (req.arriveBy) late = best.analysis.arriveAt > req.arriveBy;
  }

  return {
    request: { ...req, mode },
    options: ranked,
    recommended: best?.id ?? null,
    leaveBy,
    late,
    googleCalls: ctx.calls,
    summary: summarize(google0, best, leaveBy, req),
  };
}

function option(id, label, strategy, parts, departAt, ctx, extra = {}) {
  // Analyze parts in sequence; each starts when the previous one ends.
  let t = departAt;
  const analyses = parts.map((p) => {
    const a = analyzeRoute(p.route, { departAt: t, wheelchair: ctx.wheelchair, feeds: ctx.feeds, reports: ctx.reports });
    t = a.arriveAt;
    return a;
  });
  const analysis = {
    departAt,
    arriveAt: t,
    durationMin: Math.round((t - departAt) / MIN),
    walkMeters: analyses.reduce((m, a) => m + a.walkMeters, 0),
    transfers: analyses.reduce((m, a) => m + a.transfers, 0) + Math.max(0, analyses.filter((a) => a.lines.length).length - 1),
    lines: analyses.flatMap((a) => a.lines),
    blockers: analyses.flatMap((a) => a.blockers),
    warnings: analyses.flatMap((a) => a.warnings),
  };
  analysis.clear = analysis.blockers.length === 0;
  return { id, label, strategy, parts, analysis, ...extra };
}

async function call(ctx, args) {
  if (ctx.calls >= ctx.budget) return [];
  ctx.calls++;
  try { return await ctx.google.computeRoutes(args); }
  catch (e) { ctx.lastError = e.message; return []; }
}

// --- remapping strategies ---------------------------------------------------

/** WALK / BICYCLE / DRIVE: force the route through a crossing or corridor. */
async function remapVia(req, ctx, options, { o, d, dep0, mode, candidates }) {
  const direct = dist(o, d);
  const ranked = candidates
    .map((c) => ({ ...c, detour: dist(o, c.point) + dist(c.point, d) - direct }))
    .sort((a, b) => a.detour - b.detour)
    .slice(0, mode === "DRIVE" ? 2 : 3);
  for (const c of ranked) {
    const [route] = await call(ctx, { origin: req.origin, destination: req.destination, mode, departAt: dep0, vias: c.vias, alternatives: false });
    if (route) options.push(option(`via-${c.id}`, mode === "DRIVE" ? `Drive via ${c.name}` : `Cross at ${c.name}`, "via", [{ mode, route }], dep0, ctx, { via: c.name }));
  }
}

/** TRANSIT: stitch a walk to an open station + transit, since transit can't take vias. */
async function remapTransit(req, ctx, options, { o, d, dep0, blocked }) {
  // a. drop buses if a bus is what's stuck
  if (blocked.some((b) => /^Bus/.test(b.message) || b.kind.startsWith("closure"))) {
    const routes = await call(ctx, { origin: req.origin, destination: req.destination, mode: "TRANSIT", departAt: dep0,
      transit: { allowedTravelModes: ["SUBWAY", "TRAIN", "RAIL", "LIGHT_RAIL"] } });
    routes.slice(0, 2).forEach((route, i) => options.push(option(`rail${i}`, "Subway/rail only (no buses)", "no-bus", [{ mode: "TRANSIT", route }], dep0, ctx)));
  }
  // b. walk to an open station near the origin, then ride
  const blockedStations = blocked.filter((b) => b.kind === "station").map((b) => b.message);
  const hops = HOPS
    .filter((h) => !blockedStations.some((m) => m.includes(h.name.split(" (")[0])))
    .map((h) => ({ ...h, dO: dist(o, h.point), dD: dist(h.point, d) }))
    .filter((h) => h.dO < 1600 && h.dD < dist(o, d))
    .sort((a, b) => a.dO - b.dO)
    .slice(0, 2);
  for (const h of hops) {
    const [walk] = await call(ctx, { origin: req.origin, destination: h.address, mode: "WALK", departAt: dep0, alternatives: false });
    if (!walk) continue;
    const t1 = dep0 + secs(walk.duration) * 1000;
    const [ride] = await call(ctx, { origin: h.address, destination: req.destination, mode: "TRANSIT", departAt: t1, alternatives: false });
    if (ride) options.push(option(`hop-${h.name}`, `Walk to ${h.name}, then transit`, "hop",
      [{ mode: "WALK", route: walk }, { mode: "TRANSIT", route: ride }], dep0, ctx, { via: h.name }));
  }
}

/** Any mode: if every blocker clears by itself, leave later. */
async function waitOption(req, ctx, options, { mode, dep0 }) {
  const g = options[0];
  const bl = g.analysis.blockers;
  if (!bl.length || bl.some((b) => !b.until)) return;
  const newDep = Math.max(...bl.map((b) => b.until - b.offsetMs)) + 5 * MIN;
  if (newDep - dep0 > 6 * 60 * MIN) return;
  let parts = g.parts;
  if (mode === "TRANSIT") { // schedules change, so ask again
    const [route] = await call(ctx, { origin: req.origin, destination: req.destination, mode, departAt: newDep, alternatives: false });
    if (!route) return;
    parts = [{ mode, route }];
  }
  options.push(option("wait", `Leave at ${fmt(newDep)} instead (route clears)`, "wait", parts, newDep, ctx));
}

// --- helpers ----------------------------------------------------------------
function steps(route) { return (route.legs ?? []).flatMap((l) => l.steps ?? []); }
function firstPoint(route) {
  const s = steps(route).find((x) => x.polyline?.encodedPolyline);
  return s ? decode(s.polyline.encodedPolyline)[0] : decode(route.polyline.encodedPolyline)[0];
}
function lastPoint(route) {
  const s = steps(route).filter((x) => x.polyline?.encodedPolyline).at(-1);
  const pts = decode(s ? s.polyline.encodedPolyline : route.polyline.encodedPolyline);
  return pts[pts.length - 1];
}
function deriveDepart(route, arriveBy) {
  const st = steps(route);
  const i = st.findIndex((s) => s.transitDetails?.stopDetails?.departureTime);
  if (i >= 0) {
    const before = st.slice(0, i).reduce((m, s) => m + secs(s.staticDuration), 0);
    return Date.parse(st[i].transitDetails.stopDetails.departureTime) - before * 1000;
  }
  return arriveBy - secs(route.duration) * 1000 - BUFFER;
}

function summarize(g, best, leaveBy, req) {
  const parts = [];
  if (g.analysis.clear) parts.push(`Google's route is clear for this trip.`);
  else parts.push(`Google's route hits ${g.analysis.blockers.length} parade-day blocker${g.analysis.blockers.length > 1 ? "s" : ""}: ${g.analysis.blockers[0].message}.`);
  if (best && best.id !== g.id) parts.push(`Best option: ${best.label}, arriving ${fmt(best.analysis.arriveAt)}.`);
  if (best && req.arriveBy) parts.push(`Leave by ${fmt(leaveBy)}.`);
  if (!best) parts.push("No clean option found — walking directions with a live check are the fallback.");
  return parts.join(" ");
}
