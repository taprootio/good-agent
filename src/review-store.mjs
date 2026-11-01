// @ts-check
/**
 * Where `good-agent review` keeps its history and locks, how it names a
 * review, and the tree digest that makes a review void when the tree moves
 * (docs/design.md section 12, GA0004).
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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
 * Whether `root` is inside a git working tree.
 * @param {string} root
 */
export function insideWorkTree(root) {
  return git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/**
 * The top of the working tree that contains `root` (`git rev-parse
 * --show-toplevel`). Digests and the reviews-inside-the-tree check use it,
 * so running from a subdirectory does not shrink what they cover. Outside a
 * git working tree it throws: there is nothing a digest could compare.
 * @param {string} root
 */
export function topLevel(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error(`good-agent review needs a git working tree; ${resolve(root)} is not inside one`);
  return top;
}

/**
 * Run git and throw on any failure, with the NUL-separated output untrimmed.
 * @param {string} root
 * @param {string[]} args
 */
function gitStrict(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`the tree cannot be fingerprinted (git ${args.slice(0, 2).join(" ")} failed: ${/** @type {Error} */ (error).message.split("\n")[0]})`);
  }
}

/**
 * The repository slug: a readable name plus a short hash of the absolute git
 * common directory itself, so every worktree of one clone shares a history
 * and two submodules of one superproject (whose common directories sit side
 * by side under `.git/modules/`) do not. The name is the main worktree's
 * directory for a normal clone, the module name for a submodule and the
 * directory name for a bare repository. A directory that is not a git
 * repository uses its own path for both.
 * @param {string} root
 */
