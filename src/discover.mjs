// @ts-check
/**
 * Find instruction files, detect the canonical one, and model what each
 * tool loads: the Codex root-to-directory chains and the Claude launch set
 * (docs/design.md sections 2, 4.1 and the rule table).
 */
import { readdirSync, readFileSync, existsSync, statSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname, resolve, relative, sep, posix } from "node:path";
import { claudeImports, markdownLinks, parseFrontMatter, countLines } from "./markdown.mjs";
import { globToRegExp } from "./config.mjs";

/** Directories never walked: installed or generated content. */
export const IGNORED_DIRS = new Set(["node_modules", ".git", "coverage", "dist", "build", "public", ".next", "out"]);

/** Names recognised at any depth. */
const ANY_DEPTH = /(^|\/)(AGENTS\.md|AGENTS\.override\.md|CLAUDE\.md|CLAUDE\.local\.md)$/;
const CLAUDE_DIR = /(^|\/)\.claude\/(CLAUDE\.md|rules\/.+\.md)$/;
/** Names recognised at the root only. */
const ROOT_ONLY = /^(\.github\/copilot-instructions\.md|\.github\/instructions\/.+\.instructions\.md|AI_GUIDELINES\.md)$/;

/**
 * @typedef {object} InstructionFile
 * @property {string} path  repo-relative POSIX path
 * @property {string} text
 * @property {Buffer} raw  the bytes on disk
 * @property {number} bytes  on disk, not of the decoded text
 * @property {number} lines
 * @property {string} realPath  absolute, symlinks resolved
 * @property {boolean} symlink
 */

/**
 * @typedef {object} Repo
 * @property {string} root  absolute
 * @property {InstructionFile[]} files
 * @property {Map<string, InstructionFile>} byPath
 * @property {Set<string>} rootDirs
 */

/**
 * @param {string} rel
 * @param {import("./config.mjs").Config} config
 */
export function isInstructionPath(rel, config) {
  if (ANY_DEPTH.test(rel) || CLAUDE_DIR.test(rel) || ROOT_ONLY.test(rel)) return true;
  if (config.canonical && rel === config.canonical) return true;
  return config.extraFiles.some((g) => globToRegExp(g).test(rel));
}

/** @param {string} p */
export function toPosix(p) {
  return p.split(sep).join("/");
}

/**
 * @param {string} root
 * @param {import("./config.mjs").Config} config
 * @returns {Repo}
 */
export function discover(root, config) {
  const absRoot = resolve(root);
  const ignore = config.ignore.map(globToRegExp);
  /** @type {InstructionFile[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(absRoot, abs));
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (ignore.some((re) => re.test(rel) || re.test(`${rel}/`))) continue;
        walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (ignore.some((re) => re.test(rel))) continue;
        if (!isInstructionPath(rel, config)) continue;
        const file = readInstructionFile(abs, rel);
        if (file) files.push(file);
      }
    }
  };
  walk(absRoot);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  /** @type {Set<string>} */
  const rootDirs = new Set();
  try {
    for (const e of readdirSync(absRoot, { withFileTypes: true })) if (e.isDirectory()) rootDirs.add(e.name);
  } catch { /* unreadable root: no root dirs */ }
  return { root: absRoot, files, byPath: new Map(files.map((f) => [f.path, f])), rootDirs };
}

/**
 * @param {string} abs
 * @param {string} rel
 * @returns {InstructionFile | null}
 */
function readInstructionFile(abs, rel) {
  try {
    const symlink = lstatSync(abs).isSymbolicLink();
    if (!statSync(abs).isFile()) return null;
    const buf = readFileSync(abs);
    const text = buf.toString("utf8");
    return { path: rel, text, raw: buf, bytes: buf.length, lines: countLines(text), realPath: realpathSync(abs), symlink };
  } catch { return null; }
}

/**
 * Resolve a reference from `fromPath` to a repo-relative path, or null when
 * it points outside the repo or is an absolute import (Claude treats a
 * leading `/` in an `@` import as a filesystem path). A Markdown link with a
 * leading `/` is repo-root relative.
 * @param {string} fromPath
 * @param {string} target
 * @param {"link" | "import"} kind
 * @returns {string | null}
 */
export function resolveReference(fromPath, target, kind) {
  if (target.startsWith("~")) return null;
  // Windows drive (C:/, C:\) and UNC (//server, \\server) paths are absolute too.
  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\") || target.startsWith("//")) return null;
  if (target.startsWith("/")) return kind === "link" ? posix.normalize(target.slice(1)) : null;
  const resolved = posix.normalize(posix.join(posix.dirname(fromPath), target));
  if (resolved.startsWith("../") || resolved === "..") return null;
  return resolved === "." ? "" : resolved;
}

