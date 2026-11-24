// NYC Parade Nav — frontend. Google Maps JS for all display.
const $ = (id) => document.getElementById(id);
const NY = "America/New_York";
const DAY0 = Date.parse("2026-11-26T05:00:00-05:00"); // slider origin
const fmt = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: NY }).toLowerCase();
const fmtDay = (t) => new Date(t).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: NY });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nyInput = (v) => (v ? `${v}:00-05:00` : null); // datetime-local is read as NYC time
const toInput = (t) => new Date(t - 5 * 3600e3).toISOString().slice(0, 16);

let map, geometry, AdvancedMarkerElement, info;
let layers = { parade: [], option: [], google: [], reports: [], pick: [] };
let cfg = {};
let plan = null, selected = null, watch = null, geoWatch = null;

const SCENARIOS = [
  { label: "Dev · 9:00 · transit", origin: "W 80th St & Amsterdam Ave, New York, NY", destination: "E 36th St & Lexington Ave, New York, NY", mode: "TRANSIT", at: "09:00" },
  { label: "Dev · 10:30 · walk, by noon", origin: "W 80th St & Amsterdam Ave, New York, NY", destination: "E 36th St & Lexington Ave, New York, NY", mode: "WALK", at: "10:30", arriveBy: "12:00" },
  { label: "Dev · 12:15 · transit", origin: "W 80th St & Amsterdam Ave, New York, NY", destination: "E 36th St & Lexington Ave, New York, NY", mode: "TRANSIT", at: "12:15" },
  { label: "Wheelchair · Chelsea → UES", origin: "W 23rd St & 8th Ave, New York, NY", destination: "E 79th St & Lexington Ave, New York, NY", mode: "TRANSIT", at: "10:00", wheelchair: true },
  { label: "Driver · W 70s → Penn", origin: "W 75th St & West End Ave, New York, NY", destination: "Penn Station, New York, NY", mode: "DRIVE", at: "09:30" },
];

boot().catch((e) => setStatus(`Map failed to load: ${e.message}`));

async function boot() {
  cfg = await api("/api/config");
  const { browserKey, mapId } = cfg;
  loadMaps(browserKey);
  const { Map, InfoWindow } = await google.maps.importLibrary("maps");
  ({ AdvancedMarkerElement } = await google.maps.importLibrary("marker"));
  geometry = await google.maps.importLibrary("geometry");
  map = new Map($("map"), { center: { lat: 40.766, lng: -73.979 }, zoom: 14, mapId, clickableIcons: false, streetViewControl: false, mapTypeControl: false });
  info = new InfoWindow();
  new google.maps.TransitLayer().setMap(map);

  SCENARIOS.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = s.label;
    b.onclick = () => runScenario(s);
    $("scenarios").append(b);
  });
  $("trip").addEventListener("submit", (e) => { e.preventDefault(); doPlan(); });
  $("clockSlider").addEventListener("input", () => setClock({ mode: "sim", time: new Date(DAY0 + $("clockSlider").value * 60e3).toISOString() }));
  $("speed").addEventListener("change", () => setClock({ speed: Number($("speed").value) }));
  $("liveBtn").addEventListener("click", () => setClock({ mode: $("liveBtn").classList.contains("on") ? "sim" : "live" }));
  $("stopWatch").addEventListener("click", stopWatch);

  setupReports();
  if (cfg.clockLocked) for (const id of ["clockSlider", "speed", "liveBtn"]) $(id).hidden = true;
  await refreshParade();
  setInterval(refreshParade, 5000);
  refreshSources();
  setInterval(refreshSources, 60000);
}

