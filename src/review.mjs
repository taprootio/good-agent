// @ts-check
/**
 * `good-agent review`: spawn a fresh, read-only review of a story, plan,
 * design or diff by Codex or Claude Code, validate the findings against
 * schema/findings.json, record the round outside the tree, and return the
 * findings (docs/design.md section 12; docs/review-runner.md).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config.mjs";
import { RULE_IDS } from "./rules/index.mjs";
import { VERSION } from "./engine.mjs";
import { ReviewUsageError, acquireLock, deriveId, git, insideWorkTree, repoSlug, reserveRound, reviewsRoot, topLevel, treeDigest, writeJson } from "./review-store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PROMPTS_DIR = join(here, "..", "skill", "review-loop", "references");
export const SCHEMA_PATH = join(here, "..", "schema", "findings.json");
export const PROMPTS = /** @type {const} */ (["diff", "story", "plan", "design"]);
export const REVIEWERS = /** @type {const} */ (["codex", "claude"]);
export const EXIT = { clean: 0, findings: 1, usage: 2, unsafe: 3 };

/** Minimum CLI versions the flag sets below were verified against (2026-11-01). */
export const MIN_VERSIONS = { codex: "0.156.0", claude: "2.1.300" };

/** Codex features that run outside the sandbox with the owner's authority. */
export const CODEX_DISABLED_FEATURES = [
  "hooks", "plugins", "apps", "remote_plugin", "computer_use",
  "browser_use", "browser_use_external", "in_app_browser", "skill_mcp_dependency_install",
];
export const CLAUDE_ALLOWED = ["Read", "Grep", "Glob"];
export const CLAUDE_DENIED = ["Edit", "Write", "NotebookEdit", "Agent"];
const SEVERITIES = new Set(["blocker", "warning", "nit"]);
const TOOL_NAMES = { codex: "Codex", claude: "Claude Code" };

/** @typedef {{ file: string, line: number, severity: string, suggestion: string }} Finding */
/** @typedef {Record<string, string | undefined>} Env */

/**
 * Validate the wrapper object and every item, then unwrap to the bare array.
 * Hand-written to say exactly what schema/findings.json says.
 * @param {unknown} value
 * @returns {Finding[]}
 */
export function validateFindings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reviewer output is not an object");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "findings") throw new Error(`reviewer output must have exactly one key, "findings" (got ${keys.join(", ") || "none"})`);
  const findings = /** @type {{ findings: unknown }} */ (value).findings;
  if (!Array.isArray(findings)) throw new Error("reviewer output .findings is not an array");
  return findings.map((f, i) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error(`finding ${i} is not an object`);
    const o = /** @type {Record<string, unknown>} */ (f);
    const extra = Object.keys(o).filter((k) => !["file", "line", "severity", "suggestion"].includes(k));
    if (extra.length) throw new Error(`finding ${i} has unexpected keys: ${extra.join(", ")}`);
    if (typeof o.file !== "string" || o.file === "") throw new Error(`finding ${i}: file must be a non-empty string`);
    if (!Number.isInteger(o.line) || /** @type {number} */ (o.line) < 1) throw new Error(`finding ${i}: line must be a positive integer`);
    if (typeof o.severity !== "string" || !SEVERITIES.has(o.severity)) throw new Error(`finding ${i}: severity must be blocker, warning or nit`);
    if (typeof o.suggestion !== "string" || o.suggestion === "") throw new Error(`finding ${i}: suggestion must be a non-empty string`);
    return { file: o.file, line: /** @type {number} */ (o.line), severity: o.severity, suggestion: o.suggestion };
  });
}

/**
 * The prompt body and the runner ending from a references/review-*.md file,
 * as the review-loop skill's "Building a prompt" section describes: the body
 * is the text before the first `<!-- ENDING:` marker without its leading
 * `# ` title line; the runner ending is the text of the `runner` section
 * without its marker comments.
 * @param {string} prompt
 * @param {string} [promptsDir]
 */
