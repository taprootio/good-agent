# good-agent

Keep your AI tool instruction files DRY and inside what the tools
actually load.

> Status: design stage. Nothing is published yet. See [docs/design.md](docs/design.md).

Good tools make hard work easy. Bad tools make easy work hard.

If your repo has an `AGENTS.md` for Codex, a `CLAUDE.md` for Claude Code and a
`.github/copilot-instructions.md` for Copilot, you have three files that drift
apart, grow past what the tools will read, and point at files that no longer
exist. Keeping AI tool instructions DRY is just as important as keeping code DRY.

`good-agent` is three things:

- **A guard.** `good-agent check` fails when an instruction file breaks a rule
  that comes from the tools' own documentation: Codex truncates `AGENTS.md`
  content past 32 KiB along the directory chain, Claude Code only imports
  files through `@path`, Copilot ignores a `.instructions.md` file without
  `applyTo`, and so on. Runs locally, in a pre-commit hook and in CI.
- **A skill.** A `SKILL.md` that teaches an AI tool how to set the files up
  (one canonical file, thin tool files, long material in linked docs) and how
  to audit them for the things a guard cannot see, such as a delta file that
  contradicts the canonical one.
- **The loop.** Playbooks for writing a task and working a task with an
  internal review loop and an external review by the other AI tool, and
  `good-agent review`, which runs that external reviewer fresh and read-only
  and returns its findings as JSON.

Zero runtime dependencies. Node 22 or later. MIT.

## Five-minute setup

```bash
npx good-agent check
```

That is the whole setup for the guard. It finds your instruction files, works
out which one is canonical (the one the others point at), and reports.

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

▲ CLAUDE.md  claude/size
  Claude Code loads 619 lines at launch (CLAUDE.md 29 + AGENTS.md 590 via
  @import); the docs recommend under 200 lines per file because longer files
  reduce adherence.
  fix: Move reference material into docs/ linked by path (not @-imported), or
  into skills and path-scoped .claude/rules that load on demand.
  docs: https://code.claude.com/docs/en/memory

1 error, 1 warning  (exit 1)
```

Or, on a repo whose `CLAUDE.md` says "see AI_GUIDELINES.md" in prose:

```
✖ CLAUDE.md  claude/import-canonical
  CLAUDE.md links to AI_GUIDELINES.md as a Markdown link, which Claude Code
  only follows if it decides to open the file. Claude Code imports a file
  only through `@path` syntax.
  fix: Replace the pointer with a line containing `@AI_GUIDELINES.md`; keep
  Claude-only notes below it.
  docs: https://code.claude.com/docs/en/memory
```

A clean repo prints one line and exits 0.

Then, if you want the skill in the repo for Claude Code, Codex and Copilot:

```bash
npx good-agent init --skill
```

And in CI:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx good-agent@0.1 check
```

## The layout it enforces

1. One canonical file, `AGENTS.md`. Codex and Copilot read it natively;
   Claude Code reads it when there is no `CLAUDE.md`, or through an import.
2. `CLAUDE.md` is `@AGENTS.md` plus anything Claude-only.
3. `.github/copilot-instructions.md` is a short pointer plus anything
   Copilot-only, because Copilot has no import on GitHub.com.
4. `.github/instructions/*.instructions.md` files carry per-language deltas
   with an `applyTo` glob and never restate the canonical file.
5. Long material lives in `docs/` and is linked by path. Links cost no
   context until an AI tool opens them; imports cost context every session.

## Rules

| Rule | Default | Checks |
| --- | --- | --- |
| `canonical/detect` | error | A canonical file exists or is configured. |
| `canonical/name` | warn | It is named `AGENTS.md`, the one name every tool reads. |
| `codex/size-budget` | error | Every root-to-directory chain of `AGENTS.md` files fits Codex's 32 KiB combined budget. Reports where the cut lands. |
| `claude/import-canonical` | error | `CLAUDE.md` imports the canonical file with `@path`, not a link or a sentence. |
| `claude/import-depth` | warn | No import chain deeper than Claude's four hops. |
| `claude/size` | warn | Claude's launch set (CLAUDE.md, imports, rules) is under 200 lines. |
| `links/broken` | error | Relative links and `@` imports resolve. |
| `copilot/applyto` | error | Path-specific instruction files have valid `applyTo` front matter. |
| `dry/copied-canonical` | error | No tool file is a copy of the canonical file. |

Planned for 0.2: `dry/duplicate-block`, `copilot/pointer-thin`,
`refs/missing-path`, `refs/missing-script`.

`good-agent explain <rule>` prints the rationale, the fix and the doc it
rests on. Every rule cites the tool's documentation; nothing here is a guess
about how a tool behaves.

## Configuration

Optional. `good-agent.config.json` at the repo root:

```json
{
  "canonical": "AGENTS.md",
  "ignore": ["vendor/**"],
  "limits": { "codexBytes": 32768, "claudeLines": 200 },
  "rules": { "canonical/name": "off" }
}
```

## Commands and flags

```
good-agent check [--json] [--strict] [--verbose] [--rule id] [--config file] [path...]
good-agent inspect [--json]      what each tool loads, with sizes
good-agent explain <rule>
good-agent rules
good-agent init --skill
```

Exit codes: 0 pass, 1 findings, 2 usage or config error.

With paths, `check` runs only when one of them is an instruction file or a
file an instruction file links to, so a pre-commit hook or a
changed-paths verifier can pass it everything and let it decide:

```sh
git diff --cached --name-only | xargs npx --no-install good-agent check
```

## What it does not do

It does not read your files for meaning. A delta file that contradicts
`AGENTS.md` in different words, a command that exists but no longer does what
the file says, a paraphrased duplicate: those need a model. The bundled skill
walks an AI tool through that audit, and Claude Code users can also run
`/doctor prompt-audit`.

## Related

`agents-md-lint` and `agents-lint` on npm lint a single `AGENTS.md` for
structure and stale references. `good-agent` is about the set of files and
what each tool loads from them.

## License

MIT
