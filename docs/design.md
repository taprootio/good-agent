# good-agent design

Status: draft for review. Nothing here is implemented yet.
Date of all document checks below: 2026-11-01.

`good-agent` keeps AI tool instruction files DRY and
inside what the tools actually load. It ships a **guard** (a CLI check for
local runs, pre-commit hooks and CI) and a **skill** (a SKILL.md that teaches
an AI tool to set the files up and keep them that way).

The rule it enforces: one canonical file, every tool reads it by import where
the tool supports imports and by a short pointer where it does not, long
material lives in linked docs, and nothing points at files that are gone.

## 1. What the tools actually do

Every rule below cites one of these facts. Claims the docs do not make are
marked as such and are not used in rules.

### Codex (OpenAI)

Sources: the AGENTS.md guide at
<https://developers.openai.com/codex/guides/agents-md> (redirects to
`learn.chatgpt.com/docs/agent-configuration/agents-md`; same page), the
config reference at <https://developers.openai.com/codex/config-reference>,
and the loader source
<https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs>
(read at commit `54201ea6`, 2026-11-01). The source was read because the two
doc pages disagree on whether the limit is per file or combined.

- **Discovery.** In `~/.codex` Codex reads `AGENTS.override.md` if present,
  else `AGENTS.md` ("only the first non-empty file at this level"). Then,
  "starting at the project root (typically the Git root), Codex walks down to
  your current working directory. ... In each directory along the path, it
  checks for `AGENTS.override.md`, then `AGENTS.md`, then any fallback names in
  `project_doc_fallback_filenames`. Codex includes at most one file per
  directory." Files are concatenated root first, "joining them with blank
  lines." Directories below the cwd are not read.
- **Fallback names.** Only `AGENTS.override.md`, `AGENTS.md` and the names in
  the user's `project_doc_fallback_filenames` are considered. "Filenames not on
  this list are ignored for instruction discovery." `CLAUDE.md` is not on it.
  The fallback list is user config (`~/.codex/config.toml`), so a repo cannot
  rely on it.
- **Size limit.** `project_doc_max_bytes` is 32 KiB by default (the guide says
  "32 KiB by default"; the source has `AGENTS_MD_MAX_BYTES = DEFAULT_PROJECT_DOC_MAX_BYTES // 32 KiB`).
  The limit is a **combined budget** across the root-to-cwd chain, not per
  file: `read_agents_md` keeps a `remaining` counter, subtracts each file's
  bytes in chain order, and when a file is larger than what remains it
  `data.truncate(remaining)` and logs "project doc exceeds remaining budget;
  truncating". So the file that crosses the budget is cut mid-file and later
  files in the chain load nothing. The global `~/.codex/AGENTS.md` does not
  count against the budget (it is added before `remaining` is initialised).
  No user-visible warning is documented; the guide's troubleshooting entry is
  "Instructions truncated: Raise `project_doc_max_bytes` or split large files
  across nested directories."
- **No import syntax.** Neither page documents any include or `@path`
  mechanism in AGENTS.md.
- **Skills.** "Skills build on the open agent skills standard" (agentskills.io).
  "For repositories, Codex scans `.agents/skills` in every directory from your
  current working directory up to the repository root." Personal skills live
  in `~/.agents/skills`. Codex "supports symlinked skill folders and follows the
  symlink target." Source: <https://developers.openai.com/codex/build-skills>.

### Claude Code (Anthropic)

Sources: <https://code.claude.com/docs/en/memory>,
<https://code.claude.com/docs/en/skills>,
<https://code.claude.com/docs/en/commands>,
<https://code.claude.com/docs/en/costs>.

- **Loading.** Loaded at launch, broadest first: managed policy file, user
  `~/.claude/CLAUDE.md`, project `./CLAUDE.md` or `./.claude/CLAUDE.md`, local
  `./CLAUDE.local.md`, and the same files "from your current working directory
  and every directory above it." Subdirectory `CLAUDE.md` files load "once
  Claude reads, writes, or edits another file in that subdirectory."
  `.claude/rules/*.md` without a `paths` front matter field load at launch
  "with the same priority as `.claude/CLAUDE.md`"; with `paths` they load on
  demand. "Block-level HTML comments ... are stripped before the content is
  injected."
- **Imports.** `@path/to/import` anywhere in the file. "Both relative and
  absolute paths are allowed. Relative paths resolve relative to the file
  containing the import, not the working directory." "Imported files can
  recursively import other files, with a maximum depth of four hops." "Import
  parsing skips Markdown code spans and fenced code blocks." A path in quotes
  "isn't imported at all." Imports "don't reduce its context cost, because
  imported files load together with the CLAUDE.md that imports them."
  A Markdown link is not an import; nothing in the docs says Claude follows
  links at launch.
- **AGENTS.md.** "By default, Claude reads `AGENTS.md` only when you have no
  `CLAUDE.md` in your working directory or above it." Requires "v2.1.277 or
  later." It does not read `AGENTS.local.md`, `AGENTS.override.md` or
  `.agents/`. The docs' recommended bridge for repos that keep both: "put an
  `@AGENTS.md` import in a `CLAUDE.md` next to it." A symlink also works
  except that "the Edit and Write tools refuse to write through a symlink."
- **Size.** "Target under 200 lines per CLAUDE.md file. Longer files consume
  more context and reduce adherence." "If one of your instruction files is
  over the recommended length, you see a warning at startup and when you run
  `/status`," and there is a warning when files "add up past a combined limit
  at session start." Neither threshold number is documented. On-demand files
  (subdirectory CLAUDE.md, path-scoped rules, their imports) are cut at
  40,000 characters for a 200K context window. A file over 4 MiB is skipped.
- **Skills.** Project skills live at `.claude/skills/<name>/SKILL.md` and are
  also loaded from parent directories up to the repository root. Claude Code
  "follow[s] the Agent Skills open standard" and "extends the standard with
  additional features" (extra front matter such as `disable-model-invocation`,
  `context`, `paths`). Outside Claude Code only the spec fields are allowed.
  `.agents/skills` is not mentioned on the skills page, so Claude Code is not
  documented to read it.
- **`/doctor prompt-audit`.** "Claude looks for problems such as instructions
  written for older models, references to files or commands that don't exist,
  and files that contradict each other." Default scope: CLAUDE.md,
  CLAUDE.local.md, AGENTS.md, plus rules, skills, commands, subagents and
  output styles under `.claude/` and `~/.claude/`. It is an LLM review inside a
  Claude Code session that proposes edits. `/doctor` itself also flags
  "checked-in `CLAUDE.md` content Claude could derive from the codebase" and
  local files that duplicate checked-in ones. It does not check Codex or
  Copilot budgets, import resolution or cross-tool duplication, and it cannot
  run in CI. good-agent covers that deterministic ground and hands the
  semantic pass (contradictions, stale commands) to the skill, which tells
  Claude users to run `prompt-audit`.

