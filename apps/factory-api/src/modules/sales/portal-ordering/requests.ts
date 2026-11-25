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
import { portalReader } from '../portal-orders/access'
import { factsOf, readCatalogue, type CustomerCatalogue } from './catalogue'
// od-s s.2 (order start, 13-backend § 2): every draft command takes ONE writer (the portal's session, or an office person over the
// draft's company and customer); the party reads name the writer's party (W1); who saved it (W2); who stamps the price (W4).
import { portalWriter, type DraftWriter } from './writer'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { officeDraftStaleWords, OFFICE_DRAFT_WORDS } from '@nexus/factory-domain/sales/portal-ordering/rules'
import type { SheetOf } from './people'
// od-s s.4 (order start; addendum R1–R3): Send holds only on an invalid value; Still open; a row's sizing and open choices.
import { holdsSend } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { choiceProblems, choicesOf, type DraftChoice } from '@nexus/factory-domain/sales/portal-ordering/choices'
import { draftStillOpen, shipToInUseOf, writeChoices } from './people'
import { dayText, dayValue, iso, lockRequest, priceOrNull, readDraftFiles, readLines, readRequest, REQUEST_COLUMNS, type DraftFileRow, type LineRow, type Reader, type RequestRow } from './store'
import { catalogueLines, isCatalogueLine, ownWordsOf, type CatalogueLineRow } from './store' // B-CP-005
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
 *
 * od-s s.2 (order start, Owner yes 1a): the office fills the SAME draft through the SAME commands (./writer.ts: the office writer
 * over the draft's company and customer, orders.manage). The office starts a customer's draft, changes its header, lines, people
 * and files, and discards only a draft an office person started; it never types the customer's own price (`brandUnitPrice`: 400,
 * the office routes refuse it). The portal says "the factory" for every office save, never a worker's name (W2).
 */

const MAX_DRAFTS = 20
const LIST_MAX = 200
/** od-s s.3 (addendum R2): a draft's subject, as a mail's (the database holds 1 to 200 trimmed). */
export const SUBJECT_MAX = 200

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const today = (app: FastifyInstance): BusinessDate => businessDate(appClock(app).now())

// ---- reads -----------------------------------------------------------------------------------------------------------

/**
 * The draft's request of the writer: of its company, read in its scope (portal: the party's rows by row-level security; od-s s.2
 * office: the tenant's, so the customer is checked here — another customer's draft is not found, as a wrong id), or 404.
 */
export async function ownRequest(writer: DraftWriter, requestId: string): Promise<RequestRow> {
  const row = await writer.scoped((client) => readRequest(client, requestId))
  if (!row || row.companyId !== writer.companyId || row.partyId !== writer.partyId) throw new NotFoundError('Order request not found.')
  return row
}

// ---- od-s s.2 (W2): who saved the draft, said from the reader's side ------------------------------------------------------------
/**
 * "Saved 10:52 by …": YOU (the reader), COLLEAGUE (a person of the draft's customer), FACTORY (an office person). The portal never
 * names a factory worker (FACTORY: name always null); the office names every person (a customer's person: the page adds the
 * customer). null id (a draft saved before the column): COLLEAGUE with no name.
 */
export interface SavedBy {
  readonly who: 'YOU' | 'COLLEAGUE' | 'FACTORY'
  readonly name: string | null
}

/** Who saved (or started) a draft of `partyId`, for each of these people, read once (see SavedBy). */
export async function savedByAll(writer: DraftWriter, partyId: string, userIds: readonly (string | null)[]): Promise<(userId: string | null) => SavedBy> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null && isUuid(id)))]
  const users = ids.length === 0 ? new Map<string, { displayName: string; audience: string; partyId: string | null }>() : await writer.inTenant(async (db) => new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, audience: true, partyId: true } })).map((user) => [user.id, user])))
  return (userId) => {
    if (userId === null || !isUuid(userId)) return { who: 'COLLEAGUE', name: null }
    const user = users.get(userId)
    const customer = user !== undefined && user.audience === 'PARTNER' && user.partyId === partyId
    if (writer.door === 'portal') {
      if (!customer) return { who: 'FACTORY', name: null }
      return { who: userId === writer.userId ? 'YOU' : 'COLLEAGUE', name: user.displayName }
    }
    if (userId === writer.userId) return { who: 'YOU', name: user?.displayName ?? null }
    return { who: customer ? 'COLLEAGUE' : 'FACTORY', name: user?.displayName ?? null }
  }
}

export async function savedByOf(writer: DraftWriter, partyId: string, userId: string | null): Promise<SavedBy> {
  return (await savedByAll(writer, partyId, [userId]))(userId)
}

/**
 * od-s s.3 (L5): whether the factory made a style draft for the request (`styleIds` not empty) — read in the tenant's scope as the
 * person (the partner role has no grant on the column), answered as a yes/no only: no style id reaches the portal.
 */
async function designStartedOf(writer: DraftWriter, requestId: string): Promise<boolean> {
  const row = await writer.inTenant((db) => db.portalOrderRequest.findFirst({ where: { id: requestId, partyId: writer.partyId }, select: { styleIds: true } }))
  return (row?.styleIds.length ?? 0) > 0
}

/** Whether an office person started the draft (od-s s.2, Owner yes 1a: the office discards only such a draft). */
async function startedByOffice(writer: DraftWriter, createdById: string | null): Promise<boolean> {
  if (createdById === null || !isUuid(createdById)) return false
  return (await writer.inTenant((db) => db.user.count({ where: { id: createdById, audience: 'OFFICE' } }))) > 0
}
// ---- end od-s s.2

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
async function sourcesOf(writer: DraftWriter, lines: readonly LineRow[]): Promise<Map<string, SourceFacts>> {
  const ids = [...new Set(lines.flatMap((line) => (line.sourceOrderLineId ? [line.sourceOrderLineId] : [])))]
  if (ids.length === 0) return new Map()
  // od-s s.2 (W1): the draft's party's own order lines only (the office scope reads every customer's).
  const rows = await writer.scoped((client) =>
    client.salesOrderLine.findMany({
      where: { id: { in: ids }, order: { partyId: writer.partyId } },
      select: { id: true, kind: true, unitPrice: true, styleRevisionId: true, order: { select: { id: true, number: true, customerRef: true, orderDate: true, customerSeq: true /* B-TH-304 */ } }, sizes: { select: { size: true, quantity: true } } },
    }),
  )
  const revisionIds = [...new Set(rows.flatMap((row) => (row.styleRevisionId ? [row.styleRevisionId] : [])))]
  const revisions = revisionIds.length === 0 ? new Map<string, number>() : await writer.inTenant(async (db) => new Map((await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision])))
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

/**
 * The party's delivery addresses: every SHIP_TO one, active first. od-s s.2 (W1, 13-backend § 2): the writer's party by name — the
 * partner scope keeps to it by itself, the office scope would read EVERY customer's addresses onto the draft's page.
 */
