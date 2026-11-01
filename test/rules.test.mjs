// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { run, FIXTURES, REPO } from "./helpers.mjs";
import { RULES } from "../src/rules/index.mjs";

/** Every fixture directory that holds an expected.json, at depth one or two. */
function cases() {
  /** @type {string[]} */
  const out = [];
  for (const group of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const g = join(FIXTURES, group.name);
    if (existsSync(join(g, "expected.json"))) out.push(g);
    for (const c of readdirSync(g, { withFileTypes: true })) {
      if (c.isDirectory() && existsSync(join(g, c.name, "expected.json"))) out.push(join(g, c.name));
    }
  }
  return out;
}

/** @param {{ rule: string, file: string, line?: number, severity?: string, generatedBy?: string }} f */
const key = (f) => `${f.rule}@${f.file}${f.line ? `:${f.line}` : ""}#${f.severity ?? "?"}${f.generatedBy ? `[${f.generatedBy}]` : ""}`;

for (const dir of cases()) {
  test(`fixture ${dir.slice(FIXTURES.length + 1)}`, () => {
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
    const r = run(["check", "--json", "--cwd", dir]);
    assert.ok(r.stdout, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(r.status, expected.exitCode, `exit code; findings: ${JSON.stringify(j.findings.map(key))}`);
    assert.equal(j.summary.exitCode, expected.exitCode);
    const actual = j.findings.map((/** @type {any} */ f) => ({ rule: f.rule, file: f.file, line: f.line, severity: f.severity, generatedBy: f.generatedBy })).map(key).sort();
    const want = expected.findings.map((/** @type {any} */ f) => key({ ...f, line: f.line })).sort();
    // expected.json may omit the line; compare on what it states
    const loose = actual.map((a, i) => (want[i] && !want[i].includes(":") ? a.replace(/:\d+/, "") : a));
    assert.deepEqual(loose, want);
  });
}

test("every rule has rationale, fix and an https primary doc", () => {
  for (const rule of RULES) {
    assert.ok(rule.rationale.length > 40, rule.id);
    assert.ok(rule.fix.length > 10, rule.id);
    assert.ok(rule.docs.length > 0 && rule.docs[0].startsWith("https://"), rule.id);
    assert.match(rule.id, /^[a-z]+\/[a-z-]+$/);
    assert.equal(rule.since, "0.1.0");
  }
});

test("the import fix for .claude/CLAUDE.md is relative to that file", async () => {
  const { importText } = await import("../src/rules/claude/import-canonical.mjs");
  assert.equal(importText(".claude/CLAUDE.md", "AGENTS.md"), "@../AGENTS.md");
  assert.equal(importText("CLAUDE.md", "AGENTS.md"), "@AGENTS.md");
  assert.equal(importText("CLAUDE.md", "docs/My Guide.md"), "@docs/My\\ Guide.md");
});

test("canonical/name can be imported on its own (no circular import through the engine)", () => {
  const url = pathToFileURL(join(REPO, "src", "rules", "canonical", "name.mjs")).href;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1])", "--", url], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