/**
 * Whether a resolved reference points into a directory the guard does not
 * model: an installed or generated directory, or a configured ignore glob.
 * Such targets are not checked for existence (design 3, noise controls).
 * @param {string} rel
 * @param {import("./config.mjs").Config} config
 */
export function isIgnoredTarget(rel, config) {
  const parts = rel.split("/");
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  const globs = config.ignore.map(globToRegExp);
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/");
    if (globs.some((re) => re.test(prefix) || re.test(`${prefix}/`))) return true;
  }
  return false;
}

/**
 * @param {Repo} repo
 * @param {string} rel
 */
export function existsInRepo(repo, rel) {
  if (rel === "") return true;
  try { return existsSync(join(repo.root, ...rel.split("/"))); } catch { return false; }
}

/**
 * All references (links and imports) from one file, resolved.
 * @param {InstructionFile} file
 */
export function referencesOf(file) {
  const out = [];
  for (const l of markdownLinks(file.text)) out.push({ kind: /** @type {const} */ ("link"), target: l.target, line: l.line, resolved: resolveReference(file.path, l.target, "link") });
  for (const i of claudeImports(file.text)) out.push({ kind: /** @type {const} */ ("import"), target: i.target, line: i.line, resolved: resolveReference(file.path, i.target, "import") });
  return out;
}

/**
 * The canonical file: the instruction file the others point at (design 2).
 * @param {Repo} repo
 * @param {import("./config.mjs").Config} config
 * @returns {{ canonical: string | null, inbound: Map<string, number>, reason: string }}
 */
export function detectCanonical(repo, config) {
  /** @type {Map<string, number>} */
  const inbound = new Map(repo.files.map((f) => [f.path, 0]));
  for (const f of repo.files) {
    const seen = new Set();
    for (const r of referencesOf(f)) {
      if (r.resolved === null || r.resolved === f.path || !inbound.has(r.resolved) || seen.has(r.resolved)) continue;
      seen.add(r.resolved);
      inbound.set(r.resolved, (inbound.get(r.resolved) ?? 0) + 1);
    }
  }
  if (config.canonical) {
    return { canonical: config.canonical, inbound, reason: existsInRepo(repo, config.canonical) ? "configured" : "configured but missing" };
  }
  const ranked = repo.files.slice().sort((a, b) => (inbound.get(b.path) ?? 0) - (inbound.get(a.path) ?? 0) || (a.path === "AGENTS.md" ? -1 : b.path === "AGENTS.md" ? 1 : 0));
  if (ranked.length > 0 && (inbound.get(ranked[0].path) ?? 0) > 0) return { canonical: ranked[0].path, inbound, reason: `${inbound.get(ranked[0].path)} inbound reference(s)` };
  if (repo.byPath.has("AGENTS.md")) return { canonical: "AGENTS.md", inbound, reason: "AGENTS.md exists" };
  const rootLevel = repo.files.filter((f) => !f.path.includes("/") || f.path === ".github/copilot-instructions.md" || f.path === ".claude/CLAUDE.md");
  if (rootLevel.length === 1) return { canonical: rootLevel[0].path, inbound, reason: "the only candidate" };
  return { canonical: null, inbound, reason: "no file is referenced by the others" };
}

/**
 * @typedef {object} ChainEntry
 * @property {string} dir  "" for the root
 * @property {string} file  the selected file for this directory
 * @property {number} bytes
 * @property {string | null} shadows  an AGENTS.md ignored because an override exists
 */

/**
 * @typedef {object} CodexChain
 * @property {string} dir
 * @property {ChainEntry[]} entries
 * @property {number} bytes
 */

/**
 * For every directory holding an AGENTS.md or AGENTS.override.md, the chain
 * Codex builds from the root down to it: per directory, the first file that
 * exists in the order override, AGENTS.md (the loader probes metadata only);
 * an empty file contributes zero bytes and still wins its directory.
 * @param {Repo} repo
 * @returns {CodexChain[]}
 */
