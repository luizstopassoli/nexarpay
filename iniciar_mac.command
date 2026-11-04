#!/bin/bash
# NexarPay — inicia o servidor local e abre o navegador
cd "$(dirname "$0")"
PORT=$(python3 -c "import json;print(json.load(open('config.json')).get('porta',8765))" 2>/dev/null || echo 8765)
echo "Iniciando NexarPay — Tudo Sob Controle. em http://localhost:$PORT ..."
( sleep 2 && open "http://localhost:$PORT/" ) &
python3 server.py
