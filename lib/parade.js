// Parade-day knowledge base for the 100th Macy's Thanksgiving Day Parade
// (Thu Nov 26, 2026). Everything here carries a source and a confidence label,
// because the agent must link every closure it acts on to where it came from.
//
// confidence:
//   "official"  — published by NYPD / NYC DOT / MTA for 2026
//   "reported"  — 2026 schedule as reported by press, citing the city notice
//   "prior-year"— taken from previous years' NYPD advisories; verify for 2026
//   "model"     — our parade-clock estimate, replaced by live position when known

import { ll, pathLength, project, pointAlong, slice } from "./geo.js";

export const TZ = "-05:00";
export const T = (day, hm) => new Date(`2026-11-${day}T${hm}:00${TZ}`).getTime();
const MIN = 60e3;
export const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");

export const SOURCES = {
  mta2026: {
    name: "MTA — Thanksgiving 2026 service changes",
    url: "https://www.mta.info/article/mta-service-thanksgiving-2026-0",
    confidence: "official",
  },
  closures2026: {
    name: "2026 closure schedule (NYC DOT / Mayor's Office notice, as reported)",
    url: "https://www.travelandtourworld.com/news/article/6hubobcqcejn/",
    confidence: "reported",
  },
  fox2026: {
    name: "FOX 5 NY — 2026 parade road closures (NYPD list)",
    url: "https://www.fox5ny.com/news/nyc-macys-thanksgiving-day-parade-2026-street-closures-map",
    confidence: "reported",
  },
  nypdCrossings: {
    name: "NYPD parade traffic advisory — designated crossings (prior years)",
    url: "https://www.nyc.gov/site/nypd/news/tr1120/traffic-advisory-wednesday-november-21-thursday-november-22-thanksgiving-day-",
    confidence: "prior-year",
  },
  nypdCrossings2024: {
    name: "NYPD 2024 parade advisory (via ABC7)",
    url: "https://abc7ny.com/post/macys-thanksgiving-day-parade-2024-road-street-closures-list/15568643/",
    confidence: "prior-year",
  },
  cecm: {
    name: "NYC Citywide Event Coordination & Management — street closure notices",
    url: "https://www.nyc.gov/site/cecm/index.page",
    confidence: "official",
  },
  model: {
    name: "Parade clock model (8:30 step-off, ~noon finish) — replaced by live position reports",
    url: "https://www.fox5ny.com/news/nyc-macys-thanksgiving-day-parade-2026-street-closures-map",
    confidence: "model",
  },
};

// ---------------------------------------------------------------------------
// Manhattan grid → lat/lng (approximate, ±50 m). Avenue index: 5=Fifth,
// 6=Sixth, 7=Seventh, 8=Eighth/Central Park West, 9=Ninth/Columbus.
// Good enough to detect "does this route cross / run along this street";
// precise geometry comes from Google's own polylines.
// ---------------------------------------------------------------------------
const SIXTH_59 = ll(40.7653, -73.9763);
const STREET_S = { lat: 0.000624, lng: 0.000456 }; // per street, south of 59th
const CC = ll(40.768, -73.9819); // Columbus Circle (8th Ave & 59th)
const STREET_N = { lat: 0.000683, lng: 0.000456 }; // per street, CPW north of 59th
const AVE = { lat: 0.00112, lng: -0.00305 }; // one avenue block westward

export function at(ave, st) {
  if (ave === "B") ave = 6 + (st - 34) / 11; // Broadway, 32nd–45th
  if (st >= 59) {
    return ll(CC.lat + (st - 59) * STREET_N.lat + (ave - 8) * AVE.lat,
              CC.lng + (st - 59) * STREET_N.lng + (ave - 8) * AVE.lng);
  }
  return ll(SIXTH_59.lat + (st - 59) * STREET_S.lat + (ave - 6) * AVE.lat,
            SIXTH_59.lng + (st - 59) * STREET_S.lng + (ave - 6) * AVE.lng);
}

// ---------------------------------------------------------------------------
// Route: CPW from 77th south to Columbus Circle, east on Central Park South,
// south on 6th Ave, west on 34th to Herald Square (7th Ave).
// ---------------------------------------------------------------------------
export const PATH = [at(8, 77), CC, at(6, 59), at(6, 34), at(7, 34)];
export const FORMATION = [at(8, 86), at(8, 77)]; // staging on CPW north of the start
export const LENGTH = pathLength(PATH);

