---
name: receipt-filing
description: When a receipt or invoice lands in a folder, rename it clearly, file it by month and log it in a spreadsheet.
---

Pair this with an event routine: add_event_routine (when: new_file, folder: the folder the user saves receipts to).

Inputs to ask for (first time only): the folder to file into (default ~/Blip/workspace/receipts), and the spreadsheet (default ~/Blip/workspace/receipts/receipts.csv).

1. Read the new file (PDF or image) and find: vendor, date, total, currency, what it was for.
2. Rename it to `YYYY-MM-DD vendor total.ext` (e.g. `2026-10-19 Uber 14.20 USD.pdf`).
3. Move it to `<filing folder>/YYYY-MM/`.
4. Add one row to the CSV: date, vendor, total, currency, category, file path. Create the CSV with a header row if it doesn't exist.
5. Check: the file is in the new place and the CSV row is there. Reply in one line, e.g. "Filed Uber 14.20 USD (Oct 19) under 2026-10."

If you can't read the amount or date, still move it but name it `UNREAD original-name` and tell the user which one.
