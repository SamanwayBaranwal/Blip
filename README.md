<div align="center">

<a href="https://blip-jade.vercel.app"><img src="site/assets/social.png" alt="Blip: an AI agent with its own computer" width="100%" /></a>

# Blip

**An AI agent with its own computer.**<br />
It lives on your Mac and does the real work. You message it from your phone, from anywhere.

[![License: MIT](https://img.shields.io/badge/license-MIT-141413?style=flat-square)](LICENSE)
[![macOS](https://img.shields.io/badge/runs%20on-macOS-141413?style=flat-square&logo=apple&logoColor=white)](#install-in-5-steps)
[![Built on Claude](https://img.shields.io/badge/built%20on-Claude%20Agent%20SDK-141413?style=flat-square)](https://docs.claude.com/en/docs/agent-sdk/overview)
[![iPhone and Android](https://img.shields.io/badge/phone-iPhone%20%26%20Android-141413?style=flat-square)](#install-in-5-steps)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-141413?style=flat-square)](CONTRIBUTING.md)

[Website](https://blip-jade.vercel.app) · [Install](#install-in-5-steps) · [Features](#features) · [How it works](#how-it-works) · [Full guide](docs/GUIDE.md)

</div>

---

## Quick start

1. **Get a Mac that stays on** (a Mac mini or an old MacBook) with [Chrome](https://www.google.com/chrome/), [Homebrew](https://brew.sh) and `xcode-select --install`.
2. **Install Blip:** `curl -fsSL https://raw.githubusercontent.com/SamanwayBaranwal/blip/main/install.sh | zsh`
3. **Connect Claude:** install [Claude Code](https://claude.com/claude-code) and sign in once, or add an Anthropic API key in the app.
4. **Allow the Mac permissions:** turn on **node** under Screen Recording and Accessibility, then run `~/Blip/blip.sh restart`.
5. **Put it on your phone:** open Blip on the Mac, tap **Set up**, email yourself the link, and add it to your Home Screen.

More detail on each step is in [Install in 5 steps](#install-in-5-steps).

## Why Blip

> "I didn't open my laptop for 10 days. Blip did my work."

For ten days I ran my work through Blip from my phone. One prompt at a time, it built a ClickUp-style project platform for my company and set up many of my day-to-day automations, while the Mac sat at home doing the work.

Blip gives an AI a real computer: a terminal, files, a real Chrome browser and your Mac's own apps. It tells you what it's about to do, does it, and shows you the proof. Anything that sends, pays or deletes waits for your OK.

**Got a Mac mini sitting there?** Maybe you bought it for OpenClaw. Blip runs on the same machine, installs in one line, and turns it into an agent you use every day from your phone.

## See it

<table>
  <tr>
    <td width="33%"><img src="site/assets/chat-board.jpg" alt="Blip replies first, works, then shows the files and screenshots" /></td>
    <td width="33%"><img src="site/assets/group.jpg" alt="A group chat where three bots split one job" /></td>
    <td width="33%"><img src="site/assets/chat-draft.jpg" alt="An email draft waiting for approval" /></td>
  </tr>
  <tr>
    <td align="center"><b>Replies first, then works</b><br /><sub>Steps, files and screenshots as proof</sub></td>
    <td align="center"><b>A team of bots</b><br /><sub>The lead splits the job; they work at once</sub></td>
    <td align="center"><b>Nothing goes out without you</b><br /><sub>Drafts you edit, then approve</sub></td>
  </tr>
</table>

## Features

| | |
|---|---|
| **Talks while it works** | Replies "On it" in seconds, then works. Send three messages and each gets its own answer, in order. |
| **Real computer** | Terminal, files, a real Chrome browser with your logins, and Mac apps: Calendar, Reminders, Contacts, Mail, Spotlight. |
| **Group chats** | Put several bots in one chat. The lead hands parts to the others, and they work in parallel. `@Name` asks one directly. |
| **Proof of work** | Screenshots of what it did, a replay of its browser session, the files it made, and an independent double-check. |
| **You stay in control** | Approval cards for anything risky, editable drafts, Auto Review, "Ask first" rules, and Allow / Deny right on the notification. |
| **Remote control** | See and use the Mac's screen from your phone, like Chrome Remote Desktop. |
| **Routines and triggers** | "Every weekday at 9, brief me on my inbox." Or start a routine from an email, a new file or a link. |
| **Use it anywhere** | One tap sets up a secure link from any network or country. Nothing to install on the phone. |
| **Voice** | Hands-free talk mode, voice messages and spoken replies. Speech-to-text runs on the Mac. |
| **Memory and skills** | It remembers what you told it, searches every past chat, and learns skills, including by watching you do a task once. |
| **Its own email** | Give it a mailbox. People can email your bot; every reply is a draft you approve. |
| **Privacy** | Lock chats with a passcode or Face ID. Passwords live in the Mac's Keychain; bots only see placeholders. |
| **Phone app** | Installs on your iPhone or Android Home Screen from the browser, with notifications. There's a Mac app too. |

Every feature is described in detail in the [full guide](docs/GUIDE.md).

## Install in 5 steps

You need a Mac that can stay on (a Mac mini or an old MacBook is perfect) and your phone. It takes about 15 minutes.

**1. Prepare the Mac.** Plug it in, then install [Google Chrome](https://www.google.com/chrome/) (no extension needed), [Homebrew](https://brew.sh), and Apple's developer tools:

```bash
xcode-select --install
```

**2. Install Blip.** It installs everything else (Node.js, ffmpeg, speech-to-text, the Cloudflare tunnel) and starts Blip in `~/Blip`:

```bash
curl -fsSL https://raw.githubusercontent.com/SamanwayBaranwal/blip/main/install.sh | zsh
```

**3. Connect Claude.** Install [Claude Code](https://claude.com/claude-code) and sign in once: Blip runs on your Claude plan. Or add an Anthropic API key in the app.

**4. Allow the Mac permissions.** In **System Settings → Privacy & Security**, turn on **node** under **Screen & System Audio Recording** and **Accessibility**. Then run `~/Blip/blip.sh restart`, and in Blip open **Settings → This Mac → Check Mac access**.

**5. Put it on your phone.** Open Blip on the Mac and tap **Set up**:
1. Turn on your link.
2. Add your email.
3. Add a new Gmail for Blip, with an [app password](https://myaccount.google.com/apppasswords).
4. Tap **Email me the link**. Open the email on your phone and tap the link, then use *Share → Add to Home Screen*.

Running the install line again updates Blip. More details are in [Set up on a new Mac](docs/GUIDE.md#set-up-on-a-new-mac).

## How it works

```mermaid
flowchart LR
  P["Your phone<br/>(Blip app)"] -- "secure link<br/>Cloudflare or Tailscale" --> S["Blip on your Mac<br/>app server · scheduler · approvals"]
  T["Telegram<br/>(optional)"] --> S
  S --> B1["Bot"] & B2["Bot"] & B3["Bot"]
  B1 & B2 & B3 --> C["Claude<br/>(Agent SDK)"]
  B1 & B2 & B3 --> K["The Mac<br/>Chrome · terminal · files · Mac apps · email"]
```

- Each bot is a [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview) agent with Blip's own tools, a real Chrome browser (Playwright) and any connectors you add.
- Bots work in parallel. They take turns only on the shared screen and browser.
- Everything (chats, memory, files, settings) stays on your Mac. There is no Blip server.
- Built with TypeScript and Node.js, with a [Preact](https://preactjs.com) app and a small Swift helper for the Mac. See [How it's built](docs/GUIDE.md#how-its-built).

## Safety

- **Asks before it acts.** Sending, paying, deleting, booking and accepting always come to you as a card first, whatever your other rules say.
- **A second pair of eyes.** An independent reviewer checks risky actions, and a double-check confirms the work really happened.
- **Your secrets stay secret.** Passwords go into the Mac's Keychain; bots only ever see a placeholder, and tool output is scrubbed.
- **Your data stays home.** Chats, memory and files live on your Mac. Only your requests go to the AI model.

More in [Security notes](docs/GUIDE.md#security-notes).

## FAQ

**Is it free?** Yes: open source under MIT. It runs on your Claude plan, or on an API key with a daily spending limit.

**Which Mac?** Any Mac that can stay on, Apple Silicon or Intel. A Mac mini is ideal.

**Already running another agent on that Mac mini?** Blip installs into its own folder (`~/Blip`) as its own background service, so you can try it alongside.

**Do I need the App Store?** No. The phone app installs from the browser.

## Contributing

Ideas, skills, tools and fixes are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), then open an issue or a pull request. Run `npm test` (unit tests) and `npm run test:golden` (end-to-end, on a throwaway server) before sending a change.

## License

[MIT](LICENSE) © 2026 Samanway Baranwal
