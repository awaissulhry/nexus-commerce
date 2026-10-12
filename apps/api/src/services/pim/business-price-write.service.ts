/**
 * Amazon Business (B2B) step 3 — the ONE write of a listing's business price and quantity tiers
 * (`ChannelListing.businessPriceRule / businessPricePercent / businessPrice / businessTiers`; rules in
 * `@nexus/shared/business-price`; plan ~/nexus-archive/2026-10-12-amazon-business-b2b/STEP3-PLAN.md).
 *
 * Per listing, in one transaction:
 *   - Amazon only; never on a family parent (it has no offer of its own — `PARENT_PRICE_REASON`).
 *   - A setting needs the B2B audience Amazon lists for THIS listing's account, market and product type (the
 *     seller-scoped answer the nightly schema refresh keeps, `categories/seller-offer-audience.service.ts`; the product
 *     type is the listing's Amazon type, else its product's, else its family's, as the refresh names them). Removing one
 *     (`setting: null`) is always allowed, and it means removed on Amazon too.
 *   - Refused, nothing written, when Amazon would refuse or hide it (`businessPriceProblems`): checked against the
 *     listing's normal price as the push sends it (the job-lane offer facts) and its minimum / maximum price.
 *   - Saved with `warnings` when Amazon's answer is not documented or the normal price has moved (`businessPriceWarnings`).
 *   - Compare-and-set on `ChannelListing.version` (or a named reason there is none), a `ChannelListingOverride` audit row,
 *     and `before` / `after` on the outcome, so a caller can put the old value back through this same door.
 *
 * Step 4 — a person's applied change queues ONE `BUSINESS_PRICE_UPDATE` row (after the same 30 s hold as a price change,
 * replacing a business row still waiting), and the Amazon push sends the business offer from the listing's columns at
 * send time (`syncToAmazon`, `amazon/business-offer.ts`). A listing that cannot be sent to now (paused, a still-draft,
 * Inactive, ended) keeps it in Nexus (`notSent`); `queueHeldBusinessSends` sends it when the listing resumes, is
 * published or reopens. Copying in what Amazon holds sends nothing: Amazon already has it.
 */
import { Prisma } from '@prisma/client'
import { createOutboundRow } from '../outbound-rows.js'
import { fireOutboundJobs } from '../outbound-enqueue.js'
import { afterDatabaseCommit } from '../../lib/database-context.js'
import prisma from '../../db.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { assertPushAllowed } from '@nexus/shared/push-lock'
import {
  businessPriceOf, businessPriceProblems, businessPriceWarnings, type BusinessPriceSetting,
} from '@nexus/shared/business-price'
import { isOwnConnection, listActiveConnections } from '../connection-resolver.service.js'
import { offerAudienceKey, storedOfferAudiences } from '../categories/seller-offer-audience.service.js'
import { normaliseCategory } from '../categories/schema-coverage.service.js'
import { loadAmazonOfferFacts } from '../amazon/offer-facts.js'
import { BUSINESS_PRICE_SYNC_TYPE, storedBusinessSetting } from '../amazon/business-offer.js'
import { FOLLOWER_PRICE_HOLD_MS, holdsCascadedPrice, listingMarketCurrency } from './follower-price.js'
import { PARENT_PRICE_REASON } from './matrix-cells.js'
import type { MarketCurrencyRow } from './market-currency.js'

/** The reasons a business price write may run with no version guard — a closed set, as the price door's. */
export type BusinessPriceUnguardedReason =
  /** Step 3b: Amazon already holds a business offer Nexus does not manage; Nexus copies it in as an exact price. */
  | 'amazon-business-offer-adopt'

interface BusinessPriceWriteFields {
  listingId: string
  /** The setting to keep; `null` = no business offer here (removed on Amazon too). */
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
  /** The BUSINESS_PRICE_UPDATE row queued for Amazon, when one was. */
  queueId?: string | null
  /** The change was saved, and why nothing was sent yet (a paused, draft, Inactive or ended listing). */
  notSent?: string
}

/** Can this listing be sent to now? `null` = yes; otherwise the sentence for a change kept in Nexus until it can. */
function businessHeld(l: { syncPaused: boolean; listingStatus: string | null; isPublished: boolean; externalListingId: string | null; offerClosedAt: Date | null }): string | null {
  if (l.syncPaused) return 'The business price is saved in Nexus. Nothing was sent yet: this listing\'s sync is paused. It is sent when the listing resumes.'
  if (holdsCascadedPrice(l)) return 'The business price is saved in Nexus. Nothing was sent yet: this listing is a draft that has not been published. It is sent when the listing is published.'
  if (l.offerClosedAt) return 'The business price is saved in Nexus. Nothing was sent yet: this listing is Inactive here. It is sent when the listing is set Active again.'
  const lock = assertPushAllowed(l)
  return lock ? `The business price is saved in Nexus. Nothing was sent: ${lock.sentence}` : null
}
export interface BusinessPriceWriteResult { results: BusinessPriceWriteOutcome[]; applied: number; refused: number; noop: number; conflict: number }

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, region: true, channelConnectionId: true, version: true,
  externalListingId: true, syncPaused: true, listingStatus: true, isPublished: true, offerClosedAt: true, platformAttributes: true,
  price: true, priceOverride: true, followMasterPrice: true, pricingRule: true, priceAdjustmentPercent: true,
  businessPriceRule: true, businessPricePercent: true, businessPrice: true, businessTiers: true,
  product: { select: { isParent: true, productType: true, parent: { select: { productType: true } } } },
} satisfies Prisma.ChannelListingSelect

