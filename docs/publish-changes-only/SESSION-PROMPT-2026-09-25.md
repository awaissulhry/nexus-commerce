# Session prompt — Publish sends ONLY what changed (2026-09-25)

Written by the R-11 product-sheet lane at the Owner's request ("Option A"). Facts below were READ in the code on 2026-09-25 unless marked.

## 1. The goal (the Owner's words, summarised)

*"Previously when I clicked Publish only the values I changed were pushed; it was the most efficient way instead of pushing the whole
sheet again to channels."* The studio's **Publish** must send **only what changed — per product and per field — since the last
publish**, for every channel it publishes to (Amazon, eBay, Shopify). The review before sending lists exactly those changes. AAA quality:
nothing unchanged is re-sent, nothing changed is missed, the preview is the truth, every send is traceable, the design system and 7:1.

## 2. How it works TODAY (read; re-read every line before you rely on it)

- **Studio Publish = the WHOLE family, ALL fields.** `apps/api/src/services/pim/studio-publication.service.ts` → `buildReview` →
  `prepareAmazonPublication` (`studio-publication-amazon.ts`: a loop over every product of the family, `~:36–160`, one JSON_LISTINGS_FEED
  message per product with its full attribute set; existing listings → `PARTIAL_UPDATE` patches of EVERY attribute sent, new → `UPDATE`;
  `sendAmazonPublication` validates every message with `validateListing`, then ONE feed) · `prepareEbayPublication` / `buildEbayListingInput`
  (`studio-publication-ebay.ts`: every product of the item; Trading create/revise of the whole item) · Shopify: `previewContentSync` (content family).
  Nothing tracks which fields changed. A review is bound to a `revision` (`publicationDigest`, `studio-publication-plan.ts:15, :80`).
- **The old flat-file editor sent only CHANGED ROWS:** `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx:146–149`
  (`_dirty` / `_isNew` / `_needsPublish` per row; Submit gathers those rows only) → `services/amazon/flat-file.service.ts:2866–2880`
  (`PARTIAL_UPDATE` by default: "patches only the attributes we actually send"; `full_update` / `delete` explicit). Granularity was the ROW
  (the product), and each changed row carried its row's attributes — that is what the Owner remembers as "only what I changed".
- **Already change-only, by themselves (do not route them through Publish):** a price edit → the ONE price door
  (`services/pim/channel-price-write.service.ts:15`: one `PRICE_UPDATE` per listing, `expectedVersion` required); stock → the stock sync
  (shared-stock pool, cascade). 🔴 Amazon EU merchant quantity is ONE number for all EU markets; never touch FBA quantity.
- **A "last published" baseline does NOT exist today.** `services/pim/listing-snapshot.service.ts` says "every publish captures a snapshot of
  what was SENT" (Owner ruling #110) and exposes `captureSnapshot` / `listSnapshots` / `restoreToDraft` (routes `product-studio.routes.ts:971+`),
  **but the studio Publish never calls it** (no `snapshot` in `studio-publication.service.ts`) — a comment asserting a property the code never
  had. Decide the baseline on purpose (§5).
- **Why it matters now (measured 2026-09-24, production, read only):** the first content read found **45 of 147 Amazon listings where
  Amazon differs from Nexus** (`ChannelDrift`, A-39). A whole-family Publish overwrites those Amazon-side values, even in fields nobody
  touched in Nexus.

## 3. How to work (this programme's rules — they bind)

1. Claim a row in `docs/pes-claims.md` (top) BEFORE editing; name every file before its first edit. Other sessions share this tree
   (e.g. the channel-file-import session, `docs/channel-file-import/`): `git commit --only <your files>`, never `git add -A`, never `git stash`,
   never `--amend`, never `--no-verify`. Before any edit and before any push:
   `ps -axo pid=,command= | /usr/bin/grep -E "^ *[0-9]+ (/[^ ]*/)?git push|^ *[0-9]+ /bin/bash \.githooks/pre-push"` (NOT `pgrep -af`). Do not
   edit files while any push runs.
2. Your own folder: **`docs/publish-changes-only/`** (PLAN.md, PROGRESS.md, records/). `docs/product-cheat/**` belongs to the R-11 lane.
3. Measure before claiming; predictions before every run; label claims read / inferred. The plan is an amendment the Owner rules on BEFORE
   building ("FOR YOUR RULING", at most two questions, each with a recommendation). Every test proven by mutations (Python harness, per-file
   backups, sha256 restore, a green control first, anchors asserted once). Four closure fields per step: *Done when* · *Cost when* · *Gate* ·
   *Rollback*. One commit per step group. API tests from `apps/api` only (the root `.env` is PRODUCTION); real-database arms on
   `formulaDatabase()` unless a race; a schema change also runs `packages/database/scripts/generate-baseline.mjs`; `tsc` with a FRESH private
   build-info file.
4. R-40: run read-only production tools yourself. **Every live channel write needs the Owner's word in the chat, per run:** read → preview →
   write → read back → restore → delayed re-read. A publish IS a live channel write. Heavy transactional work never runs from the dev box
   against production (it times out) — use the server.
