// @ts-check
/**
 * The good-agent command line. `main` never runs on import: the bin and the
 * alias bin both call it and set `process.exitCode` from what it resolves to.
 */
import { parseArgs } from "node:util";
import { resolve, relative } from "node:path";
import { statSync } from "node:fs";
import { ConfigError, loadConfig } from "./config.mjs";
import { RULES, RULE_IDS, ruleById } from "./rules/index.mjs";
import { analyze, runRules, summarize, pathsNeedCheck, inspectData, VERSION } from "./engine.mjs";
import { formatHuman, formatJson, formatInspect } from "./report.mjs";
import { toPosix } from "./discover.mjs";

export const EXIT = { ok: 0, findings: 1, usage: 2, internal: 3 };

const HELP = `good-agent ${VERSION} — keep AI tool instruction files DRY and inside what each tool loads

Usage:
  good-agent check [options] [path...]
  good-agent inspect [--json] [--cwd <dir>] [--config <file>]
  good-agent explain <rule>
  good-agent rules
  good-agent init --skill [--force]

check options:
  --json              machine-readable output (includes info findings)
  --verbose           show info findings in human output
  --strict            warnings also fail (exit 1)
  --quiet             summary line only
  --rule <id>         run only this rule (repeatable)
  --no-rule <id>      skip this rule (repeatable)
  --config <file>     config file (default: good-agent.config.json in the root)
  --cwd <dir>         the repository root to check (default: current directory)
  --no-color          plain output

With paths, check runs only when one of them is an instruction file, a file an
instruction file links to or imports, or the config file; otherwise it prints
"nothing to check" and exits 0. good-agent checks the directory it runs in (or
--cwd) and never walks up to the git top level: Codex loads AGENTS.md files
from the repository root down to its working directory, and a link starting
with / resolves from the root, so run from the repository root to validate the
whole Codex chain and root-relative links.

Exit codes: 0 pass, 1 findings, 2 usage or config error, 3 internal error.
`;

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const out = /** @param {string} s */ (s) => process.stdout.write(`${s}\n`);
  const err = /** @param {string} s */ (s) => process.stderr.write(`${s}\n`);
  const [command, ...rest] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") { out(HELP.trimEnd()); return EXIT.ok; }
    if (command === "--version" || command === "-V" || command === "version") { out(VERSION); return EXIT.ok; }
    switch (command) {
      case "check": return runCheck(rest, out, err);
      case "inspect": return runInspect(rest, out);
      case "explain": return runExplain(rest, out, err);
      case "rules": return runRulesList(rest, out);
      case "init": return (await import("./init.mjs")).runInit(rest, out, err);
      case "review": return (await import("./review.mjs")).runReview(rest, out, err);
      default:
        err(`good-agent: unknown command "${command}"\n`);
        out(HELP.trimEnd());
        return EXIT.usage;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UsageError) { err(`good-agent: ${error.message}`); return EXIT.usage; }
    if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) { err(`good-agent: ${error.message}`); return EXIT.usage; }
    err(`good-agent: internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return EXIT.internal;
  }
}

export class UsageError extends Error {}

/**
 * The repository root: --cwd or the current directory, which must exist and
 * be a directory (exit 2 otherwise).
 * @param {string | undefined} cwd
 */
function rootDir(cwd) {
  const root = resolve(cwd ?? process.cwd());
  try { if (statSync(root).isDirectory()) return root; } catch { /* missing */ }
  throw new UsageError(`${root} is not a directory`);
}

/**
 * @param {string[]} args
 * @param {(s: string) => void} out
 * @param {(s: string) => void} err
 */
function runCheck(args, out, err) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      rule: { type: "string", multiple: true, default: [] },
      "no-rule": { type: "string", multiple: true, default: [] },
      config: { type: "string" },
      cwd: { type: "string" },
      "no-color": { type: "boolean", default: false },
    },
  });
  const root = rootDir(values.cwd);
  const { config, path: configPath } = loadConfig(root, { explicitPath: values.config, knownRuleIds: RULE_IDS });
  for (const id of [...values.rule, ...values["no-rule"]]) if (!ruleById(id)) throw new UsageError(`unknown rule id "${id}" (run \`good-agent rules\`)`);
  const analysis = analyze(root, config);
  const relConfig = configPath ? toPosix(relative(root, configPath)) : null;
  const paths = positionals.map((p) => toPosix(relative(root, resolve(root, p))));
  if (positionals.length > 0 && !pathsNeedCheck(analysis, paths, relConfig)) {
    if (values.json) out(JSON.stringify({ version: VERSION, root, nothingToCheck: true, paths, summary: { errors: 0, warnings: 0, info: 0, exitCode: 0 } }, null, 2));
    else out(`good-agent ${VERSION} · nothing to check (${positionals.length} path${positionals.length === 1 ? "" : "s"} given, none is an instruction file, a link target, or the config)`);
    return EXIT.ok;
  }
  const findings = runRules(analysis, { only: values.rule, skip: values["no-rule"] });
  const summary = summarize(findings, { strict: values.strict });
  out(values.json ? formatJson(analysis, findings, { strict: values.strict, configPath: relConfig }) : formatHuman(analysis, findings, { verbose: values.verbose, quiet: values.quiet, strict: values.strict }));
  void err;
  return summary.exitCode;
}