export function loadPrompt(prompt, promptsDir = PROMPTS_DIR) {
  const text = readFileSync(join(promptsDir, `review-${prompt}.md`), "utf8").replace(/\r\n/g, "\n");
  const first = text.indexOf("<!-- ENDING:");
  if (first < 0) throw new Error(`review-${prompt}.md has no endings`);
  const body = text.slice(0, first).replace(/^# .*\n+/, "").trimEnd();
  const m = /<!-- ENDING: runner -->\n([\s\S]*?)\n<!-- END ENDING -->/.exec(text);
  if (!m) throw new Error(`review-${prompt}.md has no runner ending`);
  return { body, ending: m[1].trim() };
}

/**
 * Fill the placeholders in one pass (so inserted text is never re-expanded)
 * and append the runner ending.
 * @param {string} prompt
 * @param {Record<string, string>} values  keyed by placeholder name
 * @param {string} [promptsDir]
 */
export function assemblePrompt(prompt, values, promptsDir) {
  const { body, ending } = loadPrompt(prompt, promptsDir);
  const filled = body.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`review-${prompt}.md uses an unknown placeholder {{${key}}}`);
    return values[key];
  }).replace(/\n{3,}/g, "\n\n");
  return `${filled}\n\n${ending}\n`;
}

/**
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} p.root
 * @param {string} p.taskLabel  the task path (or the review id when no task was given)
 * @param {string | null} p.baseSha
 * @param {string | undefined} p.author
 * @param {string[]} p.verified
 * @param {Finding[] | null} p.prior
 * @param {string} [p.promptsDir]
 */
