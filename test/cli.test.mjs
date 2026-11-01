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

test("a deleted default config still triggers the path filter; --quiet prints one line; rules reflects config", () => {
  assert.equal(run(["check", "good-agent.config.json"], { cwd: FAIL }).status, 1);
  const q = run(["check", "--quiet", "--cwd", FAIL]).stdout.trim().split("\n");
  assert.equal(q.length, 1);
  assert.match(q[0], /\(exit 1\)$/);
  const t = tempTree({ "AGENTS.md": "# a\n", "good-agent.config.json": '{"rules":{"canonical/name":"off"}}\n' });
  try {
    const rows = JSON.parse(run(["rules", "--json", "--cwd", t.root]).stdout);
    const name = rows.find((/** @type {any} */ r) => r.id === "canonical/name");
    assert.equal(name.enabled, false);
    assert.match(run(["rules", "--cwd", t.root]).stdout, /canonical\/name\s+off/);
  } finally { t.cleanup(); }
  const j = JSON.parse(run(["check", "--json", "--cwd", FAIL]).stdout);
  assert.ok(Array.isArray(j.files[0].readBy));
  const dot = JSON.parse(run(["check", "--json", "--cwd", join(FIXTURES, "claude-import-canonical", "fail-link")]).stdout);
  assert.ok(dot.findings.some((/** @type {any} */ f) => f.rule === "claude/import-canonical"));
});

test("schema rule names match the registry", async () => {
  const { readFileSync } = await import("node:fs");
  const { REPO } = await import("./helpers.mjs");
  const schema = JSON.parse(readFileSync(join(REPO, "schema", "config.json"), "utf8"));
  assert.deepEqual(schema.properties.rules.propertyNames.enum, RULE_IDS);
});

test("--cwd must be a directory; explain rejects extra flags; readBy is modeled; default severities are as designed", async () => {
  assert.equal(run(["check", "--cwd", "/nonexistent/dir"]).status, 2);
  assert.equal(run(["inspect", "--cwd", join(FIXTURES, "canonical-detect", "pass", "AGENTS.md")]).status, 2);
  assert.equal(run(["explain", "links/broken", "--bogus"]).status, 2);
  assert.equal(run(["explain", "links/broken", "extra"]).status, 2);
  const j = JSON.parse(run(["inspect", "--json", "--cwd", join(FIXTURES, "codex-size-budget", "empty-override")]).stdout);
  const agents = j.files.find((/** @type {any} */ f) => f.path === "AGENTS.md");
  const override = j.files.find((/** @type {any} */ f) => f.path === "AGENTS.override.md");
  assert.ok(!agents.readBy.includes("codex") && agents.readBy.includes("copilot") && agents.readBy.includes("claude:import"));
  assert.ok(override.readBy.includes("codex") && !override.readBy.includes("copilot"));
  const { RULES } = await import("../src/rules/index.mjs");
  const defaults = Object.fromEntries(RULES.map((r) => [r.id, r.severity]));
  assert.deepEqual(defaults, { "canonical/detect": "error", "canonical/name": "warn", "codex/size-budget": "error", "claude/import-canonical": "error", "claude/import-depth": "warn", "claude/size": "warn", "links/broken": "error", "copilot/applyto": "error", "dry/copied-canonical": "error" });
});

test("messages: wrong-basename import, Copilot-readable canonical name, multi-line fix text, on-demand readBy", () => {
  const w = JSON.parse(run(["check", "--json", "--cwd", join(FIXTURES, "claude-import-canonical", "wrong-basename")]).stdout);
  const f = w.findings.find((/** @type {any} */ x) => x.rule === "claude/import-canonical");
  assert.match(f.message, /resolves to \.claude\/AGENTS\.md/);
  assert.match(f.fix, /@\.\.\/AGENTS\.md/);
  const c = JSON.parse(run(["check", "--json", "--cwd", join(FIXTURES, "canonical-detect", "copilot-only")]).stdout);
  const n = c.findings.find((/** @type {any} */ x) => x.rule === "canonical/name");
  assert.deepEqual(n.data.unreadBy, ["codex"]);
  assert.match(n.message, /Codex does not read/);
  const human = run(["check", "--cwd", join(FIXTURES, "copilot-applyto", "fail-missing")]).stdout;
  assert.match(human, /\n  fix: Start the file with a front matter block:\n  ---\n  applyTo: "\*\*\/\*\.ts"\n  ---\n/);
  const t = tempTree({ "AGENTS.md": "# a\n", "CLAUDE.md": "@AGENTS.md\n", ".claude/rules/scoped.md": "---\npaths:\n  - src/**\n---\nx\n", "sub/CLAUDE.md": "nested\n" });
  try {
    const j = JSON.parse(run(["inspect", "--json", "--cwd", t.root]).stdout);
    assert.deepEqual(j.files.find((/** @type {any} */ x) => x.path === ".claude/rules/scoped.md").readBy, ["claude:on-demand"]);
    assert.deepEqual(j.files.find((/** @type {any} */ x) => x.path === "sub/CLAUDE.md").readBy, ["claude:on-demand"]);
  } finally { t.cleanup(); }
});

test("config: a directory is not a canonical file; an absolute canonical path is rejected; ignored imports are not loaded", () => {
  const dir = tempTree({ "src/x.js": "x\n", "CLAUDE.md": "@./src\n", "good-agent.config.json": '{"canonical":"src"}\n' });
  try {
    const j = JSON.parse(run(["check", "--json", "--cwd", dir.root]).stdout);
    assert.ok(j.findings.some((/** @type {any} */ f) => f.rule === "canonical/detect"));
  } finally { dir.cleanup(); }
  const abs = tempTree({ "AGENTS.md": "# a\n", "good-agent.config.json": '{"canonical":"/AGENTS.md"}\n' });
  try { assert.equal(run(["check", "--cwd", abs.root]).status, 2); } finally { abs.cleanup(); }
  const long = "# g\n\n" + "- line\n".repeat(205);
  const ign = tempTree({ "AGENTS.md": "# a\n", "CLAUDE.md": "@AGENTS.md\n@vendor/guide.md\n", "vendor/guide.md": long, "good-agent.config.json": '{"ignore":["vendor/**"]}\n' });
  try {
    const j = JSON.parse(run(["check", "--json", "--cwd", ign.root]).stdout);
    assert.ok(!j.findings.some((/** @type {any} */ f) => f.rule === "claude/size"), JSON.stringify(j.findings));
  } finally { ign.cleanup(); }
});
