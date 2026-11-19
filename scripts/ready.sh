#!/bin/zsh
# "Make your Blip ready": the one-time walkthrough after install (./blip.sh ready, also run by install.sh).
# Everything Blip will ever need from this Mac is asked for here, in one sitting, so it never has to stop and
# ask later: Claude, staying awake, Calendar / Reminders / Contacts / Mail, the screen and the mouse, logins in
# Blip's browser, the link for your phone, and how much bots may do without approval cards.
# The permission requests are made by the running service (not by Terminal), so macOS gives them to Blip itself.
# Safe to run again any time: finished steps are checked and skipped.
#   BLIP_READY_YES=1     answer every question with its default (no keyboard needed)
#   BLIP_READY_DRYRUN=1  print what would open, restart or need your password instead of doing it (for tests)
cd "${0:A:h}/.."
DIR="$PWD"
DATA="${BLIP_DATA_ROOT:-$DIR}"
PORT="${BLIP_PORT:-$(grep -E '^WEB_PORT=' "$DATA/.env" 2>/dev/null | cut -d= -f2)}"; PORT="${PORT:-8787}"
NODE="$(command -v node || true)"
B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'; OK="${B}✓${R}"; NO="${B}✗${R}"

say() { print -r -- "$@"; }
step() { say ""; say "${B}$1/10 · $2${R}"; }
dry() { [[ -n "$BLIP_READY_DRYRUN" ]] && { say "${D}[dry run] $*${R}"; return 0; }; "$@"; }
# questions read the keyboard even when this runs from "curl … | zsh"
ask() { # ask "Question?" [default y|n]
  local d="${2:-y}" a
  if [[ -n "$BLIP_READY_YES" || ! -r /dev/tty ]]; then a="$d"; else read "a?$1 [$([[ $d == y ]] && echo Y/n || echo y/N)] " < /dev/tty; a="${a:-$d}"; fi
  [[ "$a" == [Yy]* ]]
}
pause() { [[ -n "$BLIP_READY_YES" || ! -r /dev/tty ]] && return; read "?${D}$1 Press Enter to continue.${R} " < /dev/tty; }
pane() { dry open "x-apple.systempreferences:com.apple.preference.security?$1"; }

