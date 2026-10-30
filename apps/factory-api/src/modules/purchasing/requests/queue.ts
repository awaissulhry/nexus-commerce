import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { lineAmount } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { compareRequests, kindOfPath, needWeekOf, requestTiles, type RequestKind, type RequestStatus } from '@nexus/factory-domain/purchasing/requests/requests'
import { rankedSources } from '@nexus/factory-domain/purchasing/sources/sources'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf, quantityText, seesCost, type Reader } from '../store'
import { activeSourcesOf } from '../supplier-items/store'
import { buildRequests, latestRuns, planRaws, planWhy, reorderRaws, type Built } from './build'

/**
 * The buyer's queue (B-W2a-10; SCM-034; design purchasing.requests "To handle" tiles, "Requests", the Request detail):
 * every open need of the sites the caller reaches, from the sites' latest plans and their reorder rules, built by ./build
 * (one rule for the queue, the pop-up and the conversion). purchasing.view; a request with a supplier is seen when the
 * caller reaches that supplier too (as its purchase orders). Prices and values only with the cost grain.
 */

const DECISION_OF: Readonly<Record<RequestStatus, 'OPEN' | 'ORDERED' | 'IGNORED'>> = { OPEN: 'OPEN', CONVERTED: 'ORDERED', SET_ASIDE: 'IGNORED' }

/** Something to buy: a suggestion above 0, or a firm planned order. */
const TO_BUY: Prisma.MaterialRequirementWhereInput = { action: 'BUY', OR: [{ suggestedQuantity: { gt: 0 } }, { firmQuantity: { not: null } }] }

/** The request may be seen: its site, and its supplier when it has one. */
export const reaches = (actor: Actor, built: Pick<Built, 'companyId' | 'siteId' | 'supplier'>): boolean =>
  can(actor, PURCHASING_VIEW, { companyId: built.companyId, siteId: built.siteId, ...(built.supplier ? { partyId: built.supplier.id } : {}) })

/** A request as the routes answer it. */
export function requestView(built: Built, withCost: boolean) {
  const amount = withCost && built.unitPrice !== null && built.currency !== null ? safeAmount(built.quantity, built.unitPrice, built.currency) : null
  const plan = built.plan
  const reorder = built.reorder
  return {
    id: built.id,
    kind: built.kind,
    refId: built.refId,
    version: built.version,
    status: built.status,
    companyId: built.companyId,
    siteId: built.siteId,
    site: built.site,
    item: { id: built.item.id, code: built.item.code, name: built.item.name, kind: built.item.kind, baseUom: built.item.baseUom, purchaseUom: built.item.purchaseUom, requiresCrViTest: built.item.requiresCrViTest },
    colour: built.colour ? { id: built.colour.id, code: built.colour.code, name: built.colour.name } : null,
    needDate: built.needDate,
    needWeek: needWeekOf(built.needDate),
    orderBy: built.orderBy,
    quantity: built.quantity,
    uom: built.uom,
    baseQuantity: built.baseQuantity,
    baseUom: built.item.baseUom,
    estimatedHides: built.estimatedHides,
    quantityFrom: built.quantityFrom,
    rounding: built.rounding.map((step) => ({ rule: step.rule, quantity: step.quantity })),
    supplier: built.supplier ? { id: built.supplier.id, code: built.supplier.code, name: built.supplier.tradeName ?? built.supplier.legalName, status: built.supplier.status } : null,
    supplierFrom: built.supplierFrom,
    sourceId: built.source?.id ?? null,
    approvedSuppliers: built.approvedSupplierIds.length,
    supplierArticleCode: built.supplierArticleCode,
    supplierColourCode: built.supplierColourCode,
    currency: built.currency,
    ...(withCost ? { unitPrice: asMoney('cost', built.unitPrice), expectedAmount: asMoney('cost', amount) } : {}),
    hold: built.hold,
    warnings: [...built.warnings],
    plan: plan
      ? {
          runId: plan.runId,
          runStatus: plan.runStatus,
          runStartedAt: toUtcIso(plan.runStartedAt),
          trigger: plan.trigger,
          why: planWhy(plan.row),
          grossQuantity: quantityText(plan.row.grossQuantity),
          usableStock: quantityText(plan.row.usableStock),
          heldStock: quantityText(plan.row.heldStock),
          onOrder: quantityText(plan.row.onOrder),
          netQuantity: quantityText(plan.row.netQuantity),
          suggestedQuantity: quantityText(plan.row.suggestedQuantity),
          suggestedUom: plan.row.suggestedUom,
          orders: [...plan.orders],
          workOrders: [...plan.workOrders],
          firm: plan.firm,
          decidedAt: plan.row.decidedAt ? toUtcIso(plan.row.decidedAt) : null,
          setAside: plan.setAside,
          purchaseOrder: plan.purchaseOrder,
        }
      : null,
    reorder: reorder
      ? {
          method: reorder.method,
          position: reorder.need.position,
          usable: reorder.stock.usable,
          onOrder: reorder.stock.onOrder,
          reserved: reorder.stock.reserved,
          level: reorder.need.level,
          triggered: reorder.need.triggered,
          quantity: reorder.need.quantity,
          why: reorder.why,
          note: reorder.rule.note,
        }
      : null,
  }
}

