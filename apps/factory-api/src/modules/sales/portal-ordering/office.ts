import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney, type Money } from '@nexus/factory-domain/money/marked'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { decisionProblem, draftReadiness, refuseReasonProblem, type AcceptAs, type DraftLaterPart, type DraftPart, type DraftPartState } from '@nexus/factory-domain/sales/portal-ordering/office'
import { draftTotals, headerProblems, lineAmount, lineProblems, piecesOfSizes, priceShown, REQUEST_STATUS_WORDS, type RequestSource, type RequestStatus } from '@nexus/factory-domain/sales/portal-ordering/rules'
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
import { catalogueLines, isCatalogueLine, ownWordsOf } from './store' // B-CP-005
// B-CP-071 (customer page plan D10): the office reads drafts read-only, per customer.
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { mayOnThread } from '../../../platform/threads/records'
// B-CP-072: a draft's files by part; a measurement sheet is named only with sales.measurements.view.
import { draftFilesByPart } from '@nexus/factory-domain/sales/portal-ordering/draft-files'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
// B-CP-075: the lines of the customer's own kinds, their people, the parts it sends later, who saved it last; problems per part.
import { problemsByPartOf } from '@nexus/factory-domain/sales/portal-ordering/office'
import { customLineFactsOf, customLineView, isCustomLine, madeToMeasureOf, piecesOfLine, problemView, sheetLinesOf, type MadeToMeasure, type SheetOf } from './people'
import { customLineProblems, lineHasPieces } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { readPeople, type PersonRow } from './store'
// B-CP-077: the accept's line map (a described or made-to-measure line made into style lines), its checks, the logos' carry.
import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { ACCEPT_WORDS, acceptPlanOf, lineMapOf, type AcceptLineFacts, type AcceptLineMapEntry, type AcceptMapEntry, type AcceptPlan, type PlannedLine } from '@nexus/factory-domain/sales/portal-ordering/office'
import type { CommandTx } from '../../../core/command'
import { processFiles, type FilesRuntime } from '../../../platform/files/service'
import { lineTarget } from '../quotes/lines'
import { carryArtwork } from './accept-artwork'
// B-CP-076 (customer page plan 11 §1.3 D3): "Your price" in the draft, its value, and its carry onto the order (cp-2b's store).
import { newId } from '@nexus/factory-domain/core/ids'
import { brandPricesOfAccept, draftValueOf } from '@nexus/factory-domain/sales/portal-ordering/office'
import { announceBrandPrices, auditBrandPrice, brandPriceAuditView, type PricedOrder } from '../brand-prices/store'
import { ownPriceView } from './people'

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
 * B-CP-077 (customer page plan C5, 12 §9 B-CP-062): a request with described or made-to-measure lines is accepted once the office
 * maps each to the style line(s) it is made into (`map`: style, colourway, sizes — else the request's own when it has them — and,
 * for an ORDER, maybe a price); until then the accept is held in words. A made-to-measure line is accepted as a QUOTE only (GATE-MTM
 * is off: today's made-to-measure rule); its people stay on the request (the quote links it). The command keeps ONE map, request
 * line → order (or quote) line(s), by id: the answer's `made.lines` and the accept's audit carry it; the customer's logos follow it
 * onto the lines made (./accept-artwork.ts).
 *
 * B-CP-076 (customer page plan 11 §1.3 D3; review E3, B4): the customer's own price per line ("Your price", price grain) is read
 * with each line, counted in the draft's checklist (part 6, price holders only) and its value (`draftValueAmount`); accepted as
 * an ORDER, the same command writes it onto the order by the line map (OrderBrandPrice, source PORTAL, audited under
 * OrderBrandPrice with the order as its record: brand-prices/store.ts); a QUOTE takes nothing (the order made later offers the
 * take-over). The accept itself needs no price key (a Sales worker without prices accepts at the list prices).
 *
 * A decision moves the request from SENT once (its version is the guard; the database allows nothing else), with its
 * audit row and portal_order_request.accepted / .refused. The sales-order state machine is the sales orders' own.
 *
 * B-CP-071 (customer page plan D10, K9 reversed): the office READS a customer's draft from its first save — the list of one
 * customer's drafts (who started it and who changed it last, the first line as its title, counts, the checklist, its
 * conversation), and the draft itself read-only (accept and refuse held: "This is still the customer's draft: it is decided once
 * they send it."). A draft is never in Incoming, Home › Approvals or "waits on us"; part 6 "Your price" is counted only for a reader
 * with the price grain (review B4).
 * B-CQ-033 (customer page › Quotes & incoming, settle C3): made true — a draft IS counted in exactly one place, as the customer's
 * writing: the before-order group WRITING ("Customer is writing N", GET /sales/before-order/counts, orders.view over the customer,
 * the same scope as this list). It never counts in TO_ANSWER, in the tab badge or in any Incoming tile.
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
  const people = await caller.withClient((client) => readPeople(client, rows.map((row) => row.id))) // B-CP-075: a by-person line's pieces
  const parties = await caller.withClient(async (client) => new Map((await client.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row])))
  const names = await namesOf(caller, rows.map((row) => row.sentById))
  return {
    requests: rows.map((row) => {
      const own = lines.filter((line) => line.requestId === row.id)
      const totals = draftTotals(own.map((line) => ({ sizes: line.sizes, unitPriceShown: priceOrNull(line.unitPriceShown), pieces: piecesOfLine(line, people) /* B-CP-075 */ })), true)
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
  readonly problems: ReturnType<typeof problemView>[] // B-CP-075: + the part of the checklist and the person
  /** B-CP-072: its logos, references and measurement sheets; a sheet is named only for a reader with sales.measurements.view. */
  readonly files: Record<'logos' | 'references' | 'sheets', OfficeDraftFile[]>
  /** B-CP-076 (review B4): its value at the prices on it (minor units; price grain: null for a reader without it). */
  readonly draftValueAmount: Money<'price', number | null> // B-CP-076 (end-check fix): the price grain, as the contract marks it
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
async function draftViews(caller: CommandCaller, actor: Actor, rows: readonly RequestRow[], lines: readonly LineRow[], /* B-CP-075 */ people: readonly PersonRow[]): Promise<Map<string, DraftView>> {
  const out = new Map<string, DraftView>()
  if (rows.length === 0) return out
  const day = businessDate(serverClock.now())
  const ids = rows.map((row) => row.id)
  // B-CP-075: who saved it last is the draft's own column (lastEditedById); a draft saved before the column, its newest portal audit row.
  const editors = await lastEditors(caller, rows.filter((row) => row.lastEditedById === null).map((row) => row.id))
  const names = await namesOf(caller, [...rows.map((row) => row.createdById), ...rows.map((row) => row.lastEditedById), ...[...editors.values()].map((entry) => entry.actorId)])
  const catalogues = new Map<string, CustomerCatalogue>()
  const mtms = new Map<string, MadeToMeasure>() // B-CP-075
  for (const companyId of new Set(rows.map((row) => row.companyId))) {
    // B-CP-005: the catalogue lines' styles (a described or made-to-measure line names no catalogue style). B-CP-075: + the styles
    // the customer's own lines name.
    const ofCompany = lines.filter((line) => rows.some((row) => row.id === line.requestId && row.companyId === companyId))
    const styleIds = [...catalogueLines(ofCompany).map((line) => line.styleId), ...ofCompany.filter(isCustomLine).flatMap((line) => (line.styleId ? [line.styleId] : []))]
    catalogues.set(companyId, await caller.withClient((client) => readCatalogue(client, { companyId, partyId: rows[0]!.partyId, day, styleIds })))
    mtms.set(companyId, await caller.withClient((client) => madeToMeasureOf(client, companyId, rows[0]!.partyId)))
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
    const mtm = mtms.get(row.companyId)! // B-CP-075
    const scope = { companyId: row.companyId, partyId: row.partyId }
    const header = headerProblems({ requestedDate: dayText(row.requestedDate), shipToActive: row.shipToAddressId === null ? null : addresses.get(row.shipToAddressId) === 'ACTIVE', lineCount: own.length }, day)
    // B-CP-072/075: this draft's own files and its lines' (a sheet on a line stands for its roster).
    const lineIds = new Set(own.map((line) => line.id))
    const ofDraft = storedFiles.filter((file) => (file.recordType === 'PortalOrderRequest' ? file.recordId === row.id : lineIds.has(file.recordId)))
    const sheetLines = sheetLinesOf(ofDraft)
    const roster = people.filter((person) => person.requestId === row.id)
    // B-CP-005: the catalogue's checks for its own lines; the title is the first line's style, or a described or made-to-measure
    // line's own words. B-CP-075: the customer's own lines' problems too, in the draft's order.
    const problems = [
      ...header,
      ...[...own]
        .sort((a, b) => a.seq - b.seq)
        .flatMap((line) => (isCatalogueLine(line) ? lineProblems({ id: line.id, sizes: line.sizes, unitPriceShown: priceOrNull(line.unitPriceShown) }, factsOf(catalogue, line.styleId, line.colourwayId), false) : isCustomLine(line) ? customLineProblems(customLineFactsOf(line, roster, sheetLines, catalogue, mtm)) : [])),
    ]
    const head = own[0]
    const first = head && isCatalogueLine(head) ? catalogue.codes.get(head.styleId) : undefined
    const ownWords = head && !isCatalogueLine(head) ? ownWordsOf(head) : null
    // end B-CP-005
    const edited = editors.get(row.id)
    const thread = threads.get(row.id)
    // B-CP-072: a sheet locked for a reader without sales.measurements.view.
    const files = draftFilesByPart(ofDraft, row.id)
    const sheetsLocked = !can(actor, SALES_MEASUREMENTS_VIEW, scope)
    const later = [...row.laterParts] as DraftLaterPart[] // B-CP-075
    const seesPrice = can(actor, grainPermission('price'), scope) // B-CP-076 (review B4)
    const readiness = draftReadiness({
      lines: own.length,
      // B-CP-075: a line's pieces by its kind (sizes; a described total; a by-person line's people, or a sheet on it).
      linesWithoutPieces: own.filter((line) => !lineHasPieces({ kind: line.kind, quantity: line.quantity, sizes: line.sizes, byPerson: line.byPerson, people: roster.filter((person) => person.lineId === line.id).length, sheetOnLine: sheetLines.has(line.id) })).length,
      logos: files.logos.length,
      references: files.references.length,
      requestedDate: row.requestedDate !== null,
      headerProblems: header.filter((entry) => entry.code !== 'NO_LINES' && entry.code !== 'TOO_MANY_LINES').length,
      note: row.note !== null,
      later,
      // Part 6 "Your price" only for a price holder (review B4). B-CP-076: the lines that carry the customer's own price.
      pricedLines: seesPrice ? own.filter((line) => line.brandUnitPrice !== null).length : null,
      problems: problems.length,
      problemsByPart: problemsByPartOf(problems), // B-CP-075
    })
    // B-CP-075: who saved it last — the draft's own column, else (a draft saved before it) its newest portal audit row, else who started it.
    const editorId = row.lastEditedById ?? edited?.actorId ?? row.createdById
    out.set(row.id, {
      startedBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
      startedAt: iso(row.createdAt)!,
      lastEditedBy: editorId ? (names.get(editorId) ?? null) : null,
      lastEditedAt: iso(row.lastEditedAt ?? row.updatedAt)!,
      title: first ? `${first.code} ${first.name}`.trim() : ownWords, // B-CP-005: else the line's own words
      people: roster.length, // B-CP-075
      readiness: { ...readiness, parts: [...readiness.parts] },
      later, // B-CP-075
      thread: mayOnThread(actor, THREADS_READ, 'PortalOrderRequest', scope) ? { messages: thread?._count.messages ?? 0, lastAt: iso(thread?.lastMessageAt ?? null), designerAsked: false } : null,
      problems: problems.map(problemView), // B-CP-075: + the part and the person
      files: { logos: files.logos.map((file) => officeFileOf(file, false)), references: files.references.map((file) => officeFileOf(file, false)), sheets: files.sheets.map((file) => officeFileOf(file, sheetsLocked)) },
      // B-CP-076: each line at the price shown, else the customer's own, × its pieces — only for a price holder.
      draftValueAmount: asMoney('price', seesPrice ? draftValueOf(own.map((line) => ({ priceShown: isCatalogueLine(line) ? priceOrNull(line.unitPriceShown) : null, brandUnitPrice: priceOrNull(line.brandUnitPrice), pieces: piecesOfLine(line, roster) })), row.currency) : null),
    })
  }
  return out
}

/**
 * GET /sales/order-requests?status=DRAFT&partyId=: ONE customer's drafts, newest change first — orders.view over the customer
 * (any of its companies), else "Customer not found." (a customer out of reach is as unknown as a wrong id); without a customer
 * the list is refused. B-CQ-033: counted only as the customer's writing (the before-order group WRITING = these rows), never as
 * waiting on us.
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
  const people = await caller.withClient((client) => readPeople(client, rows.map((row) => row.id))) // B-CP-075
  const drafts = await draftViews(caller, actor, rows, lines, people)
  return {
    requests: rows.map((row) => {
      const totals = draftTotals(lines.filter((line) => line.requestId === row.id).map((line) => ({ sizes: line.sizes, unitPriceShown: priceOrNull(line.unitPriceShown), pieces: piecesOfLine(line, people) /* B-CP-075 */ })), true)
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
      brandUnitPrice: ownPriceView(line), // B-CP-076: the customer's own price (price grain)
    }
  })
  // ---- B-CP-075: the described and made-to-measure lines with their people; a measurement sheet is named only with
  // sales.measurements.view (else a lock without a name). B-CP-077: the accept maps them (held, in words, while one is not mapped).
  const people = await caller.withClient((client) => readPeople(client, [row.id]))
  const custom = lines.filter(isCustomLine)
  const stored = custom.length === 0 ? [] : await caller.withClient((client) => readDraftFiles(client, [row.id], lines.map((line) => line.id)))
  const customStyles = custom.flatMap((line) => (line.styleId ? [line.styleId] : []))
  const customCatalogue = customStyles.length === 0 ? catalogue : await caller.withClient((client) => readCatalogue(client, { companyId: row.companyId, partyId: row.partyId, day, styleIds: [...listed.map((line) => line.styleId), ...customStyles] }))
  const mtm = custom.length === 0 ? { open: false, garmentTypes: [] } : await caller.withClient((client) => madeToMeasureOf(client, row.companyId, row.partyId))
  const sheetsLocked = !can(actor, SALES_MEASUREMENTS_VIEW, scope)
  const sheetNames = new Map(stored.map((file) => [file.id, file.originalName]))
  const sheetOf: SheetOf = (fileId) => (sheetNames.has(fileId) ? { id: fileId, originalName: sheetsLocked ? null : sheetNames.get(fileId)!, locked: sheetsLocked } : null)
  const sheetLines = sheetLinesOf(stored)
  const customViews = custom.map((line) => customLineView(line, people, sheetLines, customCatalogue, mtm, sheetOf))
  // ---- end B-CP-075
  const totals = draftTotals(lines.map((line) => ({ sizes: line.sizes, unitPriceShown: priceOrNull(line.unitPriceShown), pieces: piecesOfLine(line, people) /* B-CP-075 */ })), true)
  const open = row.status === 'SENT'
  const draft = row.status === 'DRAFT' ? ((await draftViews(caller, actor, [row], lines, people)).get(row.id) ?? null) : null // B-CP-071
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
      customLines: customViews, // B-CP-075
      acceptMap: acceptMapOf(lines), // B-CP-077: the lines to map before the accept, and why it is not an order
    },
    may: { order: open && can(actor, ORDERS_MANAGE, scope), quote: open && can(actor, ORDERS_MANAGE, scope) && can(actor, QUOTES_MANAGE, scope), refuse: open && can(actor, ORDERS_MANAGE, scope) },
  }
}

