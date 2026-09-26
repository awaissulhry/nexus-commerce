# Etsy ingest activation — prepared, not executed

**Status (2026-09-26): deployed, not enabled.** The receipt ingest, its poll and its tables
(migrations `20260926p/q/r`) shipped in release B+C (PR #32, `93215463f`). Both Etsy switches are
OFF, no activation row (T0) exists, and no Etsy webhook has ever arrived, so nothing is ingested yet.
Current state of every switch: [COMPLETION-MATRIX](COMPLETION-MATRIX.md).

Stock rule for Etsy (Owner ruling 2026-09-26, replaces S1 "hold when paid"): a receipt holds its
stock as soon as it arrives, also while Etsy is still processing the payment; if the payment fails
Etsy cancels the receipt and the hold is given back; the stock is taken when the whole receipt has
shipped. A cancellation or refund after (part of) a shipment keeps the shipped units taken and
tells the owners. Details: [the stock model](2026-09-26-STOCK-MODEL.md).

The receipt writer uses **explicit per-account activation**, not the first webhook or poll, as
H1's boundary at Etsy's **whole-second precision**. New activation records use the beginning of
the database clock's current second; an older subsecond value is interpreted the same way without
rewriting its evidence. Etsy cannot distinguish receipts before/after activation within that
second, so the entire activation second is included. Earlier seconds are excluded. The account's
`EtsyReceiptIngest.activatedAt` is immutable across retries. A missing
row holds webhooks without spending an attempt and makes polling skip the account. Enabling a
switch alone never establishes T0. Keep both Etsy switches OFF until activation is approved.

The operator action below is prepared for review. It has not been run against a live database.
It requires a separate Owner approval, verified workspace and connection IDs, and confirmation
that the connection still names the intended Etsy shop/seller. No credentials are read by it.

1. Deploy the reviewed ingest code and additive migrations with both processing switches OFF.
   **Done 2026-09-26 (PR #32).** Before T0, the Owner registers the Etsy webhook and sets
   `ETSY_WEBHOOK_SIGNING_SECRET`; one signed event is then read back with ingest still off.
2. Obtain explicit approval to establish T0 for the selected account. Confirm its workspace,
   connection ID, shop ID and seller user ID using authorized metadata reads.
3. Run the following transaction with those verified values. An existing activation is retained;
   never delete or rewrite it to repair a delivery. Retain the returned timestamp as evidence.
4. Only after the transaction commits, obtain/execute the separately approved switch changes.
   Orders created between T0 and the first actual execution remain eligible. Retry held ledger
   entries through the normal processing path; receipts created before T0 stay excluded by H1.

```sql
BEGIN;
SET LOCAL TIME ZONE 'UTC';
-- Replace these four placeholders with verified values before execution.
SELECT set_config('nexus.workspace_id', '<workspace-id>', true);
DO $activation$
DECLARE
  account_id text := '<connection-id>';
  intended_shop text := '<shop-id>';
  intended_seller text := '<seller-user-id>';
  business_id text := current_setting('nexus.workspace_id');
BEGIN
  PERFORM 1 FROM "ChannelConnection"
   WHERE id = account_id AND "workspaceId" = business_id
     AND "channelType" = 'ETSY' AND "isActive"
     AND identity->'extra'->>'shopId' = intended_shop
     AND "externalAccountId" = intended_seller
   FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The selected active Etsy account does not match the approved identity'; END IF;
  INSERT INTO "EtsyReceiptIngest" (id, "workspaceId", "connectionId", "activatedAt", "updatedAt")
  VALUES (gen_random_uuid()::text, business_id, account_id, date_trunc('second', clock_timestamp()), clock_timestamp())
  ON CONFLICT ("workspaceId", "connectionId") DO NOTHING;
END $activation$;
SELECT "connectionId", "activatedAt" FROM "EtsyReceiptIngest"
 WHERE "workspaceId" = current_setting('nexus.workspace_id') AND "connectionId" = '<connection-id>';
COMMIT;
```

The SQL is intentionally account-scoped. It changes no flags, grants, credentials, stock, receipts
or historical orders. `activateEtsyIngest` remains an internal explicit-action/test helper;
processing entry points never call it.

## The switches: set them on the API, the worker and the scheduler together

`NEXUS_ENABLE_ETSY_ORDER_INGEST` is read by each process on its own: the API (the webhook receiver),
the worker (the inbound retry of a deferred or failed event) and the scheduler (the receipts poll).
Set it to `1` on all three in the same change, and turn it off on all three together.
`NEXUS_ENABLE_ETSY_RECEIPTS_POLL_CRON` is read by the scheduler only.

A mismatch is safe but stalls orders: a process with ingest off never finishes an activated
account's order event as a plain read-back. It holds the event (no attempt spent, retried after
30 minutes) and logs one warning naming the switch, so the event waits for a process with ingest on.
Events of an account that is not activated keep the old behaviour (read back and logged): their
receipts predate T0 and would be skipped anyway.

## Poll recovery contract

Etsy documents `sort_on=receipt_id`, `min_created` and `max_created`. Reconciliation uses those
parameters with a fixed upper bound at the last closed creation second and its lower bound at
T0. Updating a receipt changes neither its membership nor its position in this scan. The upper
bound, expected count and offset are stored separately from the diagnostic latest update/ID.
After a completed cycle, the next cycle starts at T0 again, so old receipts continue to be checked.
The obsolete updated-window checkpoint is retained for additive rollout and is not read.

One page of each run handles the newest updates from one configured poll interval plus 600
seconds of overlap; the remaining existing page budget advances reconciliation. A cap of one alternates the two paths. This keeps a new paid
receipt from waiting for the entire history cycle under the tested workload. The recent page is
a fast path, **not completeness evidence**: a burst exceeding its 100 receipts, tied timestamps,
long outages and late updates are also covered by recurring reconciliation. No cap was raised.

Checkpoints are lease-fenced. A failed receipt or refusal write keeps its reconciliation page.
If Etsy reports a changed count for a partially read window, the offset restarts at zero. A short
page/count mismatch or the supported offset limit leaves the window failed/backlogged, requiring
recovery; no completed-cycle freshness is recorded for a capped or failed scan. The current
single-window implementation can therefore become held when post-T0 history exceeds the
provider's offset ceiling; window partitioning is not implemented in this slice.

Source: [Etsy getShopReceipts reference](https://developer.etsy.com/documentation/reference#operation/getShopReceipts)
(accessed 2026-09-25). The API provides no documented snapshot cursor. Count changes are detected,
but same-count membership replacement during pagination is not a snapshot and may require the
next reconciliation cycle. Eventual coverage assumes a cycle can finish with stable membership
and sufficient vendor budget. No live vendor probe was made and no stronger guarantee is claimed.

## Release status

Deployed 2026-09-26 in release B+C (PR #32), after independent review of the ingest, the stock
model and the poller. The earlier open items are closed on `main`: a line stays mapped to its first
product after a SKU change, and the terminal settlement is the stock model's whole-receipt consume
(no per-line or pooled line-level consumption). Not enabled and not production-verified: activation
(T0), the switches and the first real `order.paid` each wait for the Owner's yes, in the order above.
The single-window offset limit described under "Poll recovery contract" still applies.