### GitHub Copilot

Sources:
<https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions>,
<https://docs.github.com/en/copilot/concepts/prompting/response-customization>,
<https://docs.github.com/en/copilot/reference/custom-instructions-support>,
<https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions>,
<https://code.visualstudio.com/docs/copilot/customization/custom-instructions>,
<https://code.visualstudio.com/docs/agent-customization/agent-skills>.

- **Repository-wide file.** `.github/copilot-instructions.md`. Used by Chat on
  GitHub.com, the cloud agent, code review, the IDE chats and the CLI.
- **AGENTS.md.** "You can create one or more `AGENTS.md` files, stored anywhere
  within the repository. When Copilot is working, the nearest `AGENTS.md` file
  in the directory tree will take precedence." Alternatively "a single
  `CLAUDE.md` or `GEMINI.md` file stored in the root." Read by the cloud agent,
  code review, the CLI and VS Code chat. Copilot Chat on GitHub.com is not in
  the support table for AGENTS.md, so the repo-wide file is the only thing
  that surface is documented to read. When a path-specific file and the
  repo-wide file both match, "the instructions from both files are used."
- **Path-specific files.** `.github/instructions/NAME.instructions.md` with a
  front matter block containing `applyTo` in glob syntax; several globs are
  comma separated; `**` matches everything. Optional `excludeAgent` with the
  values `code-review` or `cloud-agent`. Honoured by code review and the cloud
  agent on GitHub.com, and by IDE chats and the CLI. VS Code adds `name` and
  `description` keys.
- **Size.** No byte or character cap is documented. Guidance only:
  instructions "should be short, self-contained statements" and are "sent with
  every chat message."
- **Imports.** The GitHub-hosted surfaces document no include syntax. The
  Copilot **CLI** does: "In `.github/copilot-instructions.md`, `AGENTS.md`, or
  `CLAUDE.md`, use `@` followed by a relative path to include another file,"
  and "File references are not expanded in `GEMINI.md` or `*.instructions.md`
  files." So a `@AGENTS.md` line in the Copilot file helps the CLI only; code
  review and the cloud agent see it as text. VS Code says relative Markdown
  links in instruction files resolve from the file and can be followed.
- **Skills.** VS Code documents project skill locations `.github/skills/`,
  `.claude/skills/` and `.agents/skills/`, and personal `~/.copilot/skills/`,
  `~/.claude/skills/`, `~/.agents/skills/`. GitHub says code review "reads
  repository custom instructions, agent instructions, and agent skills from
  the head branch."

### Agent Skills (the open format)

Sources: <https://agentskills.io/specification>,
<https://github.com/agentskills/agentskills/blob/main/docs/client-implementation/adding-skills-support.mdx>.