export async function shipToAddresses(writer: DraftWriter) {
  const rows = await writer.scoped((client) =>
    client.partyAddress.findMany({
      where: { partyId: writer.partyId, kinds: { has: 'SHIP_TO' } },
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
    sizing: line.sizing, // od-s s.4: null = not decided yet
    choices: choicesOf(line.choices), // od-s s.4: null = none
  }
}

// B-CP-075: problemView (./people.ts) also names the part of the checklist and the person a problem is on.
const NO_MTM: MadeToMeasure = { open: false, garmentTypes: [] }

/**
 * The request as the customer reads it (any status). od-s s.2: the SAME answer for the office's draft page (the office writer):
 * grain-filtered alike; a measurement sheet named only with sales.measurements.view; who saved it from the reader's side.
 */
export async function requestView(writer: DraftWriter, row: RequestRow) {
  const day = today(writer.app)
  const lines = await writer.scoped((client) => readLines(client, [row.id]))
  // B-CP-005: the catalogue lines are read with the catalogue; a described or made-to-measure line is shown by its kind
  // (B-CP-075: `customLines`), not as a style it does not have (it still counts in the header and the totals).
  const listed = catalogueLines(lines)
  const draft = row.status === 'DRAFT'
  // ---- B-CP-075: the lines of the customer's own kinds and their people; made to measure for it, who saved it last (the tenant's
  // scope: the catalogue, the measurement templates, the portal settings and the colleague's name are the office's rows).
  const custom = lines.filter(isCustomLine)
  const people = await writer.scoped((client) => readPeople(client, [row.id]))
  const styleIds = [...listed.map((line) => line.styleId), ...custom.flatMap((line) => (line.styleId ? [line.styleId] : []))]
  const { catalogue, mtm, editedBy } = await writer.inTenant(async (db) => ({
    catalogue: await readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day, styleIds }),
    mtm: draft || custom.length > 0 ? await madeToMeasureOf(db, row.companyId, row.partyId) : NO_MTM,
    editedBy: await colleagueNameOf(db, row.partyId, row.lastEditedById),
  }))
  // ---- end B-CP-075
  // od-s s.2 (W2): who saved it, from the reader's side (the portal never names a factory worker; the office names every person).
  const savedBy = await savedByOf(writer, row.partyId, row.lastEditedById)
  const sources = await sourcesOf(writer, lines)
  const addresses = await shipToAddresses(writer)
  const views = listed.map((line) => lineView(line, catalogue, line.sourceOrderLineId ? (sources.get(line.sourceOrderLineId) ?? null) : null, writer.seesPrices))
  // end B-CP-005
  // B-CP-072: its files (the party's own, partner scope) by part; on live, files wait for the virus scanner (the e-mail way).
  const stored = await writer.scoped((client) => readDraftFiles(client, [row.id], lines.map((line) => line.id)))
  const files = draftFilesByPart(stored, row.id)
  const closed = uploadsClosed(writer, row)
  // B-CP-075: a by-person line's people (a sheet named: the customer's own file); a sheet on a line stands for its roster.
  // od-s s.2: the office names a measurement sheet only with sales.measurements.view (else locked, nameless: body data).
  const sheetsLocked = writer.door === 'office' && !can(writer.actor, SALES_MEASUREMENTS_VIEW, { companyId: row.companyId, partyId: row.partyId })
  const sheetLines = sheetLinesOf(stored)
  const sheetOf: SheetOf = sheetsLocked ? (fileId) => (stored.some((file) => file.id === fileId) ? { id: fileId, originalName: null, locked: true } : null) : ownSheetOf(stored)
  const customViews = custom.map((line) => customLineView(line, people, sheetLines, catalogue, mtm, sheetOf))
  const fileView = (file: Parameters<typeof draftFileView>[0]) => draftFileView(file, sheetsLocked && file.category === 'MEASUREMENTS')
  const shipTo = row.shipToAddressId ? addresses.find((address) => address.id === row.shipToAddressId) : undefined
  const problems = draft
    ? [
        ...headerProblems({ requestedDate: dayText(row.requestedDate), shipToActive: row.shipToAddressId === null ? null : shipTo?.status === 'ACTIVE', lineCount: lines.length }, day).map(problemView),
        // B-CP-075: every line's, in the draft's order (catalogue and custom lines by seq).
        ...[...views, ...customViews].sort((a, b) => a.seq - b.seq).flatMap((line) => line.problems),
      ]
    : []
  const totals = draftTotals(lines.map((line) => ({ sizes: sizesOf(line), unitPriceShown: priceOrNull(line.unitPriceShown), pieces: piecesOfLine(line, people) /* B-CP-075 */ })), writer.seesPrices)
  const outcome = await outcomeOf(writer, row)
  const may = await mayOn(writer, row) // B-CP-070; od-s s.2: the office's own rule
  return {
    request: {
      id: row.id,
      number: row.number,
      status: row.status as RequestStatus,
      words: REQUEST_STATUS_WORDS[row.status as RequestStatus],
      source: row.source as RequestSource,
      subject: row.subject, // od-s s.3 (addendum R2): the draft's title
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
      // od-s s.4 (addendum R1): only an invalid value holds the Send; a missing one is information (Still open, the Confirm asks it).
      held: heldWords(problems.filter((entry) => holdsSend(entry.code)).length),
      pricesChanged: views.filter((line) => line.problems.some((problem) => problem.code === 'PRICE_CHANGED')).length,
      notice: REQUEST_NOTICE,
      // B-CP-070: send / withdraw (who may order), discard (who may order, or the one who started the draft).
      may: { send: draft && may.order, withdraw: row.status === 'SENT' && may.order, discard: draft && may.discard },
      // B-CP-072: logos, references and measurement sheets (the draft's own and its lines'); uploads open here, or why not.
      files: { logos: files.logos.map(fileView), references: files.references.map(fileView), sheets: files.sheets.map(fileView) },
      uploads: { open: closed === null, words: closed },
      // ---- B-CP-075
      customLines: customViews,
      laterParts: [...row.laterParts],
      // od-s s.2 (W2): the portal names only its own people (never an office name); the office names whoever saved it.
      lastEditedBy: writer.door === 'portal' ? editedBy : savedBy.name,
      lastEditedAt: iso(row.lastEditedAt),
      madeToMeasure: draft ? { open: mtm.open, words: mtm.open ? null : MTM_CLOSED_WORDS, garmentTypes: mtm.open ? [...mtm.garmentTypes] : [] } : null,
      // ---- end B-CP-075
      savedBy, // od-s s.2 (W2)
      // od-s s.4: what is not decided yet (information only; `confirmHeld`: the office's Confirm window will ask what the order needs).
      stillOpen: draftStillOpen(lines, people, row, shipToInUseOf(row, addresses), day),
      // od-s s.3 (L5): the portal reads only whether the factory works on the design, never a style id (the office reads its own styles).
      ...(writer.door === 'portal' ? { designStarted: await designStartedOf(writer, row.id) } : {}),
    },
    addresses: addresses.map(({ approvalStatus, refuseReason, ...address }) => ({ ...address, isDefault: address.isDefaultShipTo, approval: approvalView({ approvalStatus, refuseReason }) })),
    seesPrices: writer.seesPrices,
  }
}

// ---- B-CP-070 (D11): who sends, who discards ------------------------------------------------------------------------------

/**
 * What the reader may do with the request beside filling a draft: order (send, withdraw), discard the draft. od-s s.2 (Owner yes
 * 1a): the office sends a draft only through its Confirm (`order` false here) and discards only a draft an office person started,
 * with orders.manage over the customer.
 */
async function mayOn(writer: DraftWriter, row: Pick<RequestRow, 'companyId' | 'partyId' | 'createdById'>): Promise<{ readonly order: boolean; readonly discard: boolean }> {
  if (writer.preview) return { order: false, discard: false }
  const scope = { companyId: row.companyId, partyId: row.partyId }
  if (writer.door === 'office') return { order: false, discard: can(writer.actor, ORDERS_MANAGE, scope) && (await startedByOffice(writer, row.createdById)) }
  const order = can(writer.actor, PORTAL_ORDER_REQUESTS_MANAGE, scope)
  return { order, discard: order || row.createdById === writer.userId }
}

