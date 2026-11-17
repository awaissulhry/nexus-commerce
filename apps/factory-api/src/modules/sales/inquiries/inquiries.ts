import type { Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { AskInfoBody, AssignBody, BulkAssignBody, BulkDeclineBody, CreateInquiryBody, DeclineBody, InquiryListQuery, LineBody, LoseBody, ProspectBody, UpdateInquiryBody, VersionBody } from '@nexus/factory-domain/sales/inquiries/contracts'
import { SALES_INQUIRIES_MANAGE, SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import {
  askInfoRefusal,
  assignRefusal,
  declineRefusal,
  declineMessageRefusal, // B-TH-043
  editRefusal,
  INQUIRY_TILES,
  lineProblems,
  loseRefusal,
  OPEN_STATUSES,
  overdue,
  prospectOf,
  prospectProblems,
  quantityOf,
  resumeRefusal,
  statusAfterAssign,
  statusAfterResume,
  statusAfterUnassign,
  storedSizes,
  techPackProblems,
  unassignRefusal,
  type DeclineReason,
  type InquiryStatus,
  type InquiryTile,
  type Prospect,
} from '@nexus/factory-domain/sales/inquiries/rules'
import { relativeRange } from '@nexus/factory-domain/views/quick/relative'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../../platform/auth/roles/access'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { followInCommand } from '../../../platform/threads/followers'
// B-TH-013: the question of "Ask for more information" (a portal reply, or a mail under the recipient rule).
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { EMAIL_SEND } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sendEmail } from '../../../platform/email-out/outbound'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { joinMailInCommand } from './join'
import {
  asDay,
  assertNoProblems,
  badBody,
  databaseRefusal,
  dayOrNull,
  factsOf,
  INQUIRY_COLUMNS,
  InquiryRefusedError,
  may,
  officeInquiry,
  officeOf,
  readInquiryRow,
  refuse,
  scopeOf,
  type InquiryData,
  type Reader,
} from './store'
import { inquiryViewOf, rowsOf, waitingMinutesOf } from './views'

/**
 * Inquiries (B-W2b-295; SAL-032, SAL-033, SAL-305; design sales.inquiries SCR-105: the tiles, the list, New inquiry, the
 * inquiry's Request tab, Assign, Ask for more information, Decline inquiry). Making one from a mail is ./from-mail.ts, the
 * quote ./quote.ts.
 *
 *   GET   /sales/inquiries                       sales.inquiries.view: the inquiries the caller may see (company, customer),
 *                                                with the tiles counted under the filters
 *   GET   /sales/inquiries/:inquiryId            the record: what is asked, the mail, the files and tech pack, the quote, the
 *                                                actions allowed now (else the refusal in words)
 *   POST  /sales/inquiries                       sales.inquiries.manage: a new inquiry (office, phone, fair, portal), numbered
 *                                                INQ-… (its maker follows it; an assignee follows it too)
 *   PATCH /sales/inquiries/:inquiryId            what is asked while open (the lines replaced as a whole), the customer a
 *                                                prospect is matched to (its mail then joins the inquiry's thread); the note
 *                                                in any state
 *   POST  /sales/inquiries/:inquiryId/assign     to someone who keeps inquiries there, or back to nobody (null)
 *   POST  /sales/inquiries/assign                the same for a selection, all or none
 *   POST  /sales/inquiries/:inquiryId/ask-info   NEED_INFO: waits for the customer (the message to them is the thread's)
 *   POST  /sales/inquiries/:inquiryId/resume     the customer answered: ASSIGNED (or NEW with nobody)
 *   POST  /sales/inquiries/:inquiryId/decline    DECLINED with the reason (OTHER in words); B-TH-043: with ONE message to the
 *                                                customer when "Send to the customer" is ticked (never with "Not an order")
 *   POST  /sales/inquiries/decline               the same for a selection, all or none; it never sends anything
 *   POST  /sales/inquiries/:inquiryId/lost       LOST, why in words
 *   GET   /sales/inquiries/assignees             who an inquiry of a company (and customer) may be given to: by name
 *
 * Each write is ONE command that locks the inquiry and checks the version the caller read; the target price (a price) is
 * marked in the audit rows.
 */

const LIST_LIMIT = 100
/** The most open inquiries whose waiting time one list reads (the WAITING_US tile); beyond it the count is partial. */
export const WAITING_READ_MAX = 1000

const authorOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

export async function readInquiry(caller: CommandCaller, inquiryId: string) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId)
  return caller.withClient((db) => inquiryViewOf(db, context, inquiry, serverClock.now()))
}

/** The record after a write, in the command (the answer kept in the receipt). */
export async function viewInCommand(tools: CommandTools, inquiryId: string) {
  const row = (await readInquiryRow(tools.tx, inquiryId))!
  const context = tools.context as OfficeContext
  return inquiryViewOf(tools.tx, context, row, tools.now)
}

// ---- the list ----------------------------------------------------------------------------------------------------------

