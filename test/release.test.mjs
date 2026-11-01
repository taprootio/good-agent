// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "./helpers.mjs";

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));
/** @param {string} rel */
const readText = (rel) => readFileSync(join(REPO, rel), "utf8");

test("the main package ships exactly the seven allowlisted entries and the cli export", () => {
  const pkg = readJson("package.json");
  assert.deepEqual(pkg.files, ["scripts/", "src/", "skill/", "schema/", "README.md", "CHANGELOG.md", "LICENSE"]);
  assert.equal(pkg.exports["./cli"], "./src/cli.mjs");
  assert.equal(pkg.bin["good-agent"], "./scripts/good-agent.mjs");
});

test("alias/package.json: dependency range, bin file, executable, imports good-agent/cli", () => {
  const alias = readJson("alias/package.json");
  assert.equal(alias.name, "@taprootio/good-agent");
  assert.deepEqual(alias.dependencies, { "good-agent": ">=0.1.0 <1" });
  assert.deepEqual(alias.files, ["bin.mjs", "README.md"]);
  const bin = alias.bin["good-agent"];
  assert.equal(bin, "./bin.mjs");
  const file = join(REPO, "alias", bin);
  assert.ok(existsSync(file), "alias bin exists");
  assert.ok((statSync(file).mode & 0o111) !== 0, "alias bin is executable");
  const src = readFileSync(file, "utf8");
  assert.ok(src.startsWith("#!/usr/bin/env node\n"));
  assert.ok(src.includes("good-agent/cli"));
  assert.match(src, /await main\(process\.argv\.slice\(2\)\)/);
  assert.match(src, /process\.exitCode\s*=/);
});

test("placeholders are README-only: no bin, no main, files is README.md", () => {
  for (const [dir, name] of [["good-agent", "good-agent"], ["scoped", "@taprootio/good-agent"]]) {
    const pkg = readJson(`placeholder/${dir}/package.json`);
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, "0.0.1");
    assert.equal(pkg.bin, undefined);
    assert.equal(pkg.main, undefined);
    assert.equal(pkg.exports, undefined);
    assert.equal(pkg.dependencies, undefined);
    assert.deepEqual(pkg.files, ["README.md"]);
    assert.ok(existsSync(join(REPO, "placeholder", dir, "README.md")));
    assert.deepEqual(readdirSync(join(REPO, "placeholder", dir)).sort(), ["README.md", "package.json"]);
  }
});

test("npm pack lists the shipped files and nothing from alias, placeholder, test, docs or trellis", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [info] = JSON.parse(r.stdout);
  /** @type {string[]} */
  const paths = info.files.map((/** @type {{ path: string }} */ f) => f.path);
  for (const want of ["scripts/good-agent.mjs", "src/cli.mjs", "skill/good-agent/SKILL.md", "skill/review-loop/references/review-diff.md", "schema/findings.json", "CHANGELOG.md", "LICENSE", "README.md", "package.json"]) {
    assert.ok(paths.includes(want), `${want} is packed`);
  }
  const outside = paths.filter((p) => /^(alias|placeholder|test|docs|trellis|\.github)\//.test(p));
  assert.deepEqual(outside, []);
  const allowed = /^(scripts|src|skill|schema)\/|^(README\.md|CHANGELOG\.md|LICENSE|package\.json)$/;
  assert.deepEqual(paths.filter((p) => !allowed.test(p)), []);
});

