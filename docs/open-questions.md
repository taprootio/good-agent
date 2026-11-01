# Open questions and decisions for Jereme

Decisions already taken in [design.md](design.md) are listed at the end so
they can be overturned in one place.

## Questions

1. **`canonical/name` severity.** On taproot-controls it warns that
   `AI_GUIDELINES.md` is a name Codex and Copilot never read. It is true and
   it is the root cause of the pointer problem there. Warn by default, info,
   or off? (Design: warn.)
2. **`claude/size` severity.** It warns on Taproot (619 lines at launch via
   the import). Claude Code already warns at startup. Keep as warn so CI sees
   it, or drop to info? (Design: warn.)
3. **`copilot/pointer-thin` threshold.** 2,048 bytes lets taproot-controls'
   Copilot file through at 1,879 bytes although it carries fifteen paraphrased
   reminders. A lower threshold flags it; paraphrase itself stays with the
   skill. (Design: 2,048, v0.2.)
4. **One devDependency or none.** Design proposes plain ESM with JSDoc types
   and `typescript` exact-pinned as the only devDependency for `tsc --noEmit`.
   Trellis has no devDependencies at all. Drop it to match?
5. **Package name.** `@taprootio/good-agent` is free. Unscoped `good-agent`
   was unpublished by npm support in 2020 and is probably claimable. Scoped
   only, or claim both (the unscoped one as a redirecting stub)?
6. **Skill install shape.** Two generated copies (`.agents/skills/` for Codex
   and Copilot, `.claude/skills/` for Claude Code) versus a symlink from one
   to the other. Copies survive Windows and Claude's write-through-symlink
   refusal; symlinks have one source of truth. (Design: copies, plus a v0.2
   rule that they match.)
7. **`inspect` in v0.1.** It is the screenshot-friendly "what each tool
   sees" table and most of its logic exists for the rules anyway. Keep in
   v0.1 or defer to keep the first release small? (Design: v0.1.)
8. **Attribution policy for this repo.** Taproot and Trellis forbid AI
   co-author trailers. This repo has no AGENTS.md yet, so the design commit
   carries the default trailer. Amend before pushing if the same policy
   applies here, and the repo's own AGENTS.md should say so.
9. **Article naming.** Rule ids appear in output and will appear in the
   article. `codex/size-budget`, `claude/import-canonical`, `links/broken`,
   `dry/copied-canonical` are the ones readers will see first. Any renames
   should happen before v0.1 since ids are API.

## Decisions taken (overturnable)

- Canonical detection by inbound references, ties to `AGENTS.md`.
- Contradiction detection is skill-only; no heuristic rule.
- No Copilot size rule (no documented limit).
- Codex limit is treated as a combined chain budget with mid-file
  truncation, per the loader source, not per file.
- `info` findings hidden unless `--verbose` or `--json`.
- New rules ship as warn/info in minors; error promotion only in majors.
- MIT, same copyright line as Trellis.
- Node 22+, zero runtime dependencies, no build step.
- Config file name `good-agent.config.json`, JSON only.
