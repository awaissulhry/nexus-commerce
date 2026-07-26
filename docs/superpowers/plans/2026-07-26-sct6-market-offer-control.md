# SCT.6 — Per-market Amazon offer control (Close / Reopen)

**Owner's requirements:** stop selling FBM in chosen EU markets (expensive IT→DE/FR/ES
shipping) WITHOUT touching reviews/ASIN/quantities elsewhere; one-click reopen (back to
Follow) when restocked; every scenario covered; bulk + tooltips + full wiring; no
inconsistencies. Research: 24-agent workflow `wf_ca6bb0c7-e97` (4 tracks, adversarially
verified).

## Mechanism (decided by research, Amazon-documented)

**Close = `PATCH listings/2021-08-01` `op:delete` on `/attributes/purchasable_offer`,
scoped to ONE marketplace** via `marketplaceIds` query param + `marketplace_id` selector
in the patch value. Amazon's own doc: *"Closing a listing item means making it
non-purchasable by customers. This can be achieved by removing the purchasable offer."*
The listing goes Inactive (no offer) in that marketplace only. SKU record, content
contribution, ASIN, **reviews** (ASIN-level), BSR, sibling markets' offers, and the
shared EU `fulfillment_availability` quantity are untouched.

**Reopen = re-add `purchasable_offer`** (op:replace) from the close-time snapshot —
`patchListingPrice` (amazon-sp-api.client.ts:696) already emits the exact shape. Reopen
verifies the SKU still exists (`getListingsItem`) and falls back to
`putListingsItem requirements=LISTING_OFFER_ONLY` if Amazon purged a long-dormant SKU.

**`deleteListingsItem` rejected**: permanent per-market SKU removal, re-creation
cooldown, full resubmit, unverified shared-quantity interaction. Stays only in the
existing hard-delete cascade.

## State model

Additive `ChannelListing` columns: `offerClosedAt`, `offerClosedBy`,
`offerCloseReason`, `offerCloseSnapshot` (verbatim live `purchasable_offer` +
`productType` + control state frozen at close). CLOSED is a **first-class mode**:
- `resolveIntendedQuantity`: new rule between FBA and policy-pause → `{kind:'CLOSED'}`
  (zero pushes for that market; siblings unaffected). NOT represented as PINNED@0
  (poisons the EU guard) or syncPaused (destroyed by ZERO_PIN/Excel) or ENDED (vanishes).
- EU quantity guard: closed rows express **no intent** (`intentOf` → null) and the
  SCT.5b consent-expansion **never expands into closed rows**.

## Resurrection-proofing (research: FOUR write stacks, no single choke point)

1. **Queue lane** (`dispatchSync→syncToAmazon`): skip closed (productId, marketplace) —
   terminal SKIPPED.
2. **Direct client calls** (repricer `patchListingPrice`, wizard `putListingsItem`,
   variation-sync, fba-restore, single publish): client-level belt in
   `amazon-sp-api.client` write entrypoints — refuse when the (sku, marketplaceId) is
   closed, unless called with `allowClosedMarket` (used only by close/reopen service).
3. **Feeds lane** (flat-file submit, cockpit publish, channel-batch JSON_LISTINGS_FEED):
   filter closed (sku, market) rows at payload assembly, reported per-row.
4. **Readback heal** (`amazon-qty-readback`): skip closed markets in compare + heal
   (their report rows are Inactive noise).
Excel import: any mode write against a closed row **skips with a warning** (reopen is a
deliberate action, never an import side effect). BIL note: Build International Listings
can recreate closed offers — surfaced in the runbook as an owner-side check.

## Sync Control surface

- Bulk actions **Close offer** / **Reopen offer** beside the others: chunked,
  partial-honest, audited, FBA fail-closed skip, scope-narrowed, real-time invalidation.
- Mode chip **Closed** + MODE_HELP; ACTION_HELP entries (what it writes / doesn't touch
  / how to undo) enforced by the help ratchet.
- Drift/read-back: closed rows never drift; export shows Closed.

## Pilot protocol (before any bulk)

`REGAL-JACKET-3XL-GREY-MEN` (zero sales): close DE → verify-live DE Inactive + IT
BUYABLE + qty intact → reopen DE → verify-live restored at same price. Only then the
prepared bulk lists (DE 141 / ES 80 / FR 66 FBM).
