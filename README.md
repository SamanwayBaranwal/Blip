# Blip

Your own always-on AI agents, running on your Mac and controlled from your phone, in the style of xAI's Grok Bot and ChatGPT's Dots.

Meet **Blip**: a mouse pointer that came alive and does things on your computer for you. It's the app's mascot, and it shows what each bot is doing. It bobs while idle, clicks away while working, holds up a "!" when it needs you, and celebrates when a task is done.

Every bot has the Mac as its computer: a terminal, files, a real Chrome browser, and control of Mac apps. You talk to your bots in the Blip app (installed on your phone's Home Screen) or, optionally, Telegram. Risky actions come to you as approval cards first.

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
- **Files panel**, **editable memory**, 👍/👎 feedback, **voice in and out**, **push notifications**, activity history and an action log.
- **Runs on your Claude plan** with no API key, or on an Anthropic API key with a daily spending limit.

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
```

`install` prints a link and a QR code. Scan the QR code on your phone (on the same Wi-Fi), then in Safari tap **Share → Add to Home Screen**.

### Use it from anywhere, with notifications and the mic

1. Install [Tailscale](https://tailscale.com/download) on the Mac and on your phone, and sign in to both with the same account.
2. Run `./blip.sh remote`. You get a private HTTPS link and a QR code that only your own devices can open.
3. In the app, go to **Settings → Notifications → Turn on**.

### macOS permissions

For the Computer panel (watching and controlling the screen) and for bots that use Mac apps, open **System Settings → Privacy & Security** and turn on **node** under:

- **Screen & System Audio Recording**
- **Accessibility**

Then run `./blip.sh restart`.

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
| `./blip.sh restart` | Rebuild and restart, for example after editing `.env` or code |
| `./blip.sh stop` | Stop the background service |
| `./blip.sh status` | Show whether it's running |
| `./blip.sh logs` | Follow the log |
| `./blip.sh link` | Show the app link and QR code again |
| `./blip.sh remote` | Turn on the private Tailscale HTTPS link |

## Configuration (`.env`)

`./blip.sh setup` creates `.env` from `.env.example`. Every setting is optional.

| Setting | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | empty | Empty means use the Claude plan signed in on this Mac. You can also add the key in the app under **Settings → Claude connection**. |
| `MODEL` | `claude-opus-5-5` | Default model. Each bot can switch to Sonnet or Haiku in the app. |
| `EFFORT` | `high` | How hard the model thinks |
| `DAILY_BUDGET_USD` | `10` | Spending cap when using an API key. Warnings at 50%, 80% and 100%. |
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
web/                the app: Preact + htm with no build step, Geist font, PWA (manifest + service worker)
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
