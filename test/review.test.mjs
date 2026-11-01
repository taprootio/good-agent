// @ts-check
/**
 * The review runner's self-test: fake `codex` and `claude` executables lead
 * PATH, every run sets GOOD_AGENT_REVIEWS to a fresh temp directory, and no
 * model is ever called.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BIN, REPO, tempTree } from "./helpers.mjs";
import { validateFindings, loadPrompt, assemblePrompt } from "../src/review.mjs";
import { deriveId, repoSlug, reserveRound, treeDigest } from "../src/review-store.mjs";

const FAKES = join(REPO, "test", "fakes");
/** @type {string[]} */
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
/** A fresh temp directory, removed when the file's tests finish. */
function scratch(prefix = "good-agent-reviews-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
const TASK = "---\nid: GA0002\ntitle: t\nstatus: active\nmilestone: Alpha\npriority: High\neffort: 1\ndepends_on: []\nsummary: s\n---\n\n# GA0002\n\n## Scope\n\n- x\n\n## Plan\n\n1. do it\n";

/** A git repo on a branch named for GA0001 with a task file for GA0002. */
function repo() {
  const t = tempTree({ "AGENTS.md": "# a\n\n- Rule one that is long enough.\n", "CLAUDE.md": "@AGENTS.md\n", "trellis/active/GA0002.md": TASK, "good-agent.config.json": "{}\n" });
  const g = (/** @type {string[]} */ ...a) => execFileSync("git", ["-C", t.root, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("add", "."); g("commit", "-q", "-m", "init");
  const base = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "je/ga0001/build");
  writeFileSync(join(t.root, "src.js"), "x\n"); g("add", "."); g("commit", "-q", "-m", "work");
  return { ...t, base, g };
}

/**
 * @param {string[]} args
 * @param {{ root: string, env?: Record<string, string>, reviews?: string }} o
 */
function review(args, o) {
  const reviews = o.reviews ?? scratch();
  const record = join(reviews, "record.txt");
  const r = spawnSync(process.execPath, [BIN, "review", ...args], {
    cwd: o.root, encoding: "utf8",
    env: { ...process.env, PATH: `${FAKES}:${process.env.PATH}`, GOOD_AGENT_REVIEWS: reviews, FAKE_RECORD: record, OPENAI_API_KEY: "sk-should-be-stripped", ANTHROPIC_API_KEY: "sk-should-be-stripped", ...(o.env ?? {}) },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, reviews, record: existsSync(record) ? readFileSync(record, "utf8") : "" };
}

test("validateFindings accepts the wrapper and rejects everything else", () => {
  assert.deepEqual(validateFindings({ findings: [] }), []);
  assert.equal(validateFindings({ findings: [{ file: "a", line: 1, severity: "nit", suggestion: "s" }] }).length, 1);
  for (const bad of [[], { findings: {} }, { findings: [], extra: 1 }, { findings: [{ file: "a", line: 0, severity: "nit", suggestion: "s" }] }, { findings: [{ file: "a", line: 1, severity: "major", suggestion: "s" }] }, { findings: [{ file: "a", line: 1, severity: "nit", suggestion: "s", note: "x" }] }, { findings: [{ file: "", line: 1, severity: "nit", suggestion: "s" }] }]) {
    assert.throws(() => validateFindings(bad), undefined, JSON.stringify(bad));
  }
});

test("prompts load with body and runner ending", () => {
  for (const p of ["diff", "story", "plan", "design"]) {
    const { body, ending } = loadPrompt(p);
    assert.ok(body.includes("Review only"), p);
    assert.ok(ending.includes('"findings"'), p);
    assert.ok(!body.includes("ENDING") && !body.startsWith("#"), p);
  }
});

test("prompt assembly fills every placeholder in one pass and appends the runner ending", () => {
  const values = { TASK: "t.md", BASE: "b".repeat(40), HEAD: "h".repeat(40), VERIFIED: "- echo $& $1 {{TASK}}", CHANGED: "M\ta.js", PRIOR: "", BASE_CLAUSE: " and the diff since X", AUTHOR_CONTEXT: "The change was authored by Claude Code and its internal review is clean." };
  for (const p of ["diff", "story", "plan", "design"]) {
    const text = assemblePrompt(p, values);
    assert.ok(!text.includes("{{TASK}}") || p === "diff", `${p}: inserted text is not re-expanded`);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(text.replace("{{TASK}}", "")), p);
    assert.ok(!text.includes("<!-- "), `${p}: no marker comments`);
    assert.ok(text.endsWith("Use {\"findings\":[]} when clean. Nothing after it.\n"), p);
    assert.ok(!text.includes("manual"), p);
  }
  const diff = assemblePrompt("diff", values);
  assert.ok(diff.includes("echo $& $1 {{TASK}}") && diff.includes("The change was authored by Claude Code and its internal review is clean."));
  assert.ok(assemblePrompt("design", values).includes("task cites and the diff since X."));
  assert.throws(() => assemblePrompt("diff", { TASK: "x" }), /unknown placeholder/);
});

test("ids: task front matter, basename, branch segment, slash branch, detached HEAD", () => {
  const r = repo();
  try {
    assert.equal(deriveId(r.root, "trellis/active/GA0002.md"), "GA0002");
    writeFileSync(join(r.root, "notes.md"), "no front matter\n");
    assert.equal(deriveId(r.root, "notes.md"), "notes");
    assert.equal(deriveId(r.root, undefined), "GA0001");
    r.g("checkout", "-q", "-b", "feature/thing");
    assert.equal(deriveId(r.root, undefined), "feature-thing");
    r.g("checkout", "-q", "--detach");
    assert.throws(() => deriveId(r.root, undefined), /detached HEAD/);
  } finally { r.cleanup(); }
});

test("repo slug is shared by worktrees of one clone", () => {
  const r = repo();
  const wt = scratch("good-agent-wt-");
  try {
    r.g("worktree", "add", "-q", join(wt, "w"), "main");
    assert.equal(repoSlug(join(wt, "w")), repoSlug(r.root));
  } finally { r.g("worktree", "remove", "--force", join(wt, "w")); r.cleanup(); }
});

test("rounds are reserved exclusively per id and prompt", () => {
  const dir = scratch("good-agent-rounds-");
  try {
    const a = reserveRound(dir, "GA0002", "diff", {});
    const b = reserveRound(dir, "GA0002", "diff", {});
    const c = reserveRound(dir, "GA0002", "story", {});
    assert.deepEqual([a.round, b.round, c.round], [1, 2, 1]);
    assert.ok(existsSync(a.metaPath) && existsSync(b.metaPath));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tree digest changes with content, additions, deletions, a staged change and an empty commit", () => {
  const r = repo();
  try {
    const d1 = treeDigest(r.root);
    assert.equal(treeDigest(r.root), d1, "stable when nothing moves");
    writeFileSync(join(r.root, "new.txt"), "n\n");
    const d2 = treeDigest(r.root);
    assert.notEqual(d1, d2);
    rmSync(join(r.root, "new.txt"));
    assert.equal(treeDigest(r.root), d1);
    rmSync(join(r.root, "src.js"));
    assert.notEqual(treeDigest(r.root), d1);
    r.g("checkout", "-q", "--", "src.js");
    assert.equal(treeDigest(r.root), d1);
    // Staging a file that is already untracked leaves content and path in the
    // listing the same; the index part is what moves.
    writeFileSync(join(r.root, "staged.txt"), "s\n");
    const untracked = treeDigest(r.root);
    r.g("add", "staged.txt");
    assert.notEqual(treeDigest(r.root), untracked, "a staged change");
    r.g("reset", "-q", "staged.txt");
    rmSync(join(r.root, "staged.txt"));
    assert.equal(treeDigest(r.root), d1);
    r.g("commit", "-q", "--allow-empty", "-m", "empty");
    assert.notEqual(treeDigest(r.root), d1, "an empty commit moves HEAD");
  } finally { r.cleanup(); }
});

test("tree digest of a directory that is not a git repository still works", () => {
  const t = tempTree({ "a.txt": "a\n" });
  try {
    const d = treeDigest(t.root);
    assert.match(d, /^[0-9a-f]{64}$/);
    assert.equal(treeDigest(t.root), d);
  } finally { t.cleanup(); }
});

test("usage errors exit 2 before any reviewer runs", () => {
  const r = repo();
  try {
    const cases = [
      [["--prompt", "diff"], /--by/],
      [["--by", "codex", "--prompt", "diff"], /--base/],
      [["--by", "codex", "--prompt", "story"], /--task/],
      [["--by", "gemini", "--prompt", "story", "--task", "trellis/active/GA0002.md"], /--by must be/],
      [["--by", "codex", "--prompt", "plan", "--task", "AGENTS.md"], /## Plan/],
      [["--by", "codex", "--prompt", "diff", "--base", "nope"], /not a commit/],
      [["--by", "codex", "--prompt", "diff", "--base", "main", "--timeout-minutes", "x"], /timeout/],
      [["--by", "codex", "--prompt", "diff", "--base", "main", "--bogus"], /bogus/],
      [["--by", "codex", "--prompt", "story", "--task", ""], /--task must not be empty/],
      [["--by", "codex", "--prompt", "story", "--task", "nope.md"], /task file not found/],
      [["--by", "codex", "--prompt", "story", "--task", "trellis/active/GA0002.md", "--effort", 'high"; rm -rf /'], /--effort/],
      [["--by", "codex", "--prompt", "story", "--task", "trellis/active/GA0002.md", "--prior", "missing.json"], /--prior/],
    ];
    for (const [args, re] of cases) {
      const res = review(/** @type {string[]} */ (args), { root: r.root });
      assert.equal(res.status, 2, `${args.join(" ")}: ${res.stderr}`);
      assert.match(res.stderr, /** @type {RegExp} */ (re));
      assert.equal(res.record, "", "a reviewer ran");
    }
    const inside = review(["--by", "codex", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { root: r.root, reviews: join(r.root, "reviews") });
    assert.equal(inside.status, 2); assert.match(inside.stderr, /inside the repository/);
    assert.equal(inside.record, "");
  } finally { r.cleanup(); }
});

test("codex happy path: hardened flags, keys stripped, history written, exit 0, --json prints the array", () => {
  const r = repo();
  try {
    const res = review(["--by", "codex", "--prompt", "diff", "--base", r.base, "--task", "trellis/active/GA0002.md", "--verified", "npm test", "--json"], { root: r.root });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), []);
    const argv = res.record.split("\n").find((l) => l.startsWith("ARGV:exec")) ?? "";
    for (const flag of ["--sandbox read-only", 'approval_policy="never"', "--ignore-rules", "features.hooks=false", "features.plugins=false", "--ephemeral", "--output-schema", 'model_reasoning_effort="medium"']) assert.ok(argv.includes(flag), flag);
    assert.ok(!argv.includes("-m "), "no model when config has none");
    assert.ok(res.record.includes("OPENAI_API_KEY=unset") && res.record.includes("CODEX_API_KEY=unset"));
    const slugDir = readdirSync(res.reviews).find((n) => n !== "record.txt" && n !== "codex.lock");
    assert.ok(slugDir);
    const files = readdirSync(join(res.reviews, slugDir)).sort();
    assert.deepEqual(files, ["GA0002-diff-r1.json", "GA0002-diff-r1.log", "GA0002-diff-r1.meta.json"]);
    const meta = JSON.parse(readFileSync(join(res.reviews, slugDir, "GA0002-diff-r1.meta.json"), "utf8"));
    assert.equal(meta.status, "ok"); assert.equal(meta.tree_stable, true); assert.equal(meta.reviewer, "codex");
    assert.ok(!existsSync(join(res.reviews, "codex.lock")), "lock released");
    const log = readFileSync(join(res.reviews, slugDir, "GA0002-diff-r1.log"), "utf8");
    assert.ok(log.includes("Verification already passed") && log.includes("npm test") && log.includes("src.js"));
  } finally { r.cleanup(); }
});

test("claude happy path: safe mode flags, envelope unwrapped, findings exit 1 with human output", () => {
  const r = repo();
  try {
    const res = review(["--by", "claude", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { root: r.root, env: { FAKE_OUTPUT: '{"findings":[{"file":"trellis/active/GA0002.md","line":3,"severity":"warning","suggestion":"say more"}]}' } });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stdout, /GA0002-story-r1 by claude \(sonnet, high\)/);
    assert.match(res.stdout, /trellis\/active\/GA0002.md:3  warning/);
    const argv = res.record.split("\n").find((l) => l.startsWith("ARGV:-p")) ?? "";
    for (const flag of ["--safe-mode", "--setting-sources  ", "--permission-mode dontAsk", "--tools Read Grep Glob Bash", "--allowedTools Read Grep Glob", "--disallowedTools Edit Write NotebookEdit Agent", "--strict-mcp-config", "--no-chrome", "--json-schema", "--output-format json", "--model sonnet", "--effort high"]) assert.ok(argv.includes(flag), flag);
    assert.ok(res.record.includes("ANTHROPIC_API_KEY=unset"));
  } finally { r.cleanup(); }
});

test("--by defaults from review.externalReviewer and --author", () => {
  const r = repo();
  try {
    const res = review(["--author", "claude", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { root: r.root });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.record.includes("ARGV:exec"), "codex should review claude's work");
    // The config decides: here claude's work is reviewed by claude, with the configured model and effort.
    writeFileSync(join(r.root, "good-agent.config.json"), JSON.stringify({ review: { externalReviewer: { claude: "claude" }, claude: { model: "opus", effort: "max" } } }));
    const viaConfig = review(["--author", "claude", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { root: r.root });
    assert.equal(viaConfig.status, 0, viaConfig.stderr);
    assert.ok(viaConfig.record.includes("--model opus --effort max"));
    const flags = review(["--author", "claude", "--prompt", "story", "--task", "trellis/active/GA0002.md", "--model", "haiku", "--effort", "low"], { root: r.root });
    assert.ok(flags.record.includes("--model haiku --effort low"));
    const explicit = review(["--author", "claude", "--by", "codex", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { root: r.root });
    assert.ok(explicit.record.includes("ARGV:exec"), "--by wins over the config");
  } finally { r.cleanup(); }
});

/**
 * The rounds recorded for one history directory: file name to parsed meta.
 * @param {string} reviews
 */
function metas(reviews) {
  const slugDir = readdirSync(reviews).find((n) => !n.endsWith(".lock") && n !== "record.txt");
  if (!slugDir) return {};
  /** @type {Record<string, any>} */
  const found = {};
  for (const n of readdirSync(join(reviews, slugDir)).filter((f) => f.endsWith(".meta.json")).sort()) found[n.replace(".meta.json", "")] = JSON.parse(readFileSync(join(reviews, slugDir, n), "utf8"));
  return found;
}

test("failure modes exit 3, keep their round number and record the status in .meta.json", () => {
  const r = repo();
  const reviews = scratch();
  try {
    const base = ["--by", "codex", "--prompt", "diff", "--base", r.base, "--task", "trellis/active/GA0002.md"];
    let res = review(base, { root: r.root, reviews, env: { FAKE_OUTPUT: '{"findings":[{"file":"a","line":1,"severity":"major","suggestion":"x"}]}' } });
    assert.equal(res.status, 3); assert.match(res.stderr, /REVIEW_ERROR/); assert.match(res.stderr, /severity/); assert.match(res.stderr, /GA0002-diff-r1/);
    res = review(base, { root: r.root, reviews, env: { FAKE_TOUCH: join(r.root, "AGENTS.md") } });
    assert.equal(res.status, 3); assert.match(res.stderr, /REVIEW_UNSAFE/);
    r.g("checkout", "-q", "--", "AGENTS.md");
    res = review(base, { root: r.root, reviews, env: { FAKE_EXIT: "2", FAKE_STDERR: "error: unexpected argument '--ephemeral' found" } });
    assert.equal(res.status, 3); assert.match(res.stderr, /a flag was rejected: error: unexpected argument '--ephemeral'/);
    const t0 = Date.now();
    res = review([...base, "--timeout-minutes", "0.02"], { root: r.root, reviews, env: { FAKE_SLEEP: "20" } });
    assert.equal(res.status, 3); assert.match(res.stderr, /exceeded/);
    assert.ok(Date.now() - t0 < 15_000, "the reviewer's whole process group is killed, not only the shell");
    res = review(base, { root: r.root, reviews, env: { FAKE_NO_OUTPUT: "1" } });
    assert.equal(res.status, 3); assert.match(res.stderr, /no output file/);
    res = review(["--by", "claude", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { root: r.root, reviews, env: { FAKE_RAW_STDOUT: '{"type":"result","subtype":"error","is_error":true}' } });
    assert.equal(res.status, 3); assert.match(res.stderr, /envelope/);
    res = review(["--by", "claude", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { root: r.root, reviews, env: { FAKE_RAW_STDOUT: "not json" } });
    assert.equal(res.status, 3); assert.match(res.stderr, /not JSON/);
    // a failed round keeps its number and the next round takes the next one
    const ok = review(base, { root: r.root, reviews });
    assert.equal(ok.status, 0, ok.stderr);
    const m = metas(reviews);
    assert.deepEqual(Object.keys(m), ["GA0002-diff-r1", "GA0002-diff-r2", "GA0002-diff-r3", "GA0002-diff-r4", "GA0002-diff-r5", "GA0002-diff-r6", "GA0002-story-r1", "GA0002-story-r2"]);
    assert.deepEqual(["r1", "r2", "r3", "r4", "r5", "r6"].map((n) => m[`GA0002-diff-${n}`].status), ["REVIEW_ERROR", "REVIEW_UNSAFE", "REVIEW_ERROR", "REVIEW_ERROR", "REVIEW_ERROR", "ok"]);
    assert.equal(m["GA0002-diff-r2"].tree_stable, false);
    assert.equal(m["GA0002-diff-r4"].timed_out, true);
    assert.match(m["GA0002-diff-r3"].error, /exited 2/);
    assert.match(m["GA0002-story-r1"].error, /envelope/);
    assert.ok(existsSync(join(reviews, readdirSync(reviews).find((n) => !n.endsWith(".lock") && n !== "record.txt") ?? "", "GA0002-diff-r6.json")));
    assert.ok(!existsSync(join(reviews, "codex.lock")) && !existsSync(join(reviews, "claude.lock")), "locks released after failures");
  } finally { r.cleanup(); }
});

test("old CLI version and MCP servers that stay enabled are refused", () => {
  const r = repo();
  const reviews = scratch();
  try {
    const base = ["--by", "codex", "--prompt", "story", "--task", "trellis/active/GA0002.md"];
    let res = review(base, { root: r.root, reviews, env: { FAKE_VERSION: "0.100.0" } });
    assert.equal(res.status, 3); assert.match(res.stderr, /older than/);
    assert.deepEqual(metas(reviews), {}, "refused before a round was reserved");
    res = review(["--by", "claude", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { root: r.root, reviews, env: { FAKE_VERSION: "1.0.0" } });
    assert.equal(res.status, 3); assert.match(res.stderr, /older than/);
    res = review(base, { root: r.root, reviews, env: { FAKE_MCP: '[{"name":"honeycomb","enabled":true}]', FAKE_MCP_STUCK: "1" } });
    assert.equal(res.status, 3); assert.match(res.stderr, /still enabled for a review: honeycomb/);
    assert.equal(metas(reviews)["GA0002-story-r1"].status, "REVIEW_ERROR", "the refusal is recorded on its round");
    assert.ok(!res.record.includes("ARGV:exec"), "the review itself never ran");
    res = review(base, { root: r.root, reviews, env: { FAKE_MCP: '[{"name":"honeycomb","enabled":true},{"name":"off","enabled":false}]' } });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.record.includes("mcp_servers.honeycomb.enabled=false") && !res.record.includes("mcp_servers.off.enabled=false"));
    res = review(base, { root: r.root, reviews, env: { FAKE_MCP: '[{"name":"bad name","enabled":true}]' } });
    assert.equal(res.status, 3); assert.match(res.stderr, /cannot be switched off/);
  } finally { r.cleanup(); }
});

test("lock contention, --no-wait, and stale-lock takeover", () => {
  const r = repo();
  const reviews = scratch();
  try {
    writeFileSync(join(reviews, "codex.lock"), JSON.stringify({ pid: process.pid, host: hostname(), started: "now" }));
    const base = ["--by", "codex", "--prompt", "story", "--task", "trellis/active/GA0002.md"];
    let res = review([...base, "--no-wait"], { root: r.root, reviews });
    assert.equal(res.status, 2); assert.match(res.stderr, /another codex review is running/);
    assert.ok(!res.record.includes("ARGV:exec"), "no review ran");
    res = review([...base, "--timeout-minutes", "0.02"], { root: r.root, reviews });
    assert.equal(res.status, 3); assert.match(res.stderr, /timed out waiting/);
    assert.ok(existsSync(join(reviews, "codex.lock")), "a live holder's lock is left alone");
    writeFileSync(join(reviews, "codex.lock"), JSON.stringify({ pid: 999999, host: hostname(), started: "then" }));
    res = review(base, { root: r.root, reviews });
    assert.equal(res.status, 0, `stale lock should be taken over: ${res.stderr}`);
    assert.ok(!existsSync(join(reviews, "codex.lock")), "released after the takeover");
    // a lock held on another host is never taken over
    writeFileSync(join(reviews, "codex.lock"), JSON.stringify({ pid: 999999, host: "some-other-host", started: "then" }));
    res = review([...base, "--no-wait"], { root: r.root, reviews });
    assert.equal(res.status, 2);
  } finally { r.cleanup(); }
});

test("a half-written lock is taken over once it is old", () => {
  const r = repo();
  const reviews = scratch();
  try {
    const lock = join(reviews, "codex.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const res = review(["--by", "codex", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { root: r.root, reviews });
    assert.equal(res.status, 0, res.stderr);
  } finally { r.cleanup(); }
});

test("a Codex and a Claude review of one task running at once reserve distinct rounds", async () => {
  const r = repo();
  const reviews = scratch();
  try {
    const env = { ...process.env, PATH: `${FAKES}:${process.env.PATH}`, GOOD_AGENT_REVIEWS: reviews, FAKE_SLEEP: "1" };
    /** @param {string} by */
    const go = (by) => new Promise((done) => {
      const child = spawn(process.execPath, [BIN, "review", "--by", by, "--prompt", "story", "--task", "trellis/active/GA0002.md"], { cwd: r.root, env });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (status) => done({ status, stderr }));
    });
    const results = /** @type {{ status: number, stderr: string }[]} */ (await Promise.all([go("codex"), go("claude")]));
    for (const x of results) assert.equal(x.status, 0, x.stderr);
    const m = metas(reviews);
    assert.deepEqual(Object.keys(m), ["GA0002-story-r1", "GA0002-story-r2"]);
    assert.deepEqual(Object.values(m).map((x) => x.reviewer).sort(), ["claude", "codex"]);
    // Two reviews by the same reviewer queue behind each other instead.
    const same = await Promise.all([go("codex"), go("codex")]);
    for (const x of /** @type {{ status: number, stderr: string }[]} */ (same)) assert.equal(x.status, 0, x.stderr);
    assert.deepEqual(Object.keys(metas(reviews)), ["GA0002-story-r1", "GA0002-story-r2", "GA0002-story-r3", "GA0002-story-r4"]);
  } finally { r.cleanup(); }
});

test("--prompt diff --task GA0002 on a branch named for GA0001 files the round under GA0002", () => {
  const r = repo();
  try {
    assert.equal(r.g("rev-parse", "--abbrev-ref", "HEAD"), "je/ga0001/build");
    const res = review(["--by", "codex", "--prompt", "diff", "--base", r.base, "--task", "trellis/active/GA0002.md"], { root: r.root });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(Object.keys(metas(res.reviews)), ["GA0002-diff-r1"]);
    // Without --task the id comes from the branch.
    const other = review(["--by", "codex", "--prompt", "diff", "--base", r.base], { root: r.root });
    assert.equal(other.status, 0, other.stderr);
    assert.deepEqual(Object.keys(metas(other.reviews)), ["GA0001-diff-r1"]);
  } finally { r.cleanup(); }
});

test("--prior is validated and put in the next round's prompt", () => {
  const r = repo();
  try {
    const prior = join(r.root, "..", `prior-${process.pid}.json`);
    made.push(prior);
    writeFileSync(prior, JSON.stringify([{ file: "AGENTS.md", line: 1, severity: "warning", suggestion: "fix the thing" }]));
    const res = review(["--by", "claude", "--prompt", "story", "--task", "trellis/active/GA0002.md", "--prior", prior], { root: r.root });
    assert.equal(res.status, 0, res.stderr);
    const slugDir = readdirSync(res.reviews).find((n) => !n.endsWith(".lock") && n !== "record.txt") ?? "";
    assert.ok(readFileSync(join(res.reviews, slugDir, "GA0002-story-r1.log"), "utf8").includes("fix the thing"));
    writeFileSync(prior, JSON.stringify({ findings: [] }));
    assert.equal(review(["--by", "claude", "--prompt", "story", "--task", "trellis/active/GA0002.md", "--prior", prior], { root: r.root }).status, 2);
  } finally { r.cleanup(); }
});

test("a missing prompt file fails the round with exit 3 and records it", () => {
  const r = repo();
  const empty = scratch("good-agent-no-prompts-");
  const reviews = scratch();
  try {
    const res = review(["--by", "codex", "--prompt", "story", "--task", "trellis/active/GA0002.md", "--prompts-dir", empty], { root: r.root, reviews });
    assert.equal(res.status, 3); assert.match(res.stderr, /REVIEW_ERROR.*review-story\.md/);
    assert.equal(metas(reviews)["GA0002-story-r1"].status, "REVIEW_ERROR");
    assert.ok(!res.record.includes("ARGV:exec"), "the reviewer never started");
  } finally { r.cleanup(); }
});

test("a signal to the runner kills the reviewer, fails the round and releases the lock", async () => {
  const r = repo();
  const reviews = scratch();
  try {
    const marker = join(reviews, "alive.txt");
    const env = { ...process.env, PATH: `${FAKES}:${process.env.PATH}`, GOOD_AGENT_REVIEWS: reviews, FAKE_SLEEP: "3", FAKE_TOUCH: marker };
    const child = spawn(process.execPath, [BIN, "review", "--by", "codex", "--prompt", "story", "--task", "trellis/active/GA0002.md"], { cwd: r.root, env });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    await new Promise((resolveWait) => {
      const poll = setInterval(() => { if (existsSync(join(reviews, "codex.lock"))) { clearInterval(poll); setTimeout(resolveWait, 700); } }, 50);
    });
    child.kill("SIGTERM");
    const status = await new Promise((done) => child.on("close", done));
    assert.equal(status, 3, stderr);
    assert.match(stderr, /REVIEW_ERROR: interrupted by SIGTERM/);
    assert.equal(metas(reviews)["GA0002-story-r1"].status, "REVIEW_ERROR");
    assert.ok(!existsSync(join(reviews, "codex.lock")), "lock released");
    await new Promise((done) => setTimeout(done, 3500));
    assert.ok(!existsSync(marker), "the reviewer was killed before it finished its sleep");
  } finally { r.cleanup(); }
});
