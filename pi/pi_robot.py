#!/usr/bin/env python3
"""
KAAX — Plan C: la Raspberry Pi 5 a bordo hace todo. Sin Heltec.

  Laptop/teléfono --WiFi (hotspot de la Pi)--> este script --> ESCs, servos, GPS

Mismo protocolo de líneas que la versión LoRa, así la GUI no cambia:
  entra : CMD,<id>,R,L · NET,<id>,0|1 · STOP,<id> · PING,<id>
  sale  : KAAX,<id>,lat,lon,b1,b2,fix,spd_kmh,hdg
          b1/b2 van vacíos: este robot no mide baterías (no hay ADS1115 ni
          divisores). La GUI oculta esos campos cuando llegan vacíos.

POR QUÉ TLS (el punto entero de esta versión)
  La GUI vive en GitHub Pages, que es https. Chrome bloquea https -> ws:// sin
  aviso ni forma de saltárselo. Con un certificado de la CA local que genera
  pi/setup_tls.sh, la Pi habla wss:// y https:// y la GUI puede vivir fuera de
  la Pi. Si no hay certificados, arranca en http/ws como antes.

CABLEADO (numeración BCM, Pi 5)
  GPIO18  ESC derecho    GPIO19  ESC izquierdo
  GPIO12  Servo red R    GPIO13  Servo red L
  GPIO14/15 (UART0, /dev/serial0)  GPS TX->GPIO15(pin 10), GPS RX<-GPIO14(pin 8)
  Tierra común en todo. Pi alimentada por UBEC 5 V, nunca del BEC del ESC.

Arranca:  python3 pi_robot.py --id 01
Abre:     https://kaax.local:8443   (o la GUI de GitHub Pages apuntando aquí)
"""
import argparse, asyncio, json, os, secrets, shutil, ssl, subprocess, sys, time

from aiohttp import web, ClientSession

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")
CERT_DIR = os.path.join(HERE, "certs")
TOKEN_FILE = os.path.join(HERE, "kaax_token.txt")

PIN_ESC_R, PIN_ESC_L, PIN_SRV_R, PIN_SRV_L = 18, 19, 12, 13
NEUTRAL, MIN_US, MAX_US = 1500, 1100, 1900
NET_UP, NET_DOWN = 1100, 1900          # ancho de pulso de los servos (µs)
FAILSAFE_S, TELEMETRY_S = 1.5, 1.0
HOTSPOT_NAME = os.environ.get("KAAX_HOTSPOT", "Kaax-Hotspot")
SERVICE_NAME = os.environ.get("KAAX_SERVICE", "kaax")

# ---- GPIO: opcional, para poder probar el servidor en cualquier máquina ----
def _init_gpio():
    """Devuelve una función pulse(pin, us). En una Pi 5 el header suele ser
    gpiochip4, pero los kernels 6.6+ lo movieron de vuelta a gpiochip0. Probamos
    ambos en vez de asumir uno y fallar en silencio."""
    try:
        import lgpio
    except Exception as e:
        print("lgpio no disponible, motores desactivados:", e)
        return lambda pin, us: None
    for chip in (4, 0):
        try:
            h = lgpio.gpiochip_open(chip)
            for p in (PIN_ESC_R, PIN_ESC_L, PIN_SRV_R, PIN_SRV_L):
                lgpio.gpio_claim_output(h, p)
            print(f"GPIO listo en gpiochip{chip}")
            return lambda pin, us: lgpio.tx_servo(h, pin, int(max(500, min(2500, us))), 50)
        except Exception as e:
            print(f"gpiochip{chip} no sirvió:", e)
    print("Ningún gpiochip funcionó; motores desactivados.")
    return lambda pin, us: None

pulse = _init_gpio()

# ---- GPS -------------------------------------------------------------------
# En la Pi 5 el UART sale a veces como /dev/serial0 y a veces como /dev/ttyAMA0.
GPS_CANDIDATES = [os.environ["KAAX_GPS"]] if os.environ.get("KAAX_GPS") else \
                 ["/dev/serial0", "/dev/ttyAMA0", "/dev/ttyAMA10", "/dev/ttyS0", "/dev/ttyUSB0"]
