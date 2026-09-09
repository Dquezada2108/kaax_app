# Kaax · despliegue completo (DAY1 Robotics)

```
kaax/
├── docs/          ← sitio web (GitHub Pages)
│   ├── index.html · app.js · auth.js · config.js
│   ├── pi.js            ← modo campo (offline) y administración de la Pi
│   ├── sw.js            ← service worker: la app abre sin internet
│   ├── manifest.webmanifest
│   ├── vendor/          ← Leaflet, Chart.js y fuentes locales (nada de CDN)
│   └── assets/          ← logos
├── firmware/
│   ├── kaax_base/kaax_base.ino    ← Heltec conectado a la laptop
│   └── kaax_robot/kaax_robot.ino  ← Heltec en cada robot (cambiar ROBOT_ID)
└── pi/
    ├── install.sh       ← instalación completa en la Pi (una sola vez)
    ├── setup_tls.sh     ← certificados: sin esto la GUI no puede hablarle a la Pi
    ├── pi_robot.py      ← plan C: la Pi hace todo
    └── pi_bridge.py     ← plan B: la Pi como estación con el Heltec base
```

Un solo protocolo de líneas de texto en los tres planes, así la GUI no cambia:

| Dirección | Mensaje | Significado |
|---|---|---|
| GUI → robot | `CMD,01,1700,1300` | µs motor derecho, izquierdo (1500 = paro) |
| GUI → robot | `NET,01,1` / `NET,01,0` | redes abajo / arriba |
| GUI → robot | `STOP,00` | paro de emergencia (00 = todos) |
| robot → GUI | `KAAX,01,lat,lon,b1,b2,fix,km/h,rumbo,rssi` | telemetría cada 1 s |

`b1`/`b2` son los voltajes de las dos baterías. **El robot con Raspberry los manda vacíos** (`KAAX,01,19.68,-99.02,,,1,0.00,0`) porque no lleva ADS1115 ni los divisores resistivos, y la GUI oculta esos campos en vez de mostrar 0.00 V. Los Heltec sí los mandan. Si algún día cableas el ADC, pon `battery.enabled: true` en `config.js`.

Failsafe: si un robot no recibe `CMD` en 1.5 s, se detiene solo. La GUI reenvía el último comando cada 0.5 s mientras haya movimiento.

---

## 1 · Sitio web en GitHub Pages

