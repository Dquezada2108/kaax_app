/* KAAX service worker — hace que la app abra con cero internet.
 *
 * Tres cachés, tres políticas distintas:
 *   kaax-shell-v1  la app en sí (html/js/css/fuentes/leaflet). Precargada en la
 *                  instalación. Se sirve de caché primero: en el agua no hay red
 *                  y esperar un timeout de 30 s por cada archivo es inaceptable.
 *   kaax-tiles-v1  teselas del mapa. Las llena el botón "Descargar zona" de la
 *                  GUI; aquí solo se leen. Nunca se borran solas.
 *   kaax-lib-v1    tfjs y Teachable Machine. Pesados y opcionales: se guardan la
 *                  primera vez que enciendes la visión con internet.
 *
 * Nada de esto toca a la Raspberry: la Pi se habla por wss:// y https:// en vivo,
 * y esas peticiones pasan de largo (ver el bypass en fetch).
 */
const SHELL = "kaax-shell-v1";
const TILES = "kaax-tiles-v1";
const LIB   = "kaax-lib-v1";

const ASSETS = [
  "./", "index.html", "app.js", "auth.js", "config.js", "pi.js",
  "manifest.webmanifest",
  "vendor/leaflet/leaflet.min.js", "vendor/leaflet/leaflet.min.css",
  "vendor/leaflet/images/marker-icon.png", "vendor/leaflet/images/marker-icon-2x.png",
  "vendor/leaflet/images/marker-shadow.png", "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/layers-2x.png",
  "vendor/chart.umd.min.js", "vendor/fonts/fonts.css",
  "assets/logo_sm.png", "assets/logo_k_sm.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // addAll falla entero si un archivo falta (p.ej. los logos que aún no
    // copiaste). Uno por uno: la app se instala igual, sin logos.
    await Promise.all(ASSETS.map(u => c.add(u).catch(() => {})));
    // Las fuentes vienen referenciadas desde fonts.css, no del HTML.
    try {
      const css = await (await fetch("vendor/fonts/fonts.css")).text();
      const woff = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map(m => "vendor/fonts/" + m[1].replace(/['"]/g, ""));
      await Promise.all([...new Set(woff)].map(u => c.add(u).catch(() => {})));
    } catch {}
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL, TILES, LIB];
    await Promise.all((await caches.keys()).filter(k => !keep.includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => { if (e.data === "skipWaiting") self.skipWaiting(); });

const isTile = (u) => /tile\.openstreetmap\.org/.test(u.hostname) || /\.tile\.openstreetmap\.org$/.test(u.hostname);
const isLib  = (u) => /cdn\.jsdelivr\.net|storage\.googleapis\.com|teachablemachine\.withgoogle\.com/.test(u.hostname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Nunca interceptar la Pi ni Firebase: son datos en vivo, y una respuesta
  // vieja de caché aquí sería peor que un error honesto.
  if (url.port === "8443" || /googleapis\.com|gstatic\.com\/firebasejs|firebaseio|firebaseapp\.com/.test(url.hostname)) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/camera/")) return;

  // Teselas: caché primero, y lo que se descargue en línea se va guardando.
  if (isTile(url)) {
    event.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }
      catch { return new Response("", { status: 504, statusText: "tesela no descargada" }); }
    })());
    return;
  }

  // Librerías pesadas de visión: caché primero, se llenan solas al usarlas.
  if (isLib(url)) {
    event.respondWith((async () => {
      const c = await caches.open(LIB);
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r;
    })());
    return;
  }

  // La app: caché primero y refresco en segundo plano, así abre instantánea y
  // se actualiza sola la próxima vez que haya internet.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      if (hit) return hit;
      const r = await net;
      if (r) return r;
      // Navegación sin caché y sin red: al menos devolver el index.
      if (req.mode === "navigate") return (await c.match("index.html")) || Response.error();
      return Response.error();
    })());
  }
});
