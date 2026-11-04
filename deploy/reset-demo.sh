#!/bin/sh
# SOMENTE DEMO - recusa rodar sem NEXARPAY_CONFIRMA_DEMO=1 (evita apagar produção por engano).
# Zera a demonstração (apaga o volume de dados e recria usuários/dados fictícios).
# Agende no cron do servidor, ex.: 0 4 * * *  /caminho/deploy/reset-demo.sh
[ "$NEXARPAY_CONFIRMA_DEMO" = "1" ] || { echo "Defina NEXARPAY_CONFIRMA_DEMO=1 (script destrutivo, só para a demo)"; exit 1; }
cd "$(dirname "$0")/.." || exit 1
COMPOSE="${COMPOSE_FILE_DEMO:-docker-compose.demo.yml}"   # no servidor compartilhado: COMPOSE_FILE_DEMO=docker-compose.compartilhado.yml
docker compose -f "$COMPOSE" stop app
docker run --rm -v nexarpay-demo_nexarpay-data:/d alpine sh -c 'rm -rf /d/*'
docker compose -f "$COMPOSE" up -d app
