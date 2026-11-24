// Community blocker reports: "I'm standing at a barricade" / "this entrance is
// closed", with a screenshot or photo. One report = warning; two independent
// reports (or confirmations) = blocker. Reports expire unless re-confirmed.
//
// Privacy: images are never stored — only what was read from them. Reporter
// identity is a random per-browser id, used only to stop double-voting.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const MIN = 60e3;
const TTL = { barricade: 45, closure: 60, crowd: 30, station: 60, bus: 45, other: 30 }; // minutes
export const KINDS = {
  barricade: { label: "Barricade / can't cross", affects: ["foot"] },
  closure: { label: "Street closed to cars", affects: ["vehicle", "bus"] },
  crowd: { label: "Crowd — very slow on foot", affects: ["foot"] },
  station: { label: "Subway entrance or station closed", affects: ["rail"] },
  bus: { label: "Bus detoured / not stopping", affects: ["bus"] },
  other: { label: "Something else", affects: [] },
};
export const SOURCE = { name: "New Yorkers' reports (photos/screenshots)", url: "#reports", confidence: "crowd" };

const FILE = process.env.REPORTS_FILE; // optional persistence
let reports = load();
const listeners = new Set();

function load() {
  try { return FILE ? JSON.parse(readFileSync(FILE, "utf8")) : []; } catch { return []; }
}
function save() {
  if (!FILE) return;
  try { writeFileSync(FILE, JSON.stringify(reports.slice(-500))); } catch {}
}

export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (type, report) => listeners.forEach((fn) => fn({ type, report: publicView(report) }));

export function add({ lat, lng, kind, note, extracted, reporter, time }) {
  if (!KINDS[kind]) kind = "other";
  // Same kind within 60 m and still live → counts as a confirmation, not a new pin
  const near = active(time).find((r) => r.kind === kind && dist(r, { lat, lng }) < 60);
  if (near) return confirm(near.id, { reporter, still: true, time });
  const r = {
    id: randomUUID(), lat, lng, kind,
    note: String(note ?? "").slice(0, 280),
    extracted: extracted ?? null, // what the AI read from the screenshot
    createdAt: time, expiresAt: time + TTL[kind] * MIN,
    confirms: [reporter], gone: [],
  };
  reports.push(r); save(); emit("report", r);
  return publicView(r);
}

export function confirm(id, { reporter, still, time }) {
  const r = reports.find((x) => x.id === id);
  if (!r) return null;
  r.confirms = r.confirms.filter((x) => x !== reporter);
  r.gone = r.gone.filter((x) => x !== reporter);
  (still ? r.confirms : r.gone).push(reporter);
  if (still) r.expiresAt = Math.max(r.expiresAt, time + TTL[r.kind] * MIN);
  if (r.gone.length >= 2 && r.gone.length > r.confirms.length) r.expiresAt = time; // cleared by the crowd
  save(); emit("update", r);
  return publicView(r);
}

export const active = (t) => reports.filter((r) => t >= r.createdAt && t < r.expiresAt);
export const status = (r) => (r.confirms.length >= 2 ? "confirmed" : "unconfirmed");
export const publicView = ({ confirms, gone, ...r }) => ({ ...r, confirmCount: confirms.length, goneCount: gone.length, status: confirms.length >= 2 ? "confirmed" : "unconfirmed", label: KINDS[r.kind].label });

const dist = (a, b) => {
  const k = 111320, x = (a.lng - b.lng) * k * Math.cos((a.lat * Math.PI) / 180), y = (a.lat - b.lat) * k;
  return Math.hypot(x, y);
};

/** For the blocker engine: active reports relevant at time t. */
export const forEngine = { active, status, KINDS, SOURCE, dist };

export function _reset() { reports = []; }
