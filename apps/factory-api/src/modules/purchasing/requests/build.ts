import type { Prisma } from '@nexus/factory-db'
import { arrivalDate, leadTimeWindow, orderByDate } from '@nexus/factory-domain/calendars/suppliers'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { readDecisionNote, type SetAsideReason } from '@nexus/factory-domain/planning/decisions'
import { addDays, suggestionFor, supplyRulesFor, type RoundingStep } from '@nexus/factory-domain/planning/buy'
import { whyLine } from '@nexus/factory-domain/planning/explain'
import { usabilityOf } from '@nexus/factory-domain/planning/usable'
import type { PartyRole, PartyStatus } from '@nexus/factory-domain/parties/rules'
import { decimalOf, QUANTITY_SCALE, toBase, type Uom } from '@nexus/factory-domain/product/units/units'
import { defaultUnitPrice, estimatedHidesOf, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import {
  holdOf,
  reorderNeedOf,
  reorderWhy,
  requestIdOf,
  WARNING_WORDS,
  type LotStep,
  type ReorderMethod,
  type ReorderNeed,
  type RequestHold,
  type RequestKind,
  type RequestStatus,
  type RequestWarningCode,
  type StockPosition,
} from '@nexus/factory-domain/purchasing/requests/requests'
import { approvedSupplierIds, buyFromSource, isApproved, priceIn, sourceFor, sourceRules, unitsBoughtIn, type Need, type SourceFacts } from '@nexus/factory-domain/purchasing/sources/sources'
import { supplierCalendarsFor, type LoadedSupplierCalendar } from '../../../platform/calendars/service'
import { lotFactsOf, readLots, readPurchases, readStock, type PurchaseRead } from '../../planning/store'
import { sourcesOf } from '../../planning/views'
import { dayOf, decimal, ITEM_COLUMNS, quantityText, unitsOf, type Reader } from '../store'
import { activeSourcesOf } from '../supplier-items/store'

/**
 * What each request to buy proposes (B-W2a-10; SCM-034, SCM-036; factory-domain purchasing/requests): one function for
 * the queue, the "Draft POs" pop-up and the conversion, so the three never disagree.
 *
 *   supplier   the one chosen (a request of the conversion, or the plan's Draft PO), else a firm planned order's, else
 *              the site's preferred supplier (ItemPlanning: its colour's row, else every colour's), else the best
 *              approved source, else the plan line's (the material's default supplier).
 *   quantity   a firm planned order's, as the planner fixed it; else from the net need (the plan line's, or the reorder
 *              rule's) in the chosen supplier's source unit after its minimum and steps; without a source the plan's own
 *              suggestion (the material's terms), or for a reorder row the material's terms.
 *   price      the source's (in the supplier's currency, moved to the line's unit), else the material's standard purchase
 *              price; a cost.
 *   dates      a plan row is needed by its need date (a firm order's date); its day to order by is that date less the
 *              site's safety days and the lead time (the site's, else the source's, else the supplier's), counted back
 *              around the supplier's closed days (platform/calendars). A reorder row is ordered today and needed when the
 *              goods can come: today plus the lead time, the closed days not counted.
 *
 * Reads only (a scoped client or a command's tx); no money leaves here without the cost grain (the view's marked fields).
 */

const REQUIREMENT_COLUMNS = {
  id: true,
  runId: true,
  siteId: true,
  version: true,
  action: true,
  itemId: true,
  itemColourId: true,
  uom: true,
  grossQuantity: true,
  usableStock: true,
  heldStock: true,
  onOrder: true,
  netQuantity: true,
  suggestedQuantity: true,
  suggestedUom: true,
  needDate: true,
  supplierId: true,
  sources: true,
  decision: true,
  decisionNote: true,
  purchaseOrderLineId: true,
  decidedAt: true,
  firmQuantity: true,
  firmBaseQuantity: true,
  firmDate: true,
  firmSupplierId: true,
} as const satisfies Prisma.MaterialRequirementSelect
type RequirementRow = Prisma.MaterialRequirementGetPayload<{ select: typeof REQUIREMENT_COLUMNS }>

const RUN_COLUMNS = { id: true, companyId: true, siteId: true, status: true, trigger: true, startedAt: true, finishedAt: true } as const satisfies Prisma.PlanningRunSelect
type RunRow = Prisma.PlanningRunGetPayload<{ select: typeof RUN_COLUMNS }>

const RULE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  method: true,
  source: true,
  supplierId: true,
  buyLeadTimeDays: true,
  safetyLeadTimeDays: true,
  reorderPoint: true,
  lotSize: true,
  minStock: true,
  maxStock: true,
  minOrderQty: true,
  orderMultiple: true,
  maxOrderQty: true,
  note: true,
  version: true,
} as const satisfies Prisma.ItemPlanningSelect
type RuleRow = Prisma.ItemPlanningGetPayload<{ select: typeof RULE_COLUMNS }>

