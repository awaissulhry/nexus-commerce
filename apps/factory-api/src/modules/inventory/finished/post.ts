import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { availabilityOf } from '@nexus/factory-domain/inventory/reservations/rules'
import { finishedItemDraft, standardCostOn, type SkuFacts } from '@nexus/factory-domain/production/completion/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { postMoves, type LedgerRow, type MoveDraft, type PostedMove } from '../ledger/post-moves'
import { lockReservations, readKeyFacts } from '../reservations/store'

/**
 * Finished goods in the stock ledger (B-W2a-12; GAP-003, MES-011; factory-db wave 5): the stock side of "Report finished
 * to stock", for apps/factory-api's modules/production/completion, which calls it INSIDE its command.
 *
 *   places     a site's finished-goods stock: its FINISHED_GOODS locations and every place inside one (the receipt's
 *              trigger walks the same tree), not archived.
 *   the item   one FINISHED item per SKU (Item.variantId, PCS; never through the materials API, which leaves FINISHED
 *              out): made the first time a SKU goes into stock, its code the SKU's (finishedItemFor).
 *   a receipt  one PRODUCTION_RECEIPT move per cell (into a place, no from; the work order; whole garments; its reference
 *              the work order's batch number) through postMoves, the one writer of the ledger. Valued at the standard
 *              cost (the company's costing method is UNDECIDED until the accountant answers, GATE-ACCOUNTANT): the
 *              item's FROZEN StandardCost in force on the day (wave 7), else the item's own standard cost, else not
 *              valued (the stock overview says so).
 *   reversal   the receipt's mirror (out of the place it went to), postMoves again: a 409 in words when the place no
 *              longer holds the garments. It takes the reservation lock of the item first (as a write-off does) and
 *              answers the keys it leaves over-reserved.
 */

export type Reader = FactoryClient | CommandTx

export const PRODUCTION_RECEIPT = 'PRODUCTION_RECEIPT' as const

// ---- places ------------------------------------------------------------------------------------------------------------

export interface FinishedPlace {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly parentId: string | null
  readonly status: string
  /** A FINISHED_GOODS location itself (not a place inside one). */
  readonly root: boolean
}

/** The site's finished-goods places, in code order (archived ones left out). */
export async function finishedPlaces(db: Reader, siteId: string): Promise<FinishedPlace[]> {
  const rows = await db.location.findMany({ where: { siteId }, select: { id: true, code: true, name: true, kind: true, parentId: true, status: true }, orderBy: { code: 'asc' } })
  const byId = new Map(rows.map((row) => [row.id, row]))
  const inside = (row: (typeof rows)[number]): boolean => {
    let place: (typeof rows)[number] | undefined = row
    for (let depth = 0; place && depth < 32; depth++) {
      if (place.kind === 'FINISHED_GOODS') return true
      place = place.parentId ? byId.get(place.parentId) : undefined
    }
    return false
  }
  return rows.filter((row) => row.status !== 'ARCHIVED' && inside(row)).map((row) => ({ ...row, root: row.kind === 'FINISHED_GOODS' }))
}

/** Where a report goes when none is named: the site's one finished-goods location (null when it has none or several). */
export function defaultPlaceOf(places: readonly FinishedPlace[]): FinishedPlace | null {
  const roots = places.filter((place) => place.root)
  if (roots.length === 1) return roots[0]!
  return places.length === 1 ? places[0]! : null
}

// ---- SKUs and their finished-goods items -------------------------------------------------------------------------------

export interface SkuRow {
  readonly variantId: string
  readonly sku: string
  readonly colourwayId: string
  readonly size: string
  /** Its FINISHED item, once one was made. */
  readonly itemId: string | null
  readonly itemCurrency: string | null
}

export const skuKey = (colourwayId: string, size: string): string => `${colourwayId}|${size}`

/** The style's SKUs for these colourways and sizes, with their FINISHED item (when made), by colourway|size. */
export async function readSkus(db: Reader, styleId: string, cells: readonly { readonly colourwayId: string; readonly size: string }[]): Promise<Map<string, SkuRow>> {
  if (cells.length === 0) return new Map()
  const variants = await db.variant.findMany({
    where: { styleId, colourwayId: { in: [...new Set(cells.map((cell) => cell.colourwayId))] }, size: { in: [...new Set(cells.map((cell) => cell.size))] } },
    select: { id: true, sku: true, colourwayId: true, size: true },
  })
  const items = variants.length > 0 ? await db.item.findMany({ where: { variantId: { in: variants.map((variant) => variant.id) }, kind: 'FINISHED' }, select: { id: true, variantId: true, currency: true } }) : []
  const itemOf = new Map(items.map((item) => [item.variantId!, item]))
  return new Map(
    variants.map((variant) => [
      skuKey(variant.colourwayId, variant.size),
      { variantId: variant.id, sku: variant.sku, colourwayId: variant.colourwayId, size: variant.size, itemId: itemOf.get(variant.id)?.id ?? null, itemCurrency: itemOf.get(variant.id)?.currency ?? null },
    ]),
  )
}

/**
 * The SKU's FINISHED item, made now when it has none (inside the caller's command): ON CONFLICT DO NOTHING, so two
 * commands that make the same SKU's item at once end with one; a code another item holds is a 409 in words.
 */
