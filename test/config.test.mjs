// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, ConfigError, globToRegExp, defaultConfig } from "../src/config.mjs";
import { RULE_IDS } from "../src/rules/index.mjs";

const ids = new Set(RULE_IDS);

test("defaults and a full valid config", () => {
  const c = validateConfig({ version: 1, canonical: "./AGENTS.md", ignore: ["vendor/**"], limits: { codexBytes: 65536 }, rules: { "canonical/name": "off", "claude/size": { severity: "info" } }, review: { externalReviewer: { claude: "codex" }, codex: { effort: "high" } } }, ids);
  assert.equal(c.canonical, "AGENTS.md");
  assert.equal(c.limits.codexBytes, 65536);
  assert.equal(c.limits.claudeLines, defaultConfig().limits.claudeLines);
  assert.equal(c.rules["claude/size"], "info");
  assert.equal(c.review.codex.effort, "high");
  assert.equal(c.review.claude.model, "sonnet");
});

test("rejections are ConfigError", () => {
  const bad = [
    { version: 2 },
    { nope: 1 },
    { rules: { "no/such": "warn" } },
    { rules: { "claude/size": { severity: "warn", maxLines: 300 } } },
    { rules: { "claude/size": "loud" } },
    { limits: { codexBytes: 0 } },
    { limits: { other: 1 } },
    { review: { externalReviewer: { claude: "gemini" } } },
    { review: { codex: { model: "" } } },
    { review: { codex: { temperature: "1" } } },
    { canonical: "" },
    { ignore: "vendor/**" },
    [],
  ];
  for (const raw of bad) assert.throws(() => validateConfig(raw, ids), ConfigError, JSON.stringify(raw));
});

test("globToRegExp", () => {
  assert.ok(globToRegExp("test/fixtures/**").test("test/fixtures/a/b.md"));
  assert.ok(globToRegExp("test/fixtures/**").test("test/fixtures/"));
  assert.ok(!globToRegExp("test/fixtures/**").test("test/other/a.md"));
  assert.ok(globToRegExp("**/*.md").test("a/b/c.md"));
  assert.ok(globToRegExp("*.md").test("c.md"));
  assert.ok(!globToRegExp("*.md").test("a/c.md"));
  assert.ok(globToRegExp("docs/?.md").test("docs/a.md"));
});

test("inherited property names are not limits; $schema must be a string; canonical stays inside the repo", () => {
  assert.throws(() => validateConfig({ limits: { toString: 1 } }, ids), ConfigError);
  assert.throws(() => validateConfig({ $schema: 1 }, ids), ConfigError);
  assert.throws(() => validateConfig({ canonical: "../x.md" }, ids), ConfigError);
  assert.equal(validateConfig({ canonical: "docs/../AGENTS.md" }, ids).canonical, "AGENTS.md");
});
