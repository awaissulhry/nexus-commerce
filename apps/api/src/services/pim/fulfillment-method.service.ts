/**
 * MX.1 / Add 4(a) — the ONE fulfilment-method write (design §3.7; report 18 §5.2–5.4).
 *
 * Before this service `PATCH /api/products/:id/fulfillment` wrote the typed column and the FLAT
 * `platformAttributes.fulfillmentChannel`, while the fail-closed FBA guard (`isFbaListing`) reads the NESTED
 * `fulfillment_availability[0].fulfillment_channel_code` — two stores, one fact — and answered the REQUEST count
 * (`updated: updates.length`) whatever the rows did. Here:
 *
 *   - ONE store rule: the typed column AND the flat key AND the nested code are written together, inside one
 *     transaction, so the cell and the guard can never disagree about what the operator set.
 *   - REAL per-row outcomes (`applied | refused | noop | conflict`), never the request count.
 *   - refusals BY NAME: an FBA→FBM change while FBA stock is on hand (or an active FBA offer exists) keeps the
 *     guard closed — the same sentence the shared preview says — and is refused rather than written into a state
 *     the push layer would ignore.
 *   - CAS on `ChannelListing.version` (the version is bumped on every applied row; a stale `expectedVersion` is a
 *     `conflict` carrying the current one).
 *   - the SCT.6d product-flag follow-on is KEPT: an FBM variant whose product still says FBA moves the product flag
 *     when every other FBA signal is clear; toggling FBA locks it. A completed FBM conversion recascades the product
 *     so the pool quantity is pushed at once — the pause→resume workaround retires (D-MX11).
 *
 * The method itself is converted in Seller Central (M7): nothing here calls Amazon.
 */
import prisma from '../../db.js'
import type { Prisma } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { recascadeAfterSyncControlChange } from '../stock-movement.service.js'

export type FulfilmentWrite = 'FBA' | 'FBM' | null

export interface FulfilmentTarget {
  listingId: string
  /** `null` clears the typed column and both mirrors (back to the derivation). */
  method: FulfilmentWrite
  /** CAS on `ChannelListing.version`; omitted = unguarded (the legacy route's callers). */
  expectedVersion?: number
}

export interface FulfilmentOutcome {
  listingId: string
  productId: string | null
  channel: string | null
  marketplace: string | null
  outcome: 'applied' | 'refused' | 'noop' | 'conflict'
  reason?: string
  /** The listing's version AFTER the write (unchanged on refused/noop; the current one on conflict). */
  version: number
  /** What happened to `Product.fulfillmentMethod` on an applied row. */
  productFlag: 'FBA' | 'FBM' | 'held' | null
}

export interface FulfilmentResult {
  results: FulfilmentOutcome[]
  applied: number
  refused: number
  noop: number
  conflict: number
  /** Products whose flag moved FBA → FBM (the SCT.6d conversion). */
  productConversions: string[]
}

const FBA_LOCATION_CODE = 'AMAZON-EU-FBA'

/** The nested code the guard reads. Every cached Amazon market enum is `AMAZON_EU | DEFAULT` (phase 0(c)). */
export const nestedChannelCode = (method: 'FBA' | 'FBM'): string => (method === 'FBA' ? 'AMAZON_EU' : 'DEFAULT')

/** PURE — the platformAttributes bag after a fulfilment write: flat mirror + nested code, everything else kept. */
export function fulfilmentAttributes(bag: unknown, channel: string, method: FulfilmentWrite): Record<string, unknown> {
  const pa: Record<string, unknown> = { ...((bag as Record<string, unknown> | null) ?? {}) }
  if (method == null) {
    delete pa.fulfillmentChannel
    if (channel === 'AMAZON') delete pa.fulfillment_availability
    return pa
  }
  pa.fulfillmentChannel = method === 'FBA' ? 'AFN' : 'MFN'
  if (channel === 'AMAZON') {
    const existing = Array.isArray(pa.fulfillment_availability) ? (pa.fulfillment_availability as unknown[]) : []
    const first = (existing[0] && typeof existing[0] === 'object' ? existing[0] : {}) as Record<string, unknown>
    /* A merchant quantity under an FBA code is exactly what the guard exists to refuse — never carry one across. */
    const { quantity: _q, ...rest } = first
    pa.fulfillment_availability = [{ ...(method === 'FBA' ? rest : first), fulfillment_channel_code: nestedChannelCode(method) }, ...existing.slice(1)]
  }
  return pa
}

export const guardHeldReason = (fbaUnits: number, activeOffer: boolean): string =>
  activeOffer && fbaUnits <= 0
    ? 'Refused — an active FBA offer keeps the guard closed; convert the offer in Seller Central first'
    : `Refused — ${fbaUnits} units of FBA stock on hand keep the guard closed; convert the offer in Seller Central first`