// B-TH-039: Sales › Incoming's one read (modules/sales/incoming) filters its requests with the same words.
export function baseWhere(context: OfficeContext, query: Omit<InquiryListQuery, 'tile' | 'limit'>): Prisma.InquiryWhereInput {
  const q = query.q?.trim()
  // B-TH-016 (PR-30): a prospect's e-mail is searched only for a reader who keeps inquiries (a reader who only reads them never
  // finds a request by an address it is not shown).
  const keeps = holds(actorOf(context), SALES_INQUIRIES_MANAGE)
  return {
    AND: [
      scopeWhere(actorOf(context), SALES_INQUIRIES_VIEW, { company: 'companyId', party: { field: 'partyId', nullable: true } }) as Prisma.InquiryWhereInput,
      query.status ? { status: query.status } : {},
      query.source ? { source: query.source } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.prospect === true ? { partyId: null } : query.prospect === false ? { partyId: { not: null } } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.receivedFrom ? { receivedAt: { gte: businessDayStart(query.receivedFrom) } } : {},
      query.receivedTo ? { receivedAt: { lt: businessDayStart(plusOne(query.receivedTo)) } } : {},
      q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { request: { contains: q, mode: 'insensitive' } },
              { prospectCompany: { contains: q, mode: 'insensitive' } },
              ...(keeps ? [{ prospectEmail: { contains: q.toLowerCase() } }] : []),
              { party: { code: { contains: q, mode: 'insensitive' } } },
              { party: { legalName: { contains: q, mode: 'insensitive' } } },
              { party: { tradeName: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {},
    ],
  }
}

const plusOne = (day: string): string => new Date(asDay(day).getTime() + 86_400_000).toISOString().slice(0, 10)
const OPEN: Prisma.InquiryWhereInput = { status: { in: [...OPEN_STATUSES] } }

/** A tile's saved filter (SCR-105 "Saved-filter tiles", the Rows ▾ saved rows), today in Europe/Rome. */
function tileWhere(tile: InquiryTile, context: OfficeContext, today: string, waitingUs: readonly string[]): Prisma.InquiryWhereInput {
  switch (tile) {
    case 'NEW':
      return { status: 'NEW' }
    case 'WAITING_US':
      return { id: { in: [...waitingUs] } }
    case 'WAITING_CUSTOMER':
      return { status: 'NEED_INFO' }
    case 'QUOTED_THIS_WEEK': {
      const week = relativeRange('this-week', today)
      return { status: 'QUOTED', closedAt: { gte: businessDayStart(week.from!), lt: businessDayStart(plusOne(week.to!)) } }
    }
    case 'MINE':
      return { AND: [OPEN, { assigneeId: context.actorId }] }
    case 'OPEN':
      return OPEN
    case 'QUOTED':
      return { status: 'QUOTED' }
    case 'DECLINED':
      return { status: 'DECLINED' }
    case 'LOST':
      return { status: 'LOST' }
    case 'ALL':
      return {}
  }
}

/** The tiles whose rows wait (the queue): the oldest first; the others the newest first. */
const QUEUE_TILES: readonly InquiryTile[] = ['NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'MINE', 'OPEN']

/** GET /sales/inquiries */
export async function listInquiries(caller: CommandCaller, query: InquiryListQuery) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const today = businessDate(now)
  const tile = query.tile ?? 'OPEN'
  const limit = query.limit ?? LIST_LIMIT
  const base = baseWhere(context, query)
  return caller.withClient(async (db) => {
    // The waiting time of the open inquiries that wait for us (NEW, ASSIGNED), on their companies' calendars.
    const waitingRows = await db.inquiry.findMany({ where: { AND: [base, { status: { in: ['NEW', 'ASSIGNED'] } }] }, select: { id: true, companyId: true, status: true, receivedAt: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: WAITING_READ_MAX + 1 })
    const complete = waitingRows.length <= WAITING_READ_MAX
    const minutes = await waitingMinutesOf(db, waitingRows.slice(0, WAITING_READ_MAX), now)
    const waitingUs = waitingRows.filter((row) => overdue(row.status as InquiryStatus, minutes.get(row.id) ?? null)).map((row) => row.id)
    const order: Prisma.InquiryOrderByWithRelationInput[] = QUEUE_TILES.includes(tile) ? [{ receivedAt: 'asc' }, { id: 'asc' }] : [{ receivedAt: 'desc' }, { id: 'desc' }]
    const rows = await db.inquiry.findMany({ where: { AND: [base, tileWhere(tile, context, today, waitingUs)] }, select: INQUIRY_COLUMNS, orderBy: order, take: limit })
    const counts: Record<string, number | null> = {}
    for (const each of INQUIRY_TILES) counts[each] = each === 'WAITING_US' ? waitingUs.length : await db.inquiry.count({ where: { AND: [base, tileWhere(each, context, today, waitingUs)] } })
    const pageMinutes = new Map(minutes)
    const missing = rows.filter((row) => !pageMinutes.has(row.id))
    if (missing.length > 0) for (const [id, value] of await waitingMinutesOf(db, missing, now)) pageMinutes.set(id, value)
    return { rows: await rowsOf(db, context, rows, now, pageMinutes), counts, complete }
  })
}

// ---- who may keep it ---------------------------------------------------------------------------------------------------

/** A person as the assign rule sees them: their live office roles (two-factor taken as proved: they prove it to sign in). */
async function personActor(db: Reader, tenantId: string, userId: string, now: Date): Promise<Actor> {
  return { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db, userId, now), true) }
}

/** Whether this person may be given an inquiry of this company (and customer): ACTIVE, an office person who keeps inquiries there. */
export async function mayKeep(db: Reader, tenantId: string, userId: string, scope: { readonly companyId: string; readonly partyId: string | null }, now: Date): Promise<boolean> {
  const user = await db.user.findFirst({ where: { id: userId, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
  if (!user) return false
  return can(await personActor(db, tenantId, userId, now), SALES_INQUIRIES_MANAGE, scopeOf(scope))
}
const ASSIGNEE_REFUSED = 'This person may not be given the inquiry: they are not an active office person who keeps inquiries for this company or customer.'

/** The most people GET /sales/inquiries/assignees reads (by name). */
export const ASSIGNABLE_MAX = 500

/** GET /sales/inquiries/assignees?companyId=&partyId=: the people an inquiry there may be given to, by name; nobody is counted. */
export async function inquiryAssignees(caller: CommandCaller, query: { readonly companyId: string; readonly partyId?: string | undefined }) {
  const context = officeOf(caller)
  const scope = { companyId: query.companyId, partyId: query.partyId ?? null }
  if (!may(context, SALES_INQUIRIES_MANAGE, scope)) throw new ForbiddenError('Your role does not keep inquiries for this company or customer.')
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const users = await db.user.findMany({ where: { status: 'ACTIVE', audience: 'OFFICE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: ASSIGNABLE_MAX, select: { id: true, displayName: true } })
    const people: { id: string; name: string; me: boolean }[] = []
    for (const user of users) if (await mayKeep(db, context.tenantId, user.id, scope, now)) people.push({ id: user.id, name: user.displayName, me: user.id === context.actorId })
    return { people, complete: users.length < ASSIGNABLE_MAX }
  })
}

// ---- what an inquiry names ---------------------------------------------------------------------------------------------

/** The customer an inquiry is from: a CUSTOMER or BRAND party of the company (or tenant-wide), not archived, that the caller may see. */
// B-TH-042: exported for the match of ./make-customer.ts.
export async function assertCustomer(db: Reader, context: OfficeContext, partyId: string, companyId: string, path = 'partyId'): Promise<void> {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { companyId: true, roles: true, status: true } })
  if (!party || (party.companyId !== null && party.companyId !== companyId) || !may(context, SALES_INQUIRIES_VIEW, { companyId, partyId })) badBody(path, 'No such customer or brand for this company.')
  if (!party.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')) badBody(path, 'This party is not a customer or a brand.')
  if (party.status === 'ARCHIVED') badBody(path, 'This customer is archived.')
}

// ---- B-TH-221 (wall W23): a request's delivery address is its own customer's (the portal's own rule, B-TH-010) ----
async function assertShipTo(db: Reader, partyId: string | null, addressId: string, path = 'shipToAddressId'): Promise<void> {
  if (partyId === null) badBody(path, 'A delivery address is named with its customer, never with a prospect.')
  const address = await db.partyAddress.findFirst({ where: { id: addressId, partyId, status: 'ACTIVE', kinds: { has: 'SHIP_TO' } }, select: { id: true } })
  if (!address) badBody(path, 'Not one of this customer’s delivery addresses.')
}
// ---- end B-TH-221

/** The person at the customer who asked: an active contact of that party, not erased. */
// B-TH-042: exported for ./make-customer.ts.
export async function assertContact(db: Reader, partyId: string, contactId: string, path = 'contactId'): Promise<void> {
  const contact = await db.partyContact.findUnique({ where: { id: contactId }, select: { partyId: true, status: true, erasedAt: true } })
  if (!contact || contact.partyId !== partyId || contact.status !== 'ACTIVE' || contact.erasedAt !== null) badBody(path, 'Not an active contact of this customer.')
}

/**
 * The lines as asked, checked: each line's own rules, then its style (of the company or tenant-wide, not archived) and colourway
 * (of that style). B-TH-009 (PR-05): a private-label style only for its own customer, or a rider of its team (the quote rule
 * PRIVATE_LABEL, said to the office in words; the database's …_sales_intake_portal_th_guards hold it too); a prospect's
 * inquiry names none.
 */
export async function checkedLines(db: Reader, companyId: string, lines: readonly LineBody[], path = 'body/lines', partyId: string | null = null): Promise<LineBody[]> {
  assertNoProblems(lines.flatMap((line, index) => lineProblems(line, `${path}/${index}`)), 'These lines cannot be the inquiry.')
  const styleIds = [...new Set(lines.flatMap((line) => (line.styleId ? [line.styleId] : [])))]
  const styles = styleIds.length === 0 ? [] : await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, companyId: true, status: true, brandPartyId: true } })
  const colourwayIds = [...new Set(lines.flatMap((line) => (line.colourwayId ? [line.colourwayId] : [])))]
  const colourways = colourwayIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, styleId: true } })
  const branded = styles.some((style) => style.brandPartyId !== null && style.brandPartyId !== partyId)
  const team = branded && partyId ? ((await db.party.findUnique({ where: { id: partyId }, select: { teamPartyId: true } }))?.teamPartyId ?? null) : null
  const problems: Issue[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.styleId) continue
    const style = styles.find((row) => row.id === line.styleId)
    if (!style || (style.companyId !== null && style.companyId !== companyId)) problems.push({ path: `${path}/${index}/styleId`, message: 'Not a style of this company.' })
    else if (style.status === 'ARCHIVED') problems.push({ path: `${path}/${index}/styleId`, message: `${style.code} is archived.` })
    else if (style.brandPartyId !== null && style.brandPartyId !== partyId && (team === null || team !== style.brandPartyId))
      problems.push({ path: `${path}/${index}/styleId`, message: partyId ? `${style.code} is another customer's private-label style: only its own customer asks for it.` : `${style.code} is a customer's private-label style: match the inquiry to that customer first, or ask in words.` })
    if (line.colourwayId && colourways.find((row) => row.id === line.colourwayId)?.styleId !== line.styleId) problems.push({ path: `${path}/${index}/colourwayId`, message: 'Not a colourway of this style.' })
  }
  assertNoProblems(problems, 'These lines cannot be the inquiry.')
  return [...lines]
}

