# Completed tasks

Generated from `completed/tasks/`. Do not hand-edit between the markers — close
a task and regenerate (`npx @taprootio/trellis generate`).

<!-- BEGIN GENERATED:COMPLETED -->
| ID | Title | Summary | Completed |
| --- | --- | --- | --- |
| [GA0008](tasks/GA0008.md) | Make `good-agent check` honour .gitignore | Inside a git work tree, enumerate candidate instruction files from git so ignored files, such as per-session worktrees under .claude/worktrees, are not checked; keep the directory walk as the fallback and keep explicit command-line paths checked as given. | 2026-11-02 |
| [GA0009](tasks/GA0009.md) | Show why a reviewer failed in `good-agent review` | When a reviewer exits non-zero, print the cause from its output, the round's log path, and the model, effort and where the model came from, with a hint for a refused model, instead of only "codex exited 1". | 2026-11-02 |
| [GA0010](tasks/GA0010.md) | Release 0.2.0 | Bump `package.json` to 0.2.0 so the release workflow publishes the gitignore-aware guard and the reviewer failure output that GA0008 and GA0009 merged. | 2026-11-02 |
| [GA0001](tasks/GA0001.md) | Build the guard (`good-agent check`) v0.1 | Ship the `good-agent` CLI with the nine v0.1 rules, canonical-file detection, config, human and JSON output, fixtures per rule, and the corpus script, as designed in docs/design.md. | 2026-11-01 |
| [GA0002](tasks/GA0002.md) | Ship the instruction-hygiene skill and `init --skill` | Write the `good-agent` SKILL.md that teaches an AI tool to set up and audit instruction files, and the `init --skill` command that installs it for Claude Code, Codex and Copilot. | 2026-11-01 |
| [GA0003](tasks/GA0003.md) | Write the write-task and work-task playbooks with the review loop | Capture Taproot's story-writing and task-working loops as universal good-agent playbooks (shipped as skills) with a shared review-loop section covering internal review until clean and external review by the other AI tool until clean. | 2026-11-01 |
| [GA0004](tasks/GA0004.md) | Build `good-agent review`, the fresh read-only external reviewer | A runner that spawns a fresh, read-only Codex or Claude Code review of a story, plan, design or diff, validates the findings against the schema, records digests and rounds, and returns the JSON, replacing Taproot's mailbox-and-watcher exchange. | 2026-11-01 |
| [GA0005](tasks/GA0005.md) | Claim the npm names and set up the release workflow | Publish `good-agent` (unscoped) as the package, `@taprootio/good-agent` as a thin alias, and copy Trellis's version-bump release workflow with trusted publishing. | 2026-11-01 |
<!-- END GENERATED:COMPLETED -->
