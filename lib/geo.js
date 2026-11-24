// Small geometry toolkit: Google polyline codec + planar math in a local
// equirectangular projection (accurate to well under 1 m across Manhattan).

const R = 6371008.8;
const LAT0 = (40.76 * Math.PI) / 180;
const KX = (Math.PI / 180) * R * Math.cos(LAT0);
const KY = (Math.PI / 180) * R;

export const ll = (lat, lng) => ({ lat, lng });

export function decode(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

export function encode(points) {
  let out = "", pLat = 0, pLng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5), lng = Math.round(p.lng * 1e5);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat; pLng = lng;
  }
  return out;
}

export const xy = (p) => [p.lng * KX, p.lat * KY];
export const fromXY = ([x, y]) => ({ lat: y / KY, lng: x / KX });

export function dist(a, b) {
  const [ax, ay] = xy(a), [bx, by] = xy(b);
  return Math.hypot(ax - bx, ay - by);
}

export function pathLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** Point at distance s along a path. */
export function pointAlong(pts, s) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (acc + d >= s) {
      const t = d ? (s - acc) / d : 0;
      return lerp(pts[i - 1], pts[i], t);
    }
    acc += d;
  }
  return pts[pts.length - 1];
}

/** Sub-path between distances s0..s1. */
export function slice(pts, s0, s1) {
  if (s1 <= s0) return [];
  const out = [pointAlong(pts, s0)];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    if (acc > s0 && acc < s1) out.push(pts[i]);
  }
  out.push(pointAlong(pts, s1));
  return out;
}

export const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

/** Proper segment intersection. Returns {t,u} params on ab and cd, or null. */
export function intersect(a, b, c, d) {
  const [ax, ay] = xy(a), [bx, by] = xy(b), [cx, cy] = xy(c), [dx, dy] = xy(d);
  const rX = bx - ax, rY = by - ay, sX = dx - cx, sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sY - (cy - ay) * sX) / den;
  const u = ((cx - ax) * rY - (cy - ay) * rX) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

/** Distance from p to segment ab, plus projection parameter t. */
export function toSegment(p, a, b) {
  const [px, py] = xy(p), [ax, ay] = xy(a), [bx, by] = xy(b);
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2)) : 0;
  return { d: Math.hypot(px - (ax + t * vx), py - (ay + t * vy)), t };
}

/** Project p onto a path: {d, s} where s is distance along the path. */
export function project(p, pts) {
  let best = { d: Infinity, s: 0 }, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = dist(pts[i - 1], pts[i]);
    const { d, t } = toSegment(p, pts[i - 1], pts[i]);
    if (d < best.d) best = { d, s: acc + t * L };
    acc += L;
  }
  return best;
}

/** Unit direction (in projected space) of segment ab. */
export function bearingVec(a, b) {
  const [ax, ay] = xy(a), [bx, by] = xy(b);
  const L = Math.hypot(bx - ax, by - ay) || 1;
  return [(bx - ax) / L, (by - ay) / L];
}
