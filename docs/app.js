/* KAAX ground station — app.js
 * Transports: Web Serial (Heltec base) · WebSocket (Raspberry Pi) · Simulation
 * Same line protocol everywhere:
 *   in : KAAX,<id>,lat,lon,b1,b2,fix,spd_kmh,hdg[,rssi]
 *   out: CMD,<id>,R,L · NET,<id>,0|1 · STOP,<id> · PING,<id>
 */
(() => {
"use strict";
const CFG = window.KAAX_CONFIG;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem("kaax." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => localStorage.setItem("kaax." + k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem("kaax." + k),
};

// ---------- settings ----------------------------------------------------
const S = Object.assign({
  transport: "ws", piUrl: CFG.pi.url, piToken: CFG.pi.token, baud: CFG.serial.baud,
  useGeo: CFG.useBrowserLocation, lat: CFG.zone.lat, lon: CFG.zone.lon,
  swath: CFG.swathMeters, noise: CFG.gpsNoiseMeters,
  aiKey: "", aiModel: CFG.ai.model,
  modelUrl: CFG.vision.modelUrl, cvth: CFG.vision.threshold, usePad: true,
  grid: { ...CFG.grid },
}, LS.get("settings", {}));
// Migración: antes había wsUrl y camUrl por separado; ahora todo sale de piUrl.
if (!S.piUrl && (S.wsUrl || S.camUrl)) {
  const base = (S.camUrl || S.wsUrl || "").replace(/\/(camera\/stream|ws).*$/, "").replace(/^ws/, "http");
  S.piUrl = base || CFG.pi.url;
}
delete S.wsUrl; delete S.camUrl;
const saveSettings = () => LS.set("settings", S);
// Las URLs de la Pi se derivan de S.piUrl (ver pi.js).
const PI = window.KaaxPi.init(() => S);

// ---------- helpers ----------------------------------------------------
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2600); };
const fmt = (n, d = 0) => Number(n || 0).toLocaleString("es-MX", { maximumFractionDigits: d, minimumFractionDigits: d });
const hms = (ms) => { const s = Math.floor(ms / 1000); return [s / 3600, s / 60 % 60, s % 60].map(v => String(Math.floor(v)).padStart(2, "0")).join(":"); };
const haversine = (a, b) => { const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const mPerDegLat = 111320;
const mPerDegLon = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
const log = (msg, cls = "") => { const el = $("#log"); const ts = new Date().toTimeString().slice(0, 8); el.insertAdjacentHTML("afterbegin", `<div class="${cls}">${ts} ${msg.replace(/</g, "&lt;")}</div>`); while (el.children.length > 200) el.lastChild.remove(); };
const battClass = (v) => v < CFG.battery.low ? "low" : v < CFG.battery.warn ? "warn" : "";
const battPct = (v) => Math.max(0, Math.min(100, (v - CFG.battery.min) / (CFG.battery.full - CFG.battery.min) * 100));
// Solo hay batería que mostrar si el robot la reporta Y la config la habilita.
const hasBatt = (r) => CFG.battery.enabled !== false && r.b1 !== null && r.b1 !== undefined;

// ---------- transports ---------------------------------------------------
let onLine = () => {};
const Serial = {
  port: null, reader: null, writer: null, alive: false,
  async connect() {
    if (!("serial" in navigator)) throw new Error("Este navegador no soporta Web Serial. Usa Chrome o Edge en escritorio.");
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: S.baud });
    this.alive = true;
    const enc = new TextEncoderStream(); enc.readable.pipeTo(this.port.writable); this.writer = enc.writable.getWriter();
    const dec = new TextDecoderStream(); this.port.readable.pipeTo(dec.writable); this.reader = dec.readable.getReader();
    this.port.addEventListener("disconnect", () => { this.alive = false; setConn(false); log("USB desconectado", "err"); });
    (async () => { let buf = ""; try { while (this.alive) { const { value, done } = await this.reader.read(); if (done) break; buf += value; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); } } } catch (e) { if (this.alive) log("Lectura USB: " + e.message, "err"); } })();
  },
  async send(l) { if (this.writer) await this.writer.write(l + "\n"); },
  async disconnect() { this.alive = false; try { await this.reader?.cancel(); await this.writer?.close(); await this.port?.close(); } catch {} },
};
const WS = {
  ws: null, alive: false,
  connect() { return new Promise((res, rej) => { const url = KaaxPi.Url.ws(); this.ws = new WebSocket(url); this.ws.onopen = () => { this.alive = true; res(); }; this.ws.onerror = () => rej(new Error(
      url.startsWith("wss")
        ? "No se pudo abrir " + url + ". Si el certificado de la Pi no está instalado en este equipo, el navegador corta la conexión sin avisar (README §12)."
        : "No se pudo abrir " + url + ". Una GUI en https no puede usar ws:// — necesitas wss:// (corre pi/setup_tls.sh en la Pi).")); this.ws.onclose = () => { if (this.alive) { this.alive = false; setConn(false); log("WebSocket cerrado", "err"); } }; this.ws.onmessage = (e) => String(e.data).split("\n").map(s => s.trim()).filter(Boolean).forEach(onLine); }); },
  send(l) { if (this.ws?.readyState === 1) this.ws.send(l + "\n"); },
  disconnect() { this.alive = false; this.ws?.close(); },
};
const Sim = {
  t: null, bots: {}, alive: false,
  connect() { this.alive = true; CFG.robots.forEach((r, i) => { this.bots[r.id] = { lat: S.lat + (i - 1) * 0.0003, lon: S.lon + (i - 1) * 0.0004, hdg: i * 120, b1: 16.4, b2: 16.2, R: 1500, L: 1500, net: 0 }; }); this.t = setInterval(() => this.tick(), 1000); },
  tick() { for (const [id, b] of Object.entries(this.bots)) { const thr = ((b.R + b.L) / 2 - 1500) / 400, turn = (b.R - b.L) / 800; b.hdg = (b.hdg + turn * 40 + 360) % 360; const v = thr * 1.4; /* m/s */ b.lat += v * Math.cos(b.hdg * Math.PI / 180) / mPerDegLat; b.lon += v * Math.sin(b.hdg * Math.PI / 180) / mPerDegLon(b.lat); b.b1 -= 0.002 + Math.abs(thr) * 0.01; b.b2 -= 0.002 + Math.abs(thr) * 0.012; onLine(`KAAX,${id},${b.lat.toFixed(6)},${b.lon.toFixed(6)},${b.b1.toFixed(2)},${b.b2.toFixed(2)},1,${(v * 3.6).toFixed(2)},${b.hdg.toFixed(0)},${-60 - Math.round(Math.random() * 30)}`); } },
  send(l) { const p = l.split(","); const ids = p[1] === "00" ? Object.keys(this.bots) : [p[1]]; ids.forEach(id => { const b = this.bots[id]; if (!b) return; if (p[0] === "CMD") { b.R = +p[2]; b.L = +p[3]; } if (p[0] === "STOP") { b.R = b.L = 1500; } if (p[0] === "NET") b.net = +p[2]; }); },
  disconnect() { this.alive = false; clearInterval(this.t); },
};
const transports = { serial: Serial, ws: WS, sim: Sim };
let T = null;

function setConn(up, mode) {
  const d = $("#conn-dot"), l = $("#conn-lbl"), b = $("#btn-connect");
  d.className = "dot " + (up ? (mode === "sim" ? "sim" : "on") : "off");
  l.textContent = up ? ({ serial: "USB · base", ws: "Pi · WebSocket", sim: "simulación" })[mode] : "sin enlace";
  b.textContent = up ? "Desconectar" : "Conectar";
  if (!up) T = null;
}
$("#btn-connect").onclick = async () => {
  if (T) { await T.disconnect(); setConn(false); log("Enlace cerrado", "sys"); return; }
  const tr = transports[S.transport];
  try { await tr.connect(); T = tr; setConn(true, S.transport); log("Enlace listo: " + $("#conn-lbl").textContent, "sys"); }
  catch (e) { toast(e.message); log(e.message, "err"); }
};
const send = (l) => { if (!T) return; T.send(l); log(l, "tx"); };

// ---------- fleet state --------------------------------------------------
const fleet = {};   // id -> {lat,lon,b1,b2,fix,spd,hdg,rssi,seen,track:[]}
CFG.robots.forEach(r => fleet[r.id] = { ...r, lat: 0, lon: 0, b1: null, b2: null, fix: 0, spd: 0, hdg: 0, rssi: null, seen: 0, track: [] });

