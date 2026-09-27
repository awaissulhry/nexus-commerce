# Channel connections — approach review (2026-09-26)

Public summary of the review the Owner asked for when this session took over the programme: "first
check that the approach is right". Verdicts and decisions only. The production measurements behind
it (counts, products, dates of individual orders) stay in the local record, not in this public
repository. Current status lives in [COMPLETION-MATRIX](COMPLETION-MATRIX.md).

## Summary

- **The safety core is right** and stays: real PostgreSQL for locks, races and row security,
  red-first tests, independent review, and a recovery build for every migrating release (a migration
  cannot be rolled back).
- **A live stock bug was found** that the plan had parked behind the release queue: Amazon FBM orders
  were deducted twice (an order line that was already taken could be held and taken again). It was
  fixed first, as a small hotfix (PR #14).
- **Several lane designs were wrong or over-built** (table below) and were changed before shipping.
- **The release method changed:** `main` takes pull requests; ship two releases (Package A, then B+C
  as one PR), not three packages over about twelve lanes.
- **Scope:** most channel value is built but switched OFF. No real eBay or Etsy event had been
  processed end to end. Finishing needs a switch-on and live-proof phase with the Owner, not only
  more code.

## Owner decisions (2026-09-26)

1. Stock bug: a small hotfix PR first (PR #14). The damaged stock is repaired only with a separate yes,
   after the hotfix is proven in production: add back, per product, only the units taken twice after
   that product's last manual stock change. **Applied 2026-09-26 11:22 UTC — do not run it again.**
2. Plan: change it as this review says — fix the wrong designs, drop unneeded parts, two releases by PR.
3. Merging: the Owner decides every merge; each pull request is merged only on the Owner's word.
4. KMS: Package A may use KMS after a KMS test passes.
5. eBay account deletion: option A — remove personal data now, keep only what tax law needs.
   Recorded, not built.
6. Shipped, then cancelled or refunded: keep the stock taken and notify the owners; returns restock.
7. Etsy: hold stock from receipt arrival, also while the payment is processing; release it if the
   payment fails (replaces the earlier "hold when paid").

## Verdicts by area

| Area | Verdict | Why (short) | Outcome |
|---|---|---|---|
| Real PostgreSQL, red-first, review, recovery build | KEEP | Essential; migrations cannot be rolled back | kept |
| Mutation testing on every guard | KEEP for stock, money and security; proportionate elsewhere | Cost against value | applied |
| Direct push to `main` | CHANGE | Settings on `main` deny it; branch and PR | PRs #14, #15, #32 |
| Three packages over about twelve lanes, a rehearsal per package, the full hook twice | CHANGE | Ship A, then B+C as one PR; one rehearsal per migrating deploy | done |
| Status block pasted into five documents | STOP | One status file; the others link to it | COMPLETION-MATRIX is the status file |
| Production evidence files committed to the repository | CHANGE | The repository is public; evidence stays local | removed from the PRs |
| Package A code | KEEP | Unchanged since its gate | PR #15 |
| Package A with KMS now on in production | NEW CONDITION | Its crypto now runs against KMS; the rehearsal had none | KMS test added before merge |
| Inbound event locking | CHANGE (coordinate) | Package A's eBay leases and PR #4's processing claims touch the same table | one owner per row type (PR #15) |
| Stock model across channels | CHANGE | Several hold/consume/restore paths and locks; channels disagreed after a shipment | one stock model R1–R10 (PR #32) |
| eBay single-transaction order writer | KEEP | Right layer | PR #32 |
| Amazon "no second hold", status under lock | KEEP, ship first | Fixes the live bug | PR #14, PR #32 |
| Amazon stock history reader and overlap planner | CHANGE | Wrong layer; a simple rule inside consume instead | dropped (R1 + reconcile) |
| Etsy per-line holds | KEEP the idea, CHANGE ownership | A second hold record that other paths bypassed could break a receipt for good | dropped; hold identity covers it |
| Etsy pooled line-level consumption | CHANGE | Rare case; the owner notice gives the same safety | dropped; whole-receipt consume |
| Etsy failure policy | CHANGE | One unmapped shipped SKU stalled every poll | R5: record on the line, never block |
| `stock_blocked` | CHANGE | The alert led to a manual fix that later deducted twice | R6: automatic retry |
| Two `InsufficientStockError` classes | CHANGE | Same name, different modules; `instanceof` failed silently | R7: one class |
| eBay price per market | CHANGE (simplify) | One SKU cannot sit on several eBay markets | one market per row (PR #32) |
| eBay read-back B1 / Trading sweep B2 | KEEP (B1 out of the request budget) | — | PR #32 |
| eBay variation price confirmation | CHANGE | False "unconfirmed" on large families | one bounded GetItem per listing |
| Amazon Finances A0, A2, A5 | KEEP | A5 stays unexecuted | PR #32 |
| Amazon Finances A3/A4 | CHANGE (hold) | Mapping knew one charge type; a lock-taking migration risked a blocked deploy | held on branch |
| Contract checks | CHANGE | Amazon checks were circular; Etsy could never be green | relabelled; Etsy not applicable |
| eBay account deletion (privacy) | CHANGE (direction) | Acknowledge eBay first, review later; records that can finish | reworked (PR #32), switch OFF |
| Listing-issues card | KEEP, small change | Link SKU, product and listing; hide raw codes | PR #32 |
| Membership account backfill | STOP | Nothing needed it | dropped |

## Scope gaps found (not owned by any package)

- Amazon Ads integrity: some drift rows can never close (the resolve pass closes campaign rows only).
  Planning.
- Amazon app-secret expiry date is still unknown; automatic rotation is off and also needs an AWS
  permission for its queue.
- Amazon Orders 2026 switch-on (target 2026-12-15) and newer Amazon notification types.
- Shopify is connected but has no order webhooks and no order poll. Planning.
- eBay inventory read-back still uses environment app credentials.

## Revised sequence and where it stands

1. Hotfix PR (FBM double deduction) — merged and deployed (PR #14). Repair applied the same day on the Owner's yes (option A).
2. Package A — merged and deployed (PR #15).
3. Rework the lanes per the table, one stock rule for all channels — done.
4. B+C as one PR — merged and deployed (PR #32).
5. Switch-on phase with the Owner: each switch ON, one real event proven per channel — **not started**.
