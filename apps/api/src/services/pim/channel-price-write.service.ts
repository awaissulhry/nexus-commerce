/**
 * MX.1 / Add 4(b) — the ONE channel price write (design §2 Change 2, §3.7; report 25 §5.2/5.3/5.8, report 19 §5.5).
 *
 * Three routes wrote three different columns: `channel-pricing` wrote `price`, the listings pricing route wrote
 * `price` while calling it `priceOverride`, and `pricing/bulk-override` wrote `priceOverride` WITHOUT
 * `followMasterPrice = false` — so the engine ignored it and the audit row, the timeline row and `updated: N` all
 * reported a change the resolved price did not reflect. The push reads `ChannelListing.price` and nothing else.
 *
 * Here, ONE shape, in ONE transaction per listing:
 *   - a price: `price` AND `priceOverride` = the value, `followMasterPrice = false`, `lastOverrideAt/By`;
 *     `null` clears both and hands the listing back to the master price (`followMasterPrice = true`).
 *   - a sale: `salePrice` + the two window columns (`sale-window.ts`); a value needs BOTH dates (Amazon's
 *     `discounted_price.schedule` requires start_at and end_at) — refused by name otherwise.
 *   - a `ChannelListingOverride` audit row and a `PriceChangeEvent` timeline row (the PH.1 helper's shape).
 *   - the pending PRICE_UPDATE rows for the listing are cancelled and ONE fresh PRICE_UPDATE row is enqueued through
 *     the existing instant lane with the price AND the sale window in its payload, so a price push never wipes the
 *     sale on Amazon (report 19 §5.9) and a sale push never wipes the price.
 *   - CAS on `ChannelListing.version` (bumped on every applied row); `noop` spends nothing.
 *
 * `channel-pricing` PATCH, `pricing/bulk-override` and the Matrix door delegate here. No snapshot refresh: the
 * pricing engine's chain is in no publish path (M8) and its hourly cron re-materialises the snapshot.
 */
import prisma from '../../db.js'
import type { Prisma } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { priceChangeData, type PriceChangeSourceLiteral } from '../price-history.service.js'
import { fireOutboundJobs } from '../outbound-enqueue.js'
import { readSaleWindows, saleWindowColumnsExist, validateSaleWindow, writeSaleWindow, type SaleWindow } from './sale-window.js'
import { decimalToNumber } from './sheet-rows.service.js'

const VALID_SYNC_TARGETS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'])
/** The same operator grace window the FOLLOW/PIN primitives use: 30 s to undo before the push leaves. */
const PRICE_HOLD_MS = 30 * 1000

export interface PriceWriteTarget {
  listingId: string
  /** `undefined` = untouched; a number sets it here; `null` clears it back to the master price. */
  price?: number | null
  /** `undefined` = untouched; `{ value: null }` clears the sale. */
  sale?: { value: number | null; start: string | null; end: string | null }
  expectedVersion?: number
}

export interface PriceWriteOutcome {
  listingId: string
  productId: string | null
  channel: string | null
  marketplace: string | null
  outcome: 'applied' | 'refused' | 'noop' | 'conflict'
  reason?: string
  version: number
  /** The PRICE_UPDATE queue row id when one was enqueued (null on a channel with no outbound lane). */
  queueId: string | null
}

export interface PriceWriteResult { results: PriceWriteOutcome[]; applied: number; refused: number; noop: number; conflict: number }

const round2 = (n: number) => Math.round(n * 100) / 100
const money = (v: number | null, currency: string) => (v == null ? '—' : `${currency} ${v.toFixed(2)}`)

