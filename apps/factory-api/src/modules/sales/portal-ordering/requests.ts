import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { approvalView } from '@nexus/factory-domain/parties/address-approval'
import { withdrawProblem } from '@nexus/factory-domain/sales/portal-ordering/office'
import { reorderPlan, type PastLine } from '@nexus/factory-domain/sales/portal-ordering/reorder'
import { isGoodsLine } from '@nexus/factory-domain/sales/quotes/quotes'
import {
  draftTotals,
  headerProblems,
  heldWords,
  lineAmount,
  lineProblems,
  lineShapeProblems,
  ORDERING_LIMITS,
  piecesOfSizes,
  priceShown,
  REQUEST_NOTICE,
  REQUEST_STATUS_WORDS,
  type LineInput,
  type Problem,
  type RequestSource,
  type RequestStatus,
  type SizeAsk,
} from '@nexus/factory-domain/sales/portal-ordering/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { portalOf } from '../../../platform/auth/portal/service'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { portalReader, type PortalReader } from '../portal-orders/access'
import { factsOf, readCatalogue, type CustomerCatalogue } from './catalogue'
import { dayText, dayValue, iso, lockRequest, priceOrNull, readDraftFiles, readLines, readRequest, REQUEST_COLUMNS, type DraftFileRow, type LineRow, type Reader, type RequestRow } from './store'
import { catalogueLines, isCatalogueLine, type CatalogueLineRow } from './store' // B-CP-005
// B-TH-304: the customer's own order numbers in the catalogue door (pick A).
import { customerNumberOf, type CustomerNumber } from '@nexus/factory-domain/sales/customer-numbers'
// B-CP-070 (D11): who sends and who discards a draft.
import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_ORDER_REQUESTS_MANAGE } from '@nexus/factory-domain/sales/portal-ordering/permissions'
// B-CP-072: the draft's files by part, and whether files may go up here now (the outside-upload gate, D14).
import { draftFilesByPart } from '@nexus/factory-domain/sales/portal-ordering/draft-files'
import { PORTAL_UPLOAD } from '@nexus/factory-domain/auth/partners/permissions'
import { portalUploadWords } from '@nexus/factory-domain/threads/partner/uploads'
import { outsideUploadsWords } from '../../../platform/files/multipart/outside'
// B-CP-075: every kind of line, the people of a by-person line, the parts sent later, who saved it last, a 409 that names them.
import { StaleVersionError } from '../../../core/command'
import { partnerLocaleOf } from '@nexus/factory-domain/threads/partner/rules'
import { PEOPLE_LIMITS, PEOPLE_WORDS, personRow, personShapeProblems, type PersonInput } from '@nexus/factory-domain/sales/portal-ordering/people'
import { customLineProblems, draftStaleWords, MTM_CLOSED_WORDS, type CustomLineInput, type CustomLineKind } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { markEdited, PERSON_COLUMNS, readPeople, type PersonRow } from './store'
import { checkCustomLine, colleagueNameOf, customLineData, customLineFactsOf, customLineView, insertCustomLine, isCustomLine, isDraftSheet, madeToMeasureOf, ownSheetOf, piecesOfLine, problemView, sheetLinesOf, type MadeToMeasure } from './people'
// B-CP-076 (customer page plan 11 §1.3 D3): "Your price" — the customer's own net unit price per line, the price grain.
import { ownPriceView, type OwnPriced } from './people'

/**
 * The customer's order requests in the portal (B-W2b-190; SAL-074 "portal orders arrive as requests", the draft of
 * SAL-071/072/073; design portal.customer.neworder). Partner sessions inside their party (row-level security) and the
 * portal's company. B-CP-070 (customer page plan D11): a draft is kept with portal.orderDrafts.edit — the Buyer and the
 * Designer (the Admin follows) start it, fill it and discard one THEY started; sending and withdrawing stay
 * portal.orderRequests.manage (the Buyer, the Admin: one who may order also discards any draft). A role without the price
 * grain (the Designer) is shown and sends no price: the grain filter drops every marked field. `may` says what the reader may
 * do with the request now (held, never hidden: the page names who can).
 *
 *   GET    /portal/order-requests                    the party's requests (drafts first, then the newest)
 *   POST   /portal/order-requests                    a new DRAFT (how it starts: PICKER, REORDER, UPLOAD; the header)
 *   GET    /portal/order-requests/:id                the request: header, lines with their sizes, prices shown and now,
 *                                                    a reorder line's differences from the order it came from, the
 *                                                    problems that hold the send, totals, the delivery addresses
 *   PATCH  /portal/order-requests/:id                the header of a DRAFT (autosave: their PO, ship-to, date, note)
 *   POST   /portal/order-requests/:id/lines          styles picked (one line per style and colour, its size run)
 *   PUT    /portal/order-requests/:id/lines/:lineId  a line's sizes, note or colour
 *   DELETE /portal/order-requests/:id/lines/:lineId  a line out
 *   POST   /portal/order-requests/:id/prices         take today's prices on every line (after "Prices changed")
 *   DELETE /portal/order-requests/:id                discard the draft (it has no number)
 *   POST   /portal/order-requests/:id/send           the request goes to the office: numbered from the company's
 *                                                    PORTAL_REQUEST series in the tenant's office scope as the person
 *                                                    (the partner role has no numbering grant), SENT, Home › Approvals
 *   POST   /portal/order-requests/:id/withdraw       a SENT request back, before the office decided
 *
 * Every line is checked against the customer's catalogue today before it is written (./catalogue: the tenant's scope as
 * the person); a draft's line that the catalogue no longer holds as it was is named as a problem when the draft is read,
 * and the send is held until none is left. The price a line shows is the customer's list price the day it was added
 * (price grain only); a change since is a problem the customer accepts with /prices before sending: what is sent is what
 * was shown, and the office prices again when it makes the order.
 *
 * B-CP-076 (customer page plan 11 §1.3 D3): every line also keeps "Your price" (`brandUnitPrice`), the customer's own net unit
 * price, written with the line (add, change; a described or made-to-measure line too) by a person with the price grain — the
 * Buyer, the Admin; a Designer sends none (the grain filter refuses the field, 403) and reads none — frozen at Send with the line.
 * Accepted as an order, the office's accept carries it onto the order by its line map (OrderBrandPrice, source PORTAL).
 */

const MAX_DRAFTS = 20
const LIST_MAX = 200

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const today = (app: FastifyInstance): BusinessDate => businessDate(appClock(app).now())

// ---- reads -----------------------------------------------------------------------------------------------------------

/** The request of the party in the portal's company, read in the partner scope, or 404. */
export async function ownRequest(request: FastifyRequest, reader: PortalReader, requestId: string): Promise<RequestRow> {
  const row = await request.withClient((client) => readRequest(client, requestId))
  if (!row || row.companyId !== reader.session.company.id) throw new NotFoundError('Order request not found.')
  return row
}

export interface SourceFacts {
  readonly orderLineId: string
  readonly orderId: string
  readonly orderNumber: string
  /** B-TH-304: the customer's own number of the order ("Your order 12"; pick A). */
  readonly yourNumber: CustomerNumber | null
  readonly customerRef: string | null
  readonly orderDate: string
  readonly line: PastLine
}

/** The order lines reorder lines came from (the partner's own: price grain, never cost), with their revision number. */
async function sourcesOf(request: FastifyRequest, reader: PortalReader, lines: readonly LineRow[]): Promise<Map<string, SourceFacts>> {
  const ids = [...new Set(lines.flatMap((line) => (line.sourceOrderLineId ? [line.sourceOrderLineId] : [])))]
  if (ids.length === 0) return new Map()
  const rows = await request.withClient((client) =>
    client.salesOrderLine.findMany({
      where: { id: { in: ids } },
      select: { id: true, kind: true, unitPrice: true, styleRevisionId: true, order: { select: { id: true, number: true, customerRef: true, orderDate: true, customerSeq: true /* B-TH-304 */ } }, sizes: { select: { size: true, quantity: true } } },
    }),
  )
  const revisionIds = [...new Set(rows.flatMap((row) => (row.styleRevisionId ? [row.styleRevisionId] : [])))]
  const revisions = revisionIds.length === 0 ? new Map<string, number>() : await reader.inTenant(async (db) => new Map((await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision])))
  // W2b-5 (B-W2b-280): a fee line is never a reorder's source.
  return new Map(
    rows.filter(isGoodsLine).map((row) => [
      row.id,
      {
        orderLineId: row.id,
        orderId: row.order.id,
        orderNumber: row.order.number,
        yourNumber: customerNumberOf('ORDER', row.order.customerSeq), // B-TH-304
        customerRef: row.order.customerRef,
        orderDate: dayText(row.order.orderDate)!,
        line: {
          kind: row.kind,
          unitPrice: row.unitPrice.toString(),
          revision: row.styleRevisionId ? (revisions.get(row.styleRevisionId) ?? null) : null,
          sizes: row.sizes.filter((size) => size.size !== null && size.quantity > 0).map((size) => ({ size: size.size!, quantity: size.quantity })),
        },
      },
    ]),
  )
}

