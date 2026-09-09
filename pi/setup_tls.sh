#!/usr/bin/env bash
# KAAX — certificados para que la GUI de GitHub Pages pueda hablarle a la Pi.
#
# El problema: la GUI es https y la Pi es http. Chrome bloquea https -> ws://
# sin aviso y sin forma de saltárselo. La única salida real es que la Pi hable
# TLS con un certificado en el que tu navegador confíe.
#
# Este script crea:
#   certs/kaax-ca.crt   la autoridad raíz — se instala UNA VEZ por dispositivo
#   certs/kaax-ca.key   su llave privada — se queda en la Pi y no sale de ahí
#   certs/kaax.crt/.key el certificado del servidor, válido para kaax.local,
#                       localhost y todas las IPs que tenga la Pi ahora
#
# Corre esto en la Pi:   bash pi/setup_tls.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"
mkdir -p "$DIR"; cd "$DIR"

HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
# La IP del hotspot de NetworkManager es siempre 10.42.0.1; añadimos también las
# que tenga la Pi ahora mismo, para que el certificado sirva en tu red de casa.
IPS="10.42.0.1 127.0.0.1 $(hostname -I 2>/dev/null || true)"

echo "==> Nombres que cubrirá el certificado:"
echo "    DNS: kaax.local, ${HOSTNAME_SHORT}.local, ${HOSTNAME_SHORT}, localhost"
echo "    IP : $(echo $IPS | tr ' ' ',')"

# ---- 1. la autoridad raíz (10 años; se instala una vez por dispositivo) ----
# Los identificadores de clave (SKI/AKI) NO son opcionales: sin ellos los
# verificadores estrictos rechazan la cadena con "Missing Authority Key
# Identifier" — y el fallo aparece como un WebSocket que no abre, sin más pista.
cat > ca-ext.cnf <<'CAEXT'
[ext]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
CAEXT

if [[ -f kaax-ca.key ]]; then
  echo "==> Ya existe una CA; la reutilizo (así no reinstalas nada en tus equipos)."
else
  echo "==> Creando la autoridad raíz Kaax…"
  openssl genrsa -out kaax-ca.key 4096 2>/dev/null
  openssl req -x509 -new -nodes -key kaax-ca.key -sha256 -days 3650 \
    -out kaax-ca.crt \
    -subj "/C=MX/O=DAY1 Robotics/CN=Kaax Local CA" \
    -extensions ext -config <(cat /etc/ssl/openssl.cnf 2>/dev/null; cat ca-ext.cnf)
fi

# ---- 2. certificado del servidor ------------------------------------------
# Dos configs a propósito: la petición (CSR) solo puede llevar el SAN, porque en
# ese momento todavía no hay emisor; el authorityKeyIdentifier solo se puede
# resolver al firmar. Meterlo en la CSR falla con "Error Loading extension".
SAN="DNS:kaax.local,DNS:${HOSTNAME_SHORT}.local,DNS:${HOSTNAME_SHORT},DNS:localhost"
for ip in $IPS; do SAN="${SAN},IP:${ip}"; done

cat > req.cnf <<REQ
[req]
distinguished_name=dn
req_extensions=ext
prompt=no
[dn]
C=MX
O=DAY1 Robotics
CN=kaax.local
[ext]
subjectAltName=${SAN}
REQ

cat > leaf-ext.cnf <<LEAF
[ext]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
subjectAltName=${SAN}
LEAF

openssl genrsa -out kaax.key 2048 2>/dev/null
openssl req -new -key kaax.key -out kaax.csr -config req.cnf
# 825 días es el máximo que aceptan los navegadores modernos para un cert de hoja.
openssl x509 -req -in kaax.csr -CA kaax-ca.crt -CAkey kaax-ca.key -CAcreateserial \
  -out kaax.crt -days 825 -sha256 -extfile leaf-ext.cnf -extensions ext

chmod 600 kaax.key kaax-ca.key
rm -f kaax.csr ca-ext.cnf req.cnf leaf-ext.cnf

echo
echo "==> Listo. Certificados en $DIR"
# -ext no existe en LibreSSL (macOS); -text funciona en todas las versiones.
openssl x509 -in kaax.crt -noout -dates | sed 's/^/    /'
openssl x509 -in kaax.crt -noout -text | grep -A1 "Subject Alternative Name" | tail -1 | sed 's/^ */    SAN: /' 
cat <<EOF

────────────────────────────────────────────────────────────────────────
FALTA UN PASO: instalar la CA en cada equipo desde el que uses la GUI.
Se hace una sola vez por dispositivo y dura 10 años.

Descárgala desde el navegador del equipo:   http://$(hostname -I | awk '{print $1}'):8080/ca.crt

  macOS   Doble clic en kaax-ca.crt → se abre Acceso a Llaveros → elige
          "Inicio de sesión" → búscalo, doble clic → Confiar →
          "Al usar este certificado: Confiar siempre". Pide tu contraseña.

  Windows Doble clic → Instalar certificado → Equipo local →
          "Colocar todos los certificados en el siguiente almacén" →
          Examinar → "Entidades de certificación raíz de confianza".

  Android Ajustes → Seguridad → Cifrado y credenciales →
          Instalar un certificado → Certificado de CA.

  iOS     Ábrelo en Safari → Ajustes → Perfil descargado → Instalar. Después,
          Ajustes → General → Información → Ajustes de confianza de
          certificados → activa Kaax Local CA. Este segundo paso es
          obligatorio; sin él iOS lo instala pero no confía.

Después reinicia el servicio para que tome los certificados:
  sudo systemctl restart ${KAAX_SERVICE:-kaax}

Y comprueba desde tu laptop (debe salir sin advertencia):
  https://kaax.local:8443/api/system
────────────────────────────────────────────────────────────────────────
EOF
