# Changelog

All notable changes to good-agent. The format follows Keep a Changelog; the
project uses semantic versioning. A rule's id, default severity, the JSON
shape and the config schema are the public API (docs/design.md section 8):
a new rule ships at `warn` or `info` in a minor version and becomes `error`
only in a major; a limit changes in a minor with the doc link and date here.

## 0.1.0 (unreleased)

First release.

### The guard

`good-agent check`, `inspect`, `explain`, `rules`, `init --skill` and
`review`. Nine rules, each citing the documentation it rests on (checked
2026-11-01):

- `canonical/detect` (error): a canonical instruction file exists or is
  configured. Codex, Claude Code and Copilot docs.
- `canonical/name` (warn): it is named `AGENTS.md`, the one name every tool
  reads. Codex AGENTS.md guide; Copilot repository instructions; Claude Code
  memory.
- `codex/size-budget` (error): every root-to-directory chain of `AGENTS.md`
  files fits Codex's 32 KiB combined `project_doc_max_bytes` budget. Codex
  AGENTS.md guide and `codex-rs/core/src/agents_md.rs`.
- `claude/import-canonical` (error): `CLAUDE.md` imports the canonical file
  with `@path`, not a link or a sentence. With no `CLAUDE.md` and an
  `AGENTS.md` canonical file it reports an info finding instead (Claude Code
  2.1.277 and later read `AGENTS.md` directly). Claude Code memory.
- `claude/import-depth` (warn): no import chain deeper than four hops.
  Claude Code memory.
- `claude/size` (warn): every file Claude Code loads at launch is under 200
  lines; an info line when only the total is over. Claude Code memory and
  costs.
- `links/broken` (error): relative links and `@` imports resolve. Claude
  Code memory; VS Code custom instructions.
- `copilot/applyto` (error): path-specific instruction files have valid
  `applyTo` front matter. Copilot repository instructions.
- `dry/copied-canonical` (error): no tool file is a copy of the canonical
  file. Claude Code memory; Codex AGENTS.md guide.

### The skills

`good-agent` (set up and audit instruction files), `write-task`,
`work-task` and `review-loop`. `good-agent init --skill` installs all four
into `.agents/skills/` (Codex, Copilot) and `.claude/skills/` (Claude Code),
marks each copy as generated, and refuses to overwrite a hand-edited copy
unless `--force` is given.

### The review runner

`good-agent review` runs a fresh, read-only Codex or Claude Code review of a
story, plan, design or diff, with the findings schema enforced and a
numbered history outside the tree.
