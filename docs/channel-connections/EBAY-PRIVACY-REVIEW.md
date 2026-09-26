# eBay account deletion (privacy)

Status: reworked 2026-09-26 after the approach review (acknowledge first, records that can
finish, notice expiry, immutable-ID matching). **Deployed 2026-09-26** in release B+C (PR #32,
migrations `20260926s`/`20260926t`). Not enabled or production-verified:
`NEXUS_ENABLE_EBAY_PRIVACY_REVIEW` (exactly `1`; worker and scheduler) is OFF, and no eBay deletion
notice has reached Nexus yet. Current state: [COMPLETION-MATRIX](COMPLETION-MATRIX.md).
No business data is anonymised or deleted. The only deletion is the expiry of deletion notices
that no business still needs, and it is dormant behind the same switch.

## eBay's rules this follows

From eBay's [account deletion workflow](https://developer.ebay.com/marketplace-account-deletion):

- Acknowledge each notification at once with 200, 201, 202 or 204. After 24 hours of
  unacknowledged notifications eBay marks the endpoint down; unresolved after 30 days, the
  developer is non-compliant. eBay resends a notification until it is acknowledged.
- Delete the user's data irreversibly, unless it is kept for a specific, demonstrable legal
  need (for example tax).
- For some U.S. users eBay sends an immutable user ID in place of the username, in the
  notification and in the Fulfillment API buyer field.

## Acknowledge first

`receiveEbayNotice` returns as soon as its storage transaction commits and runs nothing after
it. The privacy review is not part of the HTTP request any more.

| Situation | eBay receives |
|---|---|
| Notice stored (new or duplicate delivery) | 200 `{ "received": true }` |
| A later review fails | nothing new: it already has its 200; the worker retries |
| Signature mismatch or unparseable body (metadata-only row kept) | 412 |
| Verification temporarily unavailable (app token or public key) | 503, eBay redelivers |
| Storage fails before commit (database, encryption, identity conflict), including a redelivery whose delivery count cannot be recorded | 503, eBay redelivers |
| Body over 1 MiB (rejected before admission) | 413 |
| Empty body, or no raw body captured | 400 |

## Review in the retry worker

One platform tick on the inbound retry schedule (`NEXUS_ENABLE_INBOUND_RETRY_CRON`, default on)
reviews stored notices, only when `NEXUS_ENABLE_EBAY_PRIVACY_REVIEW` is exactly `1` (default
OFF; no environment was changed). It runs once per tick for the whole installation, never once
per business.

- At most 10 notices per tick. A claim is a compare-and-set lease of 10 minutes, so two ticks
  never review the same notice and a crashed worker's notice becomes due again.
- A failed review backs off from 1 minute, doubling to 6 hours. It is never dropped.
- Unreadable subject data (unsupported schema, a malformed or missing identifier) is kept as
  `unsupported`, rechecked daily, and never expires.
- Enabling the switch also reviews notices received before it, oldest first.
- The worker decrypts the first retained authenticated body outside database locks and wipes
  the returned bytes. A changed redelivery cannot retarget the review.

Review bookkeeping (`reviewAttempts`, `reviewNextAt`, `reviewedAt`, `reviewOutcome`) lives on the
quarantine row. A CHECK allows it only on verified deletion notices; a finished review names
`matched` or `unmatched`.

## Matching

Our order data stores only the Fulfillment API `buyer.username` (written by the approved eBay
order writer; older imports lack it). eBay puts the immutable user ID in that same field for
some U.S. buyers. So:

1. `user_id`: the notice's immutable `userId` equals the stored buyer username field.
2. `username`: the notice's `username` equals it. Fallback only.

Rule 1 is tried across every account of a business before rule 2, and the rule that matched is
stored as `matchBasis`. Matching is exact and case-sensitive. There is no name, email, sole
account or namespace fallback. A malformed identifier makes the whole notice unreadable.
Account provenance is unchanged: same business, OAuth eBay account with a readable seller
identity and an explicit matching environment.

Assumption not proven with live data: the ID in the notice and the ID in the order field are
the same eBay immutable user ID. eBay documents both as the user's immutable ID. A match is
still only a candidate that an owner confirms.

## Erasure request lifecycle

`ErasureRequest` is one business's record of one matched notice. It holds no personal data:
references, channel, environment, `matchBasis`, status and timestamps.

