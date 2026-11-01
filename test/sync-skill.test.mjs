// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, tempTree } from "./helpers.mjs";

const SCRIPT = join(REPO, "scripts", "sync-skill.mjs");

/** @param {string[]} args */
function sync(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("drift: the recipes in skill/good-agent/SKILL.md match the rule modules", () => {
  const r = sync(["--check"]);
  assert.equal(r.status, 0, r.stderr);
});

test("--check exits 1 on a copy whose recipes block was blanked, and a plain run repairs it", () => {
  const original = readFileSync(join(REPO, "skill", "good-agent", "SKILL.md"), "utf8");
  const blanked = original.replace(/<!-- BEGIN RECIPES -->[\s\S]*<!-- END RECIPES -->/, "<!-- BEGIN RECIPES -->\n<!-- END RECIPES -->");
  assert.notEqual(blanked, original);
  const tree = tempTree({ "SKILL.md": blanked });
  try {
    const file = join(tree.root, "SKILL.md");
    const checked = sync(["--check", file]);
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /out of date/);
    assert.equal(sync([file]).status, 0);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(sync(["--check", file]).status, 0);
    writeFileSync(file, "no markers here\n");
    assert.equal(sync(["--check", file]).status, 2);
  } finally { tree.cleanup(); }
});

test("the generated recipes never put a bare --- line outside a code fence (it would read as a setext heading)", () => {
  const text = readFileSync(join(REPO, "skill", "good-agent", "SKILL.md"), "utf8");
  const block = text.slice(text.indexOf("<!-- BEGIN RECIPES -->"), text.indexOf("<!-- END RECIPES -->"));
  let fenced = false;
  for (const line of block.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (!fenced) assert.notEqual(line.trim(), "---");
  }
  assert.equal(fenced, false);
});

test("a CRLF checkout of an unchanged skill is not drift, and a repair keeps CRLF", () => {
  const original = readFileSync(join(REPO, "skill", "good-agent", "SKILL.md"), "utf8");
  const crlf = original.replace(/\n/g, "\r\n");
  const tree = tempTree({ "SKILL.md": crlf });
  try {
    const file = join(tree.root, "SKILL.md");
    assert.equal(sync(["--check", file]).status, 0);
    assert.equal(readFileSync(file, "utf8"), crlf, "an in-sync CRLF file is not rewritten");
    writeFileSync(file, crlf.replace(/<!-- BEGIN RECIPES -->[\s\S]*<!-- END RECIPES -->/, "<!-- BEGIN RECIPES -->\r\n<!-- END RECIPES -->"));
    assert.equal(sync(["--check", file]).status, 1);
    assert.equal(sync([file]).status, 0);
    assert.equal(readFileSync(file, "utf8"), crlf);
  } finally { tree.cleanup(); }
});
