# Blip: context for Claude

Read this first. It carries over what earlier sessions built, decided and learned, because chat memory doesn't move between Macs. The user-facing setup is in `README.md`, and the product research is in `docs/RESEARCH.md`.

## What this is

Blip is the user's personal, always-on AI agent system. It runs on a dedicated spare MacBook and is controlled from their phone. **The goal is a 1:1 match with xAI's Grok Bot**, plus the best of ChatGPT Dots and Meta Muse.

It's built on the **Claude Agent SDK** (TypeScript). Each bot run is a `query()` with built-in tools (Bash, files, web) plus:

- a Playwright MCP browser using real Chrome and a persistent profile in `data/browser-profile`
- Blip's own in-process MCP tools (`src/tools.ts`)
- user-added connectors

The UI is a PWA served by `src/web.ts`. Telegram is an optional mirror channel.

## Brand: Blip

- The platform **and** its mascot are both called **Blip**, chosen by the user on 2026-10-17.
- The mascot is a mouse pointer that came alive (it clicks for you). It follows the "cute, but capable" direction: cute like Muse's Jolly or the Dots crew, but clever rather than babyish, and monochrome to fit the app.
- It's drawn in `web/app.js` (`BLIP_SVG`, `<Blip state size still tight />`), with styles under the mascot section of `web/styles.css`.
- **States:**
  - `idle`: bobs and blinks
  - `working`: tapping, with click ripples
  - `needs`: hops, with an amber "!"
  - `done`: happy eyes and sparkles
  - `sleep`: zz
- Avatars mirror each bot's live state. In light mode the character inverts to black.
- **Customization:** every bot has its own `look`, stored on `BotProfile.look` (`color`, `hat`, `eyes`, `face`, `neck`, `hold`). The wardrobe is defined in `LOOKS` in `web/app.js` as SVG layers in Blip's 200×200 space. Hats anchor near the tip at about (66, 30), the face sits at eyes (84.5|109.5, 98) and mouth (97, 112), and held items sit at about (150, 140).
- The customize screen is `StyleSheet`, reached from Bot settings → Customize. Template bots come pre-styled through `templates.ts`. The server whitelists look keys in `PATCH /api/bots/:id`.
- The app icon is `web/icon.svg`, rendered to `icon-512.png` with `qlmanage`.
- Use the mascot, never emoji. The original concept page is the "Pilot Mascot Lab" artifact.
- **The rename.** The project used to be called Pilot. Everything was renamed: `blip.sh`, the `com.blip.agent` service, the in-process MCP server `blip` (so tools are `mcp__blip__*`), and the `blip` cookie. The install moved from `~/PilotBot` to `~/Blip`.

## Apps

- **Mac:** `mac-app/main.swift` is a native Swift and WKWebView app, built by `./blip.sh app`. It installs `/Applications/Blip.app`, ad-hoc signed, with the install path stored in Info.plist as `BlipHome`. It signs in with the local access code.
- **Mac app bridge:** the web app calls `window.webkit.messageHandlers.blipNotify` and `blipBadge` (`nativeNotify` / `nativeBadge` in `app.js`).
- **Phones:** iPhone and Android use the PWA with no App Store. Pairing is a 6-digit, single-use, 10-minute code from `POST /api/pair`, accepted by `/api/login`. It's shown in **Settings → Connect your phone**, which also lists the LAN and Tailscale links.

## About the user and how to work with them

- The user is direct and impatient with anything that looks generic. They want the product to match Grok Bot and Dots as closely as possible, smooth and polished.
- **Design direction (non-negotiable):**
  - Grok-style monochrome: pure black default, white as the only accent, Geist font
  - no purple or gradients
  - **no emoji in UI chrome or bot-system messages**
  - assistant replies as plain text without bubbles; user messages in gray pills
  - a shimmering "Working" line and a thin step timeline
- **They host the code themselves. Never `git push`, never create remote repos, never publish.** Give them terminal commands instead.
- They prefer the app to Telegram.
- They're often away from the Mac. Explain anything they have to do on the Mac step by step.
- Run things and verify them yourself. Use real browser screenshots for UI work. Don't claim something works without testing it.

## Key decisions and why

