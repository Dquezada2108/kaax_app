// KAAX — user configuration. Edit freely; app.js never overwrites this file.
window.KAAX_CONFIG = {
  team: "DAY1 Robotics",

  // ---- Firebase: cuentas reales, login con Google, equipos --------------
  // Pega aquí la config de tu proyecto (Firebase Console → Configuración → Tus apps → Web).
  // Si lo dejas como está, la app funciona en modo local con la lista `users` de abajo.
  firebase: {
    apiKey: "AIzaSyBICGYUg5bsXQY9a7pv_aATZgjRDLoH-5M",
    authDomain: "kaax-cf8da.firebaseapp.com",
    projectId: "kaax-cf8da",
    storageBucket: "kaax-cf8da.firebasestorage.app",
    messagingSenderId: "1048691926194",
    appId: "1:1048691926194:web:ae425754bc24d65fdb95ab",
  },

  // ---- Raspberry Pi -----------------------------------------------------
  // UNA sola dirección para todo: de aquí salen el WebSocket (/ws), la cámara
  // (/camera/stream), el GPS (/api/gps) y la administración (/api/system).
  //
  // Tiene que ser https:// para que la GUI publicada en GitHub Pages pueda
  // hablarle: Chrome bloquea https -> ws:// sin aviso. Corre pi/setup_tls.sh
  // en la Pi e instala la CA en este equipo (README §12).
  //   en el hotspot de la Pi : https://10.42.0.1:8443
  //   en tu red de casa      : https://kaax.local:8443
  pi: { url: "https://10.42.0.1:8443", token: "" },

  camera: { fps: 4 },

  // Visión por computadora: pega la URL del modelo exportado de Teachable Machine
  // (Export Model → Tensorflow.js → Upload → copia el enlace que termina en /)
  vision: { modelUrl: "", enabled: false, threshold: 0.6 },

  // Login local (solo si NO usas Firebase). Hashes = SHA-256 de "usuario:contraseña".
  // Default password for all three: kaax2026 — change it!
  // To make a new hash open the browser console on the site and run:  KAAX.hash("usuario","contraseña")
  users: [
    { user: "quezada",  name: "Diego Quezada",  hash: "3b9fa33ec20a94141640281ec039f8a32eb64b2dda3cf1f8a04953864e9d5987" },
    { user: "yael",     name: "Yael García",    hash: "4a7f195f05a4d93d017d8eda0924fb3bfc6a2279cc7e944a4131b8bfb14ffd45" },
    { user: "carvajal", name: "Carvajal",       hash: "a3241a3c5df842fa83ce10cbbe3eed809c2d3ec896264702738398f41bdd22bb" },
  ],
  robots: [
    { id: "01", name: "Kaax 1", color: "#0077b6" },
    { id: "02", name: "Kaax 2", color: "#00b4d8" },
    { id: "03", name: "Kaax 3", color: "#2a9d8f" },
  ],

  // Default work zone (used until the browser gives its own location, or when
  // "usar mi ubicación" is off). Ojo de Agua, Tecámac, Edo. de México.
  zone: { lat: 19.6833, lon: -99.0217, name: "Ojo de Agua, Edo. Méx." },
  useBrowserLocation: true,

  // Cleaning grid
  grid: { cellMeters: 10, cols: 12, rows: 10 },

  // Effective collection width of both nets together (m). Used for swept area.
  swathMeters: 0.9,
  // Ignore GPS jumps smaller than this (m) when accumulating distance.
  gpsNoiseMeters: 1.5,

  // Baterías: el robot con Raspberry NO las mide (no hay ADS1115 ni divisores),
  // así que la GUI oculta esos campos. Ponlo en true solo si cableas el ADC.
  battery: { enabled: false, full: 16.8, warn: 14.8, low: 13.5, min: 13.0 },

  // Motor mapping (µs)
  motor: { neutral: 1500, span: 400, keepaliveMs: 500 },

  // Enlace serie con la estación base Heltec (plan A)
  serial: { baud: 115200 },

  // Ollama Cloud (key is stored only in this browser, from Ajustes)
  ai: { endpoint: "https://ollama.com/api/chat", model: "gpt-oss:20b" },

  contaminants: [
    { key: "sargazo", label: "Sargazo" },
    { key: "lirio",   label: "Lirio acuático" },
    { key: "basura",  label: "Residuos sólidos" },
  ],
};