/** quantity × price in minor units; null when it does not fit one line (the order refuses it anyway). */
export function safeAmount(quantity: string, unitPrice: string, currency: string): number | null {
  try {
    return lineAmount(quantity, unitPrice, currency)
  } catch {
    return null
  }
}

interface QueueScope {
  readonly siteId?: string | undefined
  readonly kind?: RequestKind | undefined
  /** Which plan lines (their decision, the tiles' "drafted today"); always only lines with something to buy. */
  readonly plan: Prisma.MaterialRequirementWhereInput
  readonly withReorder: boolean
}

/** Every request of the scope the caller reaches, built and in the queue's order. */
async function queueOf(db: Reader, actor: Actor, scope: QueueScope, today: BusinessDate): Promise<Built[]> {
  const runs = (await latestRuns(db, scope.siteId)).filter((run) => can(actor, PURCHASING_VIEW, { companyId: run.companyId, siteId: run.siteId }))
  const plans = scope.kind === 'REORDER' ? [] : await planRaws(db, runs, { AND: [TO_BUY, scope.plan] })
  const ruleScope = scopeWhere(actor, PURCHASING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.ItemPlanningWhereInput
  const reorders = scope.kind === 'PLAN' || !scope.withReorder ? [] : await reorderRaws(db, { AND: [ruleScope, scope.siteId ? { siteId: scope.siteId } : {}] })
  const built = await buildRequests(db, [...plans, ...reorders], { today, triggeredOnly: true })
  return built.filter((entry) => reaches(actor, entry)).sort((a, b) => compareRequests({ ...a, orderBy: a.orderBy.date, code: a.item.code }, { ...b, orderBy: b.orderBy.date, code: b.item.code }))
}

export interface ListRequestsQuery {
  readonly siteId?: string | undefined
  readonly kind?: RequestKind | undefined
  readonly status: RequestStatus | 'ALL'
  readonly supplierId?: string | undefined
  readonly itemId?: string | undefined
  readonly needBy?: string | undefined
  readonly held?: boolean | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const contains = (value: string | null | undefined, q: string): boolean => (value ?? '').toLowerCase().includes(q)

/** purchasing.view: the queue, filtered and paged (a cursor of request ids). */
export async function listRequests(caller: CommandCaller, query: ListRequestsQuery) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  const today = businessDate(now)
  return caller.withClient(async (client) => {
    const plan: Prisma.MaterialRequirementWhereInput = { ...(query.status === 'ALL' ? {} : { decision: DECISION_OF[query.status] }), ...(query.itemId ? { itemId: query.itemId } : {}) }
    const built = await queueOf(client, actor, { siteId: query.siteId, kind: query.kind, plan, withReorder: query.status === 'OPEN' || query.status === 'ALL' }, today)
    const q = query.q?.toLowerCase()
    const matching = built.filter(
      (entry) =>
        (!query.itemId || entry.item.id === query.itemId) &&
        (!query.supplierId || entry.supplier?.id === query.supplierId) &&
        (!query.needBy || entry.needDate <= query.needBy) &&
        (query.held === undefined || (entry.hold !== null) === query.held) &&
        (!q ||
          contains(entry.item.code, q) ||
          contains(entry.item.name, q) ||
          contains(entry.supplier?.tradeName ?? entry.supplier?.legalName, q) ||
          (entry.plan ? entry.plan.orders.some((order) => contains(order.number, q)) || entry.plan.workOrders.some((number) => contains(number, q)) : false)),
    )
    const start = query.cursor ? matching.findIndex((entry) => entry.id === query.cursor) + 1 : 0
    const page = matching.slice(start, start + query.limit)
    const withCost = seesCost(context)
    return {
      asOf: toUtcIso(now),
      requests: page.map((entry) => requestView(entry, withCost)),
      matching: matching.length,
      nextCursor: start + query.limit < matching.length ? page[page.length - 1]!.id : null,
    }
  })
}

/** purchasing.view: the "To handle" tiles over the same queue. */
export async function requestCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly kind?: RequestKind | undefined }) {
  const context = officeContextOf(caller)
  const now = serverClock.now()
  const today = businessDate(now)
  return caller.withClient(async (client) => {
    const plan: Prisma.MaterialRequirementWhereInput = { OR: [{ decision: 'OPEN' }, { decision: 'ORDERED', decidedAt: { gte: businessDayStart(today), lt: businessDayStart(addDays(today, 1)) } }] }
    const built = await queueOf(client, actorOf(context), { siteId: query.siteId, kind: query.kind, plan, withReorder: true }, today)
    return { asOf: toUtcIso(now), ...requestTiles(built, today) }
  })
}

