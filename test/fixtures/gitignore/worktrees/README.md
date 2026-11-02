# gitignore fixture

A repository that keeps per-session worktrees under `.claude/worktrees/`,
which its `.gitignore` lists. The copies of `AGENTS.md` and `CLAUDE.md` in
`session-a` are what a worktree holds. They are added to the outer
repository with `git add -f` because the fixture's own `.gitignore` covers
them. `test/discover.test.mjs` copies this directory to a temporary
directory before using it, with and without `git init`, so the outer
repository's index never decides the result.
