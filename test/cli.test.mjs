// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { run, FIXTURES, tempTree } from "./helpers.mjs";
import { RULE_IDS } from "../src/rules/index.mjs";

const PASS = join(FIXTURES, "canonical-detect", "pass");
const FAIL = join(FIXTURES, "codex-size-budget", "fail");

test("exit 0 on a clean repo, 1 on findings, 2 on usage and config errors", () => {
  assert.equal(run(["check", "--cwd", PASS]).status, 0);
  assert.equal(run(["check", "--cwd", FAIL]).status, 1);
  assert.equal(run(["check", "--bogus"]).status, 2);
  assert.equal(run(["nope"]).status, 2);
  assert.equal(run(["check", "--rule", "no/such", "--cwd", PASS]).status, 2);
  assert.equal(run(["check", "--config", "missing.json", "--cwd", PASS]).status, 2);
  const bad = tempTree({ "AGENTS.md": "# a\n", "good-agent.config.json": "{ not json" });
  try { const r = run(["check", "--cwd", bad.root]); assert.equal(r.status, 2); assert.match(r.stderr, /not valid JSON/); } finally { bad.cleanup(); }
});

test("--json shape", () => {
  const r = run(["check", "--json", "--cwd", FAIL]);
  const j = JSON.parse(r.stdout);
  assert.ok(typeof j.version === "string");
  assert.equal(j.canonical, "AGENTS.md");
  assert.ok(Array.isArray(j.files) && j.files[0].path && typeof j.files[0].bytes === "number");
  const f = j.findings[0];
  for (const k of ["rule", "severity", "file", "message", "fix", "docs"]) assert.ok(k in f, k);
  assert.ok(Array.isArray(f.docs) && f.docs.length >= 1);
  assert.deepEqual(Object.keys(j.summary), ["errors", "warnings", "info", "exitCode"]);
});

test("--strict fails on warnings; --rule and --no-rule select rules; info hidden unless --verbose", () => {
  const warnOnly = join(FIXTURES, "canonical-name", "fail");
  assert.equal(run(["check", "--cwd", warnOnly]).status, 0);
  assert.equal(run(["check", "--strict", "--cwd", warnOnly]).status, 1);
  assert.equal(run(["check", "--cwd", warnOnly, "--no-rule", "canonical/name", "--strict"]).status, 0);
  const only = JSON.parse(run(["check", "--json", "--cwd", FAIL, "--rule", "claude/size"]).stdout);
  assert.ok(only.findings.every((/** @type {any} */ f) => f.rule === "claude/size"));
  const info = join(FIXTURES, "claude-import-canonical", "no-claude-agents");
  assert.ok(!run(["check", "--cwd", info]).stdout.includes("claude/import-canonical"));
  assert.ok(run(["check", "--verbose", "--cwd", info]).stdout.includes("claude/import-canonical"));
});

test("path filter: fast exit, instruction file, link target, config file", () => {
  const t = tempTree({ "AGENTS.md": "# a\n\nSee [guide](docs/guide.md).\n", "CLAUDE.md": "@AGENTS.md\n", "docs/guide.md": "g\n", "src/app.js": "x\n", "good-agent.config.json": "{}\n" });
  try {
    const none = run(["check", "src/app.js"], { cwd: t.root });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /nothing to check/);
    assert.equal(JSON.parse(run(["check", "--json", "src/app.js"], { cwd: t.root }).stdout).nothingToCheck, true);
    for (const p of ["AGENTS.md", "docs/guide.md", "good-agent.config.json", "CLAUDE.md"]) {
      assert.doesNotMatch(run(["check", p], { cwd: t.root }).stdout, /nothing to check/, p);
    }
    assert.doesNotMatch(run(["check", "src/app.js", "AGENTS.md"], { cwd: t.root }).stdout, /nothing to check/);
  } finally { t.cleanup(); }
  const cfg = run(["check", "good-agent.config.json"], { cwd: join(FIXTURES, "path-filter", "config-only") });
  assert.equal(cfg.status, 1);
});

test("inspect, explain and rules", () => {
  const ins = run(["inspect", "--cwd", FAIL]);
  assert.equal(ins.status, 0);
  assert.match(ins.stdout, /Codex .*limit/);
  const j = JSON.parse(run(["inspect", "--json", "--cwd", join(FIXTURES, "codex-size-budget", "empty-override")]).stdout);
  assert.equal(j.codex.chains[0].entries[0].file, "AGENTS.override.md");
  assert.equal(j.codex.chains[0].entries[0].bytes, 0);
  assert.equal(j.codex.chains[0].entries[0].shadows, "AGENTS.md");
  assert.ok(Array.isArray(j.claude.launch) && typeof j.claude.lines === "number");
  assert.ok("repoWide" in j.copilot && Array.isArray(j.copilot.pathSpecific));
  for (const id of RULE_IDS) {
    const e = run(["explain", id]);
    assert.equal(e.status, 0, id);
    assert.match(e.stdout, /Why it matters/);
    assert.match(e.stdout, /https:\/\//);
  }
  assert.equal(run(["explain", "no/such"]).status, 2);
  assert.equal(run(["explain"]).status, 2);
  const list = run(["rules"]);
  assert.equal(list.status, 0);
  for (const id of RULE_IDS) assert.ok(list.stdout.includes(id), id);
  assert.equal(JSON.parse(run(["rules", "--json"]).stdout).length, RULE_IDS.length);
});

test("help and version", () => {
  const h = run([]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /run from the repository root/);
  assert.match(run(["--version"]).stdout, /^\d+\.\d+\.\d+/);
});