/** The refusal of a discard by a colleague who neither orders nor started the draft (the page names who may). */
const DISCARD_HELD = 'Only the colleague who started this draft, or one who may send orders, discards it.'
// ---- end B-CP-070

/** B-CP-072: why files cannot go up onto this request now, in the person's words (null: they can) — said before one is dropped. */
function uploadsClosed(writer: DraftWriter, row: Pick<RequestRow, 'status' | 'companyId' | 'partyId'>): string | null {
  const gate = outsideUploadsWords()
  if (gate !== null) return gate
  const scope = { companyId: row.companyId, partyId: row.partyId }
  // od-s s.2: the office uploads onto a customer's draft with files.upload over it (Owner yes 1a), in its own words.
  if (writer.door === 'office') return row.status !== 'DRAFT' ? OFFICE_DRAFT_WORDS.FILES_CLOSED.en : can(writer.actor, FILES_UPLOAD, scope) ? null : OFFICE_DRAFT_WORDS.NO_UPLOAD.en
  if (row.status !== 'DRAFT') return portalUploadWords('REQUEST_CLOSED', writer.locale)
  if (writer.preview) return 'A preview of the portal sends no file.'
  return can(writer.actor, PORTAL_UPLOAD, scope) ? null : portalUploadWords('NO_UPLOAD', writer.locale)
}

/**
 * B-CP-072: a draft's file as the customer reads it (its own party's: named, with its version for a removal). od-s s.2: `locked` —
 * a measurement sheet the office reader may not open (no sales.measurements.view): no name.
 */
export const draftFileView = (file: DraftFileRow & { readonly lineId: string | null }, locked = false) => ({
  id: file.id,
  lineId: file.lineId,
  originalName: locked ? null : file.originalName,
  kind: file.kind,
  contentType: file.contentType,
  sizeBytes: file.sizeBytes,
  status: file.status,
  version: file.version,
  createdAt: iso(file.createdAt)!,
  locked,
})

/** The order or quote a request became (partner reads: their number). */
async function outcomeOf(writer: DraftWriter, row: Pick<RequestRow, 'salesOrderId' | 'quoteId'>) {
  const salesOrder = row.salesOrderId ? await writer.scoped((client) => client.salesOrder.findUnique({ where: { id: row.salesOrderId! }, select: { id: true, number: true } })) : null
  const quote = row.quoteId ? await writer.scoped((client) => client.quote.findUnique({ where: { id: row.quoteId! }, select: { id: true, number: true } })) : null
  return { salesOrder: salesOrder ?? null, quote: quote ?? null }
}

export async function listRequests(writer: DraftWriter, query: { readonly status: RequestStatus | 'ALL' }) {
  const rows = await writer.scoped((client) =>
    client.portalOrderRequest.findMany({
      where: { companyId: writer.companyId, partyId: writer.partyId, ...(query.status === 'ALL' ? {} : { status: query.status }) },
      select: REQUEST_COLUMNS,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: LIST_MAX,
    }),
  )
  const ordered = [...rows.filter((row) => row.status === 'DRAFT'), ...rows.filter((row) => row.status !== 'DRAFT')]
  const lines = await writer.scoped((client) => readLines(client, ordered.map((row) => row.id)))
  const people = await writer.scoped((client) => readPeople(client, ordered.map((row) => row.id))) // B-CP-075: a by-person line's pieces are its people
  const orders = await writer.scoped((client) => client.salesOrder.findMany({ where: { id: { in: ordered.flatMap((row) => (row.salesOrderId ? [row.salesOrderId] : [])) } }, select: { id: true, number: true } }))
  const quotes = await writer.scoped((client) => client.quote.findMany({ where: { id: { in: ordered.flatMap((row) => (row.quoteId ? [row.quoteId] : [])) } }, select: { id: true, number: true } }))
  // ---- od-s s.2 (W2): "Continue a draft" — each draft's title (line 1's own words, else its style), who started it and who saved
  // it last, from the reader's side (an office person is "the factory", never named).
  const drafts = ordered.filter((row) => row.status === 'DRAFT')
  const firstLines = new Map(drafts.map((row) => [row.id, lines.filter((line) => line.requestId === row.id).sort((a, b) => a.seq - b.seq)[0]]))
  const firstStyles = [...new Set([...firstLines.values()].flatMap((line) => (line && isCatalogueLine(line) ? [line.styleId] : [])))]
  const styleNames = firstStyles.length === 0 ? new Map<string, string>() : await writer.inTenant(async (db) => new Map((await db.style.findMany({ where: { id: { in: firstStyles } }, select: { id: true, code: true, name: true } })).map((style) => [style.id, `${style.code} ${style.name}`.trim()])))
  const whoSaved = await savedByAll(writer, writer.partyId, drafts.flatMap((row) => [row.createdById, row.lastEditedById]))
  // od-s s.4 (lead addition B): each draft's Still open count (information only) for the "Continue a draft" row.
  const addresses = drafts.length === 0 ? [] : await shipToAddresses(writer)
  const day = today(writer.app)
  const draftOf = (row: RequestRow) => {
    if (row.status !== 'DRAFT') return null
    const open = draftStillOpen(lines.filter((line) => line.requestId === row.id), people.filter((person) => person.requestId === row.id), row, shipToInUseOf(row, addresses), day)
    const first = firstLines.get(row.id)
    // od-s s.3 (addendum R2): the subject is the title; else line 1's words or style.
    return { title: row.subject ?? (first ? (isCatalogueLine(first) ? (styleNames.get(first.styleId) ?? null) : ownWordsOf(first)) : null), startedBy: whoSaved(row.createdById), savedBy: whoSaved(row.lastEditedById), savedAt: iso(row.lastEditedAt ?? row.updatedAt)!, openCount: open.openCount, confirmHeld: open.confirmHeld }
  }
  // ---- end od-s s.2
  return {
    requests: ordered.map((row) => {
      const own = lines.filter((line) => line.requestId === row.id)
      const totals = draftTotals(own.map((line) => ({ sizes: sizesOf(line), unitPriceShown: priceOrNull(line.unitPriceShown), pieces: piecesOfLine(line, people) /* B-CP-075 */ })), writer.seesPrices)
      return {
        id: row.id,
        number: row.number,
        status: row.status as RequestStatus,
        words: REQUEST_STATUS_WORDS[row.status as RequestStatus],
        source: row.source as RequestSource,
        subject: row.subject, // od-s s.3
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
        draft: draftOf(row), // od-s s.2
      }
    }),
    seesPrices: writer.seesPrices,
  }
}

export async function getRequest(writer: DraftWriter, requestId: string) {
  return requestView(writer, await ownRequest(writer, requestId))
}

// ---- the draft's header ------------------------------------------------------------------------------------------------

export interface HeaderBody {
  /** od-s s.3 (addendum R2): the draft's subject, as a mail's (1 to 200; null clears it) — its title. */
  readonly subject?: string | null | undefined
  readonly customerRef?: string | null | undefined
  readonly shipToAddressId?: string | null | undefined
  readonly requestedDate?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
  /** B-CP-075: the parts the customer sends later (LOGOS, REFERENCES, PEOPLE), each once; [] clears them. */
  readonly laterParts?: readonly ('LOGOS' | 'REFERENCES' | 'PEOPLE')[] | undefined
}

/**
 * The header's own problems (400): an address of the party for deliveries, active; a date from today. od-s s.2 (W1): the address
 * of the writer's party by name (the office scope reads every customer's: another customer's address is "choose one of yours").
 */
