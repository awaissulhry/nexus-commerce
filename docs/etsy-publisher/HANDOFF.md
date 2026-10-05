# Etsy publisher — HANDOFF

Updated: 2026-10-05 23:05 local, E2 rebuilding after a restart. Lane: ETSY-PUBLISHER (memory: project_etsy_publisher_2026_10_05.md).

## Where we are
- E1 = PR #367 MERGED + LIVE (f5b61c159, deploy 37357596952 OK): review only, nothing sent. Live read-only check OK.
- **E2 in build** (Owner 2026-10-05: E2 yes, D5 = B, D6 = B). Worktree `/private/tmp/feat-etsy-e2-update` (branch
  `feat/etsy-e2-update` from origin/main f5b61c159). Spec: `~/nexus-archive/2026-10-05-etsy-publisher/E2-BUILD-SPEC.md` (§10 = D5 + D6).
- **2026-10-05 ~23:00 local: the Mac restarted and macOS emptied /private/tmp.** The 4 builders' uncommitted E2 edits
  were lost; the worktree was re-created on the same branch and the builders were resumed to redo them.
  Rule from now on: the lead makes a local WIP commit after every builder report (commits live in the main repo's .git,
  which survives a restart); they are squashed into one commit before the push.
- 4 builders, disjoint files: B1 adapter + send, B2 writers/live read/settle, B3 wiring + words, B4 queue coalescing
  (D5) + variation Status (D6).
- Builders DONE (B1 157 tests, B2 578, B3 1291 + web 373, B4 1045; api typecheck clean). Lead: close/reopen-listing pass
  `wholeListing` (keeps the whole-listing pause), many.ts comment. All saved in local WIP commits (latest 64d3c4371).
- Test sweep DONE: no branch failures (api 3376 pass + 3 old MAIN; shared 1258; web 4691; profiles ON 138; static
  61/65 MAIN; 6 ratchets pass); web typecheck pass; real-PG batch suites 3/3 + 2/2 pass; id pre-scan clean.
- Review DONE (E2-REVIEW.md): BLOCKER shared-stock doubling via *_on_property; MAJOR combined write dead-letters good
  rows; 9 minor, 6 nit. Fix round DONE (HEAD f60beef0e): Etsy's own sharing rules kept + refusals; combined write
  falls back to one write per row; minors fixed.
- 2026-10-06 00:02 local, RUNNING (7 agents): E2 review round 2 + test sweep round 2 (on f60beef0e); E3 builders
  B1/B2/B3 in /private/tmp/feat-etsy-e3-create; E5a builders B1/B2 in /private/tmp/feat-etsy-e5a-drift (both on f60beef0e).
  The lead WIP-commits each worktree after every builder report.
- E2 round 2 DONE: review — no blocker/major/minor, all round-1 findings fixed, 4 nits (R2-n1..n4; n3 decided by the
  Owner's rule: a per-variation processing profile is allowed); tests — no branch failures (api 3411, web 4691 + web
  typecheck pass, real-PG 3/3 + 2/2). RUNNING: B1 (R2-n1, n3, n4) + B4 (R2-n2). Then squash, rebase on main, scan, PR.
- Next: fixes → check table → squash → commit scan → PR → wait for "merge #N".
- Owner chose A (parallel). E3 spec DONE (E3-BUILD-SPEC.md: marker in platformAttributes._etsyCreate, recovery via
  Mark as checked, allowDraftStock, Etsy DRAFT reads Inactive). E5 spec DONE (E5-BUILD-SPEC.md: E5a drift on the
  4-hourly sweep + a "Differs on Etsy" mark; E5b Claude tools after E2 merges).
- E3 worktree `/private/tmp/feat-etsy-e3-create` (branch feat/etsy-e3-create) and E5a worktree
  `/private/tmp/feat-etsy-e5a-drift` (branch feat/etsy-e5a-drift) created on E2's tip 45446b4db, npm ci running;
  both get reset to E2's final tip once E2's fix round lands, then their builders start.
- E2 cannot be tested live until E3 makes a draft or the Owner links an existing Etsy listing; a live test needs his yes.
- Nothing pushed for E2. No Etsy call made.

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
- Read this file, then `git -C /private/tmp/feat-etsy-e2-update status` and `git log origin/main..` (WIP commits).
- Do not edit `apps/api/src/services/images/listing-photos.*` (PHOTO-CORE lane). E4 waits for that PR.
- No build before the Owner's yes. No merge before "merge #N". No live Etsy call before his yes. Never set Railway vars.
