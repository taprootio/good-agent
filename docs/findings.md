# Findings: the proposed rules against three real repos

Date: 2026-11-01. The checks were run by a throwaway prototype of the rule set
in [design.md](design.md) section 3 (a single read-only Node script, not the
implementation). The repos were not modified. Outputs below are the
prototype's, trimmed only of the per-file size listing.

Target from the brief: Taproot fails on size, taproot-controls fails on the
pointer, www.jeremeevans.com passes, with no noise. Result: met.

Corpus commits: taproot `23496ea60` (2026-10-30), taproot-controls
`b0f84baf`; www.jeremeevans.com is not a git repository, so its `AGENTS.md`
is identified by size and date (13,455 bytes, modified 2026-11-01). GA0001's
corpus acceptance is checked at these commits.

## Summary

| Rule | taproot | taproot-controls | www.jeremeevans.com |
| --- | --- | --- | --- |
| `canonical/detect` | `AGENTS.md` (2 inbound) | `AI_GUIDELINES.md` (3 inbound) | `AGENTS.md` (1 inbound) |
| `canonical/name` | pass | **warn**: canonical is not `AGENTS.md` | pass |
| `codex/size-budget` | **error**: 34,348 B, cut at byte 32,768 | pass (`AGENTS.md` is 4,582 B) | pass (13,455 B) |
| `claude/import-canonical` | pass (`@AGENTS.md`) | **error**: Markdown link, not an import | pass (`@AGENTS.md`) |
| `claude/import-depth` | pass | pass | pass |
| `claude/size` | **warn**: 619 lines at launch | pass (11 lines) | pass (97 lines) |
| `links/broken` | pass (23 link targets, all exist) | pass (23 targets in `AI_GUIDELINES.md`, all exist) | pass |
| `copilot/applyto` | pass (3 files, all have `applyTo`) | no `.instructions.md` files | no `.github` |
| `dry/copied-canonical` | pass | pass | pass |
| `dry/duplicate-block` (v0.2) | pass | pass after pointer-sentence exemption | pass |
| `copilot/pointer-thin` (v0.2) | pass (438 B) | pass (1,879 B, under 2,048) | no file |
| `refs/missing-path` (v0.2) | pass after ignored-dir exemption | pass | pass |
| `refs/missing-script` (v0.2) | pass (6 scripts, all in some package.json) | pass (4 scripts) | no package.json |
| **Exit** | **1** | **1** | **0** |

## taproot

Instruction files found: `AGENTS.md` (34,348 B), `CLAUDE.md` (1,575 B),
`.github/copilot-instructions.md` (438 B), `.github/instructions/csharp.instructions.md`
(7,189 B), `.github/instructions/proto.instructions.md` (1,275 B),
`.github/instructions/typescript.instructions.md` (6,815 B). `AGENTS.md` was
last changed 2026-10-30.

```
good-agent (prototype) · 6 instruction files · canonical AGENTS.md

✖ AGENTS.md  codex/size-budget
  Codex loads at most 32,768 bytes of AGENTS.md content along the chain AGENTS.md (34,348 bytes). It truncates AGENTS.md at byte 32,768 (line 565, inside "## Area-specific architecture"); the last 1,580 bytes never reach Codex.
  fix: Move long sections into docs/ and link them from AGENTS.md, or split guidance into nested AGENTS.md files closer to the code they govern.

▲ CLAUDE.md  claude/size
  Claude Code loads 619 lines at launch (CLAUDE.md 29 + AGENTS.md 590 via @import); the docs recommend under 200 lines per file because longer files reduce adherence.
  fix: Move reference material into docs/ linked by path (not @-imported), or into skills and path-scoped .claude/rules that load on demand.

1 errors, 1 warnings, 0 info  (exit 1)
```

Notes:

- The size finding is the one the brief predicted. The cut lands three lines
  into "## Area-specific architecture" (heading at line 562), the last
  section, mid-sentence in the deployable-settings rule. Codex never sees the
  rest of that rule or the outbox-saga, checkout-lane, member-content, SEO,
  image-processing, place-review and email-template pointers that follow. The
  fix is the one `AGENTS.md` already practises elsewhere: move the section's
  bullets into the `docs/architecture/` files they already link to and keep
  one line each.
- `claude/size` is the same fact seen from Claude's side: the `@AGENTS.md`
  import makes the launch set 619 lines. Claude Code warns about this itself
  at startup, which is why the rule is a warning.
- Two findings were tuned away during the run and are now part of the design:
  - `refs/missing-path` first reported
    `node_modules/@taprootio/espalier/espalier.token-manifest.json`. The path
    is real after `npm install`. Paths whose first segment is an ignored
    directory are now skipped.
  - `refs/missing-script` would have reported `check-cem`,
    `generate-open-api-clients`, `snapshot-openapi` and `typecheck` if it only
    read the root `package.json`. They live in workspace packages. The rule
    reads every `package.json` outside ignored directories.
- Backtick paths such as `Taproot.Domain/Commands/CommandHandler.cs`,
  `common/rendering.ts`, `completed/index.md`, `TRxxxxx.md` and `report.json`
  do not exist at the repo root and are correctly ignored by the first-segment
  test.
