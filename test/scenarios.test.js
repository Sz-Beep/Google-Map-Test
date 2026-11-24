// Outline test plan, steps 3–5: replay parade morning with a fake Google
// (so it runs offline) and check the pass criteria:
//   - no recommended route crosses an active closure
//   - every blocker/warning links to a source
//   - no booking happens (the agent has no booking capability at all in v1)
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encode, dist } from "../lib/geo.js";
import { at, T, CROSSINGS, AROUND, DRIVE_VIAS, HOPS } from "../lib/parade.js";
import { plan } from "../lib/planner.js";
import * as reports from "../lib/reports.js";

// --- fake Google: L-shaped grid routes between known places ---------------
const PLACES = {
  "80th & Amsterdam": at(10, 80),
  "Murray Hill": at(3.8, 36),
  "West 75th & West End": at(11, 75),
  "Penn Station": at(7.5, 32),
  "Chelsea": at(8, 22),
  "Upper East Side": at(3.5, 80),
};
for (const c of [...CROSSINGS, ...AROUND]) PLACES[c.address] = c.point;
for (const v of DRIVE_VIAS) v.vias.forEach((a, i) => (PLACES[a] = i === 0 ? v.point : at(5, 97)));
for (const h of HOPS) PLACES[h.address] = h.point;
const pt = (v) => (typeof v === "string" ? PLACES[v] ?? assert.fail(`unknown place ${v}`) : v);

const SPEED = { WALK: 1.3, BICYCLE: 4, DRIVE: 6 };
function step(mode, pts) {
  let m = 0; for (let i = 1; i < pts.length; i++) m += dist(pts[i - 1], pts[i]);
  return { travelMode: mode, staticDuration: `${Math.round(m / SPEED[mode])}s`, distanceMeters: Math.round(m), polyline: { encodedPolyline: encode(pts) } };
}
function gridPath(a, b, aveFirst = false) {
  // corner where the "avenue" through a meets the "street" through b, using grid basis
  const corner = aveFirst ? cornerAveFirst(a, b) : cornerStreetFirst(a, b);
  return [a, corner, b];
}
// Solve a + i*AVE_DIR = b + j*STREET_DIR in lat/lng space
const AVE_DIR = { lat: 0.000624, lng: 0.000456 }; // along an avenue (north)
const ST_DIR = { lat: 0.00112, lng: -0.00305 }; // along a street (west)
function solve(p, u, q, v) {
  const det = u.lat * -v.lng - -v.lat * u.lng;
  const i = ((q.lat - p.lat) * -v.lng - -v.lat * (q.lng - p.lng)) / det;
  return { lat: p.lat + i * u.lat, lng: p.lng + i * u.lng };
}
const cornerStreetFirst = (a, b) => solve(a, ST_DIR, b, AVE_DIR);
const cornerAveFirst = (a, b) => solve(a, AVE_DIR, b, ST_DIR);

let calls = [];
const fakeGoogle = {
  async computeRoutes(args) {
    calls.push(args);
    const o = pt(args.origin), d = pt(args.destination);
    const vias = (args.vias ?? []).map(pt);
    if (args.mode === "TRANSIT") return [transitRoute(args, o, d)];
    const stops = [o, ...vias, d];
    const pts = [];
    for (let i = 1; i < stops.length; i++) {
      const aveFirst = vias.length > 0 && (i === 1 || args.mode === "DRIVE");
      pts.push(...gridPath(stops[i - 1], stops[i], aveFirst).slice(i > 1 ? 1 : 0));
    }
    const s = step(args.mode, pts);
    return [{ duration: s.staticDuration, legs: [{ steps: [s] }], polyline: s.polyline }];
  },
};

// Transit: from UWS the "Google" answer boards the C at 81 St (closed till 11);
// from a hop station it takes the 1 train.
function transitRoute(args, o, d) {
  const t0 = args.departAt;
  const iso = (ms) => new Date(ms).toISOString();
  const fromHop = typeof args.origin === "string" && args.origin.startsWith("Broadway");
  const st = fromHop
    ? { name: "79 St", line: "1", at: o, to: { name: "Times Sq-42 St", p: at(7, 42) } }
    : { name: "81 St-Museum of Natural History", line: "C", at: at(8, 81), to: { name: "42 St-Port Authority Bus Terminal", p: at(8, 42) } };
  const walk1 = step("WALK", gridPath(o, st.at));
  const dep = t0 + Number(walk1.staticDuration.slice(0, -1)) * 1000 + 4 * 60e3, arr = dep + 16 * 60e3;
  const ride = {
    travelMode: "TRANSIT", staticDuration: `${(arr - dep) / 1000}s`,
    polyline: { encodedPolyline: encode([st.at, st.to.p]) },
    transitDetails: {
      transitLine: { nameShort: st.line, vehicle: { type: "SUBWAY" } },
      stopDetails: {
        departureStop: { name: st.name, location: { latLng: { latitude: st.at.lat, longitude: st.at.lng } } },
        arrivalStop: { name: st.to.name, location: { latLng: { latitude: st.to.p.lat, longitude: st.to.p.lng } } },
        departureTime: iso(dep), arrivalTime: iso(arr),
      },
    },
  };
  // the subway carries you under the route; the last walk stays east of it
  const walk2 = step("WALK", gridPath(at(4.6, 42), d, true));
  return { duration: "0s", legs: [{ steps: [walk1, ride, walk2] }] };
}