/** purchasing.view: one request with the sources the buyer may pick and, for a reorder row, the orders it counts. */
export async function getRequest(caller: CommandCaller, kindSegment: string, refId: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const kind = kindOfPath(kindSegment)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const raws = kind === 'PLAN' ? await planRaws(client, null, { id: refId, action: 'BUY' }) : kind === 'REORDER' ? await reorderRaws(client, { id: refId }) : []
    const [built] = await buildRequests(client, raws, { today: businessDate(now), triggeredOnly: false })
    if (!built || !reaches(actor, built)) throw new NotFoundError('Request not found.')
    const withCost = seesCost(context)
    const sources = rankedSources(await activeSourcesOf(client, [built.item.id]), { companyId: built.companyId, itemId: built.item.id, itemColourId: built.colour?.id ?? null })
    const parties = new Map((sources.length === 0 ? [] : await client.party.findMany({ where: { id: { in: sources.map((source) => source.partyId) } }, select: { id: true, code: true, legalName: true, tradeName: true, status: true } })).map((party) => [party.id, party]))
    return {
      request: requestView(built, withCost),
      sources: sources
        .filter((source) => can(actor, PURCHASING_VIEW, { companyId: source.companyId, partyId: source.partyId }))
        .map((source) => {
          const party = parties.get(source.partyId)!
          return {
            id: source.id,
            partyId: source.partyId,
            supplier: { code: party.code, name: party.tradeName ?? party.legalName, status: party.status },
            preference: source.preference,
            purchaseUom: source.purchaseUom,
            ...(withCost ? { unitPrice: asMoney('cost', source.unitPrice) } : {}),
            currency: source.currency,
            minOrderQty: source.minOrderQty,
            orderMultiple: source.orderMultiple,
            leadTimeDays: source.leadTimeDays,
            supplierArticleCode: source.supplierArticleCode,
          }
        }),
      onOrder: built.reorder ? [...built.reorder.onOrderLines] : [],
    }
  })
}
