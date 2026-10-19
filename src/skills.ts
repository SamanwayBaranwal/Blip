import fs from "node:fs";
import path from "node:path";
import { slug } from "./bots.js";
import { config, ROOT } from "./config.js";
import { save, state } from "./store.js";

// Skills are folders with a SKILL.md (a short header, then the steps). Every save keeps the previous version,
// skills can be exported and imported as a single .md file, and a library of examples ships with Blip.

const LIBRARY = path.join(ROOT, "skills-library");
const KEEP_VERSIONS = 20;

const skillDir = (name: string) => {
  if (!/^[\w-][\w.-]*$/.test(name)) throw new Error("That isn't a valid skill name.");
  return path.join(config.skillsDir, name);
};
export const skillPath = (name: string) => path.join(skillDir(name), "SKILL.md");

/** Writes a skill, keeping the version it replaces. */
export function writeSkill(name: string, text: string) {
  const file = skillPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, "utf8");
    if (old === text) return;
    const dir = path.join(path.dirname(file), ".versions");
    fs.mkdirSync(dir, { recursive: true });
    // Time first (so names sort by age), plus a counter so two saves in the same millisecond never collide.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let n = 0;
    while (fs.existsSync(path.join(dir, `${stamp}-${n}.md`))) n++;
    fs.writeFileSync(path.join(dir, `${stamp}-${n}.md`), old);
    const all = fs.readdirSync(dir).sort();
    for (const f of all.slice(0, Math.max(0, all.length - KEEP_VERSIONS))) fs.rmSync(path.join(dir, f), { force: true });
  }
  fs.writeFileSync(file, text);
}

export function skillVersions(name: string) {
  const dir = path.join(skillDir(name), ".versions");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .map((f) => {
      const id = f.replace(/\.md$/, "");
      const at = id.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z(-\d+)?$/, "T$1:$2:$3.$4Z");
      return { id, at, bytes: fs.statSync(path.join(dir, f)).size };
    });
}

export function restoreSkillVersion(name: string, id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error("No such version.");
  const file = path.join(skillDir(name), ".versions", `${id}.md`);
  if (!fs.existsSync(file)) throw new Error("No such version.");
  writeSkill(name, fs.readFileSync(file, "utf8"));
}

/**
 * Turns any skill text into a safe one: only a name and a description in the header. Anything else there
 * (like `allowed-tools`, which would let a skill skip Blip's approvals) is dropped.
 */
export function cleanSkill(text: string, fallbackName = "imported-skill") {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  const header = m?.[1] ?? "";
  const body = (m ? m[2]! : text).trim();
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(header)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const name = slug(field("name") || fallbackName).slice(0, 60);
  const description = (field("description") || body.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "Imported skill").replace(/\s+/g, " ").slice(0, 300);
  if (!body) throw new Error("That skill has no steps.");
  return { name, text: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n` };
}

/** Imports a skill file. A name that's taken gets a number added, so nothing is overwritten. */
export function importSkill(text: string, fileName = "") {
  const clean = cleanSkill(text, fileName.replace(/(\.skill)?\.md$/i, ""));
  let name = clean.name;
  for (let i = 2; fs.existsSync(skillPath(name)); i++) name = `${clean.name}-${i}`;
  writeSkill(name, clean.text.replace(/^name: .*$/m, `name: ${name}`));
  return name;
}

export function libraryList() {
  if (!fs.existsSync(LIBRARY)) return [];
  return fs
    .readdirSync(LIBRARY, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(LIBRARY, d.name, "SKILL.md")))
    .map((d) => {
      const text = fs.readFileSync(path.join(LIBRARY, d.name, "SKILL.md"), "utf8");
      return { name: d.name, description: /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "", installed: fs.existsSync(skillPath(d.name)) };
    });
}

export function addFromLibrary(name: string) {
  const file = path.join(LIBRARY, path.basename(name), "SKILL.md");
  if (!fs.existsSync(file)) throw new Error("That skill isn't in the library.");
  const clean = cleanSkill(fs.readFileSync(file, "utf8"), name);
  writeSkill(clean.name, clean.text);
  return clean.name;
}

/** Remembers when a skill was last used (shown in Skills). Several uses in one minute count once. */
export function noteSkillUse(name: string) {
  if (!name || !/^[\w-][\w.-]*$/.test(name) || !fs.existsSync(skillPath(name))) return;
  const use = (state.skillUse ??= {});
  const prev = use[name];
  if (prev && Date.now() - Date.parse(prev.at) < 60_000) return;
  use[name] = { at: new Date().toISOString(), count: (prev?.count ?? 0) + 1 };
  save();
}

/** The saved skills with what the Skills screen shows about each: version number and last use. */
export function skillsOverview(list: { name: string; description: string }[]) {
  return list.map((s) => ({ ...s, version: skillVersions(s.name).length + 1, lastUsed: state.skillUse?.[s.name]?.at ?? null, uses: state.skillUse?.[s.name]?.count ?? 0 }));
}
