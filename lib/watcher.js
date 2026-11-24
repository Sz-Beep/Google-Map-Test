// Live trip watching: re-checks the chosen route against the current parade
// position and live feeds, and pushes "leave now" / "reroute" events.
//
// Privacy guardrails from the outline: location is opt-in, only held while
// the trip is being watched, and deleted when the trip ends.

import { randomUUID } from "node:crypto";
import { analyzeRoute, fmt } from "./blockers.js";
import { plan } from "./planner.js";

const watches = new Map();
const MIN = 60e3;

export function createWatcher({ google, feeds, clock, reports = null }) {
  async function tick() {
    for (const w of watches.values()) {
      try { await check(w); } catch (e) { send(w, { type: "error", message: e.message }); }
    }
  }
  setInterval(tick, 15e3).unref();

  async function check(w) {
    const t = clock.now();
    if (t > w.endAt) return end(w.id, "Trip window over — location deleted.");

    // "Leave soon" nudge
    if (!w.nudged && w.option.analysis.departAt - t <= 10 * MIN && w.option.analysis.departAt > t - 5 * MIN) {
      w.nudged = true;
      send(w, { type: "leave_soon", message: `Leave by ${fmt(w.option.analysis.departAt)} for ${w.option.label}.`, at: t });
    }

    // Re-run blocker checks on the remaining trip
    let cursor = w.option.analysis.departAt;
    const fresh = [];
    for (const p of w.option.parts) {
      const a = analyzeRoute(p.route, { departAt: cursor, wheelchair: w.req.wheelchair, feeds, reports });
      cursor = a.arriveAt;
      fresh.push(...a.blockers.filter((b) => b.time >= t - MIN));
    }
    const sig = fresh.map((b) => b.message).join("|");
    if (!fresh.length || sig === w.lastSig) return;
    w.lastSig = sig;

    // New blocker → re-plan from where the traveler is now
    const origin = w.position ?? w.req.origin;
    const next = await plan({ ...w.req, origin, departAt: Math.max(t, w.option.analysis.departAt), arriveBy: undefined },
      { google, feeds, reports, now: t, budget: 6 });
    const best = next.options.find((o) => o.id === next.recommended);
    send(w, {
      type: "reroute",
      reason: fresh[0].message,
      sources: [...new Map(fresh.map((b) => [b.source.url, b.source])).values()],
      message: best ? `Change of plan: ${best.label}, arriving ${fmt(best.analysis.arriveAt)}.` : "No clean route right now — hold position or walk; checking again.",
      plan: next,
      at: t,
    });
    if (best) { w.option = best; w.lastSig = ""; }
  }

  function send(w, ev) {
    w.events.push(ev);
    for (const res of w.clients) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  function end(id, message) {
    const w = watches.get(id);
    if (!w) return false;
    send(w, { type: "ended", message });
    for (const res of w.clients) res.end();
    w.position = null; // delete location
    watches.delete(id);
    return true;
  }

  return {
    start(req, option) {
      const id = randomUUID();
      watches.set(id, { id, req, option, position: null, clients: new Set(), events: [], lastSig: "",
        nudged: false, endAt: option.analysis.arriveAt + 30 * MIN });
      setTimeout(() => { const w = watches.get(id); if (w) check(w).catch(() => {}); }, 500);
      return id;
    },
    stream(id, res) {
      const w = watches.get(id);
      if (!w) return false;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      for (const ev of w.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      w.clients.add(res);
      res.on("close", () => w.clients.delete(res));
      return true;
    },
    position(id, p) {
      const w = watches.get(id);
      if (!w) return false;
      w.position = { lat: p.lat, lng: p.lng };
      return true;
    },
    end,
    tick,
  };
}
