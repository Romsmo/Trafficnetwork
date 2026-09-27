"use strict";
const $ = (id) => document.getElementById(id);
const TYPES = ["traffic", "ice", "accident", "construction", "breakdown", "obstacle"];
const TYPE_DE = { traffic: "Stau", ice: "Glätte", accident: "Unfall", construction: "Baustelle", breakdown: "Panne", obstacle: "Hindernis" };
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-test-client": "1" }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => null) }));

let state = null, pos = null, limit = null, route = [], routeMode = false, driving = null;
const view = { lat: 48.1374, lng: 11.5755, z: 15 };
const canvas = $("map"), ctx = canvas.getContext("2d");
const tiles = new Map();

// ---- projection ----
const worldPx = (z) => 256 * 2 ** z;
const toPx = (lat, lng) => { const s = worldPx(view.z), x = ((lng + 180) / 360) * s, sin = Math.sin((lat * Math.PI) / 180); return [x, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s]; };
const fromPx = (x, y) => { const s = worldPx(view.z), n = Math.PI - (2 * Math.PI * y) / s; return [(180 / Math.PI) * Math.atan(Math.sinh(n)), (x / s) * 360 - 180]; };
const toScreen = (lat, lng) => { const [x, y] = toPx(lat, lng), [cx, cy] = toPx(view.lat, view.lng); return [x - cx + canvas.width / 2, y - cy + canvas.height / 2]; };
const fromScreen = (sx, sy) => { const [cx, cy] = toPx(view.lat, view.lng); return fromPx(sx - canvas.width / 2 + cx, sy - canvas.height / 2 + cy); };

const colorFor = (kmh) => (kmh <= 30 ? "#12805c" : kmh <= 50 ? "#b54708" : kmh <= 70 ? "#c11574" : kmh <= 100 ? "#175cd3" : "#5925dc");

function resize() { const r = canvas.getBoundingClientRect(); canvas.width = r.width * devicePixelRatio; canvas.height = r.height * devicePixelRatio; draw(); }

function draw() {
  const w = canvas.width, h = canvas.height, dpr = devicePixelRatio;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if ($("osm").checked) drawTiles();
  const c = state?.cache;
  if (c) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const seg of c.segments) {
      const co = seg.geometry?.coordinates; if (!co) continue;
      ctx.beginPath();
      co.forEach(([lng, lat], i) => { const [x, y] = toScreen(lat, lng); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = colorFor(seg.speedLimit); ctx.lineWidth = (limit?.segmentId === seg.id ? 7 : 3.5) * dpr; ctx.stroke();
    }
    for (const s of c.signs) { const [x, y] = toScreen(s.position.coordinates[1], s.position.coordinates[0]); ctx.fillStyle = "#344054"; ctx.fillRect(x - 3 * dpr, y - 3 * dpr, 6 * dpr, 6 * dpr); }
    for (const hz of c.hazards) {
      const co = hz.position?.coordinates ?? (hz.lng != null ? [hz.lng, hz.lat] : null); if (!co) continue;
      const [x, y] = toScreen(co[1], co[0]); ctx.beginPath(); ctx.arc(x, y, 9 * dpr, 0, 7); ctx.fillStyle = "#d92d20"; ctx.fill(); ctx.fillStyle = "#fff"; ctx.font = `bold ${12 * dpr}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("!", x, y + 1);
    }
    ctx.setLineDash([6 * dpr, 6 * dpr]); ctx.strokeStyle = "#98a2b3"; ctx.lineWidth = dpr;
    const [cx, cy] = toScreen(c.center.lat, c.center.lng), rr = (c.radiusM / (40075016.686 * Math.cos((c.center.lat * Math.PI) / 180) / worldPx(view.z)));
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  }
  if (route.length) {
    ctx.setLineDash([8 * dpr, 6 * dpr]); ctx.strokeStyle = "#101828"; ctx.lineWidth = 2 * dpr; ctx.beginPath();
    route.forEach(([la, ln], i) => { const [x, y] = toScreen(la, ln); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
    route.forEach(([la, ln]) => { const [x, y] = toScreen(la, ln); ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, 7); ctx.fillStyle = "#101828"; ctx.fill(); });
  }
  if (pos) { const [x, y] = toScreen(pos.lat, pos.lng); ctx.beginPath(); ctx.arc(x, y, 8 * dpr, 0, 7); ctx.fillStyle = "#175cd3"; ctx.fill(); ctx.lineWidth = 3 * dpr; ctx.strokeStyle = "#fff"; ctx.stroke(); }
}

function drawTiles() {
  const z = Math.max(0, Math.min(19, Math.round(view.z))), scale = 2 ** (view.z - z);
  const [cx, cy] = toPx(view.lat, view.lng), half = [canvas.width / 2, canvas.height / 2];
  const tsz = 256 * scale, x0 = Math.floor((cx - half[0]) / tsz), x1 = Math.floor((cx + half[0]) / tsz), y0 = Math.floor((cy - half[1]) / tsz), y1 = Math.floor((cy + half[1]) / tsz);
  for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
    if (ty < 0 || ty >= 2 ** z) continue;
    const wrapped = ((tx % 2 ** z) + 2 ** z) % 2 ** z, key = `${z}/${wrapped}/${ty}`;
    let img = tiles.get(key);
    if (!img) { img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => draw(); img.onerror = () => { img.failed = true; }; img.src = `https://tile.openstreetmap.org/${key}.png`; tiles.set(key, img); if (tiles.size > 300) tiles.delete(tiles.keys().next().value); }
    if (img.complete && !img.failed && img.naturalWidth) ctx.drawImage(img, tx * tsz - cx + half[0], ty * tsz - cy + half[1], tsz + 0.5, tsz + 0.5);
  }
}

// ---- interaction ----
let drag = null;
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.x) * devicePixelRatio, dy = (e.clientY - drag.y) * devicePixelRatio;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) { const [cx, cy] = toPx(view.lat, view.lng); [view.lat, view.lng] = fromPx(cx - dx, cy - dy); drag.x = e.clientX; drag.y = e.clientY; draw(); }
});
canvas.addEventListener("pointerup", (e) => {
  const wasClick = drag && !drag.moved; drag = null;
  if (!wasClick) return;
  const r = canvas.getBoundingClientRect(), [lat, lng] = fromScreen((e.clientX - r.left) * devicePixelRatio, (e.clientY - r.top) * devicePixelRatio);
  if (routeMode) { route.push([lat, lng]); draw(); } else setPosition(lat, lng);
});
canvas.addEventListener("wheel", (e) => { e.preventDefault(); view.z = Math.max(3, Math.min(19, view.z - Math.sign(e.deltaY) * 0.5)); draw(); }, { passive: false });
window.addEventListener("resize", resize);
$("osm").addEventListener("change", () => { $("attrib").textContent = $("osm").checked ? "© OpenStreetMap contributors" : ""; draw(); });

