import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { decisionProblem, refuseReasonProblem, type AcceptAs } from '@nexus/factory-domain/sales/portal-ordering/office'
import { draftTotals, lineAmount, lineProblems, piecesOfSizes, priceShown, REQUEST_STATUS_WORDS, type RequestSource, type RequestStatus } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { makeManualOrderInCommand, type ManualOrderBody } from '../orders/manual'
import { assertMay, officeContextOf } from '../orders/access'
import { duplicateInto, type Dropped } from '../quotes/duplicate'
import { factsOf, readCatalogue } from './catalogue'
import { dayText, iso, lockRequest, priceOrNull, readLines, readRequest, REQUEST_COLUMNS, type LineRow } from './store'

/**
 * The office's side of portal order requests (B-W2b-190, SAL-074; design home.approvals, sales.orders "the request waits
 * there as Requested"). Office sessions over the requests' company and customer (orders.view to see, orders.manage to
 * decide; quotes.manage too for a quote), like the sales orders.
 *
 *   GET  /sales/order-requests?status=&partyId=&q=      the requests customers sent (never a draft: it is theirs)
 *   GET  /sales/order-requests/:requestId               one request: the customer, who sent it, the lines and sizes
 *                                                       with the price the customer was shown and the list price today,
 *                                                       what changed since (a style no longer sold, a size not offered),
 *                                                       the decision
 *   POST /sales/order-requests/:requestId/accept        as=ORDER: the order through the sales orders' own manual create
 *                                                       (prices again: the list price today, or the one the office types
 *                                                       per line), then ACCEPTED naming it — one command. as=QUOTE: a new
 *                                                       quote of its lines (the quotes' own copy: list prices today, sizes
 *                                                       still offered; what it left out is named), ACCEPTED naming it
 *   POST /sales/order-requests/:requestId/refuse        REFUSED with the reason (the customer reads it)
 *
 * A decision moves the request from SENT once (its version is the guard; the database allows nothing else), with its
 * audit row and portal_order_request.accepted / .refused. The sales-order state machine is the sales orders' own.
 */

const LIST_MAX = 200
const SCOPE = { company: 'companyId', party: 'partyId' } as const

async function namesOf(caller: CommandCaller, userIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  return caller.withClient(async (client) => new Map((await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName])))
}

export async function listOfficeRequests(caller: CommandCaller, query: { readonly status: RequestStatus | 'OPEN' | 'ALL'; readonly partyId?: string | undefined; readonly q?: string | undefined }) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), ORDERS_VIEW, SCOPE) as Prisma.PortalOrderRequestWhereInput
  const q = query.q?.trim()
  const status: Prisma.PortalOrderRequestWhereInput = query.status === 'OPEN' ? { status: 'SENT' } : query.status === 'ALL' ? { status: { not: 'DRAFT' } } : query.status === 'DRAFT' ? { id: { in: [] } } : { status: query.status }
  const rows = await caller.withClient((client) =>
    client.portalOrderRequest.findMany({
      where: { AND: [scope, status, ...(query.partyId ? [{ partyId: query.partyId }] : []), ...(q ? [{ OR: [{ number: { contains: q, mode: 'insensitive' as const } }, { customerRef: { contains: q, mode: 'insensitive' as const } }] }] : [])] },
      select: { ...REQUEST_COLUMNS, decidedById: true },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      take: LIST_MAX,
    }),
  )
  const lines = await caller.withClient((client) => readLines(client, rows.map((row) => row.id)))
  const parties = await caller.withClient(async (client) => new Map((await client.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row])))
  const names = await namesOf(caller, rows.map((row) => row.sentById))
  return {
    requests: rows.map((row) => {
      const own = lines.filter((line) => line.requestId === row.id)
      const totals = draftTotals(own.map((line) => ({ sizes: line.sizes, unitPriceShown: priceOrNull(line.unitPriceShown) })), true)
      return {
        id: row.id,
        number: row.number,
        status: row.status as RequestStatus,
        source: row.source as RequestSource,
        party: { id: row.partyId, code: parties.get(row.partyId)?.code ?? '', name: parties.get(row.partyId)?.legalName ?? '' },
        customerRef: row.customerRef,
        requestedDate: dayText(row.requestedDate),
        sentAt: iso(row.sentAt),
        sentBy: row.sentById ? (names.get(row.sentById) ?? null) : null,
        decidedAt: iso(row.decidedAt),
        lines: totals.lines,
        pieces: totals.pieces,
        netShown: asMoney('price', totals.net),
        currency: row.currency,
        salesOrderId: row.salesOrderId,
        quoteId: row.quoteId,
        version: row.version,
      }
    }),
  }
}

