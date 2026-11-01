// @ts-check
/**
 * The Markdown subset good-agent reads: code blanking, inline links, Claude
 * `@path` imports, the flat front-matter subset Copilot and the Agent Skills
 * spec use, and generated-block markers. No dependency, by design
 * (docs/design.md section 9).
 */

/**
 * Blank fenced blocks and inline code spans so links, imports and references
 * inside them are not parsed, matching how Claude Code skips code when it
 * looks for imports. Newlines are kept so line numbers stay right.
 * @param {string} src
 * @returns {string}
 */
export function stripCode(src) {
  return src
    .replace(/```[\s\S]*?(```|$)/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

/**
 * 1-based line of a character index.
 * @param {string} src
 * @param {number} index
 */
export function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** @param {string} src */
export function countLines(src) {
  if (src.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < src.length; i += 1) if (src.charCodeAt(i) === 10) n += 1;
  if (src.endsWith("\n")) n -= 1;
  return n;
}

/**
 * @typedef {Record<string, string | Record<string, string>>} FrontMatter
 */

/**
 * Parse front matter when `---` is the file's first line. Supports
 * `key: value`, indented continuation lines folded into the previous value
 * with single spaces, and one level of nested map (`metadata:` followed by
 * indented `k: v` lines). Anything deeper is reported as an error so the
 * caller can reject it. Returns null when the file has no front matter.
 * @param {string} src
 * @returns {{ data: FrontMatter, bodyStart: number, errors: string[] } | null}
 */
export function parseFrontMatter(src) {
  if (!src.startsWith("---\n") && !src.startsWith("---\r\n")) return null;
  const lines = src.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].replace(/\r$/, "") === "---") { end = i; break; }
  }
  if (end < 0) return { data: {}, bodyStart: src.length, errors: ["front matter is not closed with ---"] };
  /** @type {FrontMatter} */
  const data = {};
  /** @type {string[]} */
  const errors = [];
  /** @type {string | null} */
  let lastKey = null;
  /** @type {string | null} */
  let nestedKey = null;
  for (let i = 1; i < end; i += 1) {
    const raw = lines[i].replace(/\r$/, "");
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const top = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (indent === 0 && top) {
      const [, key, value] = top;
      if (value === "") { data[key] = {}; nestedKey = key; lastKey = null; }
      else { data[key] = unquote(value); lastKey = key; nestedKey = null; }
      continue;
    }
    if (indent > 0 && nestedKey) {
      const nested = raw.trim().match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      const target = data[nestedKey];
      if (nested && typeof target === "object") {
        if (nested[2] === "") errors.push(`line ${i + 1}: nesting deeper than one level under "${nestedKey}" is not supported`);
        else target[nested[1]] = unquote(nested[2]);
        continue;
      }
    }
    if (indent > 0 && lastKey && typeof data[lastKey] === "string") {
      data[lastKey] = `${data[lastKey]} ${raw.trim()}`.trim();
      continue;
    }
    errors.push(`line ${i + 1}: cannot parse "${raw.trim()}"`);
  }
  let bodyStart = 0;
  for (let i = 0; i <= end; i += 1) bodyStart += lines[i].length + 1;
  return { data, bodyStart: Math.min(bodyStart, src.length), errors };
}

/** @param {string} value */
function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/**
 * @typedef {{ target: string, line: number, raw: string }} Reference
 */

/**
 * Inline Markdown links `[text](target "title")` outside code. Web links,
 * mail links and pure anchors are skipped; a fragment is stripped.
 * @param {string} src
 * @returns {Reference[]}
 */
export function markdownLinks(src) {
  const clean = stripCode(src);
  /** @type {Reference[]} */
  const out = [];
  const re = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m;
  while ((m = re.exec(clean))) {
    const raw = m[1];
    if (/^(https?:|mailto:|#)/i.test(raw)) continue;
    const target = raw.replace(/#.*$/, "");
    if (!target) continue;
    out.push({ target, line: lineOf(clean, m.index), raw });
  }
  return out;
}

/**
 * Claude Code `@path` imports outside code: `@` at the start of a line or
 * after whitespace, followed by a path. A path in quotes is not an import
 * (the docs say so); emails and handles are not imports because they
 * contain no `/`, `.` or `~` in the right places.
 * @param {string} src
 * @returns {Reference[]}
 */
export function claudeImports(src) {
  const clean = stripCode(src);
  /** @type {Reference[]} */
  const out = [];
  const re = /(^|[\s(])@((?:\\ |[^\s)\]`'"<>])+)/g;
  let m;
  while ((m = re.exec(clean))) {
    const raw = m[2];
    const target = raw.replace(/\\ /g, " ").replace(/[.,;:]+$/, "");
    if (!target) continue;
    // `user@host.com` style: the text before @ is not whitespace, so the regex
    // already excludes it; a bare handle like @jereme has no path character.
    if (!/[./~]/.test(target)) continue;
    if (/^[\w.-]+@/.test(target)) continue;
    out.push({ target, line: lineOf(clean, m.index + m[1].length), raw });
  }
  return out;
}

/**
 * @typedef {{ name: string, startLine: number, endLine: number }} GeneratedBlock
 */

/**
 * `<!-- BEGIN NAME -->` ... `<!-- END NAME -->` ranges. A block that is never
 * closed runs to the end of the file.
 * @param {string} src
 * @returns {GeneratedBlock[]}
 */
export function generatedBlocks(src) {
  /** @type {GeneratedBlock[]} */
  const out = [];
  const re = /<!--\s*BEGIN\s+([A-Za-z0-9_:.-]+)\s*-->/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const endRe = new RegExp(`<!--\\s*END\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*-->`, "g");
    endRe.lastIndex = m.index + m[0].length;
    const e = endRe.exec(src);
    out.push({ name, startLine: lineOf(src, m.index), endLine: e ? lineOf(src, e.index) : countLines(src) });
  }
  return out;
}

/** The one generated-looking block that is hand-written in v0.1 (design 12). */
export const HAND_WRITTEN_BLOCKS = new Set(["GOOD-AGENT"]);

/**
 * The generated block a line falls in, or null. Hand-written blocks do not
 * count.
 * @param {GeneratedBlock[]} blocks
 * @param {number} line
 */
export function generatedBlockAt(blocks, line) {
  for (const b of blocks) {
    if (HAND_WRITTEN_BLOCKS.has(b.name)) continue;
    if (line >= b.startLine && line <= b.endLine) return b.name;
  }
  return null;
}

/**
 * Lines of `src` with generated blocks (except hand-written ones) blanked,
 * for the dry/* rules.
 * @param {string} src
 */
export function withoutGeneratedBlocks(src) {
  const blocks = generatedBlocks(src).filter((b) => !HAND_WRITTEN_BLOCKS.has(b.name));
  if (blocks.length === 0) return src;
  return src.split("\n").map((l, i) => (blocks.some((b) => i + 1 >= b.startLine && i + 1 <= b.endLine) ? "" : l)).join("\n");
}
