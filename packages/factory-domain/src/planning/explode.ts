import type { Decimal } from 'decimal.js'
import type { BusinessDate } from '../core/time'
import type { BomLineData } from '../product/bom/rules'
import { colourIn, exactRequirements, netQuantity } from '../product/bom/requirements'
import { baseFactor, decimalOf, QUANTITY_SCALE, roundTo, type ItemUnits, type Uom } from '../product/units/units'
import { NO_SUPPLY_RULES, suggestionFor, type SupplyRulesOf } from './buy'
import { netMaterial, type LotFacts, type OpenPurchase, type StockEntry } from './netting'

/**
 * One planning run of a site, pure (PLN-062, PLN-063, PLN-064, PLN-065, PLN-066; design 02 "What to buy & make"):
 * explode the open orders through their BOMs per size and colour, take off what their work orders already hold, net
 * against usable stock and open purchase orders (./netting), and suggest what to buy or make (./buy).
 *
 * Demand. Every size-grid line (and made-to-measure unit) of a CONFIRMED or IN_PRODUCTION order planned at the site is
 * exploded through ONE revision: the line's own (the order fixes it), else the style's RELEASED one; a line with
 * neither is not planned (warning NO_RELEASED_BOM). Per garment of each size in the line's colourway the BOM math is the
 * product module's (product/bom/requirements `exactRequirements`: quantity per size × (1 + wastage), in each material's
 * base unit, exact); times the pieces, rounded UP to four decimals once per order line and size (never plan less).
 *
 * Work orders (W1-23). A work order makes cells (colourway × size) of order lines:
 *   - COMPLETED or CLOSED: its pieces are made; they need nothing more (taken off the pieces);
 *   - DRAFT, RELEASED or IN_PROGRESS: its pieces still count, but what was already ISSUED to it (the ledger's net
 *     issues, less returns, per material and colour) has left stock: it is shared out over the work order's cells
 *     (oldest due first, each up to what the cell needs) and taken off those cells' need, so issued material is never
 *     counted twice (once gone from stock, once still needed). More issued than the cells need stays with the work
 *     order and helps no other order;
 *   - CANCELLED: ignored (its order lines are demand again).
 * So the stored gross quantity is what the orders still need to be issued; each source (MaterialRequirement.sources)
 * keeps the split: the quantity for its pieces and what is already issued.
 *
 * Make or buy. An item sourced MAKE is a MAKE line (a part we make; W1 has no BOM per item, so it is not exploded
 * further); BUY a BUY line; MAKE_OR_BUY a BUY line when a supplier is known, else MAKE. The supplier: the one every
 * contributing BOM line names (its own, else the item's default); when they differ, the item's default (warning).
 */

export const PLANNED_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION'] as const
// W2a wave 5 (factory-db production.prisma): ON_HOLD.
export const WORK_ORDER_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED', 'ON_HOLD'] as const
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number]
/** Work orders whose pieces are made: they need nothing more. */
export const MADE_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['COMPLETED', 'CLOSED'])
/** Work orders that still need material: what was issued to them is taken off their cells. */
// W2a wave 5: a held work order still needs its material (the hold is lifted back to where it was).
export const OPEN_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'])

export const ITEM_SOURCINGS = ['BUY', 'MAKE', 'MAKE_OR_BUY'] as const
export type ItemSourcing = (typeof ITEM_SOURCINGS)[number]
export const REQUIREMENT_ACTIONS = ['BUY', 'MAKE'] as const
export type RequirementAction = (typeof REQUIREMENT_ACTIONS)[number]

/** An order line to plan, as the store reads it. */
export interface PlanOrderLine {
  readonly orderId: string
  readonly orderNumber: string
  readonly orderLineId: string
  readonly lineSeq: number
  readonly styleId: string
  readonly colourwayId: string
  /** The revision to explode: the line's own, else the style's RELEASED one; null: none. */
  readonly revisionId: string | null
  /** The pieces per size (a made-to-measure unit: its base size, 1 piece); empty: nothing to plan (warning). */
  readonly sizes: readonly { readonly size: string; readonly pieces: number }[]
  /** The day it is due: the line's promise date, else its requested date, else the order's; null: none. */
  readonly dueDate: BusinessDate | null
}

