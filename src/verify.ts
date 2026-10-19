import { query } from "@anthropic-ai/claude-agent-sdk";
import type { BotProfile } from "./store.js";
import { askCard } from "./cards.js";
import { config } from "./config.js";
import { hooks } from "./hooks.js";
import { post } from "./outbox.js";
import { makeCanUseTool } from "./permissions.js";
import { createBlipServer } from "./tools.js";

// The double-check: after a task that changed something checkable, an independent checker with read-only
// tools confirms the result really exists (the file is there and says what was claimed, the event is in the
// calendar, the routine is listed). It catches the silent "done!" that wasn't. Browser-only work is skipped:
// the checker has no browser, and it never acts on anything.

const CHECKABLE = [
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "mcp__blip__calendar_add", "mcp__blip__reminders_add", "mcp__blip__add_routine", "mcp__blip__add_event_routine",
  "mcp__blip__save_skill", "mcp__blip__send_to_phone", "mcp__blip__create_page",
];
export const isCheckable = (tools: string[]) => tools.some((t) => CHECKABLE.includes(t));

export type Verdict = { verdict: "verified" | "not verified" | "can't check"; reason: string };

export async function verifyTask(bot: BotProfile, request: string, reply: string, steps: string[], model: string): Promise<Verdict> {
  // Tests only: a request containing FAILCHECK gets a failed check, so the card can be tested end to end.
  if (process.env.BLIP_FAKE_VERDICT === "1" && /\bFAILCHECK\b/.test(request)) return { verdict: "not verified", reason: "the test asked for a failed check (todo.txt is missing)" };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 150_000);
  const ctx = { bot, request, readOnly: true, taskAllows: new Set<string>(), runId: `verify-${Date.now()}` };
  try {
    let text = "";
    for await (const m of query({
      prompt: `The user asked: ${request.slice(0, 2000)}

The assistant then said: ${reply.slice(0, 3000)}

Steps it took: ${steps.slice(-30).join(" · ").slice(0, 3000)}

Independently check, using only read-only tools, whether what it claims to have done really exists now: files exist and contain what was claimed, calendar events or reminders are there with the right date and time, routines or skills are listed. Don't redo the work and don't change anything.
Reply with exactly one line, starting with one of:
VERIFIED: <what you checked, in a few words>
NOT VERIFIED: <what's missing or wrong>
CAN'T CHECK: <why>`,
      options: {
        model,
        effort: "low",
        maxTurns: 10,
        cwd: config.workspace,
        settingSources: [],
        tools: ["Read", "Glob", "Grep"], // no shell: read-only runs can't use it (calendar, routines and skills come from Blip's tools)
        systemPrompt: "You are an independent checker. You verify claims with read-only tools and report in one line. You never modify anything.",
        mcpServers: { blip: createBlipServer(bot, { background: true }) },
        canUseTool: makeCanUseTool(ctx), // read-only: anything that would change something is refused
        abortController: abort,
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "TELEGRAM_BOT_TOKEN" && !/^CLAUDE|^ANTHROPIC_(AUTH_TOKEN|BASE_URL)$/.test(k))),
      },
    })) {
      if (m.type === "result" && m.subtype === "success") text = m.result;
    }
    const line = text.trim().split("\n").find((l) => /^(VERIFIED|NOT VERIFIED|CAN'T CHECK):/i.test(l.trim()))?.trim() ?? "";
    const [, word, reason] = /^(VERIFIED|NOT VERIFIED|CAN'T CHECK):\s*(.*)$/i.exec(line) ?? [];
    if (!word) return { verdict: "can't check", reason: "the checker gave no clear answer" };
    return { verdict: word.toLowerCase() as Verdict["verdict"], reason: reason || "" };
  } catch (error) {
    return { verdict: "can't check", reason: (error as Error).message.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the double-check and says the outcome in the chat: a quiet line when it holds, a notification when not. */
export async function doubleCheck(bot: BotProfile, request: string, reply: string, steps: string[], model: string) {
  const v = await verifyTask(bot, request, reply, steps, model);
  if (v.verdict === "verified") post(bot.id, `Checked: ${v.reason.replace(/[.\s]+$/, "")}.`, { role: "system", push: false });
  else if (v.verdict === "not verified") {
    // A card, not just a line: one tap sends the bot back to fix it.
    const reason = v.reason.replace(/[.\s]+$/, "");
    void askCard({
      botId: bot.id,
      type: "check",
      title: `Double-check failed: ${reason}`.slice(0, 200),
      body: `${bot.name} said it was done, but an independent check couldn't confirm it.`,
      buttons: [{ label: `Ask ${bot.name} to fix it`, value: "fix", style: "primary" }, { label: "Dismiss", value: "dismiss" }],
      pushActions: ["fix"],
      timeoutMs: 24 * 3_600_000,
      timeoutValue: "dismiss",
    }).then(({ value }) => {
      if (value === "fix") hooks.startTask(bot.id, `An independent double-check of your last task found a problem: ${reason}.\n\nThe original request was: ${request.slice(0, 1500)}\n\nLook again, fix it, and check the result yourself before saying it's done.`, "Fix after double-check");
    });
  }
  else console.log(`[${bot.name}] double-check skipped: ${v.reason}`);
  return v;
}