async function headerIssues(writer: DraftWriter, body: HeaderBody, day: BusinessDate): Promise<Issue[]> {
  const issues: Issue[] = []
  if (body.shipToAddressId) {
    const address = isUuid(body.shipToAddressId) ? await writer.scoped((client) => client.partyAddress.findFirst({ where: { id: body.shipToAddressId!, partyId: writer.partyId }, select: { status: true, kinds: true } })) : null
    if (!address || address.status !== 'ACTIVE' || !address.kinds.includes('SHIP_TO')) issues.push({ path: 'body/shipToAddressId', message: 'Choose one of your active delivery addresses.' })
  }
  if (body.requestedDate && body.requestedDate < day) issues.push({ path: 'body/requestedDate', message: 'The requested delivery date is today or later.' })
  if (body.subject && body.subject.trim().length > SUBJECT_MAX) issues.push({ path: 'body/subject', message: `A subject is at most ${SUBJECT_MAX} characters.` }) // od-s s.3
  if (body.customerRef && body.customerRef.trim().length > ORDERING_LIMITS.customerRef) issues.push({ path: 'body/customerRef', message: `At most ${ORDERING_LIMITS.customerRef} characters.` })
  if (body.note && body.note.trim().length > ORDERING_LIMITS.note) issues.push({ path: 'body/note', message: `At most ${ORDERING_LIMITS.note} characters.` })
  if (body.laterParts && new Set(body.laterParts).size !== body.laterParts.length) issues.push({ path: 'body/laterParts', message: 'Name each part sent later once.' }) // B-CP-075
  return issues
}

const headerData = (body: HeaderBody) => ({
  ...(body.subject !== undefined ? { subject: blankToNull(body.subject) } : {}), // od-s s.3
  ...(body.customerRef !== undefined ? { customerRef: blankToNull(body.customerRef) } : {}),
  ...(body.shipToAddressId !== undefined ? { shipToAddressId: body.shipToAddressId } : {}),
  ...(body.requestedDate !== undefined ? { requestedDate: body.requestedDate === null ? null : dayValue(body.requestedDate) } : {}),
  ...(body.note !== undefined ? { note: blankToNull(body.note) } : {}),
  ...(body.laterParts !== undefined ? { laterParts: [...body.laterParts] } : {}), // B-CP-075
})

export async function createDraft(writer: DraftWriter, body: HeaderBody & { readonly source?: RequestSource | undefined }, idempotencyKey?: string) {
  const day = today(writer.app)
  const issues = await headerIssues(writer, body, day)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  // od-s s.2 (W1): the cap counts this customer's drafts (the office scope would count every customer's).
  const drafts = await writer.scoped((client) => client.portalOrderRequest.count({ where: { companyId: writer.companyId, partyId: writer.partyId, status: 'DRAFT' } }))
  if (drafts >= MAX_DRAFTS) throw new ConflictError(writer.door === 'portal' ? `You keep ${drafts} drafts already: send or discard one first.` : `This customer keeps ${drafts} drafts already: one is sent, confirmed or discarded first.`)
  const currency = await writer.inTenant(async (db) => (await db.company.findUnique({ where: { id: writer.companyId }, select: { currency: true } }))?.currency ?? 'EUR')
  const id = newId()
  await commandOn(writer.app, writer.request, { name: 'portalOrdering.createDraft', idempotencyKey, input: { ...body } }, async (tools) => {
    // The party's default delivery address when none is asked. od-s s.2 (W1): the writer's party by name.
    const shipTo = body.shipToAddressId === undefined ? ((await tools.tx.partyAddress.findFirst({ where: { partyId: writer.partyId, status: 'ACTIVE', isDefaultShipTo: true, kinds: { has: 'SHIP_TO' } }, select: { id: true } }))?.id ?? null) : body.shipToAddressId
    await tools.tx.portalOrderRequest.create({
      data: { id, companyId: writer.companyId, partyId: writer.partyId, source: body.source ?? 'PICKER', currency, ...headerData(body), shipToAddressId: shipTo, createdById: writer.userId, createdAt: tools.now, updatedAt: tools.now, lastEditedById: writer.userId, lastEditedAt: tools.now /* B-CP-075 */ },
      select: { id: true },
    })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: id, companyId: writer.companyId, after: { status: 'DRAFT', source: body.source ?? 'PICKER', ...headerData(body), shipToAddressId: shipTo, ...(writer.door === 'office' ? { byOffice: true } : {}) } })
    draftChanged(tools, { id, companyId: writer.companyId, partyId: writer.partyId }) // B-CP-071
    return null
  })
  return requestView(writer, (await ownRequest(writer, id))!)
}

/** The draft of the party, for a change by the writer: DRAFT, or 409 in words. */
export async function ownDraft(writer: DraftWriter, requestId: string): Promise<RequestRow> {
  const row = await ownRequest(writer, requestId)
  if (row.status !== 'DRAFT') {
    // od-s s.2: after Send the customer reads only; the office types a late detail in the Confirm window or on the order.
    if (writer.door === 'office') throw new InvalidStateError(row.status === 'SENT' ? OFFICE_DRAFT_WORDS.SENT.en : 'This request is no longer a draft.')
    throw new InvalidStateError(row.status === 'SENT' ? 'This request was sent: withdraw it to change it, or ask us.' : 'This request is no longer a draft.')
  }
  return row
}

/**
 * A change of the draft in the partner scope: its version checked and moved (command's record guard), then the work.
 * B-CP-075: every one names who of the customer saved it ("Saved 10:42 by Marta Bianchi"); a stale version is a 409 that names
 * the colleague who changed it meanwhile (`staleDraftError`).
 */
export async function onDraft<Result>(writer: DraftWriter, name: `${string}.${string}`, row: RequestRow, version: number, input: unknown, idempotencyKey: string | undefined, work: (tools: CommandTools) => Promise<Result>) {
  const editorId = writer.userId // B-CP-075: the person who saves (a link context has no actor id); od-s s.2: or the office person
  try {
    return await commandOn(writer.app, writer.request, { name, idempotencyKey, input, record: { type: 'PortalOrderRequest', id: row.id, expectedVersion: version } }, async (tools) => {
      const current = await readRequest(tools.tx, row.id)
      if (current?.status !== 'DRAFT') throw new InvalidStateError('This request is no longer a draft.')
      const result = await work(tools)
      await markEdited(tools.tx, row.id, editorId, tools.now) // B-CP-075
      draftChanged(tools, row) // B-CP-071
      return result
    })
  } catch (error) {
    throw error instanceof StaleVersionError ? await staleDraftError(writer, row.id) : error // B-CP-075
  }
}

// ---- B-CP-075: "Changed by Marta Bianchi a moment ago" -------------------------------------------------------------------------
/**
 * The 409 of a draft changed since the person read it: who saved it last, the version now. The portal names only its own people;
 * od-s s.2 (W2): an office save is "the factory" there, never a worker's name. The office names whoever saved it.
 */
export async function staleDraftError(writer: DraftWriter, requestId: string): Promise<DomainError> {
  const current = await writer.scoped((client) => readRequest(client, requestId))
  if (!current) return new NotFoundError('Order request not found.')
  const saved = await savedByOf(writer, current.partyId, current.lastEditedById)
  const self = saved.who === 'YOU'
  const name = self ? null : saved.name
  const words = writer.door === 'portal' ? draftStaleWords({ name, self, factory: saved.who === 'FACTORY', version: current.version })[writer.locale] : officeDraftStaleWords({ name, self, version: current.version }).en
  return new DomainError('conflict', words, [{ path: 'version', message: `The current version is ${current.version}.` }, ...(name ? [{ path: 'lastEditedBy', message: name }] : [])])
}
// ---- end B-CP-075

