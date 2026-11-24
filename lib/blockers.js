// Blocker detection: replay a Google route against the parade clock, the
// time-windowed closures, MTA station rules and live feeds — at the moment
// the traveler would actually reach each point.

import { decode, dist, intersect, project, toSegment, bearingVec } from "./geo.js";
import {
  PATH, FORMATION, SOURCES, CLOSURES, STATION_RULES,
  pedCrossingStatus, formationBlocked, formationClearAt, describeS, tTail,
} from "./parade.js";

const WALL_CLOSURES = /^(CPW|59th St|6th Ave|34th St|Columbus Ave)/; // can't be crossed by vehicles either
const secs = (d) => parseInt(String(d ?? "0").replace("s", ""), 10) || 0;
const MIN = 60e3;

const PATH_SEGS = segs(PATH);
function segs(pts) {
  const out = []; let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = dist(pts[i - 1], pts[i]);
    out.push({ a: pts[i - 1], b: pts[i], s0: acc, L }); acc += L;
  }
  return out;
}

/** Expand a route into timed steps with geometry. */
export function timeline(route, departAt) {
  const steps = (route.legs ?? []).flatMap((l) => l.steps ?? []);
  let cursor = departAt;
  return steps.map((step) => {
    const td = step.transitDetails;
    let start = cursor, end;
    if (step.travelMode === "TRANSIT" && td?.stopDetails) {
      const dep = Date.parse(td.stopDetails.departureTime);
      const arr = Date.parse(td.stopDetails.arrivalTime);
      start = Number.isFinite(dep) ? dep : cursor;
      end = Number.isFinite(arr) ? arr : start + secs(step.staticDuration) * 1000;
    } else {
      end = start + secs(step.staticDuration) * 1000;
    }
    cursor = Math.max(cursor, end);
    const pts = step.polyline?.encodedPolyline ? decode(step.polyline.encodedPolyline) : [];
    // time at each vertex, proportional to distance
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1] || 1;
    const times = cum.map((c) => start + ((end - start) * c) / total);
    const vehicle = td?.transitLine?.vehicle?.type ?? null;
    const kind = step.travelMode === "TRANSIT" ? (vehicle === "BUS" || vehicle === "TROLLEYBUS" ? "bus" : "rail")
      : step.travelMode === "DRIVE" || step.travelMode === "TWO_WHEELER" ? "vehicle" : "foot";
    return { step, kind, start, end, pts, times, cum };
  });
}

export function analyzeRoute(route, { departAt, wheelchair = false, feeds = null, reports = null } = {}) {
  const tl = timeline(route, departAt);
  const issues = [];
  const add = (o) => issues.push({ ...o, offsetMs: (o.time ?? departAt) - departAt });

  for (const seg of tl) {
    if (seg.kind === "foot") checkPedestrian(seg, add, wheelchair);
    if (seg.kind === "vehicle" || seg.kind === "bus") checkVehicle(seg, add, seg.kind === "bus");
    if (seg.kind === "rail" || seg.kind === "bus") checkTransit(seg, add, { wheelchair, feeds });
    if (reports) checkReports(seg, add, reports, wheelchair);
  }

  const blockers = dedupe(issues.filter((i) => i.severity === "blocker"));
  const warnings = dedupe(issues.filter((i) => i.severity === "warning"));
  const extraWait = warnings.reduce((m, w) => m + (w.extraWaitMs ?? 0), 0);
  const arriveAt = (tl.length ? tl[tl.length - 1].end : departAt) + extraWait;
  const transit = tl.filter((s) => s.kind === "rail" || s.kind === "bus");
  return {
    departAt,
    arriveAt,
    durationMin: Math.round((arriveAt - departAt) / MIN),
    walkMeters: Math.round(tl.filter((s) => s.kind === "foot").reduce((m, s) => m + (s.cum.at(-1) ?? 0), 0)),
    transfers: Math.max(0, transit.length - 1),
    lines: transit.map((s) => s.step.transitDetails?.transitLine?.nameShort).filter(Boolean),
    blockers,
    warnings,
    clear: blockers.length === 0,
  };
}

