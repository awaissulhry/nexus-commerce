# Publish window lists aliases — HANDOFF (2026-10-05)

Owner (10-05 ~19:50): "A. Launch multiple sub-agents and make sure it is all perfect. I do not want to do anything in the
address bar … everything works consistently across the whole platform. I should be able to publish the aliases as well."
Cause found: apps/web/src/app/products/_publication/dialog/destinations.ts:324-325 listedDestinationKeys skips aliases
("a second listing on a market is chosen from its own sheet"); model.ts:63-70 publicationDestinations adds listingId only
for the studio's selected listing (URL `listing=`, contracts.tsx:678).
Worktree /private/tmp/feat-publish-window-aliases, branch feat/publish-window-aliases from origin/main 502761c62
(node_modules reused from the #355 worktree; lockfile/shared/events unchanged).
Test family (Owner's second business, eBay IT): a main listing plus 2 aliases (ALT1, ALT2); ids are in the session notes, not here.
Each listing has 4/8 colours live (black/blue/orange/pink missing) → Full update needed on each.
## Steps
1. Research (running): web Publish window + every publish entry point; server routes/batch/MCP alias support.
2. Build (builders, disjoint files). 3. Review + test sweep. 4. PR, merge on "merge #N".
- 19:55 Owner added scope: "the product sheet … should be able to manage all the aliases as well, including the images".
  Both research agents told to map every sheet gap for aliases (rows, Product media cell + editor, Image URLs, copy/fill,
  Media page picks, import/export, writers, photo publish per alias; Amazon aliases share the ASIN → same photos).
## 20:10 — research done, build running
- Canonical: an alias destination / selected listing = the ALIAS ID (ProductListingAlias.id); main listing = none.
- PR A (this worktree, base commit 6719af916 = PublishActionCell.aliasLabel/aliasPosition): builders
  B1 server (publish-actions label + hide archived; plan labels + dedupe by resolved alias; createPlanBatch alias check;
  batch refusal labels; products-list path refuses listingId; MCP publish-listing undo alias bug; MCP EU guard by SKU),
  B2 Publish window (aliases listed + ticked when listed, ★/① labels, "listings" wording, canonical id, many-window note),
  B3 studio (listing picker in StudioBar, band menu Show only / Publish this listing, one id kind in URL, Activity
  undo/retry alias, SellingSummary label, Last publish per alias, studio-path for alias drafts, CSV label).
- PR B (/private/tmp/feat-alias-photos, branch feat/alias-photos): B4 — Amazon aliases follow the main listing's photos
  (cell read-only + reason, save refused, publish never different, old workspace), plan seed keeps eBay alias photos,
  alias-id listingId in product-media, "Listing N" label → ★/① label.
- Left for the Owner to decide (other alias gaps, not photos): Amazon/Shopify workbook alias export/import, eBay workbook
  alias without SKU, catalog formula guard aliasKey, bulk actions targeting (MARKETPLACE_OVERRIDE_UPDATE hits all aliases;
  CHANNEL_BATCH arbitrary row), repricer/pricing engine primary-only, eBay inventory drift skips aliases, alias rename/
  archive in the web (archive deliberately absent), many-products publish with aliases (phase 2).
## 21:00 — PR A built (committed 295e1516b, local); reviewers running
- B1/B2/B3 done + follow-ups (drafts route account+alias, Media workspaces + Presentation use the alias id and ★/① names,
  toolbar mark/toast per listing, one status read per alias via usePublicationStatus().aliasReads).
- Accepted side effect: on a variation page, picking a listing on the old Media pages moves to the family's main product.
- Running: R1 adversarial review, R2 test/guard sweep. PR B (alias photos, /private/tmp/feat-alias-photos) builder running.
## 21:40 — review round on PR A
- R2 sweep: nothing caused by the branch (pre-existing: delete+relist ×3, attribute-scope-baseline B3, variation-one-writer,
  variation-store-readers, DB-down suites; 4 static gates).
- R1: M1 variation page switched to the parent's photos (wrong-product edit) — fixing; M2 a chosen listing ticks the
  whole market — fixing (chosen listing → only it in its market); M3 real ids in this file's history → removed, branch
  squashed to one commit (dc191ad0d), 0 cuid-like ids in history. Minors m1–m9 being fixed (shared cached read, picker
  refresh, archived aliases kept endable via aliasStatus, "Main listing" everywhere, phone width).
- Shared shape a4e590523: PublishActionCell.aliasStatus.
- Fixers running: F-A1 (window/status/shared read), F-A2 (studio + server). PR B reviewers R3/R4 running.
- Merge order: PR B (alias photos) FIRST, then rebase PR A (both edit useChannelSheetAdapter.tsx; Amazon alias photos rule
  must be live before aliases are ticked by default).
## 22:00 — PR B review round
- R4 sweep PR B: nothing branch-caused (each failure re-run on base 502761c62 too). R3: no blockers; M1 seed sets must
  follow #355 (rows w/o own list = gallery; set every value or no axis), M2 adopted alias order (draft → Product media/
  imageUrls → builder rows last), M3 Amazon alias on a DIFFERENT ASIN keeps its own photos, M4 existing alias sends the
  main's photos when the main listing is not live; m1–m6 (old Amazon tab read-only for following aliases, reset allowed,
  [parent, ...products] query, sentences, revision hash, seed edge cases). B4 fixing. git merge-tree PR A × PR B: clean.
- After merge of both: unify the two alias-naming helpers (PR A listingScope aliasMarkText vs PR B mediaListingName).
## 22:40
- PR B fixes committed d4b8947de (feature 6aa4aeb3c). Decision: Amazon alias with an ASIN while the main row has none =
  its own page (keeps own photos). R5 verifying the fix round.
- Pre-existing, outside these PRs (tell the Owner): the photo-plan switch builds Shared from builder rows/draft/library,
  ignoring the product's own Shared Product media; the library curation has no axis, so eBay listings that follow it can be
  blocked ("has no photos") after a switch.
- PR A: F-A2 done (variation stays on its product; archived aliases readable/writable with aliasStatus; unread alias keeps
  its aliasKey; "Main listing" in band/picker/Presentation; picker max 32ch). F-A1 (window/status/shared read) running.
  Open naming: server strings "Primary listing" (old Media workspaces, review aliasLabel, catalog/transfer files — import may
  match the text) left as is.
## 23:10
- PR A fixes committed 7d44fb899 (+ invalidatePublishActions on sheet alias create). R6 verifying.
- PR B R5: M2/M3/M4/m1–m6 verified; M1 partly: seed blocks for value sets >12 (gallery or own), variant product's own
  files/Shared list not counted (rowHasOwnPhotos rule), axis values missing from the dictionary, excluded rows; M3 Images tab
  per alias vs per row elsewhere → refined rule (row ASIN vs main row; no ASIN → alias root decides). B4 round 3 running.
## 23:40
- PR A R6: M2, m1–m7, m9, phone width verified; shared read verified (no loops/leaks/collisions). Fixed by me: N1 test
  literal (newRows.wiring). F-A2 final round: N3 variation without its own alias record → alias offered disabled; N2 lone
  listing shows no ★ (Presentation, buyer preview, bar keeps "Selected listing · Clear"); m3 leftover "Primary listing"
  display labels → "Main listing" (display only).
- Known limit (tell the Owner): a waiting End on an ARCHIVED alias cannot be sent (the resolver refuses archived aliases);
  the web has no archive control, so this needs an import-undo/DELETE-route archive first.