onLine = (line) => {
  const p = line.split(",");
  if (p[0] === "KAAX" && p.length >= 7) {
    const r = fleet[p[1]]; if (!r) { log("robot desconocido " + p[1], "err"); return; }
    r.lat = +p[2]; r.lon = +p[3];
    // La Pi manda estos campos vacíos (no mide baterías). Vacío != 0 V: si lo
    // tratáramos como número, la GUI mostraría 0.00 V y "batería crítica".
    r.b1 = p[4] === "" ? null : +p[4]; r.b2 = p[5] === "" ? null : +p[5];
    r.fix = +p[6]; r.spd = +(p[7] || 0); r.hdg = +(p[8] || 0);
    r.rssi = p.length >= 10 ? +p[9] : null; r.seen = Date.now();
    if (r.fix && r.lat && r.lon) { const pt = { lat: r.lat, lon: r.lon, t: r.seen, spd: r.spd }; const last = r.track[r.track.length - 1]; if (!last || haversine(last, pt) >= S.noise) { r.track.push(pt); if (r.track.length > 3000) r.track.shift(); } Session.onFix(r, pt); Grid.markVisited(r.lat, r.lon); if (S.follow && !Grid.cellAt(r.lat, r.lon)) { recenter(r.lat, r.lon); Grid.build(); } }
    Session.onTelemetry(r);
    renderRobots(); updateMarkers();
  } else if (p[0] === "TX") { /* echo */ }
  else log(line, "sys");
};

function renderRobots() {
  const now = Date.now();
  $("#robots").innerHTML = Object.values(fleet).map(r => { const age = r.seen ? (now - r.seen) / 1000 : null; const stale = age === null || age > 5; return `
    <div class="robot ${r.id === Control.target ? "sel" : ""}" data-id="${r.id}">
      <div class="hd"><span class="nm"><i style="background:${r.color}"></i>${r.name}</span><span class="age ${stale ? "stale" : ""}">${age === null ? "sin datos" : age < 1 ? "ahora" : "hace " + Math.round(age) + " s"}</span></div>
      <div class="grid">
        <span class="k">GPS</span><span class="v">${r.fix ? r.lat.toFixed(5) + ", " + r.lon.toFixed(5) : "sin fix"}</span>
        <span class="k">Velocidad</span><span class="v">${fmt(r.spd, 1)} km/h · ${fmt(r.hdg)}°</span>
        ${hasBatt(r) ? `<span class="k">Bat. 1</span><span class="v">${fmt(r.b1, 2)} V</span>
        <span class="k">Bat. 2</span><span class="v">${fmt(r.b2, 2)} V</span>` : ""}
        <span class="k">Señal</span><span class="v">${r.rssi === null ? "—" : r.rssi + " dBm"}</span>
      </div>
      ${hasBatt(r) ? `<div class="bat"><i class="${battClass(r.b1)}" style="width:${battPct(r.b1)}%"></i></div>
      <div class="bat" style="margin-top:3px"><i class="${battClass(r.b2)}" style="width:${battPct(r.b2)}%"></i></div>` : ""}
    </div>`; }).join("");
  $$("#robots .robot").forEach(el => el.onclick = () => { Control.setTarget(el.dataset.id); });
}
setInterval(renderRobots, 1000);

// ---------- maps ---------------------------------------------------------
const tiles = () => L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
const mapFleet = L.map("map-fleet", { zoomControl: true }).setView([S.lat, S.lon], 17); tiles().addTo(mapFleet);
const mapGrid = L.map("map-grid").setView([S.lat, S.lon], 17); tiles().addTo(mapGrid);
const markers = {}, lines = {};
// Los marcadores y las trazas se dibujan en LOS DOS mapas. Antes solo se
// añadían a mapFleet, así que la cuadrícula marcaba celdas visitadas pero
// nunca mostraba dónde estaba el robot: parecía que no usaba el GPS.
const dot = (r) => L.divIcon({ className: "", html: `<div class="rl" style="background:${r.color}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });

function updateMarkers() {
  for (const r of Object.values(fleet)) {
    if (!r.fix || !r.lat) continue;
    const ll = [r.lat, r.lon];
    if (!markers[r.id]) {
      markers[r.id] = {};
      lines[r.id] = {};
      for (const [k, map] of [["fleet", mapFleet], ["grid", mapGrid]]) {
        markers[r.id][k] = L.marker(ll, { icon: dot(r) }).addTo(map)
          .bindTooltip(r.name, { permanent: true, direction: "right", offset: [10, 0], className: "mono" });
        lines[r.id][k] = L.polyline([], { color: r.color, weight: 3, opacity: .7 }).addTo(map);
      }
    }
    const track = r.track.map(p => [p.lat, p.lon]);
    for (const k of ["fleet", "grid"]) {
      markers[r.id][k].setLatLng(ll);
      lines[r.id][k].setLatLngs(track);
    }
  }
}
function recenter(lat, lon) { S.lat = lat; S.lon = lon; mapFleet.setView([lat, lon]); mapGrid.setView([lat, lon]); $("#zone-lbl").textContent = `Zona: ${lat.toFixed(5)}, ${lon.toFixed(5)}`; }
recenter(S.lat, S.lon);
if (S.useGeo && navigator.geolocation) navigator.geolocation.getCurrentPosition(p => { recenter(p.coords.latitude, p.coords.longitude); Grid.build(); loadWeather(); toast("Zona fijada con la ubicación del navegador"); }, () => {}, { timeout: 8000 });

// ---------- weather (Open-Meteo) -------------------------------------------
async function loadWeather() {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${S.lat}&longitude=${S.lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover,uv_index&wind_speed_unit=kmh&timezone=auto`;
    const c = (await (await fetch(u)).json()).current;
    $("#weather").innerHTML = [["Temperatura", fmt(c.temperature_2m, 1) + " °C"], ["Viento", fmt(c.wind_speed_10m, 0) + " km/h · " + c.wind_direction_10m + "°"], ["Lluvia", fmt(c.precipitation, 1) + " mm"], ["Nubes", c.cloud_cover + " %"], ["Índice UV", fmt(c.uv_index, 1)], ["Hora", c.time.slice(11)]].map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join("");
  } catch { $("#weather").innerHTML = `<span class="hint">Sin conexión a Open-Meteo</span>`; }
}
loadWeather(); setInterval(loadWeather, 10 * 60 * 1000);

// ---------- cleaning grid ------------------------------------------------
const Grid = {
  cells: [], layer: L.layerGroup().addTo(mapGrid), origin: null, state: {}, key: "",
  build() {
    const g = S.grid; this.layer.clearLayers(); this.cells = [];
    const dLat = g.cellMeters / mPerDegLat, dLon = g.cellMeters / mPerDegLon(S.lat);
    this.origin = { lat: S.lat + dLat * g.rows / 2, lon: S.lon - dLon * g.cols / 2 };  // top-left
    this.key = `${S.lat.toFixed(5)}_${S.lon.toFixed(5)}_${g.cellMeters}_${g.cols}x${g.rows}`;
    this.state = LS.get("grid." + this.key, {});
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const b = [[this.origin.lat - dLat * (r + 1), this.origin.lon + dLon * c], [this.origin.lat - dLat * r, this.origin.lon + dLon * (c + 1)]];
      const id = r + "_" + c; const rect = L.rectangle(b, this.style(id)).addTo(this.layer); rect.on("click", () => this.toggle(id));
      rect.bindTooltip(`${String.fromCharCode(65 + r)}${c + 1}`, { direction: "center", className: "mono", opacity: .8 });
      this.cells.push({ id, rect });
    }
    this.render();
    if (this.cells.length) mapGrid.fitBounds(L.featureGroup(this.cells.map(c => c.rect)).getBounds().pad(0.15));
  },
  style(id) { const s = this.state[id] || 0; return { className: "cell", weight: 1, color: "rgba(0,119,182,.55)", fillColor: s === 2 ? "#2a9d8f" : s === 1 ? "#f4a261" : "#0077b6", fillOpacity: s === 2 ? .55 : s === 1 ? .45 : .08 }; },
  toggle(id) { this.state[id] = this.state[id] === 2 ? 0 : 2; this.persist(); this.render(); },
  cellAt(lat, lon) { if (!this.origin) return null; const g = S.grid, dLat = g.cellMeters / mPerDegLat, dLon = g.cellMeters / mPerDegLon(S.lat); const r = Math.floor((this.origin.lat - lat) / dLat), c = Math.floor((lon - this.origin.lon) / dLon); return r >= 0 && r < g.rows && c >= 0 && c < g.cols ? r + "_" + c : null; },
  markVisited(lat, lon) { const id = this.cellAt(lat, lon); if (id && !this.state[id]) { this.state[id] = 1; this.persist(); this.render(); } },
  persist() { LS.set("grid." + this.key, this.state); },
  counts() { const v = Object.values(this.state); return { clean: v.filter(x => x === 2).length, visited: v.filter(x => x === 1).length, total: this.cells.length }; },
  render() { this.cells.forEach(c => c.rect.setStyle(this.style(c.id))); const k = this.counts(); $("#g-clean").firstChild.textContent = k.clean; $("#g-total").textContent = "/ " + k.total; $("#g-area").firstChild.textContent = fmt(k.clean * S.grid.cellMeters ** 2); $("#g-visited").textContent = k.visited; $("#s-cells").textContent = k.clean; },
  reset() { if (confirm("¿Borrar el estado de todos los cuadrantes de esta zona?")) { this.state = {}; this.persist(); this.render(); } },
};
$("#g-size").value = S.grid.cellMeters; $("#g-cols").value = S.grid.cols; $("#g-rows").value = S.grid.rows;
["g-size", "g-cols", "g-rows"].forEach(id => $("#" + id).onchange = () => { S.grid = { cellMeters: +$("#g-size").value || 10, cols: +$("#g-cols").value || 10, rows: +$("#g-rows").value || 10 }; saveSettings(); Grid.build(); });
S.follow = S.follow || false;
$("#g-follow").checked = !!S.follow;
$("#g-follow").onchange = (e) => { S.follow = e.target.checked; saveSettings(); if (S.follow) toast("La cuadrícula seguirá al robot con fix GPS."); };
$("#g-here").onclick = () => {
  if (!navigator.geolocation) return toast("Este navegador no da ubicación.");
  toast("Buscando tu ubicación…");
  navigator.geolocation.getCurrentPosition(
    (p) => { recenter(p.coords.latitude, p.coords.longitude); saveSettings(); Grid.build(); loadWeather(); L.circleMarker([p.coords.latitude, p.coords.longitude], { radius: 7, color: "#0077b6", fillColor: "#00b4d8", fillOpacity: .9 }).addTo(mapGrid).bindTooltip("Estás aquí"); toast("Cuadrícula centrada en tu ubicación."); },
    (e) => toast("No se pudo obtener tu ubicación: " + e.message),
    { enableHighAccuracy: true, timeout: 10000 });
};
$("#g-center").onclick = () => { const c = mapGrid.getCenter(); recenter(c.lat, c.lng); saveSettings(); Grid.build(); loadWeather(); };
$("#g-reset").onclick = () => Grid.reset();
Grid.build();