export function codexChains(repo) {
  const dirs = new Set();
  for (const f of repo.files) {
    if (/(^|\/)AGENTS(\.override)?\.md$/.test(f.path)) dirs.add(f.path.includes("/") ? posix.dirname(f.path) : "");
  }
  /** @type {CodexChain[]} */
  const chains = [];
  for (const dir of [...dirs].sort()) {
    const parts = dir ? dir.split("/") : [];
    /** @type {ChainEntry[]} */
    const entries = [];
    for (let i = 0; i <= parts.length; i += 1) {
      const d = parts.slice(0, i).join("/");
      const override = d ? `${d}/AGENTS.override.md` : "AGENTS.override.md";
      const agents = d ? `${d}/AGENTS.md` : "AGENTS.md";
      const o = repo.byPath.get(override);
      const a = repo.byPath.get(agents);
      if (o) entries.push({ dir: d, file: o.path, bytes: o.text.trim() === "" ? 0 : o.bytes, shadows: a ? a.path : null });
      else if (a) entries.push({ dir: d, file: a.path, bytes: a.text.trim() === "" ? 0 : a.bytes, shadows: null });
    }
    chains.push({ dir, entries, bytes: entries.reduce((n, e) => n + e.bytes, 0) });
  }
  return chains;
}

/**
 * @typedef {object} LaunchEntry
 * @property {string} file
 * @property {number} lines
 * @property {string | null} via  the importing file, or null when loaded directly
 * @property {number} depth
 */

/**
 * What Claude Code loads at launch from this root: CLAUDE.md or
 * .claude/CLAUDE.md, CLAUDE.local.md, .claude/rules/*.md without `paths`,
 * and their @imports to four hops, each file once; with no CLAUDE.md at all,
 * AGENTS.md (the documented fallback).
 * @param {Repo} repo
 * @returns {{ entries: LaunchEntry[], lines: number, fallback: boolean, tooDeep: { file: string, via: string, line: number }[] }}
 */
export function claudeLaunchSet(repo) {
  const MAX_DEPTH = 4;
  /** @type {LaunchEntry[]} */
  const entries = [];
  /** @type {{ file: string, via: string, line: number }[]} */
  const tooDeep = [];
  /** @type {Map<string, InstructionFile>} */
  const loaded = new Map();
  /** @type {{ path: string, via: string | null, depth: number, line: number }[]} */
  const queue = [];
  /** @type {{ file: string, via: string, line: number }[]} */
  const deep = [];
  // Breadth-first, so a file reached by two paths is expanded at its
  // shallowest depth and the four-hop limit is applied to that depth.
  const drain = () => {
    while (queue.length > 0) {
      const next = /** @type {{ path: string, via: string | null, depth: number, line: number }} */ (queue.shift());
      if (loaded.has(next.path)) continue;
      if (next.depth > MAX_DEPTH) { deep.push({ file: next.path, via: /** @type {string} */ (next.via), line: next.line }); continue; }
      const file = repo.byPath.get(next.path) ?? readOutside(repo, next.path);
      if (!file) continue;
      loaded.set(next.path, file);
      entries.push({ file: next.path, lines: file.lines, via: next.via, depth: next.depth });
      for (const imp of claudeImports(file.text)) {
        const resolved = resolveReference(next.path, imp.target, "import");
        if (resolved === null || loaded.has(resolved)) continue;
        queue.push({ path: resolved, via: next.path, depth: next.depth + 1, line: imp.line });
      }
    }
  };
  const starts = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"].filter((p) => repo.byPath.has(p));
  for (const f of repo.files) {
    if (!f.path.startsWith(".claude/rules/")) continue;
    const fm = parseFrontMatter(f.text);
    if (fm && fm.data.paths !== undefined) continue;
    starts.push(f.path);
  }
  let fallback = false;
  if (!starts.some((p) => p === "CLAUDE.md" || p === ".claude/CLAUDE.md" || p === "CLAUDE.local.md") && repo.byPath.has("AGENTS.md")) {
    fallback = true;
    starts.push("AGENTS.md");
  }
  for (const s of starts) queue.push({ path: s, via: null, depth: 0, line: 0 });
  drain();
  // A target that was loaded by a shorter path is not too deep after all.
  for (const d of deep) if (!loaded.has(d.file) && !tooDeep.some((t) => t.file === d.file)) tooDeep.push(d);
  return { entries, lines: entries.reduce((n, e) => n + e.lines, 0), fallback, tooDeep };
}

/**
 * An imported file that is not itself an instruction file (a docs page
 * imported with @) still loads at launch, so read it for the line count.
 * @param {Repo} repo
 * @param {string} rel
 * @returns {InstructionFile | null}
 */
function readOutside(repo, rel) {
  return readInstructionFile(join(repo.root, ...rel.split("/")), rel);
}

/**
 * Every repo path an instruction file links to or imports (for the path
 * filter in `check <path...>`).
 * @param {Repo} repo
 */
export function linkTargets(repo) {
  const out = new Set();
  for (const f of repo.files) for (const r of referencesOf(f)) if (r.resolved !== null && r.resolved !== "") out.add(r.resolved);
  return out;
}

/** @param {string} p */
export function dirOf(p) { return dirname(p); }