async function setPosition(lat, lng, follow = false) {
  pos = { lat, lng }; $("lat").value = lat.toFixed(6); $("lng").value = lng.toFixed(6);
  if (follow) { view.lat = lat; view.lng = lng; }
  draw();
  const r = await post("/api/position", pos);
  limit = r.data?.limit ?? null; showLimit(); draw();
}

function showLimit() {
  const speed = Number($("speed").value);
  if (!limit || !limit.found) { $("limit").textContent = "–"; $("limit").className = "mute"; $("limitinfo").textContent = limit ? `kein Tempolimit gefunden (${limit.from ?? "?"})` : "Position setzen (Klick auf die Karte)"; return; }
  $("limit").textContent = `${limit.speedLimit} ${limit.speedLimitUnit === "mph" ? "mph" : "km/h"}`;
  $("limit").className = driving && speed > limit.speedLimit ? "bad" : "";
  $("limitinfo").textContent = `Quelle: ${limit.from === "local-cache" ? "lokaler Speicher (offline)" : "Server " + limit.server} · ${Math.round(limit.distanceMeters)} m zum Segment`;
}

// ---- route driving ----
function polyLen(pts) { let d = 0; for (let i = 0; i + 1 < pts.length; i++) d += hav(pts[i], pts[i + 1]); return d; }
function hav([a, b], [c, d]) { const R = 6371000, r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function pointAt(pts, dist) { for (let i = 0; i + 1 < pts.length; i++) { const l = hav(pts[i], pts[i + 1]); if (dist <= l) { const t = l === 0 ? 0 : dist / l; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]; } dist -= l; } return pts[pts.length - 1]; }

$("btnGo").addEventListener("click", () => {
  if (driving) { clearInterval(driving.timer); driving = null; $("btnGo").textContent = "▶ Fahren"; $("btnGo").classList.remove("on"); showLimit(); return; }
  if (route.length < 2) { msg("Erst eine Route mit mindestens 2 Punkten zeichnen"); return; }
  const total = polyLen(route); let travelled = 0, last = performance.now();
  $("btnGo").textContent = "■ Stopp"; $("btnGo").classList.add("on");
  driving = { timer: setInterval(async () => {
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    travelled += (Number($("speed").value) / 3.6) * dt;
    if (travelled >= total) { travelled = total; }
    const [la, ln] = pointAt(route, travelled); await setPosition(la, ln, true);
    if (travelled >= total) $("btnGo").click();
  }, 600) };
});
$("btnRoute").addEventListener("click", () => { routeMode = !routeMode; $("btnRoute").classList.toggle("on", routeMode); $("btnRoute").textContent = routeMode ? "Zeichnen beenden" : "Route zeichnen"; });
$("btnClearRoute").addEventListener("click", () => { route = []; draw(); });
$("btnSet").addEventListener("click", () => { const la = parseFloat($("lat").value), ln = parseFloat($("lng").value); if (Number.isFinite(la) && Number.isFinite(ln)) { view.lat = la; view.lng = ln; setPosition(la, ln); } });
for (const [id, la, ln] of [["btnMunich", 48.1374, 11.5755], ["btnNuremberg", 49.4539, 11.0775], ["btnRegensburg", 49.0134, 12.1016]]) $(id).addEventListener("click", () => { view.lat = la; view.lng = ln; setPosition(la, ln); });
$("btnSync").addEventListener("click", async () => { msg("lade Umgebung …"); const r = await post("/api/sync"); msg(r.ok ? "Umgebung geladen" : `Sync fehlgeschlagen: ${r.data?.error ?? r.status}`); });
$("btnFlush").addEventListener("click", async () => { const r = await post("/api/flush"); msg(`Outbox: ${JSON.stringify(r.data)}`); });
$("btnBind").addEventListener("click", async () => { const r = await post("/api/bind-key"); msg(r.ok ? "Geräteschlüssel gebunden" : `bind-key: HTTP ${r.status} ${JSON.stringify(r.data)}`); });
$("speed").addEventListener("input", showLimit);