const SUPPLIER_COLUMNS = { id: true, companyId: true, code: true, legalName: true, tradeName: true, roles: true, status: true, currency: true, leadTimeDays: true } as const satisfies Prisma.PartySelect
type SupplierRow = Prisma.PartyGetPayload<{ select: typeof SUPPLIER_COLUMNS }>

const MATERIAL_COLUMNS = { ...ITEM_COLUMNS, sourcing: true } as const satisfies Prisma.ItemSelect
type MaterialRow = Prisma.ItemGetPayload<{ select: typeof MATERIAL_COLUMNS }>

/** A request of the conversion, or the plan's Draft PO: the supplier the buyer chose for it. */
export interface Choice {
  readonly supplierId?: string | null | undefined
}

export type SupplierFrom = 'CHOSEN' | 'FIRM' | 'SITE' | 'SOURCE' | 'DEFAULT'
export type QuantityFrom = 'FIRM' | 'SOURCE' | 'PLAN' | 'ITEM'

export interface PlanPart {
  readonly runId: string
  readonly runStatus: string
  readonly runStartedAt: Date
  readonly trigger: string
  readonly row: RequirementRow
  readonly firm: boolean
  readonly setAside: { readonly reason: SetAsideReason; readonly note: string | null } | null
  readonly purchaseOrder: { readonly id: string; readonly number: string; readonly status: PurchaseOrderStatus } | null
  /** The sales orders behind it (their numbers as they are now) and the work orders the run counted. */
  readonly orders: readonly { readonly id: string; readonly number: string }[]
  readonly workOrders: readonly string[]
}

export interface ReorderPart {
  readonly rule: RuleRow
  readonly method: ReorderMethod
  readonly stock: { readonly usable: string; readonly onOrder: string; readonly reserved: string }
  readonly need: ReorderNeed
  readonly why: string
  readonly onOrderLines: readonly { readonly purchaseOrderId: string; readonly number: string; readonly status: string; readonly openQuantity: string }[]
}

/** One request, decided: what it proposes and why it may or may not be drafted now. */
export interface Built {
  readonly id: string
  readonly kind: RequestKind
  readonly refId: string
  readonly version: number
  readonly companyId: string
  readonly siteId: string
  readonly site: { readonly code: string; readonly name: string }
  readonly status: RequestStatus
  readonly convertedOn: BusinessDate | null
  readonly item: MaterialRow
  readonly colour: { readonly id: string; readonly code: string; readonly name: string; readonly supplierColourCode: string | null } | null
  readonly needDate: BusinessDate
  readonly orderBy: { readonly date: BusinessDate; readonly leadTimeDays: number | null; readonly passed: boolean; readonly closedDaysSkipped: number }
  readonly supplier: SupplierRow | null
  readonly supplierFrom: SupplierFrom | null
  readonly source: SourceFacts | null
  readonly approvedSupplierIds: readonly string[]
  readonly quantity: string
  readonly uom: Uom
  readonly baseQuantity: string
  readonly estimatedHides: number | null
  readonly quantityFrom: QuantityFrom
  readonly rounding: readonly (RoundingStep | LotStep)[]
  /** The supplier's currency (the order's); null without a supplier. */
  readonly currency: string | null
  /** Per `uom`, in `currency`; null: none on record. A cost. */
  readonly unitPrice: string | null
  readonly supplierArticleCode: string | null
  readonly supplierColourCode: string | null
  readonly hold: RequestHold | null
  readonly warnings: readonly { readonly code: RequestWarningCode; readonly message: string }[]
  readonly plan: PlanPart | null
  readonly reorder: ReorderPart | null
}