// ---- B-CP-071 (customer page plan D10; review C2): each change of a draft, one per command, tells the office's Drafts of the
// customer to read again — ids only; the party routes the live message (a person limited to another customer is never told).
export function draftChanged(tools: Pick<CommandTools, 'emit'>, row: Pick<RequestRow, 'id' | 'companyId' | 'partyId'>): void {
  tools.emit({ type: 'portal_order_request.draft_changed', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, partyId: row.partyId } })
}
// ---- end B-CP-071

export async function changeHeader(writer: DraftWriter, requestId: string, body: HeaderBody & { readonly version: number }, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  const { version, ...header } = body
  const issues = await headerIssues(writer, header, today(writer.app))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  await onDraft(writer, 'portalOrdering.changeDraft', row, version, { requestId, ...body }, idempotencyKey, async (tools) => {
    const data = headerData(header)
    if (Object.keys(data).length > 0) await tools.tx.portalOrderRequest.update({ where: { id: row.id }, data, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { customerRef: row.customerRef, shipToAddressId: row.shipToAddressId, requestedDate: dayText(row.requestedDate), note: row.note, laterParts: [...row.laterParts] /* B-CP-075 */ }, after: data })
    return null
  })
  return requestView(writer, (await ownRequest(writer, requestId))!)
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
    data: { id, partyId: row.partyId, requestId: row.id, seq, styleId: line.styleId, colourwayId: line.colourwayId, sourceOrderLineId: line.sourceOrderLineId ?? null, unitPriceShown: price, note: blankToNull(line.note), brandUnitPrice: line.brandUnitPrice ?? null /* B-CP-076 */, sizing: 'STANDARD' /* od-s s.4: a size run of the catalogue */, createdById: actorId, createdAt: now, updatedAt: now },
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

export async function addLines(writer: DraftWriter, requestId: string, body: { readonly version: number; readonly lines: readonly NewLine[] }, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  const lines = trimmed(body.lines.map((line) => ({ ...line, sourceOrderLineId: null })))
  const catalogue = await writer.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(writer.app), styleIds: lines.map((line) => line.styleId) }))
  const issues = checkNewLines(lines, catalogue)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const prices = pricesFor(lines, catalogue, writer.stampsPrices) // od-s s.2 (W4): who stamps the price shown
  await onDraft(writer, 'portalOrdering.addLines', row, body.version, { requestId, lines }, idempotencyKey, async (tools) => {
    const outcome = await addLinesInCommand(tools, row, lines, prices, writer.userId, false)
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { added: outcome.added, lines: lines.map((line) => ({ styleId: line.styleId, colourwayId: line.colourwayId, sizes: line.sizes, unitPriceShown: markMoney('price', prices.get(`${line.styleId}|${line.colourwayId}`) ?? null), brandUnitPrice: markMoney('price', line.brandUnitPrice ?? null) /* B-CP-076 */ })) } })
    return null
  })
  return requestView(writer, (await ownRequest(writer, requestId))!)
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
  writer: DraftWriter,
  requestId: string,
  lineId: string,
  body: {
    readonly version: number
    readonly colourwayId?: string | undefined
    readonly sizes?: readonly SizeAsk[] | undefined
    readonly note?: string | null | undefined
    /** od-s s.4: the Sizing cell (custom size makes the row made to measure: by person, its size run goes; null: not decided yet). */
    readonly sizing?: 'STANDARD' | 'MADE_TO_MEASURE' | null | undefined
    /** od-s s.4: the row's open choices (names only; null or [] clears them). */
    readonly choices?: readonly DraftChoice[] | null | undefined
  } & OwnPriced /* B-CP-076 */,
  idempotencyKey?: string,
) {
  const row = await ownDraft(writer, requestId)
  const line = await writer.scoped((client) => ownCatalogueLine(client, row, lineId)) // B-CP-005: a catalogue line
  checkChoices(body.choices, 'body/choices') // od-s s.4
  if (body.sizing === 'MADE_TO_MEASURE') return catalogueToCustomSize(writer, row, line, body, idempotencyKey) // od-s s.4
  const next: NewLine = { styleId: line.styleId, colourwayId: body.colourwayId ?? line.colourwayId, sizes: (body.sizes ?? sizesOf(line)).map((ask) => ({ size: ask.size.trim(), quantity: ask.quantity })), note: body.note === undefined ? line.note : body.note }
  const catalogue = await writer.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(writer.app), styleIds: [line.styleId] }))
  // Only a change of sizes or colour is checked against today's catalogue: a note alone keeps the line as it was.
  const touchesCatalogue = body.sizes !== undefined || body.colourwayId !== undefined
  const issues = touchesCatalogue ? checkNewLines([next], catalogue, 'body/line') : lineShapeProblems(next).filter((message) => message.includes('note')).map((message) => ({ path: 'body/note', message }))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const colourChanged = next.colourwayId !== line.colourwayId
  if (colourChanged) {
    // B-CP-005: a duplicate is another catalogue line of the same style and colour.
    const duplicate = catalogueLines(await writer.scoped((client) => readLines(client, [row.id]))).find((entry) => entry.id !== line.id && entry.styleId === line.styleId && entry.colourwayId === next.colourwayId)
    if (duplicate) throw new ValidationError('This colour is already on the request.', [{ path: 'body/colourwayId', message: `Already on line ${duplicate.seq}.` }])
  }
  const price = colourChanged ? (pricesFor([next], catalogue, writer.stampsPrices).get(`${next.styleId}|${next.colourwayId}`) ?? null) : priceOrNull(line.unitPriceShown) // od-s s.2 (W4)
  await onDraft(writer, 'portalOrdering.changeLine', row, body.version, { requestId, lineId, ...body }, idempotencyKey, async (tools) => {
    const { tx, now } = tools
    const current = await ownLine(tx, row, lineId)
    if (body.sizes !== undefined) {
      await tx.portalOrderRequestSize.deleteMany({ where: { lineId } })
      await tx.portalOrderRequestSize.createMany({ data: next.sizes.map((ask) => ({ id: newId(), partyId: row.partyId, lineId, size: ask.size, quantity: ask.quantity, createdById: writer.userId, createdAt: now, updatedAt: now })) })
    }
    // B-CP-076: "Your price" with the line (absent keeps it, null clears it).
    const own = body.brandUnitPrice !== undefined ? { brandUnitPrice: body.brandUnitPrice } : {}
    const sizing = body.sizing !== undefined ? { sizing: body.sizing } : {} // od-s s.4: STANDARD, or null (not decided yet)
    await tx.portalOrderRequestLine.update({ where: { id: lineId }, data: { colourwayId: next.colourwayId, note: blankToNull(next.note), unitPriceShown: price, ...own, ...sizing, version: { increment: 1 } }, select: { id: true } })
    await writeChoices(tx, lineId, body.choices) // od-s s.4
    tools.audit({
      recordType: 'PortalOrderRequest',
      recordId: row.id,
      companyId: row.companyId,
      before: { lineId, colourwayId: current.colourwayId, sizes: sizesOf(current), note: current.note, unitPriceShown: markMoney('price', priceOrNull(current.unitPriceShown)), brandUnitPrice: markMoney('price', priceOrNull(current.brandUnitPrice)) /* B-CP-076 */, sizing: current.sizing, choices: current.choices },
      after: { lineId, colourwayId: next.colourwayId, sizes: next.sizes, note: blankToNull(next.note), unitPriceShown: markMoney('price', price), brandUnitPrice: markMoney('price', body.brandUnitPrice === undefined ? priceOrNull(current.brandUnitPrice) : body.brandUnitPrice) /* B-CP-076 */, ...sizing, ...(body.choices !== undefined ? { choices: body.choices } : {}) },
    })
    return null
  })
  return requestView(writer, (await ownRequest(writer, requestId))!)
}

