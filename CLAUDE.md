# pFMS — Project Notes

## Commit subjects are user-facing

On every deploy, the backend posts the commit subjects since the last deploy to
the pfms-support Slack channel (`src/deployAnnouncer.ts`). Write every commit
subject as a short line of prose for that audience — mentors and teams, not
just developers. Lead with the user-visible effect ("Auto-clear finished
matches back to idle after 2 minutes"), not the mechanism. Implementation
detail belongs in the commit body, which is not posted.

## Tooling

- Use `bun run` for all package scripts (typecheck, build, dev).
- The pre-commit hook (lefthook) runs typecheck and prettier `--check`; it
  cannot handle partially-staged files (it re-checks-out staged content through
  autocrlf and prettier then fails on CRLF). When committing from a shared
  working tree with unrelated changes in the same file, sync the worktree file
  to the staged content for the commit, then restore it.
