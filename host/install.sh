#!/usr/bin/env bash
# Instala o native messaging host:
# 1. Copia host files pra $INSTALL_DIR (default: ~/.kaltura-lecture-host/)
# 2. Gera manifest do Chrome Native Messaging apontando pra lá
# 3. Instala em ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
#
# macOS Sequoia (Darwin 25) bloqueia exec em ~/Desktop/, ~/Downloads/, ~/Documents/
# — por isso a cópia pra $HOME/.<hidden>/.
#
# Uso:
#   ./install.sh
#   EXTENSION_ID=abc123... ./install.sh
#   INSTALL_DIR=/custom/path ./install.sh
set -euo pipefail

HOST_NAME="${HOST_NAME:-com.your.host}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.kaltura-lecture-host}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Paths específicos de macOS
# Linux equivalente: ~/.config/google-chrome/NativeMessagingHosts/
CHROME_NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

echo "==> Copiando host pra $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp "$SRC_DIR/host.py" "$SRC_DIR/host.sh" "$INSTALL_DIR/"
cp -r "$SRC_DIR/core" "$INSTALL_DIR/"
# adapters/ é opcional (Phase 2+); ignora se não existir
[ -d "$SRC_DIR/adapters" ] && cp -r "$SRC_DIR/adapters" "$INSTALL_DIR/"
# __init__.py precisa estar presente pra o pacote Python funcionar
[ -f "$SRC_DIR/__init__.py" ] && cp "$SRC_DIR/__init__.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/host.sh"

# Extension ID: env var ou placeholder
if [ -z "${EXTENSION_ID:-}" ]; then
  echo "==> EXTENSION_ID não definido. Usando placeholder {{YOUR_EXTENSION_ID}}."
  echo "    Edite $CHROME_NM_DIR/$HOST_NAME.json manualmente OU re-rode com"
  echo "    EXTENSION_ID=<id> ./install.sh"
  EXTENSION_ID="{{YOUR_EXTENSION_ID}}"
fi

echo "==> Gerando native messaging manifest em $CHROME_NM_DIR/$HOST_NAME.json"
mkdir -p "$CHROME_NM_DIR"
sed \
  -e "s|{{HOST_PATH}}|$INSTALL_DIR/host.sh|g" \
  -e "s|{{YOUR_EXTENSION_ID}}|$EXTENSION_ID|g" \
  "$SRC_DIR/$HOST_NAME.json" > "$CHROME_NM_DIR/$HOST_NAME.json"

echo ""
echo "==> OK"
echo "    Host instalado em: $INSTALL_DIR"
echo "    Manifest em:       $CHROME_NM_DIR/$HOST_NAME.json"
if [ "$EXTENSION_ID" = "{{YOUR_EXTENSION_ID}}" ]; then
  echo ""
  echo "    ATENCAO: substitua {{YOUR_EXTENSION_ID}} no manifest instalado pelo"
  echo "    ID real da sua extensao (visivel em chrome://extensions)."
fi