/** The tech pack names files of the inquiry or of its mail, not deleted (the database's rule, said first). */
export async function assertTechPack(db: Reader, fileIds: readonly string[], inquiryId: string, mailId: string | null, path = 'body/techPackFileIds'): Promise<void> {
  assertNoProblems(techPackProblems(fileIds, path))
  if (fileIds.length === 0) return
  const files = await db.storedFile.findMany({ where: { id: { in: [...fileIds] } }, select: { id: true, recordType: true, recordId: true, status: true } })
  const usable = files.filter((file) => file.status !== 'DELETED' && ((file.recordType === 'Inquiry' && file.recordId === inquiryId) || (mailId !== null && file.recordType === 'InboundEmail' && file.recordId === mailId)))
  if (usable.length !== fileIds.length) badBody(path.replace(/^body\//, ''), 'The tech pack is files of this inquiry or of the mail it came from (not deleted).')
}

/** The prospect as given, checked (a party named instead needs none). */
export function checkedProspect(body: ProspectBody | undefined | null, path = 'body/prospect'): Prospect | null {
  if (body === undefined || body === null) return null
  const prospect = prospectOf(body)
  assertNoProblems(prospectProblems(prospect, path))
  return prospect
}

/** The prospect columns of a row. */
export const prospectColumns = (prospect: Prospect | null) =>
  prospect === null
    ? { prospectName: null, prospectCompany: null, prospectEmail: null, prospectPhone: null, prospectLawfulBasis: null }
    : { prospectName: prospect.name, prospectCompany: prospect.company, prospectEmail: prospect.email, prospectPhone: prospect.phone, prospectLawfulBasis: prospect.lawfulBasis }

/** The lines of an inquiry written as a whole: the old ones removed, the new ones placed 10, 20, 30 … */
export async function writeLines(tools: CommandTools, inquiryId: string, lines: readonly LineBody[], replace: boolean): Promise<void> {
  const { tx, now } = tools
  if (replace) await tx.inquiryLine.deleteMany({ where: { inquiryId } })
  if (lines.length === 0) return
  const createdById = authorOf(tools)
  await tx.inquiryLine.createMany({
    data: lines.map((line, index) => ({
      id: newId(),
      inquiryId,
      seq: (index + 1) * 10,
      styleId: line.styleId ?? null,
      colourwayId: line.colourwayId ?? null,
      colourText: blankToNull(line.colourText),
      description: blankToNull(line.description),
      sizes: storedSizes(line.sizes),
      quantity: quantityOf(line),
      note: blankToNull(line.note),
      createdAt: now,
      updatedAt: now,
      createdById,
    })),
  })
}

const linesAudit = (lines: readonly LineBody[]) => lines.map((line, index) => ({ seq: (index + 1) * 10, styleId: line.styleId ?? null, colourwayId: line.colourwayId ?? null, description: line.description ?? null, sizes: storedSizes(line.sizes), quantity: quantityOf(line) }))

// ---- create ------------------------------------------------------------------------------------------------------------

/** What every new inquiry is made of (typed or from a mail): checked before the command. */
export interface NewInquiry {
  readonly companyId: string
  readonly source: 'OFFICE' | 'PHONE' | 'FAIR' | 'PORTAL' | 'MAIL'
  readonly sourceEmailId: string | null
  readonly receivedAt: Date
  readonly partyId: string | null
  readonly contactId: string | null
  readonly prospect: Prospect | null
  readonly request: string
  readonly wantedDate: string | null
  readonly targetUnitPrice: string | null
  readonly currency: string | null
  readonly techPackFileIds: readonly string[]
  readonly techPackVersion: string | null
  readonly note: string | null
  readonly lines: readonly LineBody[]
  readonly assigneeId: string | null
  /** B-TH-010 (L2-G01): the customer's own reference and the delivery address it asked (one of its SHIP_TO addresses). */
  readonly customerRef?: string | null
  readonly shipToAddressId?: string | null
  /**
   * B-TH-010: sent by the customer from the portal (the command runs in the office scope as the portal person): nobody of the
   * office typed it (no creator, no creator follower); the audit row's actor is the person.
   */
  readonly fromPortal?: boolean
}

/** The checks of a new inquiry that read the database (who asks, the lines, the assignee). */
export async function checkNew(caller: CommandCaller, context: OfficeContext, made: NewInquiry): Promise<void> {
  if (made.partyId === null && made.prospect === null) badBody('partyId', 'Say who asks: the customer, or a prospect (a name, company or e-mail).')
  if (made.contactId !== null && made.partyId === null) badBody('contactId', 'A contact is named with its customer.')
  await caller.withClient(async (db) => {
    if (!(await db.company.findUnique({ where: { id: made.companyId }, select: { id: true } }))) badBody('companyId', 'No such company.')
    if (made.partyId) await assertCustomer(db, context, made.partyId, made.companyId)
    if (made.partyId && made.contactId) await assertContact(db, made.partyId, made.contactId)
    // B-TH-221 (W23): the delivery address an office request names is one of ITS customer's own active delivery addresses.
    if (made.shipToAddressId) await assertShipTo(db, made.partyId, made.shipToAddressId)
    await checkedLines(db, made.companyId, made.lines, 'body/lines', made.partyId)
    if (made.assigneeId && !(await mayKeep(db, context.tenantId, made.assigneeId, { companyId: made.companyId, partyId: made.partyId }, serverClock.now()))) badBody('assigneeId', ASSIGNEE_REFUSED)
  })
  if (!may(context, SALES_INQUIRIES_MANAGE, { companyId: made.companyId, partyId: made.partyId })) throw new ForbiddenError('Your role does not keep inquiries for this company or customer.')
}

/** Inside a command: the inquiry numbered INQ-…, its lines, its followers, its event. Returns its id. */
export async function insertInquiry(tools: CommandTools, made: NewInquiry, id: string = newId()): Promise<{ id: string; number: string }> {
  const { tx, now } = tools
  const { formatted: number } = await allocateNumber(tools, { companyId: made.companyId, kind: 'INQUIRY' }, { type: 'Inquiry', id })
  const company = made.currency ? null : await tx.company.findUniqueOrThrow({ where: { id: made.companyId }, select: { currency: true } })
  const createdById = made.fromPortal ? null : authorOf(tools)
  const status: InquiryStatus = made.assigneeId ? 'ASSIGNED' : 'NEW'
  const data = {
    id,
    companyId: made.companyId,
    number,
    source: made.source,
    sourceEmailId: made.sourceEmailId,
    receivedAt: made.receivedAt,
    partyId: made.partyId,
    contactId: made.contactId,
    ...prospectColumns(made.prospect),
    request: made.request,
    wantedDate: made.wantedDate ? asDay(made.wantedDate) : null,
    customerRef: made.customerRef ?? null,
    shipToAddressId: made.shipToAddressId ?? null,
    targetUnitPrice: made.targetUnitPrice,
    currency: made.currency ?? company!.currency,
    techPackFileIds: [...made.techPackFileIds],
    techPackVersion: made.techPackVersion,
    status,
    assigneeId: made.assigneeId,
    assignedAt: made.assigneeId ? now : null,
    note: made.note,
    createdAt: now,
    updatedAt: now,
    createdById,
  }
  await tx.inquiry.create({ data, select: { id: true } })
  await writeLines(tools, id, made.lines, false)
  tools.audit({
    action: made.fromPortal ? 'sales.inquiries.fromPortal' : made.source === 'MAIL' ? 'sales.inquiries.fromMail' : 'sales.inquiries.create',
    recordType: 'Inquiry',
    recordId: id,
    companyId: made.companyId,
    after: { ...data, receivedAt: toUtcIso(made.receivedAt), wantedDate: made.wantedDate, targetUnitPrice: markMoney('price', made.targetUnitPrice), assignedAt: data.assignedAt ? toUtcIso(now) : null, createdAt: toUtcIso(now), updatedAt: undefined, lines: linesAudit(made.lines) },
  })
  const record = { type: 'Inquiry', id, companyId: made.companyId, siteId: null }
  if (createdById) await followInCommand(tools, record, createdById, 'CREATOR', createdById)
  if (made.assigneeId) await followInCommand(tools, record, made.assigneeId, 'ASSIGNEE', createdById)
  tools.emit({ type: 'inquiry.received', subject: id, companyId: made.companyId, payload: { inquiryId: id, number, source: made.source, status, partyId: made.partyId, sourceEmailId: made.sourceEmailId } })
  return { id, number }
}

/** POST /sales/inquiries: "New inquiry (phone or visit)". */
export async function createInquiry(caller: CommandCaller, body: CreateInquiryBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const receivedAt = body.receivedAt ? new Date(body.receivedAt) : now
  if (receivedAt.getTime() > now.getTime()) badBody('receivedAt', 'When it came: not in the future.')
  const made: NewInquiry = {
    companyId: body.companyId,
    source: body.source,
    sourceEmailId: null,
    receivedAt,
    partyId: body.partyId ?? null,
    contactId: body.contactId ?? null,
    prospect: checkedProspect(body.prospect),
    request: body.request,
    wantedDate: body.wantedDate ?? null,
    targetUnitPrice: (body.targetUnitPrice as string | undefined) ?? null,
    currency: body.currency ?? null,
    techPackFileIds: [],
    techPackVersion: body.techPackVersion ?? null,
    note: body.note ?? null,
    lines: body.lines ?? [],
    assigneeId: body.assigneeId ?? null,
    // B-TH-221: the customer's PO and delivery address, as the portal's New order sends them.
    customerRef: body.customerRef ?? null,
    shipToAddressId: body.shipToAddressId ?? null,
  }
  await checkNew(caller, context, made)
  const { result } = await command(caller, { name: 'sales.inquiries.create', idempotencyKey, input: { ...body, targetUnitPrice: markMoney('price', made.targetUnitPrice) } }, async (tools) => {
    const { id } = await insertInquiry(tools, made)
    return { inquiry: await viewInCommand(tools, id) }
  }).catch(databaseRefusal)
  return result
}

// ---- one inquiry in a command ------------------------------------------------------------------------------------------

/** The inquiry locked for a change at the version the caller read; seen (view) and kept (manage) by the caller, else refused. */
export async function lockForChange(tools: CommandTools, context: OfficeContext, inquiryId: string, version: number): Promise<InquiryData> {
  if (!isUuid(inquiryId)) throw new NotFoundError('Inquiry not found.')
  await tools.tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${inquiryId}::uuid FOR UPDATE`
  const row = await readInquiryRow(tools.tx, inquiryId)
  if (!row || !may(context, SALES_INQUIRIES_VIEW, row)) throw new NotFoundError('Inquiry not found.')
  if (!may(context, SALES_INQUIRIES_MANAGE, row)) throw new ForbiddenError('Your role does not keep inquiries for this company or customer.')
  if (row.version !== version) throw new StaleVersionError('Inquiry', inquiryId, row.version, version)
  return row
}

/** The update of one inquiry: its changed columns and a version bump, compare-and-set on the version read. */
export async function writeInquiry(tools: CommandTools, row: InquiryData, data: Prisma.InquiryUncheckedUpdateManyInput): Promise<void> {
  const { count } = await tools.tx.inquiry.updateMany({ where: { id: row.id, version: row.version }, data: { ...data, version: row.version + 1, updatedAt: tools.now } })
  if (count === 0) throw new StaleVersionError('Inquiry', row.id, row.version + 1, row.version)
}

type Change = 'UPDATED' | 'MATCHED' | 'ASSIGNED' | 'UNASSIGNED' | 'NEED_INFO' | 'RESUMED'
// B-TH-042: exported for ./make-customer.ts (MATCHED).
export function emitChanged(tools: CommandTools, row: InquiryData, status: InquiryStatus, change: Change, partyId: string | null, assigneeId: string | null): void {
  tools.emit({ type: 'inquiry.changed', subject: row.id, companyId: row.companyId, payload: { inquiryId: row.id, number: row.number, status, previousStatus: row.status, change, partyId, assigneeId } })
}

// ---- change ------------------------------------------------------------------------------------------------------------

const OPEN_FIELDS = ['request', 'wantedDate', 'targetUnitPrice', 'currency', 'techPackFileIds', 'techPackVersion', 'partyId', 'contactId', 'prospect', 'lines'] as const

/** PATCH /sales/inquiries/:inquiryId: the Request tab's Apply. */
export async function updateInquiry(caller: CommandCaller, inquiryId: string, body: UpdateInquiryBody, idempotencyKey?: string) {
  const { context, inquiry: seen } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  const { version, ...changes } = body
  const fields = (Object.keys(changes) as (keyof typeof changes)[]).filter((key) => changes[key] !== undefined)
  if (fields.length === 0) badBody('version', 'Say what changes.')
  const changing = fields.filter((field) => (OPEN_FIELDS as readonly string[]).includes(field))
  if (changing.length > 0) refuse(editRefusal(factsOf(seen)))
  if (changes.partyId !== undefined && seen.partyId !== null && changes.partyId !== seen.partyId) badBody('partyId', `${seen.number} is from its customer for good; a request of another customer is a new inquiry.`)
  // B-TH-010 (L2-G02): a request the customer sent from the portal keeps its words as sent (its thread's first message too);
  // the office adds a note or a message instead.
  if (changes.request !== undefined && seen.source === 'PORTAL' && changes.request !== seen.request) badBody('request', `${seen.number} keeps the customer's words as they sent them; add a note or a message instead.`)
  const partyId = changes.partyId ?? seen.partyId
  const prospect = changes.prospect === undefined ? undefined : checkedProspect(changes.prospect)
  if (changes.prospect === null && partyId === null) badBody('prospect', 'A prospect is cleared only once the inquiry names its customer.')
  const contactId = changes.contactId === undefined ? (changes.partyId !== undefined && changes.partyId !== seen.partyId ? null : seen.contactId) : changes.contactId
  const price = changes.targetUnitPrice as string | null | undefined
  await caller.withClient(async (db) => {
    if (changes.partyId !== undefined && changes.partyId !== seen.partyId) await assertCustomer(db, context, changes.partyId, seen.companyId)
    if (contactId && partyId && (changes.contactId !== undefined || changes.partyId !== undefined)) await assertContact(db, partyId, contactId)
    if (changes.lines) await checkedLines(db, seen.companyId, changes.lines, 'body/lines', partyId)
    if (changes.techPackFileIds) await assertTechPack(db, changes.techPackFileIds, seen.id, seen.sourceEmailId)
  })
  const matched = changes.partyId !== undefined && seen.partyId === null
  if (matched && !may(context, SALES_INQUIRIES_MANAGE, { companyId: seen.companyId, partyId: changes.partyId! })) badBody('partyId', 'Your role does not keep inquiries for this customer.')
  const { result } = await command(caller, { name: 'sales.inquiries.update', idempotencyKey, input: { inquiryId, ...body, ...(price !== undefined ? { targetUnitPrice: markMoney('price', price) } : {}) } }, async (tools) => {
    const row = await lockForChange(tools, context, inquiryId, version)
    if (changing.length > 0) refuse(editRefusal(factsOf(row)))
    const data: Prisma.InquiryUncheckedUpdateManyInput = {
      ...(changes.request !== undefined ? { request: changes.request } : {}),
      ...(changes.wantedDate !== undefined ? { wantedDate: changes.wantedDate === null ? null : asDay(changes.wantedDate) } : {}),
      ...(price !== undefined ? { targetUnitPrice: price } : {}),
      ...(changes.currency !== undefined ? { currency: changes.currency } : {}),
      ...(changes.note !== undefined ? { note: changes.note } : {}),
      ...(changes.techPackFileIds !== undefined ? { techPackFileIds: changes.techPackFileIds } : {}),
      ...(changes.techPackVersion !== undefined ? { techPackVersion: changes.techPackVersion } : {}),
      ...(changes.partyId !== undefined ? { partyId: changes.partyId } : {}),
      ...(changes.contactId !== undefined || matched ? { contactId } : {}),
      ...(prospect !== undefined ? prospectColumns(prospect) : {}),
    }
    await writeInquiry(tools, row, data)
    if (changes.lines) await writeLines(tools, row.id, changes.lines, true)
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const key of Object.keys(data) as (keyof InquiryData)[]) {
      if (key === 'wantedDate') {
        before[key] = dayOrNull(row.wantedDate)
        after[key] = changes.wantedDate ?? null
      } else if (key === 'targetUnitPrice') {
        before[key] = markMoney('price', row.targetUnitPrice === null ? null : row.targetUnitPrice.toString())
        after[key] = markMoney('price', price ?? null)
      } else {
        before[key] = row[key]
        after[key] = (data as Record<string, unknown>)[key]
      }
    }
    if (changes.lines) after.lines = linesAudit(changes.lines)
    tools.audit({ action: 'sales.inquiries.update', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before, after })
    // A prospect's mail that still waits in Mail to sort joins the inquiry's thread once the customer is known.
    if (matched) await joinMailInCommand(tools, context, { ...row, partyId: changes.partyId!, contactId })
    emitChanged(tools, row, row.status as InquiryStatus, matched ? 'MATCHED' : 'UPDATED', partyId, row.assigneeId)
    return { inquiry: await viewInCommand(tools, row.id) }
  }).catch(databaseRefusal)
  return result
}

// ---- assign ------------------------------------------------------------------------------------------------------------

async function assignInCommand(tools: CommandTools, context: OfficeContext, row: InquiryData, assigneeId: string | null): Promise<InquiryStatus> {
  if (assigneeId === null) {
    refuse(unassignRefusal(factsOf(row)))
    const status = statusAfterUnassign(row.status as InquiryStatus)
    await writeInquiry(tools, row, { assigneeId: null, assignedAt: null, status })
    tools.audit({ action: 'sales.inquiries.unassign', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status, assigneeId: row.assigneeId }, after: { status, assigneeId: null } })
    emitChanged(tools, row, status, 'UNASSIGNED', row.partyId, null)
    return status
  }
  refuse(assignRefusal(factsOf(row), assigneeId))
  if (!(await mayKeep(tools.tx, context.tenantId, assigneeId, row, tools.now))) throw new ValidationError(ASSIGNEE_REFUSED, [{ path: 'body/assigneeId', message: ASSIGNEE_REFUSED }])
  const status = statusAfterAssign(row.status as InquiryStatus)
  await writeInquiry(tools, row, { assigneeId, assignedAt: tools.now, status })
  tools.audit({ action: 'sales.inquiries.assign', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status, assigneeId: row.assigneeId }, after: { status, assigneeId, assignedAt: toUtcIso(tools.now) } })
  await followInCommand(tools, { type: 'Inquiry', id: row.id, companyId: row.companyId, siteId: null }, assigneeId, 'ASSIGNEE', authorOf(tools))
  emitChanged(tools, row, status, 'ASSIGNED', row.partyId, assigneeId)
  return status
}

