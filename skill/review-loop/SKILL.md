---
name: review-loop
description: Run the review loop on a story, a plan, a design or a diff: a
  fresh read-only reviewer, findings confirmed against the cited code before
  any fix, repeated until the findings array is empty, first internally and
  then externally by the other AI tool. Use when asked to review work, when
  the write-task or work-task skill reaches a review step, or when a change
  needs a second opinion before it is handed off.
license: MIT
metadata:
  package: good-agent
---

# The review loop

The author never grades its own work. Every review runs in a fresh context
that did not author the change, reads only facts, cannot edit, and returns
one JSON array. The loop ends when that array is empty.

## Inputs

- The subject: a story file, a task file with a `## Plan` section, a design
  note, or a diff against a named base commit. Never the author's summary.
- The prompt for the subject: [review-story.md](references/review-story.md),
  [review-plan.md](references/review-plan.md),
  [review-design.md](references/review-design.md) or
  [review-diff.md](references/review-diff.md). Each is a body plus two
  endings; append exactly one (see "Endings").
- The repository's conventions: the canonical instruction file first.
- Prior findings, when this is round two or later.

## The loop

1. **Fresh context.** Dispatch the review to a context with none of the
   authoring conversation: a new subagent, a new session, or the runner.
   It receives the prompt and the facts (subject path, base and head
   commits, changed-file scope, which verification already passed). It
   never receives implementation summaries, rationalisations or suspected
   findings; those anchor the reviewer.
2. **Read-only.** The reviewer may read, search and run read-only git
   commands. No edits, no state-changing commands, no re-verification. The
   runner enforces this with a sandbox; a manual dispatch states it in the
   prompt and records the tree digest before and after.
3. **Confirm before fixing.** For every finding, open the cited file and
   trace the claimed failure. Reject hallucinations, duplicates, behaviour
   already guaranteed elsewhere, and style-only advice. Merge overlapping
   confirmed findings.
4. **Fix.** Every confirmed blocker and warning; nits by default. Keep the
   narrow checks that prove the fix green. Do not run the slow gates
   between rounds; they run once on the final candidate.
5. **Repeat with everything.** The next round gets the whole current
   subject, not only the previous finding locations, plus the prior
   findings to verify. Internally, repeat until the array is `[]`, capped
   at five passes, then one focused confirmation of the cited fixes only.
6. **External round.** When the internal loop is clean, the other AI tool
   reviews the same subject with the same prompt. Codex reviews
   Claude-authored work and Claude reviews Codex-authored work. Fix and
   confirm internally as in steps 3 and 4, then file the next external
   round with the prior findings. Caps: ten rounds with Codex reviewing,
   five with Claude, counted per prompt type; a failed or unsafe round
   keeps its number and does not count.
7. **Non-convergence.** When a cap is reached with findings left, or the
   same area keeps producing defects, stop patching and run a design review
   ([review-design.md](references/review-design.md)) against the task's
   contracts; a design blocker means the design changes before any further
   patch. Surface it to the owner if that does not settle
   the matter.

## Endings

`<!-- ENDING: manual -->` asks for a fenced JSON array as the final block
even when empty; use it for a reviewer run by hand or by a tool's own
subagent. `<!-- ENDING: runner -->` asks for the schema object
`{"findings":[...]}` that structured output enforces; `good-agent review`
appends it and unwraps the result. Severities are `blocker` (breaks a
contract, the build or the workflow), `warning` (a real defect with a
bounded failure path) and `nit` (a definite small improvement). Every item
is `{file, line, severity, suggestion}` with the smallest safe fix.

## Running the external round

With good-agent installed:

```
npx good-agent review --by codex --prompt diff --base <start sha> --task trellis/active/<id>.md --verified "npm test"
npx good-agent review --by codex --prompt story --task trellis/active/<id>.md
```

`--by` defaults from the `review` block of `good-agent.config.json`
(`externalReviewer` keyed by `--author`), as do the model and effort. The
runner spawns the reviewer fresh in a read-only sandbox, strips API keys,
records tree digests, reserves a numbered round, validates the findings
and prints them (`--json` for the bare array). History lives outside the
tree under `~/.config/good-agent/reviews/`.

Without good-agent installed, run the other tool's CLI by hand with the
same prompt file from `references/` and the runner ending, for example
`codex exec --sandbox read-only --ignore-rules -c approval_policy="never"
--output-schema <schema> -o <out> - < prompt.txt`, and check the tree
digest yourself before and after.

## The durable record

The task's closeout records what a reader can act on: that the review was
independent of the authoring context, the round count per loop, the
findings and their dispositions (fixed, rejected with reason, waived by
whom). It never credits a model, vendor or runtime; runtime choice is an
operational detail that belongs in configuration, not in the record.

## The GOOD-AGENT block

A repository states its review policy for AI tools in its canonical file,
outside any other tool's generated block, matching the `review` block of
`good-agent.config.json`:

```
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
```