export interface AcceptBody {
  readonly version: number
  readonly as: AcceptAs
  /** ORDER: the promise date (today or later), else none yet. */
  readonly promiseDate?: BusinessDate | null | undefined
  /** ORDER: a unit price per catalogue line typed by the office (else the customer's list price today; a price the grain filter dropped is not typed). */
  readonly lines?: readonly { readonly lineId: string; readonly unitPrice?: string | undefined }[] | undefined
  /** B-CP-077: each described or made-to-measure line and the style line(s) it is made into (its sizes, maybe its price). */
  readonly map?: readonly AcceptMapEntry[] | undefined
}

// ---- B-CP-077 (customer page plan C5, 12 §9 B-CP-062; lead notes 1–2; review E3): the accept's ONE line map --------------------
// A described or made-to-measure line is accepted once the office maps it to the style line(s) it is made into (factory-domain
// sales/portal-ordering/office acceptPlanOf: held in words until then; a made-to-measure line is a QUOTE first while made-to-measure
// has not started, GATE-MTM). The command keeps ONE map, request line → order (or quote) line(s), by id (lineMapOf): the answer and
// the accept's audit carry it, and the customer's prices are carried by it (B-CP-076). People are never mapped to measurement
// profiles ("Saved measurements" comes later): the roster stays on the request, which the order or quote links (read only).

