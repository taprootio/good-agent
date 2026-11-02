// @ts-check
/**
 * Find instruction files, detect the canonical one, and model what each
 * tool loads: the Codex root-to-directory chains and the Claude launch set
 * (docs/design.md sections 2, 4.1 and the rule table).
 */
import { readdirSync, readFileSync, existsSync, statSync, lstatSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname, resolve, relative, sep, posix } from "node:path";
import { claudeImports, markdownLinks, parseFrontMatter, countLines } from "./markdown.mjs";
import { globToRegExp, defaultConfig } from "./config.mjs";

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
 * @property {"git" | "walk"} source  how candidates were enumerated
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
 * The files git lists under `absRoot`: tracked files and untracked files that
 * no ignore rule covers (`git ls-files --cached --others --exclude-standard
 * -z`), as root-relative POSIX paths. Null when git cannot answer, so the
 * caller walks the directory instead: git is missing, the root is not inside
 * a work tree, or the root is itself an ignored directory (git would list
 * nothing under it). Nested repositories, submodules and per-session
 * worktrees, are listed as one directory entry at most and never entered.
 * @param {string} absRoot
 * @returns {string[] | null}
 */
export function gitCandidates(absRoot) {
  try {
    const ignoredRoot = spawnSync("git", ["-C", absRoot, "check-ignore", "-q", "."], { stdio: "ignore" });
    if (ignoredRoot.error || ignoredRoot.status === 0) return null;
    const listing = execFileSync("git", ["-C", absRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    return [...new Set(listing.toString("utf8").split("\0").filter((p) => p !== ""))];
  } catch { return null; }
}

/**
 * Find the instruction files under `root`. Inside a git work tree the
 * candidates come from git, so ignored files are not checked; otherwise the
 * directory is walked. `node_modules` and the other installed or generated
 * directories and the config `ignore` globs apply either way. `include`
 * lists root-relative paths given on the command line: an instruction file
 * among them is checked even when git ignores it.
 * @param {string} root
 * @param {import("./config.mjs").Config} config
 * @param {{ include?: string[] }} [options]
 * @returns {Repo}
 */
export function discover(root, config, options = {}) {
  const absRoot = resolve(root);
  const ignore = config.ignore.map(globToRegExp);
  /** @param {string} rel  a directory, without a trailing slash */
  const dirIgnored = (rel) => ignore.some((re) => re.test(rel) || re.test(`${rel}/`));
  /** @param {string} rel  a file */
  const fileIgnored = (rel) => {
    const dirs = rel.split("/").slice(0, -1);
    return dirs.some((name, i) => IGNORED_DIRS.has(name) || dirIgnored(dirs.slice(0, i + 1).join("/"))) || ignore.some((re) => re.test(rel));
  };
  /** @type {InstructionFile[]} */
  const files = [];
  const seen = new Set();
  /**
   * @param {string} abs
   * @param {string} rel
   */
  const add = (abs, rel) => {
    if (seen.has(rel) || !isInstructionPath(rel, config)) return;
    const file = readInstructionFile(abs, rel);
    if (file) { seen.add(rel); files.push(file); }
  };
  /** @param {string} dir */
  const walk = (dir) => {
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(absRoot, abs));
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || dirIgnored(rel)) continue;
        walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!ignore.some((re) => re.test(rel))) add(abs, rel);
      }
    }
  };
  const candidates = gitCandidates(absRoot);
  if (candidates) {
    for (const rel of candidates) if (!fileIgnored(rel)) add(join(absRoot, ...rel.split("/")), rel);
  } else {
    walk(absRoot);
  }
  for (const rel of options.include ?? []) {
    if (rel !== "" && !rel.startsWith("../") && rel !== ".." && !fileIgnored(rel)) add(join(absRoot, ...rel.split("/")), rel);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  /** @type {Set<string>} */
  const rootDirs = new Set();
  try {
    for (const e of readdirSync(absRoot, { withFileTypes: true })) if (e.isDirectory()) rootDirs.add(e.name);
  } catch { /* unreadable root: no root dirs */ }
  return { root: absRoot, files, byPath: new Map(files.map((f) => [f.path, f])), rootDirs, source: candidates ? "git" : "walk" };
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
  // A Windows-style relative reference (.\AGENTS.md) resolves like its POSIX
  // form; a backslash before a space is the escaped-space syntax and stays.
  target = target.replace(/\\(?! )/g, "/");
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
    const abs = join(repo.root, ...config.canonical.split("/"));
    let reason = "configured";
    try {
      if (!statSync(abs).isFile()) reason = "configured but not a regular file";
      else readFileSync(abs);
    } catch { reason = existsSync(abs) ? "configured but not a regular file" : "configured but missing"; }
    return { canonical: config.canonical, inbound, reason };
  }
  const ranked = repo.files.slice().sort((a, b) => (inbound.get(b.path) ?? 0) - (inbound.get(a.path) ?? 0) || (a.path === "AGENTS.md" ? -1 : b.path === "AGENTS.md" ? 1 : 0));
  if (ranked.length > 0 && (inbound.get(ranked[0].path) ?? 0) > 0) return { canonical: ranked[0].path, inbound, reason: `${inbound.get(ranked[0].path)} inbound reference(s)` };
  if (repo.byPath.has("AGENTS.md")) return { canonical: "AGENTS.md", inbound, reason: "AGENTS.md exists" };
  const rootLevel = repo.files.filter((f) => !f.path.includes("/") || f.path === ".github/copilot-instructions.md" || f.path === ".claude/CLAUDE.md");
  if (rootLevel.length === 1) return { canonical: rootLevel[0].path, inbound, reason: "the only candidate" };
  return { canonical: null, inbound, reason: "no file is referenced by the others" };
}

