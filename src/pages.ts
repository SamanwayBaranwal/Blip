import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { slug } from "./bots.js";
import { config } from "./config.js";

// Pages: bots write Markdown, Blip turns it into a clean document or a 16:9 slide deck (HTML that opens in the
// app, plus a PDF). Monochrome, Geist, no scripts: the same look as Blip, and safe to open.

const run = promisify(execFile);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let fontCss: string | undefined;

function fonts() {
  if (fontCss !== undefined) return fontCss;
  const face = (file: string, family: string) => {
    const p = path.join(config.webDir, "fonts", file);
    return fs.existsSync(p) ? `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${fs.readFileSync(p).toString("base64")}) format("woff2");font-weight:100 900;}` : "";
  };
  fontCss = face("Geist-Variable.woff2", "Geist") + face("GeistMono-Variable.woff2", "Geist Mono");
  return fontCss;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Images become part of the page (data URIs), so it's one self-contained file that works anywhere. */
function image(src: string, alt: string) {
  if (/^https:\/\//.test(src)) return `<img src="${esc(src)}" alt="${esc(alt)}">`;
  const full = path.resolve(config.workspace, src.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  const type = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" }[path.extname(full).toLowerCase()];
  if (!type || !fs.existsSync(full) || fs.statSync(full).size > 4_000_000) return `<em>[image: ${esc(alt || src)}]</em>`;
  return `<img src="data:${type};base64,${fs.readFileSync(full).toString("base64")}" alt="${esc(alt)}">`;
}

function inline(text: string) {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => image(src.replace(/&amp;/g, "&"), alt))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]!);
}

/** A small Markdown renderer: headings, paragraphs, lists (nested), tables, quotes, code, rules, images. */
export function markdownToHtml(md: string) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = /^(#+)/.exec(line)![1]!.length;
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ""))}</h${level}>`);
      i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
    } else if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(`<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
    } else if (/^\s*([-*•+]|\d+[.)])\s+/.test(line)) {
      // Lists, nested by indentation.
      const stack: { indent: number; tag: string }[] = [];
      const html: string[] = [];
      while (i < lines.length && /^\s*([-*•+]|\d+[.)])\s+/.test(lines[i]!)) {
        const l = lines[i++]!;
        const indent = /^\s*/.exec(l)![0].length;
        const tag = /^\s*\d/.test(l) ? "ol" : "ul";
        while (stack.length && indent < stack.at(-1)!.indent) html.push(`</li></${stack.pop()!.tag}>`);
        if (!stack.length || indent > stack.at(-1)!.indent) {
          stack.push({ indent, tag });
          html.push(`<${tag}><li>`);
        } else html.push("</li><li>");
        html.push(inline(l.replace(/^\s*([-*•+]|\d+[.)])\s+/, "")));
      }
      while (stack.length) html.push(`</li></${stack.pop()!.tag}>`);
      out.push(html.join(""));
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|\s*>|\s*([-*•+]|\d+[.)])\s+)/.test(lines[i]!) && !(lines[i]!.includes("|") && isTableSep(lines[i + 1] ?? ""))) para.push(lines[i++]!);
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
  }
  return out.join("\n");
}

const DOC_CSS = `
:root{--ink:#111113;--muted:#5b5b63;--line:#e4e4e7;--soft:#f5f5f6}
*{box-sizing:border-box}html{background:#fff}
body{margin:0;color:var(--ink);font:16px/1.65 Geist,-apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:56px 24px 80px}
header{margin-bottom:36px;padding-bottom:20px;border-bottom:1px solid var(--line)}
header .kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
h1{font-size:34px;line-height:1.15;letter-spacing:-.025em;margin:8px 0 0;text-wrap:balance}
h2{font-size:22px;letter-spacing:-.015em;margin:38px 0 10px}h3{font-size:17px;margin:28px 0 8px}h4,h5,h6{font-size:15px;margin:22px 0 6px}
p{margin:0 0 14px}ul,ol{margin:0 0 14px;padding-left:22px}li{margin:3px 0}
a{color:var(--ink);text-underline-offset:3px}
code{font:13.5px "Geist Mono",ui-monospace,monospace;background:var(--soft);padding:1px 5px;border-radius:5px}
pre{background:var(--soft);padding:14px 16px;border-radius:10px;overflow-x:auto}pre code{background:none;padding:0}
blockquote{margin:0 0 14px;padding:2px 16px;border-left:2px solid var(--ink);color:var(--muted)}
table{width:100%;border-collapse:collapse;margin:6px 0 18px;font-size:14.5px;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:600;border-bottom:1.5px solid var(--ink);padding:7px 10px 7px 0}
td{border-bottom:1px solid var(--line);padding:7px 10px 7px 0;vertical-align:top}
hr{border:0;border-top:1px solid var(--line);margin:28px 0}img{max-width:100%;border-radius:8px}
footer{margin-top:48px;font-size:12px;color:var(--muted)}
@page{size:A4;margin:18mm 16mm}@media print{main{padding:0;max-width:none}h2,h3{break-after:avoid}tr,img,pre{break-inside:avoid}}`;

