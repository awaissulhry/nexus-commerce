/**
 * AM-21 — the eBay weekly digest's money, one total per currency.
 *
 * eBay reports each market in its own currency (EBAY_GB in GBP, the other markets in EUR) and every performance row
 * says which. The digest used to add the minor units of every row together and print the sum with "€" — so a week with
 * UK ads added pence to cents. Counts (clicks, impressions, sold) still add across markets; money never does. When the
 * week holds more than one currency the single totals carry no money (null) and `byCurrency` holds one total per
 * currency. Nothing is converted: no exchange rate is applied.
 *
 * Pure: the generator (`generateWeeklyDigest`) reads the rows and hands them here.
 */

export interface CurrencySums {
  currency: string
  adFeesCents: number
  salesCents: number
  clicks: number
  impressions: number
  soldQty: number
}

export interface CampaignCurrencySums {
  /** The external campaign id the performance rows carry. */
  entityId: string
  currency: string
  adFeesCents: number
  salesCents: number
  soldQty: number
}

const ZERO: Omit<CurrencySums, 'currency'> = { adFeesCents: 0, salesCents: 0, clicks: 0, impressions: 0, soldQty: 0 }

/** ACOS as a percentage with one decimal, as the digest has always stored it; null without sales. */
const acosPct = (feesCents: number, salesCents: number): number | null =>
  salesCents > 0 ? Math.round((feesCents / salesCents) * 1000) / 10 : null

function total(rows: CurrencySums[]): Omit<CurrencySums, 'currency'> {
  return rows.reduce((a, r) => ({
    adFeesCents: a.adFeesCents + r.adFeesCents,
    salesCents: a.salesCents + r.salesCents,
    clicks: a.clicks + r.clicks,
    impressions: a.impressions + r.impressions,
    soldQty: a.soldQty + r.soldQty,
  }), ZERO)
}

/** Money in its own currency, for the notification line ("€12.00", "£3.50"). */
export function formatMoney(cents: number, currency: string): string {
  try {
    return (cents / 100).toLocaleString('en-IE', { style: 'currency', currency })
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`
  }
}

export function weeklyDigestMoney(input: {
  current: CurrencySums[]
  prior: CurrencySums[]
  campaigns: CampaignCurrencySums[]
  nameOf: (entityId: string) => string | undefined
  marketOf: (entityId: string) => string | undefined
}) {
  const currencies = [...new Set([...input.current, ...input.prior].map((r) => r.currency))].sort()
  const mixed = currencies.length > 1
  const cur = total(input.current)
  const prev = total(input.prior)
  const ofCurrency = (rows: CurrencySums[], currency: string) => total(rows.filter((r) => r.currency === currency))

  const byCurrency = currencies
    .map((currency) => {
      const c = ofCurrency(input.current, currency)
      const p = ofCurrency(input.prior, currency)
      return {
        currency,
        adFeesCents: c.adFeesCents,
        salesCents: c.salesCents,
        soldQty: c.soldQty,
        acosPct: acosPct(c.adFeesCents, c.salesCents),
        prior: { adFeesCents: p.adFeesCents, salesCents: p.salesCents, soldQty: p.soldQty },
      }
    })
    .sort((a, b) => b.adFeesCents - a.adFeesCents || a.currency.localeCompare(b.currency))

  // ER4 E2 — per-marketplace split (campaign-grain rows rolled up by the campaign's marketplace; campaigns deleted
  // since the week keep their fees under "unknown" rather than being silently dropped). Keyed by market AND currency,
  // so even an "unknown" bucket never adds two currencies.
  const markets = new Map<string, { marketplace: string; currency: string; adFeesCents: number; salesCents: number; soldQty: number }>()
  for (const c of input.campaigns) {
    const marketplace = input.marketOf(c.entityId) ?? 'unknown'
    const key = `${marketplace}|${c.currency}`
    const agg = markets.get(key) ?? { marketplace, currency: c.currency, adFeesCents: 0, salesCents: 0, soldQty: 0 }
    agg.adFeesCents += c.adFeesCents
    agg.salesCents += c.salesCents
    agg.soldQty += c.soldQty
    markets.set(key, agg)
  }

  return {
    /** The one currency of the week's money; null when it holds more than one (read `byCurrency`). */
    currency: currencies.length === 1 ? currencies[0] : currencies.length === 0 ? 'EUR' : null,
    totals: {
      adFeesCents: mixed ? null : cur.adFeesCents,
      salesCents: mixed ? null : cur.salesCents,
      clicks: cur.clicks,
      impressions: cur.impressions,
      soldQty: cur.soldQty,
      acosPct: mixed ? null : acosPct(cur.adFeesCents, cur.salesCents),
    },
    prior: { adFeesCents: mixed ? null : prev.adFeesCents, salesCents: mixed ? null : prev.salesCents, soldQty: prev.soldQty },
    byCurrency,
    byMarketplace: [...markets.values()]
      .map((m) => ({ ...m, acosPct: acosPct(m.adFeesCents, m.salesCents) }))
      .sort((a, b) => b.adFeesCents - a.adFeesCents),
    movers: input.campaigns
      .map((c) => ({ campaign: input.nameOf(c.entityId) ?? c.entityId, currency: c.currency, feesCents: c.adFeesCents, salesCents: c.salesCents, sold: c.soldQty }))
      .sort((a, b) => b.feesCents - a.feesCents),
    /** The notification's money line: one "fees · sales" pair per currency, never one sum. */
    moneyLine: byCurrency.length === 0
      ? `${formatMoney(0, 'EUR')} fees · ${formatMoney(0, 'EUR')} sales`
      : byCurrency.map((c) => `${formatMoney(c.adFeesCents, c.currency)} fees · ${formatMoney(c.salesCents, c.currency)} sales`).join('; '),
  }
}