// ---- reading the raw rows ---------------------------------------------------------------------------------------------

interface RawPlan {
  readonly kind: 'PLAN'
  readonly run: RunRow
  readonly row: RequirementRow
}
interface RawReorder {
  readonly kind: 'REORDER'
  readonly rule: RuleRow
}
type Raw = RawPlan | RawReorder

/** Plan lines: of these runs (the queue: the sites' latest DONE runs), or whatever their run (a conversion, a Draft PO). */
export async function planRaws(db: Reader, runs: readonly RunRow[] | null, where: Prisma.MaterialRequirementWhereInput): Promise<RawPlan[]> {
  const rows = await db.materialRequirement.findMany({
    where: { AND: [where, runs ? { runId: { in: runs.map((run) => run.id) } } : {}] },
    select: REQUIREMENT_COLUMNS,
    orderBy: [{ runId: 'asc' }, { seq: 'asc' }],
  })
  const runIds = [...new Set(rows.map((row) => row.runId))]
  const known = runs ?? (runIds.length === 0 ? [] : await db.planningRun.findMany({ where: { id: { in: runIds } }, select: RUN_COLUMNS }))
  const runOf = new Map(known.map((run) => [run.id, run]))
  return rows.map((row) => ({ kind: 'PLAN', run: runOf.get(row.runId)!, row }))
}

/** The latest DONE run of each site (one per site). */
export const latestRuns = (db: Reader, siteId?: string): Promise<RunRow[]> =>
  db.planningRun.findMany({ where: { status: 'DONE', ...(siteId ? { siteId } : {}) }, select: RUN_COLUMNS, orderBy: { siteId: 'asc' } })

/** The reorder-point and min/max rules of bought items (every rule, or these). */
export async function reorderRaws(db: Reader, where: Prisma.ItemPlanningWhereInput): Promise<RawReorder[]> {
  const rules = await db.itemPlanning.findMany({ where: { AND: [where, { method: { in: ['REORDER_POINT', 'MIN_MAX'] } }, { OR: [{ source: 'BUY' }, { source: null }] }] }, select: RULE_COLUMNS, orderBy: { id: 'asc' } })
  return rules.map((rule) => ({ kind: 'REORDER', rule }))
}

// ---- stock positions ----------------------------------------------------------------------------------------------------

type Dec = ReturnType<typeof decimalOf>

interface SiteStock {
  readonly usable: Map<string, Dec>
  readonly purchases: PurchaseRead[]
  readonly reserved: { readonly itemId: string; readonly itemColourId: string | null; readonly open: Dec }[]
}

const keyOf = (itemId: string, colourId: string | null): string => `${itemId}|${colourId ?? '-'}`

/** Usable stock, open purchase lines and open reservations of these items at one site. */
async function siteStock(db: Reader, siteId: string, itemIds: readonly string[]): Promise<SiteStock> {
  const stock = await readStock(db, siteId, itemIds)
  const lots = new Map((await readLots(db, stock.flatMap((entry) => (entry.lotId ? [entry.lotId] : [])))).map((lot) => [lot.id, lot]))
  const usable = new Map<string, Dec>()
  for (const entry of stock) {
    const lot = entry.lotId ? lots.get(entry.lotId) : null
    if (!usabilityOf(lot ? lotFactsOf(lot) : null).usable) continue
    const key = keyOf(entry.itemId, entry.itemColourId)
    usable.set(key, (usable.get(key) ?? decimalOf('0')).plus(decimalOf(String(entry.quantity))))
  }
  const purchases = await readPurchases(db, siteId, itemIds)
  const reservations = await db.reservation.findMany({ where: { siteId, itemId: { in: [...itemIds] }, status: 'ACTIVE' }, select: { itemId: true, itemColourId: true, quantity: true, issuedQuantity: true } })
  const reserved = reservations.map((row) => {
    const open = decimalOf(row.quantity.toString()).minus(decimalOf(row.issuedQuantity.toString()))
    return { itemId: row.itemId, itemColourId: row.itemColourId, open: open.isNegative() ? decimalOf('0') : open }
  })
  return { usable, purchases, reserved }
}

