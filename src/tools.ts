import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { slug } from "./bots.js";
import { askCard } from "./cards.js";
import { config } from "./config.js";
import { hooks } from "./hooks.js";
import * as mac from "./mac.js";
import { post } from "./outbox.js";
import { inside, isSensitive } from "./permissions.js";
import { addRoutine, describeRoutines, removeRoutine } from "./routines.js";
import { save, state, today, type BotProfile } from "./store.js";

const MAX_SUGGESTIONS_PER_DAY = 3;
const text =(t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

async function screenForModel(note: string) {
  const shot = await mac.screenshotForModel();
  return {
    content: [
      { type: "image" as const, data: fs.readFileSync(shot.file).toString("base64"), mimeType: "image/jpeg" },
      { type: "text" as const, text: `${note}Screenshot is ${shot.width}x${shot.height} px; use these pixel coordinates with mac_click.` },
    ],
  };
}

/** In-process tools for one run: phone delivery, Mac control, routines, skills, drafts, takeovers, suggestions, connectors. */
export function createBlipServer(bot: BotProfile) {
  return createSdkMcpServer({
    name: "blip",
    tools: [
      tool(
        "send_to_phone",
        "Share a file (image, PDF, document, audio, etc.) with the user: it appears in the chat and the Files panel on their phone.",
        { path: z.string().describe("Absolute path, or relative to the workspace"), caption: z.string().optional() },
        async ({ path: p, caption }) => {
          const full = path.resolve(config.workspace, p);
          if (isSensitive(full)) return text("That file is protected and can't be sent.", true);
          if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return text(`No file at ${full}`, true);
          if (!inside(full, config.workspace)) {
            // The app serves files from the workspace only, so copy anything outside it in first.
            const copy = path.join(config.workspace, "shared", path.basename(full));
            fs.mkdirSync(path.dirname(copy), { recursive: true });
            fs.copyFileSync(full, copy);
            post(bot.id, caption ?? "", { files: [copy] });
          } else {
            post(bot.id, caption ?? "", { files: [full] });
          }
          return text(`Shared ${path.basename(full)} with the user.`);
        },
      ),

      // ---- Mac app control ----
      tool(
        "mac_screenshot",
        "See this Mac's screen. Returns the screenshot to you. Set send_to_phone to also show it to the user.",
        { send_to_phone: z.boolean().optional(), caption: z.string().optional() },
        async ({ send_to_phone, caption }) => {
          if (send_to_phone) post(bot.id, caption ?? "", { files: [await mac.screenshotForPhone()] });
          return screenForModel(send_to_phone ? "Also sent to the user's phone. " : "");
        },
      ),
      tool(
        "mac_click",
        "Click on the Mac screen at pixel coordinates from your latest mac_screenshot. Returns a new screenshot.",
        { x: z.number(), y: z.number(), kind: z.enum(["left", "right", "double"]).optional(), why: z.string().describe("What you're clicking, for the approval card") },
        async ({ x, y, kind }) => {
          await mac.click(x, y, kind ?? "left");
          await new Promise((r) => setTimeout(r, 700));
          return screenForModel("Clicked. ");
        },
      ),
      tool("mac_type", "Type text into the focused field on the Mac.", { text: z.string() }, async ({ text: t }) => {
        await mac.typeText(t);
        return text("Typed.");
      }),
      tool(
        "mac_key",
        'Press a key or shortcut on the Mac, e.g. "return", "esc", "tab", "cmd+space", "cmd+shift+4", "arrow-down".',
        { keys: z.string() },
        async ({ keys }) => {
          await mac.pressKeys(keys);
          await new Promise((r) => setTimeout(r, 500));
          return screenForModel(`Pressed ${keys}. `);
        },
      ),
      tool("mac_scroll", "Scroll the focused window.", { direction: z.enum(["up", "down"]), pages: z.number().optional() }, async ({ direction, pages }) => {
        await mac.scroll(direction, pages ?? 1);
        return screenForModel("Scrolled. ");
      }),
      tool("mac_open_app", "Open (or bring to front) a Mac app by name, e.g. Notes, Calendar, Finder.", { app: z.string() }, async ({ app }) => {
        await mac.openApp(app);
        await new Promise((r) => setTimeout(r, 1500));
        return screenForModel(`Opened ${app}. `);
      }),

      // ---- Routines ----
      tool(
        "add_routine",
        `Schedule a task you will run automatically and report to the user. Times are in ${config.timezone}. ` +
          `Use a 5-field cron for repeating tasks ("0 8 * * *" = daily 8:00, "0 9 * * 1" = Mondays 9:00, "*/30 * * * *" = every 30 min) ` +
          `or a local ISO date-time for one time ("2026-10-18T09:00:00"). For "when X happens" requests, poll on a sensible cron and only report when X happened.`,
        {
          name: z.string().describe("Short name, e.g. 'Morning news'"),
          schedule: z.string(),
          prompt: z.string().describe("Complete, self-contained instructions for each run"),
        },
        async ({ name, schedule, prompt }) => {
          try {
            const { routine, next } = addRoutine(bot.id, name, schedule, prompt);
            return text(`Routine "${routine.name}" [${routine.id}] saved for ${bot.name}. Next run: ${next.toLocaleString("en-US", { timeZone: config.timezone })}`);
          } catch (error) {
            return text(`Could not schedule: ${(error as Error).message}`, true);
          }
        },
      ),
      tool("list_routines", "List all scheduled routines.", {}, async () => text(describeRoutines())),
      tool("remove_routine", "Delete a scheduled routine by id.", { id: z.string() }, async ({ id }) =>
        removeRoutine(id) ? text(`Removed routine ${id}.`) : text(`No routine with id ${id}.`, true),
      ),

      // ---- Skills ----
      tool(
        "save_skill",
        "Save (or update) a reusable skill: step-by-step instructions for a task, shared by all bots and runnable by the user with /skills.",
        {
          name: z.string().describe("Short name, e.g. 'expense-report'"),
          description: z.string().describe("One line: what it does and when to use it"),
          instructions: z.string().describe("Markdown steps, including inputs needed, sites/apps used, criteria and edge cases the user showed you"),
        },
        async ({ name, description, instructions }) => {
          const dir = path.join(config.skillsDir, slug(name));
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${slug(name)}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${instructions}\n`);
          return text(`Skill "${slug(name)}" saved. It's available to all bots from the next message.`);
        },
      ),

      // ---- Human-in-the-loop ----
      tool(
        "propose_draft",
        "Show the user a draft email/message/post before sending it as them. They can send, edit or discard it. Only send after approval, using the returned final text.",
        {
          channel: z.string().describe("email, WhatsApp message, Slack message, post, etc."),
          to: z.string(),
          subject: z.string().optional(),
          body: z.string(),
        },
        async ({ channel, to, subject, body }) =>
          text(`APPROVED by the user. Send this ${channel} to ${to} now${subject ? ` with subject "${subject}"` : ""}, using exactly this text:\n\n${body}`),
      ),
      tool(
        "request_takeover",
        "Hand the Mac to the user for a step only they should do (sign-in, password, 2FA code, CAPTCHA, payment). Waits until they tap Done.",
        { reason: z.string().describe("Exactly what they need to do, e.g. 'Sign in to Amazon in the Chrome window that's open'") },
        async () => text("The user says they've finished that step. Check the screen or page to confirm before continuing."),
      ),
      tool(
        "suggest",
        "Offer the user something useful you could do for them. They get a card with 'Do it' / 'Dismiss'. Use sparingly: only genuinely valuable, specific ideas.",
        {
          title: z.string(),
          why: z.string().describe("One or two sentences: why this helps them now"),
          plan: z.string().describe("Self-contained instructions you'd follow if they say yes"),
        },
        async ({ title, why, plan }) => {
          const day = today();
          if ((state.suggestionsByDay[day] ?? 0) >= MAX_SUGGESTIONS_PER_DAY) {
            return text("Daily suggestion limit reached. Don't suggest anything else today.", true);
          }
          state.suggestionsByDay = { [day]: (state.suggestionsByDay[day] ?? 0) + 1 };
          state.recentSuggestions = [...state.recentSuggestions, title].slice(-30);
          save();
          void askCard({
            botId: bot.id,
            type: "suggestion",
            title,
            body: why,
            buttons: [{ label: "Do it", value: "do", style: "primary" }, { label: "Not useful", value: "no" }],
            timeoutMs: 24 * 60 * 60_000,
            timeoutValue: "ignored",
          }).then(({ value: choice }) => {
            if (choice === "do") hooks.startTask(bot.id, plan, `suggestion: ${title}`);
            if (choice === "no") {
              state.dismissedSuggestions = [...state.dismissedSuggestions, title].slice(-30);
              save();
            }
          });
          return text("Suggestion sent to the user.");
        },
      ),

      // ---- Connectors ----
      tool(
        "add_connector",
        "Add an app connector (an MCP server) so all bots can use that app's tools. Always asks the user first. Takes effect from the next message.",
        {
          name: z.string().describe("Short lowercase name, e.g. 'notion'"),
          type: z.enum(["stdio", "http"]),
          command: z.string().optional().describe("For stdio: executable, e.g. 'npx'"),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          url: z.string().optional().describe("For http: the server URL"),
          headers: z.record(z.string(), z.string()).optional(),
          access: z.enum(["read", "full"]).optional().describe("read = only tools that look things up"),
        },
        async ({ name, type, command, args, env, url, headers, access }) => {
          const key = slug(name).replace(/-/g, "");
          if (["blip", "browser"].includes(key)) return text("That name is reserved.", true);
          if (type === "stdio" && !command) return text("stdio connectors need a command.", true);
          if (type === "http" && !url) return text("http connectors need a url.", true);
          state.connectors[key] = { type, command, args, env, url, headers, access: access ?? "read" };
          save();
          return text(`Connector "${key}" added with ${access ?? "read"} access. Its tools appear from the next message as mcp__${key}__*.`);
        },
      ),
    ],
  });
}