// ---------- control --------------------------------------------------------
// ---------- rodillos (servos de rotación continua) ---------------------------------
// Dos servos de 360° que empujan la basura hacia adentro. En estos servos el
// ancho de pulso es velocidad y sentido, no ángulo: CFG.rollers.stop los deja
// quietos y alejarse de ahí los hace girar hacia un lado o el otro.
const Rollers = {
  R: CFG.rollers.stop, L: CFG.rollers.stop, ka: null,
  init() {
    $("#rol-toggle").onclick = () => this.toggle();
    $$("[data-rol-step]").forEach(b => {
      const [w, d] = b.dataset.rolStep.split(",");
      b.onclick = () => this.nudge(w, +d);
    });
    // Keepalive propio: el failsafe del robot para todo si no llega nada en
    // 1.5 s, y recogiendo basura con el robot quieto no se manda ningún CMD.
    this.ka = setInterval(() => { if (this.spinning()) this.send(); }, CFG.rollers.keepaliveMs);
    this.render();
  },
  spinning() { return this.R !== CFG.rollers.stop || this.L !== CFG.rollers.stop; },
  clamp(v) { return Math.max(CFG.rollers.min, Math.min(CFG.rollers.max, Math.round(v))); },
  set(which, us) { this[which] = this.clamp(us); this.send(); this.render(); },
  nudge(which, dir) { this.set(which, this[which] + dir * CFG.rollers.step); },
  toggle() {
    const run = CFG.rollers.run, stop = CFG.rollers.stop;
    if (this.spinning()) { this.R = this.L = stop; }
    else { this.R = this.L = run; }
    this.send(); this.render();
  },
  /** Sincroniza la GUI tras un STOP, sin volver a mandar nada. */
  reset() { this.R = this.L = CFG.rollers.stop; this.render(); },
  send() { send(`ROL,${Control.target},${this.R},${this.L}`); },
  render() {
    const { stop, min, max } = CFG.rollers;
    for (const w of ["R", "L"]) {
      const v = this[w], el = $(`.rl-one[data-rol="${w}"]`);
      if (!el) continue;
      const bar = el.querySelector(".rl-bar > b");
      const span = v >= stop ? (max - stop) : (stop - min);
      const frac = Math.min(1, Math.abs(v - stop) / span);
      // La barra sale del centro hacia el lado del giro.
      bar.style.width = (frac * 50) + "%";
      bar.style.left = v >= stop ? "50%" : (50 - frac * 50) + "%";
      el.classList.toggle("rev", v < stop);
      el.classList.toggle("live", v !== stop);
      $("#rol-us-" + w).textContent = v + " µs";
    }
    const on = this.spinning();
    $("#rol-toggle").textContent = on ? "Parar" : "Encender";
    $("#rol-toggle").classList.toggle("on", on);
    $(".rollers").classList.toggle("spin", on);
  },
};

const Control = {
  target: CFG.robots[0].id, keys: {}, thr: .6, last: "", ka: null,
  init() {
    const sel = $("#target"); sel.innerHTML = `<option value="00">Todos</option>` + CFG.robots.map(r => `<option value="${r.id}">${r.name}</option>`).join(""); sel.value = this.target;
    sel.onchange = () => { this.target = sel.value; renderRobots(); };
    $("#thr").oninput = (e) => { this.thr = e.target.value / 100; $("#thr-lbl").textContent = e.target.value + " %"; this.calc(); };
    $("#estop").onclick = () => this.estop();
    const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right" };
    document.addEventListener("keydown", e => { if (e.target.matches("input,textarea,select")) return; if (e.key === " ") { e.preventDefault(); this.estop(); return; } const k = map[e.key.length === 1 ? e.key.toLowerCase() : e.key]; if (!k) return; e.preventDefault(); if (this.keys[k]) return; this.keys[k] = true; this.calc(); });
    document.addEventListener("keyup", e => { const k = map[e.key.length === 1 ? e.key.toLowerCase() : e.key]; if (!k) return; this.keys[k] = false; this.calc(); });
    $$(".dpad button").forEach(b => { const k = b.dataset.k; const dn = (e) => { e.preventDefault(); this.keys[k] = true; this.calc(); }, up = (e) => { e.preventDefault(); if (!this.keys[k]) return; this.keys[k] = false; this.calc(); }; b.onmousedown = dn; b.onmouseup = up; b.onmouseleave = up; b.ontouchstart = dn; b.ontouchend = up; });
    this.ka = setInterval(() => { if (this.last && this.last !== `CMD,${this.target},1500,1500`) send(this.last); }, CFG.motor.keepaliveMs);
    window.addEventListener("blur", () => { this.keys = {}; this.calc(); });
  },
  setTarget(id) { this.target = id; $("#target").value = id; renderRobots(); },
  calc() {
    const N = CFG.motor.neutral, A = Math.round(CFG.motor.span * this.thr), k = this.keys; let R = N, L = N;
    if (k.up && k.left) { R = N + A; L = N + A / 2; } else if (k.up && k.right) { R = N + A / 2; L = N + A; }
    else if (k.down && k.left) { R = N - A; L = N - A / 2; } else if (k.down && k.right) { R = N - A / 2; L = N - A; }
    else if (k.up) { R = L = N + A; } else if (k.down) { R = L = N - A; }
    else if (k.left) { R = N + A; L = N - A; } else if (k.right) { R = N - A; L = N + A; }
    $$(".dpad button").forEach(b => b.classList.toggle("on", !!k[b.dataset.k]));
    const cmd = `CMD,${this.target},${Math.round(R)},${Math.round(L)}`;
    if (cmd !== this.last) { this.last = cmd; send(cmd); }
  },
  estop() {
    this.keys = {}; this.last = ""; $$(".dpad button").forEach(b => b.classList.remove("on"));
    send(`STOP,00`);
    // STOP ya para los rodillos en el robot; esto sincroniza lo que ves.
    Rollers.reset();
    toast("Paro de emergencia enviado a toda la flota");
  },
};
Control.init(); Rollers.init();

