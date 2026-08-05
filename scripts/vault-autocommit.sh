#!/bin/bash
#
# Scoped Obsidian-vault auto-commit. Runs on a launchd timer every 5 min:
#   ~/Library/LaunchAgents/com.awais.nexus-vault-autocommit.plist
#
# Two invariants, both deliberate:
#
#   1. COMMITS ONLY obsidian-vault/. Never code, never the ~487 stray
#      _probe.mts scripts, never another session's in-flight work. The
#      `git add` stages new notes; `git commit --only <pathspec>` then
#      restricts the commit to that pathspec no matter what else happens
#      to be sitting in the index — the same concurrent-session-safe
#      pattern used when several Claude sessions share main.
#
#   2. NEVER PUSHES. The pre-push hook is a full `rm -rf .next &&
#      next build` plus api tsc, RBAC boot check and the security suite —
#      minutes of work, and it hard-fails whenever the code tree is
#      mid-edit. Paying that every 5 min for a note is absurd, and
#      --no-verify is not an option here. So notes ride to GitHub on the
#      next ordinary code push instead.
#
# Uninstall:  launchctl bootout gui/$(id -u)/com.awais.nexus-vault-autocommit
set -euo pipefail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
REPO="/Users/awais/nexus-commerce"
VAULT="obsidian-vault/"

cd "$REPO"

# Nothing changed under the vault? Cheapest possible exit.
if [ -z "$(git status --porcelain -- "$VAULT")" ]; then
  exit 0
fi

# Never auto-commit on top of a merge/rebase/bisect in progress.
if [ -e .git/MERGE_HEAD ] || [ -e .git/REBASE_HEAD ] || [ -d .git/rebase-merge ]; then
  echo "$(date '+%F %T') skipped: repo mid-merge/rebase" >&2
  exit 0
fi

git add -- "$VAULT"

# -m must precede the `--` pathspec separator, or git reads the message
# as a filename and fails with "pathspec '-m' did not match any file(s)".
#
# `|| true` because --only recomputes the commit from the working tree
# for the given paths, so a status that looked dirty can still resolve to
# an empty commit (e.g. a staged deletion of a now-ignored file). That is
# a no-op, not a failure — it must not kill the launchd job.
if git commit --only \
     -m "vault: auto-commit $(date '+%Y-%m-%d %H:%M')" \
     -- "$VAULT"; then
  echo "$(date '+%F %T') committed vault changes"
else
  echo "$(date '+%F %T') nothing to commit after all (no-op)" >&2
fi