test("release.yml keeps the 0.0.0 guard, the four gates, and a disabled alias job", () => {
  const yml = readText(".github/workflows/release.yml");
  // The guard is the if ... fi block that starts at the 0.0.0 comparison; slice only that block.
  const start = yml.indexOf('if [ "$version" = "0.0.0" ]; then\n');
  assert.ok(start >= 0, "0.0.0 guard");
  const end = yml.indexOf("\n          fi\n", start);
  assert.ok(end > start, "the guard block closes with fi");
  const guard = yml.slice(start, end);
  const publish = guard.indexOf('echo "publish=false" >> "$GITHUB_OUTPUT"');
  const release = guard.indexOf('echo "release=false" >> "$GITHUB_OUTPUT"');
  const exit0 = guard.indexOf("exit 0");
  assert.ok(publish >= 0 && release >= 0 && exit0 >= 0, "the guard writes both outputs and exits");
  assert.ok(publish < release && release < exit0, "outputs are written before the exit");
  // The guard comes before anything that asks the registry or GitHub.
  assert.ok(start < yml.indexOf("npm view"));
  assert.ok(start < yml.indexOf("gh release view"));
  for (const gate of ["npx --yes @taprootio/trellis@0.2.0 check", "npm test", "npm run typecheck", "node scripts/good-agent.mjs check"]) {
    assert.ok(yml.includes(`- run: ${gate}\n`), gate);
  }
  assert.match(yml, /^  alias:\n(?:    .*\n)*?    if: false\n/m);
  assert.match(yml, /# .*enable/i);
  assert.ok(!yml.includes("\t"), "no tabs");
});

test("release.yml publish job: OIDC, provenance, dist-tag, trigger expression, release target", () => {
  const yml = readText(".github/workflows/release.yml");
  const jobStart = yml.indexOf("\n  publish:\n");
  const jobEnd = yml.indexOf("\n  # The @taprootio/good-agent alias.");
  assert.ok(jobStart >= 0 && jobEnd > jobStart);
  const job = yml.slice(jobStart, jobEnd);
  assert.ok(job.includes("    if: needs.check.outputs.publish == 'true' || needs.check.outputs.release == 'true'\n"));
  assert.match(job, /^    permissions:\n      contents: write.*\n      id-token: write.*\n/m);
  assert.ok(job.includes("- run: npm install -g npm@latest\n"));
  assert.ok(job.includes('npm publish --provenance --access public --tag "$NPM_TAG"'));
  assert.ok(job.includes("NPM_TAG: ${{ needs.check.outputs.npmtag }}"));
  assert.ok(job.includes("VERSION: ${{ needs.check.outputs.version }}"));
  assert.ok(yml.includes('*-*) echo "npmtag=next" >> "$GITHUB_OUTPUT" ;;'));
  assert.ok(yml.includes('*) echo "npmtag=latest" >> "$GITHUB_OUTPUT" ;;'));
  const creates = job.split("\n").filter((l) => !l.trim().startsWith("#") && l.includes("gh release create"));
  assert.equal(creates.length, 2);
  for (const l of creates) assert.ok(l.includes('--target "$GITHUB_SHA"'), l);
  assert.ok(creates.some((l) => l.includes("--prerelease")));
  assert.ok(!/git tag|git push/.test(job), "gh release create makes the tag, so an existing tag never blocks the Release");
});

test("release.yml: every expression names an existing output, job or step", () => {
  const yml = readText(".github/workflows/release.yml");
  const lines = yml.split("\n");
  // Keys under `outputs:` of the check job, and ids set by `echo "<key>=" >> "$GITHUB_OUTPUT"`.
  const outputs = [...yml.matchAll(/^      (\w+): \$\{\{ steps\.state\.outputs\.(\w+) \}\}$/gm)];
  assert.deepEqual(outputs.map((m) => m[1]).sort(), ["npmtag", "publish", "release", "version"]);
  for (const m of outputs) assert.equal(m[1], m[2]);
  const written = new Set([...yml.matchAll(/echo "(\w+)=[^"]*" >> "\$GITHUB_OUTPUT"/g)].map((m) => m[1]));
  for (const m of outputs) assert.ok(written.has(m[2]), `step writes ${m[2]}`);
  assert.ok(yml.includes("        id: state\n"));
  const refs = lines.filter((l) => !l.trim().startsWith("#")).join("\n");
  for (const m of refs.matchAll(/needs\.check\.outputs\.(\w+)/g)) assert.ok(written.has(m[1]), `needs.check.outputs.${m[1]}`);
  for (const m of refs.matchAll(/steps\.(\w+)\.outputs\.(\w+)/g)) assert.ok(m[1] === "state" && written.has(m[2]), m[0]);
  for (const m of refs.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) {
    assert.match(m[1], /^(steps\.state\.outputs\.\w+|needs\.check\.outputs\.\w+|github\.token)$/, m[0]);
  }
  // Expressions reach shell code through env:, never inline in a run: step.
  /** @type {string[]} */
  const runBlocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^( *)(?:- )?run: (.*)$/);
    if (!m) continue;
    const indent = m[1].length + (lines[i].trimStart().startsWith("- ") ? 2 : 0);
    let block = m[2];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || lines[i + 1].length - lines[i + 1].trimStart().length > indent)) block += `\n${lines[++i]}`;
    runBlocks.push(block);
  }
  assert.ok(runBlocks.length > 5);
  for (const block of runBlocks) assert.ok(!/\$\{\{\s*needs\./.test(block), `inline needs reference in a run step: ${block}`);
  // Brace and indentation sanity: two-space steps, jobs at depth one.
  for (const job of ["check", "publish", "alias"]) assert.match(yml, new RegExp(`^  ${job}:$`, "m"));
  for (const l of lines) assert.equal((l.length - l.trimStart().length) % 2, 0, `even indentation: ${l}`);
});

test("CHANGELOG.md has the unreleased 0.1.0 entry naming all nine rules", () => {
  const log = readText("CHANGELOG.md");
  assert.match(log, /^## 0\.1\.0\b/m);
  const ids = [...readText("src/rules/index.mjs").matchAll(/^import \w+ from "\.\/(\w+\/[\w-]+)\.mjs";$/gm)].map((m) => m[1]).filter((id) => id !== "types");
  assert.equal(ids.length, 9);
  for (const id of ids) assert.ok(log.includes(`\`${id}\``), id);
});

test("CHANGELOG.md links every rule's first documentation source", async () => {
  const log = readText("CHANGELOG.md");
  const { RULES } = await import("../src/rules/index.mjs");
  assert.equal(RULES.length, 9);
  for (const rule of RULES) assert.ok(log.includes(`](${rule.docs[0]})`), `${rule.id}: ${rule.docs[0]}`);
});

test("the alias bin runs end to end from local tarballs (offline)", () => {
  const work = mkdtempSync(join(tmpdir(), "good-agent-release-"));
  try {
    const packDir = join(work, "pack");
    mkdirSync(packDir);
    /** @param {string[]} args @param {string} cwd */
    const npm = (args, cwd) => {
      const r = spawnSync("npm", [...args, "--no-audit", "--no-fund", "--offline", "--ignore-scripts"], { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, `npm ${args.join(" ")}\n${r.stderr}`);
      return r.stdout;
    };
    const mainTgz = join(packDir, npm(["pack", "--pack-destination", packDir, "--silent"], REPO).trim().split("\n").pop() ?? "");
    const aliasDir = join(work, "alias");
    cpSync(join(REPO, "alias"), aliasDir, { recursive: true });
    const aliasPkg = readJson("alias/package.json");
    aliasPkg.dependencies["good-agent"] = `file:${mainTgz}`;
    writeFileSync(join(aliasDir, "package.json"), JSON.stringify(aliasPkg));
    const aliasTgz = join(packDir, npm(["pack", "--pack-destination", packDir, "--silent"], aliasDir).trim().split("\n").pop() ?? "");
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), '{"name":"consumer","version":"1.0.0","private":true}');
    npm(["install", aliasTgz], consumer);
    const bin = join(consumer, "node_modules", ".bin", "good-agent");
    const version = spawnSync(bin, ["--version"], { cwd: consumer, encoding: "utf8" });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), readJson("package.json").version);
    const empty = join(work, "empty");
    mkdirSync(empty);
    const none = spawnSync(bin, ["check"], { cwd: empty, encoding: "utf8" });
    assert.equal(none.status, 1);
    assert.match(none.stdout, /canonical\/detect/);
    const ok = join(work, "ok");
    mkdirSync(ok);
    writeFileSync(join(ok, "AGENTS.md"), "# Project\n");
    writeFileSync(join(ok, "CLAUDE.md"), "@AGENTS.md\n");
    const pass = spawnSync(bin, ["check"], { cwd: ok, encoding: "utf8" });
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
