import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { OPEN_RETURN_STATUSES, RETURN_LIMITS, RETURN_REASON_LIST, RETURN_STATUSES, statusWords, type ReturnListView, type ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { reasonWords } from '../../../platform/reasons/service'
import { officeOf } from './access'
import { currencyOf, dayOrNull, lineKeyOf, RMA_COLUMNS, soldFactsOf } from './store'

/**
 * The returns list and its tiles (B-W2a-43; design sales.returns returns.tiles "Waiting for goods", "Received — to
 * inspect", "Replacement to send", returns.grid "Open returns; To inspect; Closed; All"; SAL-362 the status of each).
 * Office only, within the caller's companies, sites and customers (sales.returns.view). Repairs join the list with
 * B-W2a-57; the screen is B-W2a-77's.
 *
 *   GET /sales/returns         newest first: `view` open (default) | waiting | late | toInspect | toDecide | replacement |
 *                              closed | all, or `status` (one or a comma list), `partyId`, `salesOrderId`, `siteId`,
 *                              `owner` me | <id>, `q` (number, customer reference, customer code or name); at most 200
 *                              (`truncated`). Credit values with the price grain only.
 *   GET /sales/returns/counts  the tiles: waiting for the goods, late, received to inspect or decide, replacement to make,
 *                              open.
 */


export interface ListQuery {
  readonly view?: ReturnListView | undefined
  readonly status?: string | undefined
  readonly partyId?: string | undefined
  readonly salesOrderId?: string | undefined
  readonly siteId?: string | undefined
  readonly owner?: string | undefined
  readonly q?: string | undefined
}

const SCOPE = { company: 'companyId', site: 'siteId', party: 'partyId' } as const

function viewWhere(view: ReturnListView, today: Date): Prisma.ReturnAuthorisationWhereInput {
  switch (view) {
    case 'open':
      return { status: { in: [...OPEN_RETURN_STATUSES] } }
    case 'waiting':
      return { status: 'AUTHORISED' }
    case 'late':
      return { status: 'AUTHORISED', goodsDueBy: { lt: today } }
    case 'toInspect':
      return { status: 'RECEIVED', lines: { some: { receivedQuantity: { gt: 0 }, grade: null } } }
    case 'toDecide':
      return { status: 'RECEIVED', lines: { some: { receivedQuantity: { gt: 0 }, disposition: null } } }
    case 'replacement':
      return { status: { in: ['RECEIVED', 'INSPECTED'] }, replacementOrderId: null, lines: { some: { disposition: 'REPLACE', replacementLineId: null } } }
    case 'closed':
      return { status: { in: ['CLOSED', 'CANCELLED', 'REJECTED'] } }
    case 'all':
      return {}
  }
}

function whereOf(caller: CommandCaller, query: ListQuery): Prisma.ReturnAuthorisationWhereInput {
  const context = officeOf(caller)
  const today = new Date(`${businessDate(serverClock.now())}T00:00:00.000Z`)
  const statuses = query.status ? query.status.split(',').map((entry) => entry.trim()).filter(Boolean) : []
  const bad = statuses.find((status) => !(RETURN_STATUSES as readonly string[]).includes(status))
  if (bad) throw new ValidationError('Not a return status.', [{ path: 'querystring/status', message: `One or more of ${RETURN_STATUSES.join(', ')}.` }])
  if (query.owner && query.owner !== 'me' && !isUuid(query.owner)) throw new ValidationError('Not an owner.', [{ path: 'querystring/owner', message: "A person's id, or me." }])
  const q = (query.q ?? '').trim()
  return {
    AND: [
      scopeWhere(actorOf(context), SALES_RETURNS_VIEW, SCOPE) as Prisma.ReturnAuthorisationWhereInput,
      statuses.length > 0 ? { status: { in: statuses as ReturnStatus[] } } : viewWhere(query.view ?? 'open', today),
      query.partyId ? { partyId: query.partyId } : {},
      query.salesOrderId ? { OR: [{ salesOrderId: query.salesOrderId }, { lines: { some: { salesOrderLine: { orderId: query.salesOrderId } } } }] } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.owner ? { ownerId: query.owner === 'me' ? context.actorId : query.owner } : {},
      q
        ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { customerRef: { contains: q, mode: 'insensitive' } }, { party: { legalName: { contains: q, mode: 'insensitive' } } }, { party: { code: { contains: q, mode: 'insensitive' } } }] }
        : {},
    ],
  }
}

