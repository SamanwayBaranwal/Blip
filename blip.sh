#!/bin/zsh
# Blip control script.
#   ./blip.sh setup      first time on a new Mac: installs everything Blip needs
#   ./blip.sh install    build + start now + start automatically at every login
#   ./blip.sh restart    rebuild and restart (after editing .env or code)
#   ./blip.sh stop       stop until next install
#   ./blip.sh logs       follow the log
#   ./blip.sh status     is it running?
#   ./blip.sh link       show the app link + QR code to open on your phone
#   ./blip.sh remote     make the app reachable from anywhere over Tailscale (private HTTPS)
#   ./blip.sh app        build the Blip Mac app and put it in Applications
#   ./blip.sh backups    list the nightly backups
#   ./blip.sh restore F  put a backup back (the current data is kept aside first)
set -e
cd "${0:A:h}"
DIR="$PWD"
LABEL="com.blip.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)" # empty on a brand-new Mac until setup installs Node
DOMAIN="gui/$(id -u)"
PORT="$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-8787}"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"

# macOS blocks background apps from reading Desktop, Documents and Downloads, so the service can't run from there.
check_location() {
  case "$DIR" in
    "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
      echo "❌ Blip is in $DIR."
      echo "   macOS blocks background apps from Desktop, Documents and Downloads."
      echo "   Move it to your home folder, then run it from there:"
      echo "     mv \"$DIR\" ~/Blip && cd ~/Blip && ./blip.sh setup"
      exit 1 ;;
  esac
}

check_env() {
  [[ -f .env ]] || cp .env.example .env
  chmod 600 .env
}

show_link() {
  local code; code="$(cat data/app-access-code 2>/dev/null || true)"
  if [[ -z "$code" ]]; then echo "Start the app first: ./blip.sh install"; exit 1; fi
  local url=""
  if [[ -x "$TS" ]] && "$TS" serve status 2>/dev/null | grep -q "https://"; then
    url="$("$TS" serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1 | sed 's#/$##')"
  fi
  if [[ -z "$url" ]]; then
    local ip; ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)"
    url="http://$ip:$PORT"
    echo "ℹ️  Home Wi-Fi only. For anywhere-access, notifications and the mic, run: ./blip.sh remote"
  fi
  echo ""
  echo "📱 Open on your phone (scan or tap):  $url/login?code=$code"
  "$NODE" -e 'require("qrcode-terminal").generate(process.argv[1], { small: true })' "$url/login?code=$code"
  echo "Access code: $code"
}

need_node() {
  NODE="${NODE:-$(command -v node || true)}"
  [[ -n "$NODE" ]] || { echo "Node.js isn't installed yet. Run ./blip.sh setup first."; exit 1; }
}

# Starts the background service, waiting for an old copy to fully stop first (macOS refuses to load it twice).
load_service() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for i in {1..20}; do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || { sleep 2; launchctl bootstrap "$DOMAIN" "$PLIST"; }
}

write_plist() {
  need_node
  mkdir -p "$HOME/Library/LaunchAgents" logs
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/dist/main.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$DIR/logs/blip.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/blip.log</string>
</dict>
</plist>
EOF
}

