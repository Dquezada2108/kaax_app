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
  transport: "serial", wsUrl: CFG.websocket.url, baud: CFG.serial.baud,
  useGeo: CFG.useBrowserLocation, lat: CFG.zone.lat, lon: CFG.zone.lon,
  swath: CFG.swathMeters, noise: CFG.gpsNoiseMeters,
  aiKey: "", aiModel: CFG.ai.model,
  grid: { ...CFG.grid },
}, LS.get("settings", {}));
const saveSettings = () => LS.set("settings", S);

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
  connect() { return new Promise((res, rej) => { const url = S.wsUrl; this.ws = new WebSocket(url); this.ws.onopen = () => { this.alive = true; res(); }; this.ws.onerror = () => rej(new Error("No se pudo abrir " + url)); this.ws.onclose = () => { if (this.alive) { this.alive = false; setConn(false); log("WebSocket cerrado", "err"); } }; this.ws.onmessage = (e) => String(e.data).split("\n").map(s => s.trim()).filter(Boolean).forEach(onLine); }); },
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
CFG.robots.forEach(r => fleet[r.id] = { ...r, lat: 0, lon: 0, b1: 0, b2: 0, fix: 0, spd: 0, hdg: 0, rssi: null, seen: 0, track: [] });

onLine = (line) => {
  const p = line.split(",");
  if (p[0] === "KAAX" && p.length >= 7) {
    const r = fleet[p[1]]; if (!r) { log("robot desconocido " + p[1], "err"); return; }
    r.lat = +p[2]; r.lon = +p[3]; r.b1 = +p[4]; r.b2 = +p[5]; r.fix = +p[6]; r.spd = +(p[7] || 0); r.hdg = +(p[8] || 0);
    r.rssi = p.length >= 10 ? +p[9] : null; r.seen = Date.now();
    if (r.fix && r.lat && r.lon) { const pt = { lat: r.lat, lon: r.lon, t: r.seen, spd: r.spd }; const last = r.track[r.track.length - 1]; if (!last || haversine(last, pt) >= S.noise) { r.track.push(pt); if (r.track.length > 3000) r.track.shift(); } Session.onFix(r, pt); Grid.markVisited(r.lat, r.lon); }
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
        <span class="k">Bat. 1</span><span class="v">${fmt(r.b1, 2)} V</span>
        <span class="k">Bat. 2</span><span class="v">${fmt(r.b2, 2)} V</span>
        <span class="k">Señal</span><span class="v">${r.rssi === null ? "—" : r.rssi + " dBm"}</span>
      </div>
      <div class="bat"><i class="${battClass(r.b1)}" style="width:${battPct(r.b1)}%"></i></div>
      <div class="bat" style="margin-top:3px"><i class="${battClass(r.b2)}" style="width:${battPct(r.b2)}%"></i></div>
    </div>`; }).join("");
  $$("#robots .robot").forEach(el => el.onclick = () => { Control.setTarget(el.dataset.id); });
}
setInterval(renderRobots, 1000);

// ---------- maps ---------------------------------------------------------
const tiles = () => L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
const mapFleet = L.map("map-fleet", { zoomControl: true }).setView([S.lat, S.lon], 17); tiles().addTo(mapFleet);
const mapGrid = L.map("map-grid").setView([S.lat, S.lon], 17); tiles().addTo(mapGrid);
const markers = {}, lines = {};
function updateMarkers() {
  for (const r of Object.values(fleet)) {
    if (!r.fix || !r.lat) continue;
    const ll = [r.lat, r.lon];
    if (!markers[r.id]) { markers[r.id] = L.marker(ll, { icon: L.divIcon({ className: "", html: `<div class="rl" style="background:${r.color}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(mapFleet).bindTooltip(r.name, { permanent: true, direction: "right", offset: [10, 0], className: "mono" }); lines[r.id] = L.polyline([], { color: r.color, weight: 3, opacity: .7 }).addTo(mapFleet); }
    markers[r.id].setLatLng(ll);
    lines[r.id].setLatLngs(r.track.map(p => [p.lat, p.lon]));
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
$("#g-center").onclick = () => { const c = mapGrid.getCenter(); recenter(c.lat, c.lng); saveSettings(); Grid.build(); loadWeather(); };
$("#g-reset").onclick = () => Grid.reset();
Grid.build();

// ---------- control --------------------------------------------------------
const Control = {
  target: CFG.robots[0].id, keys: {}, thr: .6, last: "", ka: null,
  init() {
    const sel = $("#target"); sel.innerHTML = `<option value="00">Todos</option>` + CFG.robots.map(r => `<option value="${r.id}">${r.name}</option>`).join(""); sel.value = this.target;
    sel.onchange = () => { this.target = sel.value; renderRobots(); };
    $("#thr").oninput = (e) => { this.thr = e.target.value / 100; $("#thr-lbl").textContent = e.target.value + " %"; this.calc(); };
    $("#net").onchange = (e) => send(`NET,${this.target},${e.target.checked ? 1 : 0}`);
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
  estop() { this.keys = {}; this.last = ""; $$(".dpad button").forEach(b => b.classList.remove("on")); send(`STOP,00`); toast("Paro de emergencia enviado a toda la flota"); },
};
Control.init();

// ---------- session ----------------------------------------------------------
const Session = {
  cur: null, tick: null,
  init() {
    $("#s-weights").innerHTML = CFG.contaminants.map(c => `<div class="field"><span>${c.label}</span><input type="number" min="0" step="0.1" data-w="${c.key}" placeholder="0.0"></div>`).join("");
    $("#s-start").onclick = () => this.start(); $("#s-stop").onclick = () => this.stop();
    const c = LS.get("current", null); if (c) { this.cur = c; this.arm(); toast("Sesión anterior recuperada"); }
  },
  start() {
    this.cur = { id: Date.now(), start: Date.now(), end: null, site: $("#s-site").value, ops: $("#s-ops").value, robots: {}, cellsStart: Grid.counts().clean, gridKey: Grid.key };
    CFG.robots.forEach(r => this.cur.robots[r.id] = { name: r.name, dist: 0, spdSum: 0, spdN: 0, spdMax: 0, battMin: null, last: null, samples: 0 });
    this.arm(); LS.set("current", this.cur); toast("Sesión iniciada");
  },
  arm() { $("#s-start").disabled = true; $("#s-stop").disabled = false; $("#s-state").textContent = "Sesión en curso desde " + new Date(this.cur.start).toLocaleTimeString("es-MX"); $("#s-site").value = this.cur.site || ""; $("#s-ops").value = this.cur.ops || ""; this.tick = setInterval(() => this.render(), 1000); this.render(); },
  onFix(r, pt) { if (!this.cur) return; const s = this.cur.robots[r.id]; if (!s) return; if (s.last) s.dist += haversine(s.last, pt); s.last = pt; },
  onTelemetry(r) { if (!this.cur) return; const s = this.cur.robots[r.id]; if (!s) return; s.samples++; if (r.spd > 0.2) { s.spdSum += r.spd; s.spdN++; s.spdMax = Math.max(s.spdMax, r.spd); } const bm = Math.min(r.b1 || 99, r.b2 || 99); if (bm < 99) s.battMin = s.battMin === null ? bm : Math.min(s.battMin, bm); if (this.cur.robots) LS.set("current", this.cur); },
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
    clearInterval(this.tick); this.cur = null;
    $("#s-start").disabled = false; $("#s-stop").disabled = true; $("#s-state").textContent = "Sesión guardada. Revisa Reportes."; $("#s-timer").textContent = "00:00:00"; $("#s-notes").value = ""; $$("#s-weights input").forEach(i => i.value = "");
    Reports.render(); toast("Sesión guardada"); location.hash = "#/reportes";
  },
};
Session.init();

// ---------- reports -----------------------------------------------------------
const Reports = {
  chart: null,
  all: () => LS.get("sessions", []),
  totalKg: (s) => Object.values(s.weights || {}).reduce((a, b) => a + b, 0),
  render() {
    const all = this.all();
    const tot = { n: all.length, kg: 0, dist: 0, dur: 0, area: 0, cells: 0 };
    all.forEach(s => { tot.kg += this.totalKg(s); tot.dist += s.stats.dist; tot.dur += s.stats.dur; tot.area += s.stats.swept; tot.cells += s.stats.cells; });
    const kgh = tot.dur ? tot.kg / (tot.dur / 3600) : 0;
    $("#r-kpis").innerHTML = [["Sesiones", tot.n, ""], ["Material retirado", fmt(tot.kg, 1), "kg"], ["Distancia", fmt(tot.dist / 1000, 2), "km"], ["Tiempo", hms(tot.dur * 1000), ""], ["Área barrida", fmt(tot.area), "m²"], ["Ritmo", fmt(kgh, 2), "kg/h"]].map(([l, n, u]) => `<div class="kpi"><div class="l">${l}</div><div class="n">${n}<span class="u">${u}</span></div></div>`).join("");
    if (!all.length) { $("#r-table").innerHTML = `<div class="empty">Aún no hay sesiones. Inicia una en la pestaña Sesión.</div>`; this.chart?.destroy(); this.chart = null; return; }
    $("#r-table").innerHTML = `<table><thead><tr><th>Fecha</th><th>Lugar</th><th class="num">Duración</th><th class="num">m</th><th class="num">km/h</th><th class="num">m²</th>${CFG.contaminants.map(c => `<th class="num">${c.label} kg</th>`).join("")}<th></th></tr></thead><tbody>` +
      all.slice().reverse().map(s => `<tr><td>${new Date(s.start).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" })}</td><td>${s.site || "—"}</td><td class="num">${hms(s.stats.dur * 1000)}</td><td class="num">${fmt(s.stats.dist)}</td><td class="num">${fmt(s.stats.avg, 1)}</td><td class="num">${fmt(s.stats.swept)}</td>${CFG.contaminants.map(c => `<td class="num">${fmt(s.weights?.[c.key] || 0, 1)}</td>`).join("")}<td><button class="btn sm ghost" data-del="${s.id}">borrar</button></td></tr>`).join("") + `</tbody></table>`;
    $$("[data-del]").forEach(b => b.onclick = () => { if (confirm("¿Borrar esta sesión?")) { LS.set("sessions", all.filter(s => s.id !== +b.dataset.del)); this.render(); } });
    const labels = all.map(s => new Date(s.start).toLocaleDateString("es-MX", { day: "2-digit", month: "short" }));
    const ds = CFG.contaminants.map((c, i) => ({ label: c.label, data: all.map(s => s.weights?.[c.key] || 0), backgroundColor: ["#0077b6", "#00b4d8", "#2a9d8f"][i % 3], stack: "kg" }));
    ds.push({ label: "Área barrida (m²)", data: all.map(s => s.stats.swept), type: "line", borderColor: "#f4a261", backgroundColor: "#f4a261", yAxisID: "y2", tension: .3 });
    this.chart?.destroy();
    this.chart = new Chart($("#r-chart"), { data: { labels, datasets: ds }, type: "bar", options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { stacked: true, title: { display: true, text: "kg" } }, y2: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "m²" } } }, font: { family: "Space Grotesk" } } });
  },
  csv() {
    const all = this.all(); const cols = ["fecha", "lugar", "operadores", "duracion_s", "distancia_m", "vel_media_kmh", "area_barrida_m2", "cuadrantes", ...CFG.contaminants.map(c => c.key + "_kg"), "notas"];
    const rows = all.map(s => [new Date(s.start).toISOString(), s.site, s.ops, Math.round(s.stats.dur), Math.round(s.stats.dist), s.stats.avg.toFixed(2), Math.round(s.stats.swept), s.stats.cells, ...CFG.contaminants.map(c => s.weights?.[c.key] || 0), (s.notes || "").replace(/\n/g, " ")]);
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
const A = { transport: "a-transport", wsUrl: "a-ws", baud: "a-baud", lat: "a-lat", lon: "a-lon", swath: "a-swath", noise: "a-noise", aiKey: "a-key", aiModel: "a-model" };
function loadSettingsForm() { for (const [k, id] of Object.entries(A)) $("#" + id).value = S[k]; $("#a-geo").checked = S.useGeo; }
$("#a-save").onclick = () => { for (const [k, id] of Object.entries(A)) { const el = $("#" + id); S[k] = el.type === "number" ? +el.value : el.value; } S.useGeo = $("#a-geo").checked; saveSettings(); recenter(S.lat, S.lon); Grid.build(); loadWeather(); toast("Ajustes guardados"); };
$("#a-wipe").onclick = () => { if (confirm("Se borrarán sesiones, cuadrículas y ajustes de este navegador.")) { Object.keys(localStorage).filter(k => k.startsWith("kaax.")).forEach(k => localStorage.removeItem(k)); location.reload(); } };
loadSettingsForm();

// ---------- router -----------------------------------------------------------------
function route() {
  const h = (location.hash || "#/flota").replace("#/", "");
  const ok = ["flota", "cuadricula", "sesion", "reportes", "ajustes"].includes(h) ? h : "flota";
  $$(".view").forEach(v => v.classList.toggle("show", v.id === "v-" + ok));
  $$("#tabs a").forEach(a => a.classList.toggle("active", a.getAttribute("href") === "#/" + ok));
  setTimeout(() => { mapFleet.invalidateSize(); mapGrid.invalidateSize(); }, 60);
  if (ok === "reportes") Reports.render();
}
window.addEventListener("hashchange", route); route();
log("Kaax listo. Elige transporte en Ajustes y pulsa Conectar.", "sys");
})();
