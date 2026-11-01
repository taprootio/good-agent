#!/usr/bin/env node
// @ts-check
/**
 * Run `check --json` against the three real repositories the design was
 * tested on and diff the result against test/corpus/<name>.expected.json.
 * A git sibling is evaluated at the commit its expected file records
 * (extracted read-only with `git archive`); the site, which is not a git
 * repository, is skipped with a note when its AGENTS.md size differs from
 * the pinned size. Paths default to sibling checkouts and can be overridden
 * with GOOD_AGENT_CORPUS_TAPROOT, GOOD_AGENT_CORPUS_TAPROOT_CONTROLS and
 * GOOD_AGENT_CORPUS_SITE. Exit 1 on a difference; a skipped repo is not a
 * failure unless --require-all is given.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const requireAll = process.argv.includes("--require-all");
const update = process.argv.includes("--update");

const CORPUS = [
  { name: "taproot", env: "GOOD_AGENT_CORPUS_TAPROOT", fallback: "../taproot" },
  { name: "taproot-controls", env: "GOOD_AGENT_CORPUS_TAPROOT_CONTROLS", fallback: "../taproot-controls" },
  { name: "site", env: "GOOD_AGENT_CORPUS_SITE", fallback: "../www.jeremeevans.com" },
];

/** @param {string} root */
function checkJson(root) {
  const r = spawnSync(process.execPath, [join(here, "good-agent.mjs"), "check", "--json", "--cwd", root], { encoding: "utf8" });
  if (!r.stdout) throw new Error(`check produced no output for ${root}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  return {
    exitCode: j.summary.exitCode,
    canonical: j.canonical,
    findings: j.findings.map((/** @type {any} */ f) => ({ rule: f.rule, severity: f.severity, file: f.file, ...(f.line ? { line: f.line } : {}) })),
  };
}

let failed = false;
let skipped = 0;
for (const entry of CORPUS) {
  const expectedPath = join(repoRoot, "test", "corpus", `${entry.name}.expected.json`);
  const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : null;
  const root = resolve(repoRoot, process.env[entry.env] ?? entry.fallback);
  if (!existsSync(root)) { console.log(`skip  ${entry.name}: ${root} not found`); skipped += 1; continue; }
  let target = root;
  let temp = null;
  if (expected?.pin?.commit) {
    temp = mkdtempSync(join(tmpdir(), `good-agent-corpus-${entry.name}-`));
    try {
      const tar = execFileSync("git", ["-C", root, "archive", "--format=tar", expected.pin.commit], { maxBuffer: 256 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", temp], { input: tar });
      target = temp;
    } catch (error) {
      console.log(`skip  ${entry.name}: cannot extract ${expected.pin.commit} from ${root} (${/** @type {Error} */ (error).message.split("\n")[0]})`);
      skipped += 1; rmSync(temp, { recursive: true, force: true }); continue;
    }
  } else if (expected?.pin?.agentsBytes) {
    const size = statSync(join(root, "AGENTS.md")).size;
    if (size !== expected.pin.agentsBytes) { console.log(`skip  ${entry.name}: AGENTS.md is ${size} bytes, pinned ${expected.pin.agentsBytes}`); skipped += 1; continue; }
  }
  const actual = checkJson(target);
  if (temp) rmSync(temp, { recursive: true, force: true });
  if (update || !expected) {
    const pin = expected?.pin ?? {};
    const out = { pin, ...actual };
    (await import("node:fs")).writeFileSync(expectedPath, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`wrote ${expectedPath}`);
    continue;
  }
  const { pin, ...want } = expected;
  const same = JSON.stringify(want) === JSON.stringify(actual);
  console.log(`${same ? "ok   " : "DIFF "} ${entry.name} (${pin.commit ?? `AGENTS.md ${pin.agentsBytes} bytes`})`);
  if (!same) { failed = true; console.log("  expected:", JSON.stringify(want)); console.log("  actual:  ", JSON.stringify(actual)); }
}
if (requireAll && skipped > 0) { console.log(`${skipped} repo(s) skipped and --require-all given`); failed = true; }
process.exitCode = failed ? 1 : 0;
