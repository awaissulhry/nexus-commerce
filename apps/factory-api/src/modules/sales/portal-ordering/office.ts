import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { decisionProblem, draftReadiness, refuseReasonProblem, type AcceptAs, type DraftLaterPart, type DraftPart, type DraftPartState } from '@nexus/factory-domain/sales/portal-ordering/office'
import { draftTotals, headerProblems, lineAmount, lineProblems, piecesOfSizes, priceShown, REQUEST_STATUS_WORDS, type Problem, type RequestSource, type RequestStatus } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { command, COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { makeManualOrderInCommand, type ManualOrderBody } from '../orders/manual'
import { assertMay, officeContextOf } from '../orders/access'
import { duplicateInto, type Dropped } from '../quotes/duplicate'
import { approveWaitingInCommand } from './address-check'
import { factsOf, readCatalogue, type CustomerCatalogue } from './catalogue'
import { dayText, iso, lockRequest, priceOrNull, readDraftFiles, readLines, readRequest, REQUEST_COLUMNS, type DraftFileRow, type LineRow, type RequestRow } from './store'
import { catalogueLines, isCatalogueLine, ownWordsOf, type CatalogueLineRow } from './store' // B-CP-005
// B-CP-071 (customer page plan D10): the office reads drafts read-only, per customer.
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { mayOnThread } from '../../../platform/threads/records'
// B-CP-072: a draft's files by part; a measurement sheet is named only with sales.measurements.view.
import { draftFilesByPart } from '@nexus/factory-domain/sales/portal-ordering/draft-files'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'

/**
 * The office's side of portal order requests (B-W2b-190, SAL-074; design home.approvals, sales.orders "the request waits
 * there as Requested"). Office sessions over the requests' company and customer (orders.view to see, orders.manage to
 * decide; quotes.manage too for a quote), like the sales orders.
 *
 *   GET  /sales/order-requests?status=&partyId=&q=      the requests customers sent; B-CP-071: status=DRAFT lists ONE
 *                                                       customer's drafts (partyId required: "Drafts are listed per
 *                                                       customer"; a customer out of reach: "Customer not found.")
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
 *
 * B-CP-071 (customer page plan D10, K9 reversed): the office READS a customer's draft from its first save — the list of one
 * customer's drafts (who started it and who changed it last, the first line as its title, counts, the checklist, its
 * conversation), and the draft itself read-only (accept and refuse held: "This is still the customer's draft: it is decided once
 * they send it."). A draft is never in Incoming, Home › Approvals or any count; part 6 "Your price" is counted only for a reader
 * with the price grain (review B4).
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
  if (query.status === 'DRAFT') return listDrafts(caller, actorOf(context), query.partyId, query.q) // B-CP-071
  const scope = scopeWhere(actorOf(context), ORDERS_VIEW, SCOPE) as Prisma.PortalOrderRequestWhereInput
  const q = query.q?.trim()
  const status: Prisma.PortalOrderRequestWhereInput = query.status === 'OPEN' ? { status: 'SENT' } : query.status === 'ALL' ? { status: { not: 'DRAFT' } } : { status: query.status }
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
        draft: null, // B-CP-071: a sent request is no draft
      }
    }),
  }
}

// ---- B-CP-071 (D10): a customer's drafts, read-only ----------------------------------------------------------------------------

/** The draft's facts the office reads (a sent request has none). */
interface DraftView {
  readonly startedBy: string | null
  readonly startedAt: string
  readonly lastEditedBy: string | null
  readonly lastEditedAt: string
  /** The first line's style ("JKT-100 Racing jacket"); null: no line yet ("Untitled draft"). */
  readonly title: string | null
  /** The people of its roster (B-CP-075). */
  readonly people: number
  readonly readiness: { readonly parts: { readonly part: DraftPart; readonly state: DraftPartState }[]; readonly done: number; readonly of: number; readonly problems: number }
  readonly later: DraftLaterPart[]
  /** Its conversation, for a reader of its thread (null: not one). */
  readonly thread: { readonly messages: number; readonly lastAt: string | null; readonly designerAsked: boolean } | null
  /** What holds its send today (the office's reading: a price change is the customer's to accept). */
  readonly problems: { readonly code: Problem['code']; readonly lineId: string | null; readonly size: string | null; readonly words: Problem['words'] }[]
  /** B-CP-072: its logos, references and measurement sheets; a sheet is named only for a reader with sales.measurements.view. */
  readonly files: Record<'logos' | 'references' | 'sheets', OfficeDraftFile[]>
}

/** B-CP-072: a draft's file as the office reads it; `locked`: a measurement sheet this reader may not open (no name). */
interface OfficeDraftFile {
  readonly id: string
  readonly lineId: string | null
  readonly originalName: string | null
  readonly kind: string
  readonly sizeBytes: number
  readonly status: string
  readonly locked: boolean
}

const officeFileOf = (file: DraftFileRow & { readonly lineId: string | null }, locked: boolean): OfficeDraftFile => ({ id: file.id, lineId: file.lineId, originalName: locked ? null : file.originalName, kind: file.kind, sizeBytes: file.sizeBytes, status: file.status, locked })

/** The newest change of each draft by its customer (the audit's portal rows): who, and when. */
async function lastEditors(caller: CommandCaller, ids: readonly string[]): Promise<Map<string, { actorId: string; at: Date }>> {
  if (ids.length === 0) return new Map()
  const rows = await caller.withClient((client) =>
    (client as Prisma.TransactionClient).$queryRaw<{ recordId: string; actorId: string; at: Date }[]>`
      SELECT DISTINCT ON (a."recordId") a."recordId"::text AS "recordId", a."actorId"::text AS "actorId", a."at"
        FROM "AuditLog" a
       WHERE a."recordType" = 'PortalOrderRequest' AND a."recordId" = ANY(${[...ids]}::uuid[]) AND a."audience" = 'PARTNER'
       ORDER BY a."recordId", a."at" DESC, a."id" DESC`,
  )
  return new Map(rows.map((row) => [row.recordId, { actorId: row.actorId, at: row.at }]))
}

/** The drafts' office facts (rows of ONE customer, any of its companies), one read per kind. */
async function draftViews(caller: CommandCaller, actor: Actor, rows: readonly RequestRow[], lines: readonly LineRow[]): Promise<Map<string, DraftView>> {
  const out = new Map<string, DraftView>()
  if (rows.length === 0) return out
  const day = businessDate(serverClock.now())
  const ids = rows.map((row) => row.id)
  const editors = await lastEditors(caller, ids)
  const names = await namesOf(caller, [...rows.map((row) => row.createdById), ...[...editors.values()].map((entry) => entry.actorId)])
  const catalogues = new Map<string, CustomerCatalogue>()
  for (const companyId of new Set(rows.map((row) => row.companyId))) {
    // B-CP-005: the catalogue lines' styles (a described or made-to-measure line names no catalogue style).
    const styleIds = catalogueLines(lines.filter((line) => rows.some((row) => row.id === line.requestId && row.companyId === companyId))).map((line) => line.styleId)
    catalogues.set(companyId, await caller.withClient((client) => readCatalogue(client, { companyId, partyId: rows[0]!.partyId, day, styleIds })))
  }
  const addressIds = [...new Set(rows.flatMap((row) => (row.shipToAddressId ? [row.shipToAddressId] : [])))]
  const addresses = new Map(addressIds.length === 0 ? [] : (await caller.withClient((client) => client.partyAddress.findMany({ where: { id: { in: addressIds } }, select: { id: true, status: true } }))).map((row) => [row.id, row.status]))
  const threads = new Map(
    (await caller.withClient((client) => client.thread.findMany({ where: { recordType: 'PortalOrderRequest', recordId: { in: ids } }, select: { recordId: true, lastMessageAt: true, _count: { select: { messages: true } } } }))).map((row) => [row.recordId, row]),
  )
  const storedFiles = await caller.withClient((client) => readDraftFiles(client, ids, lines.map((line) => line.id))) // B-CP-072
  for (const row of rows) {
    const own = lines.filter((line) => line.requestId === row.id)
    const catalogue = catalogues.get(row.companyId)!
    const scope = { companyId: row.companyId, partyId: row.partyId }
    const header = headerProblems({ requestedDate: dayText(row.requestedDate), shipToActive: row.shipToAddressId === null ? null : addresses.get(row.shipToAddressId) === 'ACTIVE', lineCount: own.length }, day)
    // B-CP-005: the catalogue's checks for its own lines; the title is the first line's style, or a described or made-to-measure
    // line's own words.
    const problems = [...header, ...catalogueLines(own).flatMap((line) => lineProblems({ id: line.id, sizes: line.sizes, unitPriceShown: priceOrNull(line.unitPriceShown) }, factsOf(catalogue, line.styleId, line.colourwayId), false))]
    const head = own[0]
    const first = head && isCatalogueLine(head) ? catalogue.codes.get(head.styleId) : undefined
    const ownWords = head && !isCatalogueLine(head) ? ownWordsOf(head) : null
    // end B-CP-005
    const edited = editors.get(row.id)
    const thread = threads.get(row.id)
    // B-CP-072: this draft's own files and its lines' (a sheet locked for a reader without sales.measurements.view).
    const lineIds = new Set(own.map((line) => line.id))
    const files = draftFilesByPart(storedFiles.filter((file) => (file.recordType === 'PortalOrderRequest' ? file.recordId === row.id : lineIds.has(file.recordId))), row.id)
    const sheetsLocked = !can(actor, SALES_MEASUREMENTS_VIEW, scope)
    const readiness = draftReadiness({
      lines: own.length,
      linesWithoutPieces: own.filter((line) => piecesOfSizes(line.sizes) === 0).length,
      logos: files.logos.length,
      references: files.references.length,
      requestedDate: row.requestedDate !== null,
      headerProblems: header.filter((entry) => entry.code !== 'NO_LINES' && entry.code !== 'TOO_MANY_LINES').length,
      note: row.note !== null,
      later: [],
      // Part 6 "Your price" only for a price holder (review B4); the customer's own price per line comes with B-CP-076.
      pricedLines: can(actor, grainPermission('price'), scope) ? 0 : null,
      problems: problems.length,
    })
    out.set(row.id, {
      startedBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
      startedAt: iso(row.createdAt)!,
      lastEditedBy: edited ? (names.get(edited.actorId) ?? null) : row.createdById ? (names.get(row.createdById) ?? null) : null,
      lastEditedAt: iso(row.updatedAt)!,
      title: first ? `${first.code} ${first.name}`.trim() : ownWords, // B-CP-005: else the line's own words
      people: 0,
      readiness: { ...readiness, parts: [...readiness.parts] },
      later: [],
      thread: mayOnThread(actor, THREADS_READ, 'PortalOrderRequest', scope) ? { messages: thread?._count.messages ?? 0, lastAt: iso(thread?.lastMessageAt ?? null), designerAsked: false } : null,
      problems: problems.map((entry) => ({ code: entry.code, lineId: entry.lineId, size: entry.size, words: entry.words })),
      files: { logos: files.logos.map((file) => officeFileOf(file, false)), references: files.references.map((file) => officeFileOf(file, false)), sheets: files.sheets.map((file) => officeFileOf(file, sheetsLocked)) },
    })
  }
  return out
}

/**
 * GET /sales/order-requests?status=DRAFT&partyId=: ONE customer's drafts, newest change first — orders.view over the customer
 * (any of its companies), else "Customer not found." (a customer out of reach is as unknown as a wrong id); without a customer
 * the list is refused. Never counted anywhere.
 */
async function listDrafts(caller: CommandCaller, actor: Actor, partyId: string | undefined, typed: string | undefined) {
  if (!partyId) throw new ValidationError('Drafts are listed per customer.', [{ path: 'querystring/partyId', message: 'Drafts are listed per customer.' }])
  const party = isUuid(partyId) ? await caller.withClient((client) => client.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, legalName: true } })) : null
  if (!party || !can(actor, ORDERS_VIEW, { partyId })) throw new NotFoundError('Customer not found.')
  const scope = scopeWhere(actor, ORDERS_VIEW, SCOPE) as Prisma.PortalOrderRequestWhereInput
  const q = typed?.trim()
  const rows = await caller.withClient((client) =>
    client.portalOrderRequest.findMany({
      where: { AND: [scope, { status: 'DRAFT', partyId }, ...(q ? [{ customerRef: { contains: q, mode: 'insensitive' as const } }] : [])] },
      select: { ...REQUEST_COLUMNS, decidedById: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: LIST_MAX,
    }),
  )
  const lines = await caller.withClient((client) => readLines(client, rows.map((row) => row.id)))
  const drafts = await draftViews(caller, actor, rows, lines)
  return {
    requests: rows.map((row) => {
      const totals = draftTotals(lines.filter((line) => line.requestId === row.id).map((line) => ({ sizes: line.sizes, unitPriceShown: priceOrNull(line.unitPriceShown) })), true)
      return {
        id: row.id,
        number: row.number,
        status: row.status as RequestStatus,
        source: row.source as RequestSource,
        party: { id: party.id, code: party.code, name: party.legalName },
        customerRef: row.customerRef,
        requestedDate: dayText(row.requestedDate),
        sentAt: null,
        sentBy: null,
        decidedAt: null,
        lines: totals.lines,
        pieces: totals.pieces,
        netShown: asMoney('price', totals.net),
        currency: row.currency,
        salesOrderId: null,
        quoteId: null,
        version: row.version,
        draft: drafts.get(row.id)!,
      }
    }),
  }
}
// ---- end B-CP-071

