/* KAAX — modo campo (offline) y administración de la Raspberry.
 *
 * El problema que resuelve este archivo:
 *   La GUI vive en GitHub Pages (https). La Pi vive en su propio hotspot, sin
 *   internet. Chrome bloquea https -> ws:// y https -> http://, sin aviso y sin
 *   forma de saltárselo. Por eso la Pi ahora habla TLS (pi/setup_tls.sh genera
 *   una CA local) y la GUI le habla por wss:// y https://.
 *
 * Modo campo = tres cosas a la vez:
 *   1. la app carga sin internet          -> service worker (sw.js)
 *   2. lo que captures no se pierde       -> Firestore encola y sincroniza al volver
 *   3. la Pi se administra desde la página -> /api/system, sin monitor ni teclado
 */
window.KaaxPi = (() => {
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem("kaax." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => localStorage.setItem("kaax." + k, JSON.stringify(v)),
};

// ---------- URLs derivadas de una sola raíz -------------------------------
// Antes había tres ajustes (wsUrl, camUrl, y el /api/gps deducido con un
// replace sobre camUrl). Ahora hay uno: piUrl. Todo lo demás se deriva.
const clean = (u) => String(u || "").trim().replace(/\/+$/, "");
const Url = {
  base: () => clean(Settings().piUrl),
  ws:   () => clean(Settings().piUrl).replace(/^http/, "ws") + "/ws",
  api:  (p) => clean(Settings().piUrl) + "/api/" + p.replace(/^\//, ""),
  cam:  () => clean(Settings().piUrl) + "/camera/stream",
  snap: () => clean(Settings().piUrl) + "/camera/snapshot",
};
let Settings = () => ({ piUrl: "" });      // app.js inyecta el suyo en init()

// ---------- estado --------------------------------------------------------
const state = {
  offline: LS.get("offline", false),   // modo campo activado por el usuario
  online: navigator.onLine,            // lo que cree el navegador
  queued: 0,                           // escrituras pendientes de subir
};
const listeners = [];
const emit = () => listeners.forEach(f => { try { f(state); } catch {} });
const onChange = (f) => { listeners.push(f); f(state); };

// ---------- llamadas autenticadas a la Pi ---------------------------------
// Las acciones destructivas (reboot, cambiar de red) piden un token que se
// genera en la Pi durante la instalación y se pega una sola vez en Ajustes.
async function piFetch(path, { method = "GET", body = null, timeout = 8000 } = {}) {
  if (!Url.base()) throw new Error("Falta la URL de la Pi en Ajustes.");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(Url.api(path), {
      method, signal: ctrl.signal, cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(Settings().piToken ? { "X-Kaax-Token": Settings().piToken } : {}),
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("La Pi no respondió (timeout).");
    // Un fetch que falla contra https:// casi siempre es el certificado.
    if (e instanceof TypeError && Url.base().startsWith("https"))
      throw new Error("No se pudo contactar la Pi. Si el certificado no está instalado en este equipo, corre pi/setup_tls.sh y añade la CA (ver README §12).");
    throw e;
  } finally { clearTimeout(t); }
}

// ---------- modo campo ----------------------------------------------------
async function setOffline(on) {
  state.offline = !!on;
  LS.set("offline", state.offline);
  // Firestore: cortar la red a propósito evita que cada escritura espere 30 s
  // a un timeout. Las escrituras se encolan en IndexedDB y salen al volver.
  try { await window.KaaxAuth?.setNetwork?.(!state.offline); } catch {}
  emit();
  return state.offline;
}

/** Vuelve a línea y empuja lo que quedó pendiente. Devuelve cuántas subió. */
async function goOnline() {
  await setOffline(false);
  if (!navigator.onLine) throw new Error("Este equipo sigue sin internet. Conéctate a una red y vuelve a intentar.");
  const n = await window.KaaxAuth?.flushQueue?.();
  state.queued = 0; emit();
  return n || 0;
}

window.addEventListener("online",  () => { state.online = true;  emit(); });
window.addEventListener("offline", () => { state.online = false; emit(); });

// ---------- mapa sin internet ---------------------------------------------
// Leaflet pide sus teselas a openstreetmap.org. Sin internet no hay mapa, y sin
// mapa la cuadrícula no sirve de nada. Así que las bajamos antes de salir.
const TILE_CACHE = "kaax-tiles-v1";
const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };

function tileList(bounds, zMin, zMax) {
  const out = [];
  for (let z = zMin; z <= zMax; z++) {
    const x0 = lon2x(bounds.west, z), x1 = lon2x(bounds.east, z);
    const y0 = lat2y(bounds.north, z), y1 = lat2y(bounds.south, z);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) out.push(tileUrl(z, x, y));
  }
  return out;
}

/** Descarga las teselas de una zona para usarlas sin internet. */
async function downloadTiles(bounds, { zMin = 13, zMax = 18, onProgress = () => {} } = {}) {
  if (!("caches" in window)) throw new Error("Este navegador no soporta caché offline.");
  const urls = [...new Set(tileList(bounds, zMin, zMax))];
  // El uso pesado de tile.openstreetmap.org está mal visto y te bloquean.
  // Una zona de trabajo a z13–18 son ~1500 teselas; con tope y de a poco.
  if (urls.length > 4000) throw new Error(`La zona es demasiado grande (${urls.length} teselas). Acércate en el mapa y vuelve a intentar.`);
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0;
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try {
        if (!(await cache.match(u))) {
          const r = await fetch(u, { mode: "cors", cache: "no-cache" });
          if (r.ok) await cache.put(u, r.clone()); else failed++;
        }
      } catch { failed++; }
      onProgress(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));   // 6 en paralelo, no más
  return { total: urls.length, failed };
}

async function tileCacheSize() {
  if (!("caches" in window)) return 0;
  try { const c = await caches.open(TILE_CACHE); return (await c.keys()).length; } catch { return 0; }
}
async function clearTiles() { try { await caches.delete(TILE_CACHE); } catch {} }

// ---------- service worker ------------------------------------------------
async function registerSW() {
  if (!("serviceWorker" in navigator)) return null;
  // La ruta es relativa para que funcione igual en /Yum-Kaaxa/ (Pages) que en
  // la raíz (cuando la sirve la propia Pi como respaldo).
  try {
    const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      sw?.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller)
          document.dispatchEvent(new CustomEvent("kaax:update"));
      });
    });
    return reg;
  } catch (e) { console.warn("SW no registrado:", e.message); return null; }
}

