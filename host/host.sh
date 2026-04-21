#!/usr/bin/env bash
# Wrapper pro host Python. Usado pelo native messaging manifest porque
# (1) scripts .py podem não ter permissão de exec dependendo do FS;
# (2) macOS Sequoia bloqueia exec em ~/Desktop/, e o installer copia
# este wrapper pra ~/.host-dir/ onde a restrição não se aplica.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Adiciona /usr/local/bin + /opt/homebrew/bin ao PATH pra encontrar ffmpeg
# quando invocado pelo Chrome (que roda com PATH mínimo).
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
exec python3 "$DIR/host.py" "$@"