export function buildPrompt(p) {
  const head = git(p.root, ["rev-parse", "HEAD"]) ?? "(not a git repository)";
  let changed = "(no base given)";
  if (p.baseSha) {
    const top = topLevel(p.root);
    const status = git(top, ["diff", "--name-status", p.baseSha]) ?? "";
    const untracked = (git(top, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").filter(Boolean).map((f) => `?\t${f}`);
    changed = [status, ...untracked].filter(Boolean).join("\n") || "(none)";
  }
  const authorContext = p.author
    ? `The change was authored by ${TOOL_NAMES[/** @type {"codex" | "claude"} */ (p.author)]} and its internal review is clean.`
    : "The change was authored by another AI tool and its internal review is clean.";
  const prior = p.prior && p.prior.length > 0
    ? `Findings from the previous round (confirm each is resolved, report any that is not, then review the whole subject again):\n${JSON.stringify(p.prior, null, 2)}`
    : "";
  return assemblePrompt(p.prompt, {
    TASK: p.taskLabel,
    BASE: p.baseSha ?? "(none)",
    HEAD: head,
    VERIFIED: p.verified.length ? p.verified.map((v) => `- ${v}`).join("\n") : "- (none stated)",
    CHANGED: changed,
    PRIOR: prior,
    BASE_CLAUSE: p.baseSha ? ` and the diff since ${p.baseSha}` : "",
    AUTHOR_CONTEXT: authorContext,
  }, p.promptsDir);
}

/** @param {string} out */
function parseVersion(out) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** @param {string} a @param {string} b */
function versionLess(a, b) {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** Every credential and provider switch removed for both reviewers, whichever one runs. */
export const STRIPPED_ENVIRONMENT = [
  "CODEX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
];

/**
 * The environment every reviewer process sees: no API keys or provider
 * switches for either tool, so the review uses the subscription login and
 * never bills an API.
 * @param {string} reviewer
 * @returns {Env}
 */
export function reviewEnvironment(reviewer) {
  void reviewer;
  const env = { ...process.env };
  for (const k of STRIPPED_ENVIRONMENT) delete env[k];
  return env;
}

export const BUDGET_EXHAUSTED = "timeout budget exhausted before the review started";

/**
 * The timeout for one setup call: 30 seconds or what is left of the run's
 * budget, whichever is less. No budget left is an error, never a floor.
 * @param {number} deadline
 */
function setupTimeout(deadline) {
  const left = deadline - Date.now();
  if (left <= 0) throw new Error(BUDGET_EXHAUSTED);
  return Math.min(30_000, left);
}

/**
 * @param {string} reviewer
 * @param {Env} env
 * @param {number} deadline
 */
function checkVersion(reviewer, env, deadline) {
  const r = spawnSync(reviewer, ["--version"], { encoding: "utf8", env, timeout: setupTimeout(deadline), killSignal: "SIGKILL" });
  if (r.error && /** @type {NodeJS.ErrnoException} */ (r.error).code === "ETIMEDOUT" && deadline - Date.now() <= 100) throw new Error(BUDGET_EXHAUSTED);
  if (r.error || r.status !== 0) throw new Error(`${reviewer} --version failed (${r.error?.message ?? `exit ${r.status}`}); is ${reviewer} installed and on PATH?`);
  const out = `${r.stdout}${r.stderr}`.trim();
  const min = MIN_VERSIONS[/** @type {"codex" | "claude"} */ (reviewer)];
  if (versionLess(out, min)) throw new Error(`${reviewer} ${out} is older than ${min}, the version these flags were verified against; upgrade it`);
  return out;
}

/**
 * The `-c` overrides that keep a Codex review inside the sandbox: features
 * off, and every MCP server Codex would load switched off by name and
 * re-listed to confirm. Listed from the reviewed tree, so a project
 * `.codex/config.toml` is seen. It fails closed: a server counts as enabled
 * unless the listing says `enabled: false`, in both listings.
 * @param {string} root
 * @param {Env} env
 * @param {number} [deadline]  the run's deadline; each listing gets 30 seconds or what is left
 */
export function codexIsolation(root, env, deadline = Date.now() + 10 * 60_000) {
  const overrides = CODEX_DISABLED_FEATURES.flatMap((f) => ["-c", `features.${f}=false`]);
  /** @param {string[]} extra */
  const list = (extra) => {
    const r = spawnSync("codex", ["mcp", "list", "--json", ...extra], { cwd: root, encoding: "utf8", env, timeout: setupTimeout(deadline), killSignal: "SIGKILL" });
    if (r.error && /** @type {NodeJS.ErrnoException} */ (r.error).code === "ETIMEDOUT" && deadline - Date.now() <= 100) throw new Error(BUDGET_EXHAUSTED);
    if (r.error || r.status !== 0) throw new Error(`codex mcp list --json failed (${r.error?.message ?? `exit ${r.status}`}): ${(r.stderr || "").trim().slice(0, 300)}`);
    const servers = JSON.parse(r.stdout);
    if (!Array.isArray(servers)) throw new Error("codex mcp list --json did not return an array");
    return /** @type {{ name?: unknown, enabled?: unknown }[]} */ (servers);
  };
  for (const s of list(overrides)) {
    if (s?.enabled === false) continue;
    if (typeof s?.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(s.name)) throw new Error(`MCP server ${JSON.stringify(s?.name)} cannot be switched off by a -c override; rename or remove it in the Codex config`);
    overrides.push("-c", `mcp_servers.${s.name}.enabled=false`);
  }
  const still = list(overrides).filter((s) => s?.enabled !== false).map((s) => String(s?.name));
  if (still.length) throw new Error(`MCP servers still enabled for a review: ${still.join(", ")}`);
  return overrides;
}

/**
 * Catches SIGINT, SIGTERM and SIGHUP from lock acquisition until the review
 * is over, so every exit path kills the reviewer's process group, records
 * the round and releases the lock instead of dying with the lock held.
 * @returns {{ signal: string | null, kill: (() => void) | null, dispose: () => void }}
 */
function trapSignals() {
  const names = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);
  const trap = {
    signal: /** @type {string | null} */ (null),
    kill: /** @type {(() => void) | null} */ (null),
    dispose: () => { for (const n of names) process.off(n, handler); },
  };
  /** @param {string} name */
  function handler(name) { trap.signal ??= name; trap.kill?.(); }
  for (const n of names) process.on(n, handler);
  return trap;
}

/**
 * A fingerprint of the task file the review is about: its real path and
 * content. The tree digest does not cover an ignored file, so the subject is
 * checked on its own. Null when unreadable.
 * @param {string} path
 */
function taskFingerprint(path) {
  try {
    const real = realpathSync(path);
    return createHash("sha256").update(real).update("\0").update(readFileSync(real)).digest("hex");
  } catch { return null; }
}

/**
 * Whether anything is left in a process group. The test-only override
 * (honoured only inside a `node --test` process) reports the group alive
 * forever, to exercise the survived-SIGKILL path that cannot be made on demand.
 * @param {number} pgid
 */
function groupAlive(pgid) {
  if (process.env.GOOD_AGENT_TEST_GROUP_ALIVE && process.env.NODE_TEST_CONTEXT) return true;
  try { process.kill(-pgid, 0); return true; } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM"; }
}

/**
 * Terminate everything left in a reviewer's process group: SIGTERM, wait up
 * to two seconds for the group to empty, then SIGKILL and wait for it to go.
 * @param {number | undefined} pgid
 * @returns {Promise<boolean>}  false when the group is still alive after SIGKILL
 */
async function reapGroup(pgid) {
  if (!pgid || process.platform === "win32" || !groupAlive(pgid)) return true;
  /** @param {number} ms */
  const until = async (ms) => { const end = Date.now() + ms; while (groupAlive(pgid) && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); };
  try { process.kill(-pgid, "SIGTERM"); } catch { /* gone */ }
  await until(2000);
  if (!groupAlive(pgid)) return true;
  try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
  await until(2000);
  return !groupAlive(pgid);
}

/**
 * Test-only: with GOOD_AGENT_TEST_PAUSE=<dir> (honoured only inside a
 * `node --test` process), write <dir>/paused and block until <dir>/resume
 * exists, so a test can kill the runner between spawning the gate and
 * recording its group in the lock.
 */
function pauseForTest() {
  const dir = process.env.GOOD_AGENT_TEST_PAUSE;
  if (!dir || !process.env.NODE_TEST_CONTEXT) return;
  writeFileSync(join(dir, "paused"), "");
  for (let i = 0; i < 1500 && !existsSync(join(dir, "resume")); i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

/**
 * The start gate: a shell that waits on stdin for a line `go` before it
 * `exec`s the reviewer, and exits without running anything on end of file or
 * anything else. The exec keeps the pid and process group, so the group id
 * recorded in the lock while the gate waits is the reviewer's.
 */
const GATE = 'IFS= read -r go || exit 0; [ "$go" = go ] || exit 0; exec "$@"';

/**
 * Run the reviewer in its own process group so a timeout or a signal kills
 * everything it started, not only the direct child. The reviewer does not
 * start (and is not given its prompt) until `onSpawn` has recorded the group
 * id and returned: it is spawned behind a start gate, so a runner that dies
 * before the lock names the group leaves nothing running. `onSpawn` receives
 * the group id (the child's pid).
 * @param {string} command
 * @param {string[]} argv
 * @param {{ cwd: string, env: Env, input: string, timeoutMs: number, trap: ReturnType<typeof trapSignals>, onSpawn: (pgid: number) => void }} o
 * @returns {Promise<{ status: number | null, signal: string | null, stdout: string, stderr: string, error: Error | null, timedOut: boolean, interrupted: string | null, survivor: number | null }>}
 */
export function runChild(command, argv, o) {
  return new Promise((done) => {
    const result = { status: /** @type {number | null} */ (null), signal: /** @type {string | null} */ (null), stdout: "", stderr: "", error: /** @type {Error | null} */ (null), timedOut: false, interrupted: /** @type {string | null} */ (null), survivor: /** @type {number | null} */ (null) };
    if (o.trap.signal) { result.interrupted = o.trap.signal; done(result); return; }
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    const gated = process.platform !== "win32";
    try {
      child = gated
        ? spawn("sh", ["-c", GATE, "sh", command, ...argv], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true })
        : spawn(command, argv, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: false });
    } catch (error) { result.error = /** @type {Error} */ (error); done(result); return; }
    const killGroup = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    };
    let finished = false;
    let reaped = false;
    let closed = false;
    /** @type {NodeJS.Timeout | undefined} */
    let grace;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); if (grace) clearTimeout(grace);
      o.trap.kill = null;
      result.interrupted = o.trap.signal;
      done(result);
    };
    const timer = setTimeout(() => { result.timedOut = true; killGroup(); }, o.timeoutMs);
    o.trap.kill = killGroup;
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => { result.stdout += d; });
    child.stderr?.on("data", (d) => { result.stderr += d; });
    child.stdin?.on("error", () => { /* the child exited before reading its prompt */ });
    child.on("error", (error) => { result.error = error; finish(); });
    // When the direct child exits, whatever it left running in the group is
    // terminated (SIGTERM, up to two seconds, then SIGKILL) and reaped before
    // the result resolves, so the caller releases the lock only once nothing
    // of the review is still running.
    child.on("exit", (status, signal) => {
      result.status = status; result.signal = signal;
      reapGroup(child.pid).then((gone) => { if (!gone) result.survivor = child.pid ?? null; reaped = true; if (closed) finish(); else grace = setTimeout(finish, 2000); });
    });
    child.on("close", () => { closed = true; if (reaped) finish(); });
    // Only now, with every handler installed, record the reviewer's group. If
    // that fails the review cannot be tracked: close the gate without `go`
    // (the reviewer never starts), kill the group and let the exit path reap
    // it and clear the timer before the result resolves.
    let recorded = true;
    if (child.pid) {
      try {
        pauseForTest();
        o.onSpawn(child.pid);
      } catch (error) {
        recorded = false;
        result.error = new Error(`could not record the reviewer's process group in the lock: ${error instanceof Error ? error.message : String(error)}`);
        killGroup();
      }
    }
    if (recorded) child.stdin?.end(gated ? `go\n${o.input}` : o.input);
    else child.stdin?.end();
    if (o.trap.signal) killGroup();
  });
}