const model = {
  stepOff: T(26, "08:30"),
  headArrive: T(26, "09:30"), // first units reach Herald Sq (estimate)
  tailArrive: T(26, "12:00"), // Santa reaches Herald Sq
  pedWallStart: T(26, "06:00"), // crowds + barricades make the route uncrossable
  formationWallStart: T(26, "00:00"),
  clearBuffer: 20 * MIN, // barricades come down after the tail passes
  delay: 0, // live correction from position reports
  lastReport: null,
};
const travel = () => model.headArrive - model.stepOff;
const tailStart = () => model.tailArrive - travel();

export const tHead = (s) => model.stepOff + model.delay + (s / LENGTH) * travel();
export const tTail = (s) => tailStart() + model.delay + (s / LENGTH) * travel();
export const headS = (t) => clamp(((t - model.stepOff - model.delay) / travel()) * LENGTH);
export const tailS = (t) => clamp(((t - tailStart() - model.delay) / travel()) * LENGTH);
const clamp = (v) => Math.max(0, Math.min(LENGTH, v));

/** Live correction: "the head (or tail) is at this spot right now". */
export function reportPosition({ lat, lng, which = "head", time }) {
  const { s } = project(ll(lat, lng), PATH);
  const expected = which === "tail" ? tTail(s) - model.delay : tHead(s) - model.delay;
  model.delay = time - expected;
  model.lastReport = { which, lat, lng, time, delayMin: Math.round(model.delay / MIN) };
  return model.lastReport;
}
export const modelInfo = () => ({ ...model, tailStart: tailStart(), length: LENGTH });

/** Name a point on the route the way a New Yorker would. */
export function describeS(s) {
  const cc = project(CC, PATH).s, six59 = project(at(6, 59), PATH).s, six34 = project(at(6, 34), PATH).s;
  if (s < 0) return "the parade formation area on Central Park West (77th–86th St)";
  if (s <= cc) return `Central Park West near W ${ord(Math.round(77 - (s / cc) * 18))} St`;
  if (s <= six59) return "Central Park South (59th St)";
  if (s <= six34) return `6th Ave near W ${ord(Math.round(59 - ((s - six59) / (six34 - six59)) * 25))} St`;
  return "34th St at Herald Square";
}

// ---------------------------------------------------------------------------
// Pedestrian crossing points the NYPD has kept open in past parades.
// ---------------------------------------------------------------------------
export const CROSSINGS = [58, 52, 48, 44, 40, 39, 37].map((st) => ({
  id: `x${st}`,
  name: `6th Ave & W ${ord(st)} St`,
  address: `W ${ord(st)} St & 6th Ave, New York, NY`,
  point: at(6, st),
  s: project(at(6, st), PATH).s,
  waitMin: 15,
  source: st === 58 ? SOURCES.nypdCrossings2024 : SOURCES.nypdCrossings,
}));

// Places to get around the route entirely (pedestrian / bike)
export const AROUND = [
  { id: "n90", name: "Central Park West & W 90th St (north of formation)", address: "W 90th St & Central Park W, New York, NY", point: at(8, 90) },
  { id: "s30", name: "6th Ave & W 30th St (south of the finish)", address: "W 30th St & 6th Ave, New York, NY", point: at(6, 30) },
];

// Vehicle corridors that stay open across the closures
export const DRIVE_VIAS = [
  { id: "t97", name: "97th St Transverse", vias: ["W 97th St & Central Park W, New York, NY", "E 97th St & 5th Ave, New York, NY"], point: at(8, 97) },
  { id: "s18", name: "cross 6th Ave at 18th St (south of the closures)", vias: ["W 18th St & 6th Ave, New York, NY"], point: at(6, 18) },
  { id: "wsh", name: "West Side Highway", vias: ["12th Ave & W 42nd St, New York, NY"], point: at(12, 42) },
];