async function officeRequest(caller: CommandCaller, requestId: string) {
  const context = officeContextOf(caller)
  const row = isUuid(requestId) ? await caller.withClient((client) => client.portalOrderRequest.findUnique({ where: { id: requestId }, select: { ...REQUEST_COLUMNS, decidedById: true } })) : null
  // B-CP-071 (D10): a draft is read too (read-only: a decision on it is held by decisionProblem); out of reach is not found.
  if (!row) throw new NotFoundError('Order request not found.')
  assertMay(context, ORDERS_VIEW, { companyId: row.companyId, partyId: row.partyId }, 'Order request')
  return { context, row }
}

export async function officeRequestView(caller: CommandCaller, requestId: string) {
  const { context, row } = await officeRequest(caller, requestId)
  const day = businessDate(serverClock.now())
  const lines = await caller.withClient((client) => readLines(client, [row.id]))
  // B-CP-005: the catalogue lines are read with the catalogue; a described or made-to-measure line is the office's to map
  // first (B-CP-077) and is shown by its kind there, not as a style it does not have (it counts in the totals).
  const listed = catalogueLines(lines)
  const catalogue = await caller.withClient((client) => readCatalogue(client, { companyId: row.companyId, partyId: row.partyId, day, styleIds: listed.map((line) => line.styleId) }))
  const party = await caller.withClient((client) => client.party.findUnique({ where: { id: row.partyId }, select: { id: true, code: true, legalName: true } }))
  const shipTo = row.shipToAddressId ? await caller.withClient((client) => client.partyAddress.findUnique({ where: { id: row.shipToAddressId! }, select: { id: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, status: true, approvalStatus: true } })) : null
  const names = await namesOf(caller, [row.sentById, row.decidedById, row.createdById])
  const salesOrder = row.salesOrderId ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: row.salesOrderId! }, select: { id: true, number: true } })) : null
  const quote = row.quoteId ? await caller.withClient((client) => client.quote.findUnique({ where: { id: row.quoteId! }, select: { id: true, number: true } })) : null
  const actor = actorOf(context)
  const scope = { companyId: row.companyId, partyId: row.partyId }
  const views = listed.map((line) => { // B-CP-005: catalogue lines
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
  const draft = row.status === 'DRAFT' ? ((await draftViews(caller, actor, [row], lines)).get(row.id) ?? null) : null // B-CP-071
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
      draft, // B-CP-071: a draft's office facts (null once sent)
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

// B-CP-005: an order is made from catalogue lines (a style and colourway of the catalogue); see notCatalogueProblem.
const linesFor = (lines: readonly CatalogueLineRow[], prices: AcceptBody['lines']) =>
  lines.map((line) => ({
    styleId: line.styleId,
    colourwayId: line.colourwayId,
    sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity })),
    unitPrice: prices?.find((entry) => entry.lineId === line.id)?.unitPrice,
    note: line.note,
  }))