/** POST /sales/inquiries/:inquiryId/assign */
export async function assignInquiry(caller: CommandCaller, inquiryId: string, body: AssignBody, idempotencyKey?: string) {
  const { context } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  const { result } = await command(caller, { name: 'sales.inquiries.assign', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    const row = await lockForChange(tools, context, inquiryId, body.version)
    await assignInCommand(tools, context, row, body.assigneeId)
    return { inquiry: await viewInCommand(tools, row.id) }
  }).catch(databaseRefusal)
  return result
}

/** Each item of a selection in ONE command: any refusal refuses all (409 with `body/items/<i>`). */
async function eachOf(caller: CommandCaller, name: 'sales.inquiries.assignMany' | 'sales.inquiries.declineMany', items: readonly { inquiryId: string; version: number }[], input: unknown, idempotencyKey: string | undefined, work: (tools: CommandTools, context: OfficeContext, row: InquiryData) => Promise<InquiryStatus>) {
  const context = officeOf(caller)
  if (new Set(items.map((item) => item.inquiryId)).size !== items.length) throw new ValidationError('An inquiry is listed twice.', [{ path: 'body/items', message: 'An inquiry is listed twice.' }])
  const { result } = await command(caller, { name, idempotencyKey, input }, async (tools) => {
    const issues: Issue[] = []
    const done: { id: string; number: string; status: InquiryStatus; version: number }[] = []
    for (const [index, item] of items.entries()) {
      try {
        const row = await lockForChange(tools, context, item.inquiryId, item.version)
        const status = await work(tools, context, row)
        done.push({ id: row.id, number: row.number, status, version: row.version + 1 })
      } catch (error) {
        if (error instanceof DomainError) issues.push({ path: `body/items/${index}`, message: error.message })
        else throw error
      }
    }
    if (issues.length > 0) throw new DomainError('conflict', `${issues.length} of ${items.length} inquiries cannot take this change; nothing was changed.`, issues)
    return { inquiries: done }
  }).catch(databaseRefusal)
  return result
}