async function officeRequest(caller: CommandCaller, requestId: string) {
  const context = officeContextOf(caller)
  const row = isUuid(requestId) ? await caller.withClient((client) => client.portalOrderRequest.findUnique({ where: { id: requestId }, select: { ...REQUEST_COLUMNS, decidedById: true } })) : null
  // A draft is the customer's: the office does not see it.
  if (!row || row.status === 'DRAFT') throw new NotFoundError('Order request not found.')
  assertMay(context, ORDERS_VIEW, { companyId: row.companyId, partyId: row.partyId }, 'Order request')
  return { context, row }
}

export async function officeRequestView(caller: CommandCaller, requestId: string) {
  const { context, row } = await officeRequest(caller, requestId)
  const day = businessDate(serverClock.now())
  const lines = await caller.withClient((client) => readLines(client, [row.id]))
  const catalogue = await caller.withClient((client) => readCatalogue(client, { companyId: row.companyId, partyId: row.partyId, day, styleIds: lines.map((line) => line.styleId) }))
  const party = await caller.withClient((client) => client.party.findUnique({ where: { id: row.partyId }, select: { id: true, code: true, legalName: true } }))
  const shipTo = row.shipToAddressId ? await caller.withClient((client) => client.partyAddress.findUnique({ where: { id: row.shipToAddressId! }, select: { id: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, status: true } })) : null
  const names = await namesOf(caller, [row.sentById, row.decidedById, row.createdById])
  const salesOrder = row.salesOrderId ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: row.salesOrderId! }, select: { id: true, number: true } })) : null
  const quote = row.quoteId ? await caller.withClient((client) => client.quote.findUnique({ where: { id: row.quoteId! }, select: { id: true, number: true } })) : null
  const actor = actorOf(context)
  const scope = { companyId: row.companyId, partyId: row.partyId }
  const views = lines.map((line) => {
    const facts = factsOf(catalogue, line.styleId, line.colourwayId)
    const sizes = line.sizes.map((size) => ({ size: size.size, quantity: size.quantity }))
    const shown = priceOrNull(line.unitPriceShown)
    const pieces = piecesOfSizes(sizes)
    return {
      id: line.id,
      seq: line.seq,
      style: { id: line.styleId, code: catalogue.codes.get(line.styleId)?.code ?? '', name: catalogue.codes.get(line.styleId)?.name ?? '' },
      colourway: { id: line.colourwayId, code: catalogue.colourways.get(line.colourwayId)?.code ?? '', name: catalogue.colourways.get(line.colourwayId)?.name ?? '' },
      sizes,
      pieces,
      unitPriceShown: asMoney('price', shown === null ? null : priceShown(shown)),
      listPriceNow: asMoney('price', facts?.priceNow ? priceShown(facts.priceNow) : null),
      amountShown: asMoney('price', lineAmount(shown, pieces)),
      note: line.note,
      sourceOrderLineId: line.sourceOrderLineId,
      /** What the catalogue says of the line today (the price change aside: the office prices again). */
      problems: lineProblems({ id: line.id, sizes, unitPriceShown: shown }, facts, false).map((problem) => ({ code: problem.code, size: problem.size, words: problem.words })),
    }
  })
  const totals = draftTotals(lines.map((line) => ({ sizes: line.sizes, unitPriceShown: priceOrNull(line.unitPriceShown) })), true)
  const open = row.status === 'SENT'
  return {
    request: {
      id: row.id,
      number: row.number,
      status: row.status as RequestStatus,
      words: REQUEST_STATUS_WORDS[row.status as RequestStatus],
      source: row.source as RequestSource,
      party: { id: row.partyId, code: party?.code ?? '', name: party?.legalName ?? '' },
      customerRef: row.customerRef,
      requestedDate: dayText(row.requestedDate),
      note: row.note,
      currency: row.currency,
      shipTo,
      sentAt: iso(row.sentAt),
      sentBy: row.sentById ? (names.get(row.sentById) ?? null) : null,
      decidedAt: iso(row.decidedAt),
      decidedBy: row.decidedById ? (names.get(row.decidedById) ?? null) : null,
      refuseReason: row.refuseReason,
      withdrawnAt: iso(row.withdrawnAt),
      salesOrder,
      quote,
      version: row.version,
      lines: views,
      summary: { lines: totals.lines, pieces: totals.pieces, netShown: asMoney('price', totals.net) },
    },
    may: { order: open && can(actor, ORDERS_MANAGE, scope), quote: open && can(actor, ORDERS_MANAGE, scope) && can(actor, QUOTES_MANAGE, scope), refuse: open && can(actor, ORDERS_MANAGE, scope) },
  }
}