/**
 * @param {string[]} args
 * @param {(s: string) => void} out
 */
function runInspect(args, out) {
  const { values } = parseArgs({ args, allowPositionals: false, options: { json: { type: "boolean", default: false }, config: { type: "string" }, cwd: { type: "string" } } });
  const root = rootDir(values.cwd);
  const { config } = loadConfig(root, { explicitPath: values.config, knownRuleIds: RULE_IDS });
  const data = inspectData(analyze(root, config));
  out(values.json ? JSON.stringify(data, null, 2) : formatInspect(data));
  return EXIT.ok;
}

/**
 * @param {string[]} args
 * @param {(s: string) => void} out
 * @param {(s: string) => void} err
 */
function runExplain(args, out, err) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length !== 1) throw new UsageError("explain takes exactly one rule id (run `good-agent rules`)");
  const id = positionals[0];
  const rule = ruleById(id);
  if (!rule) { err(`good-agent: unknown rule id "${id}"`); out(`Known rules: ${RULE_IDS.join(", ")}`); return EXIT.usage; }
  out(explainText(rule));
  return EXIT.ok;
}

/** @param {import("./rules/types.mjs").Rule} rule */
export function explainText(rule) {
  return [
    `${rule.id}  (default: ${rule.severity}, since ${rule.since})`,
    "",
    "Why it matters",
    `  ${rule.rationale}`,
    "",
    "How to fix it",
    ...rule.fix.split("\n").map((l) => `  ${l}`),
    "",
    "Sources",
    ...rule.docs.map((d) => `  ${d}`),
  ].join("\n");
}

/**
 * @param {string[]} args
 * @param {(s: string) => void} out
 */
function runRulesList(args, out) {
  const { values } = parseArgs({ args, allowPositionals: false, options: { json: { type: "boolean", default: false }, config: { type: "string" }, cwd: { type: "string" } } });
  const root = rootDir(values.cwd);
  const { config } = loadConfig(root, { explicitPath: values.config, knownRuleIds: RULE_IDS });
  const rows = RULES.map((r) => ({ id: r.id, default: r.severity, configured: config.rules[r.id] ?? r.severity, enabled: config.rules[r.id] !== "off", since: r.since, docs: r.docs }));
  if (values.json) { out(JSON.stringify(rows, null, 2)); return EXIT.ok; }
  const width = Math.max(...RULE_IDS.map((id) => id.length));
  for (const r of rows) out(`${r.id.padEnd(width)}  ${(r.enabled ? r.configured : "off").padEnd(5)}  (default ${r.default})  since ${r.since}  ${r.docs[0]}`);
  return EXIT.ok;
}