function loadMaps(key) {
  ((g) => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({ key, v: "weekly" });
}

async function api(url, opts) {
  const r = await fetch(url, opts && { method: opts.method ?? "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status}`);
  return data;
}

// ---------------- clock + parade layer ----------------
async function setClock(body) {
  await api("/api/clock", { body });
  await refreshParade();
}

async function refreshParade() {
  const [clock, st] = await Promise.all([api("/api/clock"), api("/api/parade")]);
  $("clockTime").textContent = fmtDay(clock.now) + (clock.mode === "sim" ? " (simulated)" : "");
  $("liveBtn").classList.toggle("on", clock.mode === "live");
  if (document.activeElement !== $("clockSlider")) $("clockSlider").value = Math.round((clock.now - DAY0) / 60e3);
  const delay = st.model.lastReport ? ` · running ${st.model.lastReport.delayMin >= 0 ? "+" : ""}${st.model.lastReport.delayMin} min vs plan` : "";
  $("paradeStatus").innerHTML = `Head: <b>${esc(st.headLabel)}</b> · Tail: <b>${esc(st.tailLabel)}</b>${delay}<br/>
    ${st.closures.length} street closures active · ${st.stationRules.length} station restrictions`;
  drawParade(st);
}

function clear(name) { layers[name].forEach((o) => (o.setMap ? o.setMap(null) : (o.map = null))); layers[name] = []; }

function drawParade(st) {
  clear("parade");
  const COLORS = { cleared: "#9aa0a6", active: "#d93025", waiting: "#f29900", upcoming: "#fbbc04" };
  for (const seg of st.segments) {
    layers.parade.push(new google.maps.Polyline({ map, path: seg.path, strokeColor: COLORS[seg.status], strokeWeight: seg.status === "active" ? 9 : 6, strokeOpacity: 0.9, zIndex: 5 }));
  }
  if (st.formation.active) layers.parade.push(new google.maps.Polyline({ map, path: st.formation.path, strokeColor: "#d93025", strokeOpacity: 0,
    icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: "#d93025", scale: 4 }, repeat: "14px" }] }));
  for (const c of st.closures) {
    const pl = new google.maps.Polyline({ map, path: c.points, strokeColor: "#7b1fa2", strokeWeight: 3, strokeOpacity: 0.7, zIndex: 4 });
    pl.addListener("click", (e) => { info.setContent(`<b>${esc(c.name)}</b><br/>${fmtDay(c.start)} → ${fmtDay(c.end)}<br/><a href="${c.source.url}" target="_blank">${esc(c.source.name)}</a> <span class="conf">${c.source.confidence}</span>`); info.setPosition(e.latLng); info.open(map); });
    layers.parade.push(pl);
  }
  const CX = { open: "#0b6b2c", wait: "#f29900", blocked: "#d93025" };
  for (const x of st.crossings) layers.parade.push(pin(x.point, `⇄ ${x.name.replace("6th Ave & ", "")}`, CX[x.status], `${x.name}: ${x.status === "wait" ? "NYPD crossing, expect a wait" : x.status}`));
  if (st.head) layers.parade.push(pin(st.head, "🎈 Head", "#d93025"));
  if (st.tail) layers.parade.push(pin(st.tail, "🎅 Tail", "#d93025"));
}

function pin(position, text, color, title) {
  const el = document.createElement("div");
  el.className = "pin"; el.style.background = color; el.textContent = text;
  return new AdvancedMarkerElement({ map, position, content: el, title: title ?? text, zIndex: 20 });
}

// ---------------- planning ----------------
async function runScenario(s) {
  $("origin").value = s.origin; $("destination").value = s.destination; $("mode").value = s.mode;
  $("wheelchair").checked = !!s.wheelchair;
  $("departAt").value = `2026-11-26T${s.at}`;
  $("arriveBy").value = s.arriveBy ? `2026-11-26T${s.arriveBy}` : "";
  await setClock({ mode: "sim", time: `2026-11-26T${s.at}:00-05:00` });
  doPlan();
}

async function doPlan() {
  setStatus(""); $("go").disabled = true; $("options").innerHTML = "";
  $("summary").className = ""; clear("option"); clear("google");
  try {
    plan = await api("/api/plan", { body: {
      origin: $("origin").value, destination: $("destination").value, mode: $("mode").value,
      departAt: $("arriveBy").value && !$("departAt").value ? null : nyInput($("departAt").value),
      arriveBy: nyInput($("arriveBy").value), wheelchair: $("wheelchair").checked,
      transitPreference: $("transitPreference").value,
    } });
    renderPlan();
  } catch (e) { setStatus(e.message); }
  finally { $("go").disabled = false; }
}

