// @ts-check
/**
 * The README's example output and its hook and Actions snippets are checked
 * against the built CLI so the article's screenshot and the code agree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, REPO, BIN, FIXTURES, tempTree } from "./helpers.mjs";

const readme = readFileSync(join(REPO, "README.md"), "utf8");

/** @param {string} s */
const normalizeVersion = (s) => s.replace(/good-agent \d+\.\d+\.\d+(-[\w.]+)?/g, "good-agent X.Y.Z");

test("README example output is what the readme-example fixture produces", () => {
  const m = readme.match(/```\n(good-agent \d+\.\d+\.\d+ · [\s\S]*?)\n```/);
  assert.ok(m, "README has no example output block");
  const actual = run(["check", "--cwd", join(FIXTURES, "readme-example")]).stdout.trimEnd();
  assert.equal(normalizeVersion(actual), normalizeVersion(m[1]));
});

/**
 * A scratch git repo with the unpublished CLI reachable as
 * node_modules/.bin/good-agent, which is what `npx --no-install` resolves.
 */
function scratchRepo() {
  const t = tempTree({ "AGENTS.md": "# a\n\n- Rule one that is long enough to count.\n", "CLAUDE.md": "@AGENTS.md\n", "src/app.js": "x\n" });
  const bin = join(t.root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "good-agent");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(shim, 0o755);
  execFileSync("git", ["init", "-q"], { cwd: t.root });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."], { cwd: t.root });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: t.root });
  return t;
}

/** @param {string} root @param {string} script */
function sh(root, script) {
  return spawnSync("sh", ["-c", script], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "node_modules", ".bin")}:${process.env.PATH}` } });
}

test("README pre-commit hook snippet: empty commit, path with a space, broken instruction file", () => {
  const m = readme.match(/```sh\n(git diff --cached --name-only -z \| xargs -0 -r npx --no-install good-agent check)\n```/);
  assert.ok(m, "README has no hook snippet");
  const hook = m[1];
  const t = scratchRepo();
  try {
    const empty = sh(t.root, hook);
    assert.equal(empty.status, 0, `empty commit: ${empty.stdout}${empty.stderr}`);
    assert.equal(empty.stdout.trim(), "");
    mkdirSync(join(t.root, "my app"));
    writeFileSync(join(t.root, "my app", "AGENTS.md"), "# nested\n\nSee [gone](missing.md).\n");
    execFileSync("git", ["add", "my app/AGENTS.md"], { cwd: t.root });
    const spaced = sh(t.root, hook);
    assert.equal(spaced.status, 1, `path with a space should reach check: ${spaced.stdout}${spaced.stderr}`);
    assert.match(spaced.stdout, /my app\/AGENTS\.md/);
    execFileSync("git", ["reset", "-q"], { cwd: t.root });
    writeFileSync(join(t.root, "src", "app.js"), "y\n");
    execFileSync("git", ["add", "src/app.js"], { cwd: t.root });
    const code = sh(t.root, hook);
    assert.equal(code.status, 0);
    assert.match(code.stdout, /nothing to check/);
  } finally { t.cleanup(); }
});

test("README GitHub Actions snippet runs against the built CLI", () => {
  const m = readme.match(/- run: (npx good-agent@[\d.]+ check)\n/);
  assert.ok(m, "README has no Actions run line");
  const t = scratchRepo();
  try {
    const cmd = m[1].replace(/npx good-agent@[\d.]+/, "good-agent");
    const r = sh(t.root, cmd);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { t.cleanup(); }
});
