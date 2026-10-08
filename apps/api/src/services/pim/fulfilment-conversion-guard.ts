/**
 * Amazon fulfilment conversion (Owner 2026-10-07) — the ONE exception the FBA hard block (`guardFbaQtyFlip`,
 * `clients/amazon-sp-api.client.ts`) makes, kept in its own small module so the client imports nothing else.
 *
 * A merchant `fulfillment_availability: [{ DEFAULT, quantity }]` for an FBA SKU is exactly what converts its Amazon offer
 * to FBM, and a `delete [{ AMAZON_EU }]` is what takes the offer off FBA. The guard strips both in every case but one: a
 * call that carries a `conversionId` whose `FulfilmentConversion` row says an operator-confirmed run is converting THIS
 * seller SKU on THIS marketplace to FBM with THIS quantity, right now (`SENDING`, created less than 10 minutes ago), with
 * EXACTLY the fulfilment patch the call carries (the row's `payload`, written before the send), while Nexus mirrors no FBA
 * units of the product — read again here, at the moment of the send. Anything else, and any failed read, strips (fail
 * closed).
 */
import prisma from '../../db.js'

/** A conversion's send window: the row must be younger than this when the patch leaves. */
export const CONVERSION_SEND_WINDOW_MS = 10 * 60_000

export const FBA_LOCATION_CODE = 'AMAZON-EU-FBA'

export interface ConversionGuardRecord {
  status: string
  toMethod: string
  sku: string
  marketplaceId: string
  quantity: number | null
  operatorConfirmed: boolean
  createdAt: Date
  /** The fulfilment patches the run recorded before the send (`conversionPatches`). */
  payload: unknown
}

export interface ConversionGuardAsk {
  sku: string
  marketplaceId: string
  /** Every merchant quantity the patch carries (DEFAULT entries). */
  quantities: readonly number[]
  /** Every `/attributes/fulfillment_availability` patch the call carries, as sent. */
  patches: readonly unknown[]
  /** FBA units Nexus mirrors for the product NOW: on hand + reserved + inbound. */
  fbaUnits: number
  now: Date
}

/** PURE — does this conversion row let this merchant-quantity patch through? `reason` says why not (or what passed). */
export function conversionGuardVerdict(record: ConversionGuardRecord | null, ask: ConversionGuardAsk): { pass: boolean; reason: string } {
  const no = (reason: string) => ({ pass: false, reason })
  if (!record) return no('no conversion row with this id')
  if (record.status !== 'SENDING') return no(`the conversion is ${record.status}, not SENDING`)
  if (record.toMethod !== 'FBM') return no(`the conversion is to ${record.toMethod}, not FBM`)
  if (!record.operatorConfirmed) return no('the conversion was not confirmed by a person')
  if (record.sku !== ask.sku) return no(`the conversion is for SKU ${record.sku}, not ${ask.sku}`)
  if (record.marketplaceId !== ask.marketplaceId) return no(`the conversion is for marketplace ${record.marketplaceId}, not ${ask.marketplaceId}`)
  if (ask.quantities.length === 0 || record.quantity == null || ask.quantities.some((q) => q !== record.quantity)) {
    return no(`the patch carries quantity ${ask.quantities.join(',') || '—'}, the conversion ${record.quantity ?? '—'}`)
  }
  if (!samePatches(record.payload, ask.patches)) return no('the patch is not the one this conversion recorded')
  const age = ask.now.getTime() - record.createdAt.getTime()
  if (!(age >= 0 && age < CONVERSION_SEND_WINDOW_MS)) return no('the conversion is older than 10 minutes')
  if (ask.fbaUnits > 0) return no(`${ask.fbaUnits} FBA units are mirrored for the product now`)
  return { pass: true, reason: 'the operator-confirmed FBM conversion of this SKU and marketplace, its own patch, sending now, no FBA units' }
}

/** JSON with every object's keys sorted: the stored payload comes back from JSONB with its keys reordered. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
  : x))

/** PURE — are the call's fulfilment patches exactly the recorded ones (same ops, same order, same records)? */
export function samePatches(recorded: unknown, sent: readonly unknown[]): boolean {
  return Array.isArray(recorded) && recorded.length > 0 && canonical(recorded) === canonical(sent)
}

/** FBA units Nexus mirrors for a product: on hand at the FBA location (the guard's number) + reserved + inbound at Amazon. */
export async function readFbaUnits(productIds: readonly string[], skus: readonly string[]): Promise<Map<string, { onHand: number; reserved: number; inbound: number }>> {
  const out = new Map<string, { onHand: number; reserved: number; inbound: number }>()
  for (const id of productIds) out.set(id, { onHand: 0, reserved: 0, inbound: 0 })
  if (productIds.length === 0) return out
  const [levels, detail] = await Promise.all([
    prisma.stockLevel.findMany({ where: { productId: { in: [...productIds] }, location: { code: FBA_LOCATION_CODE } }, select: { productId: true, quantity: true } }),
    prisma.fbaInventoryDetail.findMany({
      where: { condition: { in: ['RESERVED', 'INBOUND'] }, quantity: { gt: 0 }, OR: [{ productId: { in: [...productIds] } }, ...(skus.length ? [{ sku: { in: [...skus] } }] : [])] },
      select: { productId: true, sku: true, condition: true, quantity: true },
    }),
  ])
  for (const l of levels) { const u = out.get(l.productId); if (u) u.onHand += l.quantity }
  const bySku = new Map<string, string>()
  if (productIds.length === 1) for (const sku of skus) bySku.set(sku, productIds[0]!)
  for (const d of detail) {
    const id = d.productId && out.has(d.productId) ? d.productId : bySku.get(d.sku)
    const u = id ? out.get(id) : undefined
    if (!u) continue
    if (d.condition === 'RESERVED') u.reserved += d.quantity
    else u.inbound += d.quantity
  }
  return out
}

/**
 * The guard's question, asked of the database: the conversion row and the product's FBA units now. A failed read is a
 * `pass: false` (the guard then strips, as it always did when it could not tell).
 */
export async function conversionLetsThrough(conversionId: string, ask: Omit<ConversionGuardAsk, 'fbaUnits' | 'now'>): Promise<{ pass: boolean; reason: string }> {
  try {
    const record = await prisma.fulfilmentConversion.findUnique({
      where: { id: conversionId },
      select: { status: true, toMethod: true, sku: true, marketplaceId: true, quantity: true, operatorConfirmed: true, createdAt: true, productId: true, payload: true },
    })
    if (!record) return conversionGuardVerdict(null, { ...ask, fbaUnits: 0, now: new Date() })
    const units = (await readFbaUnits([record.productId], [record.sku])).get(record.productId) ?? { onHand: 0, reserved: 0, inbound: 0 }
    return conversionGuardVerdict(record, { ...ask, fbaUnits: units.onHand + units.reserved + units.inbound, now: new Date() })
  } catch (err) {
    return { pass: false, reason: `the conversion could not be read (${err instanceof Error ? err.message : String(err)})` }
  }
}
