// KAAX — user configuration. Edit freely; app.js never overwrites this file.
window.KAAX_CONFIG = {
  team: "DAY1 Robotics",
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

  // 4S LiPo thresholds (V)
  battery: { full: 16.8, warn: 14.8, low: 13.5, min: 13.0 },

  // Motor mapping (µs)
  motor: { neutral: 1500, span: 400, keepaliveMs: 500 },

  // Serial link to the Heltec base station
  serial: { baud: 115200 },
  // Plan B / C: WebSocket bridge on the Raspberry Pi
  websocket: { url: "ws://kaax.local:8080/ws" },

  // Ollama Cloud (key is stored only in this browser, from Ajustes)
  ai: { endpoint: "https://ollama.com/api/chat", model: "gpt-oss:20b" },

  contaminants: [
    { key: "sargazo", label: "Sargazo" },
    { key: "lirio",   label: "Lirio acuático" },
    { key: "basura",  label: "Residuos sólidos" },
  ],
};
