// @ts-check
/**
 * Where `good-agent review` keeps its history and locks, how it names a
 * review, and the tree digest that makes a review void when the tree moves
 * (docs/design.md section 12, GA0004).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontMatter } from "./markdown.mjs";

export class ReviewUsageError extends Error {}

/** The reviews root: GOOD_AGENT_REVIEWS or ~/.config/good-agent/reviews. */
export function reviewsRoot() {
  return process.env.GOOD_AGENT_REVIEWS ? resolve(process.env.GOOD_AGENT_REVIEWS) : join(homedir(), ".config", "good-agent", "reviews");
}

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {string | null}
 */
export function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
  } catch { return null; }
}

/**
 * Like `git`, but the output is returned untrimmed (for NUL-separated lists)
 * and a failure is an empty string.
 * @param {string} root
 * @param {string[]} args
 */
function gitRaw(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch { return ""; }
}

/**
 * The repository slug: the basename of the git common directory's parent
 * plus a short hash of its absolute path, so every worktree of one clone
 * shares a history. A directory that is not a git repository uses its own
 * path.
 * @param {string} root
 */
export function repoSlug(root) {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const base = common ? dirname(common) : resolve(root);
  return `${basename(base).replace(/[^A-Za-z0-9._-]/g, "-")}-${createHash("sha256").update(base).digest("hex").slice(0, 8)}`;
}

/**
 * The review id: from the task file (front-matter `id`, else its basename),
 * else from the branch name (the first `/`-separated segment matching
 * /^[A-Za-z]+[0-9]+$/ uppercased, else the branch with `/` replaced by `-`).
 * A detached HEAD without a task is a usage error.
 * @param {string} root
 * @param {string | undefined} taskPath
 */
export function deriveId(root, taskPath) {
  if (taskPath) {
    const text = readFileSync(resolve(root, taskPath), "utf8");
    const fm = parseFrontMatter(text);
    const id = fm && typeof fm.data.id === "string" ? fm.data.id.trim() : "";
    return safeId(id || basename(taskPath).replace(/\.[^.]+$/, ""));
  }
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") throw new ReviewUsageError("detached HEAD and no --task; pass --task <path> so the review has an id");
  for (const segment of branch.split("/")) if (/^[A-Za-z]+[0-9]+$/.test(segment)) return segment.toUpperCase();
  return safeId(branch.replace(/\//g, "-"));
}

/**
 * An id becomes part of file names, so anything outside a plain file-name
 * alphabet is replaced.
 * @param {string} id
 */
function safeId(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "") || "review";
}

/**
 * Reserve the next round for `<id>-<prompt>` by creating its .meta.json
 * exclusively, so two reviewers of one task never share a round.
 * @param {string} dir
 * @param {string} id
 * @param {string} prompt
 * @param {Record<string, unknown>} meta
 */
export function reserveRound(dir, id, prompt, meta) {
  mkdirSync(dir, { recursive: true });
  const taken = new Set(readdirSync(dir).map((n) => { const m = new RegExp(`^${escapeRe(id)}-${escapeRe(prompt)}-r(\\d+)\\.meta\\.json$`).exec(n); return m ? Number(m[1]) : 0; }));
  let round = Math.max(0, ...taken) + 1;
  for (;;) {
    const base = join(dir, `${id}-${prompt}-r${round}`);
    try {
      const fd = openSync(`${base}.meta.json`, "wx");
      writeSync(fd, `${JSON.stringify({ ...meta, id, prompt, round, reserved_at: new Date().toISOString() }, null, 2)}\n`);
      closeSync(fd);
      return { round, metaPath: `${base}.meta.json`, jsonPath: `${base}.json`, logPath: `${base}.log` };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      round += 1;
    }
  }
}

/** @param {string} s */
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** @param {number} pid */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM"; }
}

/**
 * One review at a time per reviewer, across repositories. The lock records
 * pid, host and start time; a lock whose pid is not alive on this host is
 * taken over, and so is an unreadable one that is more than a few seconds
 * old (a crash between creating and filling it). A takeover goes through a
 * guard file created exclusively and re-reads the lock first, so two
 * waiters never delete a lock the other has just taken. Waiting counts
 * against the caller's timeout.
 * @param {string} root  the reviews root
 * @param {string} reviewer
 * @param {{ wait: boolean, deadline: number }} options
 * @returns {Promise<() => void>}  release
 */
