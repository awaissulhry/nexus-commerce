/**
 * CX (review 2026-09-26) — confirm the prices an Inventory-API variation push wrote, REPORT-ONLY.
 *
 * ONE Trading `GetItem` per published listing: eBay returns every variation's StartPrice in that one answer (Trading
 * VariationType: "StartPrice is required (and always returned) for listings with variations"), and eBay documents
 * GetItem as the way to view a listing created through the Inventory API's offer calls. The answer goes through the
 * Trading sweep's own parser (`parseGetItemQuantities` → `parseStartPrice`), and each written SKU is compared with
 * ITS variation's price — to the cent and in its currency — never with another variation's or the item level's.
 *
 * What replaced it read `GET /offer/{id}` once per SKU under one shared eight-second budget (a large family ran out
 * and reported "unconfirmed" for the tail), required the offer's listing status to be ACTIVE (a quantity-0 deactivate
 * shows OUT_OF_STOCK — eBay's ListingStatusEnum: still live — and read as "unconfirmed"), and recorded findings when
 * the publication itself had failed. Here: a Trading listing is live unless eBay reports it Completed/Ended (an
 * out-of-stock listing is Active), and a failed publication is never read (the caller does not call this).
 *
 * A PRICE mismatch read right after the write is not recorded on that one read: eBay may not show the write yet.
 * The listing is read ONCE more after a short settle (same bound, no retries); a re-read that agrees confirms, one
 * that still differs is recorded, and a re-read that fails leaves it "unconfirmed" — never a mismatch on one read.
 *
 * 🔴 Nothing is corrected, re-sent or queued. A finding is a CHANNEL_PRICE_READBACK record, like B1 and B2.
 * Gap (docs): eBay does not state in so many words that GetItem's Variation.SKU is the Inventory API SKU for a
 * listing created through the Inventory API. A written SKU missing from the answer is UNREADABLE — never matched
 * by position or by specifics.
 */
import { getItemQuantities, type ItemQuantityReadback } from './ebay-trading-api.service.js'
import { boundedRead, ebayPriceUnconfirmedMessage, priceReadbackTimeoutMs, priceReadbackVerdict, recordEbayPriceUnconfirmed, type EbayOfferPriceReadback } from './ebay-price-readback.service.js'

export interface WrittenVariationPrice {
  sku: string
  price: number
  currency: string
  productId: string | null
}

const ENDED = new Set(['Completed', 'Ended'])
/** The settle before the one re-read: 2 s, or NEXUS_EBAY_PRICE_REREAD_DELAY_MS (0–5 s). */
const rereadDelayMs = (): number => Math.min(5_000, Math.max(0, Number(process.env.NEXUS_EBAY_PRICE_REREAD_DELAY_MS ?? 2_000) || 0))
type Verdict = Exclude<EbayOfferPriceReadback, { outcome: 'READ_FAILED' }> | Extract<EbayOfferPriceReadback, { outcome: 'READ_FAILED' }>

/**
 * Returns a sentence per written SKU for the push's row results (none at all when there was no Trading answer —
 * the dry-run's empty body outside production). Never throws.
 */