/**
 * od-s s.4 (addendum R3): a catalogue row whose Sizing cell turns to custom size — in ONE update it becomes made to measure (by
 * person; the style and colour stay as its hint, its size run and the price shown go: its people carry the sizes, the office prices
 * a made-to-measure row at Confirm). Made to measure switched off for the customer: refused in its words.
 */
async function catalogueToCustomSize(writer: DraftWriter, row: RequestRow, line: CatalogueLineRow, body: { readonly version: number; readonly note?: string | null | undefined; readonly choices?: readonly DraftChoice[] | null | undefined } & OwnPriced, idempotencyKey?: string) {
  const mtm = await writer.inTenant((db) => madeToMeasureOf(db, row.companyId, row.partyId))
  if (!mtm.open) throw mtmClosed(writer)
  await onDraft(writer, 'portalOrdering.changeLine', row, body.version, { requestId: row.id, lineId: line.id, ...body }, idempotencyKey, async (tools) => {
    const { tx } = tools
    const current = await ownLine(tx, row, line.id)
    await tx.portalOrderRequestSize.deleteMany({ where: { lineId: line.id } })
    const own = body.brandUnitPrice !== undefined ? { brandUnitPrice: body.brandUnitPrice } : {}
    const note = body.note === undefined ? {} : { note: blankToNull(body.note) }
    await tx.portalOrderRequestLine.update({ where: { id: line.id }, data: { kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', byPerson: true, quantity: null, unitPriceShown: null, ...note, ...own, version: { increment: 1 } }, select: { id: true } })
    await writeChoices(tx, line.id, body.choices)
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { lineId: line.id, kind: current.kind, sizing: current.sizing, sizes: sizesOf(current), unitPriceShown: markMoney('price', priceOrNull(current.unitPriceShown)) }, after: { lineId: line.id, kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', sizes: [], unitPriceShown: markMoney('price', null) } })
    return null
  })
  return requestView(writer, (await ownRequest(writer, row.id))!)
}

export async function removeLine(writer: DraftWriter, requestId: string, lineId: string, version: number, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  await onDraft(writer, 'portalOrdering.removeLine', row, version, { requestId, lineId, version }, idempotencyKey, async (tools) => {
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
  return requestView(writer, (await ownRequest(writer, requestId))!)
}

/** "Prices changed since you started — Review": every line takes the customer's price today. */
export async function takeTodaysPrices(writer: DraftWriter, requestId: string, version: number, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  if (!writer.seesPrices) throw new InvalidStateError('Prices are not part of your access: the factory confirms them.')
  // B-CP-005: a list price is a catalogue line's; a described or made-to-measure line has none to take.
  const lines = catalogueLines(await writer.scoped((client) => readLines(client, [row.id])))
  const catalogue = await writer.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(writer.app), styleIds: lines.map((line) => line.styleId) }))
  const prices = pricesFor(lines, catalogue, true)
  await onDraft(writer, 'portalOrdering.takePrices', row, version, { requestId, version }, idempotencyKey, async (tools) => {
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
  return requestView(writer, (await ownRequest(writer, requestId))!)
}

export async function discardDraft(writer: DraftWriter, requestId: string, version: number, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  // B-CP-070; od-s s.2 (Owner yes 1a): the office discards only a draft an office person started (its own words).
  if (!(await mayOn(writer, row)).discard) throw new ForbiddenError(writer.door === 'office' ? OFFICE_DRAFT_WORDS.DISCARD_HELD.en : DISCARD_HELD)
  await commandOn(writer.app, writer.request, { name: 'portalOrdering.discardDraft', idempotencyKey, input: { requestId, version } }, async (tools) => {
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
    throw error instanceof StaleVersionError ? await staleDraftError(writer, row.id) : error // B-CP-075
  })
  return { discarded: true as const }
}

// ---- send and withdraw -------------------------------------------------------------------------------------------------

/**
 * The problems of a draft today (the send's check): its header's and every line's, as the record shows them. od-s s.4: the Send and
 * the office's Confirm keep only those that hold it (`holdsSend`: an invalid value, never a missing one).
 */
export async function sendProblems(tx: CommandTx, row: RequestRow, lines: readonly LineRow[], day: BusinessDate, seesPrices: boolean, /* B-CP-075 */ people: readonly PersonRow[]): Promise<Problem[]> {
  // B-CP-005: the catalogue's checks (sold, colour, sizes offered, price shown) for its own lines; the header counts every line.
  // B-CP-075: a described or made-to-measure line's own (its total, its people or sheet, made to measure open, its garment type).
  const listed = catalogueLines(lines)
  const custom = lines.filter(isCustomLine)
  const catalogue = await readCatalogue(tx, { companyId: row.companyId, partyId: row.partyId, day, styleIds: [...listed.map((line) => line.styleId), ...custom.flatMap((line) => (line.styleId ? [line.styleId] : []))] })
  const shipTo = row.shipToAddressId ? await tx.partyAddress.findFirst({ where: { id: row.shipToAddressId, partyId: row.partyId }, select: { status: true } }) : null // od-s s.2 (W1)
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
  const writer = portalWriter(app, request) // od-s s.2: the draft's reads through the portal's writer
  const { session } = reader
  const row = await ownDraft(writer, requestId)
  if (row.version !== version) throw await staleDraftError(writer, row.id) // B-CP-075: names who changed it
  const p = portalOf(app)
  const outcome = await p.auth.command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portalOrdering.send', idempotencyKey, input: { requestId, version, sessionId: session.id } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockRequest(tx, requestId, version)
    if (current.partyId !== session.partyId || current.companyId !== session.company.id) throw new NotFoundError('Order request not found.')
    if (current.status !== 'DRAFT') throw new InvalidStateError('This request was already sent.')
    const day = businessDate(now)
    const lines = await readLines(tx, [current.id])
    const people = await readPeople(tx, [current.id]) // B-CP-075
    const problems = (await sendProblems(tx, current, lines, day, reader.seesPrices, people)).filter((entry) => holdsSend(entry.code)) // od-s s.4
    if (problems.length > 0) throw new DomainError('invalid_state', `${problems.length === 1 ? '1 problem holds' : `${problems.length} problems hold`} the send: fix ${problems.length === 1 ? 'it' : 'them'} first.`, problems.map((entry) => ({ path: entry.lineId ? `lines/${entry.lineId}` : 'request', message: entry.words.en })))
    const number = await allocateNumber(tools, { companyId: current.companyId, kind: 'PORTAL_REQUEST' }, { type: 'PortalOrderRequest', id: current.id, date: day })
    await tx.portalOrderRequest.update({ where: { id: current.id }, data: { status: 'SENT', number: number.formatted, sentAt: now, sentById: session.userId, version: current.version + 1 }, select: { id: true } })
    // B-CP-075: each line's pieces by its kind; a request whose only people are in an attached sheet counts one (at least one person).
    const pieces = Math.max(1, lines.reduce((sum, line) => sum + piecesOfLine(line, people), 0))
    tools.audit({ recordType: 'PortalOrderRequest', recordId: current.id, companyId: current.companyId, before: { status: 'DRAFT' }, after: { status: 'SENT', number: number.formatted, lines: lines.length, pieces, byPartner: true } })
    tools.emit({ type: 'portal_order_request.sent', subject: current.id, companyId: current.companyId, payload: { requestId: current.id, number: number.formatted, partyId: current.partyId, source: current.source, lines: lines.length, pieces } })
    return { number: number.formatted }
  })
  const sent = await ownRequest(writer, requestId)
  const { number } = outcome.result
  const po = sent.customerRef
  return {
    ...(await requestView(writer, sent)),
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
  const writer = portalWriter(app, request) // od-s s.2
  const row = await ownRequest(writer, requestId)
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
  return requestView(writer, await ownRequest(writer, requestId))
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
//
// od-s s.2: the office's twins under /sales/order-requests/:id/… call these same commands with the office writer.

export type CustomLineBody = Omit<CustomLineInput, 'kind'>

/** The catalogue (the styles a custom line names) and made to measure for the customer, in the tenant's scope. */
async function customFactsOf(writer: DraftWriter, row: RequestRow, styleIds: readonly (string | null | undefined)[]) {
  const wanted = styleIds.filter((id): id is string => typeof id === 'string' && isUuid(id))
  return writer.inTenant(async (db) => ({ catalogue: await readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(writer.app), styleIds: wanted }), mtm: await madeToMeasureOf(db, row.companyId, row.partyId) }))
}

/** Made to measure switched off for the customer: a made-to-measure line or its people are not written (409 in its words). */
function mtmClosed(writer: DraftWriter): DomainError {
  const words = MTM_CLOSED_WORDS[writer.locale]
  return new DomainError('invalid_state', words, [{ path: 'refusal/MTM_CLOSED', message: words }])
}

/**
 * od-s s.4 (addendum R3, the products table): a row's kind follows its Sizing cell — custom size is MADE_TO_MEASURE (always by
 * person), standard sizes or not decided yet a DESCRIBED row (a CATALOGUE row comes from the catalogue's own picker, reorder or
 * upload); a body may still name the kind as before. Refused in words when the two disagree (400).
 */
function rowKindOf(kind: CustomLineKind | undefined, sizing: CustomLineInput['sizing']): CustomLineKind {
  if (sizing === 'MADE_TO_MEASURE') {
    if (kind === 'DESCRIBED') throw new ValidationError('A custom-size row is made to measure.', [{ path: 'body/line/kind', message: 'A custom-size row is made to measure.' }])
    return 'MADE_TO_MEASURE'
  }
  if (sizing !== undefined && kind === 'MADE_TO_MEASURE') throw new ValidationError('A made-to-measure row has custom sizes.', [{ path: 'body/line/sizing', message: 'A made-to-measure row has custom sizes.' }])
  return kind ?? 'DESCRIBED'
}

/** A row's choices (400 in words when malformed); [] is none. */
function checkChoices(choices: readonly DraftChoice[] | null | undefined, at: string): void {
  if (choices === undefined || choices === null || choices.length === 0) return
  const issues = choiceProblems(choices, at)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
}

export async function addCustomLine(writer: DraftWriter, requestId: string, body: { readonly version: number; readonly line: Omit<CustomLineInput, 'kind'> & { readonly kind?: CustomLineKind | undefined } & OwnPriced /* B-CP-076 */ }, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  const line: CustomLineInput & OwnPriced = { ...body.line, kind: rowKindOf(body.line.kind, body.line.sizing) } // od-s s.4
  checkChoices(line.choices, 'body/line/choices')
  const { catalogue, mtm } = await customFactsOf(writer, row, [line.styleId])
  if (line.kind === 'MADE_TO_MEASURE' && !mtm.open) throw mtmClosed(writer)
  const issues = checkCustomLine(line, catalogue, mtm)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  await onDraft(writer, 'portalOrdering.addCustomLine', row, body.version, { requestId, line }, idempotencyKey, async (tools) => {
    const existing = await readLines(tools.tx, [row.id])
    if (existing.length >= ORDERING_LIMITS.lines) throw new ValidationError(`At most ${ORDERING_LIMITS.lines} lines per request.`, [{ path: 'body/line', message: `At most ${ORDERING_LIMITS.lines} lines per request.` }])
    const seq = existing.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1
    const id = await insertCustomLine(tools.tx, row, line, seq, writer.userId, tools.now)
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { added: id, seq, kind: line.kind, ...customLineData(line), sizes: line.sizes ?? [], choices: line.choices ?? null, brandUnitPrice: markMoney('price', line.brandUnitPrice ?? null) /* B-CP-076 */ } })
    return null
  })
  return requestView(writer, (await ownRequest(writer, requestId))!)
}

/** The draft's described or made-to-measure line (a catalogue line keeps its own editor: PUT …/lines/:lineId). */
async function ownCustomLine(db: Reader, row: RequestRow, lineId: string): Promise<LineRow & { readonly kind: CustomLineKind }> {
  const line = await ownLine(db, row, lineId)
  if (!isCustomLine(line)) throw new InvalidStateError(`Line ${line.seq} is from the catalogue: change its colour and sizes there.`)
  return line
}

export async function changeCustomLine(writer: DraftWriter, requestId: string, lineId: string, body: CustomLineBody & OwnPriced /* B-CP-076 */ & { readonly version: number }, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  const line = await writer.scoped((client) => ownCustomLine(client, row, lineId))
  const keep = <T>(asked: T | undefined, now: T): T => (asked === undefined ? now : asked)
  // od-s s.4 (addendum R3): the Sizing cell changes the row's kind in this one update — custom size: made to measure (by person; its
  // total and size run go, its people carry the sizes); standard or not decided: a described row (the garment type goes).
  const kind: CustomLineKind = body.sizing === undefined ? line.kind : body.sizing === 'MADE_TO_MEASURE' ? 'MADE_TO_MEASURE' : 'DESCRIBED'
  const toMtm = kind === 'MADE_TO_MEASURE' && line.kind !== 'MADE_TO_MEASURE'
  checkChoices(body.choices, 'body/choices')
  const next: CustomLineInput = {
    kind,
    sizing: keep(body.sizing, line.sizing),
    description: keep(body.description, line.description),
    colourText: keep(body.colourText, line.colourText),
    styleId: keep(body.styleId, line.styleId),
    colourwayId: body.styleId !== undefined && body.colourwayId === undefined && body.styleId !== line.styleId ? null : keep(body.colourwayId, line.colourwayId),
    garmentType: keep(body.garmentType, line.garmentType),
    quantity: toMtm ? null : keep(body.quantity, line.quantity),
    byPerson: kind === 'MADE_TO_MEASURE' ? true : keep(body.byPerson, line.byPerson),
    sizes: toMtm ? [] : (body.sizes ?? sizesOf(line)),
    note: keep(body.note, line.note),
  }
  const { catalogue, mtm } = await customFactsOf(writer, row, [next.styleId])
  if (next.kind === 'MADE_TO_MEASURE' && !mtm.open) throw mtmClosed(writer)
  // The shape always; against today's catalogue and garment types only what this change asks (a style that stopped being sold, or a
  // garment type no longer offered, stays a problem of the line to fix, never a refusal of an unrelated change).
  const styleAsked = body.styleId !== undefined || body.colourwayId !== undefined
  const issues = checkCustomLine(next, catalogue, mtm, 'body').filter((issue) => (styleAsked || !/\/(styleId|colourwayId)$/.test(issue.path)) && (body.garmentType !== undefined || !issue.path.endsWith('/garmentType')))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  await onDraft(writer, 'portalOrdering.changeCustomLine', row, body.version, { requestId, lineId, ...body }, idempotencyKey, async (tools) => {
    const { tx, now } = tools
    const current = await ownCustomLine(tx, row, lineId)
    const people = await tx.portalOrderRequestPerson.count({ where: { lineId } })
    if (current.byPerson && next.byPerson === false && people > 0) throw new InvalidStateError(`Line ${current.seq} has its people: take them off before it stops being by person.`)
    if (body.sizes !== undefined || toMtm) {
      await tx.portalOrderRequestSize.deleteMany({ where: { lineId } })
      const asked = toMtm ? [] : (body.sizes ?? [])
      if (asked.length > 0) await tx.portalOrderRequestSize.createMany({ data: asked.map((ask) => ({ id: newId(), partyId: row.partyId, lineId, size: ask.size.trim(), quantity: ask.quantity, createdById: writer.userId, createdAt: now, updatedAt: now })) })
    }
    const data = customLineData(next)
    const own = body.brandUnitPrice !== undefined ? { brandUnitPrice: body.brandUnitPrice } : {} // B-CP-076: absent keeps it, null clears it
    await tx.portalOrderRequestLine.update({ where: { id: lineId }, data: { kind: next.kind /* od-s s.4 */, ...data, ...own, version: { increment: 1 } }, select: { id: true } })
    await writeChoices(tx, lineId, body.choices) // od-s s.4: absent keeps them, null or [] clears them
    tools.audit({
      recordType: 'PortalOrderRequest',
      recordId: row.id,
      companyId: row.companyId,
      before: { lineId, ...customLineData(current), sizes: sizesOf(current), brandUnitPrice: markMoney('price', priceOrNull(current.brandUnitPrice)) /* B-CP-076 */ },
      after: { lineId, ...data, sizes: next.sizes ?? [], brandUnitPrice: markMoney('price', body.brandUnitPrice === undefined ? priceOrNull(current.brandUnitPrice) : body.brandUnitPrice) /* B-CP-076 */ },
    })
    return null
  })
  return requestView(writer, (await ownRequest(writer, requestId))!)
}

/** The draft's by-person line for its people (made to measure open for a made-to-measure line), or a refusal in words. */
async function rosterLine(writer: DraftWriter, row: RequestRow, lineId: string): Promise<LineRow> {
  const line = await writer.scoped((client) => ownLine(client, row, lineId))
  if (!line.byPerson) {
    const words = PEOPLE_WORDS.NOT_BY_PERSON[writer.locale]
    throw new DomainError('invalid_state', words, [{ path: 'refusal/NOT_BY_PERSON', message: words }])
  }
  if (line.kind === 'MADE_TO_MEASURE' && !(await writer.inTenant((db) => madeToMeasureOf(db, row.companyId, row.partyId))).open) throw mtmClosed(writer)
  return line
}

/**
 * The person's shape (400) and its sheet: a measurement sheet of this very draft (another draft's, another customer's: not found).
 * od-s s.2: the office names a sheet only with sales.measurements.view over the customer (body data; else 403 in words).
 */
async function checkPerson(writer: DraftWriter, row: RequestRow, person: PersonInput, at: string): Promise<void> {
  const issues = personShapeProblems(person).map((message) => ({ path: at, message }))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const fileId = personRow(person).measurementFileId
  if (fileId !== null) {
    if (writer.door === 'office' && !can(writer.actor, SALES_MEASUREMENTS_VIEW, { companyId: row.companyId, partyId: row.partyId })) throw new ForbiddenError(OFFICE_DRAFT_WORDS.SHEET_HELD.en)
    const lineIds = (await writer.scoped((client) => readLines(client, [row.id]))).map((line) => line.id)
    if (!(await writer.scoped((client) => isDraftSheet(client, row, lineIds, fileId)))) throw new NotFoundError('File not found.') // W-CP-3
  }
}

export async function addPeople(writer: DraftWriter, requestId: string, lineId: string, body: { readonly version: number; readonly people: readonly PersonInput[] }, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  await rosterLine(writer, row, lineId)
  for (const [index, person] of body.people.entries()) await checkPerson(writer, row, person, `body/people/${index}`)
  await onDraft(writer, 'portalOrdering.addPeople', row, body.version, { requestId, lineId, people: body.people.length }, idempotencyKey, async (tools) => {
    const { tx, now } = tools
    const roster = await tx.portalOrderRequestPerson.findMany({ where: { lineId }, select: { seq: true } })
    if (roster.length + body.people.length > PEOPLE_LIMITS.perLine) {
      const words = PEOPLE_WORDS.TOO_MANY[writer.locale]
      throw new DomainError('conflict', words, [{ path: 'refusal/TOO_MANY', message: words }])
    }
    let seq = roster.reduce((max, person) => Math.max(max, person.seq), 0)
    const ids: string[] = []
    for (const person of body.people) {
      const id = newId()
      seq += 1
      await tx.portalOrderRequestPerson.create({ data: { id, partyId: row.partyId, requestId: row.id, lineId, seq, ...personRow(person), createdById: writer.userId, createdAt: now, updatedAt: now }, select: { id: true } })
      ids.push(id)
    }
    // Who of the party added them and how they are measured; never the names (personal data stays in its own rows).
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { lineId, people: ids, measureBy: body.people.map((person) => person.measureBy) } })
    return null
  })
  return requestView(writer, (await ownRequest(writer, requestId))!)
}

