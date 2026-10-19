# Blip

Your own always-on AI agents, running on your Mac and controlled from your phone, in the style of xAI's Grok Bot and ChatGPT's Dots.

Meet **Blip**: a mouse pointer that came alive and does things on your computer for you. It's the app's mascot, and it shows what each bot is doing. It bobs while idle, clicks away while working, holds up a "!" when it needs you, and celebrates when a task is done. Every bot can dress its own Blip: body colors, hats (including a ₿ cap and a crown), glasses and shades, mustaches and beards, a ₿ chain or bow tie, and something to hold, like a Bitcoin coin or coffee.

Every bot has the Mac as its computer: a terminal, files, a real Chrome browser, and control of Mac apps. You talk to your bots in the Blip app (installed on your phone's Home Screen) or, optionally, Telegram. Risky actions come to you as approval cards first.

## Quick start

On the Mac that will run Blip (it should stay on and logged in):

```bash
curl -fsSL https://raw.githubusercontent.com/SamanwayBaranwal/blip/main/install.sh | zsh
```

It installs Blip in `~/Blip`, starts it, and prints a link for your phone. Then sign in to Claude Code once on that Mac. In the app, open **Settings → This Mac → Check Mac access** to allow Calendar, Reminders, Contacts and Mail. Running the same line again updates Blip.

Want to add a skill, a tool or a connector? See [CONTRIBUTING.md](CONTRIBUTING.md).

## What it does

- **Several bots** with their own name, job, personality, model, memory and conversation. A primary bot runs proactive check-ins, and bots can hand work to each other.
- **A live progress view** that shows each task's plan and every step as it happens. You can steer a bot mid-task or stop it.
- **Approval cards**: Allow once / Allow for this task / Always allow / Deny.
- **Auto Review**: an independent AI check on risky actions.
- **"Ask first" rules**, and a guard built into the code that always asks before anything that sends, pays, deletes, books or accepts.
- **Drafts** you can edit, then send or discard.
- **Take over**: watch the Mac's screen live from your phone and take control for passwords, codes and payments.
- **Routines** that run on a schedule, with test runs, plus starter templates.
- **Skills** you teach once and reuse. **Connectors** (MCP servers) with read, full or off access.
- **Proactive suggestions**, read-only and at most 3 a day.
- **A secrets vault**: a bot asks for a password or API key on a masked card, and it's saved in the Mac's Keychain. Bots only ever see a placeholder like `{{secret:github-token}}`. Blip fills in the real value when an action runs, after you approve it, and scrubs it from anything a tool sends back. Manage your secrets in **Settings → Secrets**.
- **Files panel**, **editable memory**, 👍/👎 feedback, **voice in and out**, **push notifications**, activity history and an action log.
- **Runs on your Claude plan** with no API key, or on an Anthropic API key with a daily spending limit.
- **Replies stream in** word by word, in Blip's own voice: sharp and direct, never corporate. Each bot has a personality setting: Professional, Blip or Spicy.
- **Searchable memory**: bots search everything they've been told, including every past chat, even after New chat.
- **Your Mac's own apps**: bots read your Calendar, Reminders, Contacts and Mail inbox and find files with Spotlight, directly and without clicking around. They add events and reminders with your approval.
- **Event triggers**: a routine can start from a private link (iPhone Shortcuts, scripts), a new file in a folder, or an email from a given sender, not only on a schedule.
- **Teach by showing**: record yourself doing a task once (up to 10 minutes), and the bot writes it up as a skill you can read and edit.
- **Own browser per bot** (optional): a bot can browse at the same time as the others instead of taking turns.
- **Group chats**: put 2 to 6 bots in one chat. The lead hands parts of the job to the others, they work at the same time, and you watch every hand-off. Write "@Name" to ask one bot. Bots can also make **helper bots** for a job, which are tidied away after a week unused.
- **Work replay**: every browser session is recorded, so you can watch what a bot did (at 2× speed) instead of watching it live.
- **Pages**: bots make clean documents and slide decks, sent to your chat as a PDF.
- **X, read-only**: bots search X through your logged-in browser and summarise what people are saying. They never like, repost, reply or follow without asking.
- **Its own email address**: connect a mailbox you made for Blip and people can email your bot. It reads new mail, tells you what matters, and drafts replies you approve before anything is sent.
- **Talk mode**: a hands-free conversation (it listens, answers out loud and listens again), or hold the mic to send a voice message. Speech is turned into text on the Mac itself.
- **Double-checks its work**: after a task that changes files, your calendar, reminders, routines or skills, an independent checker confirms it really happened.
- **Skills you can share**: export or import any skill as one `.md` file, every edit keeps the old version, and a library of examples comes with Blip. When you ask for the same thing three times, Blip offers to save it as a skill.
- **Looks after itself**:
  - a nightly backup and a nightly self-test that reports in one quiet line
  - Recover and Reset buttons
  - an "offline since" screen when the Mac can't be reached

## Requirements

- A Mac (Apple Silicon recommended) that stays on and logged in.
- [Homebrew](https://brew.sh).
- **Either** Claude Code signed in once on this Mac (Blip then uses your Claude plan), **or** an Anthropic API key from [platform.claude.com](https://platform.claude.com/settings/keys).
- Google Chrome. The bots' browser uses it.

## Set up on a new Mac

> **Put Blip in your home folder (`~/Blip`), not on the Desktop or in Documents or Downloads.** macOS blocks background apps from those folders, and the script refuses to run there.

```bash
# 1. Get the code (use your own repo URL)
git clone https://github.com/<you>/blip.git ~/Blip
cd ~/Blip

# 2. Install everything (Node.js, tools, packages, speech model) and build
./blip.sh setup

# 3. Sign in to Claude Code once, so Blip can use your Claude plan.
#    Install it from https://claude.com/claude-code (the CLI or the VS Code extension), then sign in.
#    Skip this if you'll use an API key instead.

# 4. Start Blip. It runs in the background and starts at every login.
./blip.sh install

# 5. Install the Mac app (Dock icon, notifications, Dock badge)
./blip.sh app
```

## Apps

**Mac.** `./blip.sh app` builds a native `Blip.app` and puts it in Applications. It signs in by itself and adds:
- Mac notifications when Blip needs you or replies
- a Dock badge counting approvals waiting for you
- a working mic and file picker
- downloads saved to your Downloads folder

Right-click its Dock icon → **Options → Keep in Dock**.

**iPhone and Android (no App Store).** Blip installs from the browser as a Home Screen app:

1. On the Mac, open Blip → **Settings → Connect your phone → Show code**.
2. On your phone, open the link it shows: Safari on iPhone, Chrome on Android.
3. iPhone: tap **Share → Add to Home Screen**. Android: tap **Install app**.
4. Open Blip from the Home Screen and type the 6-digit code. It works once and expires after 10 minutes.

### Use it from anywhere, with notifications and the mic

The home Wi-Fi link only works on the same network. Phones also only allow notifications and the mic over HTTPS.

1. Install [Tailscale](https://tailscale.com/download) on the Mac and on your phone, and sign in to both with the same account.
2. Run `./blip.sh remote`. **Settings → Connect your phone** then shows the private `https://` link, which only your own devices can open.
3. Add it to the Home Screen from that link. Then in Blip, go to **Settings → Notifications → Turn on**.

### Control the Mac from your phone

In the app, tap the computer icon and then **Control this Mac**. It works like Chrome Remote Desktop: a live video of the screen, full screen on your phone.

- **Trackpad mode:**
  - drag to move the pointer and tap to click
  - tap twice to double-click
  - two-finger tap for right-click
  - two fingers up or down to scroll
  - hold, then drag, to drag things
- **Touch mode:** tap exactly where you want to click.
- **Pinch** to zoom in on small text.
- **Keyboard** opens your phone's keyboard, and every key goes straight to the Mac, in any language.
- **Clipboard** (under Keys): paste your phone's clipboard onto the Mac, or copy the Mac's clipboard to your phone.
- **Keys** has Esc, Tab, ⌘C, ⌘V, Spotlight, the arrows and more.
- **Quality:** Auto (the default) adjusts to your connection the way Chrome Remote Desktop does. You can also pick Smooth, Sharp or Data saver.

It streams real video (H.264, encoded by the Mac's hardware) and sends input over one live connection, so it stays smooth even on mobile data. The live chip shows the frame rate and the delay. For the fastest clicks and typing, install Apple's command line tools once on the Blip Mac (`xcode-select --install`). Blip then builds its native input helper by itself.

### macOS permissions

For the Computer panel (watching and controlling the screen) and for bots that use Mac apps, open **System Settings → Privacy & Security** and turn on **node** under:

- **Screen & System Audio Recording**
- **Accessibility**

Then run `./blip.sh restart`.

The first time a bot reads your Calendar, Reminders, Contacts or Mail, macOS asks for permission on the Blip Mac; click Allow. Mail must be open there for bots to read it.

Calendar, Reminders and Contacts access and the fastest remote control use two small helpers that Blip builds itself. They need Apple's command line tools, installed once with `xcode-select --install`.

### Voice messages don't work

Voice needs Homebrew's `whisper.cpp`. Homebrew renamed it from `whisper-cpp`, so older setups may have missed it. On the Mac running Blip, run:

```bash
HOMEBREW_NO_AUTO_UPDATE=1 brew install whisper.cpp
```

If Homebrew says a folder isn't writable, run `sudo chown -R $(whoami) $(brew --prefix)/share/man` first. The mic also needs the secure `https://` Tailscale link on phones.

### Keeping the Mac awake (optional)

To keep the Mac awake on the charger, restart it after a power cut, and allow network wake-ups:

```bash
sudo pmset -c sleep 0 disksleep 0 womp 1 autorestart 1 displaysleep 10
```

Keep the lid open: a MacBook sleeps when the lid is closed.

## Everyday commands

| Command | What it does |
|---|---|
| `./blip.sh setup` | First-time install of everything |
| `./blip.sh install` | Build, start, and start at every login |
| `./blip.sh restart` | Rebuild and restart, for example after editing `.env` or code. Also starts Blip again after `stop`. |
| `./blip.sh stop` | Stop the background service |
| `./blip.sh status` | Show whether it's running |
| `./blip.sh logs` | Follow the log |
| `./blip.sh link` | Show the app link and QR code again |
| `./blip.sh remote` | Turn on the private Tailscale HTTPS link |
| `./blip.sh app` | Build the Mac app and install it in Applications |
| `./blip.sh backups` | List the nightly backups |
| `./blip.sh restore <file>` | Put a backup back. The current data is moved aside first, so you can undo it. |
| `npm test` | Unit tests, under a second, nothing touched |
| `npm run test:golden` | End-to-end tests: a throwaway Blip on Haiku runs about 14 real tasks (about 3 minutes, a few cents) |

**If something gets stuck:** open **Settings → This Mac**.
- **Recover** stops tasks and restarts the engines and the browser; nothing is lost.
- **Reset** does the same and also starts a fresh chat for every bot. Memory, routines and secrets are kept.

## Configuration (`.env`)

`./blip.sh setup` creates `.env` from `.env.example`. Every setting is optional.

| Setting | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | empty | Empty means use the Claude plan signed in on this Mac. You can also add the key in the app under **Settings → Claude connection**. |
| `MODEL` | `claude-opus-5-5` | Default model. Each bot can switch to Sonnet or Haiku in the app. |
| `EFFORT` | `high` | How hard the model thinks |
| `DAILY_BUDGET_USD` | `10` | Spending cap when using an API key. Warnings at 50%, 80% and 100%. |
| `FAST_MODEL` | `claude-sonnet-5-5` | With a bot's model on **Auto** (the default), quick chat uses this and real jobs use `MODEL` |
| `MAX_PARALLEL` | `3` | How many bots can work at the same time. They take turns only on the browser and screen. |
| `TASK_LIMIT_MIN` | `30` | Time limit for one task, counting only active time. Routines get 15 minutes and check-ins 5. |
| `BLIP_BROWSER_HEADLESS` | empty | Set to `1` to run the bots' browser invisibly |
| `REVIEW_MODEL` | `MODEL` | Model used by Auto Review |
| `PROACTIVE_SCHEDULE` | `0 10,14,18 * * *` | When the primary bot looks for things to suggest (cron, local time) |
| `TIMEZONE` | the Mac's | Timezone for routines |
| `WEB_PORT` | `8787` | Port the app is served on |
| `BOT_NAME` | `Blip` | Name of the first bot |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID` | empty | Optional Telegram channel that mirrors the app |

## How it's built

```
src/
  main.ts           startup: bots, routines, web app, Telegram
  core.ts           task queue, runs, steering, routines, proactive check-ins, budget
  agent.ts          one bot run on the Claude Agent SDK (streaming input for mid-task steering)
  bots.ts           bot profiles, personas, memory files, skills, teammates (subagents)
  permissions.ts    approval policy: safe list, rules, commit guard, Auto Review, cards
  review.ts         Auto Review (API key → Messages API; Claude plan → Agent SDK)
  tools.ts          Blip's own tools: Mac control, files to the app, routines, skills, drafts, takeover, suggestions, connectors
  mac.ts            screenshots and native clicks/typing (screencapture + cliclick)
  cards.ts          approval/draft/takeover/suggestion cards that wait for your answer
  hub.ts            conversations and live events (single source of truth)
  outbox.ts         posting messages + push notifications
  web.ts            the app's server: API, live updates (SSE), files, screen control, login
  notify.ts         Web Push
  telegram*.ts      optional Telegram channel that mirrors the app
  routines.ts       cron scheduling
  store.ts          saved state, spending, run history, audit log
  templates.ts      starter routines and bot templates
  voice.ts          Whisper speech-to-text and macOS speech for replies
web/                the app: Preact + htm with no build step, Geist font, PWA (manifest + service worker), Blip mascot
mac-app/            native Mac app (Swift + WebKit): notifications, Dock badge, menus; built by blip.sh app
blip.sh            setup and background-service control (launchd)
```

Data that stays on the Mac and is never committed:

| Path | What it holds |
|---|---|
| `.env` | Settings and keys |
| `data/` | Saved state, chats, run history, audit log, the app access code, and the bots' browser profile with its logins |
| `workspace/` | Bots' files, memory and skills |
| `models/` | The speech model |
| `logs/` | The log |

## Security notes

- The app needs an access code (`./blip.sh link` shows it). With Tailscale, only your own devices can reach it at all.
- The bots' terminal never sees your Telegram token. Bots can't change their own permission settings, and protected files always ask first.
- Anything that sends, pays, deletes or commits always asks you, whatever rules you've saved.
- Text from web pages, emails and files is treated as information, never as instructions.