/** The request's lines as the accept judges them (a person only by the size it gives: names never leave the request). */
function acceptFactsOf(lines: readonly LineRow[], people: readonly PersonRow[]): AcceptLineFacts[] {
  return lines.map((line) => ({
    id: line.id,
    seq: line.seq,
    kind: line.kind as AcceptLineFacts['kind'],
    styleId: isCatalogueLine(line) ? line.styleId : null,
    colourwayId: isCatalogueLine(line) ? line.colourwayId : null,
    sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity })),
    quantity: line.quantity,
    byPerson: line.byPerson,
    peopleSizes: people.filter((person) => person.lineId === line.id).map((person) => (person.measureBy === 'SIZE' ? person.size : null)),
    note: line.note,
    ownWords: isCatalogueLine(line) ? null : ownWordsOf(line),
    colourText: line.colourText,
  }))
}

/** The plan, or its refusal in words: 400 what the office sent, 409 what holds the accept (a line to map, a made-to-measure order). */
function planOf(input: Parameters<typeof acceptPlanOf>[0]): Extract<AcceptPlan, { kind: 'PLAN' }> {
  const plan = acceptPlanOf(input)
  // B-CP-077 (end-check fix): one test on kind narrows the union (its refusal member's kind is 'HELD' | 'INVALID').
  if (plan.kind !== 'PLAN') throw plan.kind === 'INVALID' ? new ValidationError(plan.words, plan.issues) : new DomainError('invalid_state', plan.words, plan.issues)
  return plan
}

