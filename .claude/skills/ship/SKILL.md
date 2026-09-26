---
name: ship
description: Ship this session's finished work to main — branch from origin/main, commit only this session's files, push, open a pull request, turn on auto-merge, watch CI until it merges, then report the deploy. The Owner starts it with /ship.
disable-model-invocation: true
argument-hint: "[what the change is]"
---

# /ship

The Owner's note, if any: $ARGUMENTS

`main` has a ruleset ("main - pull requests with green CI"): every change needs a pull request, and the
checks `ci-ok` and `db-security` must pass. Nobody can bypass it. Auto-merge merges the pull request by itself
when both checks are green. A merge to `main` is a release:
- **API:** `.github/workflows/deploy-api.yml` runs when the change touches its `paths` (apps/api, packages/database,
  packages/shared, packages/events, package*.json, railway.toml). It runs CI again, then ships to Railway, and
  the release applies new migrations to production.
- **Web:** Vercel builds when `@nexus/web` or one of its dependencies changed (`turbo-ignore`). Then
  `prod-smoke.yml` checks production.
- Anything else (docs, `.claude/`, scripts) merges and deploys nothing.

Never: push `main`, force-push, `gh pr merge --admin`, `--no-verify`, or change the ruleset or repo settings.

## 1. Make the ship list

1. The ship list is the files **this session** changed. Other sessions edit the same checkout at the same time.
2. Read every file's diff: `git diff HEAD -- <file>`, or the whole file when it is new.
3. Every hunk must be yours. A file with a hunk you did not write stays out. Name it in the report.
4. Two unrelated tasks → two pull requests. Run the steps below once per task.
5. Stop and ask the Owner, and ship nothing, when:
   - you are not sure which changes are yours, or the list is empty;
   - a hunk touches an area the memory rules mark untouchable;
   - a migration drops, renames, changes a type or adds `SET NOT NULL` (CI's expand/contract check refuses it
     anyway without a `-- contract:` header).

## 2. Check before you move it

Run these where you made the change, and write down the results for the pull request:
- `npm run typecheck -w <workspace>` for every workspace you changed.
- The tests of the changed area (the file or directory, not the whole suite). API tests run from `apps/api`.

A failure caused by your change → fix it first. CI runs the full gate on the pull request anyway.

## 3. Get a clean branch

**Already on your own task branch, in your own worktree, cut from `origin/main`?** Use it and go to step 4.

**Otherwise** (the shared checkout `/Users/awais/nexus-commerce`, or `main`): never switch branches, stash,
reset or clean there. Make a worktree:

```bash
git fetch origin main --quiet
git worktree add -b <type>/<slug> /private/tmp/nexus-<slug> origin/main
```

`<type>` is `feat`, `fix`, `docs`, `test`, `refactor` or `chore`. `<slug>` is 2–4 kebab-case words.

Copy only the ship list into it:
- A changed tracked file: write `git diff HEAD -- <files>` to a patch in your scratchpad, then
  `git -C /private/tmp/nexus-<slug> apply --3way <patch>`. A conflict → stop and report the file.
- A new file: `mkdir -p` its folder in the worktree and `cp` it to the same path.

`git -C /private/tmp/nexus-<slug> status --short` must list exactly the ship list. Your edits also stay in the
shared checkout. Say so in the report; never revert them there.

## 4. Commit

```bash
git add -- <file> <file> ...      # by name; never -A or .
git commit -F - <<'EOF'
type(scope): subject in the imperative, under 72 characters

Why, in one to three lines.

<the Co-Authored-By line from this session's attribution instructions>
EOF
```

The pre-commit hook runs the fast gates for the staged file types. If it fails, fix what it names.

## 5. Push and open the pull request

```bash
git push -u origin <type>/<slug>
```

The pre-push hook type-checks the affected workspaces (about 20 s; it skips when there is no `node_modules`).

Write the body to a file in your scratchpad, then:

```bash
gh pr create --base main --head <type>/<slug> --title "<commit subject>" --body-file <body file>
```

The body holds, in short lines:
- What changed and why.
- The checks from step 2 and their results.
- `Migration:` none, or the folder and what it does.
- `Deploys:` API, web, both or nothing (from the paths above).
- The pull-request attribution line from this session's attribution instructions, last.

Never open it as a draft: auto-merge does not merge a draft.

## 6. Turn on auto-merge

```bash
gh pr merge <number> --auto --squash
```

Squash gives one commit per pull request on `main`, so one revert undoes it. If the checks are already green,
this merges at once.

## 7. Watch CI

CI takes about 8 minutes. Run this in the background; you are told when it ends:

```bash
gh pr checks <number> --watch --required --interval 30
```

Then `gh pr view <number> --json state,mergeStateStatus,mergeCommit`.

- **MERGED** → step 8.
- **A check failed** → find the run with `gh pr checks <number>`, then `gh run view <run-id> --log-failed | tail -150`.
  - Your change caused it → fix it in the worktree, commit, push. Auto-merge stays on and CI runs again.
  - It is not from your change (main is red, infrastructure, a known flaky test) → run
    `gh run rerun <run-id> --failed` once. Red again → stop and report the job, the error line and why it is
    not yours.
- **Green but not merged** → read `mergeStateStatus`. `DIRTY` means a conflict with `main`: run
  `git merge origin/main` in the worktree, resolve only your files, push. Never rebase a pushed branch: a
  force-push is denied. `BLOCKED` with green checks → stop and report it.

## 8. After the merge

- The merge commit: `gh pr view <number> --json mergeCommit --jq .mergeCommit.oid`.
- **API deploy** (if the change touches its paths): `gh run list --workflow deploy-api.yml --branch main -L 3`,
  pick the run for the merge commit, and watch it in the background with `gh run watch <run-id> --exit-status`.
  It runs CI again, then ships.
- **Web deploy** (if the web changed): `gh run list --workflow prod-smoke.yml -L 3` shows the production smoke
  after Vercel's production build.
- Clean up only after the pull request shows MERGED:

  ```bash
  git worktree remove /private/tmp/nexus-<slug>
  git push origin --delete <type>/<slug>
  ```

## 9. Report to the Owner

Short, plain sentences:
- What merged, the pull-request link and the merge commit.
- The checks you ran, and the CI result.
- The deploy: none, or the API and web runs and their results.
- Files you left out and why, and edits that stay in the shared checkout.