export function repoSlug(root) {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  let key = resolve(root);
  let name = basename(key);
  if (common) {
    key = common;
    const submodule = /[\\/]\.git[\\/]modules[\\/](.+)$/.exec(common);
    if (basename(common) === ".git") name = basename(dirname(common));
    else if (submodule) name = submodule[1];
    else name = basename(common).replace(/\.git$/, "");
  }
  return `${name.replace(/[^A-Za-z0-9._-]/g, "-")}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
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

/** @param {number} pgid  a process group id */
function groupAlive(pgid) {
  if (process.platform === "win32") return false;
  try { process.kill(-pgid, 0); return true; } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM"; }
}

/** @param {number} ms */
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Whether a takeover guard can be reclaimed. A guard records the pid and host
 * of its holder: while that pid is alive on this host it is never reclaimed,
 * however old; a dead holder's guard is reclaimed at once; a guard that
 * cannot be read or belongs to another host is reclaimed after 30 seconds.
 * @param {string} guard
 */
function guardStale(guard) {
  /** @type {{ pid?: unknown, host?: unknown } | null} */
  let held = null;
  try { held = JSON.parse(readFileSync(guard, "utf8")); } catch { held = null; }
  if (held && held.host === hostname() && typeof held.pid === "number") return !pidAlive(held.pid);
  try { return Date.now() - statSync(guard).mtimeMs > 30_000; } catch { return true; }
}

/**
 * Take the lock directory's guard, the one mutual-exclusion point for
 * publishing a lock's identity, rewriting it and taking an abandoned lock
 * over. Returns its release, or null when another live process holds it.
 * @param {string} guard
 * @returns {(() => void) | null}
 */
function tryGuard(guard) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(guard, JSON.stringify({ pid: process.pid, host: hostname() }), { flag: "wx" });
      pauseForTest("GOOD_AGENT_TEST_PAUSE_HOLD", true);
      return () => {
        try {
          const held = JSON.parse(readFileSync(guard, "utf8"));
          if (held.pid === process.pid && held.host === hostname()) unlinkSync(guard);
        } catch { /* already gone */ }
      };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      if (!guardStale(guard)) return null;
      reclaimGuard(guard);
    }
  }
  return null;
}

/**
 * Remove a guard that was judged dead (or old and unreadable) by renaming it
 * to a private name, which is atomic: of several runners reclaiming the same
 * guard exactly one rename succeeds (the others get ENOENT and loop back to
 * re-evaluate), and a runner never deletes a fresh guard that was created
 * after its judgement. If the file it moved turns out not to be stale after
 * all (a fresh guard took the dead one's place between the check and the
 * rename), it is linked straight back and left alone.
 * @param {string} guard
 */
function reclaimGuard(guard) {
  pauseForTest("GOOD_AGENT_TEST_PAUSE_GUARD_RECLAIM", false);
  const mine = `${guard}.reclaim-${process.pid}-${Date.now()}`;
  try { renameSync(guard, mine); } catch { return; }
  if (guardStale(mine)) { try { unlinkSync(mine); } catch { /* gone */ } return; }
  try { linkSync(mine, guard); } catch { /* a newer guard exists; the moved one's holder finds it is not its own at release */ }
  try { unlinkSync(mine); } catch { /* gone */ }
}

/**
 * Take the guard, waiting up to `maxMs` for a holder to finish (they hold it
 * for microseconds). Null when it stays busy.
 * @param {string} guard
 * @param {number} maxMs
 */
function guardWait(guard, maxMs) {
  const end = Date.now() + maxMs;
  for (;;) {
    const release = tryGuard(guard);
    if (release) return release;
    if (Date.now() >= end) return null;
    sleepSync(5);
  }
}

/** Hooks that already paused once in this process, for the `once` variants. */
const paused = new Set();

/**
 * Test-only: with the named variable set to a directory (honoured only inside
 * a `node --test` process), write <dir>/paused and block until <dir>/resume
 * exists. With `once`, only the first call in the process pauses.
 * @param {string} variable
 * @param {boolean} once
 */
function pauseForTest(variable, once) {
  const dir = process.env[variable];
  if (!dir || !process.env.NODE_TEST_CONTEXT || (once && paused.has(variable))) return;
  paused.add(variable);
  writeFileSync(join(dir, "paused"), "");
  for (let i = 0; i < 1500 && !existsSync(join(dir, "resume")); i += 1) sleepSync(20);
}

/**
 * Test-only: with GOOD_AGENT_TEST_PAUSE_RECLAIM=<dir> (honoured only inside a
 * `node --test` process), write <dir>/paused and block until <dir>/resume
 * exists, after a waiter has judged a lock abandoned and before it tries to
 * take it over.
 */
function pauseForReclaimTest() {
  const dir = process.env.GOOD_AGENT_TEST_PAUSE_RECLAIM;
  if (!dir || !process.env.NODE_TEST_CONTEXT) return;
  writeFileSync(join(dir, "paused"), "");
  for (let i = 0; i < 1500 && !existsSync(join(dir, "resume")); i += 1) sleepSync(20);
}

/**
 * Test-only: with GOOD_AGENT_TEST_PAUSE_LOCK=<dir> (honoured only inside a
 * `node --test` process), write <dir>/paused and block until <dir>/resume
 * exists, between creating the lock file and writing its content.
 */
function pauseForLockTest() {
  const dir = process.env.GOOD_AGENT_TEST_PAUSE_LOCK;
  if (!dir || !process.env.NODE_TEST_CONTEXT) return;
  writeFileSync(join(dir, "paused"), "");
  for (let i = 0; i < 1500 && !existsSync(join(dir, "resume")); i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

/**
 * One review at a time per reviewer, across repositories. The lock records
 * pid, host and start time, and once the reviewer is running its process
 * group id. A lock is taken over only when its runner pid is dead on this
 * host and its reviewer's process group, if any, is gone too: a runner that
 * was SIGKILLed leaves its detached reviewer running, and a second review
 * must not start beside it. An unreadable lock more than a few seconds old
 * (a crash between creating and filling it) is taken over as well. A
 * takeover goes through a guard file created exclusively and re-reads the
 * lock first, so two waiters never delete a lock the other has just taken.
 * Waiting counts against the caller's timeout, and `aborted` (a signal
 * trap) ends the wait.
 * @param {string} root  the reviews root
 * @param {string} reviewer
 * @param {{ wait: boolean, deadline: number, aborted?: () => string | null }} options
 * @returns {Promise<{ release: () => void, setChild: (pgid: number) => void }>}
 */
export async function acquireLock(root, reviewer, options) {
  mkdirSync(root, { recursive: true });
  const path = join(root, `${reviewer}.lock`);
  const guard = `${path}.takeover`;
  /** @returns {{ pid?: number, host?: string, started?: string, pgid?: number } | null} */
  const readHolder = () => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  /** @param {string} file */
  const ageMs = (file) => { try { return Date.now() - statSync(file).mtimeMs; } catch { return 0; } };
  /** @param {ReturnType<typeof readHolder>} holder */
  const stale = (holder) => holder === null
    ? ageMs(path) > 5000
    : holder.host === hostname() && typeof holder.pid === "number" && !pidAlive(holder.pid) && !(typeof holder.pgid === "number" && groupAlive(holder.pgid));
  /** @param {NonNullable<ReturnType<typeof readHolder>>} holder */
  const describe = (holder) => `pid ${holder.pid} on ${holder.host}${typeof holder.pgid === "number" ? `, whose reviewer process group ${holder.pgid} may still be running` : ""}`;
  /**
   * Wait a little, or give up: `--no-wait` is an immediate usage error, and
   * the wait never goes past the deadline.
   * @param {string} noWait  the usage error for `--no-wait`
   * @param {string} timedOut  the error when the deadline passes
   * @param {number} ms
   */
  const waitOrFail = async (noWait, timedOut, ms) => {
    if (!options.wait) throw new ReviewUsageError(noWait);
    const left = options.deadline - Date.now();
    if (left <= 0) throw new Error(timedOut);
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(ms, left))));
  };
  for (;;) {
    const interrupted = options.aborted?.();
    if (interrupted) throw new Error(`interrupted by ${interrupted} while waiting for the ${reviewer} lock`);
    try {
      const fd = openSync(path, "wx");
      // This acquisition's identity: a random token in the content and the
      // file's inode. A runner paused here, before the content is written, can
      // be judged "unreadable" and replaced; the token and inode let it find
      // out instead of acting on a lock that is no longer its own.
      const token = randomBytes(16).toString("hex");
      const first = fstatSync(fd);
      let ino = first.ino;
      let dev = first.dev;
      pauseForLockTest();
      const started = new Date().toISOString();
      // Publishing the identity takes the guard, the same one a waiter holds
      // while it re-checks and deletes an abandoned lock, so the two never
      // interleave: a lock whose creator was paused is either deleted before the
      // creator writes (and its setChild then fails) or published first (and the
      // waiter then sees a live owner).
      const publish = guardWait(guard, options.wait ? Math.max(0, Math.min(5000, options.deadline - Date.now())) : 200);
      if (!publish) {
        closeSync(fd);
        try { const now = statSync(path); if (now.ino === first.ino && now.dev === first.dev) unlinkSync(path); } catch { /* not ours any more */ }
        const message = `the ${reviewer} lock takeover guard ${guard} is held by another process; try again`;
        if (!options.wait) throw new ReviewUsageError(message);
        throw new Error(message);
      }
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, host: hostname(), started, token })}\n`);
        closeSync(fd);
      } finally { publish(); }
      /** Whether the lock file at `path` is still this acquisition's. */
      const owns = () => {
        let rfd;
        try {
          rfd = openSync(path, "r");
          const st = fstatSync(rfd);
          if (st.ino !== ino || st.dev !== dev) return false;
          return JSON.parse(readFileSync(rfd, "utf8")).token === token;
        } catch { return false; } finally { if (rfd !== undefined) { try { closeSync(rfd); } catch { /* closed */ } } }
      };
      return {
        release: () => { if (owns()) { try { unlinkSync(path); } catch { /* already gone */ } } },
        setChild: (pgid) => {
          const rewrite = guardWait(guard, 5000);
          if (!rewrite) throw new Error(`the ${reviewer} lock takeover guard ${guard} is held by another process; the reviewer was not started`);
          try {
            if (!owns()) throw new Error(`the ${reviewer} lock ${path} no longer belongs to this run (another process took it over); the reviewer was not started`);
            const tmp = `${path}.tmp-${process.pid}`;
            writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, host: hostname(), started, pgid, token }, null, 2)}\n`);
            const written = statSync(tmp);
            renameSync(tmp, path);
            ino = written.ino; dev = written.dev;
          } finally { rewrite(); }
        },
      };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    }
    const holder = readHolder();
    if (stale(holder)) {
      pauseForReclaimTest();
      // The final check and the delete happen under the guard, so a creator
      // that publishes its identity meanwhile is seen as a live owner here.
      const takeover = tryGuard(guard);
      const guarded = takeover === null;
      if (takeover) {
        try {
          const again = readHolder();
          if (stale(again) && again?.pid === holder?.pid && again?.started === holder?.started) {
            try { unlinkSync(path); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error; }
          }
        } finally { takeover(); }
      }
      // Another process is taking the lock over: wait for it, or fail fast.
      if (guarded) await waitOrFail(`another process is taking over the ${reviewer} lock ${path}; wait for it or drop --no-wait`, `timed out waiting for another process to take over the ${reviewer} lock ${path}`, 50);
      else await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    if (holder === null) {
      // Unreadable and younger than the grace period: someone may still be writing it.
      await waitOrFail(`the ${reviewer} lock ${path} is unreadable (it may be mid-write or corrupt); wait for it or drop --no-wait`, `timed out waiting for the unreadable ${reviewer} lock ${path}`, 100);
      continue;
    }
    await waitOrFail(`another ${reviewer} review is running (${describe(holder)}); wait for it or pass --no-wait to fail fast`, `timed out waiting for the ${reviewer} lock held by ${describe(holder)}`, 1000);
  }
}

/**
 * A fingerprint of the index from `git ls-files --stage -z`: the mode,
 * object id, stage and path of every entry, conflict stages included. Unlike
 * `git write-tree` it works during an unresolved merge and takes no index
 * lock. A failure throws, so the review is refused rather than run with an
 * index nobody can compare.
 * @param {string} root
 */
function indexFingerprint(root) {
  try {
    const listing = execFileSync("git", ["-C", root, "ls-files", "--stage", "-z"], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    return createHash("sha256").update(listing).digest("hex");
  } catch (error) {
    throw new Error(`the index cannot be fingerprinted (git ls-files --stage failed: ${/** @type {Error} */ (error).message.split("\n")[0]})`);
  }
}

/**
 * A digest of the repository state a review must not change. Each part is
 * delimited by a NUL and carries a label: `git rev-parse HEAD` (or
 * `unborn:<ref>` before the first commit), a hash of `git ls-files --stage -z`
 * for the index (every entry's mode, object id, stage and path, conflicts
 * included), the porcelain status, and then
 * the path and content hash of every file in `git ls-files -co
 * --exclude-standard` that still exists. HEAD and the index are in the digest
 * so an empty commit or a staged change that leaves the status unchanged
 * still voids a round; the status part covers deletions and the content part
 * covers edits and additions. A symlink contributes its target path, not the
 * content it points at. Everything is computed from the top of the working
 * tree (`git rev-parse --show-toplevel`), whatever directory is passed. Any
 * git failure throws, including a directory that is not in a working tree, so
 * a digest can never be a constant that accepts every change.
 * @param {string} dir
 */
export function treeDigest(dir) {
  const root = topLevel(dir);
  const hash = createHash("sha256");
  /** @param {string} label @param {string | Buffer} value */
  const part = (label, value) => { hash.update(label); hash.update("\0"); hash.update(value); hash.update("\0"); };
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const unborn = head === null ? git(root, ["symbolic-ref", "-q", "HEAD"]) : null;
  if (head === null && unborn === null) throw new Error("the tree cannot be fingerprinted (HEAD is neither a commit nor an unborn branch)");
  part("head", head ?? `unborn:${unborn}`);
  part("index", indexFingerprint(root));
  part("status", gitStrict(root, ["status", "--porcelain=v1", "-z"]));
  const listed = gitStrict(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
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
