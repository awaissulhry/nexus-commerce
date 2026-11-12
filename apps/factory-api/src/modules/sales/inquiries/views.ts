import type { Prisma } from '@nexus/factory-db'
import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { workingMinutesBetween } from '@nexus/factory-domain/calendars/working-time'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { SALES_INQUIRIES_MANAGE } from '@nexus/factory-domain/sales/inquiries/permissions'
import {
  askInfoRefusal,
  currentOf,
  declineRefusal,
  editRefusal,
  loseRefusal,
  overdue,
  piecesOfSizes,
  quoteRefusal,
  resumeRefusal,
  seriesOf,
  sizesOf,
  sizesShort,
  summaryOf,
  unassignRefusal,
  waitingFor,
  type DeclineReason,
  type InquiryRefusal,
  type InquirySource,
  type InquiryStatus,
  type LawfulBasis,
} from '@nexus/factory-domain/sales/inquiries/rules'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { actorOf, type OfficeContext } from '../../../core/context'
import { dayOrNull, factsOf, LINE_COLUMNS, may, type InquiryData, type LineData, type Reader } from './store'

/**
 * How inquiry rows become the contracts' views (B-W2b-295): the list's rows (their customer or prospect, what is asked in
 * short, the waiting time in working minutes on the company's calendar), and the record (its lines, the mail it came from, its
 * files and the brand's tech pack in force, the quote it became, the actions allowed now). Names of people only in the record.
 */

const byId = <Row extends { id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))
const ids = (values: readonly (string | null)[]): string[] => [...new Set(values.filter((value): value is string => value !== null))]
const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const partyName = (party: { readonly legalName: string; readonly tradeName: string | null }): string => party.tradeName ?? party.legalName
export const price = (value: Prisma.Decimal | null): string | null => (value === null ? null : priceText(value.toString()))

/** The longest a waiting time reaches back (a year): an older open inquiry is counted from a year ago. */
const WAITING_REACH_DAYS = 366

/** Working minutes since each open inquiry came, on its company's calendar (null once closed). */
export async function waitingMinutesOf(db: Reader, rows: readonly Pick<InquiryData, 'id' | 'companyId' | 'status' | 'receivedAt'>[], now: Date): Promise<Map<string, number>> {
  const open = rows.filter((row) => waitingFor(row.status as InquiryStatus) !== null)
  const minutes = new Map<string, number>()
  if (open.length === 0) return minutes
  const today = businessDate(now)
  const oldest = open.map((row) => businessDate(row.receivedAt)).reduce((a, b) => (a < b ? a : b))
  const from = daysFrom(oldest, today) > WAITING_REACH_DAYS ? plusDays(today, -WAITING_REACH_DAYS) : plusDays(oldest, -2)
  const calendars = await workingCalendarsFor(db as Prisma.TransactionClient, ids(open.map((row) => row.companyId)).map((id) => ({ scope: 'COMPANY' as const, id })), { from, to: plusDays(today, 1) })
  const reach = new Date(`${plusDays(from, 1)}T00:00:00.000Z`)
  for (const row of open) {
    const calendar = calendars.get(ownerKey({ scope: 'COMPANY', id: row.companyId }))?.calendar
    if (!calendar) continue
    const start = row.receivedAt < reach ? reach : row.receivedAt
    minutes.set(row.id, Math.round(workingMinutesBetween(calendar, start, now)))
  }
  return minutes
}

export interface RowView {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly source: InquirySource
  readonly status: InquiryStatus
  readonly receivedAt: string
  readonly party: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly fromWords: string
  readonly prospect: boolean
  readonly summary: string
  readonly products: string[]
  readonly pieces: number
  readonly sizes: string
  readonly targetUnitPrice: ReturnType<typeof asMoney<'price', string | null>>
  readonly currency: string
  readonly wantedDate: string | null
  readonly waiting: { readonly for: 'US' | 'CUSTOMER' | null; readonly workingMinutes: number | null; readonly overdue: boolean }
  readonly assigneeId: string | null
  readonly mine: boolean
  readonly quote: { readonly id: string; readonly number: string } | null
  readonly declineReason: DeclineReason | null
  readonly closedAt: string | null
  readonly version: number
}

