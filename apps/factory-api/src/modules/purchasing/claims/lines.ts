import type { Uom } from '@nexus/factory-db'
import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { CLAIM_LIMITS, lineCredit, type ClaimKind } from '@nexus/factory-domain/purchasing/claims/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { readSiteStock } from '../../inventory/issue/store'
import { ITEM_COLUMNS, unitsOf, type Reader } from '../store'
import { lotCostOf } from './store'

/**
 * What a claim's lines are about (B-W2a-44): each line typed, or made from a receipt's discrepancy, or from a lot (every
 * hide of it in stock, or its stock per location), resolved against the database in the caller's scope. A line names
 * its material, and its lot and hide when they are tracked: a hide names its lot, a lot its material and colour, a
 * receipt line its material (and its lot when it made only one), a discrepancy its receipt line and how much. The
 * quantity is given in a unit the material converts (default its base unit), else the discrepancy's, else what the hide
 * or the lot holds at the site. Its cost per base unit is the one typed (the cost grain), else the lot's (the receipt's
 * purchase price); its value is rounded once in the claim's currency. The claim's site, supplier and receipt follow from
 * its lines when the office does not name them, and every line must agree with them.
 */

export interface LineInput {
  readonly discrepancyId?: string | undefined
  readonly receiptLineId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | null | undefined
  readonly lotId?: string | null | undefined
  readonly hideId?: string | null | undefined
  /** Above 0, in `uom` (default the material's base unit). */
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
  /** For a unit of its own size (HIDE, ROLL, BOX …): what it measures in the base unit. */
  readonly baseQuantity?: string | undefined
  /** What is wrong with this line, when more than the claim's reason. */
  readonly reason?: string | null | undefined
  /** The cost per base unit the credit is asked at (cost grain); default the lot's. */
  readonly unitCost?: string | null | undefined
  readonly note?: string | null | undefined
  /** Where its goods leave from when they go back (Return to supplier); default the one place that holds them. */
  readonly fromLocationId?: string | undefined
}

export type LineItem = { readonly id: string; readonly code: string; readonly name: string; readonly companyId: string | null; readonly tracking: string } & Parameters<typeof unitsOf>[0]

export interface ResolvedLine {
  readonly at: string
  readonly discrepancyId: string | null
  readonly receiptLineId: string | null
  readonly item: LineItem
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  readonly quantity: string
  readonly uom: Uom
  readonly baseQuantity: string
  readonly reason: string | null
  readonly note: string | null
  readonly unitCost: string | null
  /** The currency the lot's cost is in (a typed cost: the claim's). */
  readonly costCurrency: string | null
  readonly fromLocationId: string | null
  /** What the line says of the claim's header: its site, supplier, receipt and the lot's quality state. */
  readonly siteId: string | null
  readonly partyId: string | null
  readonly receiptId: string | null
  readonly lotStatus: string | null
}

