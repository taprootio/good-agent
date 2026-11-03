// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
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

test("open-pr names the release decision steps and the diff prompt carries the matching check", () => {
  const flat = (/** @type {string} */ t) => t.replace(/\s+/g, " ");
  const skill = flat(readFileSync(join(REPO, "skill", "open-pr", "SKILL.md"), "utf8"));
  for (const [heading, re] of [
    ["branch and gates", /## 1\. Confirm the branch and the gates/],
    ["version bump decision", /## 2\. Decide whether this pull request needs a version bump/],
    ["commits and branch name", /## 3\. Check the commits and the branch name/],
    ["PR body", /## 4\. Write the PR body/],
    ["open after approval", /## 5\. Open it, after approval/],
  ]) assert.match(skill, re, heading);
  for (const phrase of ["Is this pull request the release?", "Unreleased", "no release flow", "several manifests", "deliberately not a release"]) assert.ok(skill.includes(phrase), `open-pr lacks "${phrase}"`);
  const diff = readFileSync(join(REPO, "skill", "review-loop", "references", "review-diff.md"), "utf8");
  const body = flat(diff.slice(0, diff.indexOf("<!-- ENDING:")));
  assert.match(body, /changes shipped behaviour/);
  assert.match(body, /version bump the repository's release flow needs/);
  assert.match(body, /say why it is not a release/);
  assert.match(body, /no release flow/);
});