- **Auth.** With `ANTHROPIC_API_KEY` empty, the SDK uses the Claude Code login in this Mac's keychain (the user's Claude plan). This was tested and works. `review.ts` then runs Auto Review through the Agent SDK, using `outputFormat` with a JSON schema. With a key set, usage is pay-as-you-go with a daily budget (`maxBudgetUsd`), and Auto Review uses the Messages API with `zodOutputFormat`.
  - The key can be added in the app (`POST /api/setup/key`, written to `.env`).
  - The agent's env strips `CLAUDE*` and `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`, so a parent Claude Code session's connection never leaks in.
- **Install location.** The project must live outside Desktop, Documents and Downloads, because macOS TCC blocks launchd agents there. `blip.sh` enforces this. The intended location is `~/Blip`.
- **Bots work in parallel** (`core.ts`). Each bot runs one task at a time, and up to `MAX_PARALLEL` bots (default 3) run at once. Messages to a busy bot steer its task.
  - **The computer lock** (`computer.ts`): only the shared browser and screen are taken in turns. The browser and Mac tools acquire the lock in `canUseTool`, and the waiting task shows "Waiting for the computer: X is using it". When the lock passes to a different bot, the previous bot's engine is closed first so its Chrome releases the profile.
  - **Engines:** one warm Agent SDK session per bot, at most `MAX_PARALLEL` alive, with the least recently used idle one closed first.
- **Auto model** (`chooseModel` in `core.ts`) is the default when `bot.model` is unset:
  - quick chat goes to `FAST_MODEL` (Sonnet 5.5)
  - real jobs go to `MODEL` (Opus 5.5): the `BIG_TASK` verbs, more than 220 characters, or attachments
  - routines use Opus and proactive check-ins use Sonnet
  - the warm engine switches with `Query.setModel()`, and the run block shows which model handled it
- **No surprise windows:** background work (proactive check-ins, routines) runs the browser headless with the same profile, so logins still work and windows never pop up while the user is at the Mac. Chats the user starts use a visible browser.
  - Check-ins show in the chat as a quiet, collapsible run line ("Proactive check-in · read-only"), so it's always clear what Blip looked at.
  - The user was alarmed to see Gmail open by itself on 2026-10-18: never do invisible-to-the-user actions without a visible trace.
  - Blip on the development Mac (Samanways-MacBook-Air) is turned off and has no launch agent. Blip runs on the user's other laptop.
