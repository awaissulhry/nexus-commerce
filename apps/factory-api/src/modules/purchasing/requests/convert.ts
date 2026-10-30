import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PURCHASING_MANAGE, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { requestIdOf, type RequestKind } from '@nexus/factory-domain/purchasing/requests/requests'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { draftLineOf, draftLines, openDraftOf, type DraftInto } from '../from-plan'
import { assertMay, officeContextOf, seesCost, type Reader } from '../store'
import { buildRequests, planRaws, reorderRaws, type Built } from './build'
import { safeAmount } from './queue'

/**
 * "Draft POs for n" (B-W2a-10; SCM-036; design purchasing.requests "Bulk: Draft POs (same modal as planning)", the
 * Draft purchase orders pop-up): many requests to buy become draft purchase orders at once, one per supplier and delivery
 * site (into its open draft, the one the buyer names, or a new one), one line per request, through the same drafting as
 * the plan's Draft PO (../from-plan `draftLines`): a plan line is marked ORDERED with its line (planning's hook), a reorder
 * row leaves the queue once the draft's quantity lifts its position. Nothing is sent: drafts stay in Purchasing until a
 * buyer sends them. RFQs (SCM-036's "or RFQ") are Later in the approved design.
 *
 *   preview   purchasing.view: the cards the conversion would make (supplier, site, currency, the draft it adds to or the
 *             new one, the lines with their prices for the cost grain, whether the caller may draft them) and the
 *             requests it would refuse, with why. Nothing is written.
 *   convert   purchasing.manage over each request's company, site and supplier: ONE command; every request at the
 *             version read; a held request refuses the whole batch in words (its path names it). Two buyers converting
 *             the same reorder row wait for each other (an advisory lock per site, item and colour): the second finds the
 *             first one's draft in the position and is refused ("nothing to buy").
 */

export interface ConvertInput {
  readonly requests: readonly { readonly kind: RequestKind; readonly id: string; readonly version: number; readonly supplierId?: string | undefined }[]
  readonly into?: readonly DraftInto[] | undefined
}

/** The requests the body names, built, in its order; 404 for one the caller does not reach (its site). */
async function resolve(db: Reader, actor: Actor, body: ConvertInput, today: BusinessDate): Promise<Built[]> {
  const ids = body.requests.map((request) => requestIdOf(request.kind, request.id))
  if (new Set(ids).size !== ids.length) throw new ValidationError('A request is listed twice.', [{ path: 'body/requests', message: 'Each request once.' }])
  const planIds = body.requests.filter((request) => request.kind === 'PLAN').map((request) => request.id)
  const ruleIds = body.requests.filter((request) => request.kind === 'REORDER').map((request) => request.id)
  const plans = planIds.length === 0 ? [] : await planRaws(db, null, { id: { in: planIds } })
  for (const raw of plans) {
    if (raw.row.action !== 'BUY') throw new ConflictError('A part we make is not bought: it has no purchase line.')
    if (!raw.row.suggestedQuantity.gt(0) && raw.row.firmQuantity === null) throw new ConflictError('Nothing is short on this line: there is nothing to buy.')
  }
  const reorders = ruleIds.length === 0 ? [] : await reorderRaws(db, { id: { in: ruleIds } })
  const choices = new Map(body.requests.flatMap((request) => (request.supplierId ? [[requestIdOf(request.kind, request.id), { supplierId: request.supplierId }] as const] : [])))
  const built = new Map((await buildRequests(db, [...plans, ...reorders], { today, choices, triggeredOnly: false })).map((entry) => [entry.id, entry]))
  return ids.map((id) => {
    const entry = built.get(id)
    if (!entry || !can(actor, PURCHASING_VIEW, { companyId: entry.companyId, siteId: entry.siteId })) throw new NotFoundError('Request not found.')
    return entry
  })
}

const groupKey = (entry: Built): string => `${entry.companyId}|${entry.siteId}|${entry.supplier!.id}`