1. El repo es [`Dquezada2108/kaax_app`](https://github.com/Dquezada2108/kaax_app); `docs/` ya está en la raíz.
2. Copia tus logos a `docs/assets/logo_sm.png` y `docs/assets/logo_k_sm.png`.
3. GitHub → Settings → Pages → Source: **Deploy from a branch** → Branch `main`, folder **/docs** → Save.
4. Abre **https://dquezada2108.github.io/kaax_app/** en **Chrome o Edge de escritorio** (Web Serial no existe en Firefox/Safari ni en móvil).
5. Ajustes → Transporte *Raspberry Pi · WebSocket*, dirección `https://10.42.0.1:8443` → Guardar → **Conectar**. (Para los Heltec: transporte *USB · Heltec base* y elige el puerto.)
6. Instálala como app desde la barra de direcciones. Así abre sin internet — ver **§12**.

**Login:** usuarios `quezada`, `yael`, `carvajal`, contraseña inicial `kaax2026`. Cámbiala: en la consola del navegador (F12) ejecuta `KAAX.hash("usuario","nueva")` y pega el hash en `config.users`. El operador que entra queda registrado en cada sesión y en el desglose *Por operador* de Reportes. Es una puerta del lado del cliente (el sitio es estático); quien lea el repo puede ver los hashes, no las contraseñas.

`config.js` tiene los valores por defecto (robots, zona, umbrales, ancho de red). `app.js` no lo toca.
Todo lo que capturas (sesiones, cuadrícula, ajustes, API key) vive en `localStorage` de ese navegador; usa *Exportar JSON* para respaldar.

**Ubicación:** al abrir pide la ubicación del navegador y centra el mapa ahí. Si la niegas usa `config.zone`. En Cuadrícula → *Centrar aquí* fija la malla donde tengas el mapa.

**IA:** Ajustes → pega la API key de Ollama Cloud → Reportes → *Analizar sesiones*. La clave nunca se escribe en el repo. Si Chrome bloquea la petición por CORS, el mismo botón cae automáticamente al proxy `/api/ai` cuando la GUI se abre desde la Pi.

> **Rota la clave de Ollama.** La que pegaste en la conversación quedó en un enlace compartido públicamente: dala por comprometida y genera otra en ollama.com/settings/keys. La nueva se pega en *Ajustes* y vive solo en el `localStorage` de ese navegador.

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

## 3 · Plan C · solo Raspberry Pi 5 en el robot  ← el que usas

La Pi va a bordo, hace su propio hotspot WiFi y controla todo. Alcance ≈ 50–80 m (WiFi), no 1 km (LoRa). Con varios robots cada uno tendría su hotspot; en la práctica el plan C es para **un** robot.

### 3.1 Cableado (numeración **BCM**, no el número de pin físico)

| Qué | GPIO (BCM) | Pin físico |
|---|---|---|
| ESC derecho | GPIO18 | 12 |
| ESC izquierdo | GPIO19 | 35 |
| Servo red derecha | GPIO12 | 32 |
| Servo red izquierda | GPIO13 | 33 |
| GPS TX → Pi RX | GPIO15 (RXD) | 10 |
| GPS RX ← Pi TX | GPIO14 (TXD) | 8 |
| Tierra común | GND | 6 (o 9, 14, 20, 25, 30, 34, 39) |

El GPS **cruza**: TX del GPS al RX de la Pi. Si no llegan tramas NMEA, casi siempre es que están sin cruzar. El GPS va a 3.3 V (pin 1 o 17), nunca a 5 V en las líneas de datos. Los ESC y servos comparten tierra con la Pi pero se alimentan de su BEC/UBEC, **nunca** del riel de 5 V de la Pi.

No hay medición de baterías: sin ADS1115 ni divisores, la GUI simplemente no muestra ese dato.

### 3.2 Instalación (un solo comando)

```bash
git clone https://github.com/Dquezada2108/kaax_app.git ~/kaax
bash ~/kaax/pi/install.sh
```

`install.sh` deja todo listo y **no adivina rutas**: toma la carpeta real donde está el script, que es lo que provocaba el error `status=200/CHDIR` cuando la ruta del servicio no coincidía. Hace:

- instala dependencias y habilita el UART del GPS;
- crea el hotspot `Kaax` con `autoconnect yes`, así se levanta solo en cada arranque;
- genera los certificados TLS (§12);
- instala el servicio `kaax` con la ruta correcta y `PYTHONUNBUFFERED=1`, para que `journalctl -f` muestre los logs al momento y no en bloques;
- da permisos `sudo` **acotados** (solo `nmcli`, reiniciar el servicio, reiniciar y apagar) en `/etc/sudoers.d/kaax`;
- publica `kaax.local` por mDNS.

Al terminar imprime el **token de administración**. Cópialo: se pega una vez en *Ajustes → Raspberry* y es lo que autoriza reiniciar o cambiar de red desde la GUI.

Variables opcionales: `KAAX_ID=02 KAAX_SSID=Kaax2 KAAX_PSK=otraclave bash pi/install.sh`.

### 3.3 Comprobar

```bash
systemctl status kaax --no-pager      # debe decir active (running)
sudo journalctl -u kaax -f            # telemetría KAAX,01,... y errores
ls -l /dev/serial0                    # a dónde apunta el GPS en tu Pi
```

El script prueba `/dev/serial0`, `/dev/ttyAMA0`, `/dev/ttyAMA10`, `/dev/ttyS0` y `/dev/ttyUSB0` en ese orden, así que da igual cuál te toque. Fuérzalo con `KAAX_GPS=/dev/ttyAMA0` si hace falta.

---

## 4 · Plan B · Heltec base + Raspberry Pi como estación

Si algún día vuelves a los Heltec: la Pi lee el Heltec base por USB y publica todo por WebSocket.

```bash
pip3 install -r pi/requirements.txt --break-system-packages
bash pi/setup_tls.sh                 # mismos certificados que el plan C
python3 pi/pi_bridge.py              # detecta /dev/ttyUSB0 solo
```

Autostart: el mismo patrón de servicio que `install.sh`, cambiando `pi_robot.py` por `pi_bridge.py`.

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
| Batería mín. | menor voltaje visto por robot en la sesión — **solo con los Heltec**; el robot con Raspberry no mide baterías y la GUI oculta el dato |

Ajusta `swathMeters` cuando midas el ancho real de las redes en el agua.

---

## 6 · Firebase: cuentas, roles y equipos

Sin backend no hay cuentas reales. Firebase (plan gratuito Spark) da login con Google, registro por correo, aprobación de técnicos y reportes compartidos, y funciona desde GitHub Pages.

### 6.1 Crear el proyecto
1. Entra a **console.firebase.google.com** → *Crear un proyecto* → nómbralo `kaax` → puedes desactivar Analytics.
2. **Build → Authentication → Get started.** Activa **Correo/contraseña** y **Google** (elige tu correo como *support email*).
3. **Build → Firestore Database → Crear base de datos** → modo producción → región `nam5` o `us-central`.
4. **Configuración del proyecto (⚙) → Tus apps → Web (</>)** → registra la app → copia el objeto `firebaseConfig` y pégalo en `docs/config.js`, en el bloque `firebase`.
5. **Authentication → Settings → Dominios autorizados** → *Agregar dominio* → `dquezada2108.github.io`. Sin esto el login con Google falla **solo en producción** y funciona en local, que es un síntoma confuso.

### 6.2 Reglas de seguridad
**Firestore → Reglas** → pega el contenido de `firestore.rules` (viene en el paquete) → *Publicar*.

### 6.3 Clave de administrador
La clave nunca se guarda en el código: se guarda su **hash** en una colección que el cliente no puede leer.

1. Inventa una clave larga, por ejemplo `kaax-admin-2026-r7x9qm`.
2. Saca su SHA-256: abre la consola del navegador (F12) en tu sitio y ejecuta
   `crypto.subtle.digest("SHA-256", new TextEncoder().encode("TU_CLAVE")).then(b=>console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")))`
3. En **Firestore → Iniciar colección** crea la colección `adminKeys` y un documento cuyo **ID sea ese hash**. Déjalo vacío (agrega un campo cualquiera si te lo exige).
4. Reparte la clave solo a quien deba ser administrador.

Cómo funciona: al registrarse como admin, la app manda el hash; las reglas comprueban `exists(/adminKeys/{hash})` y rechazan el alta si no coincide. Las reglas sí pueden leer esa colección aunque el cliente no. Limitación honesta: si alguien conoce el hash puede crear un admin, así que usa una clave larga y no la publiques.

### 6.4 Flujo de cuentas
- **Técnico:** se registra (Google o correo) → elige *Técnico* → escoge el equipo → queda **pendiente** hasta que un admin lo acepte. La pantalla de espera se refresca sola.
- **Administrador:** se registra → elige *Administrador* → escribe la clave secreta y el nombre del equipo → entra directo y aparece la pestaña **Equipo**, donde acepta o rechaza solicitudes, ve a los miembros y renombra el equipo.
- Las sesiones guardadas se suben a `teams/{id}/sessions` y todos los del equipo las ven en Reportes.

Si dejas `config.firebase` sin tocar, la app sigue funcionando en modo local con los usuarios de `config.users`.

---

## 7 · Publicar y actualizar en GitHub

**Primera vez**
```bash
cd ~/kaax_app                  # tu repo clonado
# copia aquí las carpetas docs/, firmware/, pi/ y firestore.rules del zip
git add .
git commit -m "Kaax: cuentas Firebase, cámara, visión y control Xbox"
git push
```
Luego en GitHub: **Settings → Pages → Source: Deploy from a branch → Branch `main`, carpeta `/docs` → Save.**
Tu app queda en **https://dquezada2108.github.io/kaax_app/**.

**Cada actualización**
```bash
git add . && git commit -m "cambios" && git push
```
Tarda 1–2 minutos en verse. Si no cambia, recarga con Ctrl+Shift+R (caché).

**Ya no hace falta copiar `docs/` a la Pi.** Antes había que abrir la copia local porque Chrome bloquea que una página https hable con un `ws://` de la LAN. Ahora la Pi habla TLS (`pi/setup_tls.sh`) y la GUI de GitHub Pages se le conecta directo por `wss://`, también sin internet. El procedimiento completo está en **§12**.

Si la Pi tiene una copia de `docs/` la sigue sirviendo como respaldo; si no la tiene, ya no se cae al arrancar — muestra una página que te recuerda a qué dirección apuntar la GUI.

---

## 8 · Cámara y visión por computadora

En la Pi, `pi_robot.py` detecta la cámara sola: primero intenta **Picamera2** (cámara CSI de cinta plana) y si no, **OpenCV** (webcam USB). Expone:
- `https://kaax.local:8443/camera/stream` — video MJPEG
- `https://kaax.local:8443/camera/snapshot` — una foto
- `https://kaax.local:8443/api/gps` — diagnóstico del GPS

No se configuran por separado: todas salen de la única dirección que pusiste en *Ajustes → Raspberry*. El puerto 8080 sigue abierto en http, pero solo sirve para descargar la CA (`/ca.crt`).

Para la CSI: `sudo apt install -y python3-picamera2`. Para USB ya viene con `opencv-python-headless` en `requirements.txt`.

**Teachable Machine:** entrena tu modelo en teachablemachine.withgoogle.com (clases sugeridas: *sargazo*, *lirio*, *basura*, *agua limpia*) → **Export Model → Tensorflow.js → Upload my model** → copia el enlace que termina en `/` → pégalo en **Ajustes → Modelo de Teachable Machine**. En la pestaña **Cámara** enciendes o apagas la visión cuando quieras. Cada detección por encima del umbral se cuenta en la sesión activa.

El modelo corre en el navegador de la laptop, no en la Pi: así no cargas la Raspberry ni instalas TensorFlow en ella.

---

## 9 · Verificar que el GPS realmente funciona

Pestaña **Cámara → Verificar GPS**. Lee directo el puerto serie de la Pi y te muestra:
puerto y si se pudo abrir, bytes recibidos, fix, número de satélites, posición y las **tramas NMEA crudas**.

Cómo leerlo:
- *Bytes = 0* → no llega nada: revisa que TX del GPS vaya al **pin 10** (RX de la Pi) y RX del GPS al **pin 8**, y que activaste el serial en `raspi-config`.
- *Bytes suben pero sin fix* → sí hay comunicación, falta señal: saca la antena al exterior; el primer fix en frío tarda 1–5 minutos.
- *Fix sí* → el mapa se recentra automáticamente en la posición real.

Desde la terminal de la Pi también sirve: `cat /dev/serial0` (deben salir líneas `$GPGGA`, `$GPRMC`).

---

## 10 · Control de Xbox por Bluetooth

1. Empareja el control con la **computadora** (no con la Pi): Windows *Bluetooth y dispositivos → Agregar*; macOS *Configuración → Bluetooth*. Mantén el botón de emparejar del control hasta que parpadee.
2. Abre la GUI y **pulsa cualquier botón** del control: los navegadores no lo muestran hasta que hay una pulsación. En **Ajustes → Control Xbox** el indicador pasa a verde.

| Control | Acción |
|---|---|
| Stick izquierdo | girar |
| Gatillo derecho (RT) | avanzar, proporcional |
| Gatillo izquierdo (LT) | retroceder |
| A | subir/bajar redes |
| B | paro de emergencia |
| LB / RB | cambiar de robot |

Funciona en Chrome y Edge. Puedes apagarlo desde Ajustes sin desemparejar el control.

---

## 11 · Cuadrícula con GPS automático

- **Mi ubicación** centra la malla donde estés (GPS de la laptop).
- **Seguir el GPS del robot** recentra la cuadrícula automáticamente cuando el robot sale de la zona dibujada.
- Los cuadrantes por donde pasa un robot con fix se marcan solos en naranja; tú confirmas en verde con un clic.
- **Verificar GPS** en la pestaña Cámara también recentra el mapa en la posición real de la Pi.

---

## 12 · Modo campo: trabajar sin internet, con la GUI en GitHub Pages

Esto es lo que permite que la interfaz **no viva en la Raspberry** y aun así puedas manejar el robot en un lago sin señal.

### 12.1 El obstáculo, dicho claro

La GUI se sirve por **https** (GitHub Pages). La Pi vive en su hotspot, sin internet. Chrome **bloquea** que una página https abra `ws://` o `http://` hacia la red local: no hay aviso, no hay excepción, no hay bandera que valga en un teléfono. Ésa —y solo ésa— era la razón por la que había que copiar `docs/` a la Pi.

La salida real es que la Pi hable TLS con un certificado en el que tu navegador confíe. `pi/setup_tls.sh` crea una autoridad certificadora propia; la instalas **una vez por dispositivo** y ya.

### 12.2 Instalar la CA (una vez por equipo, dura 10 años)

Con la Pi encendida y tu equipo en su hotspot, abre `http://10.42.0.1:8080/ca.crt`.

| Sistema | Pasos |
|---|---|
| **macOS** | Doble clic → Acceso a Llaveros → llavero *Inicio de sesión* → busca «Kaax Local CA», doble clic → **Confiar** → *Al usar este certificado: **Confiar siempre*** → pide tu contraseña. |
| **Windows** | Doble clic → Instalar certificado → **Equipo local** → *Colocar todos los certificados en el siguiente almacén* → Examinar → **Entidades de certificación raíz de confianza**. |
| **Android** | Ajustes → Seguridad → Cifrado y credenciales → Instalar un certificado → **Certificado de CA**. |
| **iOS** | Ábrelo en Safari → Ajustes → *Perfil descargado* → Instalar. **Después**, Ajustes → General → Información → *Ajustes de confianza de certificados* → activa «Kaax Local CA». Sin este segundo paso iOS lo instala pero no confía, y falla igual. |

Comprueba desde el navegador: `https://kaax.local:8443/api/system` debe abrir **sin advertencia**. Si sale el candado tachado, la CA no quedó instalada y el WebSocket fallará en silencio.

Luego, en **Ajustes → Enlace con los robots**: transporte *Raspberry Pi · WebSocket*, dirección `https://10.42.0.1:8443` (en el hotspot) o `https://kaax.local:8443` (en tu red), y pega el token. De esa única dirección salen el WebSocket, la cámara, el GPS y la administración.

### 12.3 Preparar la salida (con internet, antes de irte)

1. Abre la GUI en Chrome/Edge y **entra a tu cuenta**. La sesión queda guardada; no vuelve a pedir internet.
2. Instálala como app (icono ⊕ en la barra de direcciones, o *Compartir → Añadir a inicio* en el teléfono). El *service worker* guarda la app completa: sin esto la página ni siquiera abre sin señal.
3. **Raspberry → Mapa sin internet → Descargar la zona del mapa.** Las teselas vienen de OpenStreetMap; sin descargarlas verás la cuadrícula sobre un fondo gris. Descarga la zona **que vas a trabajar**: primero céntrala en *Cuadrícula → Centrar aquí*.

Comprueba que quedó bien: pon el equipo en modo avión, abre la app y confirma que carga y que el mapa se dibuja.

### 12.4 En el agua

1. Conéctate al WiFi **Kaax** (la Pi ya lo levantó sola al encender).
2. Abre la app. Pulsa **Modo campo** arriba a la derecha.
3. Pulsa **Conectar**.

«Modo campo» corta a propósito la conexión de Firestore. Sin eso, cada sesión que guardaras esperaría ~30 s a un servidor inalcanzable antes de rendirse. Con el modo activo, todo se escribe al instante en el navegador y se encola. La barra ámbar te dice cuántas sesiones esperan subir. Si el equipo pierde la red por su cuenta, el modo se activa solo.

### 12.5 Al volver

Conéctate a una red con internet y pulsa **Volver a línea** en la barra ámbar. Firestore reenvía lo encolado y la GUI te dice cuántas sesiones subieron. No hay que exportar ni importar nada a mano.

---

## 13 · Administrar la Pi desde la página

Pestaña **Raspberry**. Todo lo que cambia algo pide el token de *Ajustes*.

- **Estado** — servicio, tiempo encendida, temperatura, disco, GPS, cuántas GUIs hay conectadas y si TLS está activo.
- **Registro del servicio** — las últimas líneas de `journalctl -u kaax`, sin SSH.
- **Acciones** — reiniciar el servicio, actualizar desde GitHub (`git pull` + reinicio), reiniciar y **apagar**. Apaga siempre desde aquí antes de cortar la corriente: un apagón sucio es lo que dejó el hotspot a medias aquella vez.
- **Red de la Pi** — pasarla a tu WiFi de casa (para actualizar o descargar) y regresarla al hotspot.

### La red de seguridad del cambio de red

La Pi tiene una antena: o emite el hotspot **o** está en tu red, nunca las dos. Cambiarla a tu WiFi es justo la operación que puede dejarte sin forma de hablarle — sin monitor, sin teclado, sin hotspot.

Por eso, **antes** de cambiar, la Pi programa su propio regreso con un timer de systemd (`kaax-revert`, que sobrevive aunque el proceso se caiga). Si a los N minutos nadie lo canceló, vuelve sola al hotspot. El flujo es:

1. *Buscar redes* → elige la tuya → contraseña → *Conectar a esta red*.
2. Búscala en la red nueva: `https://kaax.local:8443`.
3. Si la alcanzas, pulsa **Quedarme en esta red** para cancelar el regreso.
4. Si **no** la alcanzas, no hagas nada: el hotspot vuelve solo y no perdiste la Pi.