export async function writeChannelPrices(input: {
  targets: PriceWriteTarget[]
  actor: string
  source: PriceChangeSourceLiteral
  /** The timeline sentence prefix, e.g. `bulk-override SET_FIXED 89.99`; the service appends what changed. */
  reason?: string
}): Promise<PriceWriteResult> {
  const result: PriceWriteResult = { results: [], applied: 0, refused: 0, noop: 0, conflict: 0 }
  if (input.targets.length === 0) return result
  const ids = [...new Set(input.targets.map((t) => t.listingId))]
  const [listings, windows, hasWindow] = await Promise.all([
    prisma.channelListing.findMany({
      where: { id: { in: ids } },
      select: { id: true, productId: true, channel: true, marketplace: true, region: true, externalListingId: true, price: true, priceOverride: true, salePrice: true, followMasterPrice: true, version: true, fulfillmentMethod: true, product: { select: { sku: true, basePrice: true } } },
    }),
    readSaleWindows(prisma as never, ids),
    saleWindowColumnsExist(prisma as never),
  ])
  const byId = new Map(listings.map((l) => [l.id, l]))
  const marketKeys = [...new Set(listings.map((l) => `${l.channel}|${l.marketplace}`))]
  const marketplaces = await prisma.marketplace.findMany({ where: { OR: marketKeys.map((k) => ({ channel: k.split('|')[0], code: k.split('|')[1] })) }, select: { channel: true, code: true, currency: true } })
  const currencyOf = new Map(marketplaces.map((m) => [`${m.channel}|${m.code}`, m.currency]))
  const queued: Array<{ id: string; productId: string | null; syncType: string; holdUntil: Date | null }> = []

  for (const t of input.targets) {
    const l = byId.get(t.listingId)
    const push = (o: Omit<PriceWriteOutcome, 'listingId'>) => { result.results.push({ listingId: t.listingId, ...o }); result[o.outcome]++ }
    if (!l) { push({ productId: null, channel: null, marketplace: null, outcome: 'refused', reason: 'No listing with this id', version: 0, queueId: null }); continue }
    const base = { productId: l.productId, channel: l.channel, marketplace: l.marketplace, queueId: null as string | null }
    if (t.expectedVersion !== undefined && t.expectedVersion !== l.version) { push({ ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: l.version }); continue }
    if (t.price === undefined && t.sale === undefined) { push({ ...base, outcome: 'noop', version: l.version }); continue }
    const currency = currencyOf.get(`${l.channel}|${l.marketplace}`) ?? 'EUR'
    const currentPrice = decimalToNumber(l.price)
    const currentOverride = decimalToNumber(l.priceOverride)
    const nextPrice = t.price === undefined ? undefined : t.price == null ? null : round2(Number(t.price))
    if (nextPrice !== undefined && nextPrice !== null && (!Number.isFinite(nextPrice) || nextPrice < 0)) { push({ ...base, outcome: 'refused', reason: 'A price is zero or more', version: l.version }); continue }
    const currentSale: { value: number | null } & SaleWindow = { value: decimalToNumber(l.salePrice), ...(windows.get(l.id) ?? { start: null, end: null }) }
    const nextSale = t.sale === undefined ? undefined : { value: t.sale.value == null ? null : round2(Number(t.sale.value)), start: t.sale.value == null ? null : t.sale.start, end: t.sale.value == null ? null : t.sale.end }
    if (nextSale) {
      const problem = validateSaleWindow(nextSale.value, nextSale)
      if (problem) { push({ ...base, outcome: 'refused', reason: problem, version: l.version }); continue }
      if (nextSale.value != null && !hasWindow) { push({ ...base, outcome: 'refused', reason: 'This database has no sale-window columns yet — the sale cannot be scheduled', version: l.version }); continue }
    }
    const priceChanges = nextPrice !== undefined && !(nextPrice === null ? l.followMasterPrice !== false && currentOverride == null : currentPrice === nextPrice && currentOverride === nextPrice && l.followMasterPrice === false)
    const saleChanges = nextSale !== undefined && (nextSale.value !== currentSale.value || nextSale.start !== currentSale.start || nextSale.end !== currentSale.end)
    if (!priceChanges && !saleChanges) { push({ ...base, outcome: 'noop', version: l.version }); continue }

    const basePrice = decimalToNumber(l.product?.basePrice)
    const effectivePrice = priceChanges ? (nextPrice ?? basePrice) : (currentPrice ?? (l.followMasterPrice !== false ? basePrice : currentOverride))
    const effectiveSale = saleChanges ? nextSale! : currentSale
    const sentences: string[] = []
    if (priceChanges) sentences.push(nextPrice == null ? `price cleared (was ${money(currentPrice, currency)}) — follows the base price` : `price ${money(currentPrice, currency)} → ${money(nextPrice, currency)}`)
    if (saleChanges) sentences.push(nextSale!.value == null ? `sale cleared (was ${money(currentSale.value, currency)})` : `sale ${money(nextSale!.value, currency)} ${nextSale!.start} → ${nextSale!.end}`)
    const reason = [input.reason, sentences.join(' · ')].filter(Boolean).join(': ')

    const written = await prisma.$transaction(async (tx) => {
      const data: Prisma.ChannelListingUpdateManyMutationInput = { syncStatus: 'PENDING', lastSyncStatus: 'PENDING', version: { increment: 1 } }
      if (priceChanges) {
        if (nextPrice == null) Object.assign(data, { price: null, priceOverride: null, followMasterPrice: true, lastOverrideAt: new Date(), lastOverrideBy: input.actor })
        else Object.assign(data, { price: nextPrice, priceOverride: nextPrice, followMasterPrice: false, lastOverrideAt: new Date(), lastOverrideBy: input.actor })
      }
      if (saleChanges) data.salePrice = effectiveSale.value
      const guarded = await tx.channelListing.updateMany({ where: { id: l.id, version: l.version }, data })
      if (guarded.count !== 1) return null
      if (saleChanges) await writeSaleWindow(tx, l.id, { start: effectiveSale.start, end: effectiveSale.end })
      if (priceChanges) {
        await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'price', previousValue: currentOverride == null ? (currentPrice == null ? null : String(currentPrice)) : String(currentOverride), newValue: nextPrice == null ? null : String(nextPrice), reason, changedBy: input.actor } })
        await tx.priceChangeEvent.create({ data: priceChangeData({ productId: l.productId, sku: l.product?.sku ?? '', channel: l.channel, marketplace: l.marketplace, fulfillmentMethod: l.fulfillmentMethod ?? null, oldPrice: currentPrice, newPrice: nextPrice ?? basePrice, currency, source: input.source, reason, actor: input.actor }) })
      }
      if (saleChanges) {
        await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'salePrice', previousValue: currentSale.value == null ? null : `${currentSale.value} ${currentSale.start ?? ''}→${currentSale.end ?? ''}`.trim(), newValue: effectiveSale.value == null ? null : `${effectiveSale.value} ${effectiveSale.start}→${effectiveSale.end}`, reason, changedBy: input.actor } })
      }
      let queueId: string | null = null
      if (VALID_SYNC_TARGETS.has(l.channel)) {
        await tx.outboundSyncQueue.updateMany({ where: { channelListingId: l.id, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' }, data: { syncStatus: 'CANCELLED' } })
        const holdUntil = new Date(Date.now() + PRICE_HOLD_MS)
        const row = await tx.outboundSyncQueue.create({
          data: {
            productId: l.productId, channelListingId: l.id, targetChannel: l.channel as never, targetRegion: l.region,
            syncStatus: 'PENDING' as never, syncType: 'PRICE_UPDATE', holdUntil, externalListingId: l.externalListingId, maxRetries: 3,
            payload: {
              source: 'CHANNEL_PRICE_WRITE', marketplace: l.marketplace, actor: input.actor,
              price: effectivePrice ?? undefined,
              salePrice: effectiveSale.value, salePriceStart: effectiveSale.start, salePriceEnd: effectiveSale.end,
            } as Prisma.InputJsonValue,
          },
          select: { id: true, productId: true, syncType: true, holdUntil: true },
        })
        queueId = row.id
        queued.push(row)
      }
      return { version: l.version + 1, queueId }
    })
    if (!written) { push({ ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: (await prisma.channelListing.findUnique({ where: { id: l.id }, select: { version: true } }))?.version ?? l.version }); continue }
    push({ ...base, outcome: 'applied', version: written.version, queueId: written.queueId })
  }
  // Post-commit: the instant lane honours each row's own holdUntil; the drain cron is the fallback (never hangs).
  if (queued.length) await fireOutboundJobs(queued, { source: 'CHANNEL_PRICE_WRITE' })
  logger.info('channel-price-write: applied', { actor: input.actor, source: input.source, applied: result.applied, refused: result.refused, noop: result.noop, conflict: result.conflict })
  return result
}