export async function setFulfillmentMethod(input: { targets: FulfilmentTarget[]; actor: string }): Promise<FulfilmentResult> {
  const result: FulfilmentResult = { results: [], applied: 0, refused: 0, noop: 0, conflict: 0, productConversions: [] }
  if (input.targets.length === 0) return result
  const ids = [...new Set(input.targets.map((t) => t.listingId))]
  const listings = await prisma.channelListing.findMany({
    where: { id: { in: ids } },
    select: { id: true, productId: true, channel: true, marketplace: true, fulfillmentMethod: true, platformAttributes: true, version: true, product: { select: { sku: true, fulfillmentMethod: true } } },
  })
  const byId = new Map(listings.map((l) => [l.id, l]))
  const productIds = [...new Set(listings.map((l) => l.productId))]
  const [fbaStock, fbaOffers] = await Promise.all([
    prisma.stockLevel.findMany({ where: { productId: { in: productIds }, location: { code: FBA_LOCATION_CODE } }, select: { productId: true, quantity: true } }),
    prisma.offer.findMany({ where: { channelListingId: { in: ids }, fulfillmentMethod: 'FBA', isActive: true }, select: { channelListingId: true } }),
  ])
  const fbaUnits = new Map<string, number>()
  for (const s of fbaStock) fbaUnits.set(s.productId, (fbaUnits.get(s.productId) ?? 0) + s.quantity)
  const activeFbaOffer = new Set(fbaOffers.map((o) => o.channelListingId))

  const recascade = new Set<string>()
  const audit: Prisma.SyncControlAuditCreateManyInput[] = []
  for (const t of input.targets) {
    const l = byId.get(t.listingId)
    const push = (o: Omit<FulfilmentOutcome, 'listingId'>) => { result.results.push({ listingId: t.listingId, ...o }); result[o.outcome]++ }
    if (!l) { push({ productId: null, channel: null, marketplace: null, outcome: 'refused', reason: 'No listing with this id', version: 0, productFlag: null }); continue }
    const base = { productId: l.productId, channel: l.channel, marketplace: l.marketplace, productFlag: null as FulfilmentOutcome['productFlag'] }
    if (l.channel !== 'AMAZON' && l.channel !== 'EBAY') { push({ ...base, outcome: 'refused', reason: `${l.channel} has no fulfilment method`, version: l.version }); continue }
    if (t.expectedVersion !== undefined && t.expectedVersion !== l.version) { push({ ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: l.version }); continue }
    const units = fbaUnits.get(l.productId) ?? 0
    if (l.channel === 'AMAZON' && t.method === 'FBM' && (units > 0 || activeFbaOffer.has(l.id))) {
      push({ ...base, outcome: 'refused', reason: guardHeldReason(units, activeFbaOffer.has(l.id)), version: l.version }); continue
    }
    const pa = fulfilmentAttributes(l.platformAttributes, l.channel, t.method)
    const paBefore = (l.platformAttributes as Record<string, unknown> | null) ?? {}
    const mirrorsAlreadyRight = JSON.stringify(paBefore.fulfillmentChannel ?? null) === JSON.stringify(pa.fulfillmentChannel ?? null)
      && JSON.stringify(paBefore.fulfillment_availability ?? null) === JSON.stringify(pa.fulfillment_availability ?? null)
    if ((l.fulfillmentMethod ?? null) === t.method && mirrorsAlreadyRight) { push({ ...base, outcome: 'noop', version: l.version }); continue }

    const written = await prisma.$transaction(async (tx) => {
      const guarded = await tx.channelListing.updateMany({
        where: { id: l.id, version: l.version },
        data: { fulfillmentMethod: t.method, platformAttributes: pa as Prisma.InputJsonValue, syncStatus: 'PENDING', version: { increment: 1 } },
      })
      if (guarded.count !== 1) return null
      // SCT.6d — the product flag follows when every other FBA signal is clear; FBA locks it immediately.
      let productFlag: FulfilmentOutcome['productFlag'] = null
      if (t.method === 'FBA') {
        const moved = await tx.product.updateMany({ where: { id: l.productId, fulfillmentMethod: { not: 'FBA' } }, data: { fulfillmentMethod: 'FBA' } })
        productFlag = moved.count > 0 ? 'FBA' : null
      } else if (t.method === 'FBM' && String(l.product?.fulfillmentMethod ?? '').toUpperCase() === 'FBA') {
        const [otherFbaListing, fbaOffer] = await Promise.all([
          tx.channelListing.findFirst({ where: { productId: l.productId, fulfillmentMethod: 'FBA', id: { not: l.id } }, select: { id: true } }),
          tx.offer.findFirst({ where: { channelListing: { productId: l.productId }, fulfillmentMethod: 'FBA', isActive: true }, select: { id: true } }),
        ])
        if (!otherFbaListing && units === 0 && !fbaOffer) {
          await tx.product.update({ where: { id: l.productId }, data: { fulfillmentMethod: 'FBM' } })
          productFlag = 'FBM'
        } else productFlag = 'held'
      }
      return { version: l.version + 1, productFlag }
    })
    if (!written) { push({ ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: (await prisma.channelListing.findUnique({ where: { id: l.id }, select: { version: true } }))?.version ?? l.version }); continue }
    if (written.productFlag === 'FBM') { result.productConversions.push(l.productId); recascade.add(l.productId) }
    if (written.productFlag === 'held') logger.warn('fulfillment: product flag HELD (live FBA evidence remains)', { productId: l.productId, listingId: l.id, units, activeOffer: activeFbaOffer.has(l.id) })
    audit.push({ actor: input.actor, scopeType: 'LISTING', scopeId: l.id, scopeName: `${l.product?.sku ?? '?'}@${l.channel}:${l.marketplace}`, field: 'fulfillmentMethod', before: { method: l.fulfillmentMethod ?? null }, after: { method: t.method, productFlag: written.productFlag } })
    push({ ...base, outcome: 'applied', version: written.version, productFlag: written.productFlag })
  }
  if (audit.length) await prisma.syncControlAudit.createMany({ data: audit }).catch((err) => logger.warn('fulfillment: audit write failed', { error: err instanceof Error ? err.message : String(err) }))
  // A completed FBM conversion pushes pool truth now (D-MX11) — in the background, like every Sync Control mutation.
  if (recascade.size > 0) void recascadeAfterSyncControlChange([...recascade], input.actor).then((r) => logger.info('fulfillment: recascade after FBM conversion', { ...r, actor: input.actor }))
  return result
}
