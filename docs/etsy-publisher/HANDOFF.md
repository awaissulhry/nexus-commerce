# Etsy publisher — HANDOFF

Updated: 2026-10-06 00:45 local. Lane: ETSY-PUBLISHER (memory: project_etsy_publisher_2026_10_05.md).

## Where we are (2026-10-06 ~01:55 local)
- MERGED + LIVE: E1 #367 (f5b61c159), E2 #375 (a1393f12c), E5a #378 (1d207cf19; deploy 37388641505 OK).
- E3 (create as draft): reviews 2 rounds (all MAJOR fixed), test sweeps 2 rounds (2 branch typecheck items fixed).
  Squashed + rebased onto main 1d207cf19 as e333c0e8d in `/private/tmp/feat-etsy-e3-create` (backup branch
  backup/etsy-e3-before-squash). Final checks PASS; PR opened (see the PR list).
- E5b (Claude tools + skills): fix round RUNNING in `/private/tmp/feat-etsy-e5b-tools`. After E3 merges: rebase,
  remove Claude's create guard (Claude may create drafts with a person's approval), update skills for E3 + E5a,
  review again, PR.
- E4 (photos + go live) waits for the PHOTO-CORE lane's shared photo PR.
- Railway switches (the Owner sets them, never Claude): NEXUS_ENABLE_ETSY_PUBLISH=1 + ETSY_PUBLISH_MODE=live (sending);
  NEXUS_ENABLE_ETSY_ORDER_INGEST=1 + the Motovento Etsy account's order-import activation (stock; not needed for drafts).
- No live Etsy call has been made. A live test needs the Owner's yes (one draft, one Motovento product).
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