/** POST /sales/inquiries/assign: "Assign to…" on a selection. */
export async function assignInquiries(caller: CommandCaller, body: BulkAssignBody, idempotencyKey?: string) {
  return eachOf(caller, 'sales.inquiries.assignMany', body.items, body, idempotencyKey, (tools, context, row) => assignInCommand(tools, context, row, body.assigneeId))
}

// ---- waiting for the customer ------------------------------------------------------------------------------------------

// ---- B-TH-013: the question goes with "Ask for more information" ---------------------------------------------------------
const ASK_NEEDS_CUSTOMER = 'Make the customer first: a question goes to a customer of this request (a prospect has no portal and no contact yet).'
const ASK_NO_ADDRESS = 'Say whom to write to: this request names no contact with an e-mail address.'

/**
 * POST /sales/inquiries/:inquiryId/ask-info: "Ask for more information". NEED_INFO, and — B-TH-013 — the question in the same
 * command: on a request the customer sent from the portal, an OUTBOUND PORTAL message of its thread by the office person (the
 * customer reads it in its portal; its "We need something from you" news is B-TH-011's); on any other, a mail on the request's
 * thread (platform/email-out sendEmail: the one recipient rule, B-TH-004) to `to`, else the request's contact. A prospect's
 * request takes no question until it is made a customer (said in words). The customer's answer takes it up again by itself
 * (./resume-on-reply.ts).
 */
