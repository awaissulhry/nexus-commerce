# One stock model for every channel (2026-09-26)

Status: built on branch `cx/stock-model-20260926`, not pushed, not deployed. Approved direction:
"fix the wrong designs, drop parts that are not needed" (Owner, 2026-09-26). Builds on the hotfix in
PR #14 (R1). Fitted to current main (#4, #14, #15, #18). Real-PostgreSQL suites prove each rule; the
review round of 2026-09-26 (items A, B1–B5, C1–C7, D) is folded in below.

## Owner rulings (2026-09-26)

1. **R4 confirmed.** A cancellation or a full refund after (part of) an order shipped keeps the stock
   that shipped taken and tells the owner. Stock comes back only through a booked-in return.
2. **Etsy holds on arrival (replaces S1 "hold when paid").** An Etsy receipt holds its stock as soon as
   it arrives, also while Etsy is still processing the payment (up to about three days). If the payment
   fails, Etsy cancels the receipt and the hold is given back. The stock is taken when the whole receipt
   has shipped, as before.

Integration ruling (same day): every non-eBay inbound webhook row is owned by the generic processing
claim (`cx/ingress/claims.ts`, PR #4). The Etsy writer no longer writes its own row; the claim finishes,
retries or defers it, fenced by its token (`deferInboundClaim` for a deferral), so a stale claim holder
cannot complete a row.

## The rules

| Rule | What it says | Where it lives |
|---|---|---|
| R1 | Never hold units an order line already took; consume at most ordered − taken (own and shared stock counted together); a bigger hold gives its surplus back. | `stock-level.service.ts` (`reserveOpenOrder`, `owedToOrder`, `consumeReservation` with `capToOrder`) |
| Hold identity | An order's hold for a product stays on the side it was first made: an open or taken own hold keeps it on own stock; an open or taken pool hold keeps it in the pool, also after a grant pauses or ends. A hold that was given back pins nothing. The side is decided and the hold made in ONE transaction under the order-stock lock door. | `heldSide`, `reserveOpenOrder`; read door `nexus_pool_order_hold` |
| R2 | One owner: every hold, consume, release, at-ingest take, cancellation give-back and order movement (ORDER_PLACED, RESERVATION_CONSUMED, ORDER_CANCELLED) goes through `stock-level.service.ts` (plus the pool doors). | `scripts/check-stock-writer-lock.mjs` and its self-test (`reservationFiles`, `orderMovementFiles`, SQL functions in policy files and migrations) |
| R3 | Lifecycle follows the marketplace (table below). | channel writers |
| R4 | Cancellation or full refund, all channels: nothing shipped — open holds are given back and units taken at ingest come back. After (part of) a shipment — see "Cancellation after a partial shipment". One owner notice. | `order-cancellation/index.ts` (E3, `settleCancelledOrderHolds`), `settleOrderHoldsInTx`, the reconcile, the Etsy writer |
| R5 | A problem on one part of an order (no product, no warehouse, shortfall, no stock level, shared stock refused, an unreadable line, date or total) is recorded on the line or the order and told once; it never blocks the order record or the rest of a poll. Only an order with no usable id is refused (nothing to record it under), and the owners are told. | Etsy writer (`etsyMetadata.stock`), eBay writer (`ebayMetadata.stockEffect`, `ebayMetadata.problems`) |
| R6 | A `stock_blocked` eBay line is taken automatically once its configuration resolves: by a later read of the order and, whatever its age, by every scheduled eBay order sync from the database. The notice never asks for a manual stock change. | `ebay-order-writer.ts` (`retryBlockedEbayLines`), `jobs/ebay-orders-sync.job.ts` |
| R7 | One `InsufficientStockError` for holds and movements. | `stock-movement.service.ts` |
| R8 | "Order written SHIPPED, the process died before consume" heals without a history reader: the next poll holds what is still owed (R1) and the reconcile consumes it, exactly once. | proven in `stock-model-postgres` |
| R10 | Several lines of one product: one hold per (order, product) for the total of its lines. No cutoff for history: a read-only check of production (2026-09-26) found no order with one product on two lines. | `unitsPerProduct` and its callers |

Shipment evidence (R4) is any of: `Order.shippedAt` or `deliveredAt` (every writer sets `shippedAt` on its
first shipped read, a partial one included; Shopify also when an order is created already fulfilled), a
consumed own hold, a consumed pool hold (`nexus_pool_order_shipped`), a parcel past pickup, or a channel
line that says it shipped.

### Cancellation after a partial shipment (C1)

Per product, the units the channel says shipped, line by line: Amazon `QuantityShipped` per order item,
eBay `lineItemFulfillmentStatus` (stored on each line every read; FULFILLED = all, NOT_STARTED = none),
Etsy's per-line shipped time, Shopify's fulfilments.

- Held channels (Amazon FBM, Etsy, Shopify): the units that shipped are taken out (an own hold is split:
  shipped part consumed, rest released, one reservation; a pool hold is taken whole by door 4a and the
  unshipped rest put back once by door 5), the rest given back.
- eBay (taken at ingest): only the units of lines that did not ship come back, own and shared (door 5).
- A product the channel does not describe keeps its hold (never released into stock, also by the
  reconcile) or its units stay deducted (eBay). Evidence of a shipment while every described line says
  nothing shipped is a disagreement: nothing is released.
- The notice says exactly what happened: nothing that shipped came back (a booked-in return puts a
  returned parcel back), how many unshipped units went back on sale, what is still held or deducted
  because the channel does not say, and the one safe action — a stock-page release of this order's own
  hold, or, for a hold in shared stock, asking the lending business to release it on its Stock →
  Reservations page. It never suggests a restock that could count a unit twice. A refund is called a
  refund.
- A pool hold kept this way is released by the LENDER: its Stock → Reservations page already lists every
  hold of its stock with a Release action (and a confirmation). That action now works for exactly this
  case — the borrowing business's order is cancelled or refunded — through the door
  `nexus_pool_lender_release` (lender only, checked in the database; the movement names the actor and why;
  the route writes an audit log entry). While the order is open it is refused as before. No new UI.

Shopify partial fulfilments (re-review of 2026-09-26): each fulfilment — the `fulfillments/create`
webhook, or the fulfilments an `orders/create` / `orders/updated` payload lists — takes out only the units
it fulfilled, line by line; the rest stays held (an own hold is split: the shipped part consumed, a
continuing hold keeps the rest; a pool hold is taken whole once its product is complete). The order is
PARTIALLY_SHIPPED until every line is fulfilled, then SHIPPED. Duplicate deliveries take nothing (the
fulfilment is recorded by id; takes are capped by what the order owes). Before, the first fulfilment,
even a partial one, set the order SHIPPED and took every hold, so a refund after it gave nothing back.

Shopify's own restock of a refunded unit arrives through its inventory webhook and is applied to the
Shopify location, a channel mirror that is not part of the stock that sells (`Product.totalStock` counts
warehouses only); the booked-in return restocks the warehouse. One unit is counted once in what sells
(real-PG arm "C5 Shopify"). A read-only check of production (2026-09-26) found no stock location mapped to
Shopify, so this shape cannot occur yet; the test stays for when one is mapped.

## Per-channel lifecycle

| Channel | Takes stock | Hold | Consume | Cancel before shipment | Cancel or refund after (part of) shipment |
|---|---|---|---|---|---|
| eBay | at ingest (single-transaction writer), per line; pool door 4b once per order and product | — | — (taken at ingest) | give back the ORDER_PLACED units (own and pool) | lines eBay says did not ship come back; the rest stay deducted; owner notice |
| Amazon FBM | on shipment | on Pending/Unshipped/PartiallyShipped reads | when the order is SHIPPED (poll on the transition; the reconcile otherwise), capped | release | shipped units taken, the rest released, by QuantityShipped; no data: hold kept; owner notice |
| Etsy | on shipment | on arrival, payment processing included (Owner ruling 2) | when the WHOLE receipt has shipped; a partial shipment keeps the hold and tells the owners | release (a failed payment is this case) | shipped lines taken, the rest released; owner notice |
| Shopify | on fulfilment | on `orders/create` | on fulfilment | release | fulfilled units taken, the rest released; owner notice ("refunded" for a refund) |
| Amazon FBA | never: FBA quantity belongs to Amazon | — | — | — | — |

All holds are per (order, product) in the stock ledger; the reconcile settles open holds of shipped
(consume) and cancelled (the C1 settlement) orders for every channel. The stock page's manual release is
the same `releaseReservation`, so every path sees one record.

Locks: every order hold, every cancellation settlement and all stock work of the eBay and Etsy writers
take the order-stock lock door (`nexus_lock_order_stock`) first — the order's products, the sources of
every pool link they ever had (not only active ones) and the pool-link lock, in one sorted set — so two
orders with lines in opposite orders, a grant change and a hold, or a link switch and a hold run one after
the other. A consume takes the product lock of each hold it settles (and the pool doors theirs).

## Dropped, and why

- **Amazon stock history reader** (`65bda8b72`, migration `20260925f_cx_amazon_stock_history`) and the
  uncommitted overlap planner (`20260925g_cx_amazon_stock_overlap`): R8 is healed by R1's re-read path plus
  the reconcile, proven for item-fetch, hold and consume failures, own, pool and mixed.
- **`reuseClosedReservation`** (Amazon lane): R1 already refuses to re-hold taken units, and released
  units must stay re-holdable (an MCF cancel and re-submit).
- **Amazon/Shopify cancellation restore retry** (`b77db1bd3`): under R4 those channels never take stock at
  ingest, so a cancelled order has no ledger debt to retry; open holds are retried by the reconcile.
- **`OrderLineHold`** (`20260924b`'s table): a second record of holds that manual release, the reconcile and
  E3 never updated, so a receipt could fail forever. Its one concrete case (a product switching between own
  and shared stock between reads) is covered for every channel by hold identity.
- **Etsy pooled line-level consumption** (`20260925e_cx_pool_line_consume`): not needed once Etsy consumes
  the whole receipt (R3); it also wrote stock without the literal product lock the writer gate requires.
- **Per-line Etsy consumption and the Etsy lane's throw-on-stock-failure integration** (saved, uncommitted):
  replaced by R3 and R5.

Kept from the lanes: the eBay single-transaction writer, the eBay order stock lock door
(`nexus_lock_order_stock`, used by every order stock path), E3's per-movement markers, Amazon's status
decided under its write lock (`016c34629`), shipped FBM status never regressed by a stale read, a line kept
on its first product, Etsy scan resume and reconciliation.

## Migrations

Never deployed, named to sort after everything on main (#18's `20260926a`/`20260926b`, #22's `20260926m`):
`20260926n_cx_order_stock_locks` (the lock door; sources of every link),
`20260926o_cx_pool_order_history` (pool restore detector counts ORDER_PLACED only; adds
`nexus_pool_order_hold`, `nexus_pool_order_taken`, `nexus_pool_order_shipped`),
`20260926p_cx_etsy_receipt_ingest` (Etsy ingest tables only; its foreign keys to `ChannelConnection` run
under `lock_timeout = 5s`), `20260926q_cx_etsy_scan_resume`, `20260926r_cx_etsy_reconciliation`,
`20260926u_cx_order_lock_pool_holds` (the lock door also locks the sources of an order's open pool holds;
a two-argument form, the one-argument form kept and delegating), `20260926v_cx_pool_lender_release` (the
lender's release of a kept pool hold). They apply on a database in main's state (CI's expand/contract gate
and migration upgrade check pass). No migration on main or in PR #15 was edited. A later main migration
dated 2026-09-26 would need these renamed again.

Runbook — if `20260926p`'s 5 s `lock_timeout` fires (a long transaction held `ChannelConnection` during the
release): the migration is wrapped in one transaction, so nothing of it is applied, but Prisma records it
as failed and every later `migrate deploy` stops with P3009 until it is resolved. Check with (read-only):
`SELECT migration_name, started_at, finished_at, rolled_back_at, logs FROM "_prisma_migrations" WHERE
migration_name = '20260926p_cx_etsy_receipt_ingest';` — a failed run has `finished_at` and `rolled_back_at`
both NULL and a lock-timeout (55P03) message in `logs`; confirm the Etsy tables do not exist
(`SELECT to_regclass('"EtsyReceiptIngest"')` is NULL). Then, with the Owner's approval only:
`prisma migrate resolve --rolled-back 20260926p_cx_etsy_receipt_ingest` against the direct (non-pooler)
endpoint, and redeploy at a quieter moment. Never mark it applied.

## Production-facing on deploy (no switch)

The eBay orders cron runs in production, so the eBay order writer is live on deploy. Compared with main's
eBay ingestion:

- eBay: the order, its unseen lines and each line's stock effect commit together or not at all; a stock
  failure no longer leaves a recorded sale that never left the shelf.
- eBay: not enough own stock records the sale as `shortfall` and tells the owners (main logged and skipped
  the deduction); a configuration refusal (no single default warehouse, the pooled-product guard) records
  `stock_blocked`, tells the owners, and is taken automatically once resolved (R6) — including by every
  scheduled sync from the database, one extra query per business per tick.
- eBay: a refusal of shared stock is recorded on the line and told (main logged it); a line whose pool
  take was already made is `pool_reused` and not counted as deducted.
- eBay: concurrent reads of one order (poll, replay) write it once (account, order and stock locks).
- eBay: a line links to a product only through this seller's eBay listings (verified sibling accounts
  included), then the SKU; the eBay line id no longer matches another channel's listing; ambiguous matches
  stay unlinked.
- eBay: an order already recorded for a different eBay seller is refused with no change; an order linked to
  an account without a readable identity is updated, keeps its link, and the owners are told once.
- eBay: an order that cannot be recorded tells the owners once per failure class (transient lock contention
  is retried silently); an inactive business records nothing.
- eBay (R5): an order with unreadable parts is recorded with its readable lines; an unreadable date or
  total falls back (a stored order keeps its own; a new one takes its first read time and 0); unreadable
  lines take no stock; the parts are kept on the order and told once. Only an order without a usable id is
  refused.
- eBay: the first shipped read records `shippedAt`; each line keeps eBay's fulfilment status; a
  cancellation gives back exactly what the order took at ingest (per taking movement, once), and after a
  partial shipment only the lines that did not ship (C1).
- Cancellations no longer create stock for an order that never held or took any (main's cascade added the
  full ordered quantity back when no hold was released): an order that arrived cancelled, a shortfall line,
  a released hold or an FBA order gets nothing back.
- R4 and C1: cancelling or refunding an Amazon, Shopify or Etsy order after (part of) it shipped no longer
  puts shipped units back; units that did not ship are released; with no line data the hold is kept. The
  reconcile follows the same rule, and the owners are told.
- R10: a re-read of an Amazon order with several lines of one product holds and later takes the total.
- Hold identity: an order held in shared stock is no longer held again from own stock while a grant is
  paused or after it ends; a hold that was given back does not pin the order to the pool.
- Amazon: a stale pre-shipment read no longer regresses a shipped FBM order; the status decision is locked.
- Shopify: an order created already fulfilled records its shipped time.
- Shopify: a partly fulfilled order is PARTIALLY_SHIPPED (was PROCESSING); each fulfilment takes only its
  units (was: the first fulfilment took every hold and set SHIPPED).
- Stock page: the Release action on a hold of this business's stock for another business's order now
  works when that business cancelled or refunded the order and kept the hold (lender only, audited).
- The first reconcile after deploy releases (never consumes) surplus open holds, as PR #14 describes.
- Etsy order ingest stays behind its switches: the receipts poll cron is scheduled by the scheduler process
  only with `NEXUS_ENABLE_ETSY_RECEIPTS_POLL_CRON=1` and writes nothing without
  `NEXUS_ENABLE_ETSY_ORDER_INGEST=1`.

## Out of scope (documented only)

- Location resolution differs: the eBay writer uses the default warehouse, the others `IT-MAIN` (with the
  default as fallback). Unifying it is a separate change.
- Three "status only moves forward" rules remain (the O.7 terminal guard, Etsy's `mergeStatus`, Amazon's
  shipped-FBM rule) and three order-level locks (eBay, Amazon, Etsy); each is correct for its writer.
- A kept pool hold is released by the lender only; the borrower's stock page cannot show it. A borrower
  button that asks the lender is a possible follow-up (UI).
- `nexus_pool_order_taken` (the pool part of R1's cap) counts what an order took from shared stock and does
  not subtract put-backs: a take, then a put-back, then a second take of the same product for the same
  order would be under-counted. Door 4b takes once per order and product, so this is practically
  unreachable.
- The R6 sweep selects eBay orders with a JSON-path filter on `OrderItem.ebayMetadata` that has no index;
  eBay order volume is small today. An expression index is the fix if it grows.
- A cancelled Shopify fulfilment (`fulfillments/update`, not subscribed) is not read: its units stay
  taken, and the notice at a later cancellation reflects the fulfilments Nexus recorded.
- A `stock_blocked` line of an order whose eBay account was disconnected is retried only while the
  scheduled sync runs for that business.
- MCF consumes holds at the FBA location on completion (unchanged behaviour on main).
