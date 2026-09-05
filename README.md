# Kaax · despliegue completo (DAY1 Robotics)

```
kaax/
├── docs/          ← sitio web (GitHub Pages)  index.html · app.js · config.js · assets/
├── firmware/
│   ├── kaax_base/kaax_base.ino    ← Heltec conectado a la laptop
│   └── kaax_robot/kaax_robot.ino  ← Heltec en cada robot (cambiar ROBOT_ID)
└── pi/            ← plan B (pi_bridge.py) y plan C (pi_robot.py)
```

Un solo protocolo de líneas de texto en los tres planes, así la GUI no cambia:

| Dirección | Mensaje | Significado |
|---|---|---|
| GUI → robot | `CMD,01,1700,1300` | µs motor derecho, izquierdo (1500 = paro) |
| GUI → robot | `NET,01,1` / `NET,01,0` | redes abajo / arriba |
| GUI → robot | `STOP,00` | paro de emergencia (00 = todos) |
| robot → GUI | `KAAX,01,lat,lon,b1,b2,fix,km/h,rumbo,rssi` | telemetría cada 1 s |

Failsafe: si un robot no recibe `CMD` en 1.5 s, se detiene solo. La GUI reenvía el último comando cada 0.5 s mientras haya movimiento.

---

## 1 · Sitio web en GitHub Pages

1. En tu repo (`Yum-Kaaxa` o uno nuevo) copia la carpeta `docs/` a la raíz.
2. Copia tus logos a `docs/assets/logo_sm.png` y `docs/assets/logo_k_sm.png`.
3. GitHub → Settings → Pages → Source: **Deploy from a branch** → Branch `main`, folder **/docs** → Save.
4. Abre `https://<usuario>.github.io/<repo>/` en **Chrome o Edge de escritorio** (Web Serial no existe en Firefox/Safari ni en móvil).
5. Ajustes → Transporte "USB · Heltec base" → Guardar → **Conectar** → elige el puerto del Heltec base.

`config.js` tiene los valores por defecto (robots, zona, umbrales, ancho de red). `app.js` no lo toca.
Todo lo que capturas (sesiones, cuadrícula, ajustes, API key) vive en `localStorage` de ese navegador; usa *Exportar JSON* para respaldar.

**Ubicación:** al abrir pide la ubicación del navegador y centra el mapa ahí. Si la niegas usa `config.zone`. En Cuadrícula → *Centrar aquí* fija la malla donde tengas el mapa.

**IA:** Ajustes → pega la API key de Ollama Cloud → Reportes → *Analizar sesiones*. La clave nunca se escribe en el repo. Si Chrome bloquea la petición por CORS, el mismo botón cae automáticamente al proxy `/api/ai` cuando la GUI se abre desde la Pi.

> Rota la clave que pegaste en el chat (ollama.com/settings/keys) — cualquier clave compartida en texto plano debe considerarse comprometida.

---

## 2 · Flashear los Heltec (plan A, el principal)

### Arduino IDE una sola vez
1. **File → Preferences → Additional boards manager URLs:**
   `https://github.com/Heltec-Aaron-Lee/WiFi_Kit_series/releases/download/0.0.9/package_heltec_esp32_index.json`
2. **Tools → Board → Boards Manager:** instala *Heltec ESP32 Series Dev-boards*. **Si también tienes "esp32 by Espressif", fíjala en 2.0.14** (la 3.x rompe la librería Heltec con el error `SpiInOut`).
3. **Tools → Manage Libraries:** instala `Heltec ESP32 Dev-Boards`, `ESP32Servo`, `TinyGPSPlus`.
4. Driver USB: CP210x (Silicon Labs) si Windows no ve el puerto.

### Selección de placa (igual para base y robots)
`Tools → Board → Heltec ESP32 Series Dev-boards → WiFi LoRa 32(V2)` · Upload speed 921600 · Port: el COM/ttyUSB del Heltec.
Si el upload se queda en `Connecting...`, mantén **PRG** pulsado, toca **RST**, suelta PRG.

### Base
Abre `firmware/kaax_base/kaax_base.ino` → Upload. La OLED debe decir `KAAX BASE 915 MHz`. Serial Monitor a 115200 muestra `BASE,ready`. **Cierra el Serial Monitor antes de usar la GUI** (el puerto solo puede tener un dueño).

### Robots
Abre `firmware/kaax_robot/kaax_robot.ino`, cambia `#define ROBOT_ID "01"` → `"02"` → `"03"` y sube a cada placa. La OLED muestra `KAAX 01  fix:no`, baterías y el último comando recibido.

### Prueba en mesa (sin motores)
Base por USB + un robot alimentado por power bank. En la GUI verás la tarjeta del robot con voltajes y RSSI en ≤ 2 s. Pulsa ▲ y la OLED del robot debe cambiar `R 1740 L 1740`. Suelta → `R 1500`.