for (const t of TYPES) { const b = document.createElement("button"); b.textContent = TYPE_DE[t]; b.title = t; b.addEventListener("click", async () => {
  if (!pos) { msg("Erst Position setzen"); return; }
  const r = await post("/api/report", { type: t, lat: pos.lat, lng: pos.lng, signed: $("signed").checked });
  const first = r.data?.[0]; msg(first?.sent ? `Meldung gesendet (HTTP ${first.status}${first.data?.merged ? ", mit vorhandener zusammengeführt" : ""})` : first?.buffered ? "Server nicht erreichbar – Meldung gepuffert" : `Meldung abgelehnt: ${JSON.stringify(first)}`);
}); $("types").appendChild(b); }

const msg = (t) => { $("msg").textContent = t; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (iso) => { const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 90 ? `${s}s` : `${Math.round(s / 60)}min`; };

function renderPanels() {
  const st = state.status;
  $("conn").innerHTML = st.servers.map((s) => `<div><span class="pill ${s.down ? "bad" : "ok"}">${s.down ? "offline" : "online"}</span> ${s.url === st.activeServer ? "<b>" : ""}${esc(s.url)}${s.url === st.activeServer ? "</b> (aktiv)" : ""} <small>${s.latencyMs != null ? s.latencyMs + " ms" : ""} ${s.lastError ? "· " + esc(s.lastError) : ""}</small></div>`).join("")
    + `<div>Push: <span class="pill ${st.push.connected ? "ok" : "warn"}">${st.push.connected ? "verbunden mit " + esc(st.push.server) : "getrennt"}</span></div>`;
  $("sync").innerHTML = st.cache ? `Stand ${ago(st.cache.at)} her · Radius ${st.cache.radiusM} m<br>${st.cache.segments} Segmente · ${st.cache.signs} Schilder · ${st.cache.hazards} Meldungen` : "<span class='mute'>noch nichts lokal gespeichert</span>";
  $("hazards").innerHTML = (state.cache?.hazards ?? []).map((h) => `<li><b>${esc(TYPE_DE[h.type] ?? h.type)}</b> <small>läuft ab ${h.expiresAt ? new Date(h.expiresAt).toLocaleTimeString() : "?"} · ${esc((h.id ?? "").slice(0, 8))}</small><div class="row"><button data-id="${esc(h.id)}" data-k="stillThere">noch da</button><button data-id="${esc(h.id)}" data-k="gone">weg</button></div></li>`).join("") || "<li class='mute'>keine</li>";
  $("outbox").innerHTML = state.outbox.map((o) => `<li>${esc(o.kind === "report" ? "Meldung " + (TYPE_DE[o.type] ?? o.type) : "Bestätigung " + o.confirmKind)} <small>${ago(o.queuedAt)}</small></li>`).join("") || "<li class='mute'>leer</li>";
  $("events").innerHTML = state.events.map((e) => `<li>${esc(e.type)} <small>${esc(e.entityType)} ${esc(String(e.entityId).slice(0, 8))} · vor ${ago(e.receivedAt)}</small></li>`).join("") || "<li class='mute'>noch keine</li>";
}
$("hazards").addEventListener("click", async (e) => { const b = e.target.closest("button"); if (!b) return; const r = await post("/api/confirm", { reportId: b.dataset.id, kind: b.dataset.k }); const f = r.data?.[0]; msg(f?.sent ? `Bestätigung gesendet (${f.data?.recorded ? "gezählt" : "bereits abgegeben"})` : f?.buffered ? "offline – gepuffert" : JSON.stringify(f)); });

async function refresh() { state = await (await fetch("/api/state")).json(); if (!pos && state.status.position) { pos = state.status.position; view.lat = pos.lat; view.lng = pos.lng; $("lat").value = pos.lat.toFixed(6); $("lng").value = pos.lng.toFixed(6); } renderPanels(); draw(); }
resize();
refresh();
new EventSource("/api/events").addEventListener("change", refresh);
setInterval(refresh, 5000);
