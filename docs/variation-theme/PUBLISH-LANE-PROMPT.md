Start a new PUBLISH-EVERYWHERE lane (Owner-approved 2026-09-26: "switch on the publishing for every channel and market";
a separate lane builds the missing publish code, in parallel with VTR).

Read first, in order:
1. /private/tmp/nexus-variation-theme/docs/variation-theme/PUBLISH-EVERYWHERE.md (state today + plan P1–P6; also in PR #45)
2. docs/publish-changes-only/PLAN.md §1, §5, §6 and PROGRESS.md (the PCO publish engine, the live-proof tools)
3. docs/channel-connections/PROGRESS.md rows P4.6 (Etsy writes) and P7a (WooCommerce removal)
4. docs/pes-claims.md (rulings at the TOP, lane rows at the BOTTOM)

Setup: new worktree /private/tmp/nexus-publish-everywhere, branch feat/publish-everywhere from origin/main. Private DB copy whose name
contains "test". Add your claim row at the top of docs/pes-claims.md and name every file before its first edit.

Scope (this lane): P1, P3, P4, P5 of PUBLISH-EVERYWHERE.md.
- P1: re-prepare the two PCO one-listing proofs (Amazon IT, eBay IT Trading) with fresh reads. Show the Owner the EXACT send.
  Run each only on the Owner's word for that run.
- P3: eBay studio publish for Inventory-model listings (8 live families on the local copy) and variation changes on live items.
- P4: Shopify change-only publish for existing (linked) products, and product linking. The value order comes from VTR step 1.
- P5: Etsy studio publish adapter (content + variations) on the P4.6 write client.
- NOT this lane: WooCommerce (Owner: keep the removal, channel-connections P7a); variation theme/values (VTR).

Rules:
- Research and a written plan first. Code only after the Owner approves the plan.
- A publish switch (Railway NEXUS_ENABLE_*_PUBLISH / *_PUBLISH_MODE) changes only on the Owner's word for that channel. The first send
  per channel is ONE listing: read → preview → write → read back → restore.
- No production writes without the Owner's word. The repo is PUBLIC: scan every commit for real listing, seller and policy ids.
- VTR holds studio-publication-ebay.ts, studio-publication-plan.ts, stored-variation-projection.ts and variation-rules.service.ts until
  PR #45 merges. Coordinate before you edit them.
- Talk to the Owner in simple, short English.
