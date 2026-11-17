import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { customerNumberOf, customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { RequestListQuery } from '@nexus/factory-domain/sales/portal-requests/contracts'
import { subjectOf } from '@nexus/factory-domain/sales/portal-requests/rules'
import { isOpenRequest, REQUEST_STATE_WORDS, requestStateOf, type PortalRequestState } from '@nexus/factory-domain/sales/portal-requests/state'
import { piecesOfSizes, sizesOf, type InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { portalReader, type PortalReader } from '../portal-orders/access'

/**
 * The customer's requests as its portal reads them (B-TH-103 partner-first, rule P1; B-TH-011 the real state; B-TH-105 its own
 * numbers). Two kinds of read, never mixed in one query (as portal-orders):
 *
 *   the partner's own (factory_partner_runtime, the party's row-level security and column grants of B-TH-009): its inquiries
 *   in the portal's company and their lines. A select names only partner-readable columns (never the assignee, the office note,
 *   the close words, the decline reason, the target price, the prospect, the mail, the tech pack, who typed it).
 *
 *   the tenant's (the office scope, read as the person, only AFTER the partner read found the party's own inquiries, and keyed
 *   by what that read returned): the quote each became and the order made from it (their status, number and the customer's own
 *   number), the delivery address, the styles' and colourways' names; B-TH-043: whether a declined one was "Not an order" (it
 *   then reads "Closed"; the reason itself is never answered).
 *
 * Another party's request answers "not found" (W37); nothing here names another customer or counts the others' requests.
 */

/** At most this many requests in one answer (a customer has far fewer open). */
export const REQUESTS_MAX = 500

const PARTNER_INQUIRY = {
  id: true,
  companyId: true,
  partyId: true,
  number: true,
  customerSeq: true,
  customerRef: true,
  shipToAddressId: true,
  source: true,
  status: true,
  request: true,
  receivedAt: true,
  wantedDate: true,
  quoteId: true,
  // B-TH-025: the order made straight from it (partner-readable since the TH-2 schema wave).
  salesOrderId: true,
  closedAt: true,
  updatedAt: true,
} as const satisfies Prisma.InquirySelect
type InquiryRow = Prisma.InquiryGetPayload<{ select: typeof PARTNER_INQUIRY }>

const PARTNER_LINE = { id: true, inquiryId: true, seq: true, styleId: true, colourwayId: true, colourText: true, description: true, sizes: true, quantity: true, note: true, unitPriceShown: true } as const satisfies Prisma.InquiryLineSelect
type LineRow = Prisma.InquiryLineGetPayload<{ select: typeof PARTNER_LINE }>

interface Made {
  readonly quote: { readonly id: string; readonly number: string; readonly status: string; readonly customerSeq: number | null; readonly sent: boolean; readonly updatedAt: Date } | null
  readonly order: { readonly id: string; readonly number: string; readonly status: string; readonly customerSeq: number | null; readonly updatedAt: Date } | null
  /** B-TH-043: declined as "Not an order" (the customer reads "Closed"). */
  readonly notAnOrder?: boolean
}

const ids = (values: readonly (string | null)[]): string[] => [...new Set(values.filter((value): value is string => value !== null))]
const dayOrNull = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const latest = (...dates: (Date | null | undefined)[]): Date => dates.filter((date): date is Date => date instanceof Date).reduce((a, b) => (a > b ? a : b))

/** The party's inquiries in the portal's company, newest first (partner scope). */
async function partnerInquiries(client: FactoryClient, companyId: string, where: Prisma.InquiryWhereInput = {}, take = REQUESTS_MAX + 1): Promise<InquiryRow[]> {
  return client.inquiry.findMany({ where: { AND: [{ companyId }, where] }, select: PARTNER_INQUIRY, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take })
}

/** What became of each inquiry (tenant scope as the person; ids from the party's own inquiries; the party checked again). */
async function madeOf(reader: PortalReader, rows: readonly InquiryRow[]): Promise<Map<string, Made>> {
  const quoteIds = ids(rows.map((row) => row.quoteId))
  // B-TH-025: the orders made straight from requests (no quote between): the customer reads the order's own state.
  const orderIds = ids(rows.map((row) => row.salesOrderId))
  // B-TH-043: the declined ones, to tell "Not an order" (the office's decline reason, never partner-readable) from a decline.
  const declinedIds = rows.filter((row) => row.status === 'DECLINED').map((row) => row.id)
  const made = new Map<string, Made>()
  if (quoteIds.length === 0 && orderIds.length === 0 && declinedIds.length === 0) return made
  const partyId = reader.session.partyId
  const { quotes, orders, direct, notAnOrder } = await reader.inTenant(async (client) => {
    const quotes = quoteIds.length === 0 ? [] : await client.quote.findMany({ where: { id: { in: quoteIds }, partyId }, select: { id: true, number: true, status: true, customerSeq: true, updatedAt: true, versions: { where: { sentAt: { not: null } }, select: { id: true }, take: 1 } } })
    const orders = quoteIds.length === 0 ? [] : await client.salesOrder.findMany({ where: { partyId, quoteVersion: { quoteId: { in: quoteIds } } }, select: { id: true, number: true, status: true, customerSeq: true, updatedAt: true, createdAt: true, quoteVersion: { select: { quoteId: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const direct = orderIds.length === 0 ? [] : await client.salesOrder.findMany({ where: { id: { in: orderIds }, partyId }, select: { id: true, number: true, status: true, customerSeq: true, updatedAt: true } })
    const notAnOrder = declinedIds.length === 0 ? [] : await client.inquiry.findMany({ where: { id: { in: declinedIds }, partyId, declineReason: 'NOT_AN_ORDER' }, select: { id: true } }) // B-TH-043
    return { quotes, orders, direct, notAnOrder }
  })
  for (const entry of notAnOrder) made.set(entry.id, { quote: null, order: null, notAnOrder: true }) // B-TH-043
  for (const row of rows) {
    // ---- B-TH-025: ORDERED, the order named on the request (the party checked again in the tenant read).
    const straight = row.salesOrderId ? direct.find((entry) => entry.id === row.salesOrderId) : undefined
    if (straight) {
      made.set(row.id, { quote: null, order: { id: straight.id, number: straight.number, status: straight.status, customerSeq: straight.customerSeq, updatedAt: straight.updatedAt } })
      continue
    }
    // ---- end B-TH-025
    if (!row.quoteId) continue
    const quote = quotes.find((entry) => entry.id === row.quoteId)
    if (!quote) continue
    const order = orders.find((entry) => entry.quoteVersion?.quoteId === quote.id) ?? null
    made.set(row.id, {
      quote: { id: quote.id, number: quote.number, status: quote.status, customerSeq: quote.customerSeq, sent: quote.versions.length > 0, updatedAt: quote.updatedAt },
      order: order ? { id: order.id, number: order.number, status: order.status, customerSeq: order.customerSeq, updatedAt: order.updatedAt } : null,
    })
  }
  return made
}

/** The customer's state of a request from its real states (B-TH-011). */
export function stateOfRow(row: Pick<InquiryRow, 'status'>, made: Made | undefined): { code: PortalRequestState; words: { it: string; en: string }; open: boolean; needsYou: boolean } {
  const code = requestStateOf({ status: row.status as InquiryStatus, quoteStatus: made?.quote?.status ?? null, orderStatus: made?.order?.status ?? null, declineReason: made?.notAnOrder ? 'NOT_AN_ORDER' : null })
  return { code, words: REQUEST_STATE_WORDS[code], open: isOpenRequest(code), needsYou: code === 'NEED_INFO' }
}

function rowOf(row: InquiryRow, lines: readonly LineRow[], made: Made | undefined) {
  const own = lines.filter((line) => line.inquiryId === row.id)
  return {
    id: row.id,
    // th2-backend step 7 (threads plan §0.5, counts do not leak): the customer's own reference ("#7"); the office keeps INQ-….
    number: customerRefOf('REQUEST', row.customerSeq) ?? '—',
    yourNumber: customerNumberOf('REQUEST', row.customerSeq),
    customerRef: row.customerRef,
    subject: subjectOf(null, row.request),
    state: stateOfRow(row, made),
    wantedDate: dayOrNull(row.wantedDate),
    receivedAt: toUtcIso(row.receivedAt),
    updatedAt: toUtcIso(latest(row.updatedAt, made?.quote?.updatedAt, made?.order?.updatedAt)),
    pieces: own.reduce((sum, line) => sum + (line.quantity ?? piecesOfSizes(sizesOf(line.sizes))), 0),
  }
}

/** GET /portal/inquiries: the party's requests (open by default), with the tiles' counts. */
export async function listRequests(app: FastifyInstance, request: FastifyRequest, query: RequestListQuery, _now: Date) {
  const reader = portalReader(app, request)
  const companyId = reader.session.company.id
  const { rows, lines } = await request.withClient(async (client) => {
    const rows = await partnerInquiries(client, companyId)
    const lines = rows.length === 0 ? [] : await client.inquiryLine.findMany({ where: { inquiryId: { in: rows.slice(0, REQUESTS_MAX).map((row) => row.id) } }, select: PARTNER_LINE, orderBy: [{ inquiryId: 'asc' }, { seq: 'asc' }] })
    return { rows, lines }
  })
  const all = rows.slice(0, REQUESTS_MAX)
  const made = await madeOf(reader, all)
  const viewed = all.map((row) => rowOf(row, lines, made.get(row.id)))
  const chosen = viewed.filter((row) => query.state === 'ALL' || (query.state === 'OPEN') === row.state.open)
  return {
    rows: chosen.slice(0, query.limit),
    counts: { needsYou: viewed.filter((row) => row.state.needsYou).length, open: viewed.filter((row) => row.state.open).length },
    complete: rows.length <= REQUESTS_MAX && chosen.length <= query.limit,
  }
}

/** The party's own request in the portal's company (partner scope), or 404: another party's request is never found (W37). */
export async function partnerRequest(request: FastifyRequest, companyId: string, inquiryId: string): Promise<InquiryRow> {
  if (!isUuid(inquiryId)) throw new NotFoundError('Request not found.')
  const [row] = await request.withClient((client) => partnerInquiries(client, companyId, { id: inquiryId }, 1))
  if (!row) throw new NotFoundError('Request not found.')
  return row
}

/** One request as the customer reads it (its record page, X-P-CUS-REQ). */
export async function requestViewOf(reader: PortalReader, request: FastifyRequest, row: InquiryRow) {
  const lines = await request.withClient((client) => client.inquiryLine.findMany({ where: { inquiryId: row.id }, select: PARTNER_LINE, orderBy: { seq: 'asc' } }))
  const made = (await madeOf(reader, [row])).get(row.id)
  const partyId = reader.session.partyId
  const named = await reader.inTenant(async (client) => ({
    shipTo: row.shipToAddressId ? await client.partyAddress.findFirst({ where: { id: row.shipToAddressId, partyId }, select: { id: true, name: true, line1: true, postalCode: true, city: true, country: true, approvalStatus: true } }) : null,
    styles: await client.style.findMany({ where: { id: { in: ids(lines.map((line) => line.styleId)) } }, select: { id: true, code: true, name: true } }),
    colourways: await client.colourway.findMany({ where: { id: { in: ids(lines.map((line) => line.colourwayId)) } }, select: { id: true, code: true, name: true } }),
  }))
  return {
    ...rowOf(row, lines, made),
    request: row.request,
    source: row.source,
    shipTo: named.shipTo ? { id: named.shipTo.id, name: named.shipTo.name, line1: named.shipTo.line1, postalCode: named.shipTo.postalCode, city: named.shipTo.city, country: named.shipTo.country, waiting: named.shipTo.approvalStatus === 'WAITING' } : null,
    lines: lines.map((line) => {
      const style = line.styleId ? named.styles.find((entry) => entry.id === line.styleId) : undefined
      const colourway = line.colourwayId ? named.colourways.find((entry) => entry.id === line.colourwayId) : undefined
      return {
        id: line.id,
        seq: line.seq,
        style: style ? { id: style.id, code: style.code, name: style.name } : null,
        colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null,
        colourText: line.colourText,
        description: line.description,
        sizes: sizesOf(line.sizes),
        quantity: line.quantity,
        note: line.note,
        unitPriceShown: asMoney('price', line.unitPriceShown === null ? null : priceText(line.unitPriceShown.toString())),
      }
    }),
    made: {
      // A quote is the customer's to open once a version of it was sent (the portal's quote view); before, the state says
      // "Quote being prepared" and names no number.
      // th2-backend step 7: the quote's and the order's own references of the customer ("#3", "#12"), never QT-… or SO-….
      quote: made?.quote?.sent ? { id: made.quote.id, number: customerRefOf('QUOTE', made.quote.customerSeq) ?? '—', yourNumber: customerNumberOf('QUOTE', made.quote.customerSeq), sent: true } : null,
      order: made?.order ? { id: made.order.id, number: customerRefOf('ORDER', made.order.customerSeq) ?? '—', yourNumber: customerNumberOf('ORDER', made.order.customerSeq) } : null,
    },
    closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
  }
}

/** GET /portal/inquiries/:inquiryId */
export async function readRequest(app: FastifyInstance, request: FastifyRequest, inquiryId: string, _now: Date) {
  const reader = portalReader(app, request)
  const row = await partnerRequest(request, reader.session.company.id, inquiryId)
  return requestViewOf(reader, request, row)
}