gps_raw, gps_bytes, gps_sats, gps_port = [], 0, 0, None
gps_ser = None
try:
    import serial, pynmea2
    for cand in GPS_CANDIDATES:
        try:
            gps_ser = serial.Serial(cand, 9600, timeout=0)
            gps_port = cand
            print("GPS en", cand)
            break
        except Exception:
            continue
    if not gps_ser:
        print("GPS no encontrado. Probé:", ", ".join(GPS_CANDIDATES))
except Exception as e:
    print("pyserial/pynmea2 no disponibles:", e)

# ---- cámara: Picamera2 (CSI) con respaldo OpenCV (USB) ---------------------
camera = None
def open_camera():
    """Devuelve una función que entrega bytes JPEG, o None."""
    global camera
    if camera:
        return camera
    try:
        from picamera2 import Picamera2
        import io
        pc = Picamera2()
        pc.configure(pc.create_video_configuration(main={"size": (640, 480)}))
        pc.start(); time.sleep(1)
        def grab():
            buf = io.BytesIO(); pc.capture_file(buf, format="jpeg"); return buf.getvalue()
        camera = grab; print("Cámara: Picamera2 (CSI)"); return grab
    except Exception as e:
        print("Picamera2 no disponible:", e)
    try:
        import cv2
        cap = cv2.VideoCapture(0)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        if not cap.isOpened():
            raise RuntimeError("no hay /dev/video0")
        def grab():
            ok, frame = cap.read()
            if not ok: return None
            return cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])[1].tobytes()
        camera = grab; print("Cámara: OpenCV (USB)"); return grab
    except Exception as e:
        print("Cámara USB no disponible:", e)
    return None

# ---- estado del robot ------------------------------------------------------
state = dict(R=NEUTRAL, L=NEUTRAL, net=0, last_cmd=0.0,
             lat=0.0, lon=0.0, fix=0, spd=0.0, hdg=0.0)
clients = set()

def apply():
    pulse(PIN_ESC_R, state["R"]); pulse(PIN_ESC_L, state["L"])
    pulse(PIN_SRV_R, NET_DOWN if state["net"] else NET_UP)
    pulse(PIN_SRV_L, NET_UP if state["net"] else NET_DOWN)

def handle(line, rid):
    p = line.split(",")
    if len(p) < 2 or p[1] not in (rid, "00"):
        return
    if p[0] == "CMD" and len(p) >= 4:
        try:
            state["R"] = max(MIN_US, min(MAX_US, int(p[2])))
            state["L"] = max(MIN_US, min(MAX_US, int(p[3])))
        except ValueError:
            return
        state["last_cmd"] = time.time(); apply()
    elif p[0] == "STOP":
        state["R"] = state["L"] = NEUTRAL; apply()
    elif p[0] == "NET" and len(p) >= 3:
        try: state["net"] = int(p[2])
        except ValueError: return
        apply()

def poll_gps():
    global gps_bytes, gps_sats
    if not gps_ser:
        return
    try:
        chunk = gps_ser.read(4096)
        gps_bytes += len(chunk)
        for raw in chunk.decode(errors="ignore").splitlines():
            raw = raw.strip()
            if not raw.startswith("$"):
                continue
            gps_raw.append(raw); del gps_raw[:-12]
            try:
                if raw.startswith(("$GPRMC", "$GNRMC")):
                    m = pynmea2.parse(raw)
                    state["fix"] = 1 if m.status == "A" else 0
                    if state["fix"]:
                        state["lat"], state["lon"] = m.latitude, m.longitude
                        state["spd"] = (m.spd_over_grnd or 0) * 1.852
                        state["hdg"] = m.true_course or 0
                elif raw.startswith(("$GPGGA", "$GNGGA")):
                    gps_sats = int(pynmea2.parse(raw).num_sats or 0)
            except Exception:
                continue          # una trama corrupta no debe tirar el bucle
    except Exception as e:
        print("poll_gps:", e)

