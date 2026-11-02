// @ts-check
/**
 * Run discovery and the rules over a root and produce the result both
 * reporters consume.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discover, detectCanonical, codexChains, claudeLaunchSet, linkTargets, isInstructionPath, copilotReads } from "./discover.mjs";
import { generatedBlocks, generatedBlockAt, parseFrontMatter } from "./markdown.mjs";
import { RULES } from "./rules/index.mjs";
import { CONFIG_FILENAME } from "./config.mjs";

export const VERSION = /** @type {{ version: string }} */ (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"))).version;

/**
 * @typedef {object} ReportedFinding
 * @property {string} rule
 * @property {"error" | "warn" | "info"} severity
 * @property {string} file
 * @property {number} [line]
 * @property {string} message
 * @property {string} fix
 * @property {string[]} docs
 * @property {string | null} generatedBy
 * @property {Record<string, unknown>} [data]
 */

/**
 * @typedef {object} Analysis
 * @property {import("./discover.mjs").Repo} repo
 * @property {import("./config.mjs").Config} config
 * @property {ReturnType<typeof detectCanonical>} canonical
 * @property {ReturnType<typeof codexChains>} chains
 * @property {ReturnType<typeof claudeLaunchSet>} launch
 */

/**
 * @param {string} root
 * @param {import("./config.mjs").Config} config
 * @param {{ include?: string[] }} [options]  root-relative paths given on the command line
 * @returns {Analysis}
 */
export function analyze(root, config, options = {}) {
  const repo = discover(root, config, options);
  return { repo, config, canonical: detectCanonical(repo, config), chains: codexChains(repo), launch: claudeLaunchSet(repo, config) };
}

/**
 * @param {Analysis} analysis
 * @param {{ only?: string[], skip?: string[] }} [options]
 * @returns {ReportedFinding[]}
 */
export function runRules(analysis, options = {}) {
  const only = options.only && options.only.length > 0 ? new Set(options.only) : null;
  const skip = new Set(options.skip ?? []);
  /** @type {Map<string, ReturnType<typeof generatedBlocks>>} */
  const blocks = new Map();
  /** @type {ReportedFinding[]} */
  const out = [];
  for (const rule of RULES) {
    if (only && !only.has(rule.id)) continue;
    if (skip.has(rule.id)) continue;
    const configured = analysis.config.rules[rule.id];
    if (configured === "off") continue;
    const base = configured ?? rule.severity;
    for (const f of rule.run({ repo: analysis.repo, config: analysis.config, canonical: analysis.canonical, chains: analysis.chains, launch: analysis.launch })) {
      const forced = f.data && typeof f.data.severity === "string" ? f.data.severity : null;
      // A rule may mark a finding as informational (for example the
      // no-CLAUDE.md note); configuration can only lower it further.
      const severity = /** @type {"error" | "warn" | "info"} */ (forced === "info" ? "info" : base);
      let generatedBy = null;
      if (f.line) {
        const file = analysis.repo.byPath.get(f.file);
        if (file) {
          if (!blocks.has(f.file)) blocks.set(f.file, generatedBlocks(file.text));
          generatedBy = generatedBlockAt(blocks.get(f.file) ?? [], f.line);
        }
      }
      out.push({ rule: rule.id, severity, file: f.file, ...(f.line ? { line: f.line } : {}), message: f.message, fix: f.fix ?? rule.fix, docs: rule.docs, generatedBy, ...(f.data ? { data: f.data } : {}) });
    }
  }
  const order = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line ?? 0) - (b.line ?? 0));
  return out;
}

/**
 * @param {ReportedFinding[]} findings
 * @param {{ strict?: boolean }} [options]
 */
export function summarize(findings, options = {}) {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  const info = findings.filter((f) => f.severity === "info").length;
  const exitCode = errors > 0 || (options.strict && warnings > 0) ? 1 : 0;
  return { errors, warnings, info, exitCode };
}

