---
name: work-task
description: Take a backlog task from active to ready for the owner's
  review: ground in the repository's conventions, read and verify the task,
  plan with checkpoints, review the plan internally then externally, branch,
  dispatch bounded slices at the least-cost runtime that meets the quality
  floor, implement, review the work internally until clean and externally
  until clean, close out and hand off without pushing. Use when asked to
  work on, implement, tackle or finish a task, story or backlog item.
license: MIT
metadata:
  package: good-agent
---

# Work a task

The loop is fixed; do not improvise the order. No file is edited before the
branch exists. The author never grades its own work.

## 1. Ground

Read the repository's canonical instruction file (and whatever it imports
or points at), the file-type instruction files that apply, and the design
or specification documents the task cites. Run `git status --short` and
`git branch --show-current`; unrelated changes in the tree are a blocker to
surface, never something to sweep into the task.

## 2. Read and verify the task

Open the task file in full. Confirm every dependency is completed. Check
the task against the code: do its assumptions still hold, do the files and
commands it names exist, is it still the right thing to build. Note what
is stale.

## 3. Propose refinements

List ambiguities, gaps, drift and concrete suggestions. Take the
recommended option for each non-blocking decision and record it; stop and
ask once, consolidated, only for a choice that would change the design
materially either way.

## 4. Branch

Confirm the working tree is clean and the base branch is current. Create
the task branch with the repository's `branch-naming` convention (Trellis:
`<initials>/<id-lowercase>/<slug>`), from the local base branch. Everything
from here lands on the branch. Record the branch's starting commit; it is
the base for every diff review.

## 5. Write the refinements and the plan into the task

On the branch, fold the refinements into the task's Scope, Notes and Risks
and add a `## Plan` section: ordered steps with commit checkpoints and the
narrow check that proves each. Regenerate the backlog (the `regenerate`
seam point) and commit. This refined file is the source of truth for the
rest of the loop.

## 6. Review the plan

Run the `review-loop` skill with the plan prompt
(`references/review-plan.md`), internally until `[]`, then externally by
the other AI tool until `[]`. Fold the findings into the task file and
commit.

## 7. Choose runtimes and slices

Prefer one implementation context for cohesive work. Split into two to
four parallel slices only when that cuts wall-clock time without hiding
integration risk; each slice has disjoint files, stated inputs and
acceptance criteria, and a list of files it must not touch. For each slice
and each review, choose the least-cost runtime the host exposes that meets
the quality floor: a current-generation balanced model for substantive
work, a faster lower-cost one for isolated, reversible, well-specified work
that deterministic checks will catch, a higher effort for anything touching
money, authorization, persistence, public contracts or concurrency, and the
premium tier only when the owner asks. Record the choice and a one-line
reason in the dispatch, never in the durable record. The concrete ceiling
lives in `good-agent.config.json` (`review`).

## 8. Implement

Work the plan on the branch, committing at the checkpoints and keeping the
narrow checks green. A slice worker edits only its files and runs no
builds, tests or generators; the orchestrator integrates and runs one
unified verification. Regenerate generated artifacts through their
canonical commands; never hand-edit them. Reserve the slow gates (the
repository's `gates` seam point) for the final reviewed candidate.

## 9. Review the work

Run the `review-loop` skill with the diff prompt
(`references/review-diff.md`) against the branch's starting commit, naming
the task file: internally in a fresh context until `[]` (cap five passes,
then a focused confirmation), then externally by the other AI tool until
`[]`, confirming each round's fixes internally. Run the narrow checks after
each fix; run the slow gates once on the final candidate.

## 10. Close out

On the branch, in the same change as the work: move the task to the
completed location (Trellis: `completed/tasks/`), set `status: completed`
and `completed_on`, record the starting commit and the review rounds and
dispositions (independence, counts, what was rejected or waived and by
whom; no model or vendor names), regenerate, commit.

## 11. Hand off

Tell the owner: the branch name, what shipped, the review outcome, the
decisions taken under step 3, and the commands to push and open the pull
request (the repository's `attribution` policy applies to the message). Do
not push, publish or merge; those are the owner's.
