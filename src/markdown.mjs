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
  const lines = src.split("\n");
  /** @type {{ char: string, length: number, depth: number, indent: number } | null} */
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // A blockquote prefix is stripped first; a fence opened inside a quote
    // closes only on a fenced line at the same quote depth, and ends with
    // the quote. A fence opened after a list marker belongs to the item: its
    // lines must be indented to the item's content, and a non-blank line
    // that is not ends the fence (the item ended).
    const quote = line.match(/^(\s{0,3}>\s?)+/);
    const depth = quote ? (quote[0].match(/>/g) ?? []).length : 0;
    const rest = quote ? line.slice(quote[0].length) : line;
    if (fence && fence.depth > 0 && depth < fence.depth) fence = null;
    if (fence && fence.indent > 0 && rest.trim() !== "" && columnsOfIndent(rest) < fence.indent) fence = null;
    if (fence) {
      lines[i] = " ".repeat(line.length);
      const close = (fence.indent > 0 ? rest.slice(fence.indent) : rest).match(/^\s{0,3}(`{3,}|~{3,})/);
      if (close && depth === fence.depth && close[1][0] === fence.char && close[1].length >= fence.length && (fence.indent > 0 ? rest.slice(fence.indent) : rest).trim() === close[1]) fence = null;
      continue;
    }
    const marker = rest.match(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/);
    const body = marker ? rest.slice(marker[0].length) : rest;
    const open = body.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (open && !(open[1][0] === "`" && body.slice(open[0].length).includes("`"))) {
      fence = { char: open[1][0], length: open[1].length, depth, indent: marker ? marker[0].length : 0 };
      lines[i] = " ".repeat(line.length);
    }
  }
  // Inline code spans may span lines but not blocks: a run of N backticks
  // (not escaped, by backslash parity) closes with the same run inside one
  // block. A blank line ends a block; an ATX heading and a list item each
  // start one, and a heading is a block of its own. A thematic break ends a
  // block and is kept as is; a table row (it heads a delimiter row or
  // follows a table row) is a block of its own, blanked per cell.
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let block = [];
  const flush = () => { if (block.length) { out.push(blankSpans(block.join("\n"))); block = []; } };
  let inTable = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const bare = line.replace(/\r$/, "");
    const blank = bare.trim() === "";
    const heading = /^\s{0,3}#{1,6}(\s|$)/.test(bare);
    const item = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/.test(bare);
    const rule = /^\s{0,3}([*\-_])(?:\s*\1){2,}\s*$/.test(bare);
    /** @type {boolean} */
    const row = bare.includes("|") && (inTable || nextIsDelimiter(lines, i));
    inTable = row;
    if (blank) { flush(); out.push(line); continue; }
    if (rule) { flush(); out.push(line); continue; }
    if (heading) { flush(); out.push(blankSpans(line)); continue; }
    if (row) { flush(); out.push(splitCells(line).map(blankSpans).join("|")); continue; }
    if (item) flush();
    block.push(line);
  }
  flush();
  return out.join("\n");
}

/**
 * Whether the next non-blank line after `index` is a GFM table delimiter
 * row (it has a pipe, so a lone `---` is not one).
 * @param {string[]} lines
 * @param {number} index
 */
function nextIsDelimiter(lines, index) {
  // GFM puts the delimiter row on the very next line; a blockquote prefix is
  // allowed so quoted tables are detected too.
  if (index + 1 >= lines.length) return false;
  const bare = lines[index + 1].replace(/\r$/, "").replace(/^(\s{0,3}>\s?)+/, "");
  return bare.includes("|") && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(bare);
}

/**
 * Split a table row on unescaped `|`, so code spans are blanked per cell.
 * @param {string} row
 * @returns {string[]}
 */
function splitCells(row) {
  /** @type {string[]} */
  const cells = [];
  let start = 0;
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === "|" && !isEscaped(row, i)) { cells.push(row.slice(start, i)); start = i + 1; }
  }
  cells.push(row.slice(start));
  return cells;
}

/**
 * Leading indentation in columns, a tab counting as four.
 * @param {string} line
 */
function columnsOfIndent(line) {
  let n = 0;
  for (const c of line) { if (c === " ") n += 1; else if (c === "\t") n += 4; else break; }
  return n;
}

/**
 * Blank code spans inside one block, keeping newlines.
 * @param {string} block
 */
function blankSpans(block) {
  let out = "";
  let i = 0;
  while (i < block.length) {
    if (block[i] === "`" && !isEscaped(block, i) && (i === 0 || block[i - 1] !== "`")) {
      let n = 0;
      while (block[i + n] === "`") n += 1;
      const run = "`".repeat(n);
      let j = i + n;
      let close = -1;
      while (j < block.length) {
        const k = block.indexOf(run, j);
        if (k < 0) break;
        if (block[k + n] !== "`" && block[k - 1] !== "`") { close = k; break; }
        j = k + 1;
        while (block[j] === "`") j += 1;
      }
      if (close >= 0) { out += block.slice(i, close + n).replace(/[^\n]/g, " "); i = close + n; continue; }
      out += run; i += n; continue;
    }
    out += block[i]; i += 1;
  }
  return out;
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
 * `plain` holds the raw text (comments included) of each top-level value
 * written without quotes, so a caller can reject one that YAML would not
 * read as written.
 * @param {string} src
 * @returns {{ data: FrontMatter, plain: Record<string, string>, bodyStart: number, errors: string[] } | null}
 */
export function parseFrontMatter(src) {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (!src.startsWith("---\n") && !src.startsWith("---\r\n")) return null;
  const lines = src.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].replace(/\r$/, "") === "---") { end = i; break; }
  }
  if (end < 0) return { data: {}, plain: {}, bodyStart: src.length, errors: ["front matter is not closed with ---"] };
  /** @type {FrontMatter} */
  const data = Object.create(null);
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, string>} */
  const plain = Object.create(null);
  /** @type {{ key: string, line: number, value: string, raw: string } | null} */
  let pending = null;
  /** @type {string | null} */
  let nestedKey = null;
  let nestedIndent = 0;
  // A top-level value is complete once its continuation lines are folded, so
  // it is checked and stored when the next key (or the end) arrives.
  const finish = () => {
    if (!pending) return;
    if (isUnterminated(pending.value)) errors.push(`line ${pending.line}: unterminated quoted value for "${pending.key}"`);
    else {
      data[pending.key] = unquote(pending.value);
      if (!/^["']/.test(pending.value)) plain[pending.key] = pending.raw;
    }
    pending = null;
  };
  for (let i = 1; i < end; i += 1) {
    const raw = lines[i].replace(/\r$/, "");
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const top = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (indent === 0 && top) {
      const key = top[1];
      const value = stripComment(top[2]);
      if (key === "__proto__" || key === "constructor" || key === "prototype") { errors.push(`line ${i + 1}: "${key}" is not an allowed key`); continue; }
      finish();
      if (value === "") { data[key] = Object.create(null); nestedKey = key; nestedIndent = 0; }
      else { pending = { key, line: i + 1, value: value.trim(), raw: top[2].trim() }; nestedKey = null; }
      continue;
    }
    if (indent > 0 && nestedKey) {
      const nested = raw.trim().match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      const target = data[nestedKey];
      if (nested && typeof target === "object") {
        if (nestedIndent === 0) nestedIndent = indent;
        if (indent !== nestedIndent || stripComment(nested[2]) === "") { errors.push(`line ${i + 1}: nesting deeper than one level under "${nestedKey}" is not supported`); continue; }
        if (nested[1] === "__proto__" || nested[1] === "constructor" || nested[1] === "prototype") { errors.push(`line ${i + 1}: "${nested[1]}" is not an allowed key`); continue; }
        const nestedValue = stripComment(nested[2]);
        if (isUnterminated(nestedValue)) { errors.push(`line ${i + 1}: unterminated quoted value for "${nested[1]}"`); continue; }
        target[nested[1]] = unquote(nestedValue);
        continue;
      }
    }
    if (indent > 0 && pending) {
      const part = /^["']/.test(pending.value) ? raw.trim() : stripComment(raw.trim());
      if (part !== "") pending.value = `${pending.value} ${part}`.trim();
      pending.raw = `${pending.raw} ${raw.trim()}`.trim();
      continue;
    }
    errors.push(`line ${i + 1}: cannot parse "${raw.trim()}"`);
  }
  finish();
  const lineOfError = (/** @type {string} */ e) => Number(e.match(/^line (\d+):/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  errors.sort((x, y) => lineOfError(x) - lineOfError(y));
  let bodyStart = 0;
  for (let i = 0; i <= end; i += 1) bodyStart += lines[i].length + 1;
  return { data, plain, bodyStart: Math.min(bodyStart, src.length), errors };
}

/**
 * Drop a trailing YAML comment from an unquoted scalar: a `#` at the start
 * or after a space or tab. A quoted value is left for `unquote`, and a `#`
 * inside a word (`a#b`) stays.
 * @param {string} value
 */
function stripComment(value) {
  const v = value.trim();
  if (v[0] === '"' || v[0] === "'") return v;
  return v.replace(/(^|[ \t]+)#.*$/, "").trim();
}

/**
 * Index of the quote that closes a quoted value, or -1. A double-quoted
 * value closes at an unescaped `"` (a backslash skips the next character); a
 * single-quoted one at a `'` not followed by another `'` (a doubled one is a
 * literal quote).
 * @param {string} v  trimmed, starting with the quote
 */
function closingQuote(v) {
  const q = v[0];
  for (let i = 1; i < v.length; i += 1) {
    if (q === '"' && v[i] === "\\") { i += 1; continue; }
    if (v[i] !== q) continue;
    if (q === "'" && v[i + 1] === "'") { i += 1; continue; }
    return i;
  }
  return -1;
}

/**
 * Whether a value opens with a quote it never closes. Only whitespace or a
 * ` # comment` may follow the closing quote.
 * @param {string} value
 */
function isUnterminated(value) {
  const v = value.trim();
  if (v[0] !== '"' && v[0] !== "'") return false;
  const close = closingQuote(v);
  if (close < 0) return true;
  const rest = v.slice(close + 1);
  return !(rest.trim() === "" || /^\s+#/.test(rest));
}

/** @param {string} value */
function unquote(value) {
  const v = value.trim();
  if (v[0] !== '"' && v[0] !== "'") return v;
  const close = closingQuote(v);
  if (close < 0) return v;
  const inner = v.slice(1, close);
  return v[0] === "'" ? inner.replace(/''/g, "'") : inner;
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
  let from = 0;
  for (;;) {
    const at = clean.indexOf("](", from);
    if (at < 0) break;
    if (isEscaped(clean, at) || !hasOpeningBracket(clean, at)) { from = at + 2; continue; }
    let i = at + 2;
    while (clean[i] === " " || clean[i] === "\t") i += 1;
    let raw = "";
    if (clean[i] === "<") {
      const close = clean.indexOf(">", i + 1);
      if (close < 0 || clean.slice(i + 1, close).includes("\n")) { from = at + 2; continue; }
      raw = clean.slice(i + 1, close);
      i = close + 1;
    } else {
      let depth = 0;
      const start = i;
      while (i < clean.length) {
        const c = clean[i];
        if (c === "\\" && i + 1 < clean.length) { i += 2; continue; }
        if (c === "(") depth += 1;
        else if (c === ")") { if (depth === 0) break; depth -= 1; }
        else if (/\s/.test(c)) break;
        i += 1;
      }
      raw = clean.slice(start, i).replace(/\\([()\s])/g, "$1");
    }
    // optional title (quoted or parenthesized; it may wrap onto the next
    // line but not across a blank line), then the closing parenthesis
    const rest = scanTitleAndClose(clean, i);
    from = at + 2;
    if (!rest || raw === "") continue;
    if (/^(https?:|mailto:|#)/i.test(raw)) continue;
    const target = decodeTarget(raw.replace(/#.*$/, ""));
    if (!target) continue;
    out.push({ target, line: lineOf(clean, at), raw });
  }
  return out;
}

/**
 * Linear scan of an optional link title and the closing parenthesis from
 * `start`. Returns true when a well-formed ending follows. No regex, so an
 * unterminated title cannot backtrack.
 * @param {string} text
 * @param {number} start
 */
function scanTitleAndClose(text, start) {
  let i = start;
  const skipSpaces = () => { while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1; };
  skipSpaces();
  const open = text[i];
  if (open === '"' || open === "'" || open === "(") {
    const close = open === "(" ? ")" : open;
    i += 1;
    let prevNewline = false;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (c === "\\" && i + 1 < text.length) { i += 1; prevNewline = false; continue; }
      if (c === close) break;
      if (c === "\n") {
        if (prevNewline) return false; // a blank line ends the link
        prevNewline = true;
        continue;
      }
      if (c !== " " && c !== "\t" && c !== "\r") prevNewline = false;
    }
    if (i >= text.length) return false;
    i += 1;
    skipSpaces();
  }
  return text[i] === ")";
}

/**
 * Percent-decode a local link destination; a malformed escape is kept as
 * written.
 * @param {string} target
 */
function decodeTarget(target) {
  if (!target.includes("%")) return target;
  try { return decodeURIComponent(target); } catch { return target; }
}

/**
 * Whether the `]` at `index` closes a link label: an unescaped `[` with
 * balanced nesting earlier in the same paragraph.
 * @param {string} text
 * @param {number} index  position of "]("
 */
function hasOpeningBracket(text, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === "\n" && isBlankBefore(text, i)) return false;
    if (isEscaped(text, i)) continue;
    if (c === "]") depth += 1;
    else if (c === "[") { if (depth === 0) return true; depth -= 1; }
  }
  return false;
}

/**
 * Whether the line break at `index` follows a blank line: nothing but
 * spaces, tabs and carriage returns since the previous line break.
 * @param {string} text
 * @param {number} index
 */
function isBlankBefore(text, index) {
  let j = index - 1;
  while (j >= 0 && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j -= 1;
  return j >= 0 && text[j] === "\n";
}

/**
 * Whether the character at `index` is escaped: preceded by an odd number of
 * backslashes.
 * @param {string} text
 * @param {number} index
 */
function isEscaped(text, index) {
  let n = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) n += 1;
  return n % 2 === 1;
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
