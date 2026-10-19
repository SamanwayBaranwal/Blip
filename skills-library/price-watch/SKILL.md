---
name: price-watch
description: Watch a price (a product, a flight, a stock or coin) on a schedule and only report when it crosses the user's target.
---

Inputs to ask for: what to watch (link or name), the target (below or above what), and how often (default every 6 hours; never more than every 10 minutes).

1. Save it as a routine with add_routine. Its prompt must include the link, the target and the rule "reply NOTHING NEW unless the target is crossed".
2. Each run: open the page in the browser (or use web search for market prices), read the current price, and compare it with the target.
3. If it crossed: one line with the price, the target, the time and the link. Offer the next step (buy, book, sell) but never do it without the user's approval.
4. If it didn't: reply exactly NOTHING NEW (the user isn't pinged).

If the page layout changed and the price can't be found, tell the user once instead of failing quietly.
