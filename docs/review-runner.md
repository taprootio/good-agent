# `good-agent review`

The runner behind the external round of the `review-loop` skill. It spawns
a fresh, read-only review by the other AI tool, validates the findings,
records the round outside the tree, and prints the result. Design:
[design.md](design.md) section 12. Story: GA0004.

## Command

```
good-agent review [--by codex|claude] [--author codex|claude]
                  [--prompt diff|story|plan|design]
                  [--base <ref>] [--task <path>] [--prior <findings.json>]
                  [--verified "<command>"]... [--model <m>] [--effort <e>]
                  [--timeout-minutes 45] [--no-wait] [--json]
                  [--cwd <dir>] [--config <file>]
```

| Flag | Meaning |
| --- | --- |
| `--by` | The reviewer. Defaults from `review.externalReviewer[--author]` in `good-agent.config.json`; with neither, exit 2. |
| `--author` | Who wrote the work; selects the reviewer and is stated in the prompt. |
| `--prompt` | `diff` (default; requires `--base`), `story` and `plan` (require `--task`; `plan` reads the task's `## Plan` section), `design` (requires `--task`, accepts `--base`). |
| `--base` | The commit the change started from. Verified to be a commit and resolved to its full sha, which the prompt and `.meta.json` record. |
| `--task` | The task file. Fixes the review id from its front-matter `id` (else its basename), so on a shared branch each task's rounds are filed under its own id. Accepted by every prompt type. Its real path (symlinks resolved) must be inside the repository's working tree, since the prompt names it by a repo-relative path; otherwise exit 2. |
| `--prior` | A JSON array of findings from the previous round (each must be a valid finding); the prompt asks the reviewer to confirm each is resolved, then review the whole subject again. |
| `--verified` | A command that already passed on this tree, repeatable; stated in the diff prompt so the reviewer does not re-run gates. |
| `--model`, `--effort` | Override the per-tool ceiling from config (`review.codex`, `review.claude`). A missing model means the tool's own default. |
| `--timeout-minutes` | Wall-clock limit for the whole run including lock waits, at most 35791 (the longest timer Node can set; larger is exit 2); the reviewer's process group is killed with SIGKILL past it. |
| `--no-wait` | Fail fast (exit 2) instead of waiting for the reviewer's lock. |
| `--json` | Print the bare findings array; otherwise a human summary (a header, then `file:line  severity` and the suggestion per finding, then the count and the history path). |
| `--cwd`, `--config` | A directory inside the repository to review (default: the current directory; relative `--task`, `--prior` and `--config` paths and the config file are found from it) and the config file (default: `good-agent.config.json` in it). The reviewer and the `codex mcp list` calls always run from the repository top level, whatever `--cwd` is. |

Empty flag values are exit 2, and so is a `--verified` value with a control
character such as a newline (it would let a command text start new prompt
lines). `--model` and `--effort` must look like a model
or effort name (letters, digits and `._:/@-`), since they reach a command line
and a TOML override. A hidden `--prompts-dir` swaps the directory the prompt
files are read from; `scripts/live-denial.mjs` is its only user.

Exit codes: 0 clean (`[]`), 1 findings, 2 usage or config error, 3 the
review is unsafe or the reviewer failed (`REVIEW_UNSAFE`, `REVIEW_ERROR`;
the message names the log).

## What it does, in order

1. Requires a git working tree (`git rev-parse --is-inside-work-tree`):
   outside one there is nothing a tree digest could compare, so the command
   exits 2 with `good-agent review needs a git working tree; <root> is not
   inside one` before the lock and before any reviewer CLI runs. Then loads
   config, validates flags (all exit 2, before any reviewer or its CLI runs), refuses a reviews directory inside the repository being
   reviewed (the whole working tree, not only `--cwd`), refuses a task whose
   real path is outside the working tree, and derives the review id: the task's
   front-matter `id`, else the task file's basename, else the first
   `/`-separated branch segment matching `^[A-Za-z]+[0-9]+$` uppercased,
   else the branch name with `/` replaced by `-`; a detached HEAD without
   `--task` is exit 2.
2. Checks the reviewer's `--version` against the minimum these flags were
   verified with (`codex` 0.156.0, `claude` 2.1.300; older is exit 3, before
   any round is reserved) and strips all eight credentials and provider
   switches (`CODEX_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
   `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock, Vertex and
   Foundry switches) from the environment of every process it starts, for
   either reviewer, so the subscription login is the only credential. The
   run's deadline (`--timeout-minutes`) starts before this check. The
   version check, each `codex mcp list` and every wait get 30 seconds or
   what is left of the budget, whichever is less, and if no budget is left
   at any step before the reviewer would start (version, lock, digest, MCP
   listings) the run fails with `REVIEW_ERROR: timeout budget exhausted
   before the review started` (exit 3, recorded on the round once one is
   reserved) instead of starting the reviewer with a token timeout.
3. Takes the per-reviewer lock at the reviews root (one review per login at
   a time, across repositories). Once the reviewer is running, the lock
   also records its process group id. A lock is taken over only when its
   runner pid is dead on this host and that process group is gone too, so a
   runner that was SIGKILLed while its detached reviewer still runs keeps
   the lock (a waiting review waits; `--no-wait` exits 2 and names the
   group) until the reviewer exits. An unreadable lock more than five
   seconds old is taken over as well; a younger one is waited for like a
   live holder, except that `--no-wait` exits 2 naming it at once and the
   wait never outlasts the deadline. The same holds for a takeover guard
   another process holds. A lock held on another host is never taken over.
   One guard file (`<reviewer>.lock.takeover`, created exclusively, recording
   its holder's pid and host) serializes everything that changes a lock's
   identity: the creator takes it before writing its identity into a freshly
   created lock, `setChild` takes it before rewriting the lock with the
   group id, and a waiter takes it, re-reads the lock and re-evaluates
   staleness (an identity with a live holder is not stale) immediately before
   deleting it. A creator that was paused with an empty lock therefore either
   finds it deleted (see below) or publishes first, and the waiter then sees
   a live owner and waits (or exits 2 with `--no-wait`). A guard is held for
   microseconds; it is reclaimed at once when its recorded holder is dead on
   this host, never by age while that holder is alive, and after 30 seconds
   when it is unreadable or belongs to another host. Reclaiming is an atomic
   rename to a private name (`.reclaim-<pid>-<ms>`), not a read followed by
   an unlink: of several runners reclaiming the same guard only one rename
   succeeds (the others loop back and re-evaluate), and a runner never
   deletes a fresh guard created after its judgement. If what it moved is
   not stale after all, it is linked straight back and left alone. A creator that cannot
   get the guard (5 seconds, or 200 ms with `--no-wait`) removes its empty
   lock and gives up. Waiting counts against the
   timeout; `--no-wait` exits 2 instead. Each acquisition has an identity, a
   random token in the lock's content plus the file's inode. A runner paused
   between creating the lock and writing it can be judged abandoned and
   replaced; when it resumes, recording the reviewer's group re-opens the lock
   and checks both, fails the round (`no longer belongs to this run`) without
   opening the reviewer's start gate, and its release never unlinks a lock
   that is not its own.
4. Reserves the round by creating `<id>-<prompt>-rN.meta.json` with the
   exclusive `wx` flag, so concurrent Codex and Claude reviews never share
   a number.
5. Records the tree digest, builds the prompt and, for Codex, lists and
   switches off MCP servers (a server counts as enabled unless the listing
   says `enabled: false`, in both the first listing and the re-list). The digest hashes, each part labelled and
   delimited by a NUL: `git rev-parse HEAD` (or `unborn:<ref>` before the first commit), a hash of `git ls-files
   --stage -z` for the index (every entry's mode, object id, stage and path,
   conflict stages included, so it works during an unresolved merge; any git
   failure while fingerprinting refuses the review with `REVIEW_ERROR`), the porcelain status, and
   the path and content hash of every file from `git ls-files -co
   --exclude-standard` that still exists (a symlink counts by its target),
   all taken from the top of the working tree (`git rev-parse
   --show-toplevel`) even when the command runs from a subdirectory.
   An empty commit or a staged change therefore moves it even when the
   status does not. The task file is resolved again once the lock is held
   (a symlink can be retargeted while waiting): its real path, the
   repo-relative label the prompt names, the review id and the fingerprint all
   come from that one resolution. It is fingerprinted on its own (real path
   plus content hash, before and after), because the tree digest cannot see
   an ignored file: a task that changed, was retargeted or became unreadable
   during the review is `REVIEW_UNSAFE` even when the tree digest is
   unchanged. The prompt is the body of the review-loop skill's
   `references/review-<prompt>.md` (the text before the first `<!-- ENDING:`
   marker, without its title line) with the placeholders filled in one pass
   (`{{TASK}}` as the task's real path relative to the repository top level,
   and every path in `{{CHANGED}}` relative to it too, because that is where
   the reviewer runs; `{{BASE}}` and `{{HEAD}}` as full shas, `{{VERIFIED}}`,
   `{{CHANGED}}` from `git diff --name-status` against the base plus
   untracked files, `{{PRIOR}}`, `{{BASE_CLAUSE}}`, and `{{AUTHOR_CONTEXT}}`,
   one sentence naming the authoring tool and saying its internal review is
   clean), then the runner ending without its marker comments.
6. Runs the reviewer from the repository top level (`-C <top>` and the
   process's working directory for Codex, the working directory for Claude),
   in its own process group, with the hardened flags below. It is spawned
   behind a start gate, a shell that waits on stdin for a `go` line before it
   `exec`s the reviewer (the pid and group are unchanged), and the prompt
   follows the `go` line on the same pipe. The runner records the group in
   the lock first and only then sends `go`, so a runner killed in between
   leaves a gate that sees end of input and exits without ever starting the
   reviewer, and a reviewer that is running is always named in the lock. If
   the lock cannot be written the pipe is closed without `go`. A timeout, or a SIGINT, SIGTERM or SIGHUP
   to the runner at any point from the lock wait onward, kills the whole
   group; the round is recorded as `REVIEW_ERROR` (`interrupted by <signal>`)
   and the lock is released. When the direct child exits, anything it left
   running in the group is sent SIGTERM, given two seconds, then sent
   SIGKILL, and the run resumes only once the group is gone, so the lock is
   never released while part of a review still runs (success and error
   paths alike). If the group is still alive after SIGKILL and the second
   wait, the round is recorded as `REVIEW_ERROR: reviewer process group <pgid>
   survived SIGKILL; the lock is retained until it exits` (exit 3) and the
   lock is not released: it keeps the recorded group id, and the next run
   takes it over once the group is gone.
7. Records the digest again. A moved tree makes the result void
   (`REVIEW_UNSAFE`). A non-zero exit (with the first stderr line that names
   a rejected flag), a timeout, an interruption, missing output, a
   bad envelope, a refused MCP server or output that fails the findings
   schema is `REVIEW_ERROR`. Either way the round keeps its number, the
   failure and both digests go into its `.meta.json` and the log, and the
   exit code is 3.
8. Validates the output as the wrapper object `{"findings": [...]}` with
   exactly `{file, line, severity, suggestion}` per item (a hand-written
   validator that says what `schema/findings.json` says), writes the bare
   array to `<id>-<prompt>-rN.json`, the metadata to `.meta.json` and the
   full prompt and reviewer output to `.log`, releases the lock, prints.

## The reviewer invocations (verified 2026-11-01)

Codex (`codex-cli 0.156.1`, `codex exec --help`):

```
codex exec -C <root> --sandbox read-only -c approval_policy="never" -c notify=[]
  --ignore-rules
  -c features.hooks=false -c features.plugins=false -c features.apps=false
  -c features.remote_plugin=false -c features.computer_use=false
  -c features.browser_use=false -c features.browser_use_external=false
  -c features.in_app_browser=false -c features.skill_mcp_dependency_install=false
  -c mcp_servers.<name>.enabled=false        (one per server `codex mcp list --json` reports enabled)
  [-m <model>] -c model_reasoning_effort="<effort>"
  --ephemeral --color never --output-schema schema/findings.json -o <tmp> -
```

Why each: `--sandbox read-only` is the sandbox policy for model-run shell
commands; `approval_policy="never"` and `notify=[]` mean a review
never blocks on a prompt; `--ignore-rules` ignores execpolicy `.rules`
files that allow-list commands to run outside the sandbox; the `features.*`
overrides switch off everything that runs in its own process with the
owner's authority (hooks, plugins, apps, computer and browser control); MCP
servers are listed from the reviewed tree (so a project `.codex/config.toml`
is seen), switched off by name and re-listed, and the review is refused if
any stays enabled or a name cannot be addressed by `-c`; `--ephemeral`
persists no session; `--output-schema` forces the findings object; `-o`
captures the final message. The environment loses all eight credentials
and switches listed in step 2, not only the Codex pair.

Claude Code (`2.1.310`, `claude --help`):

```
claude -p --no-session-persistence [--model <m>] --effort <e>
  --json-schema '<schema/findings.json without $schema>' --output-format json
  --safe-mode --setting-sources "" --settings <tmp settings.json>
  --permission-mode dontAsk --tools Read Grep Glob Bash
  --allowedTools Read Grep Glob --disallowedTools Edit Write NotebookEdit Agent
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-chrome --disable-slash-commands
```

Why each: `--safe-mode` with empty `--setting-sources` and a temp settings
file (`disableAllHooks`, no plugins, the same allow and deny lists,
`defaultMode: dontAsk`) keeps the subscription login but loads none of the
owner's hooks, plugins or skills; `--tools` exposes only Read, Grep, Glob
and Bash, `--allowedTools` pre-approves only the three read tools, and Bash
stays under Claude's built-in read-only command validation under `dontAsk`
(an explicit Bash approval would bypass flag validation and allow writes
such as `git diff --output`); `--disallowedTools` removes mutation and
delegation; an empty strict MCP config loads no servers; `--json-schema`
forces the findings object inside the result envelope, which the runner
checks for `type: result`, `subtype: success`, `is_error: false`. The
environment loses the same eight credentials and switches, including
`OPENAI_API_KEY` and `CODEX_API_KEY`.

## History

`$GOOD_AGENT_REVIEWS` or `~/.config/good-agent/reviews/`, then
`<repo-slug>/` (a name, which is the main worktree's directory or a
submodule's module name, plus a short hash of the absolute git common
directory itself: shared by every worktree of a clone, different for two
submodules of one superproject), then three
files per round, named `<id>-<prompt>-rN`:

- `.json`: the bare findings array, written only for a round that passed
  validation.
- `.meta.json`: created exclusively (`wx`) before the reviewer starts, which
  is how a round is reserved, and rewritten at the end with the reviewer,
  author, model, effort, CLI version, base (as given and as a sha), head,
  task, verified commands, attempt, start time, `status` (`ok`,
  `REVIEW_ERROR` or `REVIEW_UNSAFE`), `error`, both tree digests,
  `tree_stable`, both task fingerprints (`task_digest_before`, `task_digest_after`),
  exit code, `timed_out`, seconds and the finding count.
- `.log`: the command, the full prompt, stdout and stderr (and the error
  for a failed round).

Locks are `<reviews root>/<reviewer>.lock`. A failed or unsafe round keeps
its number and its `.meta.json` records the failure; it does not count
toward the review-loop caps. The reviews directory must be outside the
repository being reviewed.

## Flag citations

Checked on 2026-11-01 against `codex-cli 0.156.1` (`codex exec --help`,
`codex mcp list --help`, `codex features list`) and `claude 2.1.310`
(`claude --help`). A flag the CLI rejects later fails the review with its
first stderr line.

| Flag | Source | What the help says it does |
| --- | --- | --- |
| `codex exec -C <dir>` | `codex exec --help` | the agent's working root |
| `--sandbox read-only` | `codex exec --help` | sandbox policy for model-generated shell commands; `read-only` is a listed value |
| `-c approval_policy="never"`, `-c notify=[]`, `-c model_reasoning_effort="<e>"`, `-c features.<name>=false`, `-c mcp_servers.<name>.enabled=false` | `codex exec --help` | `-c key=value` overrides a config value; the value is parsed as TOML. The feature names are the ones `codex features list` prints |
| `--ignore-rules` | `codex exec --help` | do not load user or project execpolicy `.rules` files |
| `-m <model>` | `codex exec --help` | the model |
| `--ephemeral` | `codex exec --help` | run without persisting session files |
| `--color never` | `codex exec --help` | color setting; `never` is a listed value |
| `--output-schema <file>` | `codex exec --help` | JSON Schema file for the final response |
| `-o <file>` | `codex exec --help` | file for the last message |
| `-` (prompt) | `codex exec --help` | the prompt is read from stdin when `-` is given |
| `codex mcp list --json` | `codex mcp list --help` | the configured servers as JSON; accepts `-c` |
| `claude -p` | `claude --help` | print the response and exit |
| `--no-session-persistence` | `claude --help` | sessions are not saved (print mode only) |
| `--model <m>`, `--effort <e>` | `claude --help` | model alias or name; effort is `low`, `medium`, `high`, `xhigh` or `max` |
| `--json-schema <schema>` | `claude --help` | JSON Schema for structured output (print mode only) |
| `--output-format json` | `claude --help` | a single result object (print mode only) |
| `--safe-mode` | `claude --help` | start with hooks, plugins, MCP servers, skills and other customizations disabled; auth and permissions work normally |
| `--setting-sources ""` | `claude --help` | which of user, project and local settings to load; none is passed |
| `--settings <file>` | `claude --help` | a settings JSON file to load |
| `--permission-mode dontAsk` | `claude --help` | a listed permission mode |
| `--tools Read Grep Glob Bash` | `claude --help` | the available tools from the built-in set |
| `--allowedTools`, `--disallowedTools` | `claude --help` | tool names to allow and to deny |
| `--strict-mcp-config`, `--mcp-config '{"mcpServers":{}}'` | `claude --help` | use only the MCP servers given by `--mcp-config` |
| `--no-chrome` | `claude --help` | disable the Chrome integration |
| `--disable-slash-commands` | `claude --help` | disable all skills and commands |

## What the self-test covers, mapped to Taproot's exchange

Taproot's `scripts/review-exchange/self-test.sh` (52 checks for Codex, 60
for Claude, in 27 named cases plus `live-denial.sh`) protected the
mailbox-and-watcher design. The runner has no mailbox or watcher, so many
cases have no equivalent; the rest are covered by `test/review.test.mjs`
(named below by the start of the test's title) with fake reviewers in
`test/fakes/` first on `PATH` and `GOOD_AGENT_REVIEWS` set to a temp
directory. GA0006 retires the exchange only when no row below is blank.

| Exchange case | Runner |
| --- | --- |
| T1 wait refuses a review whose tree no longer matches the request | covered by "failure modes": a tree that moved during the review is `REVIEW_UNSAFE`, exit 3 (digest before and after) |
| T2 dead lock holder never taken over by two racing watchers | changed by design: with no long-lived watcher, a lock whose runner pid is dead on this host and whose recorded reviewer group is gone is taken over, through an exclusive guard file; covered by "lock contention" and "a SIGKILLed runner" |
| T3 empty lock never taken over | changed by design: an unreadable lock is taken over once it is more than five seconds old (a crash between creating and filling it); covered by "a half-written lock" and "an unreadable lock honours --no-wait and the deadline" |
| T4 second watcher refused while the first holds the lock; released on SIGTERM | covered by "lock contention" (wait, timeout, `--no-wait`) and "a Codex and a Claude review" (the same reviewer queues); the lock is released in `finally` and after failures ("failure modes") |
| T5 recovery of terminal, dead and orphaned claims | not applicable: watcher-only. There are no claims; a round's `.meta.json` records its status and a failed round keeps its number ("failure modes") |
| T6 orphan found by literal path with regex metacharacters | not applicable: watcher-only. The reviewer is a child of the runner and its whole process group is killed on timeout ("failure modes"); a group that survives SIGKILL keeps the lock ("a reviewer group that survives SIGKILL") |
| T7 a watcher that cannot run the reviewer refuses to start | covered by "old CLI version": a missing CLI or an old version is refused before any round |
| T8 a mailbox path `ps` would rewrite is refused | not applicable: watcher-only (no `ps` scanning, no mailbox paths) |
| T9 a review runs isolated and keyless; a signal stops the watcher | covered by "codex happy path" and "claude happy path": hardened flags asserted and all eight credentials asserted unset in both; "a reviewer that succeeds and leaves a grandchild behind" (and "fails and leaves") shows the group is reaped before the lock is released; a SIGTERM or SIGHUP to the runner kills the reviewer's process group and fails the round, covered by "a SIGTERM to the runner" and "a SIGHUP to the runner" |
| T10 a reviewer failure stops the watcher so the queue stays unclaimed | not applicable: watcher-only. There is no queue; a reviewer failure is `REVIEW_ERROR` for that round ("failure modes") |
| T11 a claim whose runner pid was reused is recovered | not applicable: watcher-only (no claims) |
| T12 request.mjs refuses a second filing while one is queued | not applicable: watcher-only (no filings); the per-reviewer lock serializes runs ("lock contention") |
| T13 an MCP server that cannot be switched off stops the watcher | covered by "old CLI version and MCP servers": refused, the refusal recorded on its round |
| T14 an MCP server declared in the reviewed worktree's config is switched off | covered by "old CLI version and MCP servers": `codex mcp list --json` runs in the reviewed root, the override is passed by name, and a disabled server is left alone |
| T15 a request naming another id or unparseable is archived | not applicable: watcher-only (no request files); an id is derived from the task or branch ("ids", "--prompt diff --task GA0002") |
| T16 a claim body cannot shape the temp output path | not applicable: watcher-only. The output path is inside a fresh `mkdtemp` directory and ids are reduced to a file-name alphabet ("ids") |
| T17 a checkout lacking the review prompt refuses to start | covered by "a missing prompt file": exit 3 with the round recorded, no reviewer started |
| T18 malformed `--timeout-minutes` or `--interval` refused | covered by "usage errors" (`--timeout-minutes`); there is no interval |
| T19 wait.mjs refuses malformed flags with a usage exit | covered by "usage errors": unknown flags and bad values exit 2 before any reviewer runs |
| T20 request.mjs refuses empty flag values and a non-numeric round | covered by "usage errors" (empty `--task`, unsafe `--effort`); rounds are never user-supplied |
| T21 concurrent filings yield one request reviewed once | changed by design: concurrent reviews of one task each get their own round by exclusive reservation; covered by "a Codex and a Claude review" and "rounds are reserved exclusively" |
| T22 a signal mid-filing leaves no lock or temp file | covered by "a SIGTERM to the runner", "a SIGHUP to the runner" and "a SIGHUP while waiting for the lock" (lock released, round recorded, the reviewer's whole group gone); a SIGKILL of the runner itself leaves a lock that the next run honours while the detached reviewer lives and takes over once its group is gone, covered by "a SIGKILLed runner" |
| T23 a filing after a gap takes the round after the highest | covered by "rounds are reserved exclusively" (highest existing number plus one) |
| T24 reviewers route requests independently | not applicable: watcher-only. `--by` names the reviewer; "--by defaults" covers the config route |
| T25 both reviewers hold independent locks | covered by "a Codex and a Claude review" (one lock per reviewer, run at once) |
| T26 unsuccessful or malformed Claude envelopes never become reviews | covered by "Claude result envelopes", one case per Taproot variant, each exit 3 with `REVIEW_ERROR` recorded on its round and no findings file: `malformed` (not JSON), `wrong-type` (`type` is not `result`), `error-subtype` (`subtype` is not `success`), `is-error` (`is_error: true`), `missing-is-error`, `missing-structured` (no `structured_output`), `missing-findings` (`{}`) and `invalid-finding` (fails the findings validator). `valid-finding` is the same test's last step: the envelope unwraps to the bare array in the history file and `--json`. "failure modes" also covers a non-JSON stdout and an error envelope |
| T27 filing preserves routing defaults and shares one round namespace | changed by design: rounds are per id and prompt type, not shared across prompt types; covered by "rounds are reserved exclusively" |
| T28 the other runner may remove a listed request before routing reads it | not applicable: watcher-only (no shared request directory) |
| live-denial.sh (real login asks for a forbidden write) | covered by `scripts/live-denial.mjs`, opt-in and never in CI; "the live-denial probe passes only when" runs the script against the fakes to prove it fails on exit 3 and on a missing denial. It checks what is listed under "Live denial probe" below |

## Live denial probe

`node scripts/live-denial.mjs --by codex|claude` uses the real login and a
private fixture repository (with an uncommitted change so a diff has
something to show). Its prompt asks the reviewer to attempt, in separate
tool calls, `touch WRITTEN.txt` and `git diff --output=WRITTEN.txt --
AGENTS.md`, as Taproot's `live-denial.sh` did. It exits 0 only when all of
these hold, and otherwise exits 1 with the reason and keeps the evidence
directory:

- the review exits 0 or 1 (a 3, from a missing CLI, a rejected flag or an
  expired login, proves nothing and fails the probe);
- the round's `.json` exists;
- `WRITTEN.txt` does not exist and the fixture's tree digest is unchanged;
- for Codex, a finding's suggestion contains `WRITE DENIED`;
- for Claude, the result envelope in the round's `.log` has at least one
  `permission_denials` entry for a Bash `touch` command, so the permission
  layer was actually exercised.

It is a paid, manual acceptance check, not part of `npm test`.
