/**
 * Amazon Business (B2B) step 3 — the ONE write of a listing's business price and quantity tiers
 * (`ChannelListing.businessPriceRule / businessPricePercent / businessPrice / businessTiers`; rules in
 * `@nexus/shared/business-price`; plan ~/nexus-archive/2026-10-12-amazon-business-b2b/STEP3-PLAN.md).
 *
 * Per listing, in one transaction:
 *   - Amazon only; never on a family parent (it has no offer of its own — `PARENT_PRICE_REASON`).
 *   - A setting needs the B2B audience Amazon lists for THIS listing's account, market and product type (the
 *     seller-scoped answer the nightly schema refresh keeps, `categories/seller-offer-audience.service.ts`). Clearing one
 *     (`setting: null`, Nexus stops managing the business offer) is always allowed.
 *   - Refused, nothing written, when Amazon would refuse or hide it (`businessPriceProblems`): checked against the
 *     listing's normal send price (`listingSendPrice`) and its Amazon minimum / maximum price.
 *   - Saved with `warnings` when Amazon's answer is not documented or the normal price has moved (`businessPriceWarnings`).
 *   - Compare-and-set on `ChannelListing.version` (or a named reason there is none), a `ChannelListingOverride` audit row,
 *     and `before` / `after` on the outcome, so a caller can put the old value back through this same door.
 *
 * Nothing is sent to Amazon here: the send path is step 4. Until it lands, no screen or Claude tool calls this.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import {
  businessPriceOf, businessPriceProblems, businessPriceWarnings, readBusinessTiers, type BusinessPriceSetting,
} from '@nexus/shared/business-price'
import { isOwnConnection, listActiveConnections } from '../connection-resolver.service.js'
import { offerAudienceKey, storedOfferAudiences } from '../categories/seller-offer-audience.service.js'
import { loadAmazonOfferFacts } from '../amazon/offer-facts.js'
import { masterCurrency } from '../fx-rate.service.js'
import { listingMarketCurrency, listingSendPrice } from './follower-price.js'
import { PARENT_PRICE_REASON } from './matrix-cells.js'
import { decimalToNumber } from './sheet-rows.service.js'
import type { MarketCurrencyRow } from './market-currency.js'

/** The reasons a business price write may run with no version guard — a closed set, as the price door's. */
export type BusinessPriceUnguardedReason =
  /** Step 3b: Amazon already holds a business offer Nexus does not manage; Nexus copies it in as an exact price. */
  | 'amazon-business-offer-adopt'

interface BusinessPriceWriteFields {
  listingId: string
  /** The setting to keep; `null` = Nexus stops managing a business offer on this listing. */
  setting: BusinessPriceSetting | null
}
export type BusinessPriceWriteTarget =
  | (BusinessPriceWriteFields & { expectedVersion: number; unguardedReason?: never })
  | (BusinessPriceWriteFields & { expectedVersion?: never; unguardedReason: BusinessPriceUnguardedReason })

export interface BusinessPriceWriteOutcome {
  listingId: string
  productId: string | null
  marketplace: string | null
  outcome: 'applied' | 'refused' | 'noop' | 'conflict'
  reason?: string
  version: number
  guarded: boolean
  before: BusinessPriceSetting | null
  after: BusinessPriceSetting | null
  /** The business price the setting gives now (a percent of the normal send price, or the exact price); null when unknown. */
  businessPrice: number | null
  warnings: string[]
}
export interface BusinessPriceWriteResult { results: BusinessPriceWriteOutcome[]; applied: number; refused: number; noop: number; conflict: number }

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, version: true,
  price: true, priceOverride: true, followMasterPrice: true, pricingRule: true, priceAdjustmentPercent: true,
  businessPriceRule: true, businessPricePercent: true, businessPrice: true, businessTiers: true,
  product: { select: { basePrice: true, isParent: true, productType: true, parent: { select: { productType: true } } } },
} satisfies Prisma.ChannelListingSelect