/**
 * A path with symlinks resolved as far as it exists (the reviews directory
 * may not have been created yet).
 * @param {string} path
 * @returns {string}
 */
function realPath(path) {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

/**
 * Whether `child` is `parent` or below it. A relative path leaves the parent
 * only when it is `..` or starts with `..` and a separator, so a sibling
 * named `..reviews` is inside.
 * @param {string} parent
 * @param {string} child
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** 35791 minutes is the largest whole number that fits setTimeout's 2^31-1 milliseconds. */
export const MAX_TIMEOUT_MINUTES = 35791;

const FLAG_REJECTED = /unexpected argument|unknown option|unrecognized (option|argument)|invalid value|unknown flag|missing required/i;

/**
 * @param {string[]} args
 * @param {(s: string) => void} out
 * @param {(s: string) => void} err
 * @returns {Promise<number>}
 */
export async function runReview(args, out, err) {
  try {
    return await review(args, out, err);
  } catch (error) {
    if (error instanceof ReviewUsageError || error instanceof ConfigError) { err(`good-agent: ${error.message}`); return EXIT.usage; }
    if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) { err(`good-agent: ${error.message}`); return EXIT.usage; }
    err(`good-agent: REVIEW_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.unsafe;
  }
}

/**
 * @param {string[]} args
 * @param {(s: string) => void} out
 * @param {(s: string) => void} err
 * @returns {Promise<number>}
 */
async function review(args, out, err) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      by: { type: "string" }, author: { type: "string" }, prompt: { type: "string", default: "diff" },
      base: { type: "string" }, task: { type: "string" }, prior: { type: "string" },
      verified: { type: "string", multiple: true, default: [] },
      model: { type: "string" }, effort: { type: "string" },
      "timeout-minutes": { type: "string", default: "45" },
      "no-wait": { type: "boolean", default: false }, json: { type: "boolean", default: false },
      cwd: { type: "string" }, config: { type: "string" },
      // Hidden: the opt-in live probe (scripts/live-denial.mjs) swaps in its own prompt files.
      "prompts-dir": { type: "string" },
    },
  });

  // Everything below up to the version check is usage and config: exit 2, no reviewer runs.
  for (const [flag, value] of Object.entries(values)) {
    if (value === "" || (Array.isArray(value) && value.some((v) => v === ""))) throw new ReviewUsageError(`--${flag} must not be empty`);
  }
  const root = resolve(values.cwd ?? process.cwd());
  try { if (!statSync(root).isDirectory()) throw new Error("not a directory"); } catch { throw new ReviewUsageError(`${root} is not a directory`); }
  if (!insideWorkTree(root)) throw new ReviewUsageError(`good-agent review needs a git working tree; ${root} is not inside one`);
  const { config } = loadConfig(root, { explicitPath: values.config, knownRuleIds: RULE_IDS });
  const prompt = /** @type {string} */ (values.prompt);
  if (!PROMPTS.includes(/** @type {any} */ (prompt))) throw new ReviewUsageError(`--prompt must be one of ${PROMPTS.join(", ")}`);
  if (values.by && !REVIEWERS.includes(/** @type {any} */ (values.by))) throw new ReviewUsageError("--by must be codex or claude");
  if (values.author && !REVIEWERS.includes(/** @type {any} */ (values.author))) throw new ReviewUsageError("--author must be codex or claude");
  const reviewer = /** @type {"codex" | "claude" | undefined} */ (values.by ?? (values.author ? config.review.externalReviewer[values.author] : undefined));
  if (!reviewer) throw new ReviewUsageError("pass --by codex|claude, or --author codex|claude so review.externalReviewer in good-agent.config.json can pick the reviewer");
  if (prompt === "diff" && !values.base) throw new ReviewUsageError("--prompt diff requires --base <ref>");
  if (prompt !== "diff" && !values.task) throw new ReviewUsageError(`--prompt ${prompt} requires --task <path>`);
  const taskAbs = values.task ? resolve(root, values.task) : null;
  if (taskAbs) {
    let isFile = false;
    try { isFile = statSync(taskAbs).isFile(); } catch { /* missing */ }
    if (!isFile) throw new ReviewUsageError(`task file not found: ${values.task}`);
  }
  // The prompt names the task by a repo-relative path and the digest must be
  // able to vouch for it, so its real path (symlinks resolved) has to be inside
  // the working tree.
  const top = realPath(topLevel(root));
  const taskReal = taskAbs ? realpathSync(taskAbs) : null;
  if (taskReal && !isInside(top, taskReal)) {
    throw new ReviewUsageError(`task file ${values.task} resolves to ${taskReal}, outside the repository at ${top}; the review prompt names it by a repo-relative path`);
  }
  if (prompt === "plan" && taskAbs && !/^## Plan\s*$/m.test(readFileSync(taskAbs, "utf8"))) {
    throw new ReviewUsageError(`${values.task} has no "## Plan" section; the work-task skill writes it before asking for plan review`);
  }
  /** @type {string | null} */
  let baseSha = null;
  if (values.base) {
    baseSha = git(root, ["rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`]);
    if (baseSha === null) throw new ReviewUsageError(`--base ${values.base} is not a commit in this repository`);
  }
  const timeoutMinutes = Number(values["timeout-minutes"]);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new ReviewUsageError("--timeout-minutes must be a positive number");
  if (timeoutMinutes > MAX_TIMEOUT_MINUTES) throw new ReviewUsageError(`--timeout-minutes must be at most ${MAX_TIMEOUT_MINUTES} (the longest timer Node can set)`);
  for (const v of values.verified) {
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new ReviewUsageError("--verified must not contain control characters such as a newline; pass one command per --verified");
  }
  /** @type {Finding[] | null} */
  let prior = null;
  if (values.prior) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(resolve(root, values.prior), "utf8")); } catch (error) { throw new ReviewUsageError(`--prior ${values.prior} is not readable JSON: ${/** @type {Error} */ (error).message}`); }
    if (!Array.isArray(parsed)) throw new ReviewUsageError("--prior must be a JSON array of findings");
    try { prior = validateFindings({ findings: parsed }); } catch (error) { throw new ReviewUsageError(`--prior is not a findings array: ${/** @type {Error} */ (error).message}`); }
  }
  const toolConfig = config.review[reviewer];
  const model = values.model ?? toolConfig.model ?? undefined;
  const effort = values.effort ?? toolConfig.effort;
  for (const [flag, value] of [["--model", model], ["--effort", effort]]) {
    if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value)) throw new ReviewUsageError(`${flag} "${value}" contains characters a model or effort name does not use`);
  }
  const reviews = reviewsRoot();
  if (isInside(realPath(topLevel(root)), realPath(reviews))) {
    throw new ReviewUsageError(`the reviews directory ${reviews} is inside the repository being reviewed, which would void every round; set GOOD_AGENT_REVIEWS to a directory outside it`);
  }
  const id = deriveId(root, values.task);
  const promptsDir = values["prompts-dir"] ? resolve(values["prompts-dir"]) : undefined;
  const taskLabel = taskReal ? relative(top, taskReal).split(sep).join("/") : id;

  // From here on the reviewer's own CLI is involved.
  const deadline = Date.now() + timeoutMinutes * 60_000;
  const env = reviewEnvironment(reviewer);
  const cliVersion = checkVersion(reviewer, env, deadline);
  const trap = trapSignals();
  /** @type {Awaited<ReturnType<typeof acquireLock>> | null} */
  let lock = null;
  /** @type {string | null} */
  let tmp = null;
  // Set when the reviewer's process group outlived SIGKILL: the lock stays,
  // with its recorded pgid, and acquireLock frees it once the group is gone.
  let retainLock = false;
  try {
    lock = await acquireLock(reviews, reviewer, { wait: !values["no-wait"], deadline, aborted: () => trap.signal });
    const dir = join(reviews, repoSlug(root));
    const meta = {
      version: VERSION, reviewer, author: values.author ?? null, model: model ?? null, effort, cli: cliVersion, root,
      base: values.base ?? null, base_sha: baseSha, head: git(root, ["rev-parse", "HEAD"]), task: values.task ?? null, verified: values.verified, attempt: 1,
    };
    const round = reserveRound(dir, id, prompt, meta);
    const name = `${id}-${prompt}-r${round.round}`;
    const started = Date.now();
    const base = { ...meta, id, prompt, round: round.round, started: new Date(started).toISOString() };
    let logText = "";
    /** @type {string | null} */
    let digestBefore = null;
    /** @type {string | null} */
    let digestAfter = null;
    /** @type {string | null} */
    let taskBefore = null;
    /** @type {string | null} */
    let taskAfter = null;
    /** @type {{ status: number | null, timedOut: boolean }} */
    let ran = { status: null, timedOut: false };
    /**
     * Record a failed or unsafe round: its number stays taken, its meta says why.
     * @param {"REVIEW_ERROR" | "REVIEW_UNSAFE"} status
     * @param {string} message
     */
    const fail = (status, message) => {
      writeFileSync(round.logPath, `${logText}\n--- ${status} ---\n${message}\n`);
      writeJson(round.metaPath, { ...base, status, error: message, digest_before: digestBefore, digest_after: digestAfter, task_digest_before: taskBefore, task_digest_after: taskAfter, tree_stable: digestBefore !== null && digestAfter !== null ? digestBefore === digestAfter : null, exit_code: ran.status, timed_out: ran.timedOut, seconds: Math.round((Date.now() - started) / 1000) });
      err(`good-agent: ${status}: ${message} (round ${name}; log: ${round.logPath})`);
      return EXIT.unsafe;
    };
    try {
      digestBefore = treeDigest(root);
      if (taskAbs) {
        taskBefore = taskFingerprint(taskAbs);
        if (taskBefore === null) return fail("REVIEW_ERROR", `the task file ${values.task} cannot be read`);
      }
      if (trap.signal) return fail("REVIEW_ERROR", `interrupted by ${trap.signal} before the reviewer started`);
      if (Date.now() >= deadline) return fail("REVIEW_ERROR", BUDGET_EXHAUSTED);
      const promptText = buildPrompt({ prompt, root, taskLabel, baseSha, author: values.author, verified: values.verified, prior, promptsDir });
      tmp = mkdtempSync(join(tmpdir(), "good-agent-review-"));
      const outFile = join(tmp, "codex-output-attempt1.json");
      const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
      /** @type {string[]} */
      let argv;
      if (reviewer === "codex") {
        const isolation = codexIsolation(top, env, deadline);
        argv = ["exec", "-C", top, "--sandbox", "read-only", "-c", 'approval_policy="never"', "-c", "notify=[]", "--ignore-rules", ...isolation,
          ...(model ? ["-m", model] : []), "-c", `model_reasoning_effort="${effort}"`, "--ephemeral", "--color", "never", "--output-schema", SCHEMA_PATH, "-o", outFile, "-"];
      } else {
        const settings = join(tmp, "settings.json");
        writeFileSync(settings, JSON.stringify({ disableAllHooks: true, enabledPlugins: {}, permissions: { allow: CLAUDE_ALLOWED, deny: CLAUDE_DENIED, defaultMode: "dontAsk" } }));
        const { $schema, ...claudeSchema } = schema;
        void $schema;
        argv = ["-p", "--no-session-persistence", ...(model ? ["--model", model] : []), "--effort", effort, "--json-schema", JSON.stringify(claudeSchema), "--output-format", "json",
          "--safe-mode", "--setting-sources", "", "--settings", settings, "--permission-mode", "dontAsk", "--tools", "Read", "Grep", "Glob", "Bash",
          "--allowedTools", ...CLAUDE_ALLOWED, "--disallowedTools", ...CLAUDE_DENIED, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome", "--disable-slash-commands"];
      }
      if (trap.signal) return fail("REVIEW_ERROR", `interrupted by ${trap.signal} before the reviewer started`);
      if (Date.now() >= deadline) return fail("REVIEW_ERROR", BUDGET_EXHAUSTED);
      const result = await runChild(reviewer, argv, { cwd: top, env, input: promptText, timeoutMs: deadline - Date.now(), trap, onSpawn: (pgid) => lock?.setChild(pgid) });
      // Before anything that can throw: a group that outlived SIGKILL keeps the lock.
      if (result.survivor) retainLock = true;
      digestAfter = treeDigest(root);
      if (taskAbs) taskAfter = taskFingerprint(taskAbs);
      ran = { status: result.status, timedOut: result.timedOut };
      logText = `$ ${reviewer} ${argv.map((a) => (a === "" || /\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n\n--- prompt ---\n${promptText}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`;
      if (result.survivor) {
        retainLock = true;
        return fail("REVIEW_ERROR", `reviewer process group ${result.survivor} survived SIGKILL; the lock is retained until it exits`);
      }
      if (digestBefore !== digestAfter) return fail("REVIEW_UNSAFE", "the tree changed during the review; the result is void, refile the round");
      if (taskAbs && taskBefore !== taskAfter) return fail("REVIEW_UNSAFE", `the task file ${values.task} ${taskAfter === null ? "became unreadable" : "changed"} during the review; the result is void, refile the round`);
      if (result.interrupted) return fail("REVIEW_ERROR", `interrupted by ${result.interrupted}; ${reviewer} was killed`);
      if (result.timedOut) return fail("REVIEW_ERROR", `${reviewer} exceeded ${timeoutMinutes} minutes and was killed`);
      if (result.error) return fail("REVIEW_ERROR", `${reviewer} could not be started: ${result.error.message}`);
      if (result.status !== 0) {
        const rejectedLine = result.stderr.split("\n").find((l) => FLAG_REJECTED.test(l));
        const rejected = rejectedLine ? ` (a flag was rejected: ${rejectedLine.trim()})` : "";
        return fail("REVIEW_ERROR", `${reviewer} exited ${result.status ?? `on ${result.signal}`}${rejected}`);
      }
      /** @type {unknown} */
      let output;
      try {
        if (reviewer === "codex") {
          if (!existsSync(outFile)) return fail("REVIEW_ERROR", "codex exec produced no output file");
          output = JSON.parse(readFileSync(outFile, "utf8"));
        } else {
          const envelope = JSON.parse(result.stdout);
          if (!envelope || envelope.type !== "result" || envelope.subtype !== "success" || envelope.is_error !== false) return fail("REVIEW_ERROR", "claude returned an unsuccessful result envelope");
          output = envelope.structured_output;
        }
      } catch (error) { return fail("REVIEW_ERROR", `reviewer output is not JSON: ${/** @type {Error} */ (error).message}`); }
      /** @type {Finding[]} */
      let findings;
      try { findings = validateFindings(output); } catch (error) { return fail("REVIEW_ERROR", /** @type {Error} */ (error).message); }
      writeFileSync(round.logPath, logText);
      writeJson(round.jsonPath, findings);
      writeJson(round.metaPath, { ...base, status: "ok", digest_before: digestBefore, digest_after: digestAfter, task_digest_before: taskBefore, task_digest_after: taskAfter, tree_stable: true, exit_code: 0, timed_out: false, seconds: Math.round((Date.now() - started) / 1000), finding_count: findings.length });
      if (values.json) out(JSON.stringify(findings, null, 2));
      else {
        out(`good-agent review ${name} by ${reviewer} (${model ? `${model}, ` : ""}${effort})`);
        for (const f of findings) { out(`${f.file}:${f.line}  ${f.severity}`); out(`  ${f.suggestion}`); }
        out(`${findings.length} finding${findings.length === 1 ? "" : "s"} (history: ${round.jsonPath})`);
      }
      return findings.length === 0 ? EXIT.clean : EXIT.findings;
    } catch (error) {
      return fail("REVIEW_ERROR", error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (!retainLock) lock?.release();
    trap.dispose();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