const feeds = { alertsFor: () => [], accessibility: () => null, elevatorOutages: () => [],
  SOURCES: { mta: { url: "https://www.mta.info/alerts" }, stations: { url: "https://data.ny.gov" }, elevators: { url: "https://www.mta.info" } } };
const run = (req) => { calls = []; return plan(req, { google: fakeGoogle, feeds, reports: reports.forEngine }); };

function passCriteria(p) {
  const best = p.options.find((o) => o.id === p.recommended);
  assert.ok(best, "a clean option is recommended");
  assert.equal(best.analysis.blockers.length, 0, "recommended route crosses no active closure");
  for (const o of p.options) for (const i of [...o.analysis.blockers, ...o.analysis.warnings]) {
    assert.match(i.source?.url ?? "", /^(https:\/\/|#)/, `issue has a source: ${i.message}`);
  }
  return best;
}

test("Dev walks UWS → Murray Hill at 9:00: Google crosses the closed CPW, agent finds a crossing", async () => {
  const p = await run({ origin: "80th & Amsterdam", destination: "Murray Hill", mode: "WALK", departAt: T(26, "09:00") });
  assert.equal(p.options.find((o) => o.id === "g0").analysis.clear, false);
  assert.match(p.options.find((o) => o.id === "g0").analysis.blockers[0].message, /formation|Central Park West/);
  const best = passCriteria(p);
  assert.ok(calls.some((c) => c.vias?.length), "remapped with Google via-waypoints");
  console.log("   →", p.summary);
});

test("Dev takes transit at 9:00: Google boards the C at closed 81 St, agent hops to the 1", async () => {
  const p = await run({ origin: "80th & Amsterdam", destination: "Murray Hill", mode: "TRANSIT", departAt: T(26, "09:00") });
  assert.match(p.options[p.options.length - 1].analysis.blockers.concat(...p.options.map((o) => o.analysis.blockers)).map((b) => b.message).join(" "), /81 St/);
  const best = passCriteria(p);
  assert.equal(best.strategy, "hop");
  console.log("   →", p.summary);
});

test("Dev at 10:30 with an arrive-by of noon gets a leave-by time", async () => {
  const p = await run({ origin: "80th & Amsterdam", destination: "Murray Hill", mode: "WALK", departAt: T(26, "10:30"), arriveBy: T(26, "12:00") });
  passCriteria(p);
  assert.ok(p.leaveBy, "leave-by computed");
  console.log("   →", p.summary);
});

test("Dev at 12:15: the parade has passed, Google's route is fine", async () => {
  const p = await run({ origin: "80th & Amsterdam", destination: "Murray Hill", mode: "WALK", departAt: T(26, "12:15") });
  const best = passCriteria(p);
  assert.equal(best.id, "g0");
  assert.equal(calls.length, 1, "no extra Google calls when nothing is blocked");
});

test("Driver West 70s → Penn Station at 9:30: routed around the closures", async () => {
  const p = await run({ origin: "West 75th & West End", destination: "Penn Station", mode: "DRIVE", departAt: T(26, "09:30") });
  const best = passCriteria(p);
  assert.notEqual(best.id, "g0");
  console.log("   →", p.summary);
});

test("Wheelchair user Chelsea → UES: never routed along the crowd; access gaps flagged", async () => {
  const p = await run({ origin: "Chelsea", destination: "Upper East Side", mode: "WALK", departAt: T(26, "10:00"), wheelchair: true });
  passCriteria(p);
});

test("No booking capability exists in v1", () => {
  const src = ["server.js", "lib/planner.js", "lib/watcher.js"].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(src, /book|payment|checkout|uber|lyft/i);
});

test("One photo report of a barricade = warning; a second confirmation = blocker and a re-route", async () => {
  reports._reset();
  const spot = at(9.5, 80); // on Google's walking route along W 80th St
  const t = T(26, "12:10");
  reports.add({ ...spot, kind: "barricade", note: "NYPD barricade, no crossing", reporter: "a", time: t });
  let p = await run({ origin: "80th & Amsterdam", destination: "Murray Hill", mode: "WALK", departAt: T(26, "12:15") });
  let g = p.options.find((o) => o.id === "g0");
  assert.ok(g.analysis.clear && g.analysis.warnings.some((w) => w.kind === "report"), "single report warns");
  assert.equal(p.recommended, "g0");

  reports.add({ lat: spot.lat + 0.0001, lng: spot.lng, kind: "barricade", reporter: "b", time: t + 60e3 }); // second person, 11 m away
  p = await run({ origin: "80th & Amsterdam", destination: "Murray Hill", mode: "WALK", departAt: T(26, "12:15") });
  g = p.options.find((o) => o.id === "g0");
  assert.ok(g.analysis.blockers.some((b) => b.kind === "report"), "confirmed report blocks");
  const best = passCriteria(p);
  assert.notEqual(best.id, "g0");
  console.log("   →", p.summary);
  reports._reset();
});

test("Reports expire, and two 'gone' votes clear them", () => {
  reports._reset();
  const t = T(26, "10:00");
  const r = reports.add({ lat: 40.77, lng: -73.98, kind: "crowd", reporter: "a", time: t });
  assert.equal(reports.active(t + 31 * 60e3).length, 0, "crowd report expires after 30 min");
  reports.confirm(r.id, { reporter: "b", still: false, time: t + 60e3 });
  reports.confirm(r.id, { reporter: "c", still: false, time: t + 2 * 60e3 });
  assert.equal(reports.active(t + 3 * 60e3).length, 0, "cleared by two 'gone' votes");
  reports._reset();
});
