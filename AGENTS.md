# AGENTS.md for good-agent

`good-agent` is an npm package that keeps AI tool instruction files DRY and
inside what each tool actually loads. It ships a guard (the `good-agent` CLI)
and a skill. This file is the canonical instruction file for the repository;
`CLAUDE.md` imports it and `.github/copilot-instructions.md` points at it.

Good tools make hard work easy. Bad tools make easy work hard.

## Words

- The things that read these files are **AI tools** (or AI tooling): Claude
  Code, Codex, Copilot and the rest. Do not call them agents, assistants,
  helpers or models in prose. `AGENTS.md` and "Agent Skills" are proper names
  and stay as they are.
- Keeping AI tool instructions DRY is as important as keeping code DRY. One
  canonical file per repo; every tool reads it by import where it can and by
  a short pointer where it cannot; long material lives in linked docs.

## How this repo is built

- Plain ESM (`.mjs`) with `// @ts-check` and JSDoc types. No build step: the
  published files are the tested files. Node 22 or later.
- Zero runtime dependencies. A devDependency needs a one-line justification
  in the PR and an exact version pin. Prefer Node built-ins (`node:test`,
  `node:util` `parseArgs`, `node:fs`).
- Layout follows [Trellis](https://github.com/taprootio/trellis):
  `scripts/<bin>.mjs` dispatches to `src/`, tests in `test/` with fixture
  repos under `test/fixtures/`, run with `node --test`.
- Every claim about how an AI tool behaves cites its documentation with the
  date checked. If the docs do not say it, the guard does not enforce it.
  [docs/design.md](docs/design.md) holds the citations.

## Working here

- Design first. [docs/design.md](docs/design.md) is the design of record;
  change it in the same PR as the behaviour it describes.
- Commit messages and PR descriptions carry no AI attribution: no
  `Co-Authored-By:` trailers, no "Generated with" footers. The repo's own
  `attribution` value below is `none`.
- Work a task with the loop in [skill/work-task/SKILL.md](skill/work-task/SKILL.md)
  and review it with [skill/review-loop/SKILL.md](skill/review-loop/SKILL.md):
  internal review until clean, then an external round by the other AI tool
  (Codex reviews Claude's work, Claude reviews Codex's). Never push or
  publish without the owner.
- Prose style: plain words, short sentences, no em dashes. Code, commands and
  error text go in fenced blocks.

<!-- BEGIN GOOD-AGENT -->
## Review policy (good-agent)

Work is reviewed with the `review-loop` skill: internally in a fresh
context until clean, then externally by the other AI tool until clean.
Claude-authored work is reviewed by Codex and Codex-authored work by
Claude (`review.externalReviewer` in `good-agent.config.json`). Review
runs at the configured ceiling (`review.codex`, `review.claude`); never
raise it without the owner. Closeouts record independence, rounds and
dispositions, never a model name.
<!-- END GOOD-AGENT -->

<!-- BEGIN TRELLIS -->
## Backlog (Trellis)

This repo uses [Trellis](https://github.com/taprootio/trellis) for a file-based
backlog. Work items live in `trellis/{active,completed/tasks,removed}/` as
Markdown files with YAML front-matter; ids are `GA` + 4 digits.

- `trellis/README.md`, `trellis/backlog.json`, and the
  `trellis/completed/index.md` / `trellis/removed/index.md` indexes are
  **generated** — never hand-edit between the `BEGIN/END GENERATED` markers.
- Per-repo vocabulary (id prefix, milestones, priorities, effort) lives in
  `trellis/backlog.config.json` (the backlog root is `trellis/` by default;
  override it with a `tasksDir` key).
- The team roster lives in `trellis/team.json` (members with a `handle`, `name`,
  optional `email`, and `status`). A task may set an optional `owner` (one handle)
  and `collaborators` (handles); on active items they must be active roster members.
- After adding, moving, or editing an item, regenerate with `npx @taprootio/trellis generate`;
  CI runs `npx @taprootio/trellis check`.
- `main` is protected — work on a branch, open a PR, and let the backlog check
  (the pinned `backlog` job) gate the merge. Enable the gate with the recipe in
  `trellis/branch-protection.md` (GitHub plus GitLab/Bitbucket/Azure DevOps).
- Commit messages and PR descriptions carry no AI/co-author attribution — never
  add `Co-Authored-By:` trailers or "Generated with …" footers.

### Loop contract

The playbooks in `trellis/playbooks/` are universal; they name **seam points** and
read this repo's values from here. See `trellis/playbooks/conventions.md` for the
contract, then set these to match your tooling:

| seam point | this repo's value |
| --- | --- |
| `regenerate` | `npx @taprootio/trellis generate` |
| `check` | `npx @taprootio/trellis check` |
| `branch-naming` | `<initials>/<id-lowercase>/<slug>` (e.g. `je/ga0001/short-slug`) |
| `gates` | `npx @taprootio/trellis check` + `node --test` + `npm run typecheck` + `node scripts/good-agent.mjs check` |
| `attribution` | none — no `Co-Authored-By:` trailers or "Generated with …" footers |

See `trellis/playbooks/` for the work-a-task and code-review loops.
<!-- END TRELLIS -->
