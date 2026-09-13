# Language-axis (LX) revert — 2026-09-13 04:36–05:00 local, session nexus-commerce-89

Owner instruction (verbatim): "please revert it all so that it's all up to date, and then I'll make all the changes I want later."

What was done: every working-tree change attributed to the language-axis programme (steps 1–7, per its own
audit manifests under `docs/audits/2026-09-12-language-axis/`) was returned to checkpoint `b499da49`
(2026-09-12 08:08). `files-checked-out-to-HEAD.txt` lists the 176 tracked files restored; `files-deleted.txt`
lists the 61 new files and two migration folders removed (`20260912_lx4_channel_listing_translations`, `20260912_lx5_readiness_index`). ⚠ CORRECTION 05:20: the ledger shows
lx4 was applied to PRODUCTION by the LX session on 2026-09-12 12:50Z via `prisma db execute` + `migrate resolve`;
the earlier claim "applied only locally, never pushed" was wrong. Check lx5 in the ledger before judging it.
The LX audit evidence itself was left in place. Nothing was committed.

Kept: the single-sheet consolidation (`sheet/ProductSheet*.tsx`, the two adapters, the shared hooks) —
re-pointed at the checkpoint APIs; `sheet/master/channelColumns.tsx` (a verbatim hoist of the checkpoint's
inline channel column builder, which the consolidation's channel adapter uses).

Undo: `tree-before-revert.patch` is `git diff HEAD` of the whole tree at 04:36 (before the revert, after the
consolidation parity fixes); `lx-deleted-files.tgz` holds the deleted files. To resurrect LX, apply the patch
and extract the archive in a worktree at `b499da49`, then rebuild `packages/shared` and run `prisma generate`.

## 05:20 — REVERTED THE REVERT

The Owner clarified that the latest working version (language axis included) is what they want. The whole
04:36 snapshot was re-applied (`tree-before-revert.patch` + the untracked archive); the tree is byte-identical to
04:36 again except this directory. Kept from the earlier, Owner-requested renderer revert: per-cell source
indicators on channel cells, checkpoint master cell renderer, checkpoint glyph tooltip format.