// ---------- session ----------------------------------------------------------
const Session = {
  cur: null, tick: null,
  init() {
    $("#s-weights").innerHTML = CFG.contaminants.map(c => `<div class="field"><span>${c.label}</span><input type="number" min="0" step="0.1" data-w="${c.key}" placeholder="0.0"></div>`).join("");
    $("#s-start").onclick = () => this.start(); $("#s-stop").onclick = () => this.stop();
    const c = LS.get("current", null); if (c) { this.cur = c; this.arm(); toast("Sesión anterior recuperada"); }
  },
  start() {
    this.cur = { id: Date.now(), start: Date.now(), end: null, site: $("#s-site").value, ops: $("#s-ops").value, robots: {}, cellsStart: Grid.counts().clean, gridKey: Grid.key, user: Auth.user?.name || "", detections: {} };
    CFG.robots.forEach(r => this.cur.robots[r.id] = { name: r.name, dist: 0, spdSum: 0, spdN: 0, spdMax: 0, battMin: null, last: null, samples: 0 });
    this.arm(); LS.set("current", this.cur); toast("Sesión iniciada");
  },
  arm() { $("#s-start").disabled = true; $("#s-stop").disabled = false; $("#s-state").textContent = "Sesión en curso desde " + new Date(this.cur.start).toLocaleTimeString("es-MX"); $("#s-site").value = this.cur.site || ""; $("#s-ops").value = this.cur.ops || ""; this.tick = setInterval(() => this.render(), 1000); this.render(); },
  onDetection(cls, p) { if (!this.cur) return; const d = this.cur.detections = this.cur.detections || {}; d[cls] = (d[cls] || 0) + 1; },
  onFix(r, pt) { if (!this.cur) return; const s = this.cur.robots[r.id]; if (!s) return; if (s.last) s.dist += haversine(s.last, pt); s.last = pt; },
  onTelemetry(r) { if (!this.cur) return; const s = this.cur.robots[r.id]; if (!s) return; s.samples++; if (r.spd > 0.2) { s.spdSum += r.spd; s.spdN++; s.spdMax = Math.max(s.spdMax, r.spd); } if (hasBatt(r)) { const bm = Math.min(r.b1, r.b2); s.battMin = s.battMin === null ? bm : Math.min(s.battMin, bm); } if (this.cur.robots) LS.set("current", this.cur); },
  stats() {
    const c = this.cur, dur = ((c.end || Date.now()) - c.start) / 1000; const rs = Object.values(c.robots);
    const dist = rs.reduce((a, r) => a + r.dist, 0); const n = rs.reduce((a, r) => a + r.spdN, 0);
    const avg = n ? rs.reduce((a, r) => a + r.spdSum, 0) / n : 0;
    const cells = Math.max(0, Grid.counts().clean - (c.cellsStart || 0));
    return { dur, dist, avg, swept: dist * S.swath, cellsArea: cells * S.grid.cellMeters ** 2, cells, active: rs.filter(r => r.dist > 0).length };
  },
  render() {
    if (!this.cur) return; const st = this.stats();
    $("#s-timer").textContent = hms(st.dur * 1000);
    $("#s-dist").firstChild.textContent = fmt(st.dist); $("#s-spd").firstChild.textContent = fmt(st.avg, 1); $("#s-area").firstChild.textContent = fmt(st.swept);
    $("#s-robots").innerHTML = Object.entries(this.cur.robots).map(([id, r]) => `<tr><td>${r.name}</td><td class="num">${fmt(r.dist)}</td><td class="num">${fmt(r.spdN ? r.spdSum / r.spdN : 0, 1)}</td><td class="num">${fmt(r.spdMax, 1)}</td><td class="num">${r.battMin === null ? "—" : fmt(r.battMin, 2) + " V"}</td></tr>`).join("");
  },
  stop() {
    if (!this.cur) return; const c = this.cur; c.end = Date.now(); c.site = $("#s-site").value; c.ops = $("#s-ops").value; c.notes = $("#s-notes").value;
    c.weights = {}; $$("#s-weights input").forEach(i => c.weights[i.dataset.w] = +i.value || 0);
    c.stats = this.stats(); c.weather = $("#weather").textContent.slice(0, 120); c.zone = { lat: S.lat, lon: S.lon };
    Object.values(c.robots).forEach(r => { r.avg = r.spdN ? r.spdSum / r.spdN : 0; delete r.last; });
    const all = LS.get("sessions", []); all.push(c); LS.set("sessions", all); LS.del("current");
    // Encola sin esperar: offline, la confirmación del servidor puede tardar
    // horas y bloquearía el guardado de la sesión.
    const queued = KaaxAuth.pushSession(JSON.parse(JSON.stringify(c)));
    if (queued && KaaxPi.state.offline) toast("Sesión guardada. Se subirá al equipo cuando vuelvas a línea.");
    Field.paint(KaaxPi.state);
    clearInterval(this.tick); this.cur = null;
    $("#s-start").disabled = false; $("#s-stop").disabled = true; $("#s-state").textContent = "Sesión guardada. Revisa Reportes."; $("#s-timer").textContent = "00:00:00"; $("#s-notes").value = ""; $$("#s-weights input").forEach(i => i.value = "");
    Reports.render(); toast("Sesión guardada"); location.hash = "#/reportes";
  },
};
Session.init();

// ---------- reports -----------------------------------------------------------
const Reports = {
  chart: null,
  async syncDown() { try { const remote = await KaaxAuth.pullSessions(); if (!remote) return; const local = LS.get("sessions", []); const ids = new Set(local.map(s => s.id)); let n = 0; remote.forEach(s => { if (!ids.has(s.id)) { local.push(s); n++; } }); local.sort((a, b) => a.start - b.start); LS.set("sessions", local); this.render(); if (n) toast(n + " sesión(es) del equipo sincronizadas"); } catch {} },
  all: () => LS.get("sessions", []),
  totalKg: (s) => Object.values(s.weights || {}).reduce((a, b) => a + b, 0),
  render() {
    const all = this.all();
    const tot = { n: all.length, kg: 0, dist: 0, dur: 0, area: 0, cells: 0 };
    all.forEach(s => { tot.kg += this.totalKg(s); tot.dist += s.stats.dist; tot.dur += s.stats.dur; tot.area += s.stats.swept; tot.cells += s.stats.cells; });
    const kgh = tot.dur ? tot.kg / (tot.dur / 3600) : 0;
    $("#r-kpis").innerHTML = [["Sesiones", tot.n, ""], ["Material retirado", fmt(tot.kg, 1), "kg"], ["Distancia", fmt(tot.dist / 1000, 2), "km"], ["Tiempo", hms(tot.dur * 1000), ""], ["Área barrida", fmt(tot.area), "m²"], ["Ritmo", fmt(kgh, 2), "kg/h"]].map(([l, n, u]) => `<div class="kpi"><div class="l">${l}</div><div class="n">${n}<span class="u">${u}</span></div></div>`).join("");
    if (!all.length) { $("#r-table").innerHTML = `<div class="empty">Aún no hay sesiones. Inicia una en la pestaña Sesión.</div>`; this.chart?.destroy(); this.chart = null; return; }
    $("#r-table").innerHTML = `<table><thead><tr><th>Fecha</th><th>Operador</th><th>Lugar</th><th class="num">Duración</th><th class="num">m</th><th class="num">km/h</th><th class="num">m²</th>${CFG.contaminants.map(c => `<th class="num">${c.label} kg</th>`).join("")}<th></th></tr></thead><tbody>` +
      all.slice().reverse().map(s => `<tr><td>${new Date(s.start).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" })}</td><td>${s.user || s.ops || "—"}</td><td>${s.site || "—"}</td><td class="num">${hms(s.stats.dur * 1000)}</td><td class="num">${fmt(s.stats.dist)}</td><td class="num">${fmt(s.stats.avg, 1)}</td><td class="num">${fmt(s.stats.swept)}</td>${CFG.contaminants.map(c => `<td class="num">${fmt(s.weights?.[c.key] || 0, 1)}</td>`).join("")}<td><button class="btn sm ghost" data-del="${s.id}">borrar</button></td></tr>`).join("") + `</tbody></table>`;
    const byOp = {}; all.forEach(s => { const k = s.user || s.ops || "—"; const o = byOp[k] = byOp[k] || { n: 0, kg: 0, dur: 0, area: 0 }; o.n++; o.kg += this.totalKg(s); o.dur += s.stats.dur; o.area += s.stats.swept; });
    $("#r-table").insertAdjacentHTML("beforeend", `<h2 style="margin-top:16px">Por operador</h2><table><thead><tr><th>Operador</th><th class="num">Sesiones</th><th class="num">kg</th><th class="num">Tiempo</th><th class="num">m²</th><th class="num">kg/h</th></tr></thead><tbody>` + Object.entries(byOp).map(([k, o]) => `<tr><td>${k}</td><td class="num">${o.n}</td><td class="num">${fmt(o.kg, 1)}</td><td class="num">${hms(o.dur * 1000)}</td><td class="num">${fmt(o.area)}</td><td class="num">${fmt(o.dur ? o.kg / (o.dur / 3600) : 0, 2)}</td></tr>`).join("") + `</tbody></table>`);
    $$("[data-del]").forEach(b => b.onclick = () => { if (confirm("¿Borrar esta sesión?")) { LS.set("sessions", all.filter(s => s.id !== +b.dataset.del)); KaaxAuth.deleteSession(b.dataset.del).catch(() => {}); this.render(); } });
    const labels = all.map(s => new Date(s.start).toLocaleDateString("es-MX", { day: "2-digit", month: "short" }));
    const ds = CFG.contaminants.map((c, i) => ({ label: c.label, data: all.map(s => s.weights?.[c.key] || 0), backgroundColor: ["#0077b6", "#00b4d8", "#2a9d8f"][i % 3], stack: "kg" }));
    ds.push({ label: "Área barrida (m²)", data: all.map(s => s.stats.swept), type: "line", borderColor: "#f4a261", backgroundColor: "#f4a261", yAxisID: "y2", tension: .3 });
    this.chart?.destroy();
    this.chart = new Chart($("#r-chart"), { data: { labels, datasets: ds }, type: "bar", options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { stacked: true, title: { display: true, text: "kg" } }, y2: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "m²" } } }, font: { family: "Space Grotesk" } } });
  },
  csv() {
    const all = this.all(); const cols = ["fecha", "usuario", "lugar", "operadores", "duracion_s", "distancia_m", "vel_media_kmh", "area_barrida_m2", "cuadrantes", ...CFG.contaminants.map(c => c.key + "_kg"), "notas"];
    const rows = all.map(s => [new Date(s.start).toISOString(), s.user || "", s.site, s.ops, Math.round(s.stats.dur), Math.round(s.stats.dist), s.stats.avg.toFixed(2), Math.round(s.stats.swept), s.stats.cells, ...CFG.contaminants.map(c => s.weights?.[c.key] || 0), (s.notes || "").replace(/\n/g, " ")]);
    this.download("kaax_sesiones.csv", [cols, ...rows].map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n"), "text/csv");
  },
  download(name, data, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); },
  summaryForAI() { return this.all().map(s => ({ fecha: new Date(s.start).toISOString().slice(0, 16), lugar: s.site, duracion_min: Math.round(s.stats.dur / 60), distancia_m: Math.round(s.stats.dist), velocidad_media_kmh: +s.stats.avg.toFixed(2), area_barrida_m2: Math.round(s.stats.swept), cuadrantes_limpios: s.stats.cells, kg: s.weights, robots: Object.fromEntries(Object.entries(s.robots).map(([id, r]) => [id, { m: Math.round(r.dist), kmh: +(r.avg || 0).toFixed(2), bat_min_V: r.battMin }])), notas: s.notes })); },
  async ai() {
    const out = $("#r-ai-out"); const data = this.summaryForAI();
    if (!data.length) { out.textContent = "No hay sesiones que analizar."; return; }
    if (!S.aiKey) { out.textContent = "Falta la API key de Ollama Cloud. Configúrala en Ajustes."; return; }
    out.textContent = "Analizando…";
    const prompt = `Eres el analista de datos de DAY1 Robotics. Kaax es una flota de robots acuáticos que retira sargazo, lirio acuático y residuos de cuerpos de agua en México. Analiza estas sesiones (JSON) y responde en español, en máximo 180 palabras y sin encabezados: 1) tendencia de kg/h y de área barrida, 2) qué robot rinde mejor y por qué (distancia, velocidad, batería), 3) dos recomendaciones operativas concretas. Datos: ${JSON.stringify(data)}`;
    const body = { model: S.aiModel, stream: false, messages: [{ role: "user", content: prompt }] };
    try {
      let r = await fetch(CFG.ai.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + S.aiKey }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); out.textContent = j.message?.content?.trim() || JSON.stringify(j);
    } catch (e) {
      // fallback: proxy on the Pi bridge (same origin when served from the Pi)
      try { const r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json", "X-Ollama-Key": S.aiKey }, body: JSON.stringify(body) }); const j = await r.json(); out.textContent = j.message?.content?.trim() || JSON.stringify(j); }
      catch { out.textContent = "No se pudo contactar a Ollama Cloud (" + e.message + "). Si es un bloqueo CORS del navegador, abre la GUI desde la Pi para usar el proxy /api/ai."; }
    }
  },
};
$("#r-csv").onclick = () => Reports.csv();
$("#r-json").onclick = () => Reports.download("kaax_sesiones.json", JSON.stringify(Reports.all(), null, 2), "application/json");
$("#r-print").onclick = () => window.print();
$("#r-ai").onclick = () => Reports.ai();
$("#r-import").onclick = () => { const i = document.createElement("input"); i.type = "file"; i.accept = ".json"; i.onchange = async () => { try { const arr = JSON.parse(await i.files[0].text()); const all = Reports.all(); const ids = new Set(all.map(s => s.id)); arr.forEach(s => { if (!ids.has(s.id)) all.push(s); }); all.sort((a, b) => a.start - b.start); LS.set("sessions", all); Reports.render(); toast("Sesiones importadas"); } catch { toast("Archivo no válido"); } }; i.click(); };
Reports.render();