// ---- B-CP-005: a described or made-to-measure line has no style and colourway of the catalogue to make an order or a quote
// line from: the office maps it first (B-CP-077, the request-line → order-line map). Until then the accept is held, in words
// that name the lines.
function notCatalogueProblem(lines: readonly LineRow[]): string | null {
  const others = lines.filter((line) => !isCatalogueLine(line)).map((line) => line.seq)
  if (others.length === 0) return null
  return `${others.length === 1 ? `Line ${others[0]} is` : `Lines ${others.join(', ')} are`} described or made to measure, not from the catalogue: map ${others.length === 1 ? 'it' : 'them'} to a style before making an order or a quote.`
}
// ---- end B-CP-005

/** `clock`: the routes pass the app's (B-W2b-F13b: a waiting ship-to approved here is never decided before it was asked). */
export async function acceptRequest(caller: CommandCaller, requestId: string, body: AcceptBody, idempotencyKey?: string, clock: Clock = serverClock) {
  const { context, row } = await officeRequest(caller, requestId)
  const scope = { companyId: row.companyId, partyId: row.partyId }
  assertMay(context, ORDERS_MANAGE, scope, 'Order request')
  if (body.as === 'QUOTE' && !can(actorOf(context), QUOTES_MANAGE, scope)) throw new ForbiddenError('Making a quote needs the right to make quotes for this customer.')
  const problem = decisionProblem(row.status as RequestStatus)
  if (problem) throw new InvalidStateError(problem)
  const lines = await caller.withClient((client) => readLines(client, [row.id]))
  const notCatalogue = notCatalogueProblem(lines) // B-CP-005
  if (notCatalogue) throw new InvalidStateError(notCatalogue) // B-CP-005
  for (const [index, entry] of (body.lines ?? []).entries()) if (!lines.some((line) => line.id === entry.lineId)) throw new ValidationError('Not a line of this request.', [{ path: `body/lines/${index}/lineId`, message: 'Not a line of this request.' }])
  const { result } = await runCommand(caller, { name: 'portalOrdering.accept', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockRequest(tx, requestId, body.version)
    const again = decisionProblem(current.status as RequestStatus)
    if (again) throw new InvalidStateError(again)
    // B-CP-005: the lines as they are now (a sent request's lines never change; read again inside the command), catalogue ones.
    const read = await readLines(tx, [current.id])
    const stillNot = notCatalogueProblem(read)
    if (stillNot) throw new InvalidStateError(stillNot)
    const fresh = catalogueLines(read)
    // end B-CP-005
    // B-W2b-F13b: a delivery address the customer added for this request waits for our check: accepting the request
    // approves it first, in this command (the order or quote may then use it).
    if (current.shipToAddressId) await approveWaitingInCommand(tools, current.shipToAddressId, { type: 'PortalOrderRequest', id: current.id, number: current.number })
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
      // B-W2b-304 (SAL-244): an order from the portal is checked as such (PORTAL).
      const outcome = await makeManualOrderInCommand(tools, order, null, 'PORTAL')
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
  }, { ...COMMAND_SETTINGS, clock })
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