/** One shape per meaning: a percent rule carries no price, an exact price no percent, tiers only their own keys. */
function normalised(s: BusinessPriceSetting | null): BusinessPriceSetting | null {
  if (!s) return null
  const tiers = s.tiers ? { type: s.tiers.type, levels: (s.tiers.levels ?? []).map((l) => ({ minQty: l.minQty, value: l.value })) } : null
  return s.rule === 'PERCENT_OFF'
    ? { rule: 'PERCENT_OFF', percent: s.percent ?? null, price: null, tiers }
    : { rule: 'FIXED', percent: null, price: s.price ?? null, tiers }
}

/**
 * The product types a listing's B2B answer may be kept under, in the names the nightly refresh uses (upper case,
 * recognised): the listing's Amazon type, then its product's, then its family's. The first one Amazon answered for wins.
 */
export function businessTypeCandidates(l: { platformAttributes?: unknown; product?: { productType?: string | null; parent?: { productType?: string | null } | null } | null }): string[] {
  const own = l.platformAttributes && typeof l.platformAttributes === 'object' ? (l.platformAttributes as { productType?: unknown }).productType : null
  const out = [own, l.product?.productType, l.product?.parent?.productType].map((v) => normaliseCategory('AMAZON', v)).filter((v): v is string => !!v)
  return [...new Set(out)]
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
  const queued: Array<{ id: string; productId: string | null; syncType: string; holdUntil: Date | null }> = []
  const ownPrimary = connections.filter(isOwnConnection)[0]?.id ?? null
  const accountOf = (l: { channelConnectionId: string | null }) => l.channelConnectionId ?? ownPrimary
  // The kept audiences, one read per product type.
  const audiences = new Map<string, Map<string, string[]>>()
  for (const pt of new Set(listings.flatMap(businessTypeCandidates))) {
    const accounts = [...new Set(listings.filter((l) => businessTypeCandidates(l).includes(pt)).map(accountOf).filter((v): v is string => !!v))]
    audiences.set(pt, await storedOfferAudiences(pt, accounts))
  }
  /** The first product type Amazon answered for, with its audiences; `null` = never measured. */
  const audienceOf = (l: typeof listings[number]): { productType: string; audience: string[] } | null => {
    const account = accountOf(l)
    if (!account) return null
    for (const pt of businessTypeCandidates(l)) {
      const audience = audiences.get(pt)?.get(offerAudienceKey(account, l.marketplace))
      if (audience) return { productType: pt, audience }
    }
    return null
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
    const offer = facts.get(l.id)?.values
    // The normal price as the push sends it (job-lane facts): the same number the Amazon send checks against.
    const normal = offer?.our_price.price ?? null
    let businessPrice: number | null = null
    let warnings: string[] = []
    // Copying in what Amazon already holds: never over a setting Nexus manages (the write below is conditional on it too).
    if (t.unguardedReason === 'amazon-business-offer-adopt' && before !== null) {
      result.results.push({ ...base, outcome: 'noop', reason: 'Nexus already manages this business price.', version: l.version, before, businessPrice: null, warnings: [] })
      result.noop++
      continue targets
    }
    if (after && !t.unguardedReason) {
      if (!businessTypeCandidates(l).length) { refuse(MATRIX_COPY.absentBusinessNoType(), before); continue }
      const measured = audienceOf(l)
      if (!measured) { refuse(MATRIX_COPY.absentBusinessUnchecked(), before); continue }
      if (!measured.audience.includes('B2B')) { refuse(MATRIX_COPY.absentBusiness(measured.productType), before); continue }
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
      // A person's change goes to Amazon; a copy of what Amazon holds does not.
      let queueId: string | null = null
      let notSent: string | undefined
      if (!t.unguardedReason) {
        const held = businessHeld(l)
        if (held) notSent = held
        else {
          const row = await queueBusinessRow(tx, l, { actor: input.actor, source: 'BUSINESS_PRICE_WRITE', holdMs: FOLLOWER_PRICE_HOLD_MS })
          queueId = row.id
          queued.push(row)
        }
      }
      const version = (await tx.channelListing.findUnique({ where: { id: l.id }, select: { version: true } }))?.version ?? l.version + 1
      return { version, queueId, notSent }
    })
    if (written === null) {
      result.results.push({ ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: l.version, before, businessPrice, warnings })
      result.conflict++
      continue
    }
    result.results.push({ ...base, outcome: 'applied', version: written.version, before, businessPrice, warnings, queueId: written.queueId, ...(written.notSent ? { notSent: written.notSent } : {}) })
    result.applied++
  }
  // Post-commit: the instant lane honours each row's own holdUntil; the drain cron is the fallback.
  if (queued.length) await afterDatabaseCommit(`business-prices:${queued.map((row) => row.id).join(',')}`,
    () => fireOutboundJobs(queued, { source: 'BUSINESS_PRICE_WRITE' }))
  return result
}