const DECK_CSS = `
*{box-sizing:border-box}html,body{margin:0;background:#0b0b0c}
body{font-family:Geist,-apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;padding:16px;display:grid;gap:16px;justify-items:center}
.slide{width:min(1280px,calc(100vw - 32px));aspect-ratio:16/9;background:#000;color:#f5f5f6;border-radius:14px;padding:5.6% 6.5%;display:flex;flex-direction:column;justify-content:center;overflow:hidden;position:relative;font-size:clamp(7px,1.25vw,16px)}
.slide h1{font-size:4em;line-height:1.05;letter-spacing:-.035em;margin:0 0 .35em;text-wrap:balance}
.slide h2{font-size:2.6em;line-height:1.1;letter-spacing:-.025em;margin:0 0 .6em;text-wrap:balance}
.slide h3{font-size:1.6em;margin:0 0 .5em;color:#c9c9cf}
.slide p,.slide li{font-size:1.75em;line-height:1.45;color:#d4d4d8}.slide p{margin:0 0 .6em}
.slide ul,.slide ol{margin:0;padding-left:1.2em}.slide li{margin:.25em 0}
.slide strong{color:#fff}.slide a{color:#fff}.slide code{font-family:"Geist Mono",monospace;font-size:.9em;background:#18181b;padding:.05em .3em;border-radius:.3em}
.slide table{border-collapse:collapse;font-size:1.3em;width:100%}.slide th{text-align:left;border-bottom:2px solid #fff;padding:.35em .6em .35em 0}.slide td{border-bottom:1px solid #2a2a2e;padding:.35em .6em .35em 0;color:#d4d4d8}
.slide blockquote{margin:0;font-size:2.2em;line-height:1.25;letter-spacing:-.02em;color:#fff}.slide blockquote p{font-size:inherit;line-height:inherit;color:inherit}
.slide img{max-width:100%;max-height:60%;object-fit:contain;border-radius:.6em}
.slide.title{justify-content:flex-end}.slide.title h1{font-size:5em}
.slide .num{position:absolute;right:6.5%;bottom:5%;font-size:.95em;color:#71717a;font-variant-numeric:tabular-nums}
@page{size:1280px 720px;margin:0}
@media print{body{padding:0;gap:0;background:#000}.slide{width:1280px;height:720px;border-radius:0;font-size:16px;break-after:page}}`;

export type PageKind = "doc" | "deck";

/** Builds the page (HTML), then a PDF next to it. Returns both paths (the PDF only if Chrome could print it). */
export async function createPage(title: string, markdown: string, kind: PageKind = "doc", byline = "") {
  const dir = path.join(config.workspace, "pages");
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${new Date().toISOString().slice(0, 10)}-${slug(title).slice(0, 60) || "page"}${kind === "deck" ? "-deck" : ""}`);
  let body: string;
  if (kind === "deck") {
    const slides = markdown.split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean);
    body = slides
      .map((s, n) => {
        const onlyTitle = n === 0 && /^#\s/.test(s) && s.split("\n").filter((l) => l.trim()).length <= 3;
        return `<section class="slide${onlyTitle ? " title" : ""}">${markdownToHtml(s)}<span class="num">${n + 1} / ${slides.length}</span></section>`;
      })
      .join("\n");
  } else {
    const startsWithTitle = /^#\s/.test(markdown.trim());
    const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: config.timezone });
    body = `<main><header><div class="kicker">${esc([byline, date].filter(Boolean).join(" · "))}</div>${startsWithTitle ? "" : `<h1>${esc(title)}</h1>`}</header>${markdownToHtml(markdown)}</main>`;
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${fonts()}${kind === "deck" ? DECK_CSS : DOC_CSS}</style></head><body>${body}</body></html>`;
  fs.writeFileSync(`${base}.html`, html);
  let pdf: string | undefined;
  if (fs.existsSync(CHROME)) {
    const profile = path.join(config.dataDir, "pdf-profile"); // its own, so it never fights the bots' browser
    try {
      await run(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--no-pdf-header-footer", `--print-to-pdf=${base}.pdf`, `file://${base}.html`], { timeout: 90_000 });
      if (fs.existsSync(`${base}.pdf`)) pdf = `${base}.pdf`;
    } catch (error) {
      console.error("PDF failed:", (error as Error).message.split("\n")[0]);
    }
  }
  return { html: `${base}.html`, pdf, slides: kind === "deck" ? body.split('class="slide').length - 1 : undefined };
}
