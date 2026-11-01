# Review record: stories GA0001 to GA0006

The build stories were written on 2026-11-01 and taken through the loop
the stories themselves describe: internal review in a fresh context until
no blockers remained, then external review by the other AI tool until
clean, with each external round's fixes confirmed by a fresh internal pass.
This file is the durable record; the per-round findings live in the
commits named below. No model or vendor is credited for the work.

## Internal rounds (fresh read-only context, story prompt)

| Round | On commit | Blockers | Warnings | Nits | Fixed in |
| --- | --- | --- | --- | --- | --- |
| 1 | 49f21dd | 2 | 23 | 6 | f2c5294 |
| 2 | f2c5294 | 0 | 13 | 9 | 0f0bc30 |
| 3 | 0f0bc30 | 1 | 13 | 10 | 1e6336d |
| 4 | 1e6336d | 0 | 6 | 10 | af2cd4d |

Round 1's blockers: installed skill copies would have started with an HTML
comment, which breaks the Agent Skills `---`-first rule; GA0003 both
required and forbade editing Trellis's playbooks. Round 3's blocker: the
release workflow copied from Trellis would have published `0.0.0` on its
first merge.

## External rounds (other AI tool, read-only sandbox, schema-constrained)

| Round | On commit | Blockers | Warnings | Nits | Fixed in | Confirmed by |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | af2cd4d | 3 | 6 | 0 | 7354c57 | internal focused pass (16 follow-ups, fixed in e2d2462) |
| 2 | 7354c57 | 2 | 4 | 0 | bee9c11 | |
| 3 | bee9c11 | 2 | 2 | 0 | e2d2462 | internal focused pass (15 follow-ups, fixed in 8cbfc79) |
| 4 | e2d2462 | 2 | 1 | 0 | 781d570 | |
| 5 | 781d570 | 1 | 1 | 0 | c3d9db4 | internal focused pass (see below) |
| 6 | c3d9db4 | | | | | |

The external rounds caught what the internal ones had not: the review
prompts demanded a fenced array while the runner demanded a schema object;
`claude/size` enforced a combined line budget the docs do not define; the
alias bin imported a module that never runs on import; the plan step
edited the tree before the branch existed; the typecheck could not resolve
`node:` imports without `@types/node`; and the claim that cwd-only
discovery "matches Codex" was false.

## Dispositions

Every blocker and warning was confirmed against the cited file and fixed.
Nits were fixed by default. No finding was waived. The tree digest was
unchanged after every external round.
