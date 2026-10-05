# Etsy publisher — HANDOFF

Updated: 2026-10-05, E1 PR #367 open. Lane: ETSY-PUBLISHER (memory: project_etsy_publisher_2026_10_05.md).

## Where we are
- **E1 = PR #367 (open, waits for the Owner's "merge #367").** Branch `feat/etsy-e1-review`, one commit on main
  bd00d21f8. Worktree `/private/tmp/feat-etsy-e1-review`. Local backup branch `backup/etsy-e1-before-squash` (delete
  after the merge).
- E1 sends nothing to Etsy. Checks: typechecks pass; API area 1896 pass + 3 old delete-and-relist (MAIN); profiles ON
  286 pass; shared 1255; web 4027; static gates 61/65 (4 MAIN); gateway ratchet ETSY 0; real-id scan clean.
- Reports: `~/nexus-archive/2026-10-05-etsy-publisher/` — E1-BUILD-SPEC.md, E1-REVIEW.md (3 rounds), E1-TEST-SWEEP.md (2 rounds).
- After the merge: check that a Deploy API run exists for the merge SHA and watch it (memory: deploy push event can be missed).
- Next PR: E2 (send updates to listings that exist). Its must-dos are in PLAN.md "E1 notes for the next PRs".

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
- Read this file, then `git -C /private/tmp/feat-etsy-e1-review status` (builders' uncommitted work lives there).
- Do not edit `apps/api/src/services/images/listing-photos.*` (PHOTO-CORE lane). E4 waits for that PR.
- No build before the Owner's yes. No merge before "merge #N". No live Etsy call before his yes. Never set Railway vars.
