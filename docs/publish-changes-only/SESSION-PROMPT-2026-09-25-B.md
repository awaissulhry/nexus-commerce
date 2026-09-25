Continue the PCO lane: task A (Publish sends ONLY what changed, per product and per field, since the last publish — Amazon,
eBay, Shopify) and task B (direct calls to the channels). Branch `pes/phase-0`, repo /Users/awais/nexus-commerce.

READ FIRST, in this order:
1. docs/publish-changes-only/SESSION-PROMPT-2026-09-25.md — its §3 rules bind (claims, `git commit --only`, no stash/amend/
   --no-verify, predictions before every run, mutations, closure fields, API tests from apps/api only, every live channel write
   needs my word in the chat per run: read → preview → write → read back → restore → delayed re-read).
2. docs/publish-changes-only/PLAN.md — the plan, measured on 2026-09-25, FOR MY RULING (Q1, Q2 in §8).
3. docs/publish-changes-only/PROGRESS.md — the facts not to re-derive.

FIRST ACTIONS:
- Re-claim the lane at the TOP of docs/pes-claims.md (the old PCO row says the lane was released). Push check first:
  ps -axo pid=,command= | /usr/bin/grep -E "^ *[0-9]+ (/[^ ]*/)?git push|^ *[0-9]+ /bin/bash \.githooks/pre-push"
- Finish PLAN.md §1b (marked 🟠 OPEN): the READ-ONLY sweep of every AUTOMATIC channel writer (cron, BullMQ worker, event cascade,
  boot job) for Amazon, eBay, Shopify — trigger + env flag + default, what it sends, which gate it checks, file:line; above all any
  write that bypasses all three gates; whether a BullMQ outbound worker runs in production; any automatic replay of dead rows;
  which writers start the day the Shopify gate opens. The previous sweep was stopped mid-way (it was reading FBA restore,
  ebay-label-guard, listing-end-times, shopify-linked-automation).
- Then give me Q1 and Q2 again in plain short English. Build NOTHING before I rule.

FACTS ALREADY MEASURED (2026-09-25, production, read only — records in docs/publish-changes-only/records/):
- Production gates: Amazon = live, eBay = live, Shopify = gated (Railway boot log, deploy 674bf97f, 2026-09-24 20:23 UTC).
  The local apps/api/.env sets no gate flag → all gated locally. One gate per channel controls EVERY writer of that channel.
- Queue: 2,199 FAILED rows, all isDead → never re-sent automatically; 0 rows would be picked now; Shopify has 0 rows.
- No publish baseline exists: ChannelListingSnapshot = 0 rows; one studio send ever (Amazon IT, 21 products, 2026-09-14).
- Local measure: one field changed on one child → Publish still sends all 9 messages; the change is 206 of 8,662 bytes (2.4 %).
- Known overwrite exposure: GALE-JACKET · Amazon DE, 13 listings. UNKNOWN (never content-read): Amazon IT 183, DE 23, ES 30,
  FR 36 open listings, and eBay content 0 of 332 (the eBay ChannelDrift rows are the stock read-back).
- eBay Inventory-model: 208 of 332 listings (8 families) refused by studio Publish. Amazon closed offers: DE 178 / ES 93 / FR 79
  listings; one closed product refuses its whole family.
- Shopify: I will link the products and listings later. Shopify stays gated until then.
- Amazon PATCH feed messages + a per-root replace/delete builder already exist (services/amazon/mapping-payload.ts:71-75).

TRAPS:
- The gate files (services/{amazon,ebay,shopify}-publish-gate.service.ts) — I allowed the read. If a safety check refuses it,
  STOP and ask me for the permission rule; never work around it.
- Run read-only production tools yourself (docs/publish-changes-only/tools/*.mjs use BEGIN READ ONLY). Timestamps as UTC text in SQL.
- `timeout` does not exist in this shell. `grep` is a function — use /usr/bin/grep.
- docs/pes-claims.md carries other sessions' uncommitted edits: never commit it whole.
- Nothing from session 1 is committed (PLAN.md, PROGRESS.md, tools/, records/ are untracked). Commit only on my word.
- No artifacts. Report in plain, short English: what you did, did it work, what I do now.