const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The claim is not valid as it stands.', problems)
const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** One line resolved (paths under `at`, e.g. body/lines/0). */
export async function resolveLine(db: Reader, input: LineInput, at: string): Promise<ResolvedLine> {
  let partyId: string | null = null
  let siteId: string | null = null
  let receiptId: string | null = null
  let receiptLineId = input.receiptLineId ?? null
  let quantity = input.quantity ?? null
  let uom = input.uom ?? null

  // The discrepancy it pursues: of a receipt, not closed; its receipt line and how much are the defaults.
  const discrepancyId = input.discrepancyId ?? null
  if (discrepancyId) {
    const row = isUuid(discrepancyId) ? await db.receiptDiscrepancy.findUnique({ where: { id: discrepancyId }, select: { id: true, seq: true, siteId: true, receiptId: true, receiptLineId: true, supplierId: true, status: true, quantity: true, uom: true } }) : null
    if (!row) throw refuse([{ path: `${at}/discrepancyId`, message: 'Not a discrepancy of a receipt you can see.' }])
    if (row.status === 'CLOSED') throw refuse([{ path: `${at}/discrepancyId`, message: `Discrepancy ${row.seq} is closed: nothing is pursued of it any more.` }])
    if (receiptLineId && row.receiptLineId && receiptLineId !== row.receiptLineId) throw refuse([{ path: `${at}/receiptLineId`, message: 'The discrepancy is about another line of the receipt.' }])
    receiptLineId = receiptLineId ?? row.receiptLineId
    if (!receiptLineId && !input.itemId && !input.lotId && !input.hideId) throw refuse([{ path: `${at}/discrepancyId`, message: `Discrepancy ${row.seq} is about the delivery as a whole: name the material of this line.` }])
    partyId = row.supplierId
    siteId = row.siteId
    receiptId = row.receiptId
    if (quantity === null && row.quantity !== null && row.uom !== null) {
      quantity = row.quantity.toFixed(4)
      uom = row.uom
    }
  }

  // The receipt line the goods came on: its material, colour and (when it made one) its lot.
  let lotId = input.lotId ?? null
  let itemId = input.itemId ?? null
  let itemColourId = input.itemColourId ?? null
  if (receiptLineId) {
    const line = isUuid(receiptLineId) ? await db.goodsReceiptLine.findUnique({ where: { id: receiptLineId }, select: { id: true, siteId: true, receiptId: true, itemId: true, itemColourId: true, receipt: { select: { supplierId: true } } } }) : null
    if (!line) throw refuse([{ path: `${at}/receiptLineId`, message: 'Not a line of a receipt you can see.' }])
    if (itemId && itemId !== line.itemId) throw refuse([{ path: `${at}/itemId`, message: 'The receipt line is of another material.' }])
    itemId = line.itemId
    itemColourId = input.itemColourId !== undefined ? itemColourId : line.itemColourId
    siteId = siteId ?? line.siteId
    receiptId = receiptId ?? line.receiptId
    partyId = partyId ?? line.receipt.supplierId
    if (!lotId && !input.hideId) {
      const lots = await db.lot.findMany({ where: { receiptLineId: line.id }, select: { id: true }, take: 2 })
      if (lots.length === 1) lotId = lots[0]!.id
    }
  }

  // The hide names its lot; the lot names its material, colour, site and supplier.
  const hideId = input.hideId ?? null
  if (hideId) {
    const hide = isUuid(hideId) ? await db.hide.findUnique({ where: { id: hideId }, select: { id: true, code: true, lotId: true, itemId: true, siteId: true } }) : null
    if (!hide) throw refuse([{ path: `${at}/hideId`, message: 'Not a hide you can see.' }])
    if (lotId && lotId !== hide.lotId) throw refuse([{ path: `${at}/hideId`, message: `Hide ${hide.code} is of another lot.` }])
    lotId = hide.lotId
  }
  let lotStatus: string | null = null
  if (lotId) {
    const lot = isUuid(lotId) ? await db.lot.findUnique({ where: { id: lotId }, select: { id: true, code: true, siteId: true, itemId: true, itemColourId: true, supplierId: true, qualityStatus: true, receiptLineId: true } }) : null
    if (!lot) throw refuse([{ path: `${at}/lotId`, message: 'Not a lot you can see.' }])
    if (itemId && itemId !== lot.itemId) throw refuse([{ path: `${at}/lotId`, message: `Lot ${lot.code} is of another material.` }])
    if (siteId && siteId !== lot.siteId) throw refuse([{ path: `${at}/lotId`, message: `Lot ${lot.code} is at another site.` }])
    itemId = lot.itemId
    itemColourId = lot.itemColourId
    siteId = lot.siteId
    partyId = partyId ?? lot.supplierId
    if (lot.supplierId && partyId && lot.supplierId !== partyId) throw refuse([{ path: `${at}/lotId`, message: `Lot ${lot.code} came from another supplier.` }])
    lotStatus = lot.qualityStatus
    if (!receiptLineId && lot.receiptLineId) {
      receiptLineId = lot.receiptLineId
      const line = await db.goodsReceiptLine.findUnique({ where: { id: lot.receiptLineId }, select: { receiptId: true } })
      receiptId = receiptId ?? line?.receiptId ?? null
    }
  }

  if (!itemId) throw refuse([{ path: `${at}/itemId`, message: 'Name the material, its lot, a hide, a receipt line or a discrepancy.' }])
  const item = isUuid(itemId) ? await db.item.findUnique({ where: { id: itemId }, select: { ...ITEM_COLUMNS, tracking: true } }) : null
  if (!item) throw refuse([{ path: `${at}/itemId`, message: 'Not a material you can see.' }])
  if (itemColourId) {
    const colour = isUuid(itemColourId) ? await db.itemColour.findUnique({ where: { id: itemColourId }, select: { itemId: true } }) : null
    if (!colour || colour.itemId !== item.id) throw refuse([{ path: `${at}/itemColourId`, message: 'Not a colour of this material.' }])
  }

  // How much: given, else the discrepancy's, else what the hide or the lot holds at the site.
  if (quantity === null) {
    if (!siteId || (!hideId && !lotId)) throw refuse([{ path: `${at}/quantity`, message: 'Say how much the line is about.' }])
    const held = await readSiteStock(db, siteId, { itemIds: [item.id], lotId, ...(hideId ? { hideId } : {}) })
    const onHand = held.reduce((sum, balance) => sum.plus(balance.onHand), ZERO)
    if (!onHand.gt(0)) throw refuse([{ path: `${at}/quantity`, message: `${hideId ? 'The hide' : 'The lot'} holds nothing at the site: say how much the line is about.` }])
    quantity = quantityText(onHand)
    uom = item.baseUom
  }
  const unit = uom ?? item.baseUom
  if (!(Number(quantity) > 0)) throw refuse([{ path: `${at}/quantity`, message: 'Expected a quantity above 0.' }])
  const base = baseQuantityOf({ quantity, uom: unit, baseQuantity: input.baseQuantity ?? null }, unitsOf(item))
  if (base.problem || base.baseQuantity === undefined) throw refuse([{ path: `${at}/${base.problem?.path ?? 'quantity'}`, message: base.problem?.message ?? 'Expected a quantity above 0.' }])
  if (!new Dec(base.baseQuantity).gt(0)) throw refuse([{ path: `${at}/quantity`, message: 'Expected a quantity above 0.' }])

  // The cost: typed (cost grain), else the lot's.
  let unitCost: string | null = null
  let costCurrency: string | null = null
  if (input.unitCost !== undefined && input.unitCost !== null) {
    unitCost = new Dec(input.unitCost).toFixed(6)
  } else if (lotId && siteId) {
    const cost = await lotCostOf(db, siteId, lotId)
    if (cost) {
      unitCost = cost.unitCost
      costCurrency = cost.currency
    }
  }
  const reason = blank(input.reason)
  if (reason && reason.length > CLAIM_LIMITS.reasonNote) throw refuse([{ path: `${at}/reason`, message: `At most ${CLAIM_LIMITS.reasonNote} characters.` }])
  return {
    at,
    discrepancyId,
    receiptLineId,
    item: item as LineItem,
    itemColourId,
    lotId,
    hideId,
    quantity: new Dec(quantity).toFixed(4),
    uom: unit,
    baseQuantity: new Dec(base.baseQuantity).toFixed(4),
    reason,
    note: blank(input.note),
    unitCost,
    costCurrency,
    fromLocationId: input.fromLocationId ?? null,
    siteId,
    partyId,
    receiptId,
    lotStatus,
  }
}

