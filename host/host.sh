#!/usr/bin/env bash
# Wrapper pro native messaging host. Hardcoda --native-messaging porque o Chrome
# só passa chrome-extension://ID/ + --parent-window=0 como args — não sinaliza
# que é modo NM. Sem a flag, o host cai em CLI e erra imediatamente.
#
# Também loga stderr do Python em $DIR/debug.log pra ajudar debug em caso
# de falha (o Chrome só reporta "Native host has exited" sem detalhes).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/debug.log"
# Adiciona /opt/homebrew/bin e /usr/local/bin ao PATH pra encontrar ffmpeg
# quando invocado pelo Chrome (PATH mínimo).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "[$(date +%H:%M:%S)] === host invoked args=$*" >> "$LOG"
echo "[$(date +%H:%M:%S)] which python3=$(which python3)" >> "$LOG"

exec python3 "$DIR/host.py" --native-messaging "$@" 2>>"$LOG"
