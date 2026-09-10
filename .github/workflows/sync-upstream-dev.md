---
on:
  schedule: daily around 03:00 utc
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read

engine: claude

tools:
  bash: ["git:*", "bun:*", "cat", "ls", "grep", "find"]
  edit:

network:
  allowed:
    - defaults
    - github
    - node

safe-outputs:
  create-pull-request:
    title-prefix: "[auto-sync] "
    labels: [automation, upstream-sync]
    base-branch: "dev"
    allowed-branches: ["sync/upstream-dev"]
    preserve-branch-name: true
    if-no-changes: "ignore"
    draft: true
    fallback-as-issue: true
---

# Sync upstream/dev

Keep this fork's `dev` branch caught up with `upstream` (`https://github.com/caozhiyuan/copilot-api.git`, remote name `upstream`, branch `dev`) by merging its latest commits, resolving any conflicts, and opening a pull request for human review. **Never push directly to `dev` and never merge the PR yourself** — this workflow only ever proposes the sync; a human approves and merges it.

## Branch — must stay fixed

Always do all work on a branch named exactly `sync/upstream-dev`. Never invent a different name (no date suffixes, no random names). This is what lets tomorrow's run update today's still-open PR instead of opening a duplicate — if a PR on this branch is already open, you are continuing that same PR, not starting fresh.

## Steps

1. `git fetch origin dev` and `git checkout -B sync/upstream-dev origin/dev` — start from the current tip of `dev`, not from whatever this workflow's own runner happened to check out (a scheduled trigger has no natural branch context).
2. Add the upstream remote if it isn't already configured (`git remote add upstream https://github.com/caozhiyuan/copilot-api.git`), then `git fetch upstream dev`.
3. Check how far behind: `git log --oneline dev..upstream/dev`. If there is nothing to merge, stop here and do not open a PR — the `if-no-changes: ignore` policy on this workflow's PR output handles that, but exiting early saves an unnecessary merge attempt.
4. Run `git merge upstream/dev --signoff` (merge, not rebase — a straight rebase of every upstream commit one at a time reopens the same conflicts repeatedly if this fork and upstream have touched the same files independently; merging resolves the accumulated diff once).
5. If there are conflicts, resolve each file by reading both sides' intent and combining them, not by blindly preferring one side:
   - Check `CLAUDE.md` at the repo root for this project's conventions (coding style, testing requirements, commit format) before resolving.
   - When both sides changed the same logic for related-but-different reasons (e.g. one side added a feature, the other refactored the surrounding code), read each side's diff against the merge-base to understand intent, then compose both changes rather than discarding either one.
   - When one side's change is clearly superseded by a more complete version on the other side (rare, but check for it — e.g. a narrower fix replaced by a broader one covering the same case), you may drop the superseded version, but only after confirming via git history/blame that it's genuinely redundant, not just similar-looking.
   - Never use `git checkout --ours` / `--theirs` as a shortcut across a whole file without reading what each side actually changed there first.
6. Once conflicts are resolved and staged, run the project's own gates before committing further: `bun install`, `bun run typecheck`, `bun run lint`, `bun test --isolate`. Fix straightforward breakages the merge introduced (e.g. a call site that needs updating for a renamed option). If a failure looks like a genuine pre-existing bug unrelated to anything this merge touched, leave it — note it in the PR description rather than trying to fix unrelated code.
7. Commit with `git commit --signoff` (this repo requires DCO signoff on every commit; do not use `--no-verify` to bypass a failing pre-commit hook — fix the underlying issue, re-stage, and commit again).
8. Push is handled by this workflow's `create-pull-request` safe output, not by you directly — do not run `git push`.

## Safety

- Do not run `git stash` at any point while a merge is in progress (`.git/MERGE_HEAD` present) — stashing mid-merge can silently drop the in-progress merge state even though the stashed content is recoverable, which then requires manually reconstructing the merge commit. If you need to compare before/after state, use `git show <ref>:<path>` or a second read-only command instead of stashing.
- Do not force-push, `git reset --hard`, or delete branches.
- If the working tree or `dev` moved unexpectedly during your run (something else pushed to `dev` or to `sync/upstream-dev` concurrently), stop, re-fetch, and re-evaluate rather than forcing your view of the world onto what's actually there.

## PR description

Summarize: how many upstream commits were merged, which files had real conflicts (not just whitespace/import-order overlap) and the reasoning for how each was resolved, and the exact `bun run typecheck` / `bun run lint` / `bun test --isolate` results (pass/fail counts). If a pre-existing, unrelated test failure was left as-is, say so explicitly so the reviewer doesn't mistake it for something this sync introduced.