/** The lines as they are written: value in the claim's currency (a lot cost in another currency gives none). */
export function lineValue(line: Pick<ResolvedLine, 'unitCost' | 'costCurrency' | 'baseQuantity'>, currency: string): { unitCost: string | null; creditAmount: number | null } {
  if (line.unitCost === null || (line.costCurrency !== null && line.costCurrency !== currency)) return { unitCost: null, creditAmount: null }
  return { unitCost: line.unitCost, creditAmount: lineCredit(line.unitCost, line.baseQuantity, currency) }
}

/** A return names the lot (and the hide) of tracked goods: they leave the stock by it. */
export function returnLineProblems(kind: ClaimKind, lines: readonly ResolvedLine[]): Issue[] {
  if (kind !== 'RETURN') return []
  return lines.flatMap((line) => {
    if (line.item.tracking !== 'NONE' && line.lotId === null) return [{ path: `${line.at}/lotId`, message: `${line.item.code} is tracked by ${line.item.tracking.toLowerCase()}: name the lot that goes back.` }]
    if (line.item.tracking === 'HIDE' && line.hideId === null) return [{ path: `${line.at}/hideId`, message: `${line.item.code} is tracked by the hide: name the hide that goes back (one line each).` }]
    return []
  })
}

// ---- lines made from a receipt's discrepancies or from a lot ------------------------------------------------------------

