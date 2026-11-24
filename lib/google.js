// Thin Routes API client. All remapping goes through this one function, so
// the planner can be tested with a fake.

const URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.transitDetails",
  "routes.warnings",
].join(",");

export function createGoogle(apiKey) {
  let calls = 0;
  async function computeRoutes({ origin, destination, mode, departAt, arriveBy, vias = [], transit = {}, alternatives = true }) {
    const body = {
      origin: waypoint(origin),
      destination: waypoint(destination),
      travelMode: mode,
      computeAlternativeRoutes: alternatives && vias.length === 0,
      languageCode: "en-US",
      units: "IMPERIAL",
      regionCode: "US",
    };
    // Transit doesn't support intermediates; the planner stitches legs instead.
    if (vias.length && mode !== "TRANSIT") body.intermediates = vias.map((v) => ({ ...waypoint(v), via: true }));
    const future = departAt && departAt > Date.now() + 60e3;
    if (mode === "TRANSIT") {
      if (arriveBy) body.arrivalTime = new Date(arriveBy).toISOString();
      else if (departAt) body.departureTime = new Date(departAt).toISOString();
      if (transit.routingPreference) body.transitPreferences = { routingPreference: transit.routingPreference };
      if (transit.allowedTravelModes?.length) body.transitPreferences = { ...body.transitPreferences, allowedTravelModes: transit.allowedTravelModes };
    } else if (mode === "DRIVE") {
      body.routingPreference = "TRAFFIC_AWARE";
      if (future) body.departureTime = new Date(departAt).toISOString();
    }
    calls++;
    const r = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message ?? `Routes API ${r.status}`);
    return data.routes ?? [];
  }
  return { computeRoutes, get calls() { return calls; } };
}

function waypoint(v) {
  if (typeof v === "string") return { address: v };
  if (v && Number.isFinite(v.lat)) return { location: { latLng: { latitude: v.lat, longitude: v.lng } } };
  throw new Error("Waypoint must be an address or {lat, lng}");
}