### Pines Heltec WiFi LoRa 32 V2 (robot)

```
        ┌──────── USB ────────┐
 GND ●                        ● GND
  5V ●                        ● 5V
  Ve ●                        ● 3V3
  Ve ●                        ● 3V3
  36 ●  (libre, in)           ● 0
  37 ● ← BATT1 divisor        ● 22 → SERVO R (señal)
  38 ● ← BATT2 divisor        ● 19  LoRa MISO ✕
  39 ●  (libre, in)           ● 23 ← GPS TX
  34 ●  LoRa DIO2 ✕           ● 18  LoRa SS ✕
  35 ●  LoRa DIO1 ✕           ● 5   LoRa SCK ✕
  32 ●  (libre)               ● 15  OLED SCL ✕
  33 ●  (libre)               ● 2  → SERVO L (señal)
  25 ●  LED placa ✕           ● 4   OLED SDA ✕
  26 ●  LoRa DIO0 ✕           ● 17 → GPS RX
  27 ●  LoRa MOSI ✕           ● 16  OLED RST ✕
  14 ●  LoRa RST ✕            ● 21  Vext ✕
  12 ● → ESC R (señal)        ● 1/3 USB ✕
  13 ● → ESC L (señal)
```
✕ = ocupado por la placa, no conectar. GPIO 36–39 son solo entrada (ADC).

Divisor por batería: `LiPo+ ── 100 kΩ ── GPIO37/38 ── 20 kΩ ── GND` (16.8 V → 2.8 V). Tierra común obligatoria entre LiPo, ESC, servos, GPS y Heltec. Servos alimentados del BEC del ESC (o UBEC 5 V), **nunca** del pin 5V del Heltec. GPS a 3V3.

Si un Heltec no arranca con el ESC conectado en GPIO12 (pin de *strapping*), mueve `PIN_ESC_R` a 32.

---

## 3 · Plan B · Heltec base + Raspberry Pi como estación

Úsalo si Web Serial da problemas en la laptop o quieres controlar desde teléfono/tableta. La Pi lee el Heltec base por USB y publica todo por WebSocket; también sirve la misma GUI.

```bash
sudo apt install -y python3-pip
pip3 install -r pi/requirements.txt --break-system-packages
python3 pi/pi_bridge.py            # detecta /dev/ttyUSB0 solo
```
Abre `http://kaax.local:8080` (o la IP de la Pi) → Ajustes → Transporte *Raspberry Pi · WebSocket*, URL `ws://kaax.local:8080/ws` → Conectar.

Abre la copia **local** (http) y no la de GitHub Pages: Chrome no deja que una página https abra `ws://` hacia una IP de la LAN.

Autostart: `sudo systemctl enable --now` con un servicio que ejecute `python3 /home/pi/kaax/pi/pi_bridge.py` (WorkingDirectory=`/home/pi/kaax/pi`).

---

## 4 · Plan C · solo Raspberry Pi 5 en el robot

Si los Heltec no funcionan: la Pi va a bordo, hace hotspot WiFi y controla todo. Alcance ≈ 50–80 m (WiFi), no 1 km (LoRa).

Cableado BCM: ESC R **18**, ESC L **19**, servo R **12**, servo L **13**, GPS en UART0 (`/dev/serial0`, GPIO14/15, activar en `raspi-config → Interface → Serial: login shell NO, hardware YES`), baterías por **ADS1115** en I2C (A0, A1) con los mismos divisores 100k/20k. Pi alimentada por UBEC 5 V/3 A.

```bash
pip3 install -r pi/requirements.txt --break-system-packages
sudo nmcli dev wifi hotspot ifname wlan0 ssid Kaax password kaax2026   # hotspot
python3 pi/pi_robot.py --id 01
```
Conéctate al WiFi *Kaax*, abre `http://10.42.0.1:8080` → Ajustes → WebSocket `ws://10.42.0.1:8080/ws`.

Con varios robots en plan C cada uno tendría su propio hotspot; en la práctica plan C es para **un** robot. Para flota, plan A.

---

## 5 · Qué mide la GUI

| Métrica | Cómo se calcula |
|---|---|
| Distancia | suma de haversine entre fixes GPS consecutivos, ignorando saltos < `gpsNoiseMeters` (1.5 m) |
| Velocidad media | promedio de la velocidad GPS (VTG/RMC) mientras > 0.2 km/h; también máx. por robot |
| Área barrida | distancia × `swathMeters` (ancho efectivo de las dos redes, 0.9 m por defecto) |
| Área por cuadrantes | cuadrantes marcados limpios × lado² ; los recorridos por GPS se marcan solos en naranja |
| Peso | captura manual por tipo (sargazo, lirio, residuos) al terminar |
| Ritmo | kg totales / horas totales, en Reportes |
| Batería mín. | menor voltaje visto por robot en la sesión |

Ajusta `swathMeters` cuando midas el ancho real de las redes en el agua.