/**
 * The style lines the office mapped, checked in the command before anything is made: a style the company sells in an active
 * colourway, the sizes it offers there, and never another customer's own label (the brand wall: an own-label style is made for its
 * customer only). A catalogue line was checked against the customer's catalogue when it was added and again at the send.
 */
async function checkMapped(tx: CommandTx, row: Pick<RequestRow, 'companyId' | 'partyId'>, planned: readonly PlannedLine[]): Promise<void> {
  const issues: Issue[] = []
  for (const line of planned.filter((entry) => entry.at.startsWith('body/map/'))) {
    try {
      const target = await lineTarget(tx, row.companyId, { styleId: line.styleId, colourwayId: line.colourwayId, styleRevisionId: undefined }, null, line.at)
      const brand = (await tx.style.findUnique({ where: { id: target.style.id }, select: { brandPartyId: true } }))?.brandPartyId ?? null
      if (brand !== null && brand !== row.partyId) issues.push({ path: `${line.at}/styleId`, message: `${target.style.code} is another customer's own label: it is not made for this customer.` })
      for (const ask of line.sizes) if (!target.grid.range.includes(ask.size) || !target.grid.offered.has(ask.size)) issues.push({ path: `${line.at}/sizes`, message: `Size ${ask.size} is not offered for ${target.style.code} in this colourway.` })
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error
      issues.push(...(error.issues && error.issues.length > 0 ? error.issues : [{ path: line.at, message: error.message }]))
    }
  }
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
}