async def telemetry(app):
    rid = app["id"]
    while True:
        await asyncio.sleep(TELEMETRY_S)
        poll_gps()
        if (state["R"] != NEUTRAL or state["L"] != NEUTRAL) and time.time() - state["last_cmd"] > FAILSAFE_S:
            state["R"] = state["L"] = NEUTRAL; apply(); print("failsafe: alto")
        # b1/b2 vacíos a propósito: este robot no tiene medición de batería.
        msg = (f"KAAX,{rid},{state['lat']:.6f},{state['lon']:.6f},,,"
               f"{state['fix']},{state['spd']:.2f},{state['hdg']:.0f}")
        for ws in list(clients):
            try: await ws.send_str(msg)
            except Exception: clients.discard(ws)

# ---- CORS ------------------------------------------------------------------
# La GUI ahora es cross-origin (vive en GitHub Pages), así que cada endpoint
# necesita cabeceras CORS y hay que contestar el preflight OPTIONS.
def cors(request, extra=None):
    h = {
        "Access-Control-Allow-Origin": request.headers.get("Origin", "*"),
        "Access-Control-Allow-Headers": "Content-Type, X-Kaax-Token",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
    }
    h.update(extra or {})
    return h

@web.middleware
async def cors_mw(request, handler):
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=cors(request))
    resp = await handler(request)
    for k, v in cors(request).items():
        resp.headers.setdefault(k, v)
    return resp

# ---- token para las acciones destructivas ----------------------------------
def load_token():
    t = os.environ.get("KAAX_TOKEN", "").strip()
    if t:
        return t
    if os.path.exists(TOKEN_FILE):
        return open(TOKEN_FILE).read().strip()
    t = secrets.token_urlsafe(24)
    try:
        with open(TOKEN_FILE, "w") as f:
            f.write(t)
        os.chmod(TOKEN_FILE, 0o600)
        print("Token de administración generado en", TOKEN_FILE)
    except Exception as e:
        print("No se pudo guardar el token:", e)
    return t

TOKEN = load_token()

def need_token(request):
    """Compara en tiempo constante: un == normal filtra el token por timing."""
    got = request.headers.get("X-Kaax-Token", "")
    if not secrets.compare_digest(got, TOKEN):
        raise web.HTTPUnauthorized(
            text=json.dumps({"error": "Token incorrecto. Pégalo en Ajustes → Raspberry (está en pi/kaax_token.txt)."}),
            content_type="application/json", headers=cors(request))