function renderPlan() {
  const best = plan.options.find((o) => o.id === plan.recommended);
  $("summary").className = "show";
  $("summary").innerHTML = `${best && plan.leaveBy ? `<div class="leave">Leave by ${fmt(plan.leaveBy)}${plan.late ? " — you'll still be late" : ""}</div>` : ""}
    <div>${esc(plan.summary)}</div><div class="muted">${plan.googleCalls} Google Routes calls</div>`;
  $("options").innerHTML = plan.options.map((o) => {
    const a = o.analysis;
    const tag = o.id === plan.recommended ? `<span class="tag rec">Recommended</span>` : a.clear ? `<span class="tag ok">Clear</span>` : `<span class="tag bad">Blocked</span>`;
    return `<div class="opt" data-id="${o.id}">
      <div class="head"><span>${esc(o.label)}</span>${tag}</div>
      <div class="meta">${fmt(a.departAt)} → ${fmt(a.arriveAt)} · ${a.durationMin} min · ${(a.walkMeters / 1609).toFixed(1)} mi on foot${a.transfers ? ` · ${a.transfers} transfer${a.transfers > 1 ? "s" : ""}` : ""}</div>
      ${a.lines.length ? `<div class="lines">${a.lines.map((l) => `<span class="bullet">${esc(l)}</span>`).join("")}</div>` : ""}
      ${[...a.blockers.map((i) => issue(i, "blocker")), ...a.warnings.map((i) => issue(i, "warning"))].join("")}
      ${o.id === plan.recommended ? `<button class="watch" data-watch="${o.id}" type="button">Watch this trip &amp; alert me</button>` : ""}
    </div>`;
  }).join("");
  document.querySelectorAll(".opt").forEach((el) => el.addEventListener("click", () => select(el.dataset.id)));
  document.querySelectorAll("[data-watch]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); startWatch(b.dataset.watch); }));
  const g = plan.options.find((o) => o.id === "g0");
  if (g && !g.analysis.clear) drawOption(g, "google");
  select(plan.recommended ?? plan.options[0].id);
}

const issue = (i, cls) => `<div class="issue ${cls}">${esc(i.message)}
  <br/><a href="${esc(i.source?.url)}" target="_blank">${esc(i.source?.name ?? "source")}</a> <span class="conf">${esc(i.source?.confidence ?? "")}</span></div>`;

function select(id) {
  selected = plan.options.find((o) => o.id === id);
  document.querySelectorAll(".opt").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  clear("option");
  drawOption(selected, "option");
}

function drawOption(o, layer) {
  const isGoogleBlocked = layer === "google";
  const bounds = new google.maps.LatLngBounds();
  for (const part of o.parts) {
    for (const s of (part.route.legs ?? []).flatMap((l) => l.steps ?? [])) {
      if (!s.polyline?.encodedPolyline) continue;
      const path = geometry.encoding.decodePath(s.polyline.encodedPolyline);
      path.forEach((p) => bounds.extend(p));
      const transit = s.travelMode === "TRANSIT";
      const color = isGoogleBlocked ? "#d93025" : transit ? s.transitDetails?.transitLine?.color || "#0039a6" : s.travelMode === "DRIVE" ? "#1a73e8" : "#3c4043";
      const dotted = isGoogleBlocked || s.travelMode === "WALK";
      layers[layer].push(new google.maps.Polyline({ map, path, zIndex: isGoogleBlocked ? 6 : 10,
        strokeColor: color, strokeWeight: transit ? 6 : 4, strokeOpacity: dotted ? 0 : 0.95,
        icons: dotted ? [{ icon: { path: google.maps.SymbolPath.CIRCLE, scale: isGoogleBlocked ? 2.5 : 2, fillOpacity: 1, strokeOpacity: 1, strokeColor: color, fillColor: color }, repeat: "9px" }] : [] }));
    }
  }
  if (isGoogleBlocked) for (const b of o.analysis.blockers) if (b.at) layers.google.push(pin(b.at, "⛔ " + fmt(b.time), "#a1121f", b.message));
  if (!isGoogleBlocked && !bounds.isEmpty()) map.fitBounds(bounds, 60);
}

// ---------------- live trip watching ----------------
async function startWatch(optionId) {
  stopWatch();
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  const { watchId } = await api("/api/watch", { body: { planId: plan.id, optionId } });
  watch = { id: watchId, es: new EventSource(`/api/watch/${watchId}/stream`) };
  $("notifyBox").hidden = false; $("events").innerHTML = "";
  addEvent({ message: `Watching "${selected.label}". I'll alert you if the parade, a closure or the MTA changes this trip.` });
  if (confirm("Share your location while this trip is being watched? It's deleted when the trip ends.")) {
    geoWatch = navigator.geolocation?.watchPosition((p) =>
      api(`/api/watch/${watchId}/position`, { body: { lat: p.coords.latitude, lng: p.coords.longitude } }).catch(() => {}));
  }
  watch.es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    addEvent(ev);
    if ("Notification" in window && Notification.permission === "granted" && ev.type !== "ended") new Notification("NYC Parade Nav", { body: ev.message });
    if (ev.type === "reroute" && ev.plan) { plan = { ...ev.plan, id: plan.id }; renderPlan(); }
    if (ev.type === "ended") stopWatch(true);
  };
}

