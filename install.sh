#!/bin/zsh
# One-command install of Blip on a Mac:
#   curl -fsSL https://raw.githubusercontent.com/SamanwayBaranwal/blip/main/install.sh | zsh
# It puts Blip in ~/Blip (macOS blocks background apps in Desktop, Documents and Downloads), installs what it
# needs, starts it, and shows the link for your phone. Run it again any time to update.
set -e
REPO="${BLIP_REPO:-https://github.com/SamanwayBaranwal/blip.git}"
DEST="${BLIP_HOME:-$HOME/Blip}"

if [[ "$(uname)" != "Darwin" ]]; then echo "Blip runs on a Mac."; exit 1; fi
if ! command -v git >/dev/null; then
  echo "Git comes with Apple's command line tools. Install them (a window opens), then run this again:"
  echo "  xcode-select --install"
  exit 1
fi
if ! command -v brew >/dev/null; then
  echo "Blip needs Homebrew first (one line, from https://brew.sh):"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo "Then open a new Terminal window and run this again."
  exit 1
fi

if [[ -d "$DEST/.git" ]]; then
  echo "▸ Updating Blip in $DEST…"
  git -C "$DEST" pull --ff-only
else
  echo "▸ Downloading Blip into $DEST…"
  git clone --depth 1 "$REPO" "$DEST"
fi
cd "$DEST"
./blip.sh setup
./blip.sh install
echo ""
echo "Next: sign in to Claude Code once on this Mac (Blip uses that login), then open the link above on your phone."
echo "In the app: Settings → This Mac → Check Mac access, to allow Calendar, Reminders, Contacts and Mail."
