#!/usr/bin/env bash
# Roda DENTRO da VM Oracle (usuário com sudo). Idempotente: pode rodar de novo sem estragar nada.
# Cria a pasta, o serviço systemd e o site do Caddy do Rabiscadraw, no mesmo padrão do jogo de abordagens.
#
#   ssh ubuntu@SEU_IP 'bash -s' < scripts/install-oracle.sh
#
# Variáveis opcionais: PORT (3011), SITE_HOST (endereço público), APP_USER (apps)
set -euo pipefail

APP=rabiscadraw
PORT="${PORT:-3011}"
SITE_HOST="${SITE_HOST:-rabiscadraw.SEU-IP.sslip.io}"
APP_USER="${APP_USER:-apps}"
DIR="/srv/apps/$APP"
NODE_BIN="$(command -v node)"

[ -n "$NODE_BIN" ] || { echo "Node não encontrado na VM."; exit 1; }

# a porta tem que estar livre, a não ser que quem a use seja este próprio serviço
if ss -ltn | awk '{print $4}' | grep -q ":$PORT\$" && ! systemctl is-active --quiet "$APP"; then
  echo "A porta $PORT já está em uso por outro serviço. Rode com PORT=<outra>."
  exit 1
fi

sudo install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$DIR"

sudo tee "/etc/systemd/system/$APP.service" >/dev/null <<UNIT
[Unit]
Description=Rabiscadraw
After=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$DIR
ExecStart=$NODE_BIN dist-server/index.mjs
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=ALLOWED_HOSTS=$SITE_HOST
Environment=STATIC_DIR=$DIR/dist
MemoryMax=256M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT

# O servidor não guarda nada em disco e não tem chave de LLM: nenhum arquivo .env é usado.

sudo tee "/etc/caddy/sites/$APP" >/dev/null <<CADDY
$SITE_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
CADDY

if ! sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  echo "Configuração do Caddy inválida; removendo o site do Rabiscadraw para não afetar os outros."
  sudo rm -f "/etc/caddy/sites/$APP"
  exit 1
fi

sudo systemctl daemon-reload
sudo systemctl enable "$APP" >/dev/null 2>&1
echo "Instalado. Envie os arquivos com scripts/deploy-oracle.sh e o serviço sobe."