// ---------------------------------------------------------------------------
// Vehicle closures (time-windowed). These are what consumer maps often show
// as a static "road closed" — or not at all — without when it reopens.
// ---------------------------------------------------------------------------
const seg = (a, b) => [at(...a), at(...b)];
export const CLOSURES = [
  ["CPW 72nd–88th St", seg([8, 72], [8, 88]), T(25, "02:00"), T(26, "15:00"), SOURCES.closures2026],
  ["CPW 59th–72nd St", seg([8, 59], [8, 72]), T(25, "08:00"), T(26, "15:00"), SOURCES.closures2026],
  ["W 72nd St, CPW–Columbus", seg([8, 72], [9, 72]), T(25, "08:00"), T(26, "15:00"), SOURCES.closures2026],
  ...[73, 74, 75, 76].map((st) => [`W ${ord(st)} St, CPW–Columbus`, seg([8, st], [9, st]), T(25, "02:00"), T(26, "15:00"), SOURCES.closures2026]),
  ["34th St, 5th–9th Ave", seg([5, 34], [9, 34]), T(25, "21:00"), T(26, "15:00"), SOURCES.closures2026],
  ["59th St (CPS), 5th Ave–Columbus Circle", seg([5, 59], [8, 59]), T(26, "01:00"), T(26, "17:00"), SOURCES.closures2026],
  ["6th Ave 23rd–42nd St", seg([6, 23], [6, 42]), T(26, "02:00"), T(26, "15:00"), SOURCES.closures2026],
  ["6th Ave 42nd–58th St", seg([6, 42], [6, 58]), T(26, "05:00"), T(26, "15:00"), SOURCES.closures2026],
  ["7th Ave 32nd–42nd St", seg([7, 32], [7, 42]), T(26, "02:00"), T(26, "20:00"), SOURCES.closures2026],
  ["8th Ave 33rd–35th St", seg([8, 33], [8, 35]), T(26, "05:00"), T(26, "15:00"), SOURCES.closures2026],
  ["42nd St, 5th–8th Ave", seg([5, 42], [8, 42]), T(26, "05:00"), T(26, "15:00"), SOURCES.closures2026],
  ["57th St, 5th–8th Ave", seg([5, 57], [8, 57]), T(26, "05:00"), T(26, "15:00"), SOURCES.closures2026],
  ["Broadway 32nd–42nd St", seg(["B", 32], ["B", 42]), T(26, "02:00"), T(26, "17:00"), SOURCES.closures2026],
  // Listed by NYPD for 2026 without times: window assumed = parade morning
  ["Columbus Ave 72nd–86th St (times assumed)", seg([9, 72], [9, 86]), T(26, "00:00"), T(26, "15:00"), SOURCES.fox2026],
  ["Broadway, Columbus Circle–65th St (times assumed)", [CC, at(9, 65)], T(26, "05:00"), T(26, "15:00"), SOURCES.fox2026],
  ["8th Ave, Columbus Circle–58th St (times assumed)", seg([8, 58], [8, 59]), T(26, "05:00"), T(26, "15:00"), SOURCES.fox2026],
].map(([name, points, start, end, source], i) => ({ id: `c${i}`, name, points, start, end, source }));

export const activeClosures = (t) => CLOSURES.filter((c) => t >= c.start && t < c.end);

// ---------------------------------------------------------------------------
// Subway station rules from the MTA's 2026 Thanksgiving notice.
// effect: "closed" (can't board or exit), "no_board" (exit only), "warn"
// ---------------------------------------------------------------------------
export const STATION_RULES = [
  { stop: /81 St.*Museum/i, lines: null, start: T(26, "04:00"), end: T(26, "11:00"), effect: "closed",
    msg: "81 St-Museum of Natural History is closed 4–11 a.m. on parade day" },
  { stop: /81 St.*Museum/i, lines: null, start: T(25, "11:00"), end: T(25, "20:00"), effect: "closed",
    msg: "81 St-Museum of Natural History is closed 11 a.m.–8 p.m. for balloon inflation" },
  { stop: /^57 St$/i, lines: ["F", "M"], start: T(26, "04:00"), end: T(26, "11:00"), effect: "closed",
    msg: "57 St (F) is closed 4–11 a.m.; use 47-50 Sts-Rockefeller Ctr or 63 St-Lexington Av" },
  { stop: /^72 St$/i, lines: ["A", "B", "C"], start: T(26, "00:00"), end: T(26, "11:00"), effect: "no_board",
    msg: "72 St (B/C): main entrance closed until 11 a.m.; 70 St entrance is exit-only" },
  { stop: /59 St.*Columbus/i, lines: null, start: T(26, "04:00"), end: T(26, "13:00"), effect: "warn",
    msg: "59 St-Columbus Circle: exits to the north side of the circle and CPW are closed; use the 58 St / 57 St exits" },
  { stop: /(47-50 Sts|42 St-Bryant|34 St-Herald|23 St)/i, lines: ["B", "D", "F", "M"], start: T(26, "04:00"), end: T(26, "13:00"), effect: "warn",
    msg: "Sixth Ave line: select entrances and exits closed along the parade route" },
  { stop: /34 St.*Penn/i, lines: null, start: T(26, "04:00"), end: T(26, "13:00"), effect: "warn",
    msg: "34 St-Penn Station: select entrances and exits closed" },
].map((r) => ({ ...r, source: SOURCES.mta2026 }));