def run(cmd, timeout=15):
    """Ejecuta sin shell. Devuelve (ok, salida)."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode == 0, (p.stdout + p.stderr).strip()
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except FileNotFoundError:
        return False, f"no existe el comando {cmd[0]}"
    except Exception as e:
        return False, str(e)

# ---- endpoints de datos ----------------------------------------------------
async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    clients.add(ws)
    print("GUI conectada:", request.remote)
    try:
        async for m in ws:
            if m.type == web.WSMsgType.TEXT:
                for l in m.data.split("\n"):
                    if l.strip():
                        handle(l.strip(), request.app["id"])
    finally:
        clients.discard(ws)
        print("GUI desconectada")
    return ws

async def gps_status(request):
    """Diagnóstico: demuestra si la Pi realmente está leyendo el GPS."""
    poll_gps()
    return web.json_response({
        "port": gps_port or "(ninguno)", "port_open": bool(gps_ser and gps_ser.is_open),
        "candidates": GPS_CANDIDATES,
        "bytes": gps_bytes, "fix": state["fix"], "satellites": gps_sats,
        "lat": state["lat"], "lon": state["lon"], "speed_kmh": state["spd"],
        "raw": gps_raw[-8:],
    })

async def camera_stream(request):
    grab = open_camera()
    if not grab:
        return web.Response(status=503, text="sin cámara")
    resp = web.StreamResponse(headers=cors(request, {
        "Content-Type": "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-cache",
    }))
    await resp.prepare(request)
    try:
        while True:
            jpg = await asyncio.get_running_loop().run_in_executor(None, grab)
            if jpg:
                await resp.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                 + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
            await asyncio.sleep(1 / 12)
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    return resp

async def camera_snapshot(request):
    grab = open_camera()
    if not grab:
        return web.Response(status=503, text="sin cámara")
    jpg = await asyncio.get_running_loop().run_in_executor(None, grab)
    return web.Response(body=jpg, content_type="image/jpeg")

async def ai_proxy(request):
    key = request.headers.get("X-Ollama-Key", "")
    body = await request.read()
    async with ClientSession() as s:
        async with s.post("https://ollama.com/api/chat", data=body,
                          headers={"Authorization": "Bearer " + key,
                                   "Content-Type": "application/json"}) as r:
            return web.Response(body=await r.read(), status=r.status,
                                content_type="application/json")

# ---- administración de la Pi ----------------------------------------------
def net_mode():
    """¿La Pi está emitiendo hotspot o conectada a una red?"""
    ok, out = run(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"])
    if not ok:
        return {"mode": "desconocido", "ssid": "", "detail": out}
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) >= 2 and parts[1] == "802-11-wireless":
            name = parts[0]
            is_ap = name == HOTSPOT_NAME
            if not is_ap:
                ok2, m = run(["nmcli", "-t", "-f", "802-11-wireless.mode", "connection", "show", name])
                is_ap = ok2 and m.strip().endswith("ap")
            return {"mode": "hotspot" if is_ap else "cliente", "ssid": name, "detail": ""}
    return {"mode": "sin wifi", "ssid": "", "detail": out}

def ips():
    ok, out = run(["hostname", "-I"])
    return out.split() if ok else []

async def system_status(request):
    """Todo lo que necesitas saber de la Pi sin conectarle un monitor."""
    def read(path, cast=str, default=None):
        try:
            with open(path) as f: return cast(f.read().strip())
        except Exception: return default

    temp = read("/sys/class/thermal/thermal_zone0/temp", lambda v: round(int(v) / 1000, 1))
    up = read("/proc/uptime", lambda v: float(v.split()[0]), 0)
    du = shutil.disk_usage("/")
    ok_svc, svc = run(["systemctl", "is-active", SERVICE_NAME + ".service"])
    ok_rev, rev = run(["systemctl", "is-active", "kaax-revert.timer"])
    ok_git, gitrev = run(["git", "-C", os.path.join(HERE, ".."), "rev-parse", "--short", "HEAD"])

    return web.json_response({
        "hostname": os.uname().nodename,
        "robot_id": request.app["id"],
        "uptime_s": int(up or 0),
        "temp_c": temp,
        "disk_free_gb": round(du.free / 1e9, 1),
        "disk_total_gb": round(du.total / 1e9, 1),
        "load": os.getloadavg()[0],
        "service": svc.strip() if ok_svc or svc else "desconocido",
        "network": net_mode(),
        "ips": ips(),
        "tls": request.app["tls"],
        "revert_armed": rev.strip() == "active",
        "version": gitrev.strip() if ok_git else "",
        "clients": len(clients),
        "gps": {"port": gps_port, "fix": state["fix"], "satellites": gps_sats, "bytes": gps_bytes},
    })

async def system_logs(request):
    n = min(int(request.query.get("lines", 60)), 500)
    ok, out = run(["journalctl", "-u", SERVICE_NAME, "-n", str(n), "--no-pager", "--output", "short-iso"])
    if not ok or not out:
        ok, out = run(["journalctl", "-n", str(n), "--no-pager", "--output", "short-iso"])
    return web.json_response({"ok": ok, "lines": out.splitlines()[-n:]})

async def wifi_scan(request):
    need_token(request)
    run(["nmcli", "device", "wifi", "rescan"], timeout=20)
    ok, out = run(["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"], timeout=20)
    nets, seen = [], set()
    for line in out.splitlines() if ok else []:
        p = line.split(":")
        if p and p[0] and p[0] not in seen:
            seen.add(p[0])
            nets.append({"ssid": p[0], "signal": int(p[1]) if len(p) > 1 and p[1].isdigit() else 0,
                         "security": p[2] if len(p) > 2 else ""})
    nets.sort(key=lambda n: -n["signal"])
    return web.json_response({"ok": ok, "networks": nets[:20]})

def arm_revert(minutes):
    """Red de seguridad: si el cambio a tu red falla, la Pi vuelve sola al
    hotspot. Va como timer transitorio de systemd para que sobreviva aunque
    este proceso se caiga — que es justo cuando más falta hace."""
    run(["sudo", "-n", "systemctl", "stop", "kaax-revert.timer"])
    return run(["sudo", "-n", "systemd-run", "--unit=kaax-revert",
                f"--on-active={int(minutes)}min",
                "nmcli", "connection", "up", HOTSPOT_NAME])

async def system_action(request):
    need_token(request)
    body = await request.json()
    action = body.get("action", "")

    if action == "restart_service":
        ok, out = run(["sudo", "-n", "systemctl", "restart", SERVICE_NAME])
        return web.json_response({"ok": ok, "detail": out or "reiniciando…"})

    if action == "reboot":
        asyncio.get_running_loop().call_later(1, lambda: run(["sudo", "-n", "systemctl", "reboot"]))
        return web.json_response({"ok": True, "detail": "Reiniciando la Pi. Vuelve en ~40 s."})

    if action == "shutdown":
        asyncio.get_running_loop().call_later(1, lambda: run(["sudo", "-n", "systemctl", "poweroff"]))
        return web.json_response({"ok": True, "detail": "Apagando. Espera a que el LED verde deje de parpadear antes de cortar la corriente."})

    if action == "wifi_hotspot":
        run(["sudo", "-n", "systemctl", "stop", "kaax-revert.timer"])
        ok, out = run(["sudo", "-n", "nmcli", "connection", "up", HOTSPOT_NAME], timeout=30)
        return web.json_response({"ok": ok, "detail": out or f"Hotspot {HOTSPOT_NAME} arriba."})

    if action == "wifi_client":
        ssid = (body.get("ssid") or "").strip()
        if not ssid:
            return web.json_response({"error": "Falta el nombre de la red (ssid)."}, status=400)
        mins = max(1, min(int(body.get("revert_minutes", 5)), 60))
        # Armar el regreso ANTES de cambiar: si el cambio te deja sin acceso,
        # ya no puedes pedirle nada a la Pi.
        arm_revert(mins)
        psk = body.get("psk") or ""
        cmd = ["sudo", "-n", "nmcli", "device", "wifi", "connect", ssid]
        if psk:
            cmd += ["password", psk]
        ok, out = run(cmd, timeout=45)
        return web.json_response({
            "ok": ok, "detail": out,
            "note": f"Vuelvo al hotspot en {mins} min salvo que confirmes con 'cancel_revert'.",
        })

    if action == "cancel_revert":
        ok, out = run(["sudo", "-n", "systemctl", "stop", "kaax-revert.timer"])
        return web.json_response({"ok": ok, "detail": "Regreso automático cancelado. La Pi se queda en esta red."})

    if action == "update":
        ok, out = run(["git", "-C", os.path.join(HERE, ".."), "pull", "--ff-only"], timeout=60)
        if ok:
            asyncio.get_running_loop().call_later(1, lambda: run(["sudo", "-n", "systemctl", "restart", SERVICE_NAME]))
        return web.json_response({"ok": ok, "detail": out})

    return web.json_response({"error": f"Acción desconocida: {action}"}, status=400)

# ---- GUI de respaldo -------------------------------------------------------
FALLBACK = """<!doctype html><meta charset=utf-8>
<title>Kaax · Pi lista</title>
<style>body{font:16px/1.6 system-ui;margin:0;display:grid;place-items:center;
height:100vh;background:#f4fbfd;color:#023e58;text-align:center;padding:24px}
code{background:#e6f7fb;padding:2px 6px;border-radius:4px}</style>
<div><h1>Kaax · la Pi está lista</h1>
<p>Esta Raspberry no tiene copia de la interfaz, y no le hace falta.</p>
<p>Abre la GUI donde la tengas publicada y, en <b>Ajustes → Raspberry</b>,
pon esta dirección:</p><p><code id=u></code></p>
<p style=opacity:.7>Los endpoints <code>/ws</code>, <code>/api/system</code> y
<code>/camera/stream</code> están funcionando.</p></div>
<script>document.getElementById('u').textContent=location.origin</script>"""

async def index(request):
    f = os.path.join(DOCS, "index.html")
    if os.path.exists(f):
        return web.FileResponse(f)
    return web.Response(text=FALLBACK, content_type="text/html")

async def ca_cert(request):
    """Descarga del certificado raíz, para instalarlo en laptop y teléfono."""
    f = os.path.join(CERT_DIR, "kaax-ca.crt")
    if not os.path.exists(f):
        return web.Response(status=404, text="Aún no hay CA. Corre pi/setup_tls.sh en la Pi.")
    return web.FileResponse(f, headers={
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": 'attachment; filename="kaax-ca.crt"',
    })

# ---- arranque --------------------------------------------------------------
def build_app(robot_id, tls):
    app = web.Application(middlewares=[cors_mw])
    app["id"] = robot_id
    app["tls"] = tls
    app.add_routes([
        web.get("/ws", ws_handler),
        web.post("/api/ai", ai_proxy),
        web.get("/api/gps", gps_status),
        web.get("/api/system", system_status),
        web.get("/api/system/logs", system_logs),
        web.get("/api/system/wifi", wifi_scan),
        web.post("/api/system/action", system_action),
        web.get("/camera/stream", camera_stream),
        web.get("/camera/snapshot", camera_snapshot),
        web.get("/ca.crt", ca_cert),
        web.get("/", index),
    ])
    # docs/ es opcional: sin ella el script debe seguir vivo, no caerse al
    # arrancar como pasaba antes (ValueError: '.../docs' does not exist).
    if os.path.isdir(DOCS):
        app.router.add_static("/", DOCS, show_index=False)
    else:
        print("Nota: no hay carpeta docs/. Sirvo solo la API; abre la GUI publicada.")
    return app

def ssl_context():
    crt, key = os.path.join(CERT_DIR, "kaax.crt"), os.path.join(CERT_DIR, "kaax.key")
    if not (os.path.exists(crt) and os.path.exists(key)):
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    return ctx

async def run_servers(robot_id, http_port, https_port):
    ctx = ssl_context()
    app = build_app(robot_id, tls=bool(ctx))
    runner = web.AppRunner(app)
    await runner.setup()

    await web.TCPSite(runner, "0.0.0.0", http_port).start()
    print(f"HTTP  en http://0.0.0.0:{http_port}")
    if ctx:
        await web.TCPSite(runner, "0.0.0.0", https_port, ssl_context=ctx).start()
        print(f"HTTPS en https://0.0.0.0:{https_port}  ← usa esta desde GitHub Pages")
    else:
        print("Sin certificados: solo http. Corre pi/setup_tls.sh para habilitar wss://\n"
              "  (sin TLS, la GUI de GitHub Pages NO podrá conectarse por bloqueo de contenido mixto)")

    print(f"Token de administración: {TOKEN}")
    asyncio.create_task(telemetry(app))
    await asyncio.Event().wait()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", default="01")
    ap.add_argument("--http", type=int, default=8080)
    ap.add_argument("--https", type=int, default=8443)
    ap.add_argument("--no-camera", action="store_true")
    a = ap.parse_args()

    if not a.no_camera:
        open_camera()
    apply(); time.sleep(3)                 # armar los ESC en neutral
    print(f"KAAX robot {a.id} listo")
    try:
        asyncio.run(run_servers(a.id, a.http, a.https))
    except KeyboardInterrupt:
        state["R"] = state["L"] = NEUTRAL; apply()
        print("\nAlto y salida.")

if __name__ == "__main__":
    main()