/** One line per discrepancy (of one receipt). */
export async function linesFromDiscrepancies(db: Reader, discrepancyIds: readonly string[], path = 'body/from/discrepancyIds'): Promise<LineInput[]> {
  const ids = [...new Set(discrepancyIds)]
  const rows = await db.receiptDiscrepancy.findMany({ where: { id: { in: ids.filter(isUuid) } }, select: { id: true, receiptId: true }, orderBy: { seq: 'asc' } })
  const missing = ids.findIndex((id) => !rows.some((row) => row.id === id))
  if (missing !== -1) throw refuse([{ path: `${path}/${missing}`, message: 'Not a discrepancy of a receipt you can see.' }])
  if (new Set(rows.map((row) => row.receiptId)).size > 1) throw refuse([{ path, message: 'The discrepancies are of different receipts: make one claim per receipt.' }])
  return rows.map((row) => ({ discrepancyId: row.id }))
}

/**
 * The lot's goods at its site: every hide of it in stock (or the hides named), one line each, from where it lies; a lot
 * not tracked by the hide, one line per place that holds it.
 */
export async function linesFromLot(db: Reader, lotId: string, hideIds: readonly string[] | undefined, path = 'body/from'): Promise<LineInput[]> {
  const lot = isUuid(lotId) ? await db.lot.findUnique({ where: { id: lotId }, select: { id: true, code: true, siteId: true, itemId: true, item: { select: { tracking: true } } } }) : null
  if (!lot) throw refuse([{ path: `${path}/lotId`, message: 'Not a lot you can see.' }])
  const held = await readSiteStock(db, lot.siteId, { itemIds: [lot.itemId], lotId: lot.id })
  if (lot.item.tracking === 'HIDE') {
    const byHide = new Map<string, { locationId: string; onHand: string }[]>()
    for (const balance of held) {
      if (!balance.hideId) continue
      byHide.set(balance.hideId, [...(byHide.get(balance.hideId) ?? []), { locationId: balance.locationId, onHand: quantityText(balance.onHand) }])
    }
    const wanted = hideIds && hideIds.length > 0 ? [...new Set(hideIds)] : [...byHide.keys()]
    const lines: LineInput[] = []
    for (const [index, hideId] of wanted.entries()) {
      const places = byHide.get(hideId)
      if (!places) throw refuse([{ path: `${path}/hideIds/${index}`, message: `Not a hide of lot ${lot.code} in stock at its site.` }])
      for (const place of places) lines.push({ lotId: lot.id, hideId, quantity: place.onHand, fromLocationId: place.locationId })
    }
    if (lines.length === 0) throw refuse([{ path: `${path}/lotId`, message: `Lot ${lot.code} has no hide in stock at its site.` }])
    return lines
  }
  if (hideIds && hideIds.length > 0) throw refuse([{ path: `${path}/hideIds`, message: `Lot ${lot.code} is not tracked by the hide.` }])
  const places = held.filter((balance) => balance.hideId === null)
  if (places.length === 0) throw refuse([{ path: `${path}/lotId`, message: `Lot ${lot.code} holds nothing at its site.` }])
  return places.map((place) => ({ lotId: lot.id, quantity: quantityText(place.onHand), fromLocationId: place.locationId }))
}