export interface PlanRevision {
  readonly id: string
  readonly lines: readonly BomLineData[]
}

export interface PlanItem {
  readonly id: string
  readonly code: string
  readonly sourcing: ItemSourcing
  readonly units: ItemUnits
  readonly defaultSupplierId: string | null
}

/** One cell of a work order that makes an order line of the plan. */
export interface PlanWorkOrderCell {
  readonly workOrderId: string
  readonly workOrderNumber: string
  readonly status: WorkOrderStatus
  readonly orderLineId: string
  readonly size: string
  readonly pieces: number
}

/** What the ledger issued to a work order, net of returns, per material and colour (base unit). */
export interface WorkOrderIssue {
  readonly workOrderId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly quantity: string
}

/** The site's stock of a material, per colour and lot. */
export interface PlanStock extends StockEntry {
  readonly itemId: string
}

/** An open purchase line of the site. */
export interface PlanPurchase extends OpenPurchase {
  readonly itemId: string
  readonly itemColourId: string | null
}

export const WARNING_CODES = [
  /** An order line of the company with no making site while the company has several plants (the store finds it). */
  'NO_SITE',
  'NO_RELEASED_BOM',
  'NO_SIZE',
  'NO_DATE',
  'SIZE_NOT_IN_BOM',
  'COLOURWAY_NOT_IN_BOM',
  'UNCONVERTIBLE_UNIT',
  'SEVERAL_SUPPLIERS',
] as const
export type WarningCode = (typeof WARNING_CODES)[number]

/** Something the run could not plan, or planned on an assumption, in words (PlanningRun.warnings: the lead's schema step). */
export interface PlanWarning {
  readonly code: WarningCode
  readonly message: string
  readonly orderId?: string
  readonly orderLineId?: string
  readonly itemId?: string
  readonly size?: string
}

/** The demand behind a requirement: one order line in one size (MaterialRequirement.sources, decimals as strings). */
export interface RequirementSource {
  readonly orderId: string
  readonly orderNumber: string
  readonly orderLineId: string
  readonly lineSeq: number
  readonly size: string
  /** Pieces still to make (made pieces of finished work orders left out). */
  readonly pieces: number
  /** Pieces finished work orders already made. */
  readonly made: number
  /** What the pieces take, base unit, four decimals (rounded up). */
  readonly quantity: string
  /** Of it, already issued to their open work orders. */
  readonly issued: string
  readonly dueDate: BusinessDate | null
  /** The open work orders making these pieces (numbers). */
  readonly workOrders: readonly string[]
}

export interface PlannedRequirement {
  readonly seq: number
  readonly itemId: string
  readonly itemColourId: string | null
  readonly action: RequirementAction
  readonly uom: Uom
  readonly grossQuantity: string
  readonly usableStock: string
  readonly heldStock: string
  readonly onOrder: string
  readonly netQuantity: string
  readonly suggestedQuantity: string
  readonly suggestedUom: Uom
  readonly needDate: BusinessDate
  readonly supplierId: string | null
  readonly sources: readonly RequirementSource[]
}

export interface PlanResult {
  /** Order lines exploded. */
  readonly orderLines: number
  readonly requirements: readonly PlannedRequirement[]
  readonly warnings: readonly PlanWarning[]
}

export interface PlanInput {
  readonly runDate: BusinessDate
  readonly orderLines: readonly PlanOrderLine[]
  readonly revisions: readonly PlanRevision[]
  readonly items: readonly PlanItem[]
  readonly workOrderCells: readonly PlanWorkOrderCell[]
  readonly workOrderIssues: readonly WorkOrderIssue[]
  readonly stock: readonly PlanStock[]
  readonly lots: readonly LotFacts[]
  readonly purchases: readonly PlanPurchase[]
  /** The supplier's terms (lead time, minimum, multiple): ./buy SupplyRulesOf. */
  readonly supplyRulesOf?: SupplyRulesOf
}

