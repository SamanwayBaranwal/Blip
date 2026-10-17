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
- The app icon is `web/icon.svg`, rendered to `icon-512.png` with `qlmanage`.
- Use the mascot, never emoji. The original concept page is the "Pilot Mascot Lab" artifact.
- **The rename.** The project used to be called Pilot. Everything was renamed: `blip.sh`, the `com.blip.agent` service, the in-process MCP server `blip` (so tools are `mcp__blip__*`), and the `blip` cookie. The install moved from `~/PilotBot` to `~/Blip`.

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
- **One task at a time.** There's a global queue in `core.ts` because all bots share one Mac, one screen and one Chrome profile. Running bots in parallel is a known gap.
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

**Known gaps compared with Grok Bot** (the user declined building these for now):
1. bots working in parallel
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