- **Time limits** count only active time, not time spent waiting for approval or for the computer: chat 30 minutes (`TASK_LIMIT_MIN`), routines 15, proactive 5. The persona asks bots to verify their result before saying "done".
- **Approvals** (`permissions.ts`):
  - Safe tools run automatically.
  - Workspace writes are automatic; protected paths (`.env`, `data/`, `~/.ssh`, the workspace's `.claude/settings*.json`, `.mcp.json`) always ask.
  - Interactive tools (browser click/type, Mac click/type) **never** get a permanent "Always allow", only "Allow for this task". This is the Muse lesson: standing approvals once leaked a home address.
  - **The commit guard** (`COMMIT_WORDS`) always asks for send, pay, delete, book or accept, regardless of rules.
  - "Ask first" rules beat "Always allow" rules.
  - Auto Review decides what's left.
- **Steering.** `agent.ts` uses streaming input (an `Inbox` async generator). Messages sent mid-task are pushed with `priority: "next"`. The task ends when every sent user-message UUID is covered by a result.
- **Cost.** `total_cost_usd` is cumulative per session, so `store.recordCost` stores deltas.
- **Errors.** After an error result, the SDK throws "process exited with code 1". `agent.ts` swallows that once every message has been answered.
- **Noise control.** These all come from real user complaints about Grok Bot, Dots and Muse:
  - routines that reply `NOTHING NEW` stay silent
  - proactive suggestions are read-only, max 3 a day, and learn from dismissals
  - progress messages are silent
  - approvals send reminders at 10 and 60 minutes (no silent stalls)
  - a stall watchdog fires at 10 minutes
  - a context-length nudge appears past 400k tokens

## Speed, remote control and voice (2026-10-18)

- **Warm sessions** (`agent.ts`, `Session`):
  - After a chat reply, the bot's Agent SDK session stays alive for 10 minutes, and the next message to that bot is pushed into the same session with no engine restart.
  - Only one warm session exists at a time. It closes, gracefully, when any other bot or a routine starts, because they share the browser profile.
  - It also closes when the bot's settings change, on New chat (`closeWarmSession`), and on Stop, which closes it by force.
  - With an API key, sessions aren't kept warm, because each task needs a fresh budget cap.
- **Remote control** (`src/screen.ts`):
  - **Stream:** one shared ffmpeg runs per stream config (avfoundation "Capture screen 0" → MJPEG). It's served by `GET /api/screen/stream?w=&fps=` as 4-byte-length-prefixed JPEG frames. A slow viewer skips frames rather than lagging, and ffmpeg stops 3 seconds after the last viewer leaves.
  - **Input:** `POST /api/screen/pointer` (move, click, double, right, down, drag, up) takes **normalized** nx/ny between 0 and 1, and is sent with cliclick. `POST /api/screen/wheel` does real scrolling with `CGEventCreateScrollWheelEvent2` through JavaScript for Automation. Typing and keys go through `/screen/type` and `/screen/key`.
  - **Client:** `RemoteView` in `app.js`, with trackpad and touch modes, pinch zoom, two-finger scroll and right-click, hold-to-drag, a hidden input for the phone keyboard, and one serial queue so actions arrive in order. It falls back to `/api/screen` snapshots if streaming fails.
  - **Testing safely:** `BLIP_SCREEN_TEST=1` streams ffmpeg's test pattern, and `BLIP_INPUT_DRYRUN=1` logs input instead of clicking.
- **Voice:** Homebrew renamed `whisper-cpp` to `whisper.cpp`, and `blip.sh setup` now installs the new name. On Intel Macs, Homebrew lives in `/usr/local`. `voice.ts` gives clear errors when a tool is missing.
- **Settings:** `settings.fullAccess` means only payments, protected files and Ask-first rules still ask (`PAYMENT_WORDS` in `permissions.ts`).
- **Live updates:** the SSE stream sends `event: hello` on connect and `event: ping` every 20 seconds. The app polls instead if neither arrives, because some tunnels buffer the stream.
- **Measured on the Intel test laptop over Tailscale:**
  - the old screenshot view managed 0.4 frames per second
  - each API call took about 1.5 seconds round trip
  - Haiku tasks took 2 to 19 seconds

## Hard audit (2026-10-18): rules that keep it healthy for weeks

Fixed after a full audit. Keep these invariants:

- **Never kill work in progress.**
  - Settings changes and connector changes *retire* engines: idle ones close now, busy ones close after their task (`closeWarmSession`).
  - The computer lock (`computer.ts`) never closes a busy engine that has Chrome open. Other bots wait (`blocker()`), and `drain()` runs on every task end and after every grant.
  - Stop also clears that bot's queued tasks. New chat stops the bot's task and bumps `chatGeneration`, so a finishing task can't restore the old session.
- **Lock only after allowing:** the computer is taken only once a browser or screen action is allowed (the `makeCanUseTool` wrapper), never while an approval card waits.
- **Conversations expire:** the engine deletes transcripts after 30 days. `sessionExists()` checks `~/.claude/projects/*/<id>.jsonl` before resuming and starts fresh if it's gone.
- **Files never corrupt:**
  - Threads and state are written with tmp + rename.
  - An unreadable `state.json` or thread is copied to `*.broken-<time>` instead of being silently replaced.
  - `audit.jsonl` rotates at 5 MB.
  - `logs/blip.log` is trimmed hourly past 20 MB.
  - Voice recordings are deleted after transcription.
  - `view-*` screenshots are deleted after use.
  - `workspace/browser`, `workspace/screenshots` and `data/voice` are pruned after 7 days.
- **Cost:** `recordCost` ignores zero totals and never re-adds a session's whole history. `contextTokens` comes from the latest main-agent call, not the result's summed usage.
- **Security:**
  - `isSensitive` uses realpath and lower-casing (APFS is case-insensitive). Grep, Glob and LS on a folder that *contains* a secret (`~`, ROOT) count as sensitive.
  - `WRITE_PROTECTED_PATHS` (`workspace/.claude`, Blip's own code, LaunchAgents) always ask before writes.
  - "Always allow" is never offered for interpreters, shells or wrappers. Key presses and page scripts are reviewed every time, and Ctrl/Cmd+Enter counts as committing.
  - Connector read-only detection uses whole words. A removed connector gets no access.
  - The access code is never logged; `logs/` is protected.
  - JSON bodies are capped at 256 KB except `/api/send` and `/api/voice` (after sign-in).
- **Routines:**
  - At most once every 10 minutes.
  - A routine already queued or running isn't queued again.
  - A one-time routine missed during downtime runs late if it's under 24 hours old; otherwise a "Missed" note is posted.
  - Deleting a bot removes its routines and their timers.
  - A bot can remove only its own routines.
- **Memory over 20 KB:** the prompt keeps the newest part (the tail) and asks the bot to tidy up.
- **`blip.sh`:**
  - `restart` rewrites the plist and reloads it (launchd only reads it on load), waiting for the old job to exit.
  - The plist sets `LANG=en_US.UTF-8`, because without it `pbcopy` garbles non-ASCII text.
- **App:**
  - Screen-stream frames free their object URLs, and only the newest frame per chunk is drawn.
  - Streams pause when the app is hidden. Only one stream runs at a time (ComputerPanel pauses while RemoteView is open).
  - SSE reconnects itself after a 502. Live messages that arrive during a thread load are merged in. The unread count and notifications use a `seen` set.
  - Unmounting the composer turns the mic off.
  - Toasts appear above RemoteView. Fields are 16px on touch screens, so iOS doesn't zoom.

## Remote desktop and secrets vault (2026-10-18)

- **Remote desktop (`src/remote.ts`)** works like Chrome Remote Desktop:
  - **Connection:** one WebSocket at `/api/remote`. The cookie is checked when the connection is upgraded.
  - **Video:** ffmpeg runs avfoundation into `h264_videotoolbox` (falling back to libx264), producing fragmented MP4 with `frag_every_frame`. Each `moof`+`mdat` pair is one frame. The `moov`'s avcC becomes the WebCodecs `description`.
  - **Frame messages:** each frame is sent as `[key flag][uint32 seq][AVCC data]`, and the phone acks every frame.
  - **Congestion control:** if the oldest unacked frame is more than 350 ms old, the server skips frames until the next keyframe. This keeps delay from piling up in the network; a test with a throttled link showed 14 s of lag without it and about 30 ms with it.
  - **Auto quality:** steps down a `LADDER` (`app.js`) on skipped frames, and back up after 20 s calm (60 s after a slowdown).
  - **Input:** goes to `bin/blip-input`, an always-running native helper built from `mac-app/input.swift` (CGEvent, Unicode typing without the clipboard). It's built automatically at startup when the command line tools exist; `xcode-select -p` is checked first so there's never an install popup. Without it, input falls back to cliclick.
  - **Fallbacks:** browsers without WebCodecs (or on plain http) get the MJPEG view, but input still goes over the WebSocket.
  - **Tested:**
    - Chrome and WebKit decode at 30 fps.
    - Every gesture works.
    - The throttled link stays responsive.
- **Secrets vault (`src/secrets.ts`):**
  - **Storage:** values live in the Keychain (`security`, service "Blip", with the value written through stdin). Only names live in `state.secrets`.
  - **Adding:** `request_secret` shows a masked "secret" card; Telegram never collects secrets.
  - **Using:** `{{secret:name}}` in any tool input is handled by a **PreToolUse hook** (`makeSecretGate`), not `canUseTool`. The engine auto-allows commands like `echo` without calling `canUseTool`; that bypass was found in testing. The hook asks "Use your secret …" (Allow once / for this task / Deny), then fills in the value.
  - **Scrubbing:** a PostToolUse hook scrubs known values from all tool output (`updatedToolOutput`).
  - **Keychain access:** Bash touching `security` or the keychain always asks.
  - **Tested:** the value is filled in, the bot only sees the placeholder, and no file contains the value.

## Streaming, personality, reliability, memory, Mac data, triggers, teaching (2026-10-19)

- **Streaming:**
  - `includePartialMessages` is on. `agent.ts` collects the bot's own text deltas; a tool call clears the thinking-aloud text.
  - `core.ts` puts the text in `run.live` about 8 times a second.
  - `hub.ts` never saves `live` to disk; `RunBlock` shows it with a caret.
  - Measured on Haiku: first words after about 3.4 s.
- **Personality:** `character()` in `bots.ts` is the Blip voice, and every bot has it.
  - `bot.spice` is low, medium (the default) or high.
  - `OFF_VOICE` in `core.ts` logs banned phrases to the audit log; it never blocks.
  - Persona text has no emoji.
- **Tests:**
  - `npm test`: unit tests with `node:test`, each file in its own temporary Blip home through `BLIP_DATA_ROOT`, with `BLIP_TEST_KEYCHAIN=memory`. 31 tests, under 1 s.
  - `npm run test:golden`: a real throwaway server on Haiku, 14 end-to-end tasks.
  - **Every new capability needs a test in one of the two.** A deliberately reintroduced cost bug was caught.
- **`config.DATA_ROOT`:** `.env`, data, workspace and logs live here (the install folder unless `BLIP_DATA_ROOT` is set). Code assets stay under `ROOT`.
- **Health (`health.ts`):**
  - `GET /api/health`.
  - Recover: stop tasks, `closeAllEngines`, `resetComputer`, kill Chrome by profile path, `restartRemote`.
  - Reset: Recover plus `freshChat` for every bot.
  - Nightly backup at 03:30: tar of data and workspace without browser caches, 14 kept, `./blip.sh restore`.
  - Nightly self-test at 03:40: 8 checks. It posts one quiet line, and a push only on failure.
  - Optional `HEALTHCHECK_URL` heartbeat.
  - The service worker caches the app shell network-first, so `OfflineScreen` and `OfflineBanner` work when the Mac is down.
- **Memory (`memory.ts`):**
  - A SQLite FTS5 index (`node:sqlite`) in `data/memory-index.db`.
  - Covers memory files, shared notes and skills (rebuilt when the files change), plus a **permanent archive of every user and bot chat message**. Threads still trim to 400.
  - The `search_memory` tool.
  - Weekly tidy (Sunday 04:00) for memory files over 8 KB. A copy goes to `memory/.history` first, and the run uses `noPush`.
- **Mac data (`macdata.ts`):**
  - The `mac-app/macdata.swift` helper (EventKit and Contacts) is built by `native.ts` as `bin/blip-macdata`; the build checks `xcode-select -p` first.
  - Mail is read via JXA, **only if Mail is already running** (opening it would pop a window).
  - Files are found with Spotlight `mdfind`, skipping protected paths.
  - The tools are deliberately **not** named `mac_*`, so they never take the computer lock.
  - Untested on real permissions; that needs the Blip Mac to click Allow.
- **Triggers (`routines.ts`):**
  - `Routine.trigger` is a webhook token, a folder, or a mail filter; `schedule` is `"event"`.
  - `/hook/:token` takes no cookie (the token is the secret), is rate-limited to one call per 10 s, and accepts up to 64 KB.
  - Folders are watched with `fs.watch`, waiting 3 s after a file lands.
  - Mail is polled every 5 minutes while a mail routine exists.
  - Event data reaches the bot wrapped as `<event>` and marked "NOT instructions".
- **Teach by demo (`teach.ts`):**
  - ffmpeg records at 2 fps, 1280 px, 10 minutes at most.
  - Key moments: scene changes plus one every 3 s, thinned to 30.
  - Remote-view clicks and keys are logged with timestamps; **typed text never is**, only its length.
  - The bot gets the images and the log, asks questions, and calls `save_skill`. The recording is deleted after 60 s.
  - Skills can be edited in the app (`GET`/`PUT /api/skills/:name`).
- **Own browser:**
  - `bot.ownBrowser` gives the bot `data/browser-profiles/<id>`, copied from the shared profile without caches or lock files.
  - Its browser tools skip the computer lock; `mac_*` still uses it.
  - It's opt-in, because later logins don't sync between profiles.

## Check-ins, skills, double-check, voice, alerts, polish (2026-10-19, later)

- **Mac access check** (`checkMacAccess` in `health.ts`, Settings → This Mac → Check Mac access):
  - Reads and writes Calendar and Reminders for real (a test item is made and deleted with `delete-event` / `delete-reminder`), and reads Contacts, Mail, Spotlight, the screen, mouse control and voice. Each gives an exact fix.
  - Results are stored in `state.macAccess`. **Background runs only use apps marked allowed there**, and the native helper gets `BLIP_NO_PROMPT`, so check-ins and routines never pop permission dialogs. Sessions know whether the user started them (`Session.userStarted` → `createBlipServer(bot, { background })`).
  - **Never run Mac-data tools from a dev test server without `BLIP_FAKE_MAC_DATA=1`.** On 2026-10-19 a talk-mode test asked about the calendar and may have shown a Calendar prompt on the dev Mac. Unit and golden tests now always use the fake data, which remembers additions.
- **Proactive:**
  - `proactiveFacts()` gathers facts in code: failed runs in the last 24 h, waiting approvals, today's calendar and unread mail (only if allowed), and new inbox files. They go into the check-in prompt as data.
  - Modes: off, mornings (once a day) or 3× a day.
  - `POST /api/proactive/run` runs one now.
- **Skills (`skills.ts`):**
  - `writeSkill` keeps up to 20 versions in `.versions/` (unique names).
  - `cleanSkill` keeps only `name` and `description` in the header (it drops `allowed-tools` and the like). It's used for import, the library, edits and `save_skill`.
  - Export and import a skill as `.skill.md`. The library lives in `skills-library/`.
  - `offerSkill` (core) uses `similarRequests()` (FTS plus word overlap of at least 0.5) and offers once (`state.skillOffers`) when a request has been made 3 times.
- **Double-check (`verify.ts`):**
  - Runs after done tasks that used checkable tools (`Write` / `Edit` / `calendar_add` / `reminders_add` / `add_routine` / `save_skill` / `send_to_phone`).
  - An independent `query()` (`FAST_MODEL`, read-only `canUseTool`, no browser) replies VERIFIED, NOT VERIFIED or CAN'T CHECK.
  - It posts "Checked: …" quietly, or "Double-check failed: …" with a push. Setting: `settings.verify`.
- **Voice:**
  - `transcribe` trims silence and runs Whisper greedy (`-bs 1 -bo 1`, up to 8 threads): about 25% faster on Apple Silicon, much more on Intel.
  - `speak` uses the best installed Premium or Enhanced voice.
  - App: `speakText` picks the best device voice and speaks sentence by sentence (`speechDone` promise). Hold the mic to talk.
  - **Talk mode** (wave button): VAD records until 1.2 s of silence → `/voice` → send with `voice: true` → wait for the reply → speak → listen again. A pending approval is announced out loud ("tap the card"); approvals are never given by voice.
  - Tested with Chrome's fake mic.
- **Alerts:**
  - `settings.healthcheckUrl` (Settings → Outage alerts) or `HEALTHCHECK_URL`: a ping every 5 minutes, plus `/fail` when the self-test fails (healthchecks.io).
  - Public `GET /status` gives one line with no personal data.
- **Open source:** `install.sh` (a one-line curl install into `~/Blip`; it defaults to github.com/SamanwayBaranwal/blip), `CONTRIBUTING.md`, and a README quick start. There's no LICENSE yet: the user decides.
- **Tests:** 40 unit tests (`npm test`, about 6 s, with a 60 s per-test timeout) and 17 golden tasks.

## Groups, helpers, replay, pages, X, agent email (2026-10-19, evening)

- **Chats vs bots:** a task now runs *in a chat* (`TaskOpts.threadId`, `Running.threadId`) that may not be the bot's own (a group, or a teammate's chat it was handed work in).
  - Messages it posts carry `meta.from`, and its run block `run.bot`.
  - Cards go to `ctx.threadId` (`chatOf(ctx)` in `permissions.ts`).
  - Each bot keeps a separate conversation per chat: `state.groupSessions["<chatId>:<botId>"]`.
  - `chatName()` and `isGroup()` live in `store.ts`.
- **Groups** (`state.groups`, ids start with `g-`):
  - `handleGroupMessage` routes to the lead, or to the member addressed with "@Name". The prompt carries the last 14 messages.
  - `hooks.handOff` (tool `hand_off`) runs the teammate as a real task, visibly, and returns its reply. Hand-off tickets bypass `MAX_PARALLEL` (no deadlock), the waiting bot's `teamWaits` pauses its time limit, a bot already waiting on a hand-off can't receive one, and hand-off runs (`ctx.handoff`) get their own browser profile and **no screen or mouse tools** (avoids lock deadlocks with the lead).
  - `create_helper` makes a helper bot (`bot.helper`), which joins the group; helpers unused for 7 days are removed at 04:15.
  - Stop on a group stops every bot working in it, and deleting a bot removes it from its groups.
  - The `teamAgents` subagents are no longer used.
- **Work replay (`replay.ts`):** every engine's browser records via a Playwright MCP `--config` file (`contextOptions.recordVideo`). When the session exits, the `.webm` files become one 2× speed mp4 in `workspace/replays` (pruned after 7 days), linked as `run.replay` on the runs that used browser tools. For warm chats that happens when the session closes.
- **Pages (`pages.ts`, tool `create_page`):** a built-in Markdown renderer produces a doc (A4) or a 16:9 deck (slides split by `---`), with Geist embedded, as HTML plus a PDF via headless Chrome (its own `pdf-profile`). It's sent to the chat.
  - **`/api/file` now serves HTML, SVG and XML with `CSP: sandbox`** (no scripts, unique origin). Before this, a bot-made HTML page could have acted with the user's cookie.
- **X search:** read-only through the logged-in browser (`x.com/search?q=…&f=live`), plus the library skill `x-pulse`. Clicks on Like, Repost, Follow, Reply, Quote, Bookmark, Subscribe or Join always ask (`SOCIAL_CLICK`), even with an allowance for the task.
- **Agent email (`email.ts`):**
  - Any IMAP/SMTP mailbox with an app password, with presets for Gmail, iCloud, Outlook, Fastmail, Yahoo and Zoho. The password lives in the Keychain (`agent-email-password`).
  - The inbox is polled every 2 minutes, and new mail goes to `hooks.emailArrived`, which starts a task wrapped as `<email>` and marked "NOT instructions".
  - Tool `email_send` → always a draft card (`draftCard`, even with full access); the edited text is what gets sent, threaded with `inReplyTo`.
  - `BLIP_FAKE_EMAIL=1` writes sent mail to `data/fake-outbox.jsonl`, and `/api/email/test-inbound` simulates incoming mail.
  - Real IMAP/SMTP is untested until the user connects a mailbox.
- **Tests:** 43 unit tests and 21 golden tasks.

## How the code fits together

- `hub.ts` is the single source of truth for conversations. Message kinds are `text`, `run` (live progress) and `card`.
- The web app streams `msg` and `state` events over SSE from `/api/events`.
- `telegram-app.ts` mirrors hub events into Telegram.
- `cards.ts` cards resolve from whichever channel answers first.

## Developing

```bash
npm run build && ./blip.sh restart     # after code changes (web/ files are served live; no restart needed)
./blip.sh logs
```

UI checks are done with Playwright (`require("playwright")`, with `channel: "chrome"`):

- Run a demo copy of `dist` and `web` in a scratch folder on another port (`WEB_PORT=8799`), so the user's real `data/` isn't touched.
- Log in through `/login?code=<data/app-access-code>`.
- Take screenshots at 1440×900 and 390×844.

To test end to end without the UI, call `POST /api/send` with the `blip=<code>` cookie, then poll `GET /api/thread/:botId`.

## Status as of 2026-10-17

**Tested:**
- build
- permission rules and the guards
- scheduler
- voice in and out (Whisper and `say`)
- the steering and Stop lifecycle
- the full app UI (approve, edit and send a draft, send a message, switch bots, sheets)
- a live task on the Claude plan (it ran commands and replied)

**Not yet tested on real hardware:**
- Mac screen view and control (needs Screen Recording and Accessibility permission for `node`)
- push notifications on iPhone (needs Tailscale HTTPS and a Home Screen install)
- Telegram
- connectors
- a long multi-step browser task

**Known gaps compared with Grok Bot:**
1. ~~bots working in parallel~~ (done)
2. a group chat screen (delegation works through subagents, but there's no UI)
3. routines started by events (email, webhook)
4. masked secret requests (Keychain)
5. typing "/" to run a skill in the composer
6. bots creating helper bots
7. teaching a task by screen recording
8. Recover and Reset buttons
9. duplicating bots and templates
10. a permanent email address for the agent
11. built-in OAuth connectors (Gmail, Drive and so on; today bots use the browser)
12. the X integration