// ---------- settings view ---------------------------------------------------------
const A = { transport: "a-transport", piUrl: "a-pi", piToken: "a-pi-token", baud: "a-baud", lat: "a-lat", lon: "a-lon", swath: "a-swath", noise: "a-noise", aiKey: "a-key", aiModel: "a-model", modelUrl: "a-model-url", cvth: "a-cvth" };
function loadSettingsForm() { for (const [k, id] of Object.entries(A)) $("#" + id).value = S[k]; $("#a-geo").checked = S.useGeo; $("#a-pad").checked = S.usePad; }
$("#a-save").onclick = () => { for (const [k, id] of Object.entries(A)) { const el = $("#" + id); S[k] = el.type === "number" ? +el.value : el.value; } S.useGeo = $("#a-geo").checked; S.usePad = $("#a-pad").checked; saveSettings(); recenter(S.lat, S.lon); Grid.build(); loadWeather(); toast("Ajustes guardados"); };
$("#a-wipe").onclick = () => { if (confirm("Se borrarán sesiones, cuadrículas y ajustes de este navegador.")) { Object.keys(localStorage).filter(k => k.startsWith("kaax.")).forEach(k => localStorage.removeItem(k)); location.reload(); } };
loadSettingsForm();


// ---------- auth ----------------------------------------------------------
function sha256js(str) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const b = new TextEncoder().encode(str), l = b.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n); m.set(b); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(n - 4, l * 8 >>> 0); dv.setUint32(n - 8, Math.floor(l * 8 / 4294967296));
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]; const w = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let i = 0; i < n; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) { const s0 = r(w[t-15],7)^r(w[t-15],18)^(w[t-15]>>>3), s1 = r(w[t-2],17)^r(w[t-2],19)^(w[t-2]>>>10); w[t] = (w[t-16] + s0 + w[t-7] + s1) >>> 0; }
    let [a,bb,c,d,e,f,g,h] = H;
    for (let t = 0; t < 64; t++) { const S1 = r(e,6)^r(e,11)^r(e,25), ch = (e&f)^(~e&g), t1 = (h + S1 + ch + K[t] + w[t]) >>> 0, S0 = r(a,2)^r(a,13)^r(a,22), mj = (a&bb)^(a&c)^(bb&c), t2 = (S0 + mj) >>> 0; h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=bb; bb=a; a=(t1+t2)>>>0; }
    H = H.map((v, j) => (v + [a,bb,c,d,e,f,g,h][j]) >>> 0);
  }
  return H.map(v => v.toString(16).padStart(8, "0")).join("");
}
const sha256 = async (t) => crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, "0")).join("") : sha256js(t);
window.KAAX = {
  hash: (u, p) => sha256(`${u.trim().toLowerCase()}:${p}`).then(h => (console.log(h), h)),
  /** Hash de la clave de administrador, para comparar con el ID del documento
   *  en Firestore → adminKeys. La clave nunca sale de este navegador. */
  adminHash: (clave) => sha256(String(clave).trim()).then(h => {
    console.log("%cID que debe tener el documento en adminKeys:", "font-weight:bold");
    console.log(h);
    console.log("Largo:", h.length, "(deben ser 64 caracteres hex en minúsculas)");
    return h;
  }),
};