export async function confirmVariationPrices(args: {
  connectionId: string
  oauthToken: string
  /** 'IT', 'UK', … — the Trading site. */
  market: string
  /** 'EBAY_IT', … — the record's marketplace. */
  marketplaceId: string
  /** The published listing (ItemID); null → nothing to read. */
  itemId: string | null
  writes: readonly WrittenVariationPrice[]
}): Promise<Map<string, string>> {
  const messages = new Map<string, string>()
  if (args.writes.length === 0) return messages
  const sent = (w: WrittenVariationPrice) => `${w.currency} ${w.price.toFixed(2)}`
  if (!args.itemId) {
    for (const w of args.writes) messages.set(w.sku, `Price not checked: no published eBay listing is known for ${w.sku}.`)
    return messages
  }
  const itemId = args.itemId
  const ms = priceReadbackTimeoutMs()
  const read = () => boundedRead(ms, (signal) => getItemQuantities(itemId, {
    oauthToken: args.oauthToken, market: args.market, connectionId: args.connectionId,
    signal, timeoutMs: ms, maxTransientRetries: 0, max429Retries: 0,
  }))
  let answer: ItemQuantityReadback
  try {
    answer = await read()
  } catch (err) {
    // One read failed for the whole listing: one record for it, a sentence on every row.
    const reason = err instanceof Error ? err.message : String(err)
    const readback = { outcome: 'READ_FAILED' as const, reason }
    for (const w of args.writes) messages.set(w.sku, ebayPriceUnconfirmedMessage({ sku: w.sku, marketplaceId: args.marketplaceId, itemId, expected: { price: w.price, currency: w.currency }, readback }))
    await recordEbayPriceUnconfirmed({
      productId: null, source: 'VARIATION_GETITEM', marketplace: args.marketplaceId, ref: `item:${itemId}`, outcome: 'READ_FAILED',
      sku: args.writes.map((w) => w.sku).join(',').slice(0, 200),
      message: `Price unconfirmed after the eBay variation price write (${args.marketplaceId}, item ${itemId}): the listing could not be read back (${reason}). Not re-sent.`,
      localData: { sent: args.writes.map((w) => ({ sku: w.sku, price: w.price, currency: w.currency })) },
      remoteData: { itemId, reason, accountId: args.connectionId },
    })
    return messages
  }
  const prices = answer.prices
  if (!prices) return messages // no <Item>: nothing was read (dry-run outside production)
  if (answer.listingStatus && ENDED.has(answer.listingStatus)) {
    for (const w of args.writes) messages.set(w.sku, `Price not checked: eBay reports listing ${itemId} ${answer.listingStatus}.`)
    return messages
  }
  // A variation listing: this SKU's own block only. A single-SKU listing (one write): the item's price.
  const verdictOf = (a: ItemQuantityReadback, w: WrittenVariationPrice): Verdict => {
    const p = a.prices!
    const seen = p.hasVariations ? p.variations.find((v) => v.sku === w.sku) : (args.writes.length === 1 ? p.item : null)
    return seen
      ? priceReadbackVerdict({ price: w.price, currency: w.currency }, { price: seen.value, currency: seen.currency })
      : { outcome: 'UNREADABLE', reason: `eBay's answer carries no price for ${w.sku}` }
  }
  const verdicts = new Map(args.writes.map((w) => [w.sku, verdictOf(answer, w)]))
  // A PRICE mismatch read right after the write may be eBay's lag: ONE re-read of the listing decides it.
  const differing = args.writes.filter((w) => verdicts.get(w.sku)!.outcome === 'PRICE_MISMATCH')
  if (differing.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, rereadDelayMs()))
    let second: ItemQuantityReadback | null = null
    let failure = ''
    try { second = await read() } catch (err) { failure = err instanceof Error ? err.message : String(err) }
    const live = !!second?.prices && !(second.listingStatus && ENDED.has(second.listingStatus))
    for (const w of differing) {
      const first = verdicts.get(w.sku) as Extract<Verdict, { outcome: 'PRICE_MISMATCH' }>
      verdicts.set(w.sku, live ? verdictOf(second!, w) : {
        outcome: 'READ_FAILED',
        reason: `the first read showed ${first.channelCurrency} ${first.channelPrice.toFixed(2)} right after the write; the re-read ${failure ? `failed (${failure})` : 'found no live listing'}`,
      })
    }
  }
  for (const w of args.writes) {
    const expected = { price: w.price, currency: w.currency }
    const readback = verdicts.get(w.sku)!
    if (readback.outcome === 'CONFIRMED') {
      messages.set(w.sku, `Price confirmed on eBay: ${sent(w)}.`)
      continue
    }
    const message = ebayPriceUnconfirmedMessage({ sku: w.sku, marketplaceId: args.marketplaceId, itemId, expected, readback })
    messages.set(w.sku, message)
    await recordEbayPriceUnconfirmed({
      productId: w.productId, source: 'VARIATION_GETITEM', marketplace: args.marketplaceId, ref: `item:${itemId}/${w.sku}`,
      outcome: readback.outcome, sku: w.sku, message,
      localData: { sentPrice: w.price, currency: w.currency },
      remoteData: {
        itemId, sku: w.sku, accountId: args.connectionId,
        ...('channelPrice' in readback ? { ebayPrice: readback.channelPrice, ebayCurrency: readback.channelCurrency } : { reason: readback.reason }),
      },
    })
  }
  return messages
}