export async function askInfo(caller: CommandCaller, inquiryId: string, body: AskInfoBody, idempotencyKey?: string) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  refuse(askInfoRefusal(factsOf(inquiry)))
  const message = body.message
  if (message && inquiry.partyId === null) throw new ValidationError(ASK_NEEDS_CUSTOMER, [{ path: 'body/message', message: ASK_NEEDS_CUSTOMER }])
  if (message) await checkMessage(caller, context, inquiry, message) // B-TH-043: the one message helper
  const { result } = await command(caller, { name: 'sales.inquiries.askInfo', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    const row = await lockForChange(tools, context, inquiryId, body.version)
    refuse(askInfoRefusal(factsOf(row)))
    const asked = message ? await messageInCommand(tools, context, row, message, 'ask') : null
    await writeInquiry(tools, row, { status: 'NEED_INFO' })
    tools.audit({ action: 'sales.inquiries.askInfo', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'NEED_INFO', ...(asked ? { asked: asked.via, messageId: asked.messageId } : {}) } })
    emitChanged(tools, row, 'NEED_INFO', 'NEED_INFO', row.partyId, row.assigneeId)
    return { inquiry: await viewInCommand(tools, row.id) }
  }).catch(databaseRefusal)
  return result
}
// ---- end B-TH-013

