// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateSkillFile } from "../src/skill-validate.mjs";
import { REPO, FIXTURES } from "./helpers.mjs";

test("fixture skills: the valid one passes, each invalid one fails for its reason", () => {
  assert.deepEqual(validateSkillFile(join(FIXTURES, "skills", "valid", "good-skill", "SKILL.md")), []);
  const invalid = join(FIXTURES, "skills", "invalid");
  const expect = { "bad_name": /lowercase/, "mismatch": /match the directory/, "unknown-key": /unknown front matter key/, "no-front-matter": /line 1/ };
  for (const [dir, re] of Object.entries(expect)) {
    const problems = validateSkillFile(join(invalid, dir, "SKILL.md"));
    assert.ok(problems.some((p) => re.test(p)), `${dir}: ${problems.join("; ")}`);
  }
});

test("every shipped skill is valid and within its line limit", () => {
  const skillRoot = join(REPO, "skill");
  if (!existsSync(skillRoot)) return;
  for (const dir of readdirSync(skillRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(skillRoot, dir.name, "SKILL.md");
    const limit = dir.name === "good-agent" ? 200 : 250;
    assert.deepEqual(validateSkillFile(file, { maxLines: limit }), [], dir.name);
  }
});
