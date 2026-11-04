@echo off
REM NexarPay - inicia o servidor local e abre o navegador (requer Python 3 instalado)
cd /d "%~dp0"
set PORT=8765
echo Iniciando NexarPay - Tudo Sob Controle. em http://localhost:%PORT% ...
start "" http://localhost:%PORT%/
python server.py
