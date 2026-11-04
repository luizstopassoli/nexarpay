#!/bin/sh
# Backup diário do volume de dados (banco + anexos). Mantém 14 dias.
#   Produção (padrão):  ./backup.sh                    (volume nexarpay_nexarpay-data)
#   Demo:               VOLUME=nexarpay-demo_nexarpay-data ./backup.sh
# Opcionais (recomendados em produção), definidos no cron ou em ~/.nexarpay-backup.env:
#   BACKUP_AGE_RECIPIENT=age1...   criptografa o arquivo (instale: apt install age; gere a chave com age-keygen NO SEU MAC)
#   BACKUP_DESTINO=usuario@host:/pasta   copia para fora do servidor via scp (chave SSH sem senha só para isso)
# A chave de criptografia do sistema (secret.key / NEXARPAY_SECRET_KEY) NÃO entra no backup de propósito:
# guarde-a à parte (gerenciador de senhas). Sem ela, o backup não abre os dados cifrados.
set -eu
[ -f "$HOME/.nexarpay-backup.env" ] && . "$HOME/.nexarpay-backup.env"
VOLUME="${VOLUME:-nexarpay_nexarpay-data}"
umask 077
mkdir -p "$HOME/backups" && chmod 700 "$HOME/backups"
ARQ="nexarpay-$(date +%F).tar.gz"
docker run --rm -v "$VOLUME":/d:ro -v "$HOME/backups":/b alpine \
  tar czf "/b/$ARQ" --exclude=./secret.key -C /d .
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$HOME/backups/$ARQ.age" "$HOME/backups/$ARQ" && rm -f "$HOME/backups/$ARQ"
  ARQ="$ARQ.age"
else
  echo "AVISO: backup SEM criptografia (defina BACKUP_AGE_RECIPIENT)." >&2
fi
if [ -n "${BACKUP_DESTINO:-}" ]; then
  scp -q -o BatchMode=yes "$HOME/backups/$ARQ" "$BACKUP_DESTINO/" || echo "ERRO: falha ao copiar o backup para $BACKUP_DESTINO" >&2
else
  echo "AVISO: backup só no próprio servidor (defina BACKUP_DESTINO)." >&2
fi
find "$HOME/backups" -name 'nexarpay-*' -mtime +14 -delete
