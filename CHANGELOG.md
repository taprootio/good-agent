# Changelog

All notable changes to good-agent. The format follows Keep a Changelog; the
project uses semantic versioning. A rule's id, default severity, the JSON
shape and the config schema are the public API (docs/design.md section 8):
a new rule ships at `warn` or `info` in a minor version and becomes `error`
only in a major; a limit changes in a minor with the doc link and date here.

## Unreleased

### Changed

- `good-agent review` explains a reviewer failure. When the reviewer exits
  non-zero it prints the lines of its output that report the error, the model
  and effort passed and where the model came from (or that Codex's own
  default applied), and a hint to set `review.codex.model`,
  `review.claude.model` or `--model` when the model is refused
  (`model_not_found` or "model is not supported"). `.meta.json` gains `model_source`. (GA0009)

## 0.1.0 (2026-11-01)

First release.

### The guard

`good-agent check`, `inspect`, `explain`, `rules`, `init --skill` and
`review`. Nine rules, each citing the documentation it rests on (checked
2026-11-01):

- `canonical/detect` (error): a canonical instruction file exists or is
  configured. Sources: [Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md); [Claude Code memory](https://code.claude.com/docs/en/memory);
  [Copilot repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions).
- `canonical/name` (warn): it is named `AGENTS.md`, the one name every tool
  reads. Sources: [Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md); [Copilot repository
  instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions); [Claude Code memory](https://code.claude.com/docs/en/memory).
- `codex/size-budget` (error): every root-to-directory chain of `AGENTS.md`
  files fits Codex's 32 KiB combined `project_doc_max_bytes` budget. Sources:
  [Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md); [`agents_md.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs).
- `claude/import-canonical` (error): `CLAUDE.md` imports the canonical file
  with `@path`, not a link or a sentence. With no `CLAUDE.md` and an
  `AGENTS.md` canonical file it reports an info finding instead (Claude Code
  2.1.277 and later read `AGENTS.md` directly). Source: [Claude Code memory](https://code.claude.com/docs/en/memory).
- `claude/import-depth` (warn): no import chain deeper than four hops.
  Source: [Claude Code memory](https://code.claude.com/docs/en/memory).
- `claude/size` (warn): every file Claude Code loads at launch is under 200
  lines; an info line when only the total is over. Sources: [Claude Code
  memory](https://code.claude.com/docs/en/memory); [Claude Code costs](https://code.claude.com/docs/en/costs).
- `links/broken` (error): relative links and `@` imports resolve. Sources:
  [Claude Code memory](https://code.claude.com/docs/en/memory); [VS Code custom
  instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions).
- `copilot/applyto` (error): path-specific instruction files have valid
  `applyTo` front matter. Source: [Copilot repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions).
- `dry/copied-canonical` (error): no tool file is a copy of the canonical
  file. Sources: [Claude Code memory](https://code.claude.com/docs/en/memory); [Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md).

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