/** The party's delivery addresses (partner scope): every SHIP_TO one, active first. */
export async function shipToAddresses(request: FastifyRequest) {
  const rows = await request.withClient((client) =>
    client.partyAddress.findMany({
      where: { kinds: { has: 'SHIP_TO' } },
      select: { id: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, contactName: true, phone: true, deliveryNotes: true, isDefaultShipTo: true, status: true, approvalStatus: true, refuseReason: true, version: true },
      orderBy: [{ status: 'asc' }, { isDefaultShipTo: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }),
  )
  return rows
}

const sizesOf = (line: LineRow): SizeAsk[] => line.sizes.map((row) => ({ size: row.size, quantity: row.quantity }))

/** One line as the customer sees it. */
// B-CP-005: a catalogue line (its style, colourway, sizes offered and list price); the other kinds are B-CP-075's.
function lineView(line: CatalogueLineRow, catalogue: CustomerCatalogue, source: SourceFacts | null, seesPrices: boolean) {
  const facts = factsOf(catalogue, line.styleId, line.colourwayId)
  const style = catalogue.styles.get(line.styleId)
  const code = catalogue.codes.get(line.styleId)
  const colourway = catalogue.colourways.get(line.colourwayId)
  const sizes = sizesOf(line)
  const shown = priceOrNull(line.unitPriceShown)
  const pieces = piecesOfSizes(sizes)
  const range = style?.range ?? []
  const ordered = [...sizes].sort((a, b) => (range.indexOf(a.size) === -1 ? 999 : range.indexOf(a.size)) - (range.indexOf(b.size) === -1 ? 999 : range.indexOf(b.size)))
  return {
    id: line.id,
    seq: line.seq,
    version: line.version,
    kind: 'CATALOGUE' as const, // B-CP-075
    style: { id: line.styleId, code: code?.code ?? '', name: code?.name ?? '' },
    colourway: { id: line.colourwayId, code: colourway?.code ?? '', name: colourway?.name ?? '' },
    sizes: ordered.map((row) => ({ size: row.size, quantity: row.quantity, offered: facts?.offered.includes(row.size) ?? false })),
    /** The sizes the colourway offers today (the grid's columns), in range order. */
    offered: [...(facts?.offered ?? [])],
    /** The style's other colours the customer may choose (a discontinued colour). */
    colours: style ? style.colourways.filter((entry) => entry.available).map((entry) => ({ id: entry.id, code: entry.code, name: entry.name })) : [],
    pieces,
    unitPriceShown: asMoney('price', shown === null ? null : priceShown(shown)),
    priceNow: asMoney('price', facts?.priceNow ? priceShown(facts.priceNow) : null),
    amount: asMoney('price', lineAmount(shown, pieces)),
    note: line.note,
    source: source ? { orderLineId: source.orderLineId, orderId: source.orderId, orderNumber: source.orderNumber, yourNumber: source.yourNumber /* B-TH-304 */, customerRef: source.customerRef, orderDate: source.orderDate } : null,
    /** A reorder line's differences from the order it came from (named again whenever the draft is read). */
    notices: source ? [...reorderPlan(source.line, facts, seesPrices).notices] : [],
    problems: lineProblems({ id: line.id, sizes, unitPriceShown: shown }, facts, seesPrices).map(problemView),
    brandUnitPrice: ownPriceView(line), // B-CP-076
  }
}

// B-CP-075: problemView (./people.ts) also names the part of the checklist and the person a problem is on.
const NO_MTM: MadeToMeasure = { open: false, garmentTypes: [] }

/** The request as the customer reads it (any status). */
export async function requestView(app: FastifyInstance, request: FastifyRequest, reader: PortalReader, row: RequestRow) {
  const day = today(app)
  const lines = await request.withClient((client) => readLines(client, [row.id]))
  // B-CP-005: the catalogue lines are read with the catalogue; a described or made-to-measure line is shown by its kind
  // (B-CP-075: `customLines`), not as a style it does not have (it still counts in the header and the totals).
  const listed = catalogueLines(lines)
  const draft = row.status === 'DRAFT'
  // ---- B-CP-075: the lines of the customer's own kinds and their people; made to measure for it, who saved it last (the tenant's
  // scope: the catalogue, the measurement templates, the portal settings and the colleague's name are the office's rows).
  const custom = lines.filter(isCustomLine)
  const people = await request.withClient((client) => readPeople(client, [row.id]))
  const styleIds = [...listed.map((line) => line.styleId), ...custom.flatMap((line) => (line.styleId ? [line.styleId] : []))]
  const { catalogue, mtm, editedBy } = await reader.inTenant(async (db) => ({
    catalogue: await readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day, styleIds }),
    mtm: draft || custom.length > 0 ? await madeToMeasureOf(db, row.companyId, row.partyId) : NO_MTM,
    editedBy: await colleagueNameOf(db, row.partyId, row.lastEditedById),
  }))
  // ---- end B-CP-075
  const sources = await sourcesOf(request, reader, lines)
  const addresses = await shipToAddresses(request)
  const views = listed.map((line) => lineView(line, catalogue, line.sourceOrderLineId ? (sources.get(line.sourceOrderLineId) ?? null) : null, reader.seesPrices))
  // end B-CP-005
  // B-CP-072: its files (the party's own, partner scope) by part; on live, files wait for the virus scanner (the e-mail way).
  const stored = await request.withClient((client) => readDraftFiles(client, [row.id], lines.map((line) => line.id)))
  const files = draftFilesByPart(stored, row.id)
  const closed = uploadsClosed(reader, row)
  // B-CP-075: a by-person line's people (a sheet named: the customer's own file); a sheet on a line stands for its roster.
  const sheetLines = sheetLinesOf(stored)
  const sheetOf = ownSheetOf(stored)
  const customViews = custom.map((line) => customLineView(line, people, sheetLines, catalogue, mtm, sheetOf))
  const shipTo = row.shipToAddressId ? addresses.find((address) => address.id === row.shipToAddressId) : undefined
  const problems = draft
    ? [
        ...headerProblems({ requestedDate: dayText(row.requestedDate), shipToActive: row.shipToAddressId === null ? null : shipTo?.status === 'ACTIVE', lineCount: lines.length }, day).map(problemView),
        // B-CP-075: every line's, in the draft's order (catalogue and custom lines by seq).
        ...[...views, ...customViews].sort((a, b) => a.seq - b.seq).flatMap((line) => line.problems),
      ]
    : []
  const totals = draftTotals(lines.map((line) => ({ sizes: sizesOf(line), unitPriceShown: priceOrNull(line.unitPriceShown), pieces: piecesOfLine(line, people) /* B-CP-075 */ })), reader.seesPrices)
  const outcome = await outcomeOf(request, row)
  const may = mayOn(reader, row) // B-CP-070
  return {
    request: {
      id: row.id,
      number: row.number,
      status: row.status as RequestStatus,
      words: REQUEST_STATUS_WORDS[row.status as RequestStatus],
      source: row.source as RequestSource,
      customerRef: row.customerRef,
      shipToAddressId: row.shipToAddressId,
      requestedDate: dayText(row.requestedDate),
      note: row.note,
      currency: row.currency,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
      sentAt: iso(row.sentAt),
      decidedAt: iso(row.decidedAt),
      refuseReason: row.refuseReason,
      withdrawnAt: iso(row.withdrawnAt),
      salesOrder: outcome.salesOrder,
      quote: outcome.quote,
      version: row.version,
      lines: views,
      summary: { lines: totals.lines, pieces: totals.pieces, net: asMoney('price', totals.net) },
      problems,
      held: heldWords(problems.length),
      pricesChanged: views.filter((line) => line.problems.some((problem) => problem.code === 'PRICE_CHANGED')).length,
      notice: REQUEST_NOTICE,
      // B-CP-070: send / withdraw (who may order), discard (who may order, or the one who started the draft).
      may: { send: draft && may.order, withdraw: row.status === 'SENT' && may.order, discard: draft && may.discard },
      // B-CP-072: logos, references and measurement sheets (the draft's own and its lines'); uploads open here, or why not.
      files: { logos: files.logos.map(draftFileView), references: files.references.map(draftFileView), sheets: files.sheets.map(draftFileView) },
      uploads: { open: closed === null, words: closed },
      // ---- B-CP-075
      customLines: customViews,
      laterParts: [...row.laterParts],
      lastEditedBy: editedBy,
      lastEditedAt: iso(row.lastEditedAt),
      madeToMeasure: draft ? { open: mtm.open, words: mtm.open ? null : MTM_CLOSED_WORDS, garmentTypes: mtm.open ? [...mtm.garmentTypes] : [] } : null,
      // ---- end B-CP-075
    },
    addresses: addresses.map(({ approvalStatus, refuseReason, ...address }) => ({ ...address, isDefault: address.isDefaultShipTo, approval: approvalView({ approvalStatus, refuseReason }) })),
    seesPrices: reader.seesPrices,
  }
}