/** The manual order's line problems say where they are: the request's line, or the office's map entry ("Line 2: …"). */
function byPlannedLine(error: ValidationError, planned: readonly PlannedLine[]): ValidationError {
  const issues = (error.issues ?? []).map((issue) => {
    const found = /^body\/lines\/(\d+)(\/.*)?$/.exec(issue.path)
    const line = found ? planned[Number(found[1])] : undefined
    return line ? { path: `${line.at}${found![2] ?? ''}`, message: `Line ${line.requestSeq}: ${issue.message}` } : issue
  })
  return new ValidationError(issues[0]?.message ?? error.message, issues)
}

/** What the accept of this request needs: the lines to map (ids, in the request's order) and why it is not an order (null: it may be). */
function acceptMapOf(lines: readonly LineRow[]): { readonly lineIds: string[]; readonly orderHeld: string | null } {
  const custom = lines.filter((line) => !isCatalogueLine(line)).sort((a, b) => a.seq - b.seq)
  const madeToMeasure = custom.filter((line) => line.kind === 'MADE_TO_MEASURE').map((line) => line.seq)
  return { lineIds: custom.map((line) => line.id), orderHeld: madeToMeasure.length > 0 ? ACCEPT_WORDS.madeToMeasureOrder(madeToMeasure) : null }
}
// ---- end B-CP-077