function addEvent(ev) {
  const li = document.createElement("li");
  const src = (ev.sources ?? []).map((s) => `<a href="${esc(s.url)}" target="_blank">${esc(s.name)}</a>`).join(", ");
  li.innerHTML = `${ev.at ? `<b>${fmt(ev.at)}</b> ` : ""}${esc(ev.message)}${ev.reason ? `<br/><span class="muted">Why: ${esc(ev.reason)}</span>` : ""}${src ? `<br/><span class="muted">${src}</span>` : ""}`;
  $("events").prepend(li);
}

function stopWatch(ended) {
  if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch);
  geoWatch = null;
  if (watch) { watch.es.close(); if (!ended) fetch(`/api/watch/${watch.id}`, { method: "DELETE" }); }
  watch = null;
  if (!ended) $("notifyBox").hidden = true;
}

// ---------------- sources ----------------
async function refreshSources() {
  const [a, st] = await Promise.all([api("/api/alerts"), api("/api/parade")]);
  const feed = Object.values(a.status).map((s) =>
    `<li><span class="dot" style="background:${s.ok ? "#0b6b2c" : s.ok === false ? "#d93025" : "#aaa"}"></span><a href="${s.source.url}" target="_blank">${esc(s.source.name)}</a> — ${s.ok ? `${s.count} items, ${fmt(s.at)}` : esc(s.error ?? "loading")}</li>`);
  const kb = st.sources.map((s) => `<li><a href="${s.url}" target="_blank">${esc(s.name)}</a> <span class="conf">${s.confidence}</span></li>`);
  $("sources").innerHTML = feed.join("") + kb.join("");
}

function setStatus(m) { $("status").textContent = m; }

// ---------------- community reports ----------------
let pick = null, extracted = null, reportsCache = [];
const reporter = (() => { try { let id = localStorage.getItem("rid"); if (!id) { id = crypto.randomUUID(); localStorage.setItem("rid", id); } return id; } catch { return crypto.randomUUID(); } })();

function setupReports() {
  $("kind").innerHTML = Object.entries(cfg.kinds ?? {}).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
  $("reportBtn").onclick = openReport;
  $("reportCancel").onclick = closeReport;
  $("useHere").onclick = () => navigator.geolocation?.getCurrentPosition(
    (p) => setPick({ lat: p.coords.latitude, lng: p.coords.longitude }), () => toast("Couldn't get your location — tap the map instead."));
  map.addListener("click", (e) => { if (document.body.classList.contains("picking")) setPick(e.latLng.toJSON()); });
  $("shot").onchange = onShot;
  $("postReport").onclick = postReport;
  api("/api/reports").then((list) => { reportsCache = list; renderReports(); });
  const es = new EventSource("/api/live");
  es.onopen = () => ($("liveDot").textContent = "● live");
  es.onerror = () => ($("liveDot").textContent = "reconnecting…");
  es.onmessage = (m) => onLive(JSON.parse(m.data));
  setInterval(() => api("/api/reports").then((list) => { reportsCache = list; renderReports(); }).catch(() => {}), 30000);
}

function openReport() {
  $("reportBox").hidden = false; document.body.classList.add("picking");
  pick = null; extracted = null; $("pinInfo").textContent = ""; $("readOut").textContent = "";
  $("shot").value = ""; $("shotPreview").hidden = true; $("note").value = "";
  $("reportBox").scrollIntoView({ behavior: "smooth", block: "start" });
}
function closeReport() { $("reportBox").hidden = true; document.body.classList.remove("picking"); clear("pick"); }
function setPick(p) {
  pick = p; clear("pick");
  layers.pick.push(pin(p, "📍 here", "#d93025"));
  $("pinInfo").textContent = `Pinned at ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

async function onShot() {
  const f = $("shot").files[0];
  if (!f) return;
  const dataUrl = await downscale(f, 1568);
  $("shotPreview").src = dataUrl; $("shotPreview").hidden = false;
  if (!cfg.vision) { $("readOut").textContent = "Pick what it is below (automatic reading isn't turned on for this site)."; return; }
  $("readOut").textContent = "Reading your screenshot…";
  try {
    extracted = await api("/api/reports/read", { body: { image: dataUrl, mediaType: "image/jpeg", note: $("note").value } });
    if (extracted.kind === "not_a_blocker") { $("readOut").textContent = "This doesn't look like a travel blocker. You can still post it with a note."; return; }
    if (cfg.kinds[extracted.kind]) $("kind").value = extracted.kind;
    $("readOut").innerHTML = `<b>Read from image:</b> ${esc(extracted.summary)}${extracted.where ? `<br/>Where: ${esc(extracted.where)}` : ""}${extracted.until ? `<br/>Until: ${esc(extracted.until)}` : ""}${extracted.sourceSeen ? `<br/>Posted by: ${esc(extracted.sourceSeen)}` : ""}<br/><span class="conf">check it's right before posting</span>`;
  } catch (e) { $("readOut").textContent = `Couldn't read it (${e.message}). Pick the type below.`; extracted = null; }
}