// Open stations near the route that make good "hop" points when the
// default transit route uses a closed one.
export const HOPS = [
  { name: "79 St (1)", address: "Broadway & W 79th St, New York, NY", point: ll(40.7839, -73.9799) },
  { name: "86 St (1)", address: "Broadway & W 86th St, New York, NY", point: ll(40.7889, -73.9768) },
  { name: "72 St (1/2/3)", address: "Broadway & W 72nd St, New York, NY", point: ll(40.7784, -73.9819) },
  { name: "66 St-Lincoln Center (1)", address: "Broadway & W 66th St, New York, NY", point: ll(40.7734, -73.9822) },
  { name: "50 St (1)", address: "Broadway & W 50th St, New York, NY", point: ll(40.7617, -73.9838) },
  { name: "Times Sq-42 St", address: "Times Sq-42 St station, New York, NY", point: ll(40.7553, -73.987) },
  { name: "63 St-Lexington Av (F/Q)", address: "Lexington Ave & E 63rd St, New York, NY", point: ll(40.7647, -73.9663) },
  { name: "Lexington Av/59 St", address: "Lexington Ave & E 59th St, New York, NY", point: ll(40.7626, -73.9676) },
  { name: "Grand Central-42 St", address: "Grand Central Terminal, New York, NY", point: ll(40.7527, -73.9772) },
];

/** Snapshot for the map: where the parade is and what's open, at time t. */
export function stateAt(t) {
  const h = headS(t), tl = tailS(t);
  const segments = [];
  if (tl > 0) segments.push({ status: "cleared", path: slice(PATH, 0, tl) });
  if (h > tl) segments.push({ status: "active", path: slice(PATH, tl, h) });
  if (h < LENGTH) segments.push({ status: t >= model.pedWallStart ? "waiting" : "upcoming", path: slice(PATH, h, LENGTH) });
  const formationActive = t >= model.formationWallStart && t < tailStart() + model.delay + model.clearBuffer;
  return {
    time: t,
    head: h > 0 && h < LENGTH ? pointAlong(PATH, h) : null,
    tail: tl > 0 && tl < LENGTH ? pointAlong(PATH, tl) : null,
    headLabel: h <= 0 ? "not stepped off (8:30 a.m.)" : h < LENGTH ? describeS(h) : tl >= LENGTH ? "parade over" : "at Herald Square",
    tailLabel: tl <= 0 ? (h > 0 ? "still at the start (CPW & 77th)" : "—") : tl < LENGTH ? describeS(tl) : "parade over",
    segments,
    formation: { active: formationActive, path: FORMATION },
    crossings: CROSSINGS.map((c) => ({ ...c, status: pedCrossingStatus(c.s, t).status })),
    closures: activeClosures(t),
    stationRules: STATION_RULES.filter((r) => t >= r.start && t < r.end).map(({ stop, ...r }) => ({ ...r, stop: String(stop) })),
    model: modelInfo(),
    sources: Object.values(SOURCES),
  };
}

/**
 * Can a pedestrian cross the route at distance s, at time t?
 * Returns { status: "open" | "wait" | "blocked", until, wait }
 */
export function pedCrossingStatus(s, t, { designated = true } = {}) {
  const clearAt = tTail(s) + model.clearBuffer;
  const passing = t >= tHead(s) - 10 * MIN && t < clearAt;
  if (t < model.pedWallStart || t >= clearAt) return { status: "open" };
  const near = designated && CROSSINGS.find((c) => Math.abs(c.s - s) < 60);
  if (near) return passing ? { status: "wait", wait: near.waitMin * MIN, crossing: near } : { status: "open", crossing: near };
  return { status: "blocked", until: clearAt };
}

export const formationClearAt = () => tailStart() + model.delay + model.clearBuffer;
export const formationBlocked = (t) => t >= model.formationWallStart && t < formationClearAt();
