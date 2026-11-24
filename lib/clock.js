// One clock for the whole agent. "sim" lets you replay parade morning before
// it happens (the outline's parade-clock test); "live" is wall time.
import { T } from "./parade.js";

const c = { mode: "sim", simBase: T(26, "08:00"), realBase: Date.now(), speed: 1 };

export const now = () => (c.mode === "live" ? Date.now() : c.simBase + (Date.now() - c.realBase) * c.speed);

export function set({ mode, time, speed }) {
  const current = now();
  if (mode) c.mode = mode;
  c.simBase = time ? Date.parse(time) : current;
  c.realBase = Date.now();
  if (speed !== undefined) c.speed = Math.max(0, Math.min(600, Number(speed) || 0));
  return get();
}

export const get = () => ({ mode: c.mode, now: now(), speed: c.speed });
