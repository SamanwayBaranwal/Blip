---
name: inbox-triage
description: Sort the inbox into needs-a-reply, waiting-on-them, bills and noise; draft replies but never send.
---

Inputs to ask for (only the first time): which account(s), anyone who is always important, anything to never touch.

1. Read the inbox: use mail_inbox (unread first, up to 50). If Mail isn't available, open the webmail in the browser.
2. Sort every message into one group:
   • Needs a reply from the user (a person asked something or is waiting)
   • Waiting on someone else (the user asked; no answer yet for 2+ days)
   • Bills, invoices, renewals (note amount and due date)
   • Noise (newsletters, promotions, notifications)
3. For each "needs a reply", write a short draft with propose_draft. Never send anything.
4. Reply to the user in this shape:
   • First line: how many need them, the most urgent one, and why.
   • Then a bullet per group, newest first, with sender, subject and one line of context.
5. Check: the counts add up to the number of messages you read. Say what you checked.

Edge cases: security or sign-in alerts always go at the top. Never unsubscribe, archive or delete without asking.