// ---- B-CP-070 (D11): who sends, who discards ------------------------------------------------------------------------------

/** What the reader may do with the request beside filling a draft: order (send, withdraw), discard the draft. */
function mayOn(reader: PortalReader, row: Pick<RequestRow, 'companyId' | 'partyId' | 'createdById'>): { readonly order: boolean; readonly discard: boolean } {
  if (reader.session.preview) return { order: false, discard: false }
  const order = can(reader.actor, PORTAL_ORDER_REQUESTS_MANAGE, { companyId: row.companyId, partyId: row.partyId })
  return { order, discard: order || row.createdById === reader.session.userId }
}

/** The refusal of a discard by a colleague who neither orders nor started the draft (the page names who may). */
const DISCARD_HELD = 'Only the colleague who started this draft, or one who may send orders, discards it.'
// ---- end B-CP-070

/** B-CP-072: why files cannot go up onto this request now, in the person's words (null: they can) — said before one is dropped. */
function uploadsClosed(reader: PortalReader, row: Pick<RequestRow, 'status' | 'companyId' | 'partyId'>): string | null {
  const gate = outsideUploadsWords()
  if (gate !== null) return gate
  if (row.status !== 'DRAFT') return portalUploadWords('REQUEST_CLOSED', reader.session.person.locale)
  if (reader.session.preview) return 'A preview of the portal sends no file.'
  return can(reader.actor, PORTAL_UPLOAD, { companyId: row.companyId, partyId: row.partyId }) ? null : portalUploadWords('NO_UPLOAD', reader.session.person.locale)
}

/** B-CP-072: a draft's file as the customer reads it (its own party's: named, with its version for a removal). */
export const draftFileView = (file: DraftFileRow & { readonly lineId: string | null }) => ({
  id: file.id,
  lineId: file.lineId,
  originalName: file.originalName,
  kind: file.kind,
  contentType: file.contentType,
  sizeBytes: file.sizeBytes,
  status: file.status,
  version: file.version,
  createdAt: iso(file.createdAt)!,
})

/** The order or quote a request became (partner reads: their number). */
async function outcomeOf(request: FastifyRequest, row: Pick<RequestRow, 'salesOrderId' | 'quoteId'>) {
  const salesOrder = row.salesOrderId ? await request.withClient((client) => client.salesOrder.findUnique({ where: { id: row.salesOrderId! }, select: { id: true, number: true } })) : null
  const quote = row.quoteId ? await request.withClient((client) => client.quote.findUnique({ where: { id: row.quoteId! }, select: { id: true, number: true } })) : null
  return { salesOrder: salesOrder ?? null, quote: quote ?? null }
}

export async function listRequests(app: FastifyInstance, request: FastifyRequest, query: { readonly status: RequestStatus | 'ALL' }) {
  const reader = portalReader(app, request)
  const rows = await request.withClient((client) =>
    client.portalOrderRequest.findMany({
      where: { companyId: reader.session.company.id, ...(query.status === 'ALL' ? {} : { status: query.status }) },
      select: REQUEST_COLUMNS,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: LIST_MAX,
    }),
  )
  const ordered = [...rows.filter((row) => row.status === 'DRAFT'), ...rows.filter((row) => row.status !== 'DRAFT')]
  const lines = await request.withClient((client) => readLines(client, ordered.map((row) => row.id)))
  const people = await request.withClient((client) => readPeople(client, ordered.map((row) => row.id))) // B-CP-075: a by-person line's pieces are its people
  const orders = await request.withClient((client) => client.salesOrder.findMany({ where: { id: { in: ordered.flatMap((row) => (row.salesOrderId ? [row.salesOrderId] : [])) } }, select: { id: true, number: true } }))
  const quotes = await request.withClient((client) => client.quote.findMany({ where: { id: { in: ordered.flatMap((row) => (row.quoteId ? [row.quoteId] : [])) } }, select: { id: true, number: true } }))
  return {
    requests: ordered.map((row) => {
      const own = lines.filter((line) => line.requestId === row.id)
      const totals = draftTotals(own.map((line) => ({ sizes: sizesOf(line), unitPriceShown: priceOrNull(line.unitPriceShown), pieces: piecesOfLine(line, people) /* B-CP-075 */ })), reader.seesPrices)
      return {
        id: row.id,
        number: row.number,
        status: row.status as RequestStatus,
        words: REQUEST_STATUS_WORDS[row.status as RequestStatus],
        source: row.source as RequestSource,
        customerRef: row.customerRef,
        requestedDate: dayText(row.requestedDate),
        lines: totals.lines,
        pieces: totals.pieces,
        net: asMoney('price', totals.net),
        currency: row.currency,
        createdAt: iso(row.createdAt)!,
        updatedAt: iso(row.updatedAt)!,
        sentAt: iso(row.sentAt),
        decidedAt: iso(row.decidedAt),
        salesOrder: orders.find((order) => order.id === row.salesOrderId) ?? null,
        quote: quotes.find((quote) => quote.id === row.quoteId) ?? null,
        version: row.version,
      }
    }),
    seesPrices: reader.seesPrices,
  }
}

export async function getRequest(app: FastifyInstance, request: FastifyRequest, requestId: string) {
  const reader = portalReader(app, request)
  return requestView(app, request, reader, await ownRequest(request, reader, requestId))
}

// ---- the draft's header ------------------------------------------------------------------------------------------------

export interface HeaderBody {
  readonly customerRef?: string | null | undefined
  readonly shipToAddressId?: string | null | undefined
  readonly requestedDate?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
  /** B-CP-075: the parts the customer sends later (LOGOS, REFERENCES, PEOPLE), each once; [] clears them. */
  readonly laterParts?: readonly ('LOGOS' | 'REFERENCES' | 'PEOPLE')[] | undefined
}

/** The header's own problems (400): an address of the party for deliveries, active; a date from today. */
async function headerIssues(request: FastifyRequest, body: HeaderBody, day: BusinessDate): Promise<Issue[]> {
  const issues: Issue[] = []
  if (body.shipToAddressId) {
    const address = isUuid(body.shipToAddressId) ? await request.withClient((client) => client.partyAddress.findUnique({ where: { id: body.shipToAddressId! }, select: { status: true, kinds: true } })) : null
    if (!address || address.status !== 'ACTIVE' || !address.kinds.includes('SHIP_TO')) issues.push({ path: 'body/shipToAddressId', message: 'Choose one of your active delivery addresses.' })
  }
  if (body.requestedDate && body.requestedDate < day) issues.push({ path: 'body/requestedDate', message: 'The requested delivery date is today or later.' })
  if (body.customerRef && body.customerRef.trim().length > ORDERING_LIMITS.customerRef) issues.push({ path: 'body/customerRef', message: `At most ${ORDERING_LIMITS.customerRef} characters.` })
  if (body.note && body.note.trim().length > ORDERING_LIMITS.note) issues.push({ path: 'body/note', message: `At most ${ORDERING_LIMITS.note} characters.` })
  if (body.laterParts && new Set(body.laterParts).size !== body.laterParts.length) issues.push({ path: 'body/laterParts', message: 'Name each part sent later once.' }) // B-CP-075
  return issues
}