/** A rule's position: its colour's stock, or every colour's for a rule of every colour. */
function positionFor(rule: RuleRow, stock: SiteStock): { position: StockPosition; lines: ReorderPart['onOrderLines'] } {
  const reaches = (colourId: string | null) => rule.itemColourId === null || colourId === rule.itemColourId
  let usable = decimalOf('0')
  for (const [key, quantity] of stock.usable) {
    const [itemId, colour] = key.split('|') as [string, string]
    if (itemId === rule.itemId && reaches(colour === '-' ? null : colour)) usable = usable.plus(quantity)
  }
  const purchases = stock.purchases.filter((line) => line.itemId === rule.itemId && reaches(line.itemColourId) && decimalOf(String(line.openQuantity)).gt(0))
  const onOrder = purchases.reduce((sum, line) => sum.plus(decimalOf(String(line.openQuantity))), decimalOf('0'))
  const reserved = stock.reserved.filter((row) => row.itemId === rule.itemId && reaches(row.itemColourId)).reduce((sum, row) => sum.plus(row.open), decimalOf('0'))
  const q = (value: Dec) => value.toFixed(QUANTITY_SCALE)
  return {
    position: { usable: q(usable), onOrder: q(onOrder), reserved: q(reserved) },
    lines: purchases.map((line) => ({ purchaseOrderId: line.purchaseOrderId, number: line.purchaseOrderNumber, status: line.purchaseOrderStatus, openQuantity: q(decimalOf(String(line.openQuantity))) })),
  }
}

// ---- the facts ------------------------------------------------------------------------------------------------------------

interface Facts {
  readonly items: Map<string, MaterialRow>
  readonly colours: Map<string, { id: string; code: string; name: string; supplierColourCode: string | null }>
  readonly sites: Map<string, { id: string; companyId: string; code: string; name: string }>
  readonly rules: RuleRow[]
  readonly sources: SourceFacts[]
}

async function factsFor(db: Reader, raws: readonly Raw[], extraRules: readonly RuleRow[]): Promise<Facts> {
  const itemIds = [...new Set(raws.map((raw) => (raw.kind === 'PLAN' ? raw.row.itemId : raw.rule.itemId)))]
  const siteIds = [...new Set(raws.map((raw) => (raw.kind === 'PLAN' ? raw.row.siteId : raw.rule.siteId)))]
  const colourIds = [...new Set(raws.flatMap((raw) => { const id = raw.kind === 'PLAN' ? raw.row.itemColourId : raw.rule.itemColourId; return id ? [id] : [] }))]
  const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: MATERIAL_COLUMNS })
  const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true, supplierColourCode: true } })
  const sites = siteIds.length === 0 ? [] : await db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, companyId: true, code: true, name: true } })
  const rules = itemIds.length === 0 ? [] : await db.itemPlanning.findMany({ where: { siteId: { in: siteIds }, itemId: { in: itemIds } }, select: RULE_COLUMNS })
  const known = new Set(rules.map((rule) => rule.id))
  return {
    items: new Map(items.map((item) => [item.id, item])),
    colours: new Map(colours.map((colour) => [colour.id, colour])),
    sites: new Map(sites.map((site) => [site.id, site])),
    rules: [...rules, ...extraRules.filter((rule) => !known.has(rule.id))],
    sources: await activeSourcesOf(db, itemIds),
  }
}

