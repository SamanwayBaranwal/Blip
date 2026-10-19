import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listSkills, memoryFile } from "./bots.js";
import { config } from "./config.js";
import { events, getThread, type Msg } from "./hub.js";
import { state } from "./store.js";

// Searchable memory. One full-text index (SQLite FTS5, built into Node) over:
//   • every bot's memory file and the shared notes about the user (rebuilt when the files change)
//   • every chat message ever sent or received — kept here permanently, even after the chat itself trims
//     old messages, so "what did I tell you about my landlord in August?" still has an answer
//   • saved skills
// Bots search it with the search_memory tool; nothing leaves the Mac.

const DB_FILE = path.join(config.dataDir, "memory-index.db");
let db: DatabaseSync | undefined;
let filesStamp = "";

function open() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(body, kind UNINDEXED, bot UNINDEXED, at UNINDEXED, ref UNINDEXED, tokenize='porter unicode61');
    CREATE TABLE IF NOT EXISTS seen (ref TEXT PRIMARY KEY);
  `);
  fs.chmodSync(DB_FILE, 0o600);
  return db;
}

const botName = (id: string) => state.bots.find((b) => b.id === id)?.name ?? "a deleted bot";

/** Adds a chat message to the permanent archive (once). Only real text: not progress, cards or errors. */
function archive(m: Msg) {
  if (m.kind !== "text" || m.role === "system" || !m.text?.trim() || m.meta?.error) return;
  const d = open();
  const ref = `chat:${m.id}`;
  if (d.prepare("SELECT 1 FROM seen WHERE ref = ?").get(ref)) return;
  d.prepare("INSERT INTO seen (ref) VALUES (?)").run(ref);
  d.prepare("INSERT INTO docs (body, kind, bot, at, ref) VALUES (?, ?, ?, ?, ?)").run(
    m.text.slice(0, 8000),
    m.role === "user" ? "you said" : "bot said",
    botName(m.botId),
    new Date(m.at).toISOString().slice(0, 10),
    ref,
  );
}

/** Memory files, shared notes and skills are small: re-index them whenever any of them changed. */
function refreshFiles() {
  const shared = path.join(config.workspace, "CLAUDE.md");
  const sources = [
    ...state.bots.map((b) => ({ file: memoryFile(b), kind: "memory", bot: b.name })),
    { file: shared, kind: "shared notes", bot: "everyone" },
  ];
  const skills = listSkills();
  const stamp = JSON.stringify([
    sources.map((s) => (fs.existsSync(s.file) ? fs.statSync(s.file).mtimeMs : 0)),
    skills.map((s) => s.name + s.description),
  ]);
  if (stamp === filesStamp) return;
  filesStamp = stamp;
  const d = open();
  d.exec("DELETE FROM docs WHERE kind IN ('memory', 'shared notes', 'skill')");
  const insert = d.prepare("INSERT INTO docs (body, kind, bot, at, ref) VALUES (?, ?, ?, ?, ?)");
  for (const s of sources) {
    if (!fs.existsSync(s.file)) continue;
    for (const line of fs.readFileSync(s.file, "utf8").split("\n")) {
      const text = line.replace(/^[-•*]\s*/, "").trim();
      if (!text || line.startsWith("#")) continue;
      insert.run(text, s.kind, s.bot, /\((\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ?? "", s.file);
    }
  }
  for (const sk of skills) insert.run(`${sk.name}: ${sk.description}`, "skill", "everyone", "", sk.name);
}

/** Turns plain words into a forgiving full-text query: any of the words, longer words matched by prefix. */
function toQuery(q: string) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const stop = new Set(["the", "and", "for", "you", "what", "did", "about", "with", "that", "this", "from", "my", "me", "is", "to", "of", "in", "on", "a", "i"]);
  const terms = [...new Set(words.filter((w) => !stop.has(w)))].slice(0, 12);
  return terms.map((t) => (t.length >= 4 ? `"${t}"*` : `"${t}"`)).join(" OR ");
}

export type MemoryHit = { kind: string; bot: string; at: string; text: string };

export function searchMemory(q: string, limit = 12): MemoryHit[] {
  const match = toQuery(q);
  if (!match) return [];
  refreshFiles();
  return open()
    .prepare(`SELECT kind, bot, at, snippet(docs, 0, '«', '»', '…', 24) AS text FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT ?`)
    .all(match, limit) as MemoryHit[];
}

const words = (t: string) => new Set((t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !["the", "and", "for", "you", "can", "please", "this", "that", "with", "what"].includes(w)));

/** Earlier user requests that say mostly the same thing (for spotting a task worth saving as a skill). */
export function similarRequests(text: string, opts: { days?: number; excludeRef?: string } = {}) {
  const match = toQuery(text);
  const mine = words(text);
  if (!match || mine.size < 3) return [];
  const since = new Date(Date.now() - (opts.days ?? 60) * 86_400_000).toISOString().slice(0, 10);
  const rows = open()
    .prepare(`SELECT body, at, ref FROM docs WHERE docs MATCH ? AND kind = 'you said' AND at >= ? ORDER BY bm25(docs) LIMIT 40`)
    .all(match, since) as { body: string; at: string; ref: string }[];
  return rows.filter((r) => {
    if (r.ref === opts.excludeRef) return false;
    const theirs = words(r.body);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    return shared / new Set([...mine, ...theirs]).size >= 0.5; // at least half the words in common
  });
}

/** Starts the index: archives any chat messages not seen yet, then keeps archiving as messages arrive. */
export function startMemoryIndex() {
  try {
    open();
    for (const b of state.bots) for (const m of getThread(b.id, 400)) archive(m);
    refreshFiles();
    events.on("msg", (m: Msg) => {
      try {
        archive(m);
      } catch (error) {
        console.error("Memory index:", (error as Error).message);
      }
    });
  } catch (error) {
    console.error("Searchable memory is off:", (error as Error).message);
  }
}