- A skill is a directory with `SKILL.md` plus optional `scripts/`,
  `references/`, `assets/`. Front matter: `name` (required, 1 to 64 chars,
  lowercase letters, digits and hyphens, "must match the parent directory
  name"), `description` (required, up to 1024 chars), optional `license`,
  `compatibility`, `metadata`, `allowed-tools`. The reference validator
  rejects unknown keys, so Claude-only keys make a skill fail validation
  elsewhere. Body guidance: "keep your main `SKILL.md` under 500 lines."
- Location is not part of the spec. The client guide says "the
  `.agents/skills/` paths have emerged as a widely-adopted convention for
  cross-client skill sharing," and that some clients also scan
  `.claude/skills/` for compatibility.
- Consequence for good-agent: one `SKILL.md` with spec-only front matter can
  serve Codex (`.agents/skills`), Copilot (`.agents/skills` or `.claude/skills`)
  and Claude Code (`.claude/skills`). Claude Code needs its own copy or a
  symlink because the docs do not list `.agents/skills` for it.

### npm names

Checked against `registry.npmjs.org` on 2026-11-01.

- `@taprootio/good-agent`: 404, free. The `@taprootio` scope already publishes
  `@taprootio/trellis`.
- `good-agent` (unscoped): one version (0.10.15) published in October 2019 and
  unpublished by npm support in February 2020. The record still exists with no
  versions. Decision (Jereme, 2026-11-01): claim it. `good-agent` is the
  package people install (`npx good-agent check`), and `@taprootio/good-agent`
  is published as a thin alias that depends on it and exposes the same bin,
  so the org namespace is kept. Whether npm lets the unscoped name be reused
  is only knowable by publishing; GA0005 tries a placeholder first.
- Nearby packages worth knowing about: `agents-md-lint` (an AGENTS.md linter
  with scoring and autofix) and `agents-lint` ("detect stale references and
  context rot in AGENTS.md"). Both are single-file AGENTS.md linters. Neither
  models what each tool loads (Codex's combined budget, Claude's imports,
  Copilot's `applyTo`) or the one-canonical-file layout, which is the point of
  good-agent. The README should say that in one line.

## 2. The model good-agent enforces

1. **One canonical file**, named `AGENTS.md` unless configured otherwise.
   Codex reads it natively, Copilot reads it natively, Claude Code reads it
   when there is no CLAUDE.md or through an import. No other name has that
   reach.
2. **Thin tool files.** `CLAUDE.md` is `@AGENTS.md` plus Claude-only notes.
   `.github/copilot-instructions.md` is a pointer plus Copilot-only notes
   because Copilot has no import on the surfaces that matter. Per-language
   `.instructions.md` files add deltas for a file type and never restate the
   canonical file.
3. **Long material in linked docs.** Anything reference-shaped (runbooks,
   architecture detail, decision records) lives under `docs/` and is linked
   by path. Links are not loaded at launch by any tool, so they cost nothing
   until an AI tool opens them. Imports do cost context, so `@` is for the
   canonical file only.
4. **Budgets are per tool, and the tools disagree.** Codex: 32 KiB combined
   along the directory chain. Claude: under 200 lines per file for every
   file it loads at launch, imports included; no combined number is
   documented and none is enforced. Copilot: no hard limit. The guard
   reports against each tool's own number.
5. **Nothing points at what is gone.** Links, imports, repo paths and npm
   scripts named in instruction files must exist.

### How the canonical file is detected (zero config)

The canonical file is the instruction file that the other instruction files
point at. Concretely: collect every instruction file (section 4.1), count
inbound references from the other instruction files (Markdown links and
`@` imports, resolved relative to the referencing file; a Markdown link with
a leading `/` is treated as repo-root, while an `@` import with a leading
`/` is an absolute filesystem path for Claude and is skipped here, as
`links/broken` skips it), and pick the file with the most inbound
references.
Ties go to `AGENTS.md`. If no file references another and there is exactly one
root-level candidate, that is canonical. If `AGENTS.md` exists and nothing
else resolves, it wins. Otherwise `canonical/detect` fails and asks for the
`canonical` config key.

On the three real repos this picks `AGENTS.md`, `AI_GUIDELINES.md` (three
inbound) and `AGENTS.md` without configuration. On Trellis, which has only
`AGENTS.md`, it picks that.

## 3. Rule set

Each rule has an id (`area/name`), a default severity (`error` fails the
check, `warn` is reported but passes, `info` is shown only with `--verbose`),
the fact it rests on, and the decision on the candidate list from the brief.
"v0.1" marks what ships first; the rest is section 10.

### Kept

| Rule | Severity | Ships | What it checks |
| --- | --- | --- | --- |
| `canonical/detect` | error | v0.1 | A canonical file could be determined (section 2). |
| `canonical/name` | warn | v0.1 | The canonical file is named `AGENTS.md`. Otherwise Codex (only `AGENTS.md` and user-configured fallbacks) and Copilot (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) see only a written pointer. Fix: rename and keep `CLAUDE.md` as `@AGENTS.md`. |
| `codex/size-budget` | error | v0.1 | For every directory that holds an `AGENTS.md` or `AGENTS.override.md`, the chain from the repo root to that directory totals at most `limits.codexBytes` (32,768). Per directory the chain takes the first file that exists in the order `AGENTS.override.md`, `AGENTS.md`, exactly as the loader does (`agents_md_paths` probes metadata only); if that file is empty it contributes zero bytes and the directory's `AGENTS.md` is not read, so an empty override silences its directory. That case produces no budget finding; `inspect` shows the selected file with its zero bytes and the shadowed `AGENTS.md`, and a `codex/override-shadows` warning is v0.2. User-configured `project_doc_fallback_filenames` live in `~/.codex/config.toml`, so v0.1 does not model them and says so in `explain`. The finding names the file that gets cut, the byte and line where the cut lands, the heading it lands in, and how many bytes never load; chains cut at the same file and byte are merged into one finding with every chain in `data.chains`. Source: `agents_md.rs` truncation loop. |
| `claude/import-canonical` | error | v0.1 | If `CLAUDE.md` (or `.claude/CLAUDE.md`) exists and the canonical file is a different file, it contains an `@<canonical>` import outside code spans. A Markdown link is not enough. If there is no `CLAUDE.md` and the canonical file is not `AGENTS.md`, that is an error too (Claude loads nothing). If there is no `CLAUDE.md` and the canonical file is `AGENTS.md`, that is `info`: Claude Code 2.1.277+ reads it, older versions do not. |
| `claude/size` | warn | v0.1 | The launch set is what Claude Code loads at startup: `CLAUDE.md` or `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md` without `paths`, and their `@` imports to four hops, each file once; with no `CLAUDE.md` at all, `AGENTS.md` (the documented fallback). Warn for **each file** in that set over `limits.claudeLines` (200), which is the documented per-file target. When no file is over the target but the launch set together is, one `info` finding reports the total, because the docs say a combined warning exists but give no number; a clean repo gets no finding at all. Claude Code warns about this itself at startup, so this is a warning, not an error; it exists so CI sees it. The finding names the file, how it reaches the launch set (directly or via which import), and its line count. |
| `links/broken` | error | v0.1 | Every relative Markdown link and every `@` import in an instruction file resolves to an existing path. Fragments are stripped; `http(s)`, `mailto` and `#` anchors are skipped; a Markdown link with a leading `/` resolves from the repo root, as in canonical detection; `~/` and absolute imports are skipped (they are outside the repo). Imports are resolved relative to the containing file, as the Claude docs say. A broken import is called out separately because Claude "silently loads nothing for it." |
| `claude/import-depth` | warn | v0.1 | An import chain deeper than four hops; the docs say files past that are not loaded. Cheap to check while resolving `links/broken`. |
| `copilot/applyto` | error | v0.1 | Every `.github/instructions/*.instructions.md` starts with front matter containing `applyTo`; `excludeAgent`, if present, is `code-review` or `cloud-agent`. Without `applyTo` Copilot never attaches the file. |
| `dry/copied-canonical` | error | v0.1 | A tool file whose substantive lines (normalised whitespace, at least 20 chars, not headings) are at least 50% identical to lines in the canonical file, with a floor of five lines. This is the "CLAUDE.md copies AGENTS.md instead of importing it" case. Fix: replace with `@<canonical>` or a pointer. |
| `dry/duplicate-block` | warn | v0.2 | An identical paragraph or list item (60+ chars after whitespace normalisation) in two instruction files. Pointer sentences (blocks that link to or import the canonical file) are exempt because they are supposed to repeat. Suppressed for any file pair that `dry/copied-canonical` already reported, so a wholesale copy is one finding, not twenty. |
| `copilot/pointer-thin` | warn | v0.2 | `.github/copilot-instructions.md` larger than `limits.pointerBytes` (2,048) when it is not the canonical file. Copilot reads the canonical `AGENTS.md` natively on every surface except GitHub.com Chat, and has no import, so anything beyond a pointer here is a second copy. |
| `refs/missing-path` | warn | v0.2 | A backtick-quoted path in an instruction file that contains a `/`, whose first segment is a real top-level directory of the repo, and that does not exist. The first-segment test is what keeps this quiet: `Taproot.Domain/Commands/CommandHandler.cs` (relative to a service folder), `completed/index.md` and `TRxxxxx.md` are skipped, and so are paths into ignored directories such as `node_modules/`. Placeholders containing `<`, `*`, `{` or whitespace are skipped. |
| `refs/missing-script` | warn | v0.2 | `npm run <name>` where `<name>` is not a script in any `package.json` in the repo (outside ignored directories). Checking every package.json is what makes this quiet in a monorepo: Taproot's `npm run typecheck` lives in `ux/package.json`. |

### Cut

| Candidate | Why |
| --- | --- |
| Contradictions between a delta file and the canonical file | Not feasible without a model. The real case (the proto delta said every RPC needs `google.api.http`; AGENTS.md said internal RPCs must omit it) is two correct-looking sentences about the same identifier. A keyword-overlap heuristic ("both files mention `google.api.http`, check they agree") produces a review prompt, not a finding, and would fire on every delta file that correctly cross-references the canonical one. This goes to the skill's audit procedure (section 5), which also points Claude users at `/doctor prompt-audit`, whose documented scope includes "files that contradict each other." |
| Per-tool size limit for Copilot | No limit is documented. A rule with an invented number would break the "every rationale cites a doc" constraint. |
| "Pointer files where an import is supported" as a separate rule | This is `claude/import-canonical`. For Copilot the GitHub-hosted surfaces have no import, so the pointer is correct there; the CLI-only `@` include is not worth a rule because it would make code review and the cloud agent see a stray `@AGENTS.md` line. |
| Claude `claudeMdExcludes`, managed policy files, `~/.claude` | User and machine state, not repo state. Out of scope. |

### Added after reading the repos

- `canonical/name` (above). taproot-controls shows the pattern: a canonical
  `AI_GUIDELINES.md` means Codex sees only the Trellis block and Tilt notes in
  `AGENTS.md` plus a sentence saying to read another file.
- `refs/missing-script` (above). The taproot AGENTS.md names six `npm run`
  scripts; all exist somewhere in the monorepo, which is exactly why the rule
  has to look at every package.json.
- Generated blocks. taproot-controls' `AGENTS.md` carries a Trellis-generated
  block between `<!-- BEGIN TRELLIS -->` and `<!-- END TRELLIS -->`. The guard
  treats text between `<!-- BEGIN X -->` / `<!-- END X -->` markers as
  generated: findings inside it get a "generated by X; fix the generator" note,
  and `dry/*` rules do not count a generated block against the file. The
  one exception is the `GOOD-AGENT` block, which is hand-written in v0.1
  (section 12): its contents get the normal checks and no generator
  annotation. Not a rule, a parsing behaviour, and part of v0.1.

### Noise controls that are part of the design

- Code spans and fenced blocks are blanked before link, import and reference
  parsing, matching how Claude parses imports.
- `node_modules`, `.git`, `coverage`, `dist`, `build`, `public`, `.next`,
  `out` and anything in `ignore` are skipped both when discovering instruction
  files and when validating referenced paths.
- A file reported by `dry/copied-canonical` is not also reported block by
  block.
- `info` findings are hidden unless `--verbose` or `--json`.

## 4. CLI

### 4.1 Files it considers instruction files

At any depth unless ignored: `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`,
`CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`. (`GEMINI.md`
and `.cursor/rules` wait for v0.2 and a docs check of their own.)
At the root only: `.github/copilot-instructions.md`,
`.github/instructions/**/*.instructions.md`. Plus the configured `canonical`
file and any `extraFiles` globs. `AI_GUIDELINES.md` is recognised at the root
as a known alternative name so detection works on repos like taproot-controls
without config.

### 4.2 Commands

```
good-agent check [options] [path...]
    Run the rules. With paths, run only when at least one path is an
    instruction file, a link target of one, or the config file in effect
    (default or --config) (for verify-changed style scripts); otherwise
    exit 0 immediately with "nothing to check". Checks the directory it
    runs in (or --cwd); run from the repository root to validate the whole
    Codex chain and root-relative links.

good-agent inspect [--json]
    What each tool loads: the detected canonical file, every instruction
    file with bytes and lines, the Codex chain and budget per directory,
    the Claude launch set with imports expanded. No findings, no exit 1.
    This is the screenshot for the article.

good-agent explain <rule>
    The rule's rationale, the fix, and the doc URLs.

good-agent rules
    List rules with default severity and whether they are on.

good-agent init [--skill] [--config] [--hook] [--ci]     (--config, --hook, --ci: v0.2)
    --skill copies every shipped skill into .agents/skills/<name>/ and
    .claude/skills/<name>/ (two copies, both marked generated, see 5.3);
    --force overwrites a hand-edited copy.
    --config writes a commented good-agent.config.json with defaults.
    --hook and --ci print the snippets from section 6 (they do not edit
    .git/hooks or workflows).
```

Options for `check`: `--json`, `--verbose` (show `info`), `--strict` (warnings
fail), `--config <file>`, `--cwd <dir>`, `--rule <id>` (repeatable, run only
these), `--no-rule <id>` (repeatable), `--quiet` (summary line only),
`--no-color`.

The repo root is `--cwd` or, without it, the current directory. good-agent
never walks up to the git top level: discovery, the Codex chain and the JSON
`root` all start there, and running it from a subdirectory checks that
subdirectory as a root. This keeps the empty-directory case well defined,
but it is narrower than Codex, which loads from the repository root down to
its cwd: a run from a subdirectory cannot see the ancestor `AGENTS.md`
files that share the budget, and a Markdown link with a leading `/`
resolves against that root too, so complete `codex/size-budget`,
`links/broken` and canonical-detection results need a run from the
repository root. The CLI help and the README say so.

### 4.3 Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No `error` findings (warnings and info allowed; with `--strict`, no warnings either). |
| 1 | At least one failing finding. |
| 2 | Usage or config error (unknown flag, unreadable config, unknown rule id). |
| 3 | Internal error (stack trace printed; please report). |

### 4.4 Human output

```
good-agent 0.1.0 · 6 instruction files · canonical AGENTS.md

✖ AGENTS.md  codex/size-budget
  Codex loads at most 32,768 bytes of AGENTS.md content along the chain
  AGENTS.md (34,348 bytes). It truncates AGENTS.md at byte 32,768 (line 565,
  inside "## Area-specific architecture"); the last 1,580 bytes never reach
  Codex.
  fix: Move long sections into docs/ and link them from AGENTS.md, or split
  guidance into nested AGENTS.md files closer to the code they govern.
  docs: https://developers.openai.com/codex/guides/agents-md

▲ AGENTS.md  claude/size
  589 lines, loaded at launch through the @AGENTS.md import in CLAUDE.md;
  the docs recommend under 200 lines per file because longer files reduce
  adherence. Launch set: CLAUDE.md 28 + AGENTS.md 589 = 617 lines.
  fix: Move reference material into docs/ linked by path (not @-imported), or
  into skills and path-scoped .claude/rules that load on demand.
  docs: https://code.claude.com/docs/en/memory

1 error, 1 warning  (exit 1)
```

Every finding has four parts in a fixed order: file and rule, what is wrong
with the numbers, the fix, the doc. The file line is first so editors and
`grep` can pick it up.

### 4.5 JSON output (`--json`)

```json
{
  "version": "0.1.0",
  "root": "/Users/jereme/src/taproot",
  "canonical": "AGENTS.md",
  "files": [
    { "path": "AGENTS.md", "bytes": 34348, "lines": 589, "readBy": ["codex", "claude:import", "copilot"] },
    { "path": "CLAUDE.md", "bytes": 1575, "lines": 28, "readBy": ["claude", "copilot"] }
  ],
  "findings": [
    {
      "rule": "codex/size-budget",
      "severity": "error",
      "file": "AGENTS.md",
      "line": 565,
      "message": "Codex loads at most 32,768 bytes ... the last 1,580 bytes never reach Codex.",
      "fix": "Move long sections into docs/ ...",
      "docs": ["https://developers.openai.com/codex/guides/agents-md"],
      "data": { "bytes": 34348, "limit": 32768, "chain": ["AGENTS.md"], "truncatedAt": 32768 }
    }
  ],
  "summary": { "errors": 1, "warnings": 1, "info": 0, "exitCode": 1 }
}
```

`data` is rule-specific and documented per rule. Everything else is stable
across minor versions.

`inspect --json` shares `version`, `root`, `canonical` and `files`, and adds
what each tool loads. `readBy` lists what loads at launch (`codex`,
`claude`, `claude:import`, `claude:fallback`, `copilot`); `claude:on-demand`
marks a file Claude Code loads only later, such as a path-scoped rule or a
nested `CLAUDE.md`:

```json
{
  "codex": { "chains": [ { "dir": ".", "files": ["AGENTS.md"], "bytes": 34348, "limit": 32768, "truncatedAt": 32768 } ] },
  "claude": { "launch": [ { "file": "CLAUDE.md", "lines": 28 }, { "file": "AGENTS.md", "lines": 589, "via": "CLAUDE.md" } ], "lines": 617, "limit": 200 },
  "copilot": { "repoWide": ".github/copilot-instructions.md", "pathSpecific": [ { "file": ".github/instructions/proto.instructions.md", "applyTo": "**/*.proto" } ] }
}
```

### 4.6 Config file

`good-agent.config.json` at the repo root (same shape as Trellis's
`backlog.config.json`: one JSON file, no JS config, no cosmiconfig search).
Everything is optional; the file is optional.

```json
{
  "$schema": "https://raw.githubusercontent.com/taprootio/good-agent/main/schema/config.json",
  "version": 1,
  "canonical": "AGENTS.md",
  "ignore": ["vendor/**", "examples/**"],
  "extraFiles": [".cursor/rules/*.md"],
  "limits": {
    "codexBytes": 32768,
    "claudeLines": 200,
    "pointerBytes": 2048
  },
  "rules": {
    "canonical/name": "off",
    "claude/size": "info"
  },
  "review": {
    "externalReviewer": { "claude": "codex", "codex": "claude" },
    "codex": { "effort": "medium" },
    "claude": { "model": "sonnet", "effort": "high" }
  }
}
```

`review` is read by `good-agent review` (section 12): `externalReviewer`
maps the authoring tool to the tool that reviews its work, and the per-tool
`model` and `effort` are the review ceiling. A missing `model` means the
tool's own configured default. The shipped defaults are the values shown,
which are Taproot's owner decisions from September 2026.

A rule value is a severity string (`error`, `warn`, `info`, `off`) or an
object whose only allowed key in v0.1 is `severity`; any other key is an
exit 2. Rule-specific options arrive with the rules that need them (v0.2)
and are listed per rule when they do. `limits` are the numbers
that come from tool docs; changing them is how a team that sets
`project_doc_max_bytes = 65536` in every `~/.codex/config.toml` tells the
guard so. `version` lets a future schema change be detected and explained
instead of silently misread.

## 5. The skill

### 5.1 Skill or playbook

Trellis ships playbooks: Markdown procedures that `AGENTS.md` links to and
that a human can also follow. A skill is the same kind of document with front
matter that lets a tool discover it and load it on demand. The difference is
who starts it. A playbook is invoked by the repo's own workflow ("to close a
task, follow `trellis/playbooks/work-task.md`"). A skill is picked by the
AI tool from its description when the user's request matches ("set up
instruction files for Codex", "why is Codex ignoring the end of AGENTS.md").

Instruction hygiene is the second kind: nobody schedules it, it comes up when
someone touches the files. So good-agent ships a **skill**, written so it also
reads as a playbook (plain headings, numbered procedures, no tool-specific
front matter). A repo that prefers the playbook convention can link to the
same file from `AGENTS.md`.

### 5.2 `SKILL.md`

```
---
name: good-agent
description: Set up and maintain AI tool instruction files (AGENTS.md,
  CLAUDE.md, Copilot instructions) so one canonical file serves every tool,
  stays inside each tool's limits, and points only at files that exist. Use
  when creating or editing AGENTS.md, CLAUDE.md or .github/copilot-instructions.md,
  when `good-agent check` fails, or when asked to audit AI tool instructions.
license: MIT
metadata:
  package: "good-agent"
---
```

Spec fields only, so the Agent Skills reference validator, Codex and Copilot
all accept it. The `name` matches the directory. Target length under 200
lines; the spec ceiling is 500.

Body, in order:

1. **The layout** (section 2 in four bullets) and why: what each tool loads,
   with the numbers.
2. **Set up a repo**: create or rename to `AGENTS.md`; write `CLAUDE.md` as
   `@AGENTS.md` plus Claude-only notes; write
   `.github/copilot-instructions.md` as a pointer; add `.instructions.md`
   deltas with `applyTo`; move anything reference-shaped to `docs/` and link
   it; run `npx good-agent check`.
3. **Write rules that survive**: one rule per bullet, state the behaviour and
   the exception, name the check that enforces it when there is one, never
   restate the canonical file in a delta file (cross-reference the section
   instead), keep paths repo-relative.
4. **Audit** (the part the guard cannot do):
   - Run `good-agent check --json` and fix every error first.
   - For each delta file, for each rule, find the canonical section on the
     same topic and read both; if they disagree, the canonical file wins and
     the delta is rewritten as an addition ("in addition to AGENTS.md
     §Protobuf: ...") or deleted. The proto `google.api.http` drift is the
     worked example.
   - For each command in the files, run it with `--help` or confirm the
     script exists.
   - Look for paraphrased duplicates (same rule, different words) between
     files; keep one.
   - In Claude Code, also run `/doctor prompt-audit`, which covers older-model
     phrasing, missing files and contradictions for Claude's own files.
   - Report findings as a list with file, line and proposed edit; do not
     apply edits the user has not seen.
5. **Fix recipes** keyed by rule id, one paragraph each, mirroring
   `good-agent explain`.
6. **Do not**: copy the canonical file into a tool file; raise a tool's limit
   in user config as the fix for a repo problem; link with `@` to anything
   but the canonical file; hand-edit another tool's generated block (for
   example Trellis's). The `GOOD-AGENT` block is the one place for
   good-agent's own review policy.

### 5.3 Installation

Shipped in the package under `skill/<name>/SKILL.md` and listed in `files`.
`good-agent init --skill` copies every shipped skill (`good-agent`,
`write-task`, `work-task`, `review-loop`) to `.agents/skills/<name>/SKILL.md`
(Codex, Copilot) and `.claude/skills/<name>/SKILL.md` (Claude Code, Copilot).
Each copy keeps the `---` front matter as its first line, as the Agent Skills
format requires, and carries an HTML comment on the first body line marking
it generated, naming the refresh command, and holding a hash of the whole
copy except the marker line, front matter included; installed
`references/` files are covered by a manifest of hashes next to the
`SKILL.md`. A hand-edited copy is detected and not overwritten without
`--force`.
Two copies rather than a symlink because
the Claude docs say Edit and Write refuse to write through symlinks, and
Windows checkouts turn symlinks into text files. A follow-up rule
(`skills/copies-in-sync`, v0.2) can verify the two copies match.

Personal install is the same two paths under `~`. Plugin or marketplace
packaging for Claude Code is not in scope.

## 6. Integration

### Pre-commit

A plain git hook, no husky (Trellis has none either):

```sh
#!/bin/sh
# .githooks/pre-commit  (git config core.hooksPath .githooks)
git diff --cached --name-only -z | xargs -0 -r npx --no-install good-agent check
```

`check` with paths exits 0 at once when none of them is an instruction file,
a link target of one, or the config file in effect (default or `--config`),
so the hook costs nothing on ordinary commits. NUL-delimited paths keep a
filename with a space as one argument, and `xargs -r` (accepted by GNU and
BSD xargs) runs nothing on an empty commit. `npx --no-install` needs
`good-agent` in the repo's devDependencies. With `lint-staged` the
equivalent entry is `"*": "good-agent check"`: every staged path goes to
`check`, whose own filter decides, so a config-only or link-target-only
commit is not missed.

### GitHub Actions

```yaml
name: agent-instructions
on: [pull_request, push]
jobs:
  good-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx good-agent@0.1 check --json > good-agent.json || true
      - run: npx good-agent@0.1 check
```

The first run keeps the JSON as a build artefact or for a PR comment step; the
second fails the job. Pinning the major in `npx` is what keeps a new rule from
breaking the build (section 8).

### Taproot's `verify-changed.sh`

That script already collects changed paths and picks checks by pattern. The
addition is one step that hands it the paths and lets `check` decide:

```sh
run_step "agent instructions" npx --no-install good-agent check "${paths[@]}"
```

Because `check` resolves link targets, deleting `docs/architecture/foo.md`
that `AGENTS.md` links to triggers the step even though no instruction file
changed. `--plan` mode gets the step for free through `run_step`.

## 7. Testing the guard

Match Trellis: `node --test`, no test framework, fixtures as real directory
trees.

- `test/fixtures/<rule>/<case>/` holds a tiny repo (a few Markdown files, a
  `package.json` when the rule needs one) and `expected.json` listing the
  findings `check --json` must produce for that fixture, as
  `{rule, file, line?}` triples plus the expected exit code. Each rule gets at
  least one `pass` and one `fail` case; `codex/size-budget` gets a nested
  chain case and an override case; `claude/import-canonical` gets the
  Markdown-link case, the code-span case (`` `@AGENTS.md` `` must not count)
  and the no-CLAUDE.md cases; `dry/copied-canonical` gets a wholesale copy
  and checks that no `dry/duplicate-block` finding accompanies it;
  `claude/size` gets an `AGENTS.md`-only launch set, a `.claude/CLAUDE.md`-only
  launch set, and two files under the target whose total is over it (the
  info case); canonical detection gets a `@/absolute` import that must not
  count; the path filter gets a config-only change; the hook fixture gets an
  empty commit and a staged path with a space.
- `test/cli.test.mjs` runs the bin as a child process for exit codes 0, 1
  and 2, `--json` shape, `--strict`, `--rule`, and the path-filtered
  "nothing to check" fast exit.
- `test/discover.test.mjs` covers canonical detection on the three real
  layouts reproduced as fixtures (Taproot-like, taproot-controls-like, site-
  like) plus Trellis-like (single file) and empty.
- `scripts/corpus.mjs` runs `check --json` against sibling checkouts
  (`../taproot`, `../taproot-controls`, `../www.jeremeevans.com`) when they
  exist and diffs against `test/corpus/*.expected.json`. It is a local
  regression net, skipped in CI because the repos are private.
- Human output is snapshot-tested for the README example so the screenshot
  and the code agree.

## 8. Versioning and release

- Semver. Rule ids, severities, the JSON shape and the config schema are the
  public API.
- A **new rule** ships in a minor version at `warn` or `info`, never `error`,
  and is listed in the changelog with its doc citation. Promotion to `error`
  happens in the next major. So a project on `@0.x`/`^1` never starts failing
  because a rule appeared.
- A **limit value** changes when a tool's docs change (say Codex moves to
  64 KiB). That is a minor version with the date and link in the changelog,
  because it can turn a failing repo green or a green repo red.
- Removing or renaming a rule is a major. Unknown rule ids in config are an
  exit 2 so a rename is noticed.
- Each rule records `since` (the version it appeared in); `good-agent rules`
  prints it.
- Release mechanics copy Trellis's `release.yml`: the version bump in
  `package.json` on `main` is the release, npm trusted publishing with OIDC,
  tag and GitHub Release created in the same job, prereleases to the `next`
  dist-tag.

## 9. Package layout, language, dependencies, license

- **Layout** mirrors Trellis: `scripts/good-agent.mjs` (the bin, a thin
  dispatcher), `src/cli.mjs`, `src/config.mjs`, `src/discover.mjs`,
  `src/markdown.mjs` (code-span stripping, links, imports, front matter,
  generated markers), `src/rules/<area>/<name>.mjs` (one file per rule
  exporting `{ id, severity, since, docs, rationale, fix, run(ctx) }`; `docs[0]`
  is the primary page and the only one human output prints), `src/report.mjs`
  (human and JSON), `src/review.mjs` (the runner, section 12),
  `skill/<name>/SKILL.md` for `good-agent`, `write-task`, `work-task` and
  `review-loop`, with the four review prompts at
  `skill/review-loop/references/review-{diff,story,plan,design}.md` so
  they install with the skill,
  `schema/config.json`, `schema/findings.json`, `alias/package.json`,
  `CHANGELOG.md`, `test/`, `docs/`.
- **Language**: plain ESM `.mjs` with `// @ts-check` and JSDoc types, like
  Trellis. No build step, so the published files are the tested files and
  `npx` runs them directly. Type checking runs with `tsc --noEmit` over the
  shipped `.mjs` files from two exact-pinned devDependencies, `typescript`
  and `@types/node` (without which `node:` imports and `process` do not
  resolve; it brings one small transitive dependency, `undici-types`).
  Decision: keep both. They are dev-only, from large maintainers, and the
  lockfile pins their integrity hashes; dropping them would mean typing by
  hand what the checker catches.
- **Runtime dependencies: none.** Everything needed is in Node 22:
  `node:fs`, `node:path`, `node:util.parseArgs` for flags, `node:test` for
  tests. The directory walk is hand-written (`fs.glob` is still marked
  experimental in the Node 22 line, and the walk also has to honour the
  ignore list). Front matter is the subset Copilot and the skills spec
  use: `key: value` lines, indented continuation lines folded into the
  previous value, and one level of nested map (`metadata:`); no YAML
  parser, and anything deeper is a validation error. Glob matching for `ignore` is a
  small translator to `RegExp` covering `*`, `**` and `?`.
- **Engines**: `node >= 22`.
- **License: MIT.** Trellis is MIT under "Taproot IO, LLC"; the article's
  readers expect MIT on a small CLI; Apache-2.0's patent clause buys nothing
  for a Markdown checker. Same copyright holder as Trellis.

## 10. Scope

**v0.1** (the article's five-minute setup):
`check`, `explain`, `rules`, `inspect`, `init --skill`; rules
`canonical/detect`, `canonical/name`, `codex/size-budget`,
`claude/import-canonical`, `claude/import-depth`, `claude/size`,
`links/broken`, `copilot/applyto`, `dry/copied-canonical`; config file;
`--json`; the `good-agent` skill; the `write-task`, `work-task` and
`review-loop` skills and `good-agent review` (section 12); hook and Actions
snippets, verified against the built CLI; a CI workflow on Node 22 running
`node --test`, the typecheck and the self-check; fixtures and corpus script;
Trellis-style release. Nothing ships as 0.1.0 until GA0001 to GA0004 are
done.

**v0.2**: `dry/duplicate-block`, `copilot/pointer-thin`, `refs/missing-path`,
`refs/missing-script`, `skills/copies-in-sync`, `init --config/--hook/--ci`,
`GEMINI.md` and `.cursor/rules` as instruction files once their docs are
checked the same way, `--by copilot` for the review runner.

**Later or never**: contradiction detection (skill only), autofix (`--fix`
for `claude/import-canonical` is tempting and safe; everything else edits
prose), an MCP server (Trellis has one; nothing here needs it), per-tool
"what would this tool see" rendering beyond `inspect`.

## 11. Decisions taken on 2026-11-01

Jereme asked for the recommended option on every open question and decided
three himself.

| Question | Decision |
| --- | --- |
| `canonical/name` severity | warn (true, and the root cause on taproot-controls) |
| `claude/size` severity | warn (CI should see what Claude warns about locally) |
| `copilot/pointer-thin` threshold | 2,048 bytes, v0.2 |
| `typescript` devDependency | keep, exact-pinned, dev-only, plus `@types/node` for the `node:` imports |
| Package name | **Jereme:** claim unscoped `good-agent` as the package; scoped alias keeps the namespace |
| Skill install shape | two generated copies, v0.2 rule that they match |
| `inspect` in v0.1 | yes |
| Attribution | **Jereme:** none in this repo; AGENTS.md says so |
| Vocabulary | **Jereme:** the things that read these files are "AI tools"; never agents, assistants or helpers in prose |

## 12. The task and review loops

Jereme's second request: capture how Taproot writes and works a task with
internal and external review, ship it from good-agent, and then remove the
copies from taproot and taproot-controls.

### What exists today

- **Taproot** (`docs/playbooks/work-task.md`, 40 KB): an orchestrator
  implements, dispatches the adversarial review to a fresh read-only context
  on a cost-ceilinged model, confirms every finding against the code, fixes,
  and repeats until the canonical JSON array is `[]` (cap five passes, then a
  focused confirmation, then a design review). After that, the **other AI
  tool** reviews externally through `scripts/review-exchange/`: a file mailbox
  outside every checkout, a watcher the owner leaves running in a terminal,
  and a fresh `codex exec` (or `claude -p`) per request with hooks, MCP
  servers, plugins and API keys switched off and a read-only sandbox. Tree
  digests before and after make a review void if the tree moved. Rounds are
  numbered, prior findings are passed to the next round, and the direction
  caps at ten (Codex reviewing) or five (Claude reviewing). Findings are the
  canonical `{file, line, severity, suggestion}` array. The exchange has a
  52-check (Codex) and 60-check (Claude) self-test plus an opt-in live
  denial probe that asks a real reviewer for a forbidden write.
- **Trellis** (`trellis/playbooks/`): universal `work-task`, `code-review`
  and `pr-draft` playbooks that name seam points (`regenerate`, `check`,
  `branch-naming`, `gates`, `attribution`) whose values live in each repo's
  AGENTS.md. Its work-task loop is the same shape with one internal review
  pass and no external round. taproot-controls uses these.
- **Writing a task** is not a playbook anywhere yet. Taproot's practice is
  visible in its task files and triage records: a story has a one-line
  summary, Scope with acceptance criteria, Notes with decisions and rejected
  alternatives, Risks, and it is refined against the codebase before work
  starts.

### What good-agent ships

Two playbooks and a runner. The playbooks are shipped as skills (spec-only
front matter) so every tool can discover them, and are also plain Markdown a
repo can link to.

1. **`write-task`**: review the problem against the codebase and the backlog;
   write the story (summary, scope with checkable acceptance criteria,
   notes, risks, dependencies, effort); run it through the review loop with
   the story prompt (internal until clean, then external until clean);
   finalize into the backlog.
2. **`work-task`**: read and verify the task; propose refinements; branch
   (no edit before this, so Trellis's clean-tree rule holds; Taproot's own
   loop edits the task before branching, and this loop does not); write the
   refinements and a plan with checkpoints into the task
   file on the branch; review the plan internally then externally; hand
   bounded slices to the least-cost runtime that meets the quality floor
   (Taproot's "select a runtime deliberately" and "review cost ceiling"
   sections, generalized); implement; review the work internally until
   clean, then externally until clean; close out; hand off without pushing.
3. **`review-loop`**: a skill of its own, invoked by the other two and on
   its own when someone asks for a review: fresh
   context, read-only, factual prompt, severity semantics, confirm-then-fix,
   repeat until `[]`, caps, design review on non-convergence, and the one
   durable record (round count, findings, independence) that goes into the
   task closeout. No model names in durable records.
   The prompts the loop uses live in the `review-loop` skill's
   `references/` folder, so every installed copy of the skill carries them
   and a human, a tool's own subagent and the runner all read the same
   files. The plan prompt reads the plan from a `## Plan` section the
   `work-task` skill writes into the task file before asking for review, so
   `--task` is the only input and the history id stays the task's. Each is a body (the facts to
   review, the severity semantics, the two passes, and the "close the room
   for hedging" prohibitions from Taproot's section 8) plus one of two
   endings the caller appends: the manual ending asks for a fenced JSON
   array as the final block even when empty; the runner ending asks for
   the schema object `{"findings":[...]}` that `--output-schema` and
   `--json-schema` enforce, which the runner unwraps to the bare array.
4. **`good-agent review`**: the runner. It spawns a fresh read-only reviewer
   as a child process and returns the findings:

   ```
   good-agent review --by codex|claude [--prompt diff|story|plan|design]
                     [--base <ref>] [--task <path>] [--prior <findings.json>]
                     [--model <m>] [--effort <e>] [--timeout-minutes 45] [--json]
   ```

   It carries over what Taproot's exchange already worked out: the hardened
   invocation (`codex exec --sandbox read-only --ignore-rules -c approval_policy="never"`,
   hooks, plugins and MCP servers off, API keys stripped; `claude -p` in safe
   mode with Read, Grep, Glob and a Bash that Claude's own read-only command
   validation restricts under `dontAsk`, and no Edit, Write or Agent), the
   findings schema through
   `--output-schema` and `--json-schema`, tree digests before and after, a
   per-reviewer lock so two reviews by the same reviewer never run at once,
   numbered rounds with
   `--prior`, and a reviews directory outside the tree
   (`~/.config/good-agent/reviews/<repo-slug>/<id>-<prompt>-rN.{json,meta.json,log}`),
   where a round is reserved by creating its `.meta.json` exclusively
   (`wx`) before the reviewer starts, so a Codex and a Claude review of the
   same task can never take the same round.
   Its defaults come from the `review` block of `good-agent.config.json`
   (section 4.6): `--by` from `externalReviewer` keyed by `--author`, model
   and effort from the per-tool ceiling, `--prompt` defaulting to `diff`. The
   same policy is stated in prose for AI tools in a
   `<!-- BEGIN GOOD-AGENT -->` block in AGENTS.md, hand-written in v0.1 from
   the template in `skill/review-loop/SKILL.md` (`init --config` writes it
   in v0.2), kept separate from the Trellis block so neither generator
   overwrites the other. Without `--json` the command prints a human summary
   (file, line, severity, suggestion per finding, then the count); with it,
   the bare array. The history file always holds the array. Rounds are
   numbered per task and prompt type (`<id>-<prompt>-rN`) so story, plan,
   diff and design rounds keep separate counters, and the external caps (ten with
   Codex reviewing, five with Claude) apply per prompt type and count only
   completed rounds: a round whose reviewer failed or whose tree moved
   keeps its number, records the failure in its `.meta.json`, and does not
   count toward the cap.
   The reviews directory is keyed by the repository, not the worktree:
   `<repo-slug>` is the basename of the git common directory's parent plus a
   short hash of its absolute path, so every worktree of one clone shares a
   history. The per-reviewer lock lives at the reviews root, so two reviews
   by the same reviewer never run at once, even across repositories. Review exit codes:
   0 clean, 1 findings, 2 usage or config, 3 unsafe or reviewer failure.

### The watcher question

Jereme asked whether launching the external reviewer from the command line
and waiting on the exchange is worth it for the review history, and whether
there is a better way.

The mailbox and watcher exist for two reasons the exchange README states:
each lane runs in its own worktree, so a repo-relative folder would be
invisible, and a long-lived Codex session would break the fresh-context
rule. Neither needs a watcher. A fresh `codex exec` per review is a child
process the authoring tool can spawn itself; the mailbox location outside
the tree is just a path. What the watcher adds is serialization (one review
at a time against one login) and a single place the owner sets the model.
A lock file and a config value give both.

So the recommendation is: **no watcher by default.** The authoring tool runs
`good-agent review` as a background command and gets one notification when
it returns, exactly as it waits on `wait.mjs` today, minus the terminal tab
and the polling loop. The review history is still written (findings, meta,
log, per round), because the runner writes it, not the watcher. The history
is useful for the handoff and the PR body (rounds, counts, what was waived),
and the `review-loop` skill says what from it goes into the task closeout. A
`--watch` mode can stay for people who want one host process serving many
lanes, but it is the exception.

Two further ideas, both small once the runner exists:

- **One runner, several prompts.** Story review, plan review, design review
  and diff review differ only in the prompt and the inputs. Taproot runs the
  design review through a separate hand-built dispatch; here it is
  `--prompt design`.
- **A third reviewer.** The Copilot CLI has a non-interactive mode and reads
  the same AGENTS.md. Adding it as `--by copilot` needs its sandboxing and
  structured-output story verified first; it is listed as later work, not
  promised.

### Overlap with Trellis

Trellis's `work-task` playbook and good-agent's cover the same loop. The
split that keeps both DRY: **Trellis owns the backlog lifecycle** (where an
item lives, closeout, regenerate and check) and **good-agent owns the
working and reviewing loop** (write a story, plan, dispatch, internal and
external review, the runner). good-agent's playbooks name Trellis's seam
points when Trellis is present and work without it otherwise. Trellis's own
`work-task` steps 9 and 10 (review and fix) could then defer to the
`review-loop` skill when good-agent is installed. That edit to Trellis is a
decision for Jereme and is listed in open questions; no story here touches
Trellis's playbooks. GA0006 covers the taproot and taproot-controls side.