case "$1" in
  setup)
    check_location
    if ! command -v brew >/dev/null; then
      echo "Install Homebrew first (one line, from https://brew.sh):"
      echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
      echo "Then open a new Terminal window and run ./blip.sh setup again."
      exit 1
    fi
    echo "▸ Installing tools (Node.js, click control, speech-to-text, audio)…"
    for pkg in node cliclick ffmpeg; do brew list "$pkg" >/dev/null 2>&1 || brew install "$pkg"; done
    # Speech-to-text. Homebrew renamed whisper-cpp to whisper.cpp; try the new name, then the old one.
    if ! command -v whisper-cli >/dev/null; then
      HOMEBREW_NO_AUTO_UPDATE=1 brew install whisper.cpp || HOMEBREW_NO_AUTO_UPDATE=1 brew install whisper-cpp || true
    fi
    if ! command -v whisper-cli >/dev/null; then
      echo "⚠️  Speech-to-text didn't install, so voice messages won't work yet."
      echo "   If Homebrew says a folder isn't writable, run: sudo chown -R \$(whoami) \$(brew --prefix)/share/man && brew install whisper.cpp"
    fi
    echo "▸ Installing app packages…"
    npm ci --no-fund --no-audit
    if [[ ! -f models/ggml-small.bin ]]; then
      echo "▸ Downloading the speech model (~470 MB, one time)…"
      mkdir -p models
      curl -L --fail -o models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
    fi
    check_env
    echo "▸ Building…"
    npm run build --silent
    echo ""
    echo "✅ Setup done. Next:"
    echo "   1. Sign in to Claude Code once on this Mac (Blip uses that login until you add an API key)."
    echo "   2. ./blip.sh install"
    ;;
  install)
    check_location
    check_env
    npm run build --silent
    write_plist
    load_service
    echo "✅ Started. It runs in the background and starts at every login."
    sleep 3; show_link
    ;;
  restart)
    check_location
    check_env
    npm run build --silent
    write_plist
    load_service # reloads the service settings too (launchd only reads them when loading)
    echo "🔄 Restarted."
    ;;
  stop)
    launchctl bootout "$DOMAIN/$LABEL" && echo "⏹ Stopped. Run ./blip.sh install to start again."
    ;;
  logs)
    tail -n 50 -f logs/blip.log
    ;;
  backups)
    ls -lh "${BACKUP_DIR:-$HOME/Blip-backups}" 2>/dev/null || echo "No backups yet. They're made every night at 03:30, or from Settings → This Mac → Back up now."
    ;;
  restore)
    # Puts a nightly backup back. The current data is kept aside first, so a restore can be undone.
    FILE="$2"
    [[ -f "$FILE" ]] || { echo "Usage: ./blip.sh restore ~/Blip-backups/blip-YYYY-MM-DD-HH-MM.tgz   (list them: ./blip.sh backups)"; exit 1; }
    STAMP="$(date +%Y%m%d-%H%M%S)"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    mkdir -p "restore-safety-$STAMP"
    [[ -d data ]] && mv data "restore-safety-$STAMP/"
    [[ -d workspace ]] && mv workspace "restore-safety-$STAMP/"
    tar -xzf "$FILE" -C "$DIR"
    echo "✅ Restored $FILE. Your previous data is in $DIR/restore-safety-$STAMP (delete it once you're happy)."
    if [[ -f "$PLIST" ]]; then load_service; echo "🔄 Blip is starting again."; else echo "Start it with ./blip.sh install"; fi
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "Not installed."
    ;;
  link)
    need_node
    show_link
    ;;
  app)
    if ! command -v swiftc >/dev/null; then
      echo "Install Apple's command line tools first (one time): xcode-select --install"
      exit 1
    fi
    B="$DIR/dist-mac/Blip.app"
    rm -rf "$DIR/dist-mac" && mkdir -p "$B/Contents/MacOS" "$B/Contents/Resources"
    echo "▸ Building Blip.app…"
    swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13" mac-app/main.swift -o "$B/Contents/MacOS/Blip" \
      -framework Cocoa -framework WebKit -framework UserNotifications
    sed "s#__BLIP_HOME__#$DIR#" mac-app/Info.plist > "$B/Contents/Info.plist"
    cp mac-app/Blip.icns "$B/Contents/Resources/Blip.icns"
    codesign --force --deep --sign - "$B" >/dev/null
    DEST="/Applications"; [[ -w "$DEST" ]] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
    osascript -e 'quit app "Blip"' >/dev/null 2>&1 || true
    rm -rf "$DEST/Blip.app" && ditto "$B" "$DEST/Blip.app"
    echo "✅ Installed $DEST/Blip.app — opening it. Right-click its Dock icon → Options → Keep in Dock."
    open "$DEST/Blip.app"
    ;;
  remote)
    if [[ ! -x "$TS" ]]; then
      echo "Install Tailscale first (free): https://tailscale.com/download/mac — sign in, and install it on your phone with the same account."
      exit 1
    fi
    need_node
    "$TS" serve --bg "$PORT"
    echo "✅ Private HTTPS link is on (only your own Tailscale devices can reach it)."
    show_link
    ;;
  *)
    echo "Usage: ./blip.sh setup | install | restart | stop | logs | status | link | remote | app | backups | restore <file>"
    ;;
esac
