# Etsy publisher — HANDOFF

Updated: 2026-10-06 00:45 local. Lane: ETSY-PUBLISHER (memory: project_etsy_publisher_2026_10_05.md).

## Where we are (2026-10-06 ~02:20 local)
- MERGED + LIVE: E1 #367 (f5b61c159), E2 #375 (a1393f12c), E5a #378 (1d207cf19). MERGED: E3 #379 (f263e1c59; deploy
  run 37390609598 being watched).
- E5b (Claude tools + skills): squashed + rebased onto main f263e1c59 as 8dc7cf5c1 in `/private/tmp/feat-etsy-e5b-tools`
  (backup branch backup/etsy-e5b-wip). FINAL STEP RUNNING: remove Claude's create guard (Claude may create Etsy drafts
  with a person's approval), skills true for E3 + E5a, plugin 0.3.3. Then review + test sweep round 2, final checks, PR.
- E4 (photos + go live) waits for the PHOTO-CORE lane's shared photo PR.
- Railway: the Etsy SENDING switch is ON in production since 2026-10-06 ~02:30 local (NEXUS_ENABLE_ETSY_PUBLISH=1 +
  ETSY_PUBLISH_MODE=live on @nexus/api, nexus-worker, nexus-scheduler; set by Claude on the Owner's explicit request,
  after he allowed the Railway set-variables tool for this project). Read-only check: the review shows mode "live".
  NOT set: NEXUS_ENABLE_ETSY_ORDER_INGEST (stock; not needed for drafts; needed before anything goes live with stock).
- No Etsy write has been made yet. A first draft needs the product's own Etsy fields filled (description, category,
  who/when made, craft supply, the variations included) and a person pressing Publish. Writes for a create: the create
  POST, then the inventory PUT, plus one call per attribute and per translation if the sheet has them.
  Undo: delete the draft on etsy.com, then clear the Listing ID in the sheet.
- Known MAIN failures (not ours): 3 "delete and relist" tests; static gates shell pin freshness, dark ⇄ pin parity,
  DS api guard, token resolution; studio-publication-database profiles-ON; real-PG MCP.8 (3 tests).
- Lesson: the API image compiles with tsc --noCheck — rebuild shared before typecheck after every rebase.

## Research results (one line each)
- R1 Etsy API: no idempotency key; inventory PUT is a full replace; price/qty/SKU/processing only via inventory;
  draft needs qty ≥ 1; active at 0 = sold out; go-live needs ≥ 1 photo + shipping + processing profile.
- R2 contract: no registry — Etsy needs branches in studio-publication.service.ts + an adapter like eBay's; full
  branch list in R2 §7.3.
- R3 Etsy in Nexus: connector, clients, gate, price/stock doors, Pause/Resume exist; no create, no full update, no
  variations build, no photos, no live read; legacy Etsy sync is dead.
- R4 data: only Motovento has an Etsy shop (connected); 0 Etsy listings in Nexus in both businesses.
- Account label: the review shows `ChannelConnection.displayName` (a 16-char value) instead of the shop name —
  not a secret by the code path; E1 fixes the label.

## Files
- Prompt: `~/nexus-archive/2026-10-05-etsy-publisher/PASTE-IN-PROMPT.md`
- Research: `~/nexus-archive/2026-10-05-etsy-publisher/{R1-ETSY-API,R2-STUDIO-CONTRACT,R3-ETSY-IN-NEXUS,R4-ETSY-DATA,ETSY-PHOTO-RESEARCH}.md`

## Next step
- E1: builders → adversarial reviewer + test sweep → fixes → check table → commit scan → PR → wait for "merge #N".

## Rules for the next session
- Read this file, then `git status` + `git log --oneline -5` in each of the 3 worktrees above (WIP commits hold the work).
- Do not edit `apps/api/src/services/images/listing-photos.*` (PHOTO-CORE lane). E4 waits for that PR.
- No build before the Owner's yes. No merge before "merge #N". No live Etsy call before his yes. Never set Railway vars.