export async function acquireLock(root, reviewer, options) {
  mkdirSync(root, { recursive: true });
  const path = join(root, `${reviewer}.lock`);
  const guard = `${path}.takeover`;
  /** @returns {{ pid?: number, host?: string, started?: string } | null} */
  const readHolder = () => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  /** @param {string} file */
  const ageMs = (file) => { try { return Date.now() - statSync(file).mtimeMs; } catch { return 0; } };
  /** @param {ReturnType<typeof readHolder>} holder */
  const stale = (holder) => holder === null ? ageMs(path) > 5000 : holder.host === hostname() && typeof holder.pid === "number" && !pidAlive(holder.pid);
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString() })}\n`);
      closeSync(fd);
      return () => { if (readHolder()?.pid === process.pid) { try { unlinkSync(path); } catch { /* already gone */ } } };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    }
    const holder = readHolder();
    if (stale(holder)) {
      try {
        closeSync(openSync(guard, "wx"));
        try {
          const again = readHolder();
          if (stale(again) && again?.pid === holder?.pid && again?.started === holder?.started) unlinkSync(path);
        } finally { try { unlinkSync(guard); } catch { /* gone */ } }
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST" && ageMs(guard) > 30_000) { try { unlinkSync(guard); } catch { /* raced */ } }
        else if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST" && /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
      }
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    if (holder === null) { await new Promise((r) => setTimeout(r, 100)); continue; }
    if (!options.wait) throw new ReviewUsageError(`another ${reviewer} review is running (pid ${holder.pid} on ${holder.host}); wait for it or pass --no-wait to fail fast`);
    if (Date.now() > options.deadline) throw new Error(`timed out waiting for the ${reviewer} lock held by pid ${holder.pid} on ${holder.host}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * `git write-tree`, retried briefly: it needs the index lock, which another
 * git command (the reviewer's own `git status`, a second review of the same
 * clone) may hold for a moment. A failure that persists, such as an index
 * with unmerged entries, is the same before and after and so harmless.
 * @param {string} root
 * @returns {string | null}
 */
function writeTree(root) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tree = git(root, ["write-tree"]);
    if (tree !== null) return tree;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return null;
}

/**
 * A digest of the repository state a review must not change. Each part is
 * delimited by a NUL and carries a label: `git rev-parse HEAD` (or "none"),
 * `git write-tree` for the index (or "none" when the directory is not a git
 * repository or the index cannot be written), the porcelain status, and then
 * the path and content hash of every file in `git ls-files -co
 * --exclude-standard` that still exists. HEAD and the index are in the digest
 * so an empty commit or a staged change that leaves the status unchanged
 * still voids a round; the status part covers deletions and the content part
 * covers edits and additions. A symlink contributes its target path, not the
 * content it points at.
 * @param {string} root
 */
export function treeDigest(root) {
  const hash = createHash("sha256");
  /** @param {string} label @param {string | Buffer} value */
  const part = (label, value) => { hash.update(label); hash.update("\0"); hash.update(value); hash.update("\0"); };
  const inRepo = git(root, ["rev-parse", "--git-dir"]) !== null;
  part("head", git(root, ["rev-parse", "HEAD"]) ?? "none");
  part("index", (inRepo ? writeTree(root) : null) ?? "none");
  part("status", git(root, ["status", "--porcelain=v1", "-z"]) ?? "none");
  const listed = inRepo ? gitRaw(root, ["ls-files", "-co", "--exclude-standard", "-z"]) : "";
  for (const rel of listed.split("\0").filter(Boolean).sort()) {
    const abs = join(root, rel);
    /** @type {Buffer | null} */
    let content = null;
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) content = Buffer.from(`symlink:${readlinkSync(abs)}`);
      else if (st.isFile()) content = readFileSync(abs);
    } catch { /* gone since the listing */ }
    if (content === null) continue;
    part("file", rel);
    part("content", createHash("sha256").update(content).digest());
  }
  return hash.digest("hex");
}

/**
 * @param {string} path
 * @param {unknown} value
 */
export function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** @param {string} path */
export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {string} path */
export function fileExists(path) { return existsSync(path); }