async function ownPerson(db: Reader, lineId: string, personId: string): Promise<PersonRow> {
  const person = isUuid(personId) ? await db.portalOrderRequestPerson.findFirst({ where: { id: personId, lineId }, select: PERSON_COLUMNS }) : null
  if (!person) throw new NotFoundError('Person not found.')
  return person
}

export async function changePerson(
  writer: DraftWriter,
  requestId: string,
  lineId: string,
  personId: string,
  body: { readonly version: number; readonly name?: string | undefined; readonly number?: string | null | undefined; readonly measureBy?: PersonInput['measureBy'] | undefined; readonly size?: string | null | undefined; readonly measurementFileId?: string | null | undefined; readonly note?: string | null | undefined },
  idempotencyKey?: string,
) {
  const row = await ownDraft(writer, requestId)
  await rosterLine(writer, row, lineId)
  const person = await writer.scoped((client) => ownPerson(client, lineId, personId))
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
  await checkPerson(writer, row, next, 'body')
  await onDraft(writer, 'portalOrdering.changePerson', row, body.version, { requestId, lineId, personId, ...body }, idempotencyKey, async (tools) => {
    const current = await ownPerson(tools.tx, lineId, personId)
    await tools.tx.portalOrderRequestPerson.update({ where: { id: personId }, data: { ...personRow(next), version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { lineId, personId, measureBy: current.measureBy }, after: { lineId, personId, measureBy: next.measureBy } })
    return null
  })
  return requestView(writer, (await ownRequest(writer, requestId))!)
}

export async function removePerson(writer: DraftWriter, requestId: string, lineId: string, personId: string, version: number, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  await writer.scoped((client) => ownLine(client, row, lineId))
  await onDraft(writer, 'portalOrdering.removePerson', row, version, { requestId, lineId, personId, version }, idempotencyKey, async (tools) => {
    const person = await ownPerson(tools.tx, lineId, personId)
    await tools.tx.portalOrderRequestPerson.delete({ where: { id: personId }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { lineId, personId, seq: person.seq }, after: { personId: null } })
    return null
  })
  return requestView(writer, (await ownRequest(writer, requestId))!)
}
// ---- end B-CP-075

export type { RequestRow }
export { sizesOf }