| From | To | Who | Meaning |
|---|---|---|---|
| (new) | `REVIEW_REQUIRED` | verified ingress (system) | candidate, unconfirmed |
| `REVIEW_REQUIRED` | `HELD` | an active OWNER of that business | it is this buyer; erasure waits for the Option A executor (not built) |
| `REVIEW_REQUIRED` | `DISMISSED` | an active OWNER | not this buyer. Done. |
| `HELD` | `COMPLETED` | system context only | the approved erasure executor finished. Done. |

Done means `DISMISSED` or `COMPLETED`. No code writes `COMPLETED` yet: it is reserved for the
Option A executor, which is chosen but not built (see below). A `HELD` request is the
"held" state for every erasure action.

The database guard enforces every transition, stamps `decidedAt`, and refuses any other change.
Nobody deletes or truncates a request. An open request keeps its notice and order: deleting
either fails. A done request releases them: deleting either clears the pointer
(`ON DELETE SET NULL`) and the record stays. `decideEbayErasureRequest` lets an owner hold or
dismiss and writes a `WorkspaceAudit` row (`ebay.erasure.decided`) in the same transaction.
There is no route or screen for it yet.

## Notice expiry

`EBAY_DELETION_NOTICE_RETENTION_DAYS = 30` (`ebay-erasure-review.ts`). A deletion notice is
deleted 30 days after its review finished, once no business has an open request for it: it
matched nothing, or every request is done. Unreviewed, unreadable, handed-off and open notices
never expire here.

Why 30 days: eBay wants the user's data gone unless a specific legal need keeps it. A notice
that matched nothing is itself personal data with no such need. The window only covers eBay
redeliveries of the same notice, operator audit of the review and eBay's own 30-day
compliance window. The database refuses any shorter period.

Path: the retention job (`NEXUS_ENABLE_RETENTION_SWEEP`, default on) gets one platform tick on
its own schedule, dormant unless the privacy switch is exactly `1`. It calls
`nexus_expire_ebay_deletion_notices(retention_days, batch_limit)`: system context only, at least
30 days, at most 500 rows per call and 20 calls per run.

The quarantine history rule (D8) still holds: quarantine rows are never deleted or truncated.
Its one exception is that function, running as the NOLOGIN quarantine writer, removing a
never-handed-off notice whose review finished more than 30 days ago. An open request still
blocks it through the request's evidence guard. Expired notices leave the aggregate census.

## Privileges

- Runtime: `ErasureRequest` SELECT, INSERT (system context only) and UPDATE of `status` only;
  no DELETE or TRUNCATE. Quarantine: UPDATE of the four review columns only, EXECUTE on the
  expiry function, no DELETE.
- Quarantine writer (NOLOGIN, never granted to a login): additionally DELETE on the quarantine
  (reachable only through the expiry function and the history trigger's exception) and a
  read-only view of request `quarantineId`/`status`.
- RLS and business isolation on `ErasureRequest` are unchanged.

## Migration

One unreleased migration, `20260926t_cx_ebay_erasure_review`, edited in place because it was
never deployed: four review columns and an index on the quarantine, the `ErasureRequest` table,
and the shared policy file `workspaces/ebay-erasure-review.sql`. Bounded by a 5-second lock
timeout and a 60-second statement timeout. A later migration that re-applies
`inbound-history.sql` would bring back the blanket quarantine delete refusal; it must re-apply
`ebay-erasure-review.sql` after it (the expiry tests would fail otherwise).

## Owner decision: Option A (2026-09-26), NOT built

The Owner decided the fiscal-retention question on 2026-09-26: **Option A, remove personal data
now.** For a confirmed buyer, replace the name, address, email and phone. Keep only what tax law
requires: invoice number, amounts and dates. Option B (restrict until retention ends) is not
chosen.

This records the rule only. Nothing for it is built, and no business data is anonymised or
deleted by this lane. Building it needs, in order:

1. The accountant's list of fiscal fields and the retention period for each.
2. A data inventory: every place a buyer's personal data is stored (order fields, returns,
   shipping labels, messages, stored inbound bodies, exports, caches, backups).
3. An executor: a dedicated restricted database function that, for each `HELD` request, locks
   the order, overwrites the non-fiscal fields with a fixed token (no mapping kept), and sets
   `COMPLETED` in the same transaction. `COMPLETED` is then limited to that function only.
4. A re-import guard, so the eBay order poll cannot write the buyer's details back.
5. A later job that removes the fiscal fields when their retention period ends.
6. Tests: red first, real-PostgreSQL race tests, guard mutations, a dry-run census, and the
   Owner's approval before it runs against production.