/** The site's rule for an item and colour: the colour's own row, else every colour's. */
const siteRuleOf = (facts: Facts, siteId: string, itemId: string, colourId: string | null): RuleRow | null =>
  facts.rules.find((rule) => rule.siteId === siteId && rule.itemId === itemId && rule.itemColourId === colourId && colourId !== null) ??
  facts.rules.find((rule) => rule.siteId === siteId && rule.itemId === itemId && rule.itemColourId === null) ??
  null

/** Who the request buys from, and why that one (see the module comment). */
function supplierChoice(raw: Raw, facts: Facts, need: Need, siteId: string, choice: Choice): { id: string | null; from: SupplierFrom | null } {
  if (choice.supplierId) return { id: choice.supplierId, from: 'CHOSEN' }
  if (raw.kind === 'PLAN' && raw.row.firmQuantity !== null && raw.row.firmSupplierId) return { id: raw.row.firmSupplierId, from: 'FIRM' }
  const site = siteRuleOf(facts, siteId, need.itemId, need.itemColourId)?.supplierId
  if (site) return { id: site, from: 'SITE' }
  const best = sourceFor(facts.sources, need)?.partyId
  if (best) return { id: best, from: 'SOURCE' }
  const fallback = raw.kind === 'PLAN' ? raw.row.supplierId : facts.items.get(need.itemId)?.defaultSupplierId
  return fallback ? { id: fallback, from: 'DEFAULT' } : { id: null, from: null }
}

// ---- building -------------------------------------------------------------------------------------------------------------

export interface BuildOptions {
  readonly today: BusinessDate
  /** The supplier chosen per request id; none: the queue's own choice. */
  readonly choices?: ReadonlyMap<string, Choice>
  /** Only reorder rows that ask for an order now (the queue); a conversion builds every row it names. */
  readonly triggeredOnly: boolean
}

const stepsOf = (steps: readonly (RoundingStep | LotStep)[]): (RoundingStep | LotStep)[] => steps.map((step) => ({ rule: step.rule, quantity: step.quantity }) as RoundingStep | LotStep)

