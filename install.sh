#!/usr/bin/env bash
# Inox installer.  Usage:
#   curl -fsSL https://raw.githubusercontent.com/CREVIOS/inox/main/install.sh | bash
# Env overrides: INOX_REPO, INOX_HOME (default ~/.inox), INOX_BIN (default ~/.local/bin)
set -euo pipefail

REPO="${INOX_REPO:-https://github.com/CREVIOS/inox.git}"
HOME_DIR="${INOX_HOME:-$HOME/.inox}"
BIN_DIR="${INOX_BIN:-$HOME/.local/bin}"

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js >= 22 is required — https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js >= 22 required (found $(node -v))"

say "Fetching Inox into $HOME_DIR"
if [ -d "$HOME_DIR/.git" ]; then
  git -C "$HOME_DIR" pull --ff-only --quiet
else
  rm -rf "$HOME_DIR"
  git clone --depth 1 --quiet "$REPO" "$HOME_DIR"
fi

cd "$HOME_DIR"
say "Installing dependencies"
npm install --silent --no-audit --no-fund
say "Building"
npm run build --silent
chmod +x "$HOME_DIR/dist/src/cli.js"

mkdir -p "$BIN_DIR"
ln -sf "$HOME_DIR/dist/src/cli.js" "$BIN_DIR/inox"

printf '\033[1;32m✓ Inox installed:\033[0m %s\n' "$BIN_DIR/inox"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '  Add to your shell rc:  \033[1mexport PATH="%s:$PATH"\033[0m\n' "$BIN_DIR" ;;
esac
"$BIN_DIR/inox" --help | head -1 || true
say "Try:  inox init --force && inox generate --out sdk"