/** The setting a stored row holds, or `null` when Nexus manages no business offer there. */
export function storedBusinessSetting(row: { businessPriceRule: string | null; businessPricePercent: unknown; businessPrice: unknown; businessTiers: unknown }): BusinessPriceSetting | null {
  if (row.businessPriceRule !== 'PERCENT_OFF' && row.businessPriceRule !== 'FIXED') return null
  return { rule: row.businessPriceRule, percent: decimalToNumber(row.businessPricePercent), price: decimalToNumber(row.businessPrice), tiers: readBusinessTiers(row.businessTiers) }
}

/** One shape per meaning: a percent rule carries no price, an exact price no percent. */
function normalised(s: BusinessPriceSetting | null): BusinessPriceSetting | null {
  if (!s) return null
  return s.rule === 'PERCENT_OFF'
    ? { rule: 'PERCENT_OFF', percent: s.percent, price: null, tiers: s.tiers ?? null }
    : { rule: 'FIXED', percent: null, price: s.price, tiers: s.tiers ?? null }
}
const same = (a: BusinessPriceSetting | null, b: BusinessPriceSetting | null) => JSON.stringify(a) === JSON.stringify(b)

/** The audit line: `−5 % · 3 tiers (percent)`, `99.00 · no tiers`, or `—`. */
function describe(s: BusinessPriceSetting | null): string | null {
  if (!s) return null
  const base = s.rule === 'PERCENT_OFF' ? `−${s.percent} %` : (s.price ?? 0).toFixed(2)
  const tiers = s.tiers ? `${s.tiers.levels.length} tiers (${s.tiers.type}: ${s.tiers.levels.map((l) => `${l.minQty}+ ${l.value}`).join(', ')})` : 'no tiers'
  return `${base} · ${tiers}`
}