const Auth = {
  user: null, pending: null, poll: null,
  step(id) { $$(".login .step").forEach(e => e.classList.toggle("on", e.id === "st-" + id)); },
  msg(id, t) { $("#" + id).textContent = t || ""; },
  async init() {
    $("#to-up").onclick = (e) => { e.preventDefault(); this.step("up"); };
    $("#to-in").onclick = (e) => { e.preventDefault(); this.step("in"); };
    $("#adm-back").onclick = $("#team-back").onclick = (e) => { e.preventDefault(); this.step("role"); };
    $("#w-out").onclick = (e) => { e.preventDefault(); this.logout(); };
    $("#user-pill").onclick = () => { if (confirm("¿Cerrar sesión de " + (this.user?.name || "") + "?")) this.logout(); };

    if (!KaaxAuth.enabled()) return this.initLocal();

    $("#to-reset").onclick = async (e) => { e.preventDefault(); const m = $("#l-user").value.trim(); if (!m) return this.msg("l-err", "Escribe tu correo primero."); try { await KaaxAuth.reset(m); this.msg("l-err", ""); toast("Te enviamos un correo para restablecerla."); } catch (err) { this.msg("l-err", this.human(err)); } };
    $("#g-in").onclick = $("#g-up").onclick = async () => { try { await KaaxAuth.signInGoogle(); } catch (e) { this.msg("l-err", this.human(e)); } };
    $("#l-go").onclick = async () => { try { this.msg("l-err", "Entrando…"); await KaaxAuth.signInEmail($("#l-user").value.trim(), $("#l-pass").value); } catch (e) { this.msg("l-err", this.human(e)); } };
    $("#l-pass").onkeydown = (e) => { if (e.key === "Enter") $("#l-go").click(); };
    $("#u-go").onclick = async () => { const n = $("#u-name").value.trim(); if (!n) return this.msg("u-err", "Falta tu nombre."); try { this.msg("u-err", "Creando…"); sessionStorage.setItem("kaax.pendingName", n); await KaaxAuth.signUpEmail($("#u-mail").value.trim(), $("#u-pass").value); } catch (e) { this.msg("u-err", this.human(e)); } };
    $("#u-pass").onkeydown = (e) => { if (e.key === "Enter") $("#u-go").click(); };
    $("#pick-tec").onclick = async () => { this.step("team"); const ts = await KaaxAuth.listTeams(); $("#t-team").innerHTML = ts.length ? ts.map(t => `<option value="${t.id}">${t.name}</option>`).join("") : `<option value="">— aún no hay equipos —</option>`; };
    $("#pick-adm").onclick = () => this.step("adm");
    $("#a-go").onclick = async () => { const k = $("#a-secret").value.trim(); if (!k) return this.msg("a-err", "Falta la clave secreta."); try { this.msg("a-err", "Creando equipo…"); await KaaxAuth.createProfile({ name: this.pendingName(), role: "admin", adminKey: k, teamName: $("#a-team").value.trim() }); } catch (e) {
      // No enmascarar el error: "clave incorrecta" para cualquier fallo hace
      // imposible distinguir un hash que no coincide de un problema de reglas,
      // de red o de dominios autorizados.
      console.error("createProfile(admin) falló:", e);
      const c = String(e?.code || e?.message || e);
      this.msg("a-err", c.includes("permission-denied")
        ? "La clave no coincide con ninguna en adminKeys. El ID del documento en Firestore debe ser el SHA-256 de la clave, en minúsculas."
        : this.human(e));
    } };
    $("#t-go").onclick = async () => { const t = $("#t-team").value; if (!t) return this.msg("t-err", "No hay equipos todavía. Pide a tu administrador que cree uno."); try { await KaaxAuth.createProfile({ name: this.pendingName(), role: "tecnico", requestedTeamId: t }); } catch (e) { this.msg("t-err", this.human(e)); } };
    $("#w-check").onclick = () => location.reload();

    KaaxAuth.on((u, p) => this.onState(u, p));
    await KaaxAuth.init();
  },
  pendingName() { return sessionStorage.getItem("kaax.pendingName") || KaaxAuth.user?.displayName || KaaxAuth.user?.email || "Operador"; },
  onState(u, p) {
    if (!u) { $("#login").classList.add("show"); this.step("in"); clearInterval(this.poll); return; }
    if (!p) { $("#login").classList.add("show"); this.step("role"); $("#role-who").textContent = "Sesión iniciada como " + u.email; return; }
    if (p.status === "pendiente") {
      $("#login").classList.add("show"); this.step("wait");
      $("#w-msg").textContent = "Tu solicitud está esperando aprobación del administrador. Esta pantalla se actualiza sola.";
      clearInterval(this.poll); this.poll = setInterval(() => location.reload(), 20000); return;
    }
    if (p.status === "rechazado") { $("#login").classList.add("show"); this.step("wait"); $("#w-msg").textContent = "Tu solicitud fue rechazada. Habla con tu administrador."; return; }
    this.enter({ name: p.name, role: p.role, teamId: p.teamId });
  },
  enter(u) {
    this.user = u; clearInterval(this.poll);
    $("#user-lbl").textContent = u.name + (u.role === "admin" ? " · admin" : "");
    if (!$("#s-ops").value) $("#s-ops").value = u.name;
    $("#tab-equipo").style.display = u.role === "admin" ? "" : "none";
    $("#login").classList.remove("show");
    setTimeout(() => { mapFleet.invalidateSize(); mapGrid.invalidateSize(); }, 60);
    Team.init(); Reports.syncDown();
  },
  async logout() { sessionStorage.clear(); if (KaaxAuth.enabled()) await KaaxAuth.signOut(); location.reload(); },
  human(e) {
    const c = String(e?.code || e?.message || e);
    if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Correo o contraseña incorrectos.";
    if (c.includes("email-already-in-use")) return "Ese correo ya tiene cuenta. Entra en vez de registrarte.";
    if (c.includes("weak-password")) return "La contraseña necesita al menos 6 caracteres.";
    if (c.includes("invalid-email")) return "Ese correo no es válido.";
    if (c.includes("popup-closed")) return "Cerraste la ventana de Google antes de terminar.";
    if (c.includes("network")) return "Sin conexión con Firebase. Revisa tu internet.";
    return "No se pudo completar: " + c;
  },
  // modo local (sin Firebase): lista de config.users
  initLocal() {
    $("#to-up").onclick = (e) => { e.preventDefault(); this.msg("l-err", "Crear cuentas requiere Firebase. Pega tu configuración en config.js."); };
    $("#g-in").onclick = $("#g-up").onclick = () => this.msg("l-err", "Entrar con Google requiere Firebase. Pega tu configuración en config.js.");
    const go = async () => {
      const uname = $("#l-user").value.trim().toLowerCase(), pass = $("#l-pass").value;
      const rec = (CFG.users || []).find(x => x.user === uname);
      if (!rec || (await sha256(`${uname}:${pass}`)) !== rec.hash) { this.msg("l-err", "Usuario o contraseña incorrectos."); $("#l-pass").value = ""; return; }
      sessionStorage.setItem("kaax.user", JSON.stringify({ name: rec.name, role: "admin" }));
      this.enter({ name: rec.name, role: "admin" });
    };
    $("#l-go").onclick = go; $("#l-pass").onkeydown = (e) => { if (e.key === "Enter") go(); };
    const saved = sessionStorage.getItem("kaax.user");
    if (saved) this.enter(JSON.parse(saved)); else { $("#login").classList.add("show"); this.step("in"); }
  },
};

// ---------- equipo (vista admin) ---------------------------------------------
const Team = {
  async init() {
    if (!KaaxAuth.enabled() || Auth.user?.role !== "admin") return;
    $("#tm-refresh").onclick = () => this.load();
    $("#tm-rename").onclick = async () => { await KaaxAuth.renameTeam($("#tm-name").value.trim()); toast("Equipo renombrado"); this.load(); };
    this.load();
  },
  async load() {
    const name = await KaaxAuth.teamName(); $("#team-title").textContent = name || "Equipo"; $("#tm-name").value = name;
    const { pending, active } = await KaaxAuth.teamMembers();
    $("#tm-pending").innerHTML = pending.length ? pending.map(m => `<div class="memrow"><div class="who"><b>${m.name}</b><span>${m.email}</span></div><div style="display:flex;gap:6px"><button class="btn sm primary" data-ok="${m.uid}">Aceptar</button><button class="btn sm" data-no="${m.uid}">Rechazar</button></div></div>`).join("") : `<div class="empty">Nadie está esperando aprobación.</div>`;
    $("#tm-active").innerHTML = active.length ? active.map(m => `<div class="memrow"><div class="who"><b>${m.name}</b><span>${m.email} · ${m.role}</span></div>${m.role === "admin" ? "" : `<button class="btn sm" data-rm="${m.uid}">Quitar</button>`}</div>`).join("") : `<div class="empty">Aún no hay técnicos activos.</div>`;
    $$("[data-ok]").forEach(b => b.onclick = async () => { await KaaxAuth.approve(b.dataset.ok); toast("Técnico aceptado"); this.load(); });
    $$("[data-no]").forEach(b => b.onclick = async () => { await KaaxAuth.reject(b.dataset.no); this.load(); });
    $$("[data-rm]").forEach(b => b.onclick = async () => { if (confirm("¿Quitar a esta persona del equipo?")) { await KaaxAuth.removeMember(b.dataset.rm); this.load(); } });
  },
};