/**
 * The names Copilot reads (its docs): AGENTS.md anywhere, a root CLAUDE.md
 * or GEMINI.md, and the two .github locations.
 * @param {string} path
 */
export function copilotReads(path) {
  return /(^|\/)AGENTS\.md$/.test(path) || path === "CLAUDE.md" || path === "GEMINI.md" || path === ".github/copilot-instructions.md" || /^\.github\/instructions\/.+\.instructions\.md$/.test(path);
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
export function claudeLaunchSet(repo, config = defaultConfig()) {
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
  const { entries, tooDeep } = walkClaudeImports(repo, config, starts);
  return { entries, lines: entries.reduce((n, e) => n + e.lines, 0), fallback, tooDeep };
}

/** Every file Claude Code reads as a memory entry point, at any depth. */
const CLAUDE_ENTRY = /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md)$|(^|\/)\.claude\/(CLAUDE\.md|rules\/.+\.md)$/;

/**
 * Imports that sit past the four-hop limit when Claude reads any CLAUDE.md,
 * CLAUDE.local.md or rule file, at launch or on demand (subdirectory files,
 * path-scoped rules). Each on-demand entry point is walked on its own, on top
 * of the startup set, because a session under one directory never loads a
 * sibling's CLAUDE.md. The launch set's own findings come first and win a
 * duplicate. One entry per target file.
 * @param {Repo} repo
 * @param {import("./config.mjs").Config} config
 * @returns {{ file: string, via: string, line: number }[]}
 */
export function claudeImportDepth(repo, config = defaultConfig()) {
  const launch = claudeLaunchSet(repo, config);
  const startup = new Set(launch.entries.map((e) => e.file));
  const merged = [...launch.tooDeep];
  for (const f of repo.files) {
    if (!CLAUDE_ENTRY.test(f.path) || startup.has(f.path)) continue;
    for (const d of walkClaudeImports(repo, config, [f.path], launch.entries).tooDeep) {
      if (!merged.some((m) => m.file === d.file)) merged.push(d);
    }
  }
  return merged;
}

/**
 * Walk `@` imports breadth-first from `starts` (depth 0), loading each file
 * once. Breadth-first, so a file reached by two paths is expanded at its
 * shallowest depth and the four-hop limit is applied to that depth; a target
 * first reached at hop five that no shorter path reaches is too deep.
 * `preloaded` entries join the walk at their own depths (the startup set seen
 * from an on-demand entry point).
 * @param {Repo} repo
 * @param {import("./config.mjs").Config} config
 * @param {string[]} starts
 * @param {LaunchEntry[]} [preloaded]
 * @returns {{ entries: LaunchEntry[], tooDeep: { file: string, via: string, line: number }[] }}
 */
function walkClaudeImports(repo, config, starts, preloaded = []) {
  const MAX_DEPTH = 4;
  /** @type {LaunchEntry[]} */
  const entries = [];
  /** @type {Set<string>} */
  const loaded = new Set();
  /** @typedef {{ path: string, via: string | null, depth: number, line: number }} Pending */
  /** @type {Pending[][]} */
  const levels = [];
  /** @param {Pending} item */
  const enqueue = (item) => { (levels[item.depth] ??= []).push(item); };
  for (const path of starts) enqueue({ path, via: null, depth: 0, line: 0 });
  for (const e of preloaded) enqueue({ path: e.file, via: e.via, depth: e.depth, line: 0 });
  /** @type {{ file: string, via: string, line: number }[]} */
  const deep = [];
  for (let d = 0; d < levels.length; d += 1) {
    for (const next of levels[d] ?? []) {
      if (loaded.has(next.path)) continue;
      if (next.depth > MAX_DEPTH) { deep.push({ file: next.path, via: /** @type {string} */ (next.via), line: next.line }); continue; }
      const file = repo.byPath.get(next.path) ?? readOutside(repo, next.path);
      if (!file) continue;
      loaded.add(next.path);
      entries.push({ file: next.path, lines: file.lines, via: next.via, depth: next.depth });
      for (const imp of claudeImports(file.text)) {
        const resolved = resolveReference(next.path, imp.target, "import");
        if (resolved === null || loaded.has(resolved) || isIgnoredTarget(resolved, config)) continue;
        enqueue({ path: resolved, via: next.path, depth: next.depth + 1, line: imp.line });
      }
    }
  }
  // A target that was loaded by a shorter path is not too deep after all.
  /** @type {{ file: string, via: string, line: number }[]} */
  const tooDeep = [];
  for (const d of deep) if (!loaded.has(d.file) && !tooDeep.some((t) => t.file === d.file)) tooDeep.push(d);
  return { entries, tooDeep };
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