export async function writeBusinessPrices(input: {
  targets: BusinessPriceWriteTarget[]
  actor: string
  /** The audit sentence prefix; the service appends nothing else. */
  reason?: string
  /** Run inside the caller's open transaction instead of one transaction per listing. */
  tx?: Prisma.TransactionClient
}): Promise<BusinessPriceWriteResult> {
  const result: BusinessPriceWriteResult = { results: [], applied: 0, refused: 0, noop: 0, conflict: 0 }
  if (input.targets.length === 0) return result
  const db = (input.tx ?? prisma) as typeof prisma
  const inTransaction = <T,>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => input.tx ? work(input.tx) : prisma.$transaction(work)
  const ids = [...new Set(input.targets.map((t) => t.listingId))]
  const [listings, facts, currencyRows, connections] = await Promise.all([
    db.channelListing.findMany({ where: { id: { in: ids } }, select: LISTING_SELECT }),
    loadAmazonOfferFacts(db, ids, 'job'),
    db.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { channel: true, code: true, currency: true } }) as Promise<MarketCurrencyRow[]>,
    listActiveConnections('AMAZON', db),
  ])
  const byId = new Map(listings.map((l) => [l.id, l]))
  const ownPrimary = connections.filter(isOwnConnection)[0]?.id ?? null
  const accountOf = (l: { channelConnectionId: string | null }) => l.channelConnectionId ?? ownPrimary
  const productTypeOf = (l: typeof listings[number]) => l.product?.parent?.productType ?? l.product?.productType ?? null
  // The kept audiences, one read per product type.
  const audiences = new Map<string, Map<string, string[]>>()
  for (const pt of new Set(listings.map(productTypeOf).filter((v): v is string => !!v))) {
    const accounts = [...new Set(listings.filter((l) => productTypeOf(l) === pt).map(accountOf).filter((v): v is string => !!v))]
    audiences.set(pt, await storedOfferAudiences(pt, accounts))
  }

  targets: for (const t of input.targets) {
    const l = byId.get(t.listingId)
    const guarded = t.expectedVersion !== undefined
    const after = normalised(t.setting)
    const base = { listingId: t.listingId, productId: l?.productId ?? null, marketplace: l?.marketplace ?? null, guarded, after, warnings: [] as string[] }
    const refuse = (reason: string, before: BusinessPriceSetting | null = null) => {
      result.results.push({ ...base, outcome: 'refused', reason, version: l?.version ?? 0, before, businessPrice: null })
      result.refused++
    }
    if (!l) { refuse('This listing no longer exists.'); continue }
    const before = storedBusinessSetting(l)
    if (l.channel !== 'AMAZON') { refuse('Only an Amazon listing has a business price.', before); continue }
    if (l.product?.isParent) { refuse(PARENT_PRICE_REASON, before); continue }

    const currency = listingMarketCurrency(l, currencyRows)
    const normal = listingSendPrice(l, { masterPrice: l.product?.basePrice, marketCurrency: currency, masterCurrency: masterCurrency(), where: `Amazon ${l.marketplace}` }).price
    const offer = facts.get(l.id)?.values
    let businessPrice: number | null = null
    let warnings: string[] = []
    // Copying in what Amazon already holds: never over a setting Nexus manages (the write below is conditional on it too).
    if (t.unguardedReason === 'amazon-business-offer-adopt' && before !== null) {
      result.results.push({ ...base, outcome: 'noop', reason: 'Nexus already manages this business price.', version: l.version, before, businessPrice: null, warnings: [] })
      result.noop++
      continue targets
    }
    if (after && !t.unguardedReason) {
      const pt = productTypeOf(l)
      const account = accountOf(l)
      const allowed = pt && account ? audiences.get(pt)?.get(offerAudienceKey(account, l.marketplace)) ?? null : null
      if (!pt || allowed === null) { refuse(MATRIX_COPY.absentBusinessUnchecked(), before); continue }
      if (!allowed.includes('B2B')) { refuse(MATRIX_COPY.absentBusiness(pt), before); continue }
      const problems = businessPriceProblems({ setting: after, normalPrice: normal, minPrice: offer?.minimum_seller_allowed_price ?? null, maxPrice: offer?.maximum_seller_allowed_price ?? null, currency })
      if (problems.length) { refuse(problems.join(' '), before); continue }
    }
    // Copying in what Amazon already holds records it as it is (Amazon took it, so B2B is on there); only a person's
    // change is held to the audience check and Amazon's rules. Both get the warnings.
    if (after) {
      businessPrice = businessPriceOf(after, normal)
      warnings = businessPriceWarnings({ setting: after, normalPrice: normal, salePrice: offer?.sale?.price ?? null, currency })
    }
    if (same(before, after)) {
      result.results.push({ ...base, outcome: 'noop', version: l.version, before, businessPrice, warnings })
      result.noop++
      continue targets
    }

    const written = await inTransaction(async (tx) => {
      const where = guarded ? { id: l.id, version: t.expectedVersion } : t.unguardedReason === 'amazon-business-offer-adopt' ? { id: l.id, businessPriceRule: null } : { id: l.id }
      const update = await tx.channelListing.updateMany({
        where,
        data: {
          businessPriceRule: after?.rule ?? null,
          businessPricePercent: after?.percent ?? null,
          businessPrice: after?.price ?? null,
          businessTiers: after?.tiers ? (after.tiers as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          version: { increment: 1 },
        },
      })
      if (update.count === 0) return null
      await tx.channelListingOverride.create({ data: {
        channelListingId: l.id, fieldName: 'businessPrice', previousValue: describe(before), newValue: describe(after),
        reason: input.reason ?? t.unguardedReason ?? 'business price', changedBy: input.actor,
      } })
      return (await tx.channelListing.findUnique({ where: { id: l.id }, select: { version: true } }))?.version ?? l.version + 1
    })
    if (written === null) {
      result.results.push({ ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: l.version, before, businessPrice, warnings })
      result.conflict++
      continue
    }
    result.results.push({ ...base, outcome: 'applied', version: written, before, businessPrice, warnings })
    result.applied++
  }
  return result
}