const headerData = (body: HeaderBody) => ({
  ...(body.customerRef !== undefined ? { customerRef: blankToNull(body.customerRef) } : {}),
  ...(body.shipToAddressId !== undefined ? { shipToAddressId: body.shipToAddressId } : {}),
  ...(body.requestedDate !== undefined ? { requestedDate: body.requestedDate === null ? null : dayValue(body.requestedDate) } : {}),
  ...(body.note !== undefined ? { note: blankToNull(body.note) } : {}),
  ...(body.laterParts !== undefined ? { laterParts: [...body.laterParts] } : {}), // B-CP-075
})

export async function createDraft(app: FastifyInstance, request: FastifyRequest, body: HeaderBody & { readonly source?: RequestSource | undefined }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const { session } = reader
  const day = today(app)
  const issues = await headerIssues(request, body, day)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const drafts = await request.withClient((client) => client.portalOrderRequest.count({ where: { companyId: session.company.id, status: 'DRAFT' } }))
  if (drafts >= MAX_DRAFTS) throw new ConflictError(`You keep ${drafts} drafts already: send or discard one first.`)
  const currency = await reader.inTenant(async (db) => (await db.company.findUnique({ where: { id: session.company.id }, select: { currency: true } }))?.currency ?? 'EUR')
  const id = newId()
  await commandOn(app, request, { name: 'portalOrdering.createDraft', idempotencyKey, input: { ...body } }, async (tools) => {
    // The party's default delivery address when none is asked.
    const shipTo = body.shipToAddressId === undefined ? ((await tools.tx.partyAddress.findFirst({ where: { status: 'ACTIVE', isDefaultShipTo: true, kinds: { has: 'SHIP_TO' } }, select: { id: true } }))?.id ?? null) : body.shipToAddressId
    await tools.tx.portalOrderRequest.create({
      data: { id, companyId: session.company.id, partyId: session.partyId, source: body.source ?? 'PICKER', currency, ...headerData(body), shipToAddressId: shipTo, createdById: session.userId, createdAt: tools.now, updatedAt: tools.now, lastEditedById: session.userId, lastEditedAt: tools.now /* B-CP-075 */ },
      select: { id: true },
    })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: id, companyId: session.company.id, after: { status: 'DRAFT', source: body.source ?? 'PICKER', ...headerData(body), shipToAddressId: shipTo } })
    draftChanged(tools, { id, companyId: session.company.id, partyId: session.partyId }) // B-CP-071
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, id))!)
}

/** The draft of the party, for a change by its own session: DRAFT, or 409 in words. */
export async function ownDraft(request: FastifyRequest, reader: PortalReader, requestId: string): Promise<RequestRow> {
  const row = await ownRequest(request, reader, requestId)
  if (row.status !== 'DRAFT') throw new InvalidStateError(row.status === 'SENT' ? 'This request was sent: withdraw it to change it, or ask us.' : 'This request is no longer a draft.')
  return row
}

/**
 * A change of the draft in the partner scope: its version checked and moved (command's record guard), then the work.
 * B-CP-075: every one names who of the customer saved it ("Saved 10:42 by Marta Bianchi"); a stale version is a 409 that names
 * the colleague who changed it meanwhile (`staleDraftError`).
 */
export async function onDraft<Result>(app: FastifyInstance, request: FastifyRequest, name: `${string}.${string}`, row: RequestRow, version: number, input: unknown, idempotencyKey: string | undefined, work: (tools: CommandTools) => Promise<Result>) {
  try {
    return await commandOn(app, request, { name, idempotencyKey, input, record: { type: 'PortalOrderRequest', id: row.id, expectedVersion: version } }, async (tools) => {
      const current = await readRequest(tools.tx, row.id)
      if (current?.status !== 'DRAFT') throw new InvalidStateError('This request is no longer a draft.')
      const result = await work(tools)
      await markEdited(tools.tx, row.id, tools.context.actorId, tools.now) // B-CP-075
      draftChanged(tools, row) // B-CP-071
      return result
    })
  } catch (error) {
    throw error instanceof StaleVersionError ? await staleDraftError(app, request, row.id) : error // B-CP-075
  }
}

// ---- B-CP-075: "Changed by Marta Bianchi a moment ago" -------------------------------------------------------------------------
/** The 409 of a draft changed since the person read it: who of their party saved it last (never an office name), the version now. */
export async function staleDraftError(app: FastifyInstance, request: FastifyRequest, requestId: string): Promise<DomainError> {
  const reader = portalReader(app, request)
  const current = await request.withClient((client) => readRequest(client, requestId))
  if (!current) return new NotFoundError('Order request not found.')
  const self = current.lastEditedById !== null && current.lastEditedById === reader.session.userId
  const name = self ? null : await reader.inTenant((db) => colleagueNameOf(db, current.partyId, current.lastEditedById))
  const words = draftStaleWords({ name, self, version: current.version })[partnerLocaleOf(reader.session.person.locale)]
  return new DomainError('conflict', words, [{ path: 'version', message: `The current version is ${current.version}.` }, ...(name ? [{ path: 'lastEditedBy', message: name }] : [])])
}
// ---- end B-CP-075

// ---- B-CP-071 (customer page plan D10; review C2): each change of a draft, one per command, tells the office's Drafts of the
// customer to read again — ids only; the party routes the live message (a person limited to another customer is never told).
export function draftChanged(tools: Pick<CommandTools, 'emit'>, row: Pick<RequestRow, 'id' | 'companyId' | 'partyId'>): void {
  tools.emit({ type: 'portal_order_request.draft_changed', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, partyId: row.partyId } })
}
// ---- end B-CP-071