export async function buildRequests(db: Reader, raws: readonly Raw[], options: BuildOptions): Promise<Built[]> {
  const { today } = options
  // Reorder rows first need their positions: per site, its stock, open purchase lines and reservations.
  const reorderParts = new Map<string, { need: ReorderNeed; position: StockPosition; lines: ReorderPart['onOrderLines'] }>()
  const bySite = new Map<string, RawReorder[]>()
  for (const raw of raws) if (raw.kind === 'REORDER') bySite.set(raw.rule.siteId, [...(bySite.get(raw.rule.siteId) ?? []), raw])
  for (const [siteId, rules] of [...bySite.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const stock = await siteStock(db, siteId, [...new Set(rules.map((raw) => raw.rule.itemId))])
    for (const { rule } of rules) {
      const { position, lines } = positionFor(rule, stock)
      const need = reorderNeedOf({ method: rule.method as ReorderMethod, reorderPoint: decimal(rule.reorderPoint), lotSize: decimal(rule.lotSize), minStock: decimal(rule.minStock), maxStock: decimal(rule.maxStock), minOrderQty: decimal(rule.minOrderQty), orderMultiple: decimal(rule.orderMultiple), maxOrderQty: decimal(rule.maxOrderQty) }, position)
      if (need) reorderParts.set(rule.id, { need, position, lines })
    }
  }
  const kept = raws.filter((raw) => raw.kind === 'PLAN' || (reorderParts.has(raw.rule.id) && (!options.triggeredOnly || reorderParts.get(raw.rule.id)!.need.triggered)))
  const facts = await factsFor(db, kept, kept.flatMap((raw) => (raw.kind === 'REORDER' ? [raw.rule] : [])))
  // A made part is never bought: a rule with no source of its own follows the item's sourcing.
  const live = kept.filter((raw) => raw.kind === 'PLAN' || raw.rule.source === 'BUY' || facts.items.get(raw.rule.itemId)?.sourcing !== 'MAKE')

  const drafts = live.map((raw) => {
    const id = raw.kind === 'PLAN' ? requestIdOf('PLAN', raw.row.id) : requestIdOf('REORDER', raw.rule.id)
    const siteId = raw.kind === 'PLAN' ? raw.row.siteId : raw.rule.siteId
    const site = facts.sites.get(siteId)!
    const need: Need = { companyId: site.companyId, itemId: raw.kind === 'PLAN' ? raw.row.itemId : raw.rule.itemId, itemColourId: raw.kind === 'PLAN' ? raw.row.itemColourId : raw.rule.itemColourId }
    return { raw, id, site, need, supplier: supplierChoice(raw, facts, need, siteId, options.choices?.get(id) ?? {}) }
  })
  const partyIds = [...new Set(drafts.flatMap((draft) => (draft.supplier.id ? [draft.supplier.id] : [])))]
  const parties = new Map((partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: SUPPLIER_COLUMNS })).map((party) => [party.id, party]))
  const orderLineIds = drafts.flatMap((draft) => (draft.raw.kind === 'PLAN' && draft.raw.row.purchaseOrderLineId ? [draft.raw.row.purchaseOrderLineId] : []))
  const ordered = new Map(
    (orderLineIds.length === 0 ? [] : await db.purchaseOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, purchaseOrder: { select: { id: true, number: true, status: true } } } })).map((line) => [line.id, line.purchaseOrder]),
  )
  const salesOrderIds = [...new Set(drafts.flatMap((draft) => (draft.raw.kind === 'PLAN' ? sourcesOf(draft.raw.row.sources).map((source) => source.orderId) : [])))].filter((id) => id !== '')
  const salesOrders = new Map((salesOrderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: salesOrderIds } }, select: { id: true, number: true } })).map((order) => [order.id, order.number]))

  // What each buys, its lead time and the day it is needed (or ordered by), before the calendars are read.
  const sized = drafts.map((draft) => {
    const { raw, need } = draft
    const item = facts.items.get(need.itemId)!
    const units = unitsOf(item)
    const party = draft.supplier.id ? (parties.get(draft.supplier.id) ?? null) : null
    const source = party ? sourceFor(facts.sources, need, party.id) : null
    const usableSource = source && unitsBoughtIn(units, source.purchaseUom) ? source : null
    const siteRule = siteRuleOf(facts, draft.site.id, need.itemId, need.itemColourId)
    const terms = { defaultSupplierId: item.defaultSupplierId, leadTimeDays: item.leadTimeDays, minOrderQty: decimal(item.minOrderQty), orderMultiple: decimal(item.orderMultiple) }
    const supplierTerms = party ? { id: party.id, leadTimeDays: party.leadTimeDays } : null
    const lead = siteRule?.buyLeadTimeDays ?? (usableSource ? sourceRules(usableSource, party?.leadTimeDays ?? null).leadTimeDays : supplyRulesFor(terms, supplierTerms).leadTimeDays)
    let buy: { quantity: string; uom: Uom; baseQuantity: string; from: QuantityFrom; steps: (RoundingStep | LotStep)[] }
    if (raw.kind === 'PLAN' && raw.row.firmQuantity !== null) {
      buy = { quantity: quantityText(raw.row.firmQuantity), uom: raw.row.suggestedUom as Uom, baseQuantity: quantityText(raw.row.firmBaseQuantity ?? raw.row.firmQuantity), from: 'FIRM', steps: [] }
    } else {
      const net = raw.kind === 'PLAN' ? raw.row.netQuantity.toString() : reorderParts.get(raw.rule.id)!.need.quantity
      const fromSource = usableSource ? buyFromSource(net, units, usableSource, party?.leadTimeDays ?? null) : null
      if (fromSource) buy = { quantity: fromSource.quantity, uom: fromSource.uom, baseQuantity: fromSource.baseQuantity, from: 'SOURCE', steps: stepsOf(fromSource.steps) }
      else if (raw.kind === 'PLAN') {
        const quantity = raw.row.suggestedQuantity.toString()
        buy = { quantity: quantityText(raw.row.suggestedQuantity), uom: raw.row.suggestedUom as Uom, baseQuantity: toBase(quantity, raw.row.suggestedUom as Uom, units, { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }).toFixed(QUANTITY_SCALE), from: 'PLAN', steps: [] }
      } else {
        const suggestion = suggestionFor(net, 'BUY', units, supplyRulesFor(terms, supplierTerms))
        buy = { quantity: suggestion.quantity, uom: suggestion.uom, baseQuantity: suggestion.baseQuantity, from: 'ITEM', steps: stepsOf(suggestion.steps) }
      }
      if (raw.kind === 'REORDER') buy = { ...buy, steps: [...stepsOf(reorderParts.get(raw.rule.id)!.need.steps), ...buy.steps] }
    }
    const target = raw.kind === 'PLAN' ? addDays(dayOf(raw.row.firmDate ?? raw.row.needDate)!, -(siteRule?.safetyLeadTimeDays ?? 0)) : today
    return { ...draft, item, units, party, source, usableSource, lead, buy, target }
  })

  const windows = sized.flatMap((entry) => (entry.party && entry.lead !== null ? [leadTimeWindow(entry.target, entry.lead, entry.raw.kind === 'PLAN' ? 'back' : 'forward')] : []))
  const calendars: Map<string, LoadedSupplierCalendar> =
    windows.length === 0
      ? new Map()
      : await supplierCalendarsFor(db as Prisma.TransactionClient, [...new Set(sized.flatMap((entry) => (entry.party ? [entry.party.id] : [])))], {
          from: windows.map((window) => window.from).sort()[0]!,
          to: windows.map((window) => window.to).sort().reverse()[0]!,
        })

  return sized.map((entry) => {
    const { raw, item, units, party, source, usableSource, lead, buy, target, need, site } = entry
    const calendar = party ? (calendars.get(party.id)?.calendar ?? null) : null
    let needDate: BusinessDate
    let orderBy: Built['orderBy']
    if (raw.kind === 'PLAN') {
      needDate = dayOf(raw.row.firmDate ?? raw.row.needDate)!
      const walk = lead === null ? null : orderByDate(calendar, target, lead)
      const date = walk?.date ?? target
      orderBy = { date, leadTimeDays: lead, passed: date < today, closedDaysSkipped: walk?.skipped.length ?? 0 }
    } else {
      const walk = lead === null ? null : arrivalDate(calendar, today, lead)
      needDate = walk?.date ?? today
      orderBy = { date: today, leadTimeDays: lead, passed: false, closedDaysSkipped: walk?.skipped.length ?? 0 }
    }
    const currency = party?.currency ?? null
    const unitPrice =
      currency === null
        ? null
        : ((usableSource ? priceIn(usableSource, buy.uom, units, currency) : null) ?? defaultUnitPrice({ standardCost: decimal(item.standardCost), currency: item.currency, units }, buy.uom, currency))
    const colour = need.itemColourId ? (facts.colours.get(need.itemColourId) ?? null) : null
    const status: RequestStatus = raw.kind === 'REORDER' ? 'OPEN' : raw.row.decision === 'ORDERED' ? 'CONVERTED' : raw.row.decision === 'IGNORED' ? 'SET_ASIDE' : 'OPEN'
    const reorder = raw.kind === 'REORDER' ? reorderParts.get(raw.rule.id)! : null
    const approved = party ? isApproved(facts.sources, need, party.id) : true
    const hold = holdOf({
      status,
      latest: raw.kind === 'REORDER' || raw.run.status === 'DONE',
      needed: reorder === null || reorder.need.triggered,
      material: { code: item.code, active: item.status === 'ACTIVE' },
      supplier: party ? { name: party.tradeName ?? party.legalName, roles: party.roles as PartyRole[], status: party.status as PartyStatus } : null,
      approved,
    })
    // What the buyer should know before drafting: only for what is still to buy.
    const warnings: RequestWarningCode[] = []
    if (status === 'OPEN' && hold === null) {
      if (party?.status === 'PROSPECT') warnings.push('SUPPLIER_PROSPECT')
      if (party && unitPrice === null) warnings.push('NO_PRICE')
      if (orderBy.passed) warnings.push('ORDER_BY_PASSED')
      if (party && lead === null) warnings.push('NO_LEAD_TIME')
      if (source && !usableSource) warnings.push('SOURCE_UNIT_NOT_CONVERTED')
    }
    const plan: PlanPart | null =
      raw.kind === 'PLAN'
        ? {
            runId: raw.run.id,
            runStatus: raw.run.status,
            runStartedAt: raw.run.startedAt,
            trigger: raw.run.trigger,
            row: raw.row,
            firm: raw.row.firmQuantity !== null,
            setAside: raw.row.decision === 'IGNORED' ? readDecisionNote(raw.row.decisionNote) : null,
            purchaseOrder: raw.row.purchaseOrderLineId ? ((ordered.get(raw.row.purchaseOrderLineId) as PlanPart['purchaseOrder']) ?? null) : null,
            ...planOrdersOf(raw.row, salesOrders),
          }
        : null
    return {
      id: entry.id,
      kind: raw.kind,
      refId: raw.kind === 'PLAN' ? raw.row.id : raw.rule.id,
      version: raw.kind === 'PLAN' ? raw.row.version : raw.rule.version,
      companyId: site.companyId,
      siteId: site.id,
      site: { code: site.code, name: site.name },
      status,
      convertedOn: raw.kind === 'PLAN' && raw.row.decision === 'ORDERED' && raw.row.decidedAt ? businessDate(raw.row.decidedAt) : null,
      item,
      colour,
      needDate,
      orderBy,
      supplier: party,
      supplierFrom: party ? entry.supplier.from : null,
      source: usableSource ?? source,
      approvedSupplierIds: approvedSupplierIds(facts.sources, need),
      quantity: buy.quantity,
      uom: buy.uom,
      baseQuantity: buy.baseQuantity,
      estimatedHides: estimatedHidesOf(item.kind, buy.baseQuantity, units),
      quantityFrom: buy.from,
      rounding: buy.steps,
      currency,
      unitPrice,
      supplierArticleCode: source?.supplierArticleCode ?? (party && item.defaultSupplierId === party.id ? item.supplierArticleCode : null),
      supplierColourCode: source?.supplierColourCode ?? colour?.supplierColourCode ?? null,
      hold,
      warnings: warnings.map((code) => ({ code, message: WARNING_WORDS[code] })),
      plan,
      reorder: reorder
        ? { rule: (raw as RawReorder).rule, method: reorder.need.method, stock: reorder.position as ReorderPart['stock'], need: reorder.need, why: reorderWhy(reorder.need, reorder.position, item.baseUom as Uom), onOrderLines: reorder.lines }
        : null,
    } satisfies Built
  })
}

/** A plan row's netting in one line (planning's own words). */
export const planWhy = (row: RequirementRow): string =>
  whyLine({ action: row.action, uom: row.uom, grossQuantity: quantityText(row.grossQuantity), usableStock: quantityText(row.usableStock), heldStock: quantityText(row.heldStock), onOrder: quantityText(row.onOrder), netQuantity: quantityText(row.netQuantity), needDate: dayOf(row.needDate)! })

/** A plan row's orders (their numbers now, else as the run stored them) and work orders (the stored sources). */
function planOrdersOf(row: RequirementRow, numbers: ReadonlyMap<string, string>): { orders: { id: string; number: string }[]; workOrders: string[] } {
  const sources = sourcesOf(row.sources)
  const orders = new Map<string, string>()
  for (const source of sources) if (source.orderId !== '') orders.set(source.orderId, numbers.get(source.orderId) ?? source.orderNumber)
  return { orders: [...orders.entries()].map(([id, number]) => ({ id, number })), workOrders: [...new Set(sources.flatMap((source) => source.workOrders))] }
}

export type { MaterialRow, RequirementRow, RuleRow, RunRow, SupplierRow }
