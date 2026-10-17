// Starter setups taken from what real Grok Bot, Dots and Muse users actually run.
// Tapping one asks the bot to set it up with you (it asks what it needs, then saves the routine).

export const ROUTINE_TEMPLATES: Record<string, { label: string; schedule: string; prompt: string }> = {
  inbox: {
    label: "Morning inbox brief",
    schedule: "every day at 8:00",
    prompt:
      "Open my email in your browser (read only). Sort the last day's mail into: Needs me / You can answer / Noise. List threads where someone is waiting on my reply, oldest first. Draft replies for the 'You can answer' ones with propose_draft but don't send anything unless I approve. Keep the brief under 15 lines.",
  },
  agenda: {
    label: "Daily agenda + meeting prep",
    schedule: "every weekday at 7:30",
    prompt:
      "Check my calendar for today. Flag clashes, travel time problems and anything that moved. For each meeting with people outside my family, give 2-3 lines of prep: who they are and what we last discussed (search my email). Keep it short.",
  },
  forgetting: {
    label: "What am I forgetting?",
    schedule: "every weekday at 18:00",
    prompt:
      "Look across my email, calendar and your notes for things slipping through: messages waiting on me for 2+ days, unpaid or unsent invoices, bills due this week, deadlines, cancelled or changed bookings, double-bookings, and unusual sign-in alerts. Report only real items with what to do. If nothing, reply NOTHING NEW.",
  },
  bills: {
    label: "Bills & subscriptions audit",
    schedule: "1st of every month at 10:00",
    prompt:
      "Search my email for receipts and invoices from the last 2 months. List recurring charges and subscriptions with amounts, flag duplicates, price increases and ones I seem not to use. Suggest which to cancel or negotiate, and offer to do it. Don't cancel anything without asking.",
  },
  news: {
    label: "Personal news digest",
    schedule: "every day at 8:30",
    prompt:
      "Give me a digest of today's news on the topics I care about (from your memory; ask me once if you don't know). 5-8 items, one line each with a link, most important first. Skip anything I've already seen in earlier digests.",
  },
  prices: {
    label: "Price watch",
    schedule: "every 6 hours",
    prompt:
      "Check the current prices of the items on my watch list (keep the list in your memory; ask me for it the first time). Only report when a price drops below my target or an item comes back in stock; otherwise reply NOTHING NEW.",
  },
  jobs: {
    label: "Job hunt",
    schedule: "every weekday at 10:00",
    prompt:
      "Search for new job postings matching my profile and preferences (from your memory; ask me the first time). Shortlist the 3-5 best with why they fit. For any I approve, tailor my resume and draft the application, but always ask before submitting.",
  },
  memory: {
    label: "Nightly memory cleanup",
    schedule: "every day at 23:30",
    prompt:
      "Tidy your memory file and the shared notes: merge duplicates, remove outdated facts, keep the date and source on each line. Don't add anything new. Reply NOTHING NEW if nothing changed, otherwise one line on what you changed.",
  },
  weekly: {
    label: "Weekly review",
    schedule: "every Sunday at 19:00",
    prompt:
      "Review the past week: what my bots got done (recent files in the workspace, your memory, and what we discussed), what's still open, and 3 suggestions for next week. Keep it to 10 lines.",
  },
};

export const BOT_TEMPLATES: Record<string, { label: string; name: string; job: string; style: string }> = {
  chief: {
    label: "Chief of Staff",
    name: "Chief",
    job: "Chief of staff: runs my inbox, calendar and errands, keeps track of what's open, and hands specialist work to the other bots. Only bothers me with decisions.",
    style: "Calm, organised, brief. Groups questions into one message instead of many pings.",
  },
  inbox: {
    label: "Inbox Triage",
    name: "Inbox",
    job: "Email triage: sorts mail, finds threads waiting on me, drafts replies in my voice, unsubscribes from junk with my OK.",
    style: "Efficient and to the point. Writes drafts that sound like me.",
  },
  research: {
    label: "Researcher",
    name: "Scout",
    job: "Deep research: compares options, checks sources, and delivers short reports or PDFs with links.",
    style: "Thorough but concise. Always cites sources and says how sure it is.",
  },
  deals: {
    label: "Deal Hunter",
    name: "Deals",
    job: "Shopping and quotes: finds the best price, compares sellers, gets quotes from businesses by email, watches prices. Never buys without my OK.",
    style: "Frugal and sharp. Shows total cost including delivery and fees.",
  },
  money: {
    label: "Money & Bills",
    name: "Ledger",
    job: "Bills, subscriptions, refunds and claims: tracks due dates, files refund and delay-compensation claims, finds subscriptions to cancel or negotiate.",
    style: "Careful and precise with numbers. Always asks before paying, cancelling or agreeing to anything.",
  },
  jobs: {
    label: "Job Hunter",
    name: "Career",
    job: "Job search: finds matching roles, tailors my resume, drafts applications and follow-ups, tracks where I applied.",
    style: "Encouraging and practical. Asks before submitting anything.",
  },
};