/** GET /sales/returns */
export async function listReturns(caller: CommandCaller, query: ListQuery) {
  const where = whereOf(caller, query)
  return caller.withClient(async (client) => {
    const today = businessDate(serverClock.now())
    const rows = await client.returnAuthorisation.findMany({ where, select: RMA_COLUMNS, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: RETURN_LIMITS.list + 1 })
    const shown = rows.slice(0, RETURN_LIMITS.list)
    const ids = shown.map((row) => row.id)
    const lines = ids.length
      ? await client.returnLine.findMany({ where: { returnId: { in: ids } }, select: { id: true, returnId: true, salesOrderLineId: true, invoiceLineId: true, quantity: true, receivedQuantity: true, reasonCode: true, disposition: true, creditAmount: true, grade: true }, orderBy: { seq: 'asc' } })
      : []
    const sold = await soldFactsOf(client, lines)
    const parties = shown.length ? await client.party.findMany({ where: { id: { in: [...new Set(shown.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } }) : []
    const sites = shown.length ? await client.site.findMany({ where: { id: { in: [...new Set(shown.map((row) => row.siteId))] } }, select: { id: true, code: true } }) : []
    const orderIds = [...new Set(shown.flatMap((row) => [row.salesOrderId, row.replacementOrderId].filter((id): id is string => id !== null)))]
    const orders = orderIds.length ? await client.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } }) : []
    const reasons = await reasonWords(client, RETURN_REASON_LIST)
    const partyOf = new Map(parties.map((row) => [row.id, row]))
    const siteOf = new Map(sites.map((row) => [row.id, row]))
    const orderOf = new Map(orders.map((row) => [row.id, row]))
    return {
      returns: shown.map((row) => {
        const own = lines.filter((line) => line.returnId === row.id)
        const received = own.filter((line) => line.receivedQuantity > 0)
        const decided = received.filter((line) => line.disposition !== null)
        const invoices = [...new Set(own.flatMap((line) => { const number = sold.get(lineKeyOf(line))?.invoiceLine?.invoiceNumber; return number ? [number] : [] }))]
        const first = own[0]
        const reason = first ? reasons.get(first.reasonCode) : undefined
        const order = row.salesOrderId ? orderOf.get(row.salesOrderId) : undefined
        const replacement = row.replacementOrderId ? orderOf.get(row.replacementOrderId) : undefined
        return {
          id: row.id,
          number: row.number,
          companyId: row.companyId,
          siteId: row.siteId,
          site: siteOf.get(row.siteId) ?? null,
          partyId: row.partyId,
          party: partyOf.get(row.partyId) ?? null,
          customerRef: row.customerRef,
          salesOrder: order ? { id: order.id, number: order.number } : null,
          invoiceNumbers: invoices,
          units: own.reduce((sum, line) => sum + line.quantity, 0),
          receivedUnits: own.reduce((sum, line) => sum + line.receivedQuantity, 0),
          reasonCodes: [...new Set(own.map((line) => line.reasonCode))],
          reason: first && reason ? { code: first.reasonCode, labelIt: reason.labelIt, labelEn: reason.labelEn } : null,
          status: row.status,
          statusWords: statusWords({ status: row.status as ReturnStatus, goodsDueBy: dayOrNull(row.goodsDueBy), linesReceived: received.length, linesDecided: decided.length }, today),
          dispositions: [...new Set(own.flatMap((line) => (line.disposition ? [line.disposition] : [])))],
          receivedAt: row.receivedAt ? toUtcIso(row.receivedAt) : null,
          goodsDueBy: dayOrNull(row.goodsDueBy),
          late: row.status === 'AUTHORISED' && row.goodsDueBy !== null && dayOrNull(row.goodsDueBy)! < today,
          currency: currencyOf(first ? sold.get(lineKeyOf(first)) : undefined),
          creditTotal: asMoney('price', own.reduce((sum, line) => sum + (line.creditAmount ?? 0), 0)),
          replacementOrder: replacement ? { id: replacement.id, number: replacement.number } : null,
          ownerId: row.ownerId,
          requestedAt: toUtcIso(row.requestedAt),
          updatedAt: toUtcIso(row.updatedAt),
        }
      }),
      truncated: rows.length > RETURN_LIMITS.list,
    }
  })
}

/** GET /sales/returns/counts */
export async function returnCounts(caller: CommandCaller) {
  const scope = scopeWhere(actorOf(officeOf(caller)), SALES_RETURNS_VIEW, SCOPE) as Prisma.ReturnAuthorisationWhereInput
  const today = new Date(`${businessDate(serverClock.now())}T00:00:00.000Z`)
  return caller.withClient(async (client) => {
    const count = (view: ReturnListView) => client.returnAuthorisation.count({ where: { AND: [scope, viewWhere(view, today)] } })
    const waiting = await count('waiting')
    const late = await count('late')
    const toInspect = await count('toInspect')
    const toDecide = await count('toDecide')
    const replacement = await count('replacement')
    const open = await count('open')
    return { counts: { waiting, late, toInspect, toDecide, replacement, open }, asOf: toUtcIso(serverClock.now()) }
  })
}