const UP = { scale: QUANTITY_SCALE, rounding: 'UP' } as const
const ZERO = decimalOf('0')
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const materialKey = (itemId: string, itemColourId: string | null): string => `${itemId}|${itemColourId ?? '-'}`
const cellKey = (orderLineId: string, size: string): string => `${orderLineId}|${size}`

/** Per garment of one size in one colourway: each material colour with its exact base quantity and BOM lines. */
interface PerPiece {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly quantity: Decimal
  readonly lineIds: readonly string[]
}

interface SourceDraft {
  readonly line: PlanOrderLine
  readonly size: string
  readonly sizeIndex: number
  readonly ordered: number
  made: number
  readonly perPiece: readonly PerPiece[]
  readonly openCells: PlanWorkOrderCell[]
}

const compareSources = (a: SourceDraft, b: SourceDraft): number => {
  const da = a.line.dueDate ?? '9999-12-31'
  const db = b.line.dueDate ?? '9999-12-31'
  if (da !== db) return da < db ? -1 : 1
  if (a.line.orderNumber !== b.line.orderNumber) return a.line.orderNumber < b.line.orderNumber ? -1 : 1
  return a.line.lineSeq - b.line.lineSeq || a.sizeIndex - b.sizeIndex
}

/** The whole run: requirements in their list order (BUY first, then by item code and colour), with the warnings. */
export function planRequirements(input: PlanInput): PlanResult {
  const warnings: PlanWarning[] = []
  const seen = new Set<string>()
  const warn = (warning: PlanWarning) => {
    const key = [warning.code, warning.orderLineId ?? '', warning.itemId ?? '', warning.size ?? ''].join('|')
    if (seen.has(key)) return
    seen.add(key)
    warnings.push(warning)
  }
  const revisions = new Map(input.revisions.map((revision) => [revision.id, revision]))
  const items = new Map(input.items.map((item) => [item.id, item]))
  const unitsOf = (itemId: string): ItemUnits | undefined => items.get(itemId)?.units
  const supplyRulesOf = input.supplyRulesOf ?? (() => NO_SUPPLY_RULES)

  // ---- demand: each order line and size, per garment ----------------------------------------------------------------
  const drafts: SourceDraft[] = []
  const draftOf = new Map<string, SourceDraft>()
  const bomLineSupplier = new Map<string, string | null>()
  let planned = 0
  for (const line of input.orderLines) {
    const label = `${line.orderNumber} line ${line.lineSeq}`
    const revision = line.revisionId ? revisions.get(line.revisionId) : undefined
    if (!revision) {
      warn({ code: 'NO_RELEASED_BOM', message: `${label} is not planned: its style has no released BOM.`, orderId: line.orderId, orderLineId: line.orderLineId })
      continue
    }
    const sizes = line.sizes.filter((row) => row.pieces > 0)
    if (sizes.length === 0) {
      warn({ code: 'NO_SIZE', message: `${label} is not planned: it has no size to make (a made-to-measure unit needs its base size).`, orderId: line.orderId, orderLineId: line.orderLineId })
      continue
    }
    planned++
    if (line.dueDate === null) warn({ code: 'NO_DATE', message: `${label} has no date: its material is planned as needed today.`, orderId: line.orderId, orderLineId: line.orderLineId })
    for (const bomLine of revision.lines) bomLineSupplier.set(bomLine.id, bomLine.supplierId)
    sizes.forEach((row, sizeIndex) => {
      for (const bomLine of revision.lines) {
        if (bomLine.colourwayId !== null && bomLine.colourwayId !== line.colourwayId) continue
        const units = unitsOf(bomLine.itemId)
        const code = items.get(bomLine.itemId)?.code ?? 'a material'
        if (colourIn(bomLine, line.colourwayId) === undefined) {
          warn({ code: 'COLOURWAY_NOT_IN_BOM', message: `${label}: BOM line ${bomLine.seq} (${code}) names no colour for this colourway; it is not planned.`, orderLineId: line.orderLineId, itemId: bomLine.itemId })
        } else if (netQuantity(bomLine, row.size) === null) {
          warn({ code: 'SIZE_NOT_IN_BOM', message: `${label}: size ${row.size} has no quantity on BOM line ${bomLine.seq} (${code}); it is not planned.`, orderLineId: line.orderLineId, itemId: bomLine.itemId, size: row.size })
        } else if (!units || baseFactor(bomLine.uom, units) === null) {
          warn({ code: 'UNCONVERTIBLE_UNIT', message: `${label}: BOM line ${bomLine.seq} (${code}) is in a unit its material does not convert; it is not planned.`, orderLineId: line.orderLineId, itemId: bomLine.itemId })
        }
      }
      const perPiece = exactRequirements(revision.lines, { sizes: [row.size], colourwayIds: [line.colourwayId] }, unitsOf).map((need) => ({
        itemId: need.itemId,
        itemColourId: need.itemColourId,
        quantity: need.quantity,
        lineIds: need.lineIds,
      }))
      const draft: SourceDraft = { line, size: row.size, sizeIndex, ordered: row.pieces, made: 0, perPiece, openCells: [] }
      drafts.push(draft)
      draftOf.set(cellKey(line.orderLineId, row.size), draft)
    })
  }

  // ---- work orders: made pieces, and what open ones already hold ----------------------------------------------------
  for (const cell of input.workOrderCells) {
    const draft = draftOf.get(cellKey(cell.orderLineId, cell.size))
    if (!draft) continue
    if (MADE_WORK_ORDER_STATUSES.includes(cell.status)) draft.made = Math.min(draft.ordered, draft.made + cell.pieces)
    else if (OPEN_WORK_ORDER_STATUSES.includes(cell.status)) draft.openCells.push(cell)
  }
  const piecesOf = (draft: SourceDraft): number => Math.max(0, draft.ordered - draft.made)
  const needOf = (draft: SourceDraft, key: string, pieces: number): Decimal => {
    const per = draft.perPiece.find((entry) => materialKey(entry.itemId, entry.itemColourId) === key)
    return per ? roundTo(per.quantity.times(pieces), UP) : ZERO
  }
  /** Issued material shared out per order line, size and material: cellKey|materialKey → quantity. */
  const issuedTo = new Map<string, Decimal>()
  const issuesByWorkOrder = new Map<string, WorkOrderIssue[]>()
  for (const issue of input.workOrderIssues) issuesByWorkOrder.set(issue.workOrderId, [...(issuesByWorkOrder.get(issue.workOrderId) ?? []), issue])
  const cellsByWorkOrder = new Map<string, SourceDraft[]>()
  for (const draft of [...drafts].sort(compareSources)) {
    for (const cell of draft.openCells) cellsByWorkOrder.set(cell.workOrderId, [...new Set([...(cellsByWorkOrder.get(cell.workOrderId) ?? []), draft])])
  }
  for (const [workOrderId, cells] of cellsByWorkOrder) {
    for (const issue of issuesByWorkOrder.get(workOrderId) ?? []) {
      const key = materialKey(issue.itemId, issue.itemColourId)
      let left = decimalOf(issue.quantity)
      for (const draft of cells) {
        if (left.lte(0)) break
        const pieces = Math.min(
          piecesOf(draft),
          draft.openCells.filter((cell) => cell.workOrderId === workOrderId).reduce((sum, cell) => sum + cell.pieces, 0),
        )
        const slot = `${cellKey(draft.line.orderLineId, draft.size)}|${key}`
        const room = needOf(draft, key, pieces).minus(issuedTo.get(slot) ?? ZERO)
        if (room.lte(0)) continue
        const take = left.lt(room) ? left : room
        issuedTo.set(slot, (issuedTo.get(slot) ?? ZERO).plus(take))
        left = left.minus(take)
      }
    }
  }

  // ---- per material and colour: the sources ------------------------------------------------------------------------
  interface Material {
    readonly itemId: string
    readonly itemColourId: string | null
    readonly sources: RequirementSource[]
    readonly suppliers: Set<string | null>
  }
  const materials = new Map<string, Material>()
  for (const draft of [...drafts].sort(compareSources)) {
    const pieces = piecesOf(draft)
    if (pieces === 0) continue
    for (const per of draft.perPiece) {
      const key = materialKey(per.itemId, per.itemColourId)
      const quantity = needOf(draft, key, pieces)
      if (quantity.isZero()) continue
      const issued = issuedTo.get(`${cellKey(draft.line.orderLineId, draft.size)}|${key}`) ?? ZERO
      const material = materials.get(key) ?? { itemId: per.itemId, itemColourId: per.itemColourId, sources: [], suppliers: new Set<string | null>() }
      material.sources.push({
        orderId: draft.line.orderId,
        orderNumber: draft.line.orderNumber,
        orderLineId: draft.line.orderLineId,
        lineSeq: draft.line.lineSeq,
        size: draft.size,
        pieces,
        made: draft.made,
        quantity: q(quantity),
        issued: q(issued.gt(quantity) ? quantity : issued),
        dueDate: draft.line.dueDate,
        workOrders: [...new Set(draft.openCells.map((cell) => cell.workOrderNumber))].sort(),
      })
      const item = items.get(per.itemId)
      for (const lineId of per.lineIds) material.suppliers.add(bomLineSupplier.get(lineId) ?? item?.defaultSupplierId ?? null)
      materials.set(key, material)
    }
  }

  // ---- netting and suggestion -----------------------------------------------------------------------------------------
  const lots = new Map(input.lots.map((lot) => [lot.id, lot]))
  const rows: Omit<PlannedRequirement, 'seq'>[] = []
  for (const material of materials.values()) {
    const item = items.get(material.itemId)
    if (!item) continue
    const demands = material.sources.map((source) => ({ dueDate: source.dueDate, quantity: decimalOf(source.quantity).minus(decimalOf(source.issued)) }))
    if (demands.every((demand) => demand.quantity.lte(0))) continue
    const netting = netMaterial({
      itemColourId: material.itemColourId,
      demands,
      stock: input.stock.filter((entry) => entry.itemId === material.itemId),
      lotOf: (lotId) => lots.get(lotId),
      purchases: input.purchases.filter((line) => line.itemId === material.itemId && line.itemColourId === material.itemColourId),
      runDate: input.runDate,
    })
    const named = [...material.suppliers].filter((supplier): supplier is string => supplier !== null)
    let supplierId: string | null = named.length === 1 && !material.suppliers.has(null) ? named[0]! : (item.defaultSupplierId ?? named[0] ?? null)
    if (new Set(named).size > 1) {
      warn({ code: 'SEVERAL_SUPPLIERS', message: `${item.code}: the BOM lines name different suppliers; the plan suggests the material's default.`, itemId: item.id })
      supplierId = item.defaultSupplierId ?? null
    }
    const action: RequirementAction = item.sourcing === 'MAKE' || (item.sourcing === 'MAKE_OR_BUY' && supplierId === null) ? 'MAKE' : 'BUY'
    if (action === 'MAKE') supplierId = null
    const suggestion = suggestionFor(netting.net, action, item.units, action === 'BUY' ? supplyRulesOf(item.id, supplierId) : NO_SUPPLY_RULES)
    rows.push({
      itemId: material.itemId,
      itemColourId: material.itemColourId,
      action,
      uom: item.units.baseUom,
      grossQuantity: netting.gross,
      usableStock: netting.usable,
      heldStock: netting.held,
      onOrder: netting.onOrder,
      netQuantity: netting.net,
      suggestedQuantity: suggestion.quantity,
      suggestedUom: suggestion.uom,
      needDate: netting.needDate,
      supplierId,
      sources: material.sources,
    })
  }
  const codeOf = (itemId: string) => items.get(itemId)?.code ?? ''
  rows.sort((a, b) =>
    a.action !== b.action
      ? a.action === 'BUY'
        ? -1
        : 1
      : codeOf(a.itemId) !== codeOf(b.itemId)
        ? codeOf(a.itemId) < codeOf(b.itemId)
          ? -1
          : 1
        : (a.itemColourId ?? '') < (b.itemColourId ?? '')
          ? -1
          : (a.itemColourId ?? '') > (b.itemColourId ?? '')
            ? 1
            : 0,
  )
  return { orderLines: planned, requirements: rows.map((row, index) => ({ seq: index + 1, ...row })), warnings }
}