export interface AcceptBody {
  readonly version: number
  readonly as: AcceptAs
  /** ORDER: the promise date (today or later), else none yet. */
  readonly promiseDate?: BusinessDate | null | undefined
  /** ORDER: a unit price per line typed by the office (else the customer's list price today; a price the grain filter dropped is not typed). */
  readonly lines?: readonly { readonly lineId: string; readonly unitPrice?: string | undefined }[] | undefined
}

const linesFor = (lines: readonly LineRow[], prices: AcceptBody['lines']) =>
  lines.map((line) => ({
    styleId: line.styleId,
    colourwayId: line.colourwayId,
    sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity })),
    unitPrice: prices?.find((entry) => entry.lineId === line.id)?.unitPrice,
    note: line.note,
  }))

export async function acceptRequest(caller: CommandCaller, requestId: string, body: AcceptBody, idempotencyKey?: string) {
  const { context, row } = await officeRequest(caller, requestId)
  const scope = { companyId: row.companyId, partyId: row.partyId }
  assertMay(context, ORDERS_MANAGE, scope, 'Order request')
  if (body.as === 'QUOTE' && !can(actorOf(context), QUOTES_MANAGE, scope)) throw new ForbiddenError('Making a quote needs quotes.manage for this customer.')
  const problem = decisionProblem(row.status as RequestStatus)
  if (problem) throw new InvalidStateError(problem)
  const lines = await caller.withClient((client) => readLines(client, [row.id]))
  for (const [index, entry] of (body.lines ?? []).entries()) if (!lines.some((line) => line.id === entry.lineId)) throw new ValidationError('Not a line of this request.', [{ path: `body/lines/${index}/lineId`, message: 'Not a line of this request.' }])
  const { result } = await command(caller, { name: 'portalOrdering.accept', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockRequest(tx, requestId, body.version)
    const again = decisionProblem(current.status as RequestStatus)
    if (again) throw new InvalidStateError(again)
    const fresh = await readLines(tx, [current.id])
    let salesOrderId: string | null = null
    let quoteId: string | null = null
    let made: { number: string; dropped: Dropped[]; warnings: string[] }
    if (body.as === 'ORDER') {
      const shipTo = current.shipToAddressId ? await tx.partyAddress.findUnique({ where: { id: current.shipToAddressId }, select: { status: true } }) : null
      const requested = dayText(current.requestedDate)
      const order: ManualOrderBody = {
        companyId: current.companyId,
        partyId: current.partyId,
        customerRef: current.customerRef,
        requestedDate: requested !== null && requested >= businessDate(now) ? requested : null,
        promiseDate: body.promiseDate ?? null,
        ...(shipTo?.status === 'ACTIVE' ? { shipToAddressId: current.shipToAddressId } : {}),
        internalNote: current.note ? `Order request ${current.number}: ${current.note}`.slice(0, 4000) : `Order request ${current.number}.`,
        lines: linesFor(fresh, body.lines),
      }
      const outcome = await makeManualOrderInCommand(tools, order, null)
      salesOrderId = outcome.orderId
      made = { number: outcome.number, dropped: [], warnings: [] }
    } else {
      const party = await tx.party.findUniqueOrThrow({ where: { id: current.partyId }, select: { language: true, paymentTermsId: true, paymentTerms: true, defaultDepositPct: true } })
      const outcome = await duplicateInto(
        tools,
        {
          from: { requestId: current.id },
          companyId: current.companyId,
          partyId: current.partyId,
          basis: 'NET',
          contactId: null,
          language: party.language,
          billToAddressId: null,
          shipToAddressId: current.shipToAddressId,
          promiseDate: null,
          paymentTermsId: party.paymentTermsId,
          paymentTerms: party.paymentTerms,
          termsText: null,
          termsVersion: null,
          depositPct: party.defaultDepositPct === null ? null : party.defaultDepositPct.toString(),
          depositKind: null,
          // A line priced at the list (the price shown) takes the customer's list price today; one with no price shown is 0
          // until the office types it on the quote.
          lines: fresh.map((line) => {
            const shown = priceText(priceOrNull(line.unitPriceShown) ?? '0')
            return { seq: line.seq, kind: 'SIZE_GRID' as const, styleId: line.styleId, colourwayId: line.colourwayId, description: null, note: line.note, unitPrice: shown, listUnitPrice: shown, sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: null })) }
          }),
        },
        { customerRef: current.customerRef },
      )
      quoteId = outcome.quoteId
      const number = (await tx.quote.findUniqueOrThrow({ where: { id: outcome.quoteId }, select: { number: true } })).number
      made = { number, dropped: outcome.dropped, warnings: outcome.warnings }
    }
    await tx.portalOrderRequest.update({ where: { id: current.id }, data: { status: 'ACCEPTED', decidedAt: now, decidedById: context.actorId, salesOrderId, quoteId, version: current.version + 1 }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: current.id, companyId: current.companyId, before: { status: 'SENT' }, after: { status: 'ACCEPTED', as: body.as, salesOrderId, quoteId, number: made.number, prices: markMoney('price', body.lines ?? []) } })
    tools.emit({ type: 'portal_order_request.accepted', subject: current.id, companyId: current.companyId, payload: { requestId: current.id, number: current.number!, partyId: current.partyId, salesOrderId, quoteId } })
    return { as: body.as, salesOrderId, quoteId, number: made.number, dropped: made.dropped, warnings: made.warnings }
  })
  return { ...(await officeRequestView(caller, requestId)), made: result }
}