// ---------- cámara + visión ---------------------------------------------------
const Vision = {
  on: false, camOn: false, model: null, timer: null, hits: 0, canvas: null,
  init() {
    $("#cam-toggle").onclick = () => this.toggleCam();
    $("#cv-toggle").onclick = () => this.toggleCV();
    $("#cam-snap").onclick = () => this.snap();
    $("#gps-check").onclick = () => this.gps();
    $("#cv-model").textContent = S.modelUrl ? "listo para cargar" : "sin configurar";
  },
  toggleCam() {
    this.camOn = !this.camOn;
    const img = $("#cam");
    if (this.camOn) {
      img.src = KaaxPi.Url.cam() + "?t=" + Date.now();
      img.style.display = "block"; $("#cam-off").style.display = "none"; $("#cam-state").textContent = "encendida";
      img.onerror = () => { $("#cam-off").textContent = "No se pudo abrir el video en " + KaaxPi.Url.cam() + ". Revisa que la Pi esté encendida, que la URL en Ajustes sea correcta y que la CA esté instalada en este equipo."; $("#cam-off").style.display = "block"; img.style.display = "none"; $("#cam-state").textContent = "sin señal"; this.camOn = false; $("#cam-toggle").textContent = "Encender cámara"; };
    } else { img.src = ""; img.style.display = "none"; $("#cam-off").style.display = "block"; $("#cam-off").textContent = "Cámara apagada. Enciéndela para ver el video de la Pi."; $("#cam-state").textContent = "apagada"; if (this.on) this.toggleCV(); }
    $("#cam-toggle").textContent = this.camOn ? "Apagar cámara" : "Encender cámara";
  },
  /** tfjs y Teachable Machine solo se bajan cuando se usan; quedan en caché. */
  loadLibs() {
    if (window.tmImage) return Promise.resolve();
    if (this._libs) return this._libs;
    const one = (src) => new Promise((res, rej) => {
      const t = document.createElement("script");
      t.src = src; t.onload = res;
      t.onerror = () => rej(new Error("No se pudo descargar la librería de visión. Necesitas internet la primera vez."));
      document.head.appendChild(t);
    });
    return this._libs = one("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js")
      .then(() => one("https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8/dist/teachablemachine-image.min.js"));
  },
  async toggleCV() {
    if (this.on) { this.on = false; clearInterval(this.timer); $("#cvbar").style.display = "none"; $("#cv-toggle").textContent = "Activar visión"; return; }
    if (!S.modelUrl) { toast("Pega la URL del modelo de Teachable Machine en Ajustes."); return; }
    if (!this.camOn) this.toggleCam();
    $("#cv-toggle").textContent = "Cargando modelo…"; $("#cv-model").textContent = "cargando…";
    try {
      await this.loadLibs();
      if (!this.model) this.model = await tmImage.load(S.modelUrl + "model.json", S.modelUrl + "metadata.json");
      this.on = true; $("#cvbar").style.display = "block"; $("#cv-toggle").textContent = "Desactivar visión";
      $("#cv-model").textContent = this.model.getTotalClasses() + " clases";
      this.canvas = document.createElement("canvas"); this.canvas.width = 224; this.canvas.height = 224;
      this.timer = setInterval(() => this.tick(), Math.round(1000 / (CFG.camera.fps || 4)));
    } catch (e) {
      $("#cv-toggle").textContent = "Activar visión"; $("#cv-model").textContent = "error";
      toast("No se pudo cargar el modelo. Revisa la URL (debe terminar en /).");
    }
  },
  async tick() {
    const img = $("#cam"); if (!img.naturalWidth) return;
    try {
      const ctx = this.canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
      const preds = (await this.model.predict(this.canvas)).sort((a, b) => b.probability - a.probability);
      $("#cv-rows").innerHTML = preds.slice(0, 4).map(p => { const pct = p.probability * 100, hit = p.probability >= S.cvth; return `<div class="cvrow"><span>${p.className}</span><span class="meter"><i class="${hit ? "hit" : ""}" style="width:${pct.toFixed(0)}%"></i></span><span class="p">${pct.toFixed(0)}%</span></div>`; }).join("");
      const top = preds[0];
      if (top.probability >= S.cvth) { this.hits++; $("#cv-count").textContent = this.hits; Session.onDetection(top.className, top.probability); }
    } catch (e) { /* frame taint or decode issue: skip */ }
  },
  snap() {
    const img = $("#cam"); if (!img.naturalWidth) return toast("No hay video para capturar.");
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    try { c.toBlob(b => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "kaax_" + Date.now() + ".jpg"; a.click(); }, "image/jpeg", .92); }
    catch { toast("El navegador bloqueó la captura (CORS). Revisa que la Pi envíe el encabezado Access-Control-Allow-Origin."); }
  },
  async gps() {
    const out = $("#gps-out"), badge = $("#gps-badge");
    const base = KaaxPi.Url.base();
    out.textContent = "Consultando " + base + "/api/gps …";
    try {
      const d = await KaaxPi.piFetch("gps");
      badge.className = "badge " + (d.fix ? "ok" : "");
      badge.textContent = d.fix ? `fix ${d.satellites} satélites` : (d.port_open ? "sin fix" : "sin puerto");
      out.textContent = [
        "Puerto      : " + d.port + (d.port_open ? " (abierto)" : " (NO SE PUDO ABRIR)"),
        "Bytes leídos: " + d.bytes,
        "Fix         : " + (d.fix ? "sí" : "no"),
        "Satélites   : " + d.satellites,
        "Posición    : " + (d.fix ? d.lat.toFixed(6) + ", " + d.lon.toFixed(6) : "—"),
        "", "Tramas NMEA crudas:", ...(d.raw || ["(ninguna — revisa el cableado TX/RX cruzado y que el GPS tenga vista al cielo)"]),
      ].join("\n");
      if (d.fix) { recenter(d.lat, d.lon); Grid.build(); toast("GPS verificado. Mapa centrado en la posición real."); }
    } catch (e) { badge.className = "badge"; badge.textContent = "sin respuesta"; out.textContent = "No hubo respuesta de " + base + "/api/gps\nRevisa que pi_robot.py esté corriendo y que la URL de la cámara en Ajustes apunte a la Pi."; }
  },
};

// ---------- control Xbox (Gamepad API) ------------------------------------------
const Pad = {
  idx: null, prev: {}, raf: null,
  init() {
    window.addEventListener("gamepadconnected", (e) => { this.idx = e.gamepad.index; $("#pad-badge").className = "badge ok"; $("#pad-badge").textContent = "control conectado"; toast("Control detectado: " + e.gamepad.id.slice(0, 28)); this.loop(); });
    window.addEventListener("gamepaddisconnected", () => { this.idx = null; $("#pad-badge").className = "badge"; $("#pad-badge").textContent = "sin control"; });
  },
  /** Cruz del control: ▲▼ ajustan el rodillo derecho y ◀▶ el izquierdo.
   *  Un toque mueve un escalón; mantener pulsado repite, con una pausa inicial
   *  para no dispararse a 60 pasos por segundo. */
  dpad(g) {
    // Mapeo estándar: 12 arriba, 13 abajo, 14 izquierda, 15 derecha.
    if (g.buttons.length < 16) {
      if (!this._warned) { this._warned = true; log("Este control no expone la cruz en el mapeo estándar; usa los botones +/− de la pantalla.", "err"); }
      return;
    }
    const MAP = { 12: ["R", 1], 13: ["R", -1], 14: ["L", -1], 15: ["L", 1] };
    const now = performance.now();
    this.rep = this.rep || {};
    for (const idx of Object.keys(MAP)) {
      const [which, dir] = MAP[idx];
      const st = this.rep[idx] || (this.rep[idx] = { held: false, next: 0 });
      if (g.buttons[idx]?.pressed) {
        if (!st.held) { st.held = true; st.next = now + 320; Rollers.nudge(which, dir); }
        else if (now >= st.next) { st.next = now + 90; Rollers.nudge(which, dir); }
      } else { st.held = false; }
    }
  },
  loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      this.raf = requestAnimationFrame(step);
      if (this.idx === null || !S.usePad) return;
      const g = navigator.getGamepads()[this.idx]; if (!g) return;
      const dz = (v) => Math.abs(v) < 0.15 ? 0 : v;
      const fwd = (g.buttons[7]?.value || 0) - (g.buttons[6]?.value || 0);   // RT - LT
      const turn = dz(g.axes[0] || 0);
      const N = CFG.motor.neutral, A = CFG.motor.span;
      let R = N + (fwd - turn) * A, L = N + (fwd + turn) * A;
      R = Math.round(Math.max(N - A, Math.min(N + A, R))); L = Math.round(Math.max(N - A, Math.min(N + A, L)));
      const cmd = `CMD,${Control.target},${R},${L}`;
      if (cmd !== Control.last) { Control.last = cmd; send(cmd); }
      const press = (i) => { const d = g.buttons[i]?.pressed && !this.prev[i]; this.prev[i] = g.buttons[i]?.pressed; return d; };
      if (press(0)) Rollers.toggle();
      this.dpad(g);
      if (press(1)) Control.estop();
      const next = press(5), prev = press(4);
      if (next || prev) { const ids = ["00", ...CFG.robots.map(r => r.id)]; const i = ids.indexOf(Control.target); Control.setTarget(ids[(i + (next ? 1 : ids.length - 1)) % ids.length]); }
    };
    step();
  },
};

// ---------- modo campo (offline) ---------------------------------------------------
// Tres cosas a la vez: la app abre sin internet (service worker), lo capturado
// se encola en Firestore, y la Pi se administra desde aquí.
const Field = {
  init() {
    $("#btn-offline").onclick = () => this.toggle();
    $("#fb-online").onclick = () => this.back();
    KaaxPi.onChange((st) => this.paint(st));
    // Si el navegador pierde la red por su cuenta, entrar en modo campo solo:
    // es exactamente el momento en que hace falta y nadie va a pulsar nada.
    window.addEventListener("offline", () => { if (!KaaxPi.state.offline) this.toggle(true); });
    document.addEventListener("kaax:update", () => toast("Hay una versión nueva. Recarga la página cuando puedas."));
    KaaxPi.offlineReady().then(r => { if (r) log("App lista para abrirse sin internet.", "sys"); });
  },
  paint(st) {
    const b = $("#btn-offline");
    b.classList.toggle("on", st.offline);
    b.textContent = st.offline ? "Modo campo" : "Modo campo";
    document.body.classList.toggle("field", st.offline);
    $("#fieldbar").classList.toggle("show", st.offline);
    const q = KaaxAuth.pendingCount ? KaaxAuth.pendingCount() : 0;
    $("#fieldbar-txt").textContent = st.offline
      ? (q ? `Modo campo · ${q} sesión${q === 1 ? "" : "es"} esperando subir`
           : "Modo campo · lo que captures se guarda aquí y se sube al volver")
      : "";
  },
  async toggle(force) {
    const on = force !== undefined ? force : !KaaxPi.state.offline;
    await KaaxPi.setOffline(on);
    log(on ? "Modo campo activado: Firestore desconectado a propósito." : "Modo campo desactivado.", "sys");
    if (on) toast("Modo campo. La app ya no espera a internet.");
  },
  async back() {
    try {
      const n = await KaaxPi.goOnline();
      toast(n ? `De vuelta en línea. ${n} sesión${n === 1 ? "" : "es"} sincronizada${n === 1 ? "" : "s"}.` : "De vuelta en línea.");
      log(`Sincronización completa (${n}).`, "sys");
      Reports.render();
    } catch (e) { toast(e.message); log(e.message, "err"); }
  },
};