// ---- B-TH-043: ONE message to the request's customer — Ask for info's question (B-TH-013) and Decline's message ------------

/** The message as both bodies carry it (askInfoBody.message, declineBody.message). */
interface CustomerMessage {
  readonly body: string
  readonly subject?: string | undefined
  readonly to?: readonly string[] | undefined
  readonly sendOutside?: boolean | undefined
}

/** Before the command: a mail goes only from who may send mail there (email.send, as the thread's own send), to an address. */
async function checkMessage(caller: CommandCaller, context: OfficeContext, inquiry: InquiryData, message: CustomerMessage): Promise<void> {
  if (inquiry.source === 'PORTAL') return
  if (!can(actorOf(context), EMAIL_SEND, scopeOf(inquiry))) throw new ForbiddenError('Your role does not send mail for this company or customer.')
  if (message.to) return
  const contact = inquiry.contactId ? await caller.withClient((db) => db.partyContact.findUnique({ where: { id: inquiry.contactId! }, select: { email: true } })) : null
  if (!contact?.email) throw new ValidationError(ASK_NO_ADDRESS, [{ path: 'body/message/to', message: ASK_NO_ADDRESS }])
}

/**
 * In the command: on a request the customer sent from the portal an OUTBOUND PORTAL message of its thread by the office person
 * (the customer reads it in its portal, no mail); on any other a mail on the request's thread (email-out sendEmail: the one
 * recipient rule, B-TH-004) to `to`, else the request's contact.
 */