CODE="$(cat "$DATA/data/app-access-code" 2>/dev/null)"
api() { # api METHOD /path [json]
  local body=(); [[ -n "$3" ]] && body=(--data "$3")
  curl -sS -m 180 -H "content-type: application/json" -b "blip=$CODE" -X "$1" "http://127.0.0.1:$PORT/api$2" "${body[@]}"
}
json() { "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.log(eval(process.argv[1]))}catch{console.log("")}})' "$1"; }
wait_up() {
  for i in {1..60}; do api GET /reach >/dev/null 2>&1 && return 0; sleep 1; done
  say "$NO Blip isn't answering on port $PORT. Start it with ./blip.sh install, then run ./blip.sh ready again."; exit 1
}
restart_blip() { dry launchctl kickstart -k "gui/$(id -u)/com.blip.agent"; sleep 3; wait_up; }

[[ -n "$NODE" ]] || { say "Node.js isn't installed yet. Run ./blip.sh setup first."; exit 1; }
[[ -n "$CODE" ]] || { say "Blip hasn't started yet. Run ./blip.sh install first."; exit 1; }
wait_up
say ""
say "${B}Make your Blip ready${R}"
say "Steps 1-3 (a Mac that stays on, the tools, the install) are done. This does the rest in one go,"
say "so Blip never has to stop and ask this Mac for anything later. About 10 minutes."

# ---------------------------------------------------------------- 4. Claude
step 4 "Connect Claude"
claude_ok() { security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 || grep -qE '^ANTHROPIC_API_KEY=.+' "$DATA/.env" 2>/dev/null; }
if claude_ok; then say "$OK Claude is connected."
else
  if ! command -v claude >/dev/null; then
    say "Installing Claude Code (Blip uses its sign-in)…"
    dry npm install -g @anthropic-ai/claude-code --no-fund --no-audit >/dev/null
  fi
  say "Open a new Terminal window, type ${B}claude${R}, sign in with your Claude account, then type /exit."
  say "${D}(Or add an Anthropic API key later in the app: Settings → Claude.)${R}"
  pause "When you've signed in:"
  claude_ok && say "$OK Claude is connected." || say "$NO Not signed in yet. Blip can't work until you do: run ./blip.sh ready again after."
fi

# ---------------------------------------------------------------- 5. stay awake
step 5 "Keep the Mac awake"
if pmset -g custom 2>/dev/null | grep -qE '^ sleep +0$' && pmset -g 2>/dev/null | grep -qE 'autorestart +1'; then say "$OK The Mac never sleeps on power and restarts after a power cut."
elif ask "Never sleep while plugged in, and start again after a power cut? (asks for your Mac password)"; then
  dry sudo pmset -c sleep 0 disksleep 0 autorestart 1 && say "$OK Done. The screen can still turn off."
else say "Skipped. Blip stops working while the Mac sleeps."; fi

# ---------------------------------------------------------------- 6 and 7. macOS permissions
step 6 "Allow Calendar, Reminders, Contacts and Mail"
say "Mail opens once so macOS can ask about it. Several ${B}Allow${R} popups will appear: click Allow on each."
dry open -ga Mail
sleep 2
pause "Ready for the popups?"
api POST /check-mac >/dev/null

step 7 "Allow the screen and the mouse"
say "Two System Settings panes open. In each, turn on ${B}node${R}."
say "${D}Not in the list? Click +, press Cmd+Shift+G, paste ${NODE:A} and click Open.${R}"
pane Privacy_ScreenCapture
pause "Screen & System Audio Recording: node on?"
pane Privacy_Accessibility
pause "Accessibility: node on?"
say "Restarting Blip so it picks these up…"
restart_blip
for try in 1 2 3; do
  result="$(api POST /check-mac)"
  say ""
  print -r -- "$result" | json 'v.checks.map(c => (c.ok ? "  ✓ " : "  ✗ ") + c.name + " · " + c.detail + (c.ok || !c.fix ? "" : "\n      fix: " + c.fix)).join("\n")'
  # voice is a tool, not a permission (setup installs it): only permissions are worth re-checking
  [[ "$(print -r -- "$result" | json 'v.checks.every(c => c.ok || c.name === "Voice messages")')" == true ]] && break
  [[ $try -lt 3 && -z "$BLIP_READY_YES" ]] && ask "Fix the ✗ items above, then check again?" || break
  [[ "$(print -r -- "$result" | json 'v.checks.some(c => !c.ok && /Screen|Mouse/.test(c.name))')" == true ]] && restart_blip
done

# ---------------------------------------------------------------- 8. logins
step 8 "Sign in to your sites"
say "Bots use their own Chrome profile. Sign in once to what they'll use (Gmail, Google Calendar, X, your work"
say "tools…) so they never hit a login page later. ${D}Using your own Chrome through the Playwright Extension"
say "instead? Install the extension in Chrome now and skip this.${R}"
if ask "Open Blip's Chrome to sign in?"; then
  dry open -na "Google Chrome" --args --user-data-dir="$DATA/data/browser-profile" --no-first-run "https://accounts.google.com"
  pause "Sign in, then close that Chrome window."
  dry pkill -f "user-data-dir=$DATA/data/browser-profile" 2>/dev/null
fi

# ---------------------------------------------------------------- 9. the phone
step 9 "Put Blip on your phone, from anywhere"
url="$(api GET /reach | json 'v.status === "on" ? v.url : ""')"
if [[ -n "$BLIP_READY_DRYRUN" ]]; then say "${D}[dry run] would turn on the public link${R}"; url="https://example.trycloudflare.com"
elif [[ -z "$url" ]]; then
  ts="$(api GET /reach | json 'v.tools.tailscale')"
  mode=cloudflare
  [[ "$ts" == true ]] && ask "Use Tailscale? Its link never changes (No = Cloudflare, no account needed)" && mode=tailscale
  api POST /reach "{\"mode\":\"$mode\"}" >/dev/null
  say "Turning on your link (a new link takes about a minute to work everywhere)…"
  for i in {1..90}; do
    r="$(api GET /reach)"; url="$(print -r -- "$r" | json 'v.status === "on" ? v.url : ""')"
    [[ -n "$url" ]] && break
    hint="$(print -r -- "$r" | json 'v.status === "error" ? (v.error || "error") : ""')"; [[ -n "$hint" ]] && { say "$NO $hint"; break; }
    if [[ "$(print -r -- "$r" | json 'v.status')" == needs-you && -z "$asked" ]]; then
      asked=1; say "$(print -r -- "$r" | json 'v.error')"
      enable="$(print -r -- "$r" | json 'v.enableUrl || ""')"; [[ -n "$enable" ]] && dry open "$enable"
      pause "When that's done:"; api POST /reach "{\"mode\":\"$mode\"}" >/dev/null
    fi
    sleep 2
  done
fi
if [[ -n "$url" ]]; then
  say "$OK Your link: $url"
  say "Scan this with your phone's camera:"
  "$NODE" -e 'require("qrcode-terminal").generate(process.argv[1], { small: true })' "$url/login?code=$CODE"
  say "Then: iPhone, Share → Add to Home Screen. Android, ⋮ → Install app. Open Blip from the Home Screen"
  say "and tap ${B}Allow${R} for notifications, so approvals and results reach you."
  [[ "$mode" == cloudflare || "$(api GET /reach | json 'v.permanent')" != true ]] && say "${D}A Cloudflare link changes when Blip restarts. Add your email in the app (Set up) and Blip emails you each new one.${R}"
  pause "When Blip is on your phone:"
else
  say "$NO The link didn't come up. Open Blip on this Mac and tap Set up to try again."
fi

# ---------------------------------------------------------------- 10. approvals
step 10 "How much Blip does without asking"
say "With ${B}full access${R}, bots just work: no approval cards for sending, deleting or booking."
say "Payments, protected files (keys, Blip's own data) and your own \"Ask first\" rules still ask. That's the safety net."
if ask "Turn on full access?"; then api PATCH /settings '{"fullAccess":true}' >/dev/null && say "$OK Full access is on. Change it any time in Settings."
else say "Kept the default: Blip asks before it sends, pays, deletes, books or accepts."; fi

api POST /reach/done >/dev/null
say ""
say "${B}Blip is ready.${R} Message it from your phone. Run ./blip.sh ready again any time to re-check."
