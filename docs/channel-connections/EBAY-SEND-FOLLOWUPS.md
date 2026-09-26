# eBay send follow-ups — price lane rework (2026-09-26)

Branch `fix/cx-ebay-send-followups`, based on Package A `e565504c6` with the approved price
read-back lane merged (`5cfd8366e`). Reworked after the independent design review of
2026-09-26 (`2026-09-26-APPROACH-REVIEW.md`, "eBay price per market" and the B1/B2 and
variation-confirmation rows). **Deployed 2026-09-26** in release B+C (PR #32). No switch: the
market rule, FIXED_PRICE selection and report-only read-backs run now; price heal
(`NEXUS_ENABLE_PRICE_READBACK_HEAL`) stays OFF. Not production-verified. The sections below keep
their lane-time wording.

## What the lane does now

- **One market per queue row.** eBay offers a SKU on one marketplace (getOffers: "the same
  SKU value can not be offered across multiple eBay marketplaces"). As on Amazon, the row's
  listing decides its market; a row without a listing uses the market it names. No market, or
  a row market that disagrees with its listing, is refused (`EBAY_MARKET_UNRESOLVED`, on the
  row, nothing sent) — never defaulted to EBAY_IT. The
  split-market price branch (its own circuit, rate token and success log) is gone. The price
  step still prices only the FIXED_PRICE offer of that market, in that market's currency.
- **B1 read-back after the answer.** The offer is read back once (GET /offer/{id}, cents and
  currency, stale-read case) only after the queue row is written (`SyncResult.afterAnswer`,
  started by both backstop lanes and the BullMQ worker). Report-only; the finding lives in the
  CHANNEL_PRICE_READBACK record, not in the row message.
- **Every eBay offer lookup** takes the single FIXED_PRICE offer of the market
  (`ebayFixedPriceOfferOf`), never `offers[0]`: the quantity path, the variation and
  offers-only writers and their failure diagnostics, the flat-file routes (re-publish, single-SKU
  writer, end, delete), the legacy price writers and the status reconcile. A census test keeps
  eBay source free of `offers[0]`.
- **B2 Trading sweep.** A membership with no price is compared with the price it falls back to
  (the child's eBay listing price on that market; several accounts → the membership's own;
  still ambiguous → counted, never guessed). `followPool=false` variants are compared for
  price (followPool is a pool/quantity control); the quantity arm is unchanged. Cron line
  gains `fallback=N`.
- **Variation price confirmation.** One Trading GetItem per published listing (all variation
  StartPrices in one answer, the sweep's own parser), bounded, no retries. A listing is live
  unless eBay reports it Completed/Ended (out of stock is live). A price mismatch is re-read
  once after a short settle before it is recorded (agrees → confirmed; still different →
  recorded; re-read failed → unconfirmed). Nothing is read or recorded when an offer write or
  the publication failed. Report-only.
- **One StartPrice parser** (`parseStartPrice`) for the sweep, the SKU-less adoption and the
  axis rename; one bounded-read helper (`boundedRead`) for every price read-back.
- **Refuse, don't convert.** The master-price cascade does not send the master number to a
  listing whose market currency differs from the master currency (or is not configured); it
  is recorded (result, audit, MASTER_PRICE_CURRENCY_REFUSED). The pricing engine refuses a
  missing FX rate (`fx_rate_missing`) or a market with no Marketplace currency
  (`market_currency_unconfigured`) instead of pricing 1:1 or as EUR; the snapshot refresh drops
  that cell's old snapshot and the promotion scheduler skips it; `/pricing/explain` answers
  these refusals with 400 and the sentence.

## Not built (listed only)

- `getFxRate`'s other callers (ads, revenue, fulfilment) still read a missing rate as 1:1.

## Not proven here

- eBay does not state in so many words that GetItem's `Variation.SKU` equals the Inventory
  API SKU for a listing created through the Inventory API. A written SKU missing from the
  answer is UNREADABLE, never matched by position or specifics.
- No production or eBay call was made. Behaviour against live listings is unverified.

Evidence (red logs, mutation records with sha256 restore proof, real-PostgreSQL runs) is kept
locally, outside the repository.
