// Live disruption feeds. Each poller is independent: if one fails, the others
// keep working and /api/sources shows what's stale.
//
//   MTA service alerts (GTFS-rt, JSON)   every 60 s   subway/bus/rail changes
//   MTA elevator & escalator outages     every 5 min  step-free access
//   MTA subway stations (ADA flags)      daily        accessibility lookup
//   511NY events (needs free dev key)    every 2 min  NYC DOT / NYPD road events
//   NYC Open Data permitted events       hourly       CECM-permitted closures

import { dist } from "./geo.js";

const MTA_KEY = process.env.MTA_API_KEY; // optional; sent as x-api-key if set
const KEY_511 = process.env.NY511_API_KEY; // https://511ny.org/developers

export const SOURCES = {
  mta: { name: "MTA service alerts (GTFS-realtime)", url: "https://www.mta.info/alerts", confidence: "live" },
  elevators: { name: "MTA elevator & escalator status", url: "https://www.mta.info/elevator-escalator-status", confidence: "live" },
  stations: { name: "MTA Subway Stations dataset (ADA)", url: "https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f", confidence: "official" },
  ny511: { name: "511NY traffic events", url: "https://511ny.org/", confidence: "live" },
  permits: { name: "NYC Permitted Event Information (CECM)", url: "https://data.cityofnewyork.us/d/tvpp-9vvx", confidence: "official" },
};

const FEEDS = {
  mta: { url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts.json", every: 60e3 },
  elevators: { url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json", every: 300e3 },
  stations: { url: "https://data.ny.gov/resource/39hk-dx4f.json?$limit=1000", every: 86400e3 },
  ny511: { url: KEY_511 ? `https://511ny.org/api/v2/get/event?key=${KEY_511}&format=json` : null, every: 120e3 },
  permits: {
    url: "https://data.cityofnewyork.us/resource/tvpp-9vvx.json?$limit=500&event_borough=Manhattan&$order=start_date_time",
    every: 3600e3,
  },
};

const state = Object.fromEntries(Object.keys(FEEDS).map((k) => [k, { ok: null, at: null, error: null, items: [] }]));

async function poll(name) {
  const f = FEEDS[name];
  if (!f.url) { state[name] = { ...state[name], ok: false, error: "not configured (add API key to .env)" }; return; }
  try {
    const headers = name === "mta" || name === "elevators" ? (MTA_KEY ? { "x-api-key": MTA_KEY } : {}) : {};
    const r = await fetch(f.url, { headers, signal: AbortSignal.timeout(15e3) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state[name] = { ok: true, at: Date.now(), error: null, items: PARSE[name](data) };
  } catch (e) {
    state[name] = { ...state[name], ok: false, error: String(e.message ?? e) };
  }
}

export function start() {
  for (const name of Object.keys(FEEDS)) {
    poll(name);
    setInterval(() => poll(name), FEEDS[name].every).unref();
  }
}

// --- parsers (tolerant: feed shapes drift) ---------------------------------
const tx = (t) => t?.translation?.find((x) => !x.language || x.language === "en")?.text ?? t?.translation?.[0]?.text ?? "";
const PARSE = {
  mta: (d) => (d.entity ?? []).map((e) => {
    const a = e.alert ?? {};
    return {
      id: e.id,
      header: tx(a.header_text),
      text: `${tx(a.header_text)} ${tx(a.description_text)}`,
      routes: [...new Set((a.informed_entity ?? []).map((i) => i.route_id).filter(Boolean))],
      stops: [...new Set((a.informed_entity ?? []).map((i) => i.stop_id).filter(Boolean))],
      periods: (a.active_period ?? []).map((p) => [Number(p.start ?? 0) * 1000, p.end ? Number(p.end) * 1000 : Infinity]),
      url: SOURCES.mta.url,
    };
  }),
  elevators: (d) => (Array.isArray(d) ? d : d.outages ?? []).map((o) => {
    const g = (k) => o[k] ?? o[k.toLowerCase()] ?? o[k.toUpperCase()];
    return {
      station: String(g("station") ?? ""),
      equipment: g("equipmenttype") ?? g("equipment"),
      ada: String(g("ADA") ?? "").toUpperCase() === "Y",
      text: `${g("serving") ?? g("equipment") ?? ""} — ${g("reason") ?? "out of service"}`.trim(),
    };
  }).filter((o) => /EL/i.test(String(o.equipment))),
  stations: (d) => d.map((s) => ({
    name: s.stop_name,
    ada: Number(s.ada),
    lat: Number(s.gtfs_latitude),
    lng: Number(s.gtfs_longitude),
  })).filter((s) => Number.isFinite(s.lat)),
  ny511: (d) => (Array.isArray(d) ? d : []).filter((e) => /new york|manhattan/i.test(`${e.County ?? ""} ${e.RegionName ?? ""}`) ||
      (e.Latitude > 40.7 && e.Latitude < 40.82 && e.Longitude > -74.02 && e.Longitude < -73.93))
    .map((e) => ({
      id: e.ID, header: `${e.RoadwayName ?? ""}: ${e.Description ?? e.EventType ?? ""}`.trim(),
      type: e.EventType, full: !!e.IsFullClosure,
      a: { lat: e.Latitude, lng: e.Longitude },
      b: e.LatitudeSecondary ? { lat: e.LatitudeSecondary, lng: e.LongitudeSecondary } : null,
      start: Date.parse(e.StartDate) || null, end: Date.parse(e.PlannedEndDate) || null,
      url: SOURCES.ny511.url,
    })),
  permits: (d) => d.filter((e) => /thanksgiving|macy/i.test(e.event_name ?? "")).map((e) => ({
    id: e.event_id, header: e.event_name, location: e.event_location,
    closure: e.street_closure_type, start: Date.parse(e.start_date_time), end: Date.parse(e.end_date_time),
    url: SOURCES.permits.url,
  })),
};

// --- lookups used by the blocker engine --------------------------------------
const activeAt = (a, t) => !a.periods.length || a.periods.some(([s, e]) => t >= s && t < e);

export function alertsFor(line, t) {
  return state.mta.items.filter((a) => a.routes.includes(line) && activeAt(a, t));
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
/** true / false / null (unknown) */
export function accessibility(name, loc) {
  const list = state.stations.items;
  if (!list.length) return null;
  const near = loc ? list.filter((s) => dist(loc, s) < 200) : [];
  const cand = near.find((s) => norm(s.name) === norm(name)) ?? near[0] ?? list.find((s) => norm(s.name) === norm(name));
  if (!cand) return null;
  return cand.ada >= 1; // 1 = fully accessible, 2 = partial (one direction)
}

export function elevatorOutages(name) {
  const n = norm(name).slice(0, 8);
  return state.elevators.items.filter((o) => norm(o.station).includes(n));
}

export function snapshot(t = Date.now()) {
  return {
    alerts: state.mta.items.filter((a) => activeAt(a, t)).slice(0, 200),
    roadEvents: state.ny511.items,
    permits: state.permits.items,
    status: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { ok: v.ok, at: v.at, error: v.error, count: v.items.length, source: SOURCES[k] }])),
  };
}

export const feeds = { alertsFor, accessibility, elevatorOutages, SOURCES };