/** purchasing.view: what the conversion would make, card by card; nothing is written. */
export async function previewConversion(caller: CommandCaller, body: ConvertInput) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const withCost = seesCost(context)
  return caller.withClient(async (client) => {
    const built = await resolve(client, actor, body, businessDate(serverClock.now()))
    const held = built.filter((entry) => entry.hold !== null).map((entry) => ({ requestId: entry.id, code: entry.hold!.code, message: entry.hold!.message }))
    const groups = new Map<string, Built[]>()
    for (const entry of built) if (entry.hold === null) groups.set(groupKey(entry), [...(groups.get(groupKey(entry)) ?? []), entry])
    const cards = []
    for (const key of [...groups.keys()].sort()) {
      const entries = groups.get(key)!
      const first = entries[0]!
      const supplier = first.supplier!
      const open = await openDraftOf(client, { companyId: first.companyId, siteId: first.siteId, partyId: supplier.id, currency: supplier.currency })
      const named = body.into?.find((entry) => entry.supplierId === supplier.id && (entry.siteId === undefined || entry.siteId === first.siteId))
      const target = named === undefined ? open : named.purchaseOrderId === null ? null : await client.purchaseOrder.findFirst({ where: { id: named.purchaseOrderId, companyId: first.companyId, siteId: first.siteId, partyId: supplier.id, status: 'DRAFT' }, select: { id: true, number: true } })
      const count = async (orderId: string) => client.purchaseOrderLine.count({ where: { purchaseOrderId: orderId } })
      const lines = entries.map((entry) => {
        const amount = withCost && entry.unitPrice !== null ? safeAmount(entry.quantity, entry.unitPrice, supplier.currency) : null
        return {
          requestId: entry.id,
          item: { id: entry.item.id, code: entry.item.code, name: entry.item.name },
          colour: entry.colour ? { id: entry.colour.id, code: entry.colour.code, name: entry.colour.name } : null,
          quantity: entry.quantity,
          uom: entry.uom,
          needDate: entry.needDate,
          ...(withCost ? { unitPrice: asMoney('cost', entry.unitPrice), expectedAmount: asMoney('cost', amount) } : {}),
          warnings: [...entry.warnings],
        }
      })
      const amounts = lines.map((line) => (line as { expectedAmount?: number | null }).expectedAmount ?? null)
      cards.push({
        companyId: first.companyId,
        siteId: first.siteId,
        site: first.site,
        supplier: { id: supplier.id, code: supplier.code, name: supplier.tradeName ?? supplier.legalName, status: supplier.status },
        currency: supplier.currency,
        into: target ? ('EXISTING' as const) : ('NEW' as const),
        draft: target ? { id: target.id, number: target.number, lineCount: await count(target.id) } : null,
        openDraft: open && open.id !== target?.id ? { id: open.id, number: open.number, lineCount: await count(open.id) } : null,
        lines,
        ...(withCost ? { expectedAmount: asMoney('cost', amounts.some((value) => value === null) ? null : amounts.reduce<number>((sum, value) => sum + value!, 0)) } : {}),
        mayDraft: can(actor, PURCHASING_MANAGE, { companyId: first.companyId, siteId: first.siteId, partyId: supplier.id }),
      })
    }
    return { cards, held }
  })
}

/** purchasing.manage: the requests drafted into purchase orders, in ONE command (see the module comment). */
export async function convertRequests(caller: CommandCaller, body: ConvertInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const { result } = await command(caller, { name: 'purchasing.convertRequests', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    // A reorder row is a position, not a row: one lock per site, item and colour, taken in a fixed order, before it is read.
    const ruleIds = body.requests.filter((request) => request.kind === 'REORDER').map((request) => request.id)
    const rules = ruleIds.length === 0 ? [] : await tx.itemPlanning.findMany({ where: { id: { in: ruleIds } }, select: { siteId: true, itemId: true, itemColourId: true } })
    for (const lock of [...new Set(rules.map((rule) => `${rule.siteId}|${rule.itemId}|${rule.itemColourId ?? '-'}`))].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.reorder-buy', ${context.tenantId}::uuid, ${lock}::text), 0))`
    }
    const built = await resolve(tx, actor, body, businessDate(tools.now))
    const lines = built.map((entry, index) => {
      const asked = body.requests[index]!
      if (entry.version !== asked.version) throw new StaleVersionError(entry.kind === 'PLAN' ? 'MaterialRequirement' : 'ItemPlanning', entry.refId, entry.version, asked.version)
      if (entry.supplier) assertMay(context, PURCHASING_MANAGE, { companyId: entry.companyId, siteId: entry.siteId, partyId: entry.supplier.id }, 'Request')
      return draftLineOf(entry, `body/requests/${index}`, { requestId: entry.id, kind: entry.kind, refId: entry.refId, quantityFrom: entry.quantityFrom, sourceId: entry.source?.id ?? null })
    })
    const { orders, made } = await draftLines(tools, context, lines, body.into ?? [], 'purchasing.convertRequests')
    for (const order of orders) {
      const kinds = order.keys.map((key) => built.find((entry) => entry.id === key)!.kind)
      tools.emit({
        type: 'purchase_requests.converted',
        subject: order.id,
        companyId: order.companyId,
        siteId: order.siteId,
        payload: { purchaseOrderId: order.id, number: order.number, created: order.created, requests: kinds.length, fromPlan: kinds.filter((kind) => kind === 'PLAN').length, fromReorder: kinds.filter((kind) => kind === 'REORDER').length },
      })
    }
    return {
      orders: orders.map((order) => ({ id: order.id, number: order.number, created: order.created, companyId: order.companyId, siteId: order.siteId, supplierId: order.supplierId, lineIds: order.lineIds, lineCount: order.lineCount })),
      lines: made.map((entry) => ({ requestId: entry.key, purchaseOrderId: entry.purchaseOrderId, purchaseOrderLineId: entry.purchaseOrderLineId })),
    }
  })
  return result
}