- The historical proto drift (delta file: every RPC carries `google.api.http`;
  `AGENTS.md`: internal RPCs omit it) is not detectable by any rule here. The
  current `proto.instructions.md` is correct and says both things. This case
  is the worked example in the skill's audit procedure.

## taproot-controls

Instruction files found: `AI_GUIDELINES.md` (30,502 B), `AGENTS.md` (4,582 B),
`CLAUDE.md` (421 B), `.github/copilot-instructions.md` (1,879 B).

```
good-agent (prototype) · 4 instruction files · canonical AI_GUIDELINES.md

▲ AI_GUIDELINES.md  canonical/name
  Canonical file is AI_GUIDELINES.md, which Codex and Copilot do not read natively; they only see written pointers to it.
  fix: Rename it to AGENTS.md (Codex, Copilot and Claude Code all read that name) and keep CLAUDE.md as `@AGENTS.md`.

✖ CLAUDE.md  claude/import-canonical
  CLAUDE.md links to AI_GUIDELINES.md as a Markdown link, which Claude Code only follows if it decides to open the file. Claude Code imports a file only through `@path` syntax.
  fix: Replace the pointer with a line containing `@AI_GUIDELINES.md`; keep Claude-only notes below it.

1 errors, 1 warnings, 0 info  (exit 1)
```

Notes:

- The pointer finding is the one the brief predicted. `CLAUDE.md` links to
  `AI_GUIDELINES.md` with a Markdown link; the Claude docs only load files
  through `@path`. The fix is a one-line change.
- `canonical/name` is new and is the real underlying problem: Codex reads
  `AGENTS.md` only, so in this repo Codex sees the Tilt notes and the Trellis
  block and a sentence telling it to read `AI_GUIDELINES.md`. Whether that
  should be a warning, an info line or off by default is an open question for
  Jereme; the prototype runs it as a warning.
- The Trellis-generated block in `AGENTS.md` (2,805 B between
  `<!-- BEGIN TRELLIS -->` and `<!-- END TRELLIS -->`) produced no findings.
  The design treats such blocks as generated for `dry/*` rules and annotates
  any finding inside them.
- `dry/duplicate-block` first reported the sentence "The canonical shared AI
  guidance for this repository lives in [AI_GUIDELINES.md]" because
  `AGENTS.md` and `CLAUDE.md` both open with it. That is a pointer sentence
  doing its job; blocks that link to or import the canonical file are now
  exempt.
- `copilot/pointer-thin` does not fire at 1,879 B against a 2,048 B default.
  The file has about fifteen bullets of real reminders, each a paraphrase of
  something in `AI_GUIDELINES.md`. Paraphrase is beyond the guard; the skill's
  audit step covers it. If Jereme wants this file flagged, the threshold is
  the knob.

## www.jeremeevans.com

Instruction files found: `AGENTS.md` (13,455 B, 96 lines), `CLAUDE.md`
(11 B, exactly `@AGENTS.md`).

```
good-agent (prototype) · 2 instruction files · canonical AGENTS.md

0 errors, 0 warnings, 0 info  (exit 0)
```

Notes:

- Clean on every rule, including the v0.2 ones. `AGENTS.md` names paths in
  the Taproot repo (`docs/playbooks/write-article.md`, `scripts/verify-changed.sh`,
  `ux/scripts/check-no-raw-fetch.mjs`) that do not exist here; the
  first-segment test skips them because `docs/`, `scripts/` and `ux/` are not
  directories in this repo. Paths that do resolve (`tools/pmblocks.py`,
  `taproot-site.json`) exist.
- The repo is not a git repository, which the guard does not need.

## Other repos run for noise

- **Trellis** (`AGENTS.md` only, no `CLAUDE.md`): one `info` line, hidden by
  default, saying Claude Code 2.1.277+ reads `AGENTS.md` directly and older
  versions load nothing. Exit 0.
- **good-agent** (this repo, empty): `canonical/detect` error, exit 1, as it
  should until an `AGENTS.md` exists.

## Synthetic cases

Run against throwaway fixtures to confirm the rules fire when they should.
These become `test/fixtures/` in the implementation.

| Fixture | Result |
| --- | --- |
| `CLAUDE.md` is a byte copy of `AGENTS.md` | `claude/import-canonical` error ("does not reference AGENTS.md at all") and `dry/copied-canonical` error ("61 of 61 substantive lines"). The prototype also emitted eighteen `dry/duplicate-block` warnings; the design suppresses those for a pair already reported as copied. |
| Root `AGENTS.md` 20,000 B plus `api/AGENTS.md` 15,000 B | `codex/size-budget` error on `api/AGENTS.md`: chain `AGENTS.md → api/AGENTS.md` is 35,000 B, cut at byte 12,768 of the nested file (line 225, inside "### AI task tracking"), 2,232 B lost. This is the combined-budget behaviour from the Codex loader source. |
| `AGENTS.md` links to `docs/missing.md`; `CLAUDE.md` imports `@docs/nope.md`; a `.instructions.md` file with no front matter | Three errors: `links/broken` on the link, `links/broken` on the import (with the "silently loads nothing" wording), `copilot/applyto`. |
