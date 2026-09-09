#!/usr/bin/env bash
# KAAX — instalación completa en la Raspberry Pi 5 (Bookworm).
#
# Deja la Pi lista para trabajar sin monitor ni teclado:
#   · dependencias de Python
#   · hotspot Kaax que se levanta solo al arrancar
#   · certificados TLS (para que la GUI de GitHub Pages pueda conectarse)
#   · servicio systemd con la RUTA REAL, detectada, no adivinada
#   · permisos sudo mínimos para que la GUI pueda reiniciar y cambiar de red
#   · kaax.local por mDNS
#
# Corre:   bash pi/install.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"      # .../kaax/pi
ROOT="$(cd "$HERE/.." && pwd)"                            # .../kaax
USER_NAME="${SUDO_USER:-$(whoami)}"
ROBOT_ID="${KAAX_ID:-01}"
SSID="${KAAX_SSID:-Kaax}"
PSK="${KAAX_PSK:-kaax2026}"
HOTSPOT="Kaax-Hotspot"
SERVICE="kaax"

echo "==> Usuario   : $USER_NAME"
echo "==> Proyecto  : $ROOT"
echo "==> Robot ID  : $ROBOT_ID"

if [[ ! -f "$HERE/pi_robot.py" ]]; then
  echo "!! No encuentro pi_robot.py junto a este script. Aborto." >&2; exit 1
fi

# ---- 1. dependencias -------------------------------------------------------
echo; echo "==> Instalando dependencias…"
sudo apt-get update -qq
sudo apt-get install -y -qq python3-pip python3-lgpio avahi-daemon openssl git
# --break-system-packages: Bookworm marca el Python del sistema como gestionado.
pip3 install -r "$HERE/requirements.txt" --break-system-packages --quiet

# ---- 2. serie para el GPS --------------------------------------------------
echo; echo "==> Habilitando el UART para el GPS…"
sudo raspi-config nonint do_serial_hw 0   || echo "   (ajusta el serial a mano si esto falló)"
sudo raspi-config nonint do_serial_cons 1 || true   # consola de login FUERA del puerto

# ---- 3. hotspot que arranca solo -------------------------------------------
# autoconnect yes es la clave: NetworkManager lo vuelve a levantar en cada
# arranque, sin servicio aparte. Se recrea desde cero para evitar el perfil a
# medias que queda tras un apagado sucio.
echo; echo "==> Configurando el hotspot $SSID…"
sudo nmcli connection delete "$HOTSPOT" 2>/dev/null || true
sudo nmcli connection add type wifi ifname wlan0 con-name "$HOTSPOT" ssid "$SSID"
sudo nmcli connection modify "$HOTSPOT" \
  802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.channel 6 \
  ipv4.method shared \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PSK" \
  connection.autoconnect yes connection.autoconnect-priority 100

# ---- 4. certificados TLS ---------------------------------------------------
echo; echo "==> Generando certificados…"
bash "$HERE/setup_tls.sh"

# ---- 5. permisos sudo acotados ---------------------------------------------
# La GUI necesita reiniciar el servicio y cambiar de red. En vez de correr todo
# como root, damos permiso sin contraseña solo a estos comandos concretos.
echo; echo "==> Permisos sudo mínimos…"
sudo tee /etc/sudoers.d/kaax > /dev/null <<EOF
# Generado por kaax/pi/install.sh — permisos mínimos para la API de administración
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE, \\
  /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, \\
  /usr/bin/systemctl stop kaax-revert.timer, \\
  /usr/bin/systemd-run --unit=kaax-revert *, \\
  /usr/bin/nmcli *
EOF
sudo chmod 440 /etc/sudoers.d/kaax
sudo visudo -c -f /etc/sudoers.d/kaax

# Leer los logs del servicio sin ser root.
sudo usermod -aG adm,systemd-journal,dialout,gpio "$USER_NAME" 2>/dev/null || true

# ---- 6. servicio systemd ---------------------------------------------------
# WorkingDirectory sale de $HERE, que es la ruta real donde está este script.
# Así no se repite el fallo 200/CHDIR de rutas escritas a mano.
echo; echo "==> Instalando el servicio $SERVICE…"
sudo tee /etc/systemd/system/$SERVICE.service > /dev/null <<EOF
[Unit]
Description=KAAX robot $ROBOT_ID
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$HERE
# Sin esto Python retiene stdout en un buffer y journalctl -f no muestra nada
# hasta que se llena: justo lo que hace imposible depurar en vivo.
Environment=PYTHONUNBUFFERED=1
ExecStartPre=/bin/sleep 8
ExecStart=/usr/bin/python3 $HERE/pi_robot.py --id $ROBOT_ID
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now $SERVICE.service
sleep 3

# ---- 7. mDNS: kaax.local ---------------------------------------------------
echo; echo "==> Publicando kaax.local…"
sudo hostnamectl set-hostname kaax 2>/dev/null || true
sudo systemctl enable --now avahi-daemon

# ---- 8. resumen ------------------------------------------------------------
IP="$(hostname -I | awk '{print $1}')"
TOKEN="$(cat "$HERE/kaax_token.txt" 2>/dev/null || echo '(se crea al primer arranque)')"
echo
echo "════════════════════════════════════════════════════════════════"
systemctl is-active --quiet $SERVICE \
  && echo "  Servicio      ✓ corriendo" \
  || { echo "  Servicio      ✗ FALLÓ — mira: sudo journalctl -u $SERVICE -n 40 --no-pager"; }
echo "  Hotspot       $SSID / $PSK  (canal 6, 2.4 GHz)"
echo "  Direcciones   https://kaax.local:8443   https://10.42.0.1:8443"
echo "  CA para tus   http://$IP:8080/ca.crt"
echo "  dispositivos  (instálala una vez por equipo — ver arriba)"
echo
echo "  Token de administración (pégalo en Ajustes → Raspberry):"
echo "      $TOKEN"
echo "════════════════════════════════════════════════════════════════"
echo
echo "  Comandos útiles:"
echo "    sudo journalctl -u $SERVICE -f      ver logs en vivo"
echo "    sudo systemctl restart $SERVICE     reiniciar"
echo "    sudo nmcli connection up $HOTSPOT   forzar el hotspot"