/** `clock`: the routes pass the app's (B-W2b-F13b: a waiting ship-to approved here is never decided before it was asked). */
export async function acceptRequest(caller: CommandCaller, requestId: string, body: AcceptBody, idempotencyKey?: string, clock: Clock = serverClock, files: FilesRuntime | null = null /* B-CP-077: the logos' carry */) {
  const { context, row } = await officeRequest(caller, requestId)
  const scope = { companyId: row.companyId, partyId: row.partyId }
  assertMay(context, ORDERS_MANAGE, scope, 'Order request')
  if (body.as === 'QUOTE' && !can(actorOf(context), QUOTES_MANAGE, scope)) throw new ForbiddenError('Making a quote needs the right to make quotes for this customer.')
  const problem = decisionProblem(row.status as RequestStatus)
  if (problem) throw new InvalidStateError(problem)
  // B-CP-077: the lines and their map judged first (400 / 409 in words, nothing written); again inside the command.
  const planInput = (lines: readonly LineRow[], roster: readonly PersonRow[], number: string | null) => ({ number, as: body.as, lines: acceptFactsOf(lines, roster), map: body.map ?? [], prices: body.lines ?? [] })
  planOf(planInput(await caller.withClient((client) => readLines(client, [row.id])), await caller.withClient((client) => readPeople(client, [row.id])), row.number))
  const { result } = await runCommand(caller, { name: 'portalOrdering.accept', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockRequest(tx, requestId, body.version)
    const again = decisionProblem(current.status as RequestStatus)
    if (again) throw new InvalidStateError(again)
    // B-CP-077: the lines as they are now (a sent request's lines never change; read again inside the command), every kind by the map.
    const read = await readLines(tx, [current.id])
    const plan = planOf(planInput(read, await readPeople(tx, [current.id]), current.number))
    await checkMapped(tx, current, plan.lines)
    const byId = new Map(read.map((line) => [line.id, line]))
    let lineMap: AcceptLineMapEntry[]
    let brandPrices = 0 // B-CP-076: the customer's prices the order took over
    // end B-CP-077
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
        // B-CP-077: every planned line (a catalogue line as it is; a mapped line as the office made it), in the request's order.
        lines: plan.lines.map((line) => ({ styleId: line.styleId, colourwayId: line.colourwayId, sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity })), unitPrice: line.unitPrice, description: line.description, note: line.note })),
      }
      // B-W2b-304 (SAL-244): an order from the portal is checked as such (PORTAL).
      let outcome: Awaited<ReturnType<typeof makeManualOrderInCommand>>
      try {
        outcome = await makeManualOrderInCommand(tools, order, null, 'PORTAL')
      } catch (error) {
        throw error instanceof ValidationError ? byPlannedLine(error, plan.lines) : error // B-CP-077: said where it is
      }
      salesOrderId = outcome.orderId
      made = { number: outcome.number, dropped: [], warnings: [...plan.warnings] }
      // B-CP-077: the order's lines are made in the plan's order, one for each planned line.
      const orderLines = await tx.salesOrderLine.findMany({ where: { orderId: outcome.orderId }, select: { id: true, seq: true, quantity: true }, orderBy: { seq: 'asc' } })
      lineMap = lineMapOf(plan.lines, orderLines)
      // ---- B-CP-076: the customer's prices carried onto the order by the map, in this command (never by place); never converted.
      const priced: PricedOrder = { id: outcome.orderId, companyId: current.companyId, partyId: current.partyId }
      const currency = (await tx.salesOrder.findUniqueOrThrow({ where: { id: outcome.orderId }, select: { currency: true } })).currency
      const pieces = new Map(orderLines.map((line) => [line.id, Number(line.quantity)]))
      const carry = brandPricesOfAccept({
        currency,
        prices: read.map((line) => ({ requestLineId: line.id, brandUnitPrice: priceOrNull(line.brandUnitPrice) })),
        map: lineMap.map((entry) => ({ requestLineId: entry.requestLineId, into: entry.into.map((line) => ({ lineId: line.lineId, pieces: pieces.get(line.lineId) ?? 0 })) })),
      })
      if (carry.length > 0 && currency !== current.currency) made.warnings.push(`The customer's prices are in ${current.currency}, the order in ${currency}: they were not carried (a price is never converted).`)
      else {
        for (const entry of carry) {
          const data = { id: newId(), companyId: current.companyId, partyId: current.partyId, salesOrderId: outcome.orderId, salesOrderLineId: entry.orderLineId, unitPrice: entry.unitPrice, netAmount: entry.netAmount, currency, source: 'PORTAL' as const, sourceFileId: null, note: null, enteredById: null, enteredAt: now }
          await tx.orderBrandPrice.create({ data: { ...data, createdAt: now, updatedAt: now }, select: { id: true } })
          auditBrandPrice(tools, priced, { action: 'brandPrices.fromRequest', after: { ...brandPriceAuditView({ ...data, version: 1 }), requestId: current.id, requestLineIds: [...entry.requestLineIds] } })
        }
        if (carry.length > 0) announceBrandPrices(tools, priced)
        brandPrices = carry.length
      }
      // ---- end B-CP-076
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
          // until the office types it on the quote. B-CP-077: a mapped line has no price shown; each planned line goes by its
          // place in the plan (1, 2, …), and what the copy leaves out is said by the request's own line number below.
          lines: plan.lines.map((line, place) => {
            const shown = priceText((line.kind === 'CATALOGUE' ? priceOrNull(byId.get(line.requestLineId)!.unitPriceShown) : null) ?? '0')
            return { seq: place + 1, kind: 'SIZE_GRID' as const, styleId: line.styleId, colourwayId: line.colourwayId, description: line.description, note: line.note, unitPrice: shown, listUnitPrice: shown, sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: null })) }
          }),
        },
        { customerRef: current.customerRef },
      )
      quoteId = outcome.quoteId
      const number = (await tx.quote.findUniqueOrThrow({ where: { id: outcome.quoteId }, select: { number: true } })).number
      // B-CP-077: a place the copy left out whole (a style no longer sold) has no quote line; what it left out names the request's line.
      const left = new Set(outcome.dropped.filter((entry) => entry.size === null).map((entry) => entry.seq - 1))
      made = { number, dropped: outcome.dropped.map((entry) => ({ ...entry, seq: plan.lines[entry.seq - 1]?.requestSeq ?? entry.seq })), warnings: [...plan.warnings, ...outcome.warnings] }
      lineMap = lineMapOf(plan.lines, await tx.quoteLine.findMany({ where: { quoteVersion: { quoteId: outcome.quoteId } }, select: { id: true, seq: true }, orderBy: { seq: 'asc' } }), left)
    }
    await tx.portalOrderRequest.update({ where: { id: current.id }, data: { status: 'ACCEPTED', decidedAt: now, decidedById: context.actorId, salesOrderId, quoteId, version: current.version + 1 }, select: { id: true } })
    // B-CP-077: + the map (ids and places only: each request line and the lines made from it) and the mapped lines' typed prices.
    const typed = [...(body.lines ?? []), ...(body.map ?? []).flatMap((entry) => entry.into.flatMap((into) => (into.unitPrice === undefined ? [] : [{ lineId: entry.lineId, styleId: into.styleId, unitPrice: into.unitPrice }])))]
    tools.audit({
      recordType: 'PortalOrderRequest',
      recordId: current.id,
      companyId: current.companyId,
      before: { status: 'SENT' },
      after: { status: 'ACCEPTED', as: body.as, salesOrderId, quoteId, number: made.number, prices: markMoney('price', typed), lineMap: lineMap.map((entry) => ({ requestLineId: entry.requestLineId, requestSeq: entry.requestSeq, into: entry.into.map((line) => line.lineId) })) },
    })
    tools.emit({ type: 'portal_order_request.accepted', subject: current.id, companyId: current.companyId, payload: { requestId: current.id, number: current.number!, partyId: current.partyId, salesOrderId, quoteId } })
    return { as: body.as, salesOrderId, quoteId, number: made.number, dropped: made.dropped, warnings: made.warnings, lines: lineMap.map((entry) => ({ ...entry, into: entry.into.map((line) => ({ ...line })) })) /* B-CP-077: the answer's own copy (the contract's arrays) */, brandPrices: asMoney('price', brandPrices) /* B-CP-076: how many customer prices it carried, the price grain (contract) */ }
  }, { ...COMMAND_SETTINGS, clock })
  // B-CP-077: the request's logos carried to what it became (after the command: the order stands even when a file cannot be copied).
  const artwork = await carryArtwork(() => files ?? processFiles(), caller, { id: row.id, companyId: row.companyId, partyId: row.partyId, number: row.number }, result)
  const warnings = [...result.warnings, ...artwork.notCarried.map((entry) => `The logo ${entry.name} was not carried: ${entry.reason}`)]
  return { ...(await officeRequestView(caller, requestId)), made: { ...result, warnings, artwork } }
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
