# Etsy publisher — HANDOFF

Updated: 2026-10-05, Phase 3 started (E1). Lane: ETSY-PUBLISHER (memory: project_etsy_publisher_2026_10_05.md).

## Where we are
- Phase 1 research DONE (4 agents, read-only). Phase 2 plan DONE: `docs/etsy-publisher/PLAN.md`.
- **Owner approved the plan, D1–D4 = A (2026-10-05).** E1 started.
- E1 worktree: `/private/tmp/feat-etsy-e1-review` (branch `feat/etsy-e1-review` from origin/main 502761c62); npm ci + shared/events built.
- E1 spec DONE: `~/nexus-archive/2026-10-05-etsy-publisher/E1-BUILD-SPEC.md` (§9 = lead amendments: the plan shows in
  every mode; Etsy is read only when live).
- Baseline on clean main (E1 area): 1174 pass, 3 fail — the 3 old "delete and relist" tests in studio-publication.vitest.test.ts.
- Builders DONE (B1 adapter 81 tests, B2 live read + shop label 17 tests, B3 wiring 8 tests + edits). Lead fixed the
  Etsy whole-family Not-listed hold (publish-plan.ts) + 2 stale comments. Web typecheck pass. Committed LOCALLY (not pushed).
- Test sweep DONE (`~/nexus-archive/2026-10-05-etsy-publisher/E1-TEST-SWEEP.md`): NO branch failures. Typechecks
  shared/api/web pass; API area 1667 pass + 3 old delete-and-relist (MAIN); shared 1250 pass; web 252 pass; profiles ON
  224 pass; static gates 61/65 (4 fail identically on main); gateway ratchet ETSY 0.
- Review DONE (`~/nexus-archive/2026-10-05-etsy-publisher/E1-REVIEW.md`): nothing writes to Etsy; 3 MAJOR (processing
  profile must block; a new variation of a live listing ignores its own Status; identity check calls any Etsy read
  "live"), 8 MINOR, 11 NIT.
- Fix round DONE (B1 94 tests, B2 51 tests, B3 wiring 10 tests; lead applied the sheet facts patch in
  publish-action.service.ts + a test, and the identity tool text). Committed locally as the 2nd commit.
- Round 2 DONE: tests — no branch failures (api 1871 pass + 3 old MAIN; web 4616; shared 1252; profiles ON 258);
  review — no blocker, 17 fixed, new N1 (new variation of a live listing defaulted hidden with no way back) + N2 wording + 6 nits.
- Commit scan (both commits, real ids from the local copy nexus_sheet_publish_test + R4 Etsy ids, 2 positive controls):
  CLEAN. But commit 1 holds a business name in a test line (fixed in commit 2) → squash to ONE commit before the push.
- Round 3 fixes DONE (B3: a new variation of a live Etsy listing defaults Active, hidden refused for now; true option
  words; off-live Etsy error "Sending to Etsy comes in the next Nexus update…"; B1: N4 N5 N7; B2: N3 N8). Lead: batch
  "Nothing was sent." said once (notSentMessage).
- RUNNING: final full checks (log scratchpad e1-final-checks.log). NEXT: squash to one commit, re-scan, PR.
- E2 traps noted (not fixed in E1): batch SPARSE set (publication-batch.service.ts:55) + processor ticks (:506) lack ETSY;
  the claim revision includes live stock.
- Nothing pushed. No Etsy call made.
- Old plan worktree `/private/tmp/etsy-publisher-plan` is read-only reference now.

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