function checkPedestrian(seg, add, wheelchair) {
  const { pts, times } = seg;
  for (let i = 1; i < pts.length; i++) {
    for (const p of PATH_SEGS) {
      const hit = intersect(pts[i - 1], pts[i], p.a, p.b);
      if (!hit) continue;
      const s = p.s0 + hit.u * p.L;
      const t = times[i - 1] + hit.t * (times[i] - times[i - 1]);
      const st = pedCrossingStatus(s, t);
      const where = { lat: p.a.lat + (p.b.lat - p.a.lat) * hit.u, lng: p.a.lng + (p.b.lng - p.a.lng) * hit.u };
      if (st.status === "blocked") {
        add({ severity: "blocker", kind: "parade_wall", at: where, time: t, until: st.until,
          message: `Crosses the parade route at ${describeS(s)} at ${fmt(t)} — not crossable there until about ${fmt(st.until)}`,
          source: SOURCES.model, alsoSee: SOURCES.nypdCrossings });
      } else if (st.status === "wait") {
        add({ severity: "warning", kind: "crossing_wait", at: where, time: t, extraWaitMs: st.wait,
          message: `Crosses at the NYPD crossing ${st.crossing.name} while the parade passes — expect ~${st.wait / MIN} min wait`,
          source: st.crossing.source });
      }
    }
    if (intersect(pts[i - 1], pts[i], FORMATION[0], FORMATION[1]) && formationBlocked(times[i])) {
      add({ severity: "blocker", kind: "formation", at: pts[i], time: times[i], until: formationClearAt(),
        message: `Crosses the formation area on Central Park West (77th–86th) — closed to the public until about ${fmt(formationClearAt())}`,
        source: SOURCES.fox2026 });
    }
  }
  // Walking along the route itself = walking into the crowd
  let run = 0, runStart = null;
  for (let i = 1; i < pts.length; i++) {
    const pr = project(pts[i], PATH);
    const inCrowd = pr.d < 30 && pedCrossingStatus(pr.s, times[i], { designated: false }).status === "blocked";
    if (inCrowd) { run += dist(pts[i - 1], pts[i]); runStart ??= { i, s: pr.s }; }
    if ((!inCrowd || i === pts.length - 1) && run > 100) {
      add({ severity: wheelchair ? "blocker" : "warning", kind: "crowd", at: pts[runStart.i], time: times[runStart.i],
        until: tTail(runStart.s) + 20 * MIN,
        message: `Walks ${Math.round(run)} m along ${describeS(runStart.s)} while spectators line it${wheelchair ? " — not passable with a wheelchair" : " — slow going"}`,
        source: SOURCES.model });
    }
    if (!inCrowd) { run = 0; runStart = null; }
  }
}

function checkVehicle(seg, add, isBus) {
  const { pts, times } = seg;
  for (const c of CLOSURES) {
    const wall = WALL_CLOSURES.test(c.name);
    let along = 0, alongAt = null;
    for (let i = 1; i < pts.length; i++) {
      const t = times[i];
      if (t < c.start || t >= c.end) { along = 0; continue; }
      // crossing a wall
      if (wall && intersect(pts[i - 1], pts[i], c.points[0], c.points[1])) {
        add({ severity: "blocker", kind: "closure_cross", at: pts[i], time: t, until: c.end, closure: c.id,
          message: `${isBus ? "Bus" : "Route"} crosses ${c.name}, closed until ${fmt(c.end)}`, source: c.source });
      }
      // running along a closed segment
      const d = toSegment(pts[i], c.points[0], c.points[1]).d;
      const [ux, uy] = bearingVec(pts[i - 1], pts[i]), [vx, vy] = bearingVec(c.points[0], c.points[1]);
      if (d < 25 && Math.abs(ux * vx + uy * vy) > 0.9) {
        along += dist(pts[i - 1], pts[i]); alongAt ??= { p: pts[i], t };
        if (along > 50) {
          add({ severity: "blocker", kind: "closure_along", at: alongAt.p, time: alongAt.t, until: c.end, closure: c.id,
            message: `${isBus ? "Bus runs" : "Drives"} on ${c.name}, closed ${fmt(c.start)}–${fmt(c.end)}`, source: c.source });
          along = -Infinity; // report once per closure
        }
      } else if (along > 0) { along = 0; alongAt = null; }
    }
  }
}