export async function changeHeader(app: FastifyInstance, request: FastifyRequest, requestId: string, body: HeaderBody & { readonly version: number }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  const { version, ...header } = body
  const issues = await headerIssues(request, header, today(app))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  await onDraft(app, request, 'portalOrdering.changeDraft', row, version, { requestId, ...body }, idempotencyKey, async (tools) => {
    const data = headerData(header)
    if (Object.keys(data).length > 0) await tools.tx.portalOrderRequest.update({ where: { id: row.id }, data, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { customerRef: row.customerRef, shipToAddressId: row.shipToAddressId, requestedDate: dayText(row.requestedDate), note: row.note, laterParts: [...row.laterParts] /* B-CP-075 */ }, after: data })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

// ---- lines -------------------------------------------------------------------------------------------------------------

export interface NewLine extends LineInput, OwnPriced /* B-CP-076 */ {
  readonly sourceOrderLineId?: string | null | undefined
}

/** The lines asked, checked against the catalogue today: each style sold, the colour available, every size offered. */
export function checkNewLines(lines: readonly NewLine[], catalogue: CustomerCatalogue, at = 'body/lines'): Issue[] {
  const issues: Issue[] = []
  for (const [index, line] of lines.entries()) {
    for (const message of lineShapeProblems(line)) issues.push({ path: `${at}/${index}`, message })
    const facts = factsOf(catalogue, line.styleId, line.colourwayId)
    if (!facts || !facts.sold) issues.push({ path: `${at}/${index}/styleId`, message: 'Not a style of your catalogue.' })
    else if (catalogue.colourways.get(line.colourwayId)?.styleId !== line.styleId || !facts.colourwayActive) issues.push({ path: `${at}/${index}/colourwayId`, message: `Not an available colour of ${facts.styleCode}.` })
    else for (const ask of line.sizes) if (!facts.offered.includes(ask.size.trim())) issues.push({ path: `${at}/${index}/sizes`, message: `Size ${ask.size} is not offered for ${facts.styleCode}.` })
  }
  return issues
}

/** Writes one line and its sizes (partner scope, inside the draft's command). */
async function insertLine(tx: CommandTx, row: RequestRow, line: NewLine, seq: number, price: string | null, actorId: string, now: Date): Promise<string> {
  const id = newId()
  await tx.portalOrderRequestLine.create({
    data: { id, partyId: row.partyId, requestId: row.id, seq, styleId: line.styleId, colourwayId: line.colourwayId, sourceOrderLineId: line.sourceOrderLineId ?? null, unitPriceShown: price, note: blankToNull(line.note), brandUnitPrice: line.brandUnitPrice ?? null /* B-CP-076 */, createdById: actorId, createdAt: now, updatedAt: now },
    select: { id: true },
  })
  await tx.portalOrderRequestSize.createMany({ data: line.sizes.map((ask) => ({ id: newId(), partyId: row.partyId, lineId: id, size: ask.size.trim(), quantity: ask.quantity, createdById: actorId, createdAt: now, updatedAt: now })) })
  return id
}

export interface AddOutcome {
  readonly added: readonly string[]
  /** Sizes added to a line the draft already had for that style and colour. */
  readonly merged: readonly { readonly lineId: string; readonly size: string }[]
  /** Sizes a line of the draft already had: the draft's quantity was kept. */
  readonly kept: readonly { readonly lineId: string; readonly size: string }[]
}

/**
 * Inside the draft's command: the lines added. `merge`: a style and colour the draft already has takes the sizes it did
 * not have (an upload, a reorder); otherwise it is refused (the picker: change the line's sizes there).
 */
export async function addLinesInCommand(tools: CommandTools, row: RequestRow, lines: readonly NewLine[], prices: ReadonlyMap<string, string | null>, actorId: string, merge: boolean): Promise<AddOutcome> {
  const { tx, now } = tools
  const existing = await readLines(tx, [row.id])
  // B-CP-005: a style and colour merges into a catalogue line only (a described line that names the customer's own style is
  // not the same line); the limit counts every line of the request.
  const byKey = new Map(catalogueLines(existing).map((line) => [`${line.styleId}|${line.colourwayId}`, { id: line.id, seq: line.seq, sizes: new Set(line.sizes.map((size) => size.size)) }]))
  let lineCount = existing.length
  // end B-CP-005
  let seq = existing.reduce((max, line) => Math.max(max, line.seq), 0)
  const added: string[] = []
  const merged: { lineId: string; size: string }[] = []
  const kept: { lineId: string; size: string }[] = []
  for (const [index, line] of lines.entries()) {
    const key = `${line.styleId}|${line.colourwayId}`
    const same = byKey.get(key)
    if (same) {
      if (!merge) throw new ValidationError('This style and colour is already on the request: change its sizes there.', [{ path: `body/lines/${index}`, message: `Already on line ${same.seq}: change its sizes there.` }])
      const fresh = line.sizes.filter((ask) => !same.sizes.has(ask.size))
      for (const ask of line.sizes) if (same.sizes.has(ask.size)) kept.push({ lineId: same.id, size: ask.size })
      if (fresh.length > 0) {
        await tx.portalOrderRequestSize.createMany({ data: fresh.map((ask) => ({ id: newId(), partyId: row.partyId, lineId: same.id, size: ask.size, quantity: ask.quantity, createdById: actorId, createdAt: now, updatedAt: now })) })
        await tx.portalOrderRequestLine.update({ where: { id: same.id }, data: { version: { increment: 1 } }, select: { id: true } })
        for (const ask of fresh) {
          same.sizes.add(ask.size)
          merged.push({ lineId: same.id, size: ask.size })
        }
      }
      continue
    }
    if (lineCount >= ORDERING_LIMITS.lines) throw new ValidationError(`At most ${ORDERING_LIMITS.lines} lines per request.`, [{ path: 'body/lines', message: `At most ${ORDERING_LIMITS.lines} lines per request.` }]) // B-CP-005: every line
    lineCount += 1 // B-CP-005
    seq += 1
    const id = await insertLine(tx, row, line, seq, prices.get(key) ?? null, actorId, now)
    added.push(id)
    byKey.set(key, { id, seq, sizes: new Set(line.sizes.map((ask) => ask.size)) })
  }
  return { added, merged, kept }
}

/** Today's price per style and colour of the lines (only for a person who sees prices: else none is shown). */
export function pricesFor(lines: readonly { readonly styleId: string; readonly colourwayId: string }[], catalogue: CustomerCatalogue, seesPrices: boolean): Map<string, string | null> {
  return new Map(lines.map((line) => [`${line.styleId}|${line.colourwayId}`, seesPrices ? (factsOf(catalogue, line.styleId, line.colourwayId)?.priceNow ?? null) : null]))
}

const trimmed = (lines: readonly NewLine[]): NewLine[] => lines.map((line) => ({ ...line, sizes: line.sizes.map((ask) => ({ size: ask.size.trim(), quantity: ask.quantity })) }))

export async function addLines(app: FastifyInstance, request: FastifyRequest, requestId: string, body: { readonly version: number; readonly lines: readonly NewLine[] }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  const lines = trimmed(body.lines.map((line) => ({ ...line, sourceOrderLineId: null })))
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(app), styleIds: lines.map((line) => line.styleId) }))
  const issues = checkNewLines(lines, catalogue)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const prices = pricesFor(lines, catalogue, reader.seesPrices)
  await onDraft(app, request, 'portalOrdering.addLines', row, body.version, { requestId, lines }, idempotencyKey, async (tools) => {
    const outcome = await addLinesInCommand(tools, row, lines, prices, reader.session.userId, false)
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { added: outcome.added, lines: lines.map((line) => ({ styleId: line.styleId, colourwayId: line.colourwayId, sizes: line.sizes, unitPriceShown: markMoney('price', prices.get(`${line.styleId}|${line.colourwayId}`) ?? null), brandUnitPrice: markMoney('price', line.brandUnitPrice ?? null) /* B-CP-076 */ })) } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

async function ownLine(tx: Reader, row: RequestRow, lineId: string): Promise<LineRow> {
  const line = isUuid(lineId) ? (await readLines(tx, [row.id])).find((entry) => entry.id === lineId) : undefined
  if (!line) throw new NotFoundError('Line not found.')
  return line
}

// B-CP-005: the catalogue line's own editor (colour, sizes, note): a described or made-to-measure line has no colourway or
// size grid of the catalogue to change here (B-CP-075 edits it by its kind).
async function ownCatalogueLine(tx: Reader, row: RequestRow, lineId: string): Promise<CatalogueLineRow> {
  const line = await ownLine(tx, row, lineId)
  if (!isCatalogueLine(line)) throw new InvalidStateError(`Line ${line.seq} is not from the catalogue: it has no colour or sizes of a catalogue style to change here.`)
  return line
}
// end B-CP-005

export async function changeLine(
  app: FastifyInstance,
  request: FastifyRequest,
  requestId: string,
  lineId: string,
  body: { readonly version: number; readonly colourwayId?: string | undefined; readonly sizes?: readonly SizeAsk[] | undefined; readonly note?: string | null | undefined } & OwnPriced /* B-CP-076 */,
  idempotencyKey?: string,
) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  const line = await request.withClient((client) => ownCatalogueLine(client, row, lineId)) // B-CP-005: a catalogue line
  const next: NewLine = { styleId: line.styleId, colourwayId: body.colourwayId ?? line.colourwayId, sizes: (body.sizes ?? sizesOf(line)).map((ask) => ({ size: ask.size.trim(), quantity: ask.quantity })), note: body.note === undefined ? line.note : body.note }
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(app), styleIds: [line.styleId] }))
  // Only a change of sizes or colour is checked against today's catalogue: a note alone keeps the line as it was.
  const touchesCatalogue = body.sizes !== undefined || body.colourwayId !== undefined
  const issues = touchesCatalogue ? checkNewLines([next], catalogue, 'body/line') : lineShapeProblems(next).filter((message) => message.includes('note')).map((message) => ({ path: 'body/note', message }))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const colourChanged = next.colourwayId !== line.colourwayId
  if (colourChanged) {
    // B-CP-005: a duplicate is another catalogue line of the same style and colour.
    const duplicate = catalogueLines(await request.withClient((client) => readLines(client, [row.id]))).find((entry) => entry.id !== line.id && entry.styleId === line.styleId && entry.colourwayId === next.colourwayId)
    if (duplicate) throw new ValidationError('This colour is already on the request.', [{ path: 'body/colourwayId', message: `Already on line ${duplicate.seq}.` }])
  }
  const price = colourChanged ? (pricesFor([next], catalogue, reader.seesPrices).get(`${next.styleId}|${next.colourwayId}`) ?? null) : priceOrNull(line.unitPriceShown)
  await onDraft(app, request, 'portalOrdering.changeLine', row, body.version, { requestId, lineId, ...body }, idempotencyKey, async (tools) => {
    const { tx, now } = tools
    const current = await ownLine(tx, row, lineId)
    if (body.sizes !== undefined) {
      await tx.portalOrderRequestSize.deleteMany({ where: { lineId } })
      await tx.portalOrderRequestSize.createMany({ data: next.sizes.map((ask) => ({ id: newId(), partyId: row.partyId, lineId, size: ask.size, quantity: ask.quantity, createdById: reader.session.userId, createdAt: now, updatedAt: now })) })
    }
    // B-CP-076: "Your price" with the line (absent keeps it, null clears it).
    const own = body.brandUnitPrice !== undefined ? { brandUnitPrice: body.brandUnitPrice } : {}
    await tx.portalOrderRequestLine.update({ where: { id: lineId }, data: { colourwayId: next.colourwayId, note: blankToNull(next.note), unitPriceShown: price, ...own, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      recordType: 'PortalOrderRequest',
      recordId: row.id,
      companyId: row.companyId,
      before: { lineId, colourwayId: current.colourwayId, sizes: sizesOf(current), note: current.note, unitPriceShown: markMoney('price', priceOrNull(current.unitPriceShown)), brandUnitPrice: markMoney('price', priceOrNull(current.brandUnitPrice)) /* B-CP-076 */ },
      after: { lineId, colourwayId: next.colourwayId, sizes: next.sizes, note: blankToNull(next.note), unitPriceShown: markMoney('price', price), brandUnitPrice: markMoney('price', body.brandUnitPrice === undefined ? priceOrNull(current.brandUnitPrice) : body.brandUnitPrice) /* B-CP-076 */ },
    })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

export async function removeLine(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  await onDraft(app, request, 'portalOrdering.removeLine', row, version, { requestId, lineId, version }, idempotencyKey, async (tools) => {
    const line = await ownLine(tools.tx, row, lineId)
    const people = await tools.tx.portalOrderRequestPerson.deleteMany({ where: { lineId } }) // B-CP-075: its roster goes with it
    // B-CP-075: its measurement sheets go too (draft-files.ts): a person of another line they measured is "sending later" again.
    const sheets = (await tools.tx.storedFile.findMany({ where: { recordType: 'PortalOrderRequestLine', recordId: lineId, category: 'MEASUREMENTS', status: { not: 'DELETED' } }, select: { id: true } })).map((file) => file.id)
    if (sheets.length > 0) await tools.tx.portalOrderRequestPerson.updateMany({ where: { requestId: row.id, measurementFileId: { in: sheets } }, data: { measureBy: 'LATER', measurementFileId: null, version: { increment: 1 } } })
    await tools.tx.portalOrderRequestSize.deleteMany({ where: { lineId } })
    await tools.tx.portalOrderRequestLine.delete({ where: { id: lineId }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { lineId, seq: line.seq, kind: line.kind, styleId: line.styleId, colourwayId: line.colourwayId, sizes: sizesOf(line), people: people.count }, after: { lineId: null } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

/** "Prices changed since you started — Review": every line takes the customer's price today. */
export async function takeTodaysPrices(app: FastifyInstance, request: FastifyRequest, requestId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  if (!reader.seesPrices) throw new InvalidStateError('Prices are not part of your access: the factory confirms them.')
  // B-CP-005: a list price is a catalogue line's; a described or made-to-measure line has none to take.
  const lines = catalogueLines(await request.withClient((client) => readLines(client, [row.id])))
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(app), styleIds: lines.map((line) => line.styleId) }))
  const prices = pricesFor(lines, catalogue, true)
  await onDraft(app, request, 'portalOrdering.takePrices', row, version, { requestId, version }, idempotencyKey, async (tools) => {
    const changed: { lineId: string; before: string | null; after: string | null }[] = []
    for (const line of catalogueLines(await readLines(tools.tx, [row.id]))) { // B-CP-005: catalogue lines only
      const now = prices.get(`${line.styleId}|${line.colourwayId}`) ?? null
      const before = priceOrNull(line.unitPriceShown)
      if (now === null || (before !== null && Number(before) === Number(now))) continue
      await tools.tx.portalOrderRequestLine.update({ where: { id: line.id }, data: { unitPriceShown: now, version: { increment: 1 } }, select: { id: true } })
      changed.push({ lineId: line.id, before, after: now })
    }
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { prices: markMoney('price', changed) } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

export async function discardDraft(app: FastifyInstance, request: FastifyRequest, requestId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  if (!mayOn(reader, row).discard) throw new ForbiddenError(DISCARD_HELD) // B-CP-070
  await commandOn(app, request, { name: 'portalOrdering.discardDraft', idempotencyKey, input: { requestId, version } }, async (tools) => {
    const current = await readRequest(tools.tx, row.id)
    if (!current || current.status !== 'DRAFT') throw new InvalidStateError('This request is no longer a draft.')
    if (current.version !== version) throw new StaleVersionError('PortalOrderRequest', row.id, current.version, version) // B-CP-075: named below
    const lines = await readLines(tools.tx, [row.id])
    await tools.tx.portalOrderRequestPerson.deleteMany({ where: { requestId: row.id } }) // B-CP-075: a discarded draft takes its people (personal data)
    await tools.tx.portalOrderRequestSize.deleteMany({ where: { lineId: { in: lines.map((line) => line.id) } } })
    await tools.tx.portalOrderRequestLine.deleteMany({ where: { requestId: row.id } })
    await tools.tx.portalOrderRequest.delete({ where: { id: row.id }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { status: 'DRAFT', lines: lines.length }, after: { discarded: true } })
    draftChanged(tools, row) // B-CP-071
    return null
  }).catch(async (error: unknown) => {
    throw error instanceof StaleVersionError ? await staleDraftError(app, request, row.id) : error // B-CP-075
  })
  return { discarded: true as const }
}

// ---- send and withdraw -------------------------------------------------------------------------------------------------

/** The problems of a draft today (the send's check): its header's and every line's, as the record shows them. */
async function sendProblems(tx: CommandTx, row: RequestRow, lines: readonly LineRow[], day: BusinessDate, seesPrices: boolean, /* B-CP-075 */ people: readonly PersonRow[]): Promise<Problem[]> {
  // B-CP-005: the catalogue's checks (sold, colour, sizes offered, price shown) for its own lines; the header counts every line.
  // B-CP-075: a described or made-to-measure line's own (its total, its people or sheet, made to measure open, its garment type).
  const listed = catalogueLines(lines)
  const custom = lines.filter(isCustomLine)
  const catalogue = await readCatalogue(tx, { companyId: row.companyId, partyId: row.partyId, day, styleIds: [...listed.map((line) => line.styleId), ...custom.flatMap((line) => (line.styleId ? [line.styleId] : []))] })
  const shipTo = row.shipToAddressId ? await tx.partyAddress.findUnique({ where: { id: row.shipToAddressId }, select: { status: true } }) : null
  const mtm = custom.length === 0 ? NO_MTM : await madeToMeasureOf(tx, row.companyId, row.partyId)
  const sheetLines = custom.length === 0 ? new Set<string>() : sheetLinesOf(await readDraftFiles(tx, [row.id], lines.map((line) => line.id)))
  return [
    ...headerProblems({ requestedDate: dayText(row.requestedDate), shipToActive: row.shipToAddressId === null ? null : shipTo?.status === 'ACTIVE', lineCount: lines.length }, day),
    ...listed.flatMap((line) => lineProblems({ id: line.id, sizes: sizesOf(line), unitPriceShown: priceOrNull(line.unitPriceShown) }, factsOf(catalogue, line.styleId, line.colourwayId), seesPrices)), // B-CP-005
    ...custom.flatMap((line) => customLineProblems(customLineFactsOf(line, people, sheetLines, catalogue, mtm))), // B-CP-075
  ]
}

/**
 * The send: in the tenant's office scope as the portal person (the numbering grant; the office role may move a DRAFT to
 * SENT with its number and nothing else, the guard holds it), checked again inside the command (the catalogue today, the
 * prices shown), the PORTAL_REQUEST number, SENT, its audit row and portal_order_request.sent. B-TH-041 (Owner decision 3): the
 * answer promises no time to confirm by — `confirmBy` stays in the answer as null until the portal's words drop it (B-TH-220).
 */
export async function sendRequest(app: FastifyInstance, request: FastifyRequest, requestId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const { session } = reader
  const row = await ownDraft(request, reader, requestId)
  if (row.version !== version) throw await staleDraftError(app, request, row.id) // B-CP-075: names who changed it
  const p = portalOf(app)
  const outcome = await p.auth.command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portalOrdering.send', idempotencyKey, input: { requestId, version, sessionId: session.id } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockRequest(tx, requestId, version)
    if (current.partyId !== session.partyId || current.companyId !== session.company.id) throw new NotFoundError('Order request not found.')
    if (current.status !== 'DRAFT') throw new InvalidStateError('This request was already sent.')
    const day = businessDate(now)
    const lines = await readLines(tx, [current.id])
    const people = await readPeople(tx, [current.id]) // B-CP-075
    const problems = await sendProblems(tx, current, lines, day, reader.seesPrices, people)
    if (problems.length > 0) throw new DomainError('invalid_state', `${problems.length === 1 ? '1 problem holds' : `${problems.length} problems hold`} the send: fix ${problems.length === 1 ? 'it' : 'them'} first.`, problems.map((entry) => ({ path: entry.lineId ? `lines/${entry.lineId}` : 'request', message: entry.words.en })))
    const number = await allocateNumber(tools, { companyId: current.companyId, kind: 'PORTAL_REQUEST' }, { type: 'PortalOrderRequest', id: current.id, date: day })
    await tx.portalOrderRequest.update({ where: { id: current.id }, data: { status: 'SENT', number: number.formatted, sentAt: now, sentById: session.userId, version: current.version + 1 }, select: { id: true } })
    // B-CP-075: each line's pieces by its kind; a request whose only people are in an attached sheet counts one (at least one person).
    const pieces = Math.max(1, lines.reduce((sum, line) => sum + piecesOfLine(line, people), 0))
    tools.audit({ recordType: 'PortalOrderRequest', recordId: current.id, companyId: current.companyId, before: { status: 'DRAFT' }, after: { status: 'SENT', number: number.formatted, lines: lines.length, pieces, byPartner: true } })
    tools.emit({ type: 'portal_order_request.sent', subject: current.id, companyId: current.companyId, payload: { requestId: current.id, number: number.formatted, partyId: current.partyId, source: current.source, lines: lines.length, pieces } })
    return { number: number.formatted }
  })
  const sent = await ownRequest(request, reader, requestId)
  const { number } = outcome.result
  const po = sent.customerRef
  return {
    ...(await requestView(app, request, reader, sent)),
    sent: {
      number,
      // B-TH-041: no promise of when we confirm.
      confirmBy: null,
      words: {
        it: `Richiesta d'ordine inviata${po ? ` — il vostro ordine ${po}` : ''}, la nostra richiesta ${number}. Vi confermiamo prezzo, quantità e data.`,
        en: `Order request sent${po ? ` — your PO ${po}` : ''}, our request ${number}. We confirm price, quantities and date with you.`,
      },
    },
  }
}

export async function withdrawRequest(app: FastifyInstance, request: FastifyRequest, requestId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownRequest(request, reader, requestId)
  const problem = withdrawProblem(row.status as RequestStatus)
  if (problem) throw new InvalidStateError(problem)
  await commandOn(app, request, { name: 'portalOrdering.withdraw', idempotencyKey, input: { requestId, version } }, async (tools) => {
    const current = await lockRequest(tools.tx, requestId, version)
    const again = withdrawProblem(current.status as RequestStatus)
    if (again) throw new InvalidStateError(again)
    await tools.tx.portalOrderRequest.update({ where: { id: requestId }, data: { status: 'WITHDRAWN', withdrawnAt: tools.now, version: current.version + 1 }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: requestId, companyId: current.companyId, before: { status: 'SENT' }, after: { status: 'WITHDRAWN', byPartner: true } })
    tools.emit({ type: 'portal_order_request.withdrawn', subject: requestId, companyId: current.companyId, payload: { requestId, number: current.number!, partyId: current.partyId } })
    return null
  })
  return requestView(app, request, reader, await ownRequest(request, reader, requestId))
}

// ---- B-CP-075 (customer page plan C5; 12 §2 parts 1 and 4; review A5, F1, F2): described and made-to-measure lines, and the
// people of a by-person line. Every write is a draft command at the draft's version (onDraft: one rule for every part), checked
// first against the customer's catalogue today and its made-to-measure facts; a line out is DELETE …/lines/:lineId (its people
// and files go with it).
//
//   POST   /portal/order-requests/:id/custom-lines                          a described or made-to-measure line
//   PUT    /portal/order-requests/:id/custom-lines/:lineId                  its words, colours, style, garment type, total, sizes, by person, note
//   POST   /portal/order-requests/:id/lines/:lineId/people                  people added to a by-person line (a pasted roster: many at once)
//   PUT    /portal/order-requests/:id/lines/:lineId/people/:personId       a person changed (name, number, size / sheet / later, note)
//   DELETE /portal/order-requests/:id/lines/:lineId/people/:personId?version=  a person off the line (the others keep their place)

export type CustomLineBody = Omit<CustomLineInput, 'kind'>

/** The catalogue (the styles a custom line names) and made to measure for the customer, in the tenant's scope. */
async function customFactsOf(app: FastifyInstance, reader: PortalReader, row: RequestRow, styleIds: readonly (string | null | undefined)[]) {
  const wanted = styleIds.filter((id): id is string => typeof id === 'string' && isUuid(id))
  return reader.inTenant(async (db) => ({ catalogue: await readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(app), styleIds: wanted }), mtm: await madeToMeasureOf(db, row.companyId, row.partyId) }))
}

/** Made to measure switched off for the customer: a made-to-measure line or its people are not written (409 in its words). */
function mtmClosed(reader: PortalReader): DomainError {
  const words = MTM_CLOSED_WORDS[partnerLocaleOf(reader.session.person.locale)]
  return new DomainError('invalid_state', words, [{ path: 'refusal/MTM_CLOSED', message: words }])
}

export async function addCustomLine(app: FastifyInstance, request: FastifyRequest, requestId: string, body: { readonly version: number; readonly line: CustomLineInput & OwnPriced /* B-CP-076 */ }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  const { catalogue, mtm } = await customFactsOf(app, reader, row, [body.line.styleId])
  if (body.line.kind === 'MADE_TO_MEASURE' && !mtm.open) throw mtmClosed(reader)
  const issues = checkCustomLine(body.line, catalogue, mtm)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  await onDraft(app, request, 'portalOrdering.addCustomLine', row, body.version, { requestId, line: body.line }, idempotencyKey, async (tools) => {
    const existing = await readLines(tools.tx, [row.id])
    if (existing.length >= ORDERING_LIMITS.lines) throw new ValidationError(`At most ${ORDERING_LIMITS.lines} lines per request.`, [{ path: 'body/line', message: `At most ${ORDERING_LIMITS.lines} lines per request.` }])
    const seq = existing.reduce((max, line) => Math.max(max, line.seq), 0) + 1
    const id = await insertCustomLine(tools.tx, row, body.line, seq, reader.session.userId, tools.now)
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { added: id, seq, kind: body.line.kind, ...customLineData(body.line), sizes: body.line.sizes ?? [], brandUnitPrice: markMoney('price', body.line.brandUnitPrice ?? null) /* B-CP-076 */ } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

/** The draft's described or made-to-measure line (a catalogue line keeps its own editor: PUT …/lines/:lineId). */
async function ownCustomLine(db: Reader, row: RequestRow, lineId: string): Promise<LineRow & { readonly kind: CustomLineKind }> {
  const line = await ownLine(db, row, lineId)
  if (!isCustomLine(line)) throw new InvalidStateError(`Line ${line.seq} is from the catalogue: change its colour and sizes there.`)
  return line
}

export async function changeCustomLine(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, body: CustomLineBody & OwnPriced /* B-CP-076 */ & { readonly version: number }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  const line = await request.withClient((client) => ownCustomLine(client, row, lineId))
  const keep = <T>(asked: T | undefined, now: T): T => (asked === undefined ? now : asked)
  const next: CustomLineInput = {
    kind: line.kind,
    description: keep(body.description, line.description),
    colourText: keep(body.colourText, line.colourText),
    styleId: keep(body.styleId, line.styleId),
    colourwayId: body.styleId !== undefined && body.colourwayId === undefined && body.styleId !== line.styleId ? null : keep(body.colourwayId, line.colourwayId),
    garmentType: keep(body.garmentType, line.garmentType),
    quantity: keep(body.quantity, line.quantity),
    byPerson: keep(body.byPerson, line.byPerson),
    sizes: body.sizes ?? sizesOf(line),
    note: keep(body.note, line.note),
  }
  const { catalogue, mtm } = await customFactsOf(app, reader, row, [next.styleId])
  if (line.kind === 'MADE_TO_MEASURE' && !mtm.open) throw mtmClosed(reader)
  // The shape always; against today's catalogue and garment types only what this change asks (a style that stopped being sold, or a
  // garment type no longer offered, stays a problem of the line to fix, never a refusal of an unrelated change).
  const styleAsked = body.styleId !== undefined || body.colourwayId !== undefined
  const issues = checkCustomLine(next, catalogue, mtm, 'body').filter((issue) => (styleAsked || !/\/(styleId|colourwayId)$/.test(issue.path)) && (body.garmentType !== undefined || !issue.path.endsWith('/garmentType')))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  await onDraft(app, request, 'portalOrdering.changeCustomLine', row, body.version, { requestId, lineId, ...body }, idempotencyKey, async (tools) => {
    const { tx, now } = tools
    const current = await ownCustomLine(tx, row, lineId)
    const people = await tx.portalOrderRequestPerson.count({ where: { lineId } })
    if (current.byPerson && next.byPerson === false && people > 0) throw new InvalidStateError(`Line ${current.seq} has its people: take them off before it stops being by person.`)
    if (body.sizes !== undefined) {
      await tx.portalOrderRequestSize.deleteMany({ where: { lineId } })
      if (body.sizes.length > 0) await tx.portalOrderRequestSize.createMany({ data: body.sizes.map((ask) => ({ id: newId(), partyId: row.partyId, lineId, size: ask.size.trim(), quantity: ask.quantity, createdById: reader.session.userId, createdAt: now, updatedAt: now })) })
    }
    const data = customLineData(next)
    const own = body.brandUnitPrice !== undefined ? { brandUnitPrice: body.brandUnitPrice } : {} // B-CP-076: absent keeps it, null clears it
    await tx.portalOrderRequestLine.update({ where: { id: lineId }, data: { ...data, ...own, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      recordType: 'PortalOrderRequest',
      recordId: row.id,
      companyId: row.companyId,
      before: { lineId, ...customLineData(current), sizes: sizesOf(current), brandUnitPrice: markMoney('price', priceOrNull(current.brandUnitPrice)) /* B-CP-076 */ },
      after: { lineId, ...data, sizes: next.sizes ?? [], brandUnitPrice: markMoney('price', body.brandUnitPrice === undefined ? priceOrNull(current.brandUnitPrice) : body.brandUnitPrice) /* B-CP-076 */ },
    })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

/** The draft's by-person line for its people (made to measure open for a made-to-measure line), or a refusal in words. */
async function rosterLine(request: FastifyRequest, reader: PortalReader, app: FastifyInstance, row: RequestRow, lineId: string): Promise<LineRow> {
  const line = await request.withClient((client) => ownLine(client, row, lineId))
  if (!line.byPerson) {
    const words = PEOPLE_WORDS.NOT_BY_PERSON[partnerLocaleOf(reader.session.person.locale)]
    throw new DomainError('invalid_state', words, [{ path: 'refusal/NOT_BY_PERSON', message: words }])
  }
  if (line.kind === 'MADE_TO_MEASURE' && !(await reader.inTenant((db) => madeToMeasureOf(db, row.companyId, row.partyId))).open) throw mtmClosed(reader)
  return line
}

/** The person's shape (400) and its sheet: a measurement sheet of this very draft (another draft's, another customer's: not found). */
async function checkPerson(request: FastifyRequest, row: RequestRow, person: PersonInput, at: string): Promise<void> {
  const issues = personShapeProblems(person).map((message) => ({ path: at, message }))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const fileId = personRow(person).measurementFileId
  if (fileId !== null) {
    const lineIds = (await request.withClient((client) => readLines(client, [row.id]))).map((line) => line.id)
    if (!(await request.withClient((client) => isDraftSheet(client, row, lineIds, fileId)))) throw new NotFoundError('File not found.') // W-CP-3
  }
}

export async function addPeople(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, body: { readonly version: number; readonly people: readonly PersonInput[] }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  await rosterLine(request, reader, app, row, lineId)
  for (const [index, person] of body.people.entries()) await checkPerson(request, row, person, `body/people/${index}`)
  await onDraft(app, request, 'portalOrdering.addPeople', row, body.version, { requestId, lineId, people: body.people.length }, idempotencyKey, async (tools) => {
    const { tx, now } = tools
    const roster = await tx.portalOrderRequestPerson.findMany({ where: { lineId }, select: { seq: true } })
    if (roster.length + body.people.length > PEOPLE_LIMITS.perLine) {
      const words = PEOPLE_WORDS.TOO_MANY[partnerLocaleOf(reader.session.person.locale)]
      throw new DomainError('conflict', words, [{ path: 'refusal/TOO_MANY', message: words }])
    }
    let seq = roster.reduce((max, person) => Math.max(max, person.seq), 0)
    const ids: string[] = []
    for (const person of body.people) {
      const id = newId()
      seq += 1
      await tx.portalOrderRequestPerson.create({ data: { id, partyId: row.partyId, requestId: row.id, lineId, seq, ...personRow(person), createdById: reader.session.userId, createdAt: now, updatedAt: now }, select: { id: true } })
      ids.push(id)
    }
    // Who of the party added them and how they are measured; never the names (personal data stays in its own rows).
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { lineId, people: ids, measureBy: body.people.map((person) => person.measureBy) } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

async function ownPerson(db: Reader, lineId: string, personId: string): Promise<PersonRow> {
  const person = isUuid(personId) ? await db.portalOrderRequestPerson.findFirst({ where: { id: personId, lineId }, select: PERSON_COLUMNS }) : null
  if (!person) throw new NotFoundError('Person not found.')
  return person
}

export async function changePerson(
  app: FastifyInstance,
  request: FastifyRequest,
  requestId: string,
  lineId: string,
  personId: string,
  body: { readonly version: number; readonly name?: string | undefined; readonly number?: string | null | undefined; readonly measureBy?: PersonInput['measureBy'] | undefined; readonly size?: string | null | undefined; readonly measurementFileId?: string | null | undefined; readonly note?: string | null | undefined },
  idempotencyKey?: string,
) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  await rosterLine(request, reader, app, row, lineId)
  const person = await request.withClient((client) => ownPerson(client, lineId, personId))
  const measureBy = body.measureBy ?? person.measureBy
  // A new way of being measured starts from its own field (the other one is dropped: personRow keeps only the field of its way).
  const next: PersonInput = {
    name: body.name ?? person.name,
    number: body.number === undefined ? person.number : body.number,
    measureBy,
    size: body.size === undefined ? (measureBy === person.measureBy ? person.size : null) : body.size,
    measurementFileId: body.measurementFileId === undefined ? (measureBy === person.measureBy ? person.measurementFileId : null) : body.measurementFileId,
    note: body.note === undefined ? person.note : body.note,
  }
  await checkPerson(request, row, next, 'body')
  await onDraft(app, request, 'portalOrdering.changePerson', row, body.version, { requestId, lineId, personId, ...body }, idempotencyKey, async (tools) => {
    const current = await ownPerson(tools.tx, lineId, personId)
    await tools.tx.portalOrderRequestPerson.update({ where: { id: personId }, data: { ...personRow(next), version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { lineId, personId, measureBy: current.measureBy }, after: { lineId, personId, measureBy: next.measureBy } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

export async function removePerson(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, personId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  await request.withClient((client) => ownLine(client, row, lineId))
  await onDraft(app, request, 'portalOrdering.removePerson', row, version, { requestId, lineId, personId, version }, idempotencyKey, async (tools) => {
    const person = await ownPerson(tools.tx, lineId, personId)
    await tools.tx.portalOrderRequestPerson.delete({ where: { id: personId }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { lineId, personId, seq: person.seq }, after: { personId: null } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}
// ---- end B-CP-075

export type { RequestRow }
export { sizesOf }
