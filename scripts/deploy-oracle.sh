#!/usr/bin/env bash
# Roda no SEU computador: gera o build, envia só o resultado para a VM e reinicia o serviço.
# A VM tem 1 GB de memória, então o build nunca é feito lá. O .env local NÃO é enviado.
#
#   bash scripts/deploy-oracle.sh
#
# Variáveis opcionais: DEPLOY_HOST (ubuntu@SEU_IP), DEPLOY_KEY (~/.ssh/id_ed25519)
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-ubuntu@SEU_IP}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
DIR=/srv/apps/rabiscadraw

npm run build:all

tar czf - dist dist-server | ssh -i "$KEY" -o BatchMode=yes "$HOST" "
  set -e
  sudo rm -rf $DIR/dist $DIR/dist-server
  sudo tar xzf - -C $DIR --no-same-owner --no-same-permissions
  sudo chown -R apps:apps $DIR
  sudo systemctl restart rabiscadraw
  sudo systemctl reload caddy
  sleep 2
  systemctl is-active rabiscadraw
"
echo "Publicado."