export async function finishedItemFor(tools: CommandTools, sku: SkuRow, facts: Omit<SkuFacts, 'sku' | 'size'> & { readonly companyId: string | null }): Promise<string> {
  if (sku.itemId) return sku.itemId
  const { tx } = tools
  const draft = finishedItemDraft({ ...facts, sku: sku.sku, size: sku.size })
  const id = newId()
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  await tx.item.createMany({ data: [{ id, companyId: facts.companyId, ...draft, variantId: sku.variantId, createdById: actorId }], skipDuplicates: true })
  const made = await tx.item.findFirst({ where: { variantId: sku.variantId }, select: { id: true } })
  if (!made) {
    throw new ConflictError(`Item code ${sku.sku} is taken by another item, so SKU ${sku.sku} gets no finished-goods item: give that item another code first (Product › Materials).`)
  }
  if (made.id === id) {
    tools.audit({ action: 'inventory.finishedItem', recordType: 'Item', recordId: id, after: { ...draft, variantId: sku.variantId, companyId: facts.companyId } })
  }
  return made.id
}

// ---- receipts -----------------------------------------------------------------------------------------------------------

export interface FinishedDraft {
  readonly siteId: string
  readonly companyId: string
  readonly workOrderId: string
  readonly itemId: string
  readonly quantity: number
  readonly toLocationId: string
  /** The work order's batch number. */
  readonly reference: string | null
  readonly note?: string | null
}

/** The FROZEN standard cost of the item in force today for the company, in the item's currency (null: none). */
async function standardCostFor(tx: CommandTx, companyId: string, itemId: string, day: string): Promise<MoveDraft['cost']> {
  const item = await tx.item.findUnique({ where: { id: itemId }, select: { currency: true } })
  if (!item) return null
  const rows = await tx.standardCost.findMany({
    where: { companyId, itemId, status: 'FROZEN' },
    select: { id: true, status: true, validFrom: true, validTo: true, unitCost: true, currency: true },
  })
  const chosen = standardCostOn(
    rows.map((row) => ({ ...row, validFrom: row.validFrom.toISOString().slice(0, 10), validTo: row.validTo ? row.validTo.toISOString().slice(0, 10) : null, unitCost: row.unitCost.toString() })),
    day,
    item.currency,
  )
  return chosen ? { method: 'STANDARD_COST', unitCost: chosen.unitCost } : null
}

/** One PRODUCTION_RECEIPT per draft, in order, valued at the standard cost; key `<key>:<n>` (postMoves). */
export async function postFinishedReceipts(tools: CommandTools, drafts: readonly FinishedDraft[], key: string): Promise<PostedMove[]> {
  const day = businessDate(tools.now)
  const moves: MoveDraft[] = []
  for (const draft of drafts) {
    const cost = await standardCostFor(tools.tx, draft.companyId, draft.itemId, day)
    moves.push({
      siteId: draft.siteId,
      reason: PRODUCTION_RECEIPT,
      itemId: draft.itemId,
      itemColourId: null,
      lotId: null,
      hideId: null,
      toLocationId: draft.toLocationId,
      quantity: String(draft.quantity),
      uom: 'PCS',
      workOrderId: draft.workOrderId,
      reference: draft.reference,
      note: draft.note ?? null,
      ...(cost ? { cost } : {}),
    })
  }
  return postMoves(tools, moves, { key, issuePath: (index) => `body/cells/${index}` })
}

export interface OverReserved {
  readonly itemId: string
  readonly available: string
  readonly reserved: string
}

/**
 * The mirrors of these receipts (out of the place each went to), with the reason, under the items' reservation locks;
 * answers the keys left over-reserved (as a write-off does: the garments are gone from stock either way).
 */
export async function reverseFinishedReceipts(tools: CommandTools, tenantId: string, originals: readonly LedgerRow[], note: string, key: string): Promise<{ moves: PostedMove[]; overReserved: OverReserved[] }> {
  const keys = [...new Map(originals.map((row) => [`${row.siteId}|${row.itemId}`, { siteId: row.siteId, itemId: row.itemId, itemColourId: null }])).values()]
  await lockReservations(tools.tx, tenantId, keys)
  const drafts: MoveDraft[] = originals.map((row) => ({
    siteId: row.siteId,
    reason: PRODUCTION_RECEIPT,
    itemId: row.itemId,
    itemColourId: row.itemColourId,
    lotId: row.lotId,
    hideId: row.hideId,
    fromLocationId: row.toLocationId,
    toLocationId: null,
    quantity: row.quantity.toString(),
    uom: row.uom,
    baseQuantity: row.baseQuantity.toString(),
    workOrderId: row.workOrderId,
    reference: row.reference,
    note,
    reversalOfId: row.id,
  }))
  const moves = await postMoves(tools, drafts, { key, issuePath: () => 'body' })
  const overReserved: OverReserved[] = []
  for (const entry of keys) {
    const facts = await readKeyFacts(tools.tx, entry, { withOrders: true })
    const figures = availabilityOf(facts.stock, facts.reservations)
    if (figures.overReserved) overReserved.push({ itemId: entry.itemId, available: quantityText(figures.available), reserved: quantityText(figures.reserved) })
  }
  return { moves, overReserved }
}