function checkTransit(seg, add, { wheelchair, feeds }) {
  const td = seg.step.transitDetails;
  if (!td) return;
  const line = td.transitLine?.nameShort || td.transitLine?.name || "";
  const dep = td.stopDetails?.departureStop, arr = td.stopDetails?.arrivalStop;
  for (const [stop, t, role] of [[dep, seg.start, "board"], [arr, seg.end, "exit"]]) {
    if (!stop?.name) continue;
    for (const r of STATION_RULES) {
      if (!r.stop.test(stop.name) || t < r.start || t >= r.end) continue;
      if (r.lines && !r.lines.includes(line)) continue;
      const hard = r.effect === "closed" || (r.effect === "no_board" && role === "board");
      add({ severity: hard ? "blocker" : "warning", kind: "station", at: latLng(stop), time: t, until: r.end,
        message: `${line ? line + " · " : ""}${stop.name}: ${r.msg}`, source: r.source });
    }
    if (wheelchair && feeds) {
      const acc = feeds.accessibility(stop.name, latLng(stop));
      if (acc === false) add({ severity: "blocker", kind: "access", at: latLng(stop), time: t,
        message: `${stop.name} is not wheelchair accessible`, source: feeds.SOURCES.stations });
      else if (acc === null) add({ severity: "warning", kind: "access", at: latLng(stop), time: t,
        message: `Couldn't verify step-free access at ${stop.name}`, source: feeds.SOURCES.stations });
      for (const o of feeds.elevatorOutages(stop.name)) add({ severity: "blocker", kind: "elevator", at: latLng(stop), time: t,
        message: `Elevator out at ${stop.name}: ${o.text}`, source: feeds.SOURCES.elevators });
    }
  }
  if (feeds && line) {
    for (const a of feeds.alertsFor(line, seg.start)) {
      const names = [dep?.name, arr?.name].filter(Boolean);
      const severe = /suspend|not running|no [a-z0-9 ]*trains|bypass|skip/i.test(a.text) &&
        (!/bypass|skip/i.test(a.text) || names.some((n) => a.text.includes(n)));
      add({ severity: severe ? "blocker" : "warning", kind: "live_alert", time: seg.start,
        message: `${line} alert: ${a.header}`, source: { ...feeds.SOURCES.mta, url: a.url ?? feeds.SOURCES.mta.url }, at: latLng(dep) });
    }
  }
}

// Community reports: a route passing within 40 m of an active report it's
// sensitive to. Two confirmations make it a blocker; one is a warning.
function checkReports(seg, add, R, wheelchair) {
  const { pts, times } = seg;
  if (!pts.length) return;
  const td = seg.step.transitDetails;
  for (const r of R.active(seg.start - 60e3)) {
    const affects = R.KINDS[r.kind]?.affects ?? [];
    if (!affects.includes(seg.kind)) continue;
    let hit = null;
    if (seg.kind === "rail") {
      for (const [stop, t] of [[td?.stopDetails?.departureStop, seg.start], [td?.stopDetails?.arrivalStop, seg.end]]) {
        const p = latLng(stop);
        if (p && R.dist(p, r) < 120) { hit = { p, t }; break; }
      }
    } else {
      for (let i = 1; i < pts.length && !hit; i++) {
        const { d, t: u } = toSegment(r, pts[i - 1], pts[i]);
        if (d < 40) hit = { p: { lat: r.lat, lng: r.lng }, t: times[i - 1] + u * (times[i] - times[i - 1]) };
      }
    }
    if (!hit || hit.t < r.createdAt || hit.t >= r.expiresAt) continue;
    const confirmed = R.status(r) === "confirmed";
    const hard = confirmed || (wheelchair && r.kind === "barricade");
    const ago = Math.max(0, Math.round((seg.start - r.createdAt) / 60e3));
    add({ severity: hard ? "blocker" : "warning", kind: "report", at: hit.p, time: hit.t, until: r.expiresAt, reportId: r.id,
      message: `${R.KINDS[r.kind].label} reported ${ago} min ago (${r.confirms.length} confirmation${r.confirms.length > 1 ? "s" : ""})${r.extracted?.summary ? `: ${r.extracted.summary}` : r.note ? `: ${r.note}` : ""}`,
      source: R.SOURCE });
  }
}

const latLng = (stop) => {
  const l = stop?.location?.latLng;
  return l ? { lat: l.latitude, lng: l.longitude } : null;
};

function dedupe(list) {
  const seen = new Set();
  return list.filter((i) => {
    const k = i.kind + "|" + i.message.replace(/\d{1,2}:\d{2} [ap]m/g, "");
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

export const fmt = (t) =>
  new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).toLowerCase();