/** ¿Está la app lista para abrirse sin internet? */
async function offlineReady() {
  if (!("caches" in window)) return false;
  try { return (await caches.has("kaax-shell-v1")) && !!navigator.serviceWorker.controller; }
  catch { return false; }
}

// ---------- administración de la Pi ---------------------------------------
const Pi = {
  status:  () => piFetch("system"),
  logs:    (n = 60) => piFetch("system/logs?lines=" + n),
  gps:     () => piFetch("gps"),
  action:  (action, extra = {}) => piFetch("system/action", { method: "POST", body: { action, ...extra }, timeout: 20000 }),
  wifiScan: () => piFetch("system/wifi", { timeout: 20000 }),

  /** Pasa la Pi a tu red de casa. El watchdog la regresa al hotspot si falla. */
  goOnline: (ssid, psk, revertMin = 5) =>
    Pi.action("wifi_client", { ssid, psk, revert_minutes: revertMin }),
  /** Regresa la Pi a modo hotspot (el modo de campo). */
  goHotspot: () => Pi.action("wifi_hotspot"),
  restart:  () => Pi.action("restart_service"),
  reboot:   () => Pi.action("reboot"),
  shutdown: () => Pi.action("shutdown"),
  update:   () => Pi.action("update", {}),
};

function init(getSettings) {
  Settings = getSettings;
  registerSW();
  return state;
}

return { init, state, onChange, setOffline, goOnline, Pi, piFetch,
         downloadTiles, tileCacheSize, clearTiles, offlineReady, Url,
         get queued() { return state.queued; },
         set queued(n) { state.queued = n; emit(); } };
})();
