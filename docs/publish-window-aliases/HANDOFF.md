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
