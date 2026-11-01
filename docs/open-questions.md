# Open questions and decisions for Jereme

The first round of questions was answered on 2026-11-01; the answers are in
[design.md](design.md) section 11. These are what remain.

## Questions

1. **Trellis's own playbooks.** good-agent's `work-task` and Trellis's cover
   the same loop. The proposed split is Trellis owns the backlog lifecycle
   and good-agent owns the working and reviewing loop, with Trellis's
   review steps deferring to good-agent's `review-loop` skill when it is
   installed. That is a change to the Trellis repo. Agree, or keep the loop
   in Trellis and have good-agent ship only the runner?
2. **Where review history lives.** The runner writes findings, meta and logs
   per round outside the tree (`~/.config/good-agent/reviews/<repo>/`), as
   Taproot's exchange does, and the task closeout records the round count
   and dispositions. Is anything else from the history wanted in the repo
   (for instance the final round's findings file committed next to the
   task)?
3. **Default external reviewer model and effort.** Resolved by
   recommendation: the shipped defaults are Codex at `medium` on the user's
   own configured model, and Claude `sonnet` at `high`, which are Taproot's
   owner decisions from September 2026. A repo overrides them in the `review`
   block of `good-agent.config.json`. Say so if you want different ones.
4. **The unscoped name may be blocked.** npm support unpublished `good-agent`
   in 2020, which can mean a takedown rather than an owner request. GA0005
   publishes a placeholder to find out. If it is refused, the fallback is
   `@taprootio/good-agent` as the package with the `good-agent` bin, which is
   what the first design assumed.
5. **wtfm for documentation.** Not recommended now: wtfm documents component
   libraries from a Custom Elements Manifest through Eleventy, and this
   package has no components. README plus `docs/` is enough for v0.1 and the
   article. Revisit if a docs site is wanted for the rules reference.

## Decisions taken (overturnable)

- Canonical detection by inbound references, ties to `AGENTS.md`.
- Contradiction detection is skill-only; no heuristic rule.
- No Copilot size rule (no documented limit).
- Codex limit is a combined chain budget with mid-file truncation, per the
  loader source.
- `info` findings hidden unless `--verbose` or `--json`.
- New rules ship as warn or info in minors; error promotion only in majors.
- MIT, same copyright line as Trellis.
- Node 22+, zero runtime dependencies, two exact-pinned devDependencies
  (`typescript`, `@types/node`), no build step.
- Config file name `good-agent.config.json`, JSON only.
- No watcher by default for external review; the runner is a child process
  of the authoring tool.
