#!/usr/bin/env python3
"""
KAAX — Plan B: Raspberry Pi as ground station.

  Heltec BASE (USB) <-> this script <-> WebSocket <-> GUI (any browser on the LAN)

Why: Web Serial only works in Chrome/Edge on a laptop. With the Pi you can open
the GUI from a phone/tablet, or keep the base far from the laptop.

Run:   python3 pi_bridge.py [--port /dev/ttyUSB0] [--http 8080]
Open:  http://kaax.local:8080   (GUI served from ../docs — same files as GitHub Pages)
Set Ajustes → Transporte = "Raspberry Pi · WebSocket", URL = ws://kaax.local:8080/ws

Also exposes POST /api/ai → https://ollama.com/api/chat (header X-Ollama-Key)
so the GUI can use Ollama Cloud even if the browser blocks the direct call.
"""
import argparse, asyncio, glob, json, os, ssl, sys
import serial            # pyserial
from aiohttp import web, ClientSession

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")
CERT_DIR = os.path.join(HERE, "certs")
clients = set()

def find_port(explicit):
    if explicit: return explicit
    for pat in ("/dev/ttyUSB*", "/dev/ttyACM*", "/dev/cu.usbserial*", "/dev/cu.SLAB*"):
        m = glob.glob(pat)
        if m: return m[0]
    sys.exit("No Heltec found. Plug the base station in or pass --port.")

async def serial_reader(app):
    ser = app["ser"]
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, ser.readline)
        if not line: continue
        txt = line.decode(errors="ignore").strip()
        if not txt: continue
        print("<-", txt)
        dead = []
        for ws in clients:
            try: await ws.send_str(txt)
            except Exception: dead.append(ws)
        for ws in dead: clients.discard(ws)

async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    clients.add(ws)
    print("GUI connected", request.remote)
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                for l in msg.data.split("\n"):
                    l = l.strip()
                    if l:
                        print("->", l)
                        request.app["ser"].write((l + "\n").encode())
    finally:
        clients.discard(ws)
        print("GUI disconnected")
    return ws

async def ai_proxy(request):
    key = request.headers.get("X-Ollama-Key", "")
    body = await request.read()
    async with ClientSession() as s:
        async with s.post("https://ollama.com/api/chat", data=body,
                          headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}) as r:
            return web.Response(body=await r.read(), status=r.status, content_type="application/json")

async def index(request):
    f = os.path.join(DOCS, "index.html")
    if os.path.exists(f):
        return web.FileResponse(f)
    return web.Response(text="Kaax bridge activo. Abre la GUI publicada y apunta "
                             "Ajustes -> Raspberry a " + str(request.url.origin()),
                        content_type="text/plain")

async def ca_cert(request):
    f = os.path.join(CERT_DIR, "kaax-ca.crt")
    if not os.path.exists(f):
        return web.Response(status=404, text="Corre pi/setup_tls.sh primero.")
    return web.FileResponse(f, headers={"Content-Type": "application/x-x509-ca-cert",
                                        "Content-Disposition": 'attachment; filename="kaax-ca.crt"'})

@web.middleware
async def cors_mw(request, handler):
    """La GUI ahora puede vivir en GitHub Pages, o sea otro origen."""
    h = {"Access-Control-Allow-Origin": request.headers.get("Origin", "*"),
         "Access-Control-Allow-Headers": "Content-Type, X-Ollama-Key, X-Kaax-Token",
         "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin"}
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=h)
    resp = await handler(request)
    for k, v in h.items():
        resp.headers.setdefault(k, v)
    return resp

def ssl_context():
    crt, key = os.path.join(CERT_DIR, "kaax.crt"), os.path.join(CERT_DIR, "kaax.key")
    if not (os.path.exists(crt) and os.path.exists(key)):
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    return ctx

async def run_servers(app, http_port, https_port):
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", http_port).start()
    print(f"HTTP  en http://0.0.0.0:{http_port}")
    ctx = ssl_context()
    if ctx:
        await web.TCPSite(runner, "0.0.0.0", https_port, ssl_context=ctx).start()
        print(f"HTTPS en https://0.0.0.0:{https_port}  <- usa esta desde GitHub Pages")
    else:
        print("Sin certificados: solo http. Corre pi/setup_tls.sh para habilitar wss://")
    asyncio.create_task(serial_reader(app))
    await asyncio.Event().wait()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port"); ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--http", type=int, default=8080)
    ap.add_argument("--https", type=int, default=8443)
    a = ap.parse_args()
    port = find_port(a.port)
    app = web.Application(middlewares=[cors_mw])
    app["ser"] = serial.Serial(port, a.baud, timeout=1)
    print("Estación base en", port)
    app.add_routes([web.get("/ws", ws_handler), web.post("/api/ai", ai_proxy),
                    web.get("/ca.crt", ca_cert), web.get("/", index)])
    # docs/ es opcional: sin ella el bridge sigue vivo y sirve solo la API.
    if os.path.isdir(DOCS):
        app.router.add_static("/", DOCS, show_index=False)
    else:
        print("Nota: no hay carpeta docs/. Sirvo solo la API.")
    try:
        asyncio.run(run_servers(app, a.http, a.https))
    except KeyboardInterrupt:
        print("\nSalida.")

if __name__ == "__main__":
    main()