5. Parallel sub-agent lanes with DISJOINT files (R-44); you verify and commit; only the main session edits shared DS files (CHANGELOG web +
   factory, `.claude/DS-GAPS.md`, catalog, barrels). UI in `apps/web/src/design-system` first; mirror to `apps/factory`; 7:1 (hook 0/0);
   keyboard; light/dark; 100 % honest UI (an unknown baseline is SAID, never hidden as "no changes").
6. The flat-file no-touch rule was LIFTED by the Owner on 2026-09-24. R-34: listing CONTENT data work (the 25 DE titles, AIREON colour) stays
   the Owner's, last — do not raise it. The pre-push hook takes ~30–40 min on a UI push; the AE.4 flake may refuse once — retry once.
7. Report to the Owner in plain, short English: what you did, did it work, what he does now.

## 4. Read first — do not redo this research

- ★ `docs/audits/2026-09-13-studio-publication/README.md` — how studio Publish was built (durable review bound to a revision, advisory lock,
  Amazon validate-then-one-feed, eBay Trading create/revise, Shopify content sync, the boundaries).
- ★ `docs/product-cheat/PLAN.md` — Phase 3 "Proof" (Steps 3.1–3.6: the doors, the four payload measurements M1–M4, the parity gate between
  the two Amazon payload builders (A-33, one serializer), the first live write + read-back, reconciliation / `ChannelDrift`), and A-32 (the
  publish preview names foreign-language text), A-38/R-38 (SCT.6 offer close), A-39/A-40 (content reads per night), A-41 (eBay currency),
  A-56 (eBay builder category list). Tools: `docs/product-cheat/tools/payload-capture.mts` (captures the payload a publish WOULD send,
  locally, rolled back), `live-write-probe.mts`, `channel-read-probe.mts`.
- `docs/product-sheet/PLAN.md` (untracked; SUPERSEDED IN PART) topic **06 — Publish**: 06.4 "Publish history" (field-level diff, per-field
  checkboxes), 06.6 the publish drawer (Preflight · Payload · Send · Result), 06.8 capture a snapshot in the publish path with `publishEventId`,
  diff endpoint, field-subset restore; its open questions Q1–Q3.
- `docs/superpowers/plans/2026-07-19-flat-file-trust.md` + `docs/flat-file-trust-runbook.md` (zero data loss on the flat-file editors),
  `docs/2026-07-31-snapshot-versioning-sv.md` (`flatFileSnapshot` versioning proposal), `docs/pes5-phase0-backend.md` (PES.5 publish/snapshot
  doctrine), `docs/market-features/23-amazon-live-pdp-preview.md`, `34-list-on-channel-wizard.md`.

## 5. The design question you must answer (with data) — "changed since WHAT?"

Candidates (measure each; recommend one):
1. **What Nexus SENT last time** — capture, on every successful publish, the exact values sent per listing and field (the missing
   `captureSnapshot` call, or a new per-field record); next publish = current resolved values minus that baseline.
2. **What the CHANNEL holds now** — the nightly content reads (`ChannelDrift`, A-39 Amazon / A-40 eBay) or a live read at review time;
   next publish = the fields where Nexus ≠ channel. This also shows the 45 Amazon-side differences before anything is overwritten.
3. A combination: send "changed since last sent", and SHOW "the channel differs from what we last sent" (someone edited in Seller Central)
   so the Owner chooses per field whether Nexus or the channel wins.
Also decide: a product with NO baseline (never published from Nexus, or published before the baseline existed) — how it is shown and
what is sent; a family where only one child changed (Amazon: one message; eBay: can a Trading revise send one variation / only the changed
fields?); deletions (a field cleared in Nexus); images, variation theme, parent/child; the review's revision binding stays.

## 6. The first step (measure only — no code change, no channel write)

1. Read §4. Write `docs/publish-changes-only/PLAN.md` §0 "How Publish works today" in 20 lines, citing file:line (re-read §2's lines).
2. On the LOCAL database, capture what Publish builds today for one family per channel (Amazon: `payload-capture.mts`; eBay and Shopify: the
   review endpoint), predictions first: products, messages, attributes per message, bytes. Then change ONE field on ONE product and capture
   again: how much of the payload is unchanged.
3. Read production (read only): how many listings per channel have a usable baseline today (snapshots, `ChannelDrift` rows and their age,
   `lastPublishedAt`-like fields), and the 45 Amazon differences by field.
4. Write the plan as an amendment for the Owner (FOR YOUR RULING): the baseline (§5), the change-only payload per channel (Amazon patches
   of changed attributes for changed SKUs only; eBay the smallest Trading revise that is safe; Shopify), the review UI (a per-product,
   per-field list of exactly what will be sent, and where the channel differs), the tests + mutations, and a first live proof on ONE listing
   (read → preview → write → read back → restore → delayed re-read, on the Owner's word). At most two questions. Nothing is built before he rules.