export async function refuseRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { context, row } = await officeRequest(caller, requestId)
  assertMay(context, ORDERS_MANAGE, { companyId: row.companyId, partyId: row.partyId }, 'Order request')
  const state = decisionProblem(row.status as RequestStatus)
  if (state) throw new InvalidStateError(state)
  const words = refuseReasonProblem(body.reason)
  if (words) throw new ValidationError(words, [{ path: 'body/reason', message: words }])
  await command(caller, { name: 'portalOrdering.refuse', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const current = await lockRequest(tools.tx, requestId, body.version)
    const again = decisionProblem(current.status as RequestStatus)
    if (again) throw new InvalidStateError(again)
    const reason = body.reason.trim()
    await tools.tx.portalOrderRequest.update({ where: { id: current.id }, data: { status: 'REFUSED', decidedAt: tools.now, decidedById: context.actorId, refuseReason: reason, version: current.version + 1 }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: current.id, companyId: current.companyId, before: { status: 'SENT' }, after: { status: 'REFUSED' }, reason })
    tools.emit({ type: 'portal_order_request.refused', subject: current.id, companyId: current.companyId, payload: { requestId: current.id, number: current.number!, partyId: current.partyId } })
    return null
  })
  return officeRequestView(caller, requestId)
}

export { readRequest }
