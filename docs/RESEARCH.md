# Research: Grok Bot, ChatGPT Dots, Meta Muse

Gathered on 2026-10-17 to shape Blip. Most of it comes from official docs and hands-on reviews. Reddit and X were hard to fetch, so posts from there come quoted in articles. All three products were 3–10 weeks old, so many user reports cover only a few days of use.

## The products

| | Grok Bot (xAI) | Dots (OpenAI) | Muse (Meta) |
|---|---|---|---|
| Launched | Aug 11, 2026 (early beta) | Sep 29, 2026 (DevDay) | Sep 8, 2026 (US) |
| Model | xAI (not named) | GPT-6 Astra | Muse Spark |
| Computer | One persistent cloud computer per user, shared by all their bots | Its own cloud computer, plus the owner's laptop with permission | A Secure VM per user |
| Access | SuperGrok and Cursor plans | Pro and Business Premium (one Dot included) | Free, $20/mo and $100/mo |

### Grok Bot feature list (from docs.x.ai and its glossary)

- **Bots:** bots with a name, job and memory; a primary bot; helper bots; group chats of 2–6 bots with visible handoffs; team bots; duplicate and share as templates.
- **Computer:** browser, terminal and files, with `/workspace` shared by all bots. You can watch it or take control. Wake, Recover, Update and Reset controls. A setting for running commands on your own computer: ask, always, or never.
- **Skills:** skills run with "/"; "teach a task" by recording up to 10 minutes of your screen.
- **Routines:** up to 50 per bot, on a schedule or started by events (Slack, GitHub, webhook, email, Linear, Sentry, PagerDuty), with test runs.
- **Plugins:** Gmail, Calendar, Drive, Outlook, Teams, SharePoint, Salesforce and more, plus custom MCP. An agent email address; secret requests in masked fields; secure forms; 1Password.
- **Safety:** approval cards (Allow once / Always allow / Deny), Auto Review, "Ask first" rules (Ask first wins), and draft cards.
- **Pages:** documents and canvases, downloadable as PDF. Search on X; tag @bot on X. Hand-off to Cursor Cloud Agents.

### Dots

- Always on; proactive "research" that is read-only; auto-review; custom approval rules.
- Channels: ChatGPT on web, desktop and mobile, Slack, Teams, and voice calls.
- 4,000+ plugins; learns from feedback; "Take over" for passwords and payments.

### Muse

- Sends email, books, fills forms, negotiates, makes phone calls, and shops through Stripe Link.
- Sentinel permission agent with separate read and write access; an audit trail; "forget" on request.
- A realtime avatar, macOS app control, an agent email address, a smart-glasses wake word, and the Muse Charm device.

## What real users do with them

- **Inbox triage:** sort mail, find threads where someone is waiting on you, draft but don't send. This is the #1 use across all three.
- **Morning briefs and "what am I forgetting?" sweeps:** an unsent invoice, a cancelled train, a double booking, a strange login.
- **Money:** bills and negotiation (Muse users report saving $180 to $3,500 a year), refunds and claims, cancelling duplicate subscriptions, getting quotes.
- **Errands:** shopping, bookings, insurance forms, job applications, Marketplace, family logistics.
- **Business routines:** competitor scans to Notion, meeting prep, invoice hunting, content pipelines, nightly memory cleanup.
- **Bot teams:** a Chief of Staff bot manages specialists, and only yes/no decisions reach the user.

## Complaints, and how Blip answers them

| Complaint | Blip |
|---|---|
| Usage drains fast with no warning; no model picker (Grok #1) | Budget warnings at 50/80/100%, a model per bot, cost per reply and per run, spend per bot |
| Context grows forever and costs more | Context meter, a prompt to start fresh, a fresh-chat button |
| Tasks stall silently waiting on an approval (Dots) | Reminders, 3-hour approvals, a "waiting for you" state, a stall watchdog |
| Too many confirmations (Dots: 3 for one booking) | "Allow for this task" |
| A standing approval shared a home address and accepted a $10 offer (Muse) | No permanent approval for clicking or typing; the commit guard; Auto Review checks for sharing personal details |
| "The instruction is a hope": prompts don't stop sends (Grok) | The commit guard is enforced in code |
| Memory can't be edited (Dots) | Delete any line, plus a date and source on each fact |
| Too many pings | Silent "nothing new" routines, silent progress messages, mute per bot, capped suggestions |
| Datacenter IPs get blocked (Shopify, Amazon, X) | Runs on the user's home connection |
| Made-up phone numbers, stale dates (Muse) | Bots must check facts against a live source, never invent contacts, and get today's date |
| Blank screen on day one | Welcome message, starter chips, templates |

## Sources (main)

- docs.x.ai/grok-bot/security, docs.x.ai/grok-bot/security-faq, x.ai/news/grok-bot-more-plans, grokbotwiki.com glossary
- forum.cursor.com Grok Bot threads (usage, login bugs), news.ycombinator.com Grok Bot threads
- wrightmode.com, flaviocopes.com, aimaker.substack.com, ryandoser.com (Grok Bot hands-on)
- platformer.news, zapier.com/blog/chatgpt-dots, dev.to (uehara), community.openai.com (Dots)
- about.fb.com Muse launch, Wikipedia "Muse (AI agent)", tech.yahoo.com Reddit roundup, memeburn.com, lennysnewsletter.com, dnyuz.com (Wired)
