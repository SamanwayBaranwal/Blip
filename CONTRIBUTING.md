# Contributing to Blip

Blip is a local, open-source AI agent platform for a Mac you leave on. This page is the short version of how it's put together and how to add to it. Agents working on the code should also read `CLAUDE.md`.

## Run it while you work

```bash
npm install
npm test                # unit tests: under 10 seconds, touch nothing real
npm run test:golden     # ~15 real tasks on a throwaway Blip with Haiku (a few minutes, a few cents)
```

Tests run in their own temporary folder (`BLIP_DATA_ROOT`), with a pretend Keychain, pretend Calendar, Reminders, Contacts and Mail data, logged-only mouse and keyboard, and a test pattern for the screen. They never touch your chats, secrets, apps or screen.

**Every new capability needs a test**, a unit test in `test/unit/` or a golden task in `test/golden/run.mjs`.

## Where things live

| File | What it does |
|---|---|
| `src/agent.ts` | One bot's engine (Claude Agent SDK): warm sessions, streaming, hooks |
| `src/core.ts` | Tasks, parallel bots, routines, proactive check-ins, repeated-task spotting |
| `src/permissions.ts` | Every tool call's approval: safe tools, protected paths, the commit and payment guards, secrets |
| `src/tools.ts` | Blip's own tools (`mcp__blip__*`) |
| `src/macdata.ts`, `mac-app/macdata.swift` | Calendar, Reminders, Contacts, Mail, Spotlight |
| `src/memory.ts` | Searchable memory (SQLite full-text search) |
| `src/skills.ts`, `skills-library/` | Skills: versions, import/export, the example library |
| `src/health.ts` | Health report, Recover/Reset, backups, self-test, access check, heartbeat |
| `src/remote.ts`, `mac-app/input.swift` | Remote desktop: H.264 video and input over one WebSocket |
| `src/web.ts`, `web/app.js` | The server and the app (Preact + htm, no build step) |

## Add a skill (no code)

A skill is a folder with a `SKILL.md`:

```markdown
---
name: my-skill
description: One line: what it does and when to use it.
---

1. Steps the bot follows, in plain language.
2. Inputs to ask for, how to check it worked, and edge cases.
```

Put it in `skills-library/my-skill/` to ship it as an example (users add it with one tap under Skills), or import the `.md` in the app. Only `name` and `description` are kept in the header. Anything else, like `allowed-tools`, is removed on import, so a shared skill can never skip Blip's approvals.

## Add a tool

1. Add it in `src/tools.ts` with `tool(name, description, zodSchema, handler)`. Return plain text, or JSON for structured data. Return `text(message, true)` with a fix the user can follow when something's missing.
2. Classify it in `src/permissions.ts`:
   - Reads go in `READ_ONLY_SAFE` (allowed even in read-only check-ins).
   - Bookkeeping goes in `SAFE`.
   - Anything else goes through Auto Review or an approval card automatically.
   - Don't name it `mac_*` unless it really drives the screen or mouse: those take turns on the shared computer.
3. Mention it in the bot instructions (`personaFor` in `src/bots.ts`) if bots should prefer it.
4. Add a test.

## Add an app connector (MCP)

Users connect MCP servers from the app (ask a bot "connect my Notion") or through the `add_connector` tool. Each connector gets read, full or off access, and tools whose names don't start with a read verb always count as writes.

## Add a bot template

Add it to `BOT_TEMPLATES` in `src/templates.ts` (name, job, style and an optional `look` for its Blip).

## House rules

- **Safety is enforced in code, never only in a prompt.** Don't add ways around approvals, the commit guard, protected paths or the secrets vault.
- **Background work is visible and quiet.** It never pops windows or permission dialogs, and always leaves a line in the chat.
- **Design:** monochrome (black, white, Geist), no emoji in the app or in Blip's messages, no purple or gradients.
- **Writing:** plain words the user would use. Errors say what happened and how to fix it.