// ---------- administración de la Raspberry -----------------------------------------
const PiPanel = {
  loaded: false,
  init() {
    $("#pi-refresh").onclick = () => this.status();
    $("#pi-logs").onclick = () => this.logs();
    $("#pi-scan").onclick = () => this.scan();
    $("#pi-hotspot").onclick = () => this.act("volver al hotspot", () => KaaxPi.Pi.goHotspot());
    $("#pi-restart").onclick = () => this.act("reiniciar el servicio", () => KaaxPi.Pi.restart());
    $("#pi-update").onclick = () => this.act("actualizar desde GitHub", () => KaaxPi.Pi.update());
    $("#pi-reboot").onclick = () => this.act("REINICIAR la Pi", () => KaaxPi.Pi.reboot(), true);
    $("#pi-shutdown").onclick = () => this.act("APAGAR la Pi", () => KaaxPi.Pi.shutdown(), true);
    $("#pi-stay").onclick = () => this.act("quedarte en esta red", () => KaaxPi.Pi.action("cancel_revert"));
    $("#pi-join").onclick = () => this.join();
    $("#tiles-dl").onclick = () => this.tiles();
    $("#tiles-clear").onclick = async () => { await KaaxPi.clearTiles(); this.tileBadge(); toast("Teselas borradas."); };
    this.tileBadge();
  },
  async load() { if (!this.loaded) { this.loaded = true; this.status(); } },

  async status() {
    const badge = $("#pi-badge");
    badge.className = "badge"; badge.textContent = "consultando…";
    try {
      const d = await KaaxPi.Pi.status();
      badge.className = "badge ok"; badge.textContent = "en línea";
      const up = (s) => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min`; };
      const rows = [
        ["Robot", d.robot_id, ""], ["Servicio", d.service, ""],
        ["Encendida", up(d.uptime_s), ""], ["Temperatura", d.temp_c ?? "—", "°C"],
        ["Disco libre", d.disk_free_gb, "GB"], ["GUIs conectadas", d.clients, ""],
        ["GPS", d.gps.fix ? `fix · ${d.gps.satellites} sat` : (d.gps.port ? "sin fix" : "sin puerto"), ""],
        ["TLS", d.tls ? "activo" : "APAGADO", ""],
      ];
      $("#pi-kpis").innerHTML = rows.map(([l, n, u]) => `<div class="kpi"><div class="l">${l}</div><div class="n">${n}<span class="u">${u}</span></div></div>`).join("");
      $("#pi-net").textContent =
        `modo: ${d.network.mode}   red: ${d.network.ssid || "—"}\nIPs: ${(d.ips || []).join("  ") || "—"}` +
        (d.revert_armed ? "\n⚠ regreso automático al hotspot armado — pulsa «Quedarme en esta red» si esta red te sirve" : "");
      if (!d.tls) log("La Pi corre sin TLS: desde https solo funcionará la simulación.", "err");
    } catch (e) {
      badge.className = "badge"; badge.textContent = "sin respuesta";
      $("#pi-kpis").innerHTML = `<div class="empty">${e.message}</div>`;
    }
  },

  async logs() {
    const out = $("#pi-log-out"); out.textContent = "leyendo…";
    try { const d = await KaaxPi.Pi.logs(60); out.textContent = (d.lines || []).join("\n") || "(sin líneas)"; out.scrollTop = out.scrollHeight; }
    catch (e) { out.textContent = e.message; }
  },

  async scan() {
    const sel = $("#pi-ssid"); $("#pi-wifi").style.display = "block";
    sel.innerHTML = `<option>buscando…</option>`;
    try {
      const d = await KaaxPi.Pi.wifiScan();
      sel.innerHTML = (d.networks || []).map(n => `<option value="${n.ssid}">${n.ssid} · ${n.signal}%${n.security ? " · " + n.security : " · abierta"}</option>`).join("") || `<option>(ninguna)</option>`;
    } catch (e) { sel.innerHTML = `<option>${e.message}</option>`; toast(e.message); }
  },

  async join() {
    const ssid = $("#pi-ssid").value, mins = +$("#pi-revert").value || 5;
    if (!ssid) return toast("Elige una red.");
    if (!confirm(`La Pi se pasará a «${ssid}». Perderás el hotspot y tendrás que buscarla en esa red.\n\nSi algo sale mal vuelve sola al hotspot en ${mins} min. ¿Continuar?`)) return;
    try {
      const d = await KaaxPi.Pi.goOnline(ssid, $("#pi-psk").value, mins);
      toast(d.ok ? "La Pi se está pasando a esa red." : "No lo logró: " + (d.detail || ""));
      log("wifi_client → " + ssid + " · " + (d.detail || ""), d.ok ? "sys" : "err");
      setTimeout(() => this.status(), 6000);
    } catch (e) { toast(e.message); }
  },

  async act(label, fn, hard = false) {
    if (!confirm(`¿Seguro que quieres ${label}?`)) return;
    if (hard && !confirm(`Confirmación final: ${label}. Esto corta la conexión con el robot.`)) return;
    try { const d = await fn(); toast(d.detail || (d.ok ? "Hecho." : "No se pudo.")); log(`${label}: ${d.detail || d.ok}`, d.ok ? "sys" : "err"); setTimeout(() => this.status(), 3000); }
    catch (e) { toast(e.message); log(`${label}: ${e.message}`, "err"); }
  },

  async tileBadge() {
    const n = await KaaxPi.tileCacheSize();
    $("#tiles-badge").textContent = n ? `${n} teselas guardadas` : "sin teselas guardadas";
    $("#tiles-badge").className = "badge" + (n ? " ok" : "");
  },

  async tiles() {
    // La zona sale de la cuadrícula de trabajo (centro + cols/filas × lado),
    // no de lo que se vea en pantalla: si nunca abriste la pestaña Cuadrícula
    // el mapa mide 0 px y bajaríamos cuatro teselas inútiles.
    const g = S.grid, margin = 3;          // 3× la cuadrícula, para tener orilla
    const dLat = g.cellMeters * g.rows * margin / 2 / mPerDegLat;
    const dLon = g.cellMeters * g.cols * margin / 2 / mPerDegLon(S.lat);
    const bounds = { north: S.lat + dLat, south: S.lat - dLat, east: S.lon + dLon, west: S.lon - dLon };
    if (!confirm(`Se descargará la zona alrededor de ${S.lat.toFixed(4)}, ${S.lon.toFixed(4)} `
      + `(unos ${Math.round(g.cellMeters * g.cols * margin)} × ${Math.round(g.cellMeters * g.rows * margin)} m), zoom 13 a 18.\n\n`
      + `Si no es tu zona de trabajo, ajústala primero en Cuadrícula → Centrar aquí. ¿Continuar?`)) return;
    const bar = $("#tiles-bar"), fill = bar.querySelector("i");
    bar.style.display = "block"; fill.style.width = "0%";
    $("#tiles-dl").disabled = true;
    try {
      const r = await KaaxPi.downloadTiles(bounds, {
        onProgress: (d, t) => { fill.style.width = (d / t * 100).toFixed(0) + "%"; $("#tiles-badge").textContent = `${d} / ${t}`; },
      });
      toast(r.failed ? `Descargadas con ${r.failed} fallos de ${r.total}.` : `Zona lista sin internet (${r.total} teselas).`);
    } catch (e) { toast(e.message); }
    finally { $("#tiles-dl").disabled = false; setTimeout(() => { bar.style.display = "none"; this.tileBadge(); }, 800); }
  },
};

// ---------- router -----------------------------------------------------------------
function route() {
  const h = (location.hash || "#/flota").replace("#/", "");
  const ok = ["flota", "camara", "cuadricula", "sesion", "reportes", "raspberry", "equipo", "ajustes"].includes(h) ? h : "flota";
  $$(".view").forEach(v => v.classList.toggle("show", v.id === "v-" + ok));
  $$("#tabs a").forEach(a => a.classList.toggle("active", a.getAttribute("href") === "#/" + ok));
  setTimeout(() => { mapFleet.invalidateSize(); mapGrid.invalidateSize(); }, 60);
  if (ok === "reportes") Reports.render();
  if (ok === "equipo") Team.load?.();
  if (ok === "raspberry") PiPanel.load();
}
Vision.init(); Pad.init(); Auth.init(); Field.init(); PiPanel.init();
window.addEventListener("hashchange", route); route();
log("Kaax listo. Elige transporte en Ajustes y pulsa Conectar.", "sys");
})();