type QueuedRow = { id: string; productId: string | null; syncType: string; holdUntil: Date | null }

/** ONE waiting business row per listing: a newer one replaces the one still waiting. */
async function queueBusinessRow(
  tx: Prisma.TransactionClient,
  l: { id: string; productId: string | null; region: string | null; externalListingId: string | null },
  opts: { actor: string; source: string; holdMs: number },
): Promise<QueuedRow> {
  await tx.outboundSyncQueue.updateMany({
    where: { channelListingId: l.id, syncType: BUSINESS_PRICE_SYNC_TYPE, syncStatus: 'PENDING' },
    data: { syncStatus: 'CANCELLED', errorMessage: 'Replaced by a newer business price send for this listing' },
  })
  return createOutboundRow(tx, {
    data: {
      productId: l.productId, channelListingId: l.id, targetChannel: 'AMAZON' as never, targetRegion: l.region,
      syncStatus: 'PENDING' as never, syncType: BUSINESS_PRICE_SYNC_TYPE, holdUntil: new Date(Date.now() + opts.holdMs),
      externalListingId: l.externalListingId, maxRetries: 3,
      payload: { syncBusiness: true, source: opts.source, actor: opts.actor } as Prisma.InputJsonValue,
    },
    select: { id: true, productId: true, syncType: true, holdUntil: true },
  })
}

/**
 * Queue ONE business send for each listing that can be sent to now — the Amazon push compares what Nexus keeps with what
 * Amazon holds and sends only a difference (nothing when equal). Used after a percent-off follow that could not finish
 * (`syncToAmazon`) and by `queueHeldBusinessSends`. Listings that cannot be sent to now are skipped.
 */
export async function queueBusinessSends(input: { listingIds: string[]; actor: string; source: string; holdMs?: number }): Promise<string[]> {
  if (!input.listingIds.length) return []
  const listings = await prisma.channelListing.findMany({
    where: { id: { in: [...new Set(input.listingIds)] }, channel: 'AMAZON' },
    select: { id: true, productId: true, region: true, externalListingId: true, syncPaused: true, listingStatus: true, isPublished: true, offerClosedAt: true, product: { select: { isParent: true } } },
  })
  const queued: QueuedRow[] = []
  for (const l of listings) {
    if (l.product?.isParent || businessHeld(l)) continue
    queued.push(await prisma.$transaction((tx) => queueBusinessRow(tx, l, { actor: input.actor, source: input.source, holdMs: input.holdMs ?? FOLLOWER_PRICE_HOLD_MS })))
  }
  if (queued.length) await fireOutboundJobs(queued, { source: input.source })
  return queued.map((r) => r.id)
}

/**
 * A listing that could not be sent to (paused, a draft, Inactive) can be now: send its business offer as Nexus keeps it —
 * for every Amazon listing in scope whose business price Nexus has ever kept (a setting now, or a person's audit row: a
 * removal still to reach Amazon). A reopen also needs it: Amazon's reopen replays the offer as it was at the close.
 */
export async function queueHeldBusinessSends(input: { listingIds?: string[]; productIds?: string[]; actor: string; cause: 'resume' | 'publish' | 'reopen' }): Promise<string[]> {
  const scope: Prisma.ChannelListingWhereInput | null = input.listingIds?.length ? { id: { in: input.listingIds } }
    : input.productIds?.length ? { productId: { in: input.productIds } } : null
  if (!scope) return []
  try {
    const listings = await prisma.channelListing.findMany({
      where: { ...scope, channel: 'AMAZON', OR: [{ businessPriceRule: { not: null } }, { overrideHistory: { some: { fieldName: 'businessPrice' } } }] },
      select: { id: true },
    })
    return await queueBusinessSends({ listingIds: listings.map((l) => l.id), actor: input.actor, source: `BUSINESS_PRICE_${input.cause.toUpperCase()}` })
  } catch (err) {
    // A business send that cannot be queued here is queued by the next change or the next resume; it never fails the caller.
    const { logger } = await import('../../utils/logger.js')
    logger.warn('business price: held sends not queued', { cause: input.cause, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

export { BUSINESS_PRICE_SYNC_TYPE, storedBusinessSetting }