/** Who asks, in words (the list's From): the customer, else the prospect (company, name, e-mail), else the mail's sender. */
function fromWordsOf(row: InquiryData, party: { readonly legalName: string; readonly tradeName: string | null } | undefined, sender: string | null): string {
  if (party) return partyName(party)
  if (row.prospectErasedAt) return 'Erased prospect'
  return row.prospectCompany ?? row.prospectName ?? row.prospectEmail ?? sender ?? '—'
}

/** The list's rows, their references read in one pass. */
export async function rowsOf(db: Reader, context: OfficeContext, rows: readonly InquiryData[], now: Date, waiting?: Map<string, number>): Promise<RowView[]> {
  if (rows.length === 0) return []
  const inquiryIds = rows.map((row) => row.id)
  const [parties, lines, quotes, mails, minutes] = await Promise.all([
    db.party.findMany({ where: { id: { in: ids(rows.map((row) => row.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } }),
    db.inquiryLine.findMany({ where: { inquiryId: { in: inquiryIds } }, select: LINE_COLUMNS, orderBy: [{ inquiryId: 'asc' }, { seq: 'asc' }] }),
    db.quote.findMany({ where: { id: { in: ids(rows.map((row) => row.quoteId)) } }, select: { id: true, number: true } }),
    db.inboundEmail.findMany({ where: { id: { in: ids(rows.map((row) => row.sourceEmailId)) } }, select: { id: true, fromAddress: true } }),
    waiting ? Promise.resolve(waiting) : waitingMinutesOf(db, rows, now),
  ])
  const styles = await db.style.findMany({ where: { id: { in: ids(lines.map((line) => line.styleId)) } }, select: { id: true, code: true } })
  const partyOf = byId(parties)
  const quoteOf = byId(quotes)
  const mailOf = byId(mails)
  const styleOf = byId(styles)
  const linesOf = new Map<string, LineData[]>()
  for (const line of lines) linesOf.set(line.inquiryId, [...(linesOf.get(line.inquiryId) ?? []), line])
  return rows.map((row) => {
    const status = row.status as InquiryStatus
    const own = linesOf.get(row.id) ?? []
    const party = row.partyId ? partyOf.get(row.partyId) : undefined
    const sizes: Record<string, number> = {}
    for (const line of own) for (const [code, pieces] of Object.entries(sizesOf(line.sizes))) sizes[code] = (sizes[code] ?? 0) + pieces
    const workingMinutes = minutes.get(row.id) ?? null
    const quote = row.quoteId ? quoteOf.get(row.quoteId) : undefined
    return {
      id: row.id,
      number: row.number,
      companyId: row.companyId,
      source: row.source as InquirySource,
      status,
      receivedAt: toUtcIso(row.receivedAt),
      party: party ? { id: party.id, code: party.code, name: partyName(party) } : null,
      fromWords: fromWordsOf(row, party, row.sourceEmailId ? (mailOf.get(row.sourceEmailId)?.fromAddress ?? null) : null),
      prospect: row.partyId === null,
      summary: summaryOf(row.request),
      products: own.map((line) => (line.styleId ? (styleOf.get(line.styleId)?.code ?? '') : summaryOf(line.description ?? '').slice(0, 40))).filter((words) => words !== ''),
      pieces: own.reduce((sum, line) => sum + (line.quantity ?? piecesOfSizes(sizesOf(line.sizes))), 0),
      sizes: sizesShort(sizes),
      targetUnitPrice: asMoney('price', price(row.targetUnitPrice)),
      currency: row.currency,
      wantedDate: dayOrNull(row.wantedDate),
      waiting: { for: waitingFor(status), workingMinutes: waitingFor(status) === null ? null : workingMinutes, overdue: overdue(status, workingMinutes) },
      assigneeId: row.assigneeId,
      mine: row.assigneeId !== null && row.assigneeId === context.actorId,
      quote: quote ? { id: quote.id, number: quote.number } : null,
      declineReason: (row.declineReason as DeclineReason | null) ?? null,
      closedAt: at(row.closedAt),
      version: row.version,
    }
  })
}

// ---- files and the tech pack -------------------------------------------------------------------------------------------

const FILE_COLUMNS = { id: true, recordType: true, recordId: true, companyId: true, originalName: true, contentType: true, sizeBytes: true, status: true, versionNo: true, seriesId: true, supersededAt: true } as const satisfies Prisma.StoredFileSelect
type FileRow = Prisma.StoredFileGetPayload<{ select: typeof FILE_COLUMNS }>
const fileView = (file: FileRow) => ({ id: file.id, recordType: file.recordType, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, status: file.status, versionNo: file.versionNo })

/** The tech pack as named, each file with the version in force of its series ("always the version in force", SAL-305). */
export async function techPackOf(db: Reader, row: Pick<InquiryData, 'techPackFileIds' | 'techPackVersion'>) {
  if (row.techPackFileIds.length === 0) return { version: row.techPackVersion, files: [] }
  const named = await db.storedFile.findMany({ where: { id: { in: row.techPackFileIds } }, select: FILE_COLUMNS })
  const series = ids(named.map((file) => seriesOf(file)))
  const versions = await db.storedFile.findMany({ where: { OR: [{ id: { in: series } }, { seriesId: { in: series } }] }, select: FILE_COLUMNS })
  const namedOf = byId(named)
  return {
    version: row.techPackVersion,
    files: row.techPackFileIds.flatMap((fileId) => {
      const file = namedOf.get(fileId)
      if (!file) return []
      const root = seriesOf(file)
      const current = currentOf(versions.filter((version) => seriesOf(version) === root))
      return [{ named: fileView(file), current: current ? fileView(current) : null, newer: current !== null && current.id !== file.id && current.versionNo > file.versionNo }]
    }),
  }
}

// ---- the record --------------------------------------------------------------------------------------------------------

const action = (allowedByRole: boolean, refusal: InquiryRefusal | null) => ({ allowed: allowedByRole && refusal === null, refusal })

/** The inquiry's record: the row, what is asked, the mail, the files and tech pack, the quote, the actions for this reader. */
export async function inquiryViewOf(db: Reader, context: OfficeContext, row: InquiryData, now: Date) {
  const [view] = await rowsOf(db, context, [row], now)
  const actor = actorOf(context)
  const [lines, contact, people, mail, files, mailFiles, quote] = await Promise.all([
    db.inquiryLine.findMany({ where: { inquiryId: row.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } }),
    row.contactId ? db.partyContact.findUnique({ where: { id: row.contactId }, select: { id: true, name: true, email: true, erasedAt: true } }) : Promise.resolve(null),
    db.user.findMany({ where: { id: { in: ids([row.assigneeId, row.closedById, row.createdById]) } }, select: { id: true, displayName: true } }),
    row.sourceEmailId ? db.inboundEmail.findUnique({ where: { id: row.sourceEmailId }, select: { id: true, status: true, receivedAt: true, fromAddress: true, fromName: true, subject: true, bodyText: true, bodyHtml: true, threadId: true } }) : Promise.resolve(null),
    db.storedFile.findMany({ where: { recordType: 'Inquiry', recordId: row.id, status: { not: 'DELETED' } }, select: FILE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    row.sourceEmailId ? db.storedFile.findMany({ where: { recordType: 'InboundEmail', recordId: row.sourceEmailId, status: { not: 'DELETED' } }, select: FILE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : Promise.resolve([]),
    row.quoteId ? db.quote.findUnique({ where: { id: row.quoteId }, select: { id: true, number: true, status: true, currentRevision: true, companyId: true, partyId: true } }) : Promise.resolve(null),
  ])
  const [styles, colourways, version, techPack] = await Promise.all([
    db.style.findMany({ where: { id: { in: ids(lines.map((line) => line.styleId)) } }, select: { id: true, code: true, name: true } }),
    db.colourway.findMany({ where: { id: { in: ids(lines.map((line) => line.colourwayId)) } }, select: { id: true, code: true, name: true } }),
    quote ? db.quoteVersion.findFirst({ where: { quoteId: quote.id, revision: quote.currentRevision }, select: { netAmount: true, currency: true } }) : Promise.resolve(null),
    techPackOf(db, row),
  ])
  const styleOf = byId(styles)
  const colourwayOf = byId(colourways)
  const personOf = byId(people)
  const person = (userId: string | null) => (userId && personOf.get(userId) ? { id: userId, name: personOf.get(userId)!.displayName } : null)
  const readsFiles = (file: FileRow) => can(actor, FILES_READ, { companyId: file.companyId })
  const facts = factsOf(row)
  const manage = may(context, SALES_INQUIRIES_MANAGE, row)
  const hasProspect = row.partyId === null || row.prospectName !== null || row.prospectCompany !== null || row.prospectEmail !== null || row.prospectErasedAt !== null
  return {
    ...view!,
    request: row.request,
    note: row.note,
    closeNote: row.closeNote,
    contact: contact ? { id: contact.id, name: contact.erasedAt ? 'Erased contact' : contact.name, email: contact.email } : null,
    prospectDetails: hasProspect
      ? { name: row.prospectName, company: row.prospectCompany, email: row.prospectEmail, phone: row.prospectPhone, lawfulBasis: (row.prospectLawfulBasis as LawfulBasis | null) ?? null, erased: row.prospectErasedAt !== null }
      : null,
    assignee: person(row.assigneeId),
    assignedAt: at(row.assignedAt),
    lines: lines.map((line) => {
      const style = line.styleId ? styleOf.get(line.styleId) : undefined
      const colourway = line.colourwayId ? colourwayOf.get(line.colourwayId) : undefined
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
      }
    }),
    mail: mail
      ? { id: mail.id, status: mail.status, receivedAt: toUtcIso(mail.receivedAt), from: { address: mail.fromAddress, name: mail.fromName }, subject: mail.subject, bodyText: mail.bodyText, bodyHtml: mail.bodyHtml, threadId: mail.threadId }
      : null,
    techPack,
    files: files.filter(readsFiles).map(fileView),
    mailFiles: mailFiles.filter(readsFiles).map(fileView),
    quoteDetail:
      quote && can(actor, QUOTES_VIEW, { companyId: quote.companyId, partyId: quote.partyId })
        ? { id: quote.id, number: quote.number, status: quote.status, revision: quote.currentRevision, netAmount: asMoney('price', version?.netAmount ?? 0), currency: version?.currency ?? row.currency }
        : null,
    closedBy: person(row.closedById),
    createdBy: person(row.createdById),
    createdAt: toUtcIso(row.createdAt as Date),
    actions: {
      edit: action(manage, editRefusal(facts)),
      assign: action(manage, editRefusal(facts)),
      unassign: action(manage, unassignRefusal(facts)),
      askInfo: action(manage, askInfoRefusal(facts)),
      resume: action(manage, resumeRefusal(facts)),
      decline: action(manage, declineRefusal(facts, 'PRICE', null)),
      lose: action(manage, loseRefusal(facts)),
      quote: action(manage && can(actor, QUOTES_MANAGE, { companyId: row.companyId, ...(row.partyId ? { partyId: row.partyId } : {}) }), quoteRefusal(facts)),
    },
  }
}