/**
 * Whether a `check <path...>` run has anything to do: true when any path is
 * an instruction file, a file an instruction file links to or imports, or
 * the config file in effect.
 * @param {Analysis} analysis
 * @param {string[]} paths  repo-relative POSIX paths
 * @param {string | null} configPath  repo-relative, or null
 */
export function pathsNeedCheck(analysis, paths, configPath) {
  if (paths.length === 0) return true;
  const targets = linkTargets(analysis.repo);
  const files = new Set(analysis.repo.files.map((f) => f.path));
  const configRel = configPath ?? CONFIG_FILENAME;
  return paths.some((p) => {
    const rel = p.replace(/^\.\//, "");
    if (rel === configRel) return true;
    if (files.has(rel) || isInstructionPath(rel, analysis.config)) return true;
    return targets.has(rel);
  });
}

/**
 * The `files` array shared by `check --json` and `inspect --json`.
 * `readBy` lists what loads at launch; `claude:on-demand` marks the
 * files Claude Code loads later (path-scoped rules, nested CLAUDE.md).
 * @param {Analysis} analysis
 */
export function fileReport(analysis) {
  const { repo, launch, chains } = analysis;
  // Codex reads what its chains select, Claude what the launch set loads;
  // Copilot's names come from its docs (AGENTS.md anywhere, root CLAUDE.md,
  // the .github files) and it has no override file.
  const codexReads = new Set(chains.flatMap((c) => c.entries.map((e) => e.file)));
  /** @param {string} path */
  const readBy = (path) => {
    /** @type {string[]} */
    const tools = [];
    if (codexReads.has(path)) tools.push("codex");
    const entry = launch.entries.find((e) => e.file === path);
    if (entry) tools.push(entry.via ? "claude:import" : launch.fallback && path === "AGENTS.md" ? "claude:fallback" : "claude");
    else if (/(^|\/)(CLAUDE\.md|CLAUDE\.local\.md)$/.test(path) || /\.claude\/(CLAUDE\.md|rules\/)/.test(path)) tools.push("claude:on-demand");
    if (copilotReads(path)) tools.push("copilot");
    return tools;
  };
  return repo.files.map((f) => ({ path: f.path, bytes: f.bytes, lines: f.lines, readBy: readBy(f.path) }));
}

/** @param {Analysis} analysis */
export function inspectData(analysis) {
  const { repo, canonical, chains, launch, config } = analysis;
  const pathSpecific = repo.files.filter((f) => /^\.github\/instructions\//.test(f.path)).map((f) => {
    const fm = parseFrontMatter(f.text);
    return { file: f.path, applyTo: fm && typeof fm.data.applyTo === "string" ? fm.data.applyTo : null };
  });
  return {
    version: VERSION,
    root: repo.root,
    canonical: canonical.canonical,
    canonicalReason: canonical.reason,
    files: fileReport(analysis),
    codex: {
      limit: config.limits.codexBytes,
      chains: chains.map((c) => ({
        dir: c.dir || ".",
        files: c.entries.map((e) => e.file),
        entries: c.entries.map((e) => ({ file: e.file, bytes: e.bytes, ...(e.shadows ? { shadows: e.shadows } : {}) })),
        bytes: c.bytes,
        limit: config.limits.codexBytes,
        ...(c.bytes > config.limits.codexBytes ? { truncatedAt: config.limits.codexBytes } : {}),
      })),
    },
    claude: {
      limit: config.limits.claudeLines,
      launch: launch.entries.map((e) => ({ file: e.file, lines: e.lines, ...(e.via ? { via: e.via } : {}) })),
      lines: launch.lines,
      fallback: launch.fallback,
    },
    copilot: {
      repoWide: repo.byPath.has(".github/copilot-instructions.md") ? ".github/copilot-instructions.md" : null,
      pathSpecific,
    },
  };
}
