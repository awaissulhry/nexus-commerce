---
name: ship
description: Ship this session's finished work to main — branch from origin/main, commit only this session's files, check it locally, push, open a pull request, merge it, then report the deploy. The Owner starts it with /ship.
disable-model-invocation: true
argument-hint: "[what the change is]"
---

# /ship

The Owner's note, if any: $ARGUMENTS

Since 2026-10-01 (the Owner, for speed) **no CI runs on pull requests and no check is required to merge**. The
ruleset on `main` still requires a pull request and forbids force-pushes and deleting `main`. So **your local checks
in step 2 are the only checks** before the change is live. A merge to `main` is a release:
- `.github/workflows/deploy-api.yml` runs when the change touches its `paths` (apps/api, apps/web, packages/*,
  package*.json, patches, Docker and Railway files). It builds the images and ships to Railway **without running
  CI first**: the API (which applies new migrations to production), then worker, scheduler and web. Live in about
  7 minutes. A read-only production smoke runs after the web ships.
- Anything else (docs, `.claude/`, `.github/`, scripts) merges and deploys nothing.

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

Run these where you made the change, and write down the results for the pull request (the light LOCAL FIRST
rule in `~/.claude/CLAUDE.md`):
- `npm run typecheck -w <workspace>` for every workspace you changed.
- The tests of the changed area (the file or directory, not the whole suite). API tests run from `apps/api`.
- A big screen change only: a look in the browser against a LOCAL API on a LOCAL database
  (`NEXT_PUBLIC_API_URL` set to it; never production data).

A failure caused by your change → fix it first. **Nothing else checks it**: no CI runs on the pull request, and the
deploy ships without tests.

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

Never open it as a draft.

## 6. Merge

There are no checks to wait for. Read the state, then merge exactly the commit you pushed:

```bash
gh pr view <number> --json state,mergeable,mergeStateStatus
gh pr merge <number> --squash --match-head-commit "$(git rev-parse HEAD)"
```

Squash gives one commit per pull request on `main`, so one revert undoes it.
- `DIRTY` means a conflict with `main`: run `git merge origin/main` in the worktree, resolve only your files, rerun
  the checks of step 2, push, merge. Never rebase a pushed branch: a force-push is denied.
- `BLOCKED` → stop and report it.
- A change to the Docker build files (`apps/*/Dockerfile`, `package-lock.json`, `turbo.json` …) also starts the
  `Images` workflow on the pull request (build + secret scan, no push). It blocks nothing; read it before merging.

## 7. (No CI on pull requests since 2026-10-01)

Do not wait for `ci-ok` or `db-security`: they no longer run on pull requests. The nightly workflow still runs the
whole CI on `main` and emails the Owner on a failure.

## 8. After the merge

- The merge commit: `gh pr view <number> --json mergeCommit --jq .mergeCommit.oid`.
- **Deploy** (if the change touches its paths): `gh run list --workflow deploy-api.yml --branch main -L 3`, pick
  the run for the merge commit (none at all → `gh workflow run deploy-api.yml --ref main -f ship=changed`), and
  watch it in the background with `gh run watch <run-id> --exit-status`. It builds the images and ships (API,
  worker, scheduler, web), then runs the read-only production smoke. About 8 minutes.
  - An image build that fails with `Can't resolve '@vercel/turbopack-next/internal/font/google/font'` is a Google
    Fonts download failure on the runner, not your change: `gh run rerun <run-id> --failed` once.
  - Then check production: `curl -fsS https://nexusapi-production-b7bb.up.railway.app/api/health/ready` must say
    `healthy` with the merge commit's first 8 characters as `build`.
- Clean up only after the pull request shows MERGED. Delete the remote branch through the API: a
  `git push --delete` from the shared checkout runs that checkout's own pre-push hook, which may fail on other
  sessions' work.

  ```bash
  git worktree remove /private/tmp/nexus-<slug>
  git branch -D <type>/<slug>
  gh api -X DELETE repos/awaissulhry/nexus-commerce/git/refs/heads/<type>/<slug>
  ```

## 9. Report to the Owner

Short, plain sentences:
- What merged, the pull-request link and the merge commit.
- The checks you ran (the only checks before going live) and their results.
- The deploy: none, or the deploy run, its result and the live `build`.
- Files you left out and why, and edits that stay in the shared checkout.