function downscale(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function postReport() {
  if (!pick) return toast("Tap the map where the blocker is first.");
  try {
    await api("/api/reports", { body: { ...pick, kind: $("kind").value, note: $("note").value,
      extracted: extracted && extracted.kind !== "not_a_blocker" ? extracted : null, reporter } });
    toast("Posted. People routing past it are being re-checked now.");
    closeReport();
  } catch (e) { toast(e.message, true); }
}

async function vote(id, still) {
  try { await api(`/api/reports/${id}/vote`, { body: { still, reporter } }); toast(still ? "Thanks — confirmed." : "Thanks — marked as gone."); }
  catch (e) { toast(e.message, true); }
}

function onLive(ev) {
  const r = ev.report;
  reportsCache = reportsCache.filter((x) => x.id !== r.id).concat([r]);
  renderReports();
  if (ev.type !== "report") return;
  if (selected && nearOption(r, selected)) {
    toast(`New report on your route: ${r.label}. Re-planning…`, true);
    doPlan();
  } else toast(`New report: ${r.label}${r.extracted?.summary ? " — " + r.extracted.summary : ""}`);
}

function nearOption(r, o) {
  const p = new google.maps.LatLng(r.lat, r.lng);
  return o.parts.some((part) => (part.route.legs ?? []).flatMap((l) => l.steps ?? []).some((s) => s.polyline?.encodedPolyline &&
    geometry.poly.isLocationOnEdge(p, new google.maps.Polyline({ path: geometry.encoding.decodePath(s.polyline.encodedPolyline) }), 0.0006)));
}

function renderReports() {
  const list = [...reportsCache].sort((a, b) => b.createdAt - a.createdAt);
  clear("reports");
  for (const r of list) layers.reports.push(pin({ lat: r.lat, lng: r.lng }, `📸 ${r.label.split(" ")[0]}${r.status === "confirmed" ? " ✓" : ""}`, r.status === "confirmed" ? "#a1121f" : "#e37400", r.extracted?.summary ?? r.note ?? r.label));
  $("reportList").innerHTML = list.length ? list.map((r) => `<li data-id="${esc(r.id)}">
      <span class="kind">${esc(r.label)}</span> <span class="tag ${r.status === "confirmed" ? "bad" : "crowd"}">${r.status === "confirmed" ? "Confirmed" : "1 report"}</span>
      <div>${esc(r.extracted?.summary || r.note || "")}</div>
      <div class="muted">${fmt(r.createdAt)} · ${r.confirmCount} still there · ${r.goneCount} gone · expires ${fmt(r.expiresAt)}${r.extracted?.sourceSeen ? ` · from a ${esc(r.extracted.sourceSeen)} post` : ""}</div>
      <div class="acts"><button type="button" data-v="1">Still there</button><button type="button" data-v="0">Gone</button><button type="button" data-z="1">Show</button></div>
    </li>`).join("") : `<li class="muted">No reports yet. See a barricade or a closed entrance? Report it.</li>`;
  $("reportList").querySelectorAll("li[data-id]").forEach((li) => {
    li.querySelector("[data-v='1']").onclick = () => vote(li.dataset.id, true);
    li.querySelector("[data-v='0']").onclick = () => vote(li.dataset.id, false);
    li.querySelector("[data-z]").onclick = () => { const r = reportsCache.find((x) => x.id === li.dataset.id); map.panTo(r); map.setZoom(17); };
  });
}

let toastTimer;
function toast(msg, alert = false) {
  const t = $("toast");
  t.textContent = msg; t.className = alert ? "alert" : ""; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