async function messageInCommand(tools: CommandTools, context: OfficeContext, row: InquiryData, message: CustomerMessage, purpose: 'ask' | 'decline'): Promise<{ via: 'PORTAL' | 'MAIL'; messageId: string }> {
  const user = await tools.tx.user.findUniqueOrThrow({ where: { id: context.actorId }, select: { displayName: true, email: true } })
  const record = { type: 'Inquiry', id: row.id }
  if (row.source === 'PORTAL') {
    const { thread } = await ensureThread(tools, record, context.actorId)
    if (thread.status !== 'OPEN') throw new InquiryRefusedError({ code: 'CLOSED', message: `The request's conversation is closed; reopen it to ${purpose === 'ask' ? 'ask' : 'write to the customer'}.` })
    const written = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'PORTAL', author: { kind: 'USER', id: context.actorId, name: user.displayName }, bodyText: cleanBody(message.body) })
    return { via: 'PORTAL', messageId: written.id }
  }
  const contact = row.contactId ? await tools.tx.partyContact.findUnique({ where: { id: row.contactId }, select: { email: true } }) : null
  const to = message.to ? [...message.to] : contact?.email ? [contact.email] : []
  const sent = await sendEmail(tools, { record, sender: { userId: context.actorId, name: user.displayName, email: user.email }, to, subject: message.subject ?? null, body: message.body, sendOutside: message.sendOutside })
  return { via: 'MAIL', messageId: sent.messageId }
}
// ---- end B-TH-043

/** POST /sales/inquiries/:inquiryId/resume: the customer answered. */
export async function resumeInquiry(caller: CommandCaller, inquiryId: string, body: VersionBody, idempotencyKey?: string) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  refuse(resumeRefusal(factsOf(inquiry)))
  const { result } = await command(caller, { name: 'sales.inquiries.resume', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    const row = await lockForChange(tools, context, inquiryId, body.version)
    refuse(resumeRefusal(factsOf(row)))
    const status = statusAfterResume(row.assigneeId)
    await writeInquiry(tools, row, { status })
    tools.audit({ action: 'sales.inquiries.resume', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status } })
    emitChanged(tools, row, status, 'RESUMED', row.partyId, row.assigneeId)
    return { inquiry: await viewInCommand(tools, row.id) }
  }).catch(databaseRefusal)
  return result
}

// ---- closing -----------------------------------------------------------------------------------------------------------

// B-TH-025: ORDERED names the order made from it (salesOrderId); every other end names none.
export function emitClosed(tools: CommandTools, row: InquiryData, status: 'QUOTED' | 'DECLINED' | 'LOST' | 'ORDERED', quoteId: string | null, declineReason: DeclineReason | null, salesOrderId: string | null = null): void {
  tools.emit({ type: 'inquiry.closed', subject: row.id, companyId: row.companyId, payload: { inquiryId: row.id, number: row.number, status, previousStatus: row.status, quoteId, salesOrderId, declineReason, partyId: row.partyId } })
}

// B-TH-043: `sent` = the one message that went with it (a single decline with "Send to the customer" ticked), in the audit row.
async function declineInCommand(tools: CommandTools, context: OfficeContext, row: InquiryData, reason: DeclineReason, note: string | null, sent: { via: 'PORTAL' | 'MAIL'; messageId: string } | null = null): Promise<InquiryStatus> {
  refuse(declineRefusal(factsOf(row), reason, note))
  const closeNote = note === null ? null : note.trim()
  await writeInquiry(tools, row, { status: 'DECLINED', declineReason: reason, closeNote, closedAt: tools.now, closedById: context.actorId })
  tools.audit({ action: 'sales.inquiries.decline', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'DECLINED', declineReason: reason, closedAt: toUtcIso(tools.now), ...(sent ? { sent: sent.via, messageId: sent.messageId } : {}) }, ...(closeNote ? { reason: closeNote } : {}) })
  emitClosed(tools, row, 'DECLINED', null, reason)
  return 'DECLINED'
}

/**
 * POST /sales/inquiries/:inquiryId/decline: "Decline inquiry". B-TH-043: with `message` ("Send to the customer" ticked) its ONE
 * message goes in the same command (both or neither): a portal reply, or a mail under the recipient rule; "Not an order" and a
 * prospect's request take none (said in words). Without it nothing goes to the customer.
 */
export async function declineInquiry(caller: CommandCaller, inquiryId: string, body: DeclineBody, idempotencyKey?: string) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  refuse(declineRefusal(factsOf(inquiry), body.reason, body.note ?? null))
  const message = body.message
  if (message) {
    refuse(declineMessageRefusal(factsOf(inquiry), body.reason))
    await checkMessage(caller, context, inquiry, message)
  }
  const { result } = await command(caller, { name: 'sales.inquiries.decline', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    const row = await lockForChange(tools, context, inquiryId, body.version)
    refuse(declineRefusal(factsOf(row), body.reason, body.note ?? null))
    if (message) refuse(declineMessageRefusal(factsOf(row), body.reason))
    const sent = message ? await messageInCommand(tools, context, row, message, 'decline') : null
    await declineInCommand(tools, context, row, body.reason, body.note ?? null, sent)
    return { inquiry: await viewInCommand(tools, row.id) }
  }).catch(databaseRefusal)
  return result
}

/** POST /sales/inquiries/decline: "Decline N" on a selection (B-TH-043: never sends anything; its body has no message). */
export async function declineInquiries(caller: CommandCaller, body: BulkDeclineBody, idempotencyKey?: string) {
  if (body.reason === 'OTHER' && !body.note) throw new InquiryRefusedError({ code: 'OTHER_NEEDS_WORDS', message: 'Say in words why they are declined (the reason is Other).' })
  return eachOf(caller, 'sales.inquiries.declineMany', body.items, body, idempotencyKey, (tools, context, row) => declineInCommand(tools, context, row, body.reason, body.note ?? null))
}

/** POST /sales/inquiries/:inquiryId/lost: the customer went away before a quote. */
export async function loseInquiry(caller: CommandCaller, inquiryId: string, body: LoseBody, idempotencyKey?: string) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  refuse(loseRefusal(factsOf(inquiry)))
  const { result } = await command(caller, { name: 'sales.inquiries.lose', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    const row = await lockForChange(tools, context, inquiryId, body.version)
    refuse(loseRefusal(factsOf(row)))
    await writeInquiry(tools, row, { status: 'LOST', closeNote: body.note, closedAt: tools.now, closedById: context.actorId })
    tools.audit({ action: 'sales.inquiries.lose', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'LOST', closedAt: toUtcIso(tools.now) }, reason: body.note })
    emitClosed(tools, row, 'LOST', null, null)
    return { inquiry: await viewInCommand(tools, row.id) }
  }).catch(databaseRefusal)
  return result
}

