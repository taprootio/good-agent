// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateSkillFile, validateSkillText } from "../src/skill-validate.mjs";
import { REPO, FIXTURES } from "./helpers.mjs";

test("fixture skills: the valid one passes, each invalid one fails for its reason", () => {
  assert.deepEqual(validateSkillFile(join(FIXTURES, "skills", "valid", "good-skill", "SKILL.md")), []);
  const invalid = join(FIXTURES, "skills", "invalid");
  const expect = { "bad_name": /lowercase/, "mismatch": /match the directory/, "unknown-key": /unknown front matter key/, "no-front-matter": /line 1/, "unquoted-colon": /quote the value/ };
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

test("validator: an unquoted name or description that YAML would misread is flagged; the quoted form passes", () => {
  const text = (/** @type {string} */ description) => `---\nname: x\ndescription: ${description}\n---\n`;
  for (const bad of ["a: b", "a: b # c", "[x] y", "*x", "!x", "@x", "`x`", "%x", "- x: y"]) {
    assert.ok(validateSkillText(text(bad), "x").some((p) => /quote the value/.test(p)), bad);
  }
  for (const good of ["plain words, with `code` and a#b", "plain words # a trailing comment", "words\n  more words # comment", '"a: b"', "\"a: b #c\n  and more: here\"", "'a: b'"]) {
    assert.deepEqual(validateSkillText(text(good), "x"), [], good);
  }
  assert.deepEqual(validateSkillText("---\nname: x # directory name\ndescription: d # what it does\n---\n", "x"), []);
  assert.ok(validateSkillText("---\nname: a: b\ndescription: d\n---\n", "a").some((p) => /name is an unquoted/.test(p)));
});
