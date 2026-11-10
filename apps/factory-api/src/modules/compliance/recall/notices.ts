import type { Prisma } from '@nexus/factory-db'
import { legalFooter, legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import { REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import { draftNotice, type DraftFacts } from '@nexus/factory-domain/compliance/recall/drafts'
import { noticePaper } from '@nexus/factory-domain/compliance/recall/paper'
import { RECALL_MANAGE, RECALL_SEND } from '@nexus/factory-domain/compliance/recall/permissions'
import { defaultDecision, metOnProblems, noticeSendProblems, RECALL_LAW, RECALL_LIMITS, wordsProblems, type AuthorityChannel, type NoticeDecision, type NoticeStatus } from '@nexus/factory-domain/compliance/recall/rules'
import { paperLanguageOf } from '@nexus/factory-domain/compliance/techfiles/paper'
import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import { renderPackPdf } from '../techfiles/pdf'
import { changed as entryChanged, ENTRY_SCOPE } from '../register/register'
import { lockEntry, updateEntry, type EntryRecord } from '../register/store'
import type { NoticeView } from './contract'
import { assertMay, draftNames, entryScope, guarded, mayOn, namesFor, officeOf, recallClock, settings, textOrNull, uuidOr404, visibleEntry, type Reader } from './common'

/**
 * The non-conformity decision and the notice to the authority (B-W2b-260; PRD-387; PPE Reg. (EU) 2016/425 art. 8(8); design
 * compliance.register › pop:rg-notice "Authority notice", tab:authority, tab rg-notice-pdf): a notice per market to its
 * market surveillance authority, drafted from the register entry (product, what was found, the risk, the corrective
 * action) in the market's languages; the person edits it, exports it (the PDF) and sends it on the authority's own channel
 * (the Safety Business Gateway, its site, PEC …), then marks it as sent here with the date, the authority's reference and
 * the copy sent. Nothing is sent from here by itself: "sent" is a person's act (compliance.recall.send, step-up).
 *
 * W1's entry stays in step: the first notice sent fills the entry's "authority notified" date and reference when they are
 * empty (W1's close reads the entry); a date typed by hand is kept. Every write is ONE command (audit row, event
 * authority_notice.changed, Idempotency-Key, the version the caller read); the database's own refusal answers 409 in words.
 */

export const NOTICE_NOT_FOUND = 'Authority notice not found.'

const NOTICE_SELECT = {
  id: true,
  companyId: true,
  registerEntryId: true,
  marketCode: true,
  authorityName: true,
  channel: true,
  decision: true,
  words: true,
  status: true,
  sentAt: true,
  sentById: true,
  reference: true,
  fileId: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  registerEntry: { select: { id: true, reference: true, kind: true, risk: true, status: true, partyId: true, styleId: true } },
  file: { select: { id: true, originalName: true, sizeBytes: true, status: true } },
} as const satisfies Prisma.AuthorityNoticeSelect
export type NoticeRow = Prisma.AuthorityNoticeGetPayload<{ select: typeof NOTICE_SELECT }>

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const wordsOf = (value: unknown): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

export async function marketNames(db: Reader, codes: Iterable<string>): Promise<Map<string, string>> {
  const wanted = [...new Set(codes)]
  if (wanted.length === 0) return new Map()
  const rows = await db.marketProfile.findMany({ where: { code: { in: wanted } }, select: { code: true, name: true, companyId: true }, orderBy: [{ code: 'asc' }] })
  const out = new Map<string, string>()
  // A tenant-wide market first; a company's own profile of the same code only when no tenant-wide one exists.
  for (const row of [...rows.filter((r) => r.companyId === null), ...rows.filter((r) => r.companyId !== null)]) if (!out.has(row.code)) out.set(row.code, row.name)
  return out
}

/** The views of notices (names of people and markets read once). */
export async function noticeViews(db: Reader, context: OfficeContext, rows: readonly NoticeRow[]): Promise<NoticeView[]> {
  const people = await namesFor(db, rows.map((row) => row.sentById))
  const markets = await marketNames(db, rows.map((row) => row.marketCode))
  return rows.map((row) => {
    const scope = { companyId: row.companyId, partyId: row.registerEntry.partyId }
    const manage = mayOn(context, RECALL_MANAGE, scope)
    const send = mayOn(context, RECALL_SEND, scope)
    const open = row.registerEntry.status === 'OPEN'
    return {
      id: row.id,
      companyId: row.companyId,
      entryId: row.registerEntryId,
      entry: { id: row.registerEntry.id, reference: row.registerEntry.reference, kind: row.registerEntry.kind, risk: row.registerEntry.risk, status: row.registerEntry.status },
      marketCode: row.marketCode,
      market: markets.has(row.marketCode) ? { code: row.marketCode, name: markets.get(row.marketCode)! } : null,
      authorityName: row.authorityName,
      channel: row.channel,
      decision: row.decision,
      words: wordsOf(row.words),
      status: row.status,
      sentAt: iso(row.sentAt),
      sentBy: people(row.sentById),
      reference: row.reference,
      file: row.file ? { id: row.file.id, name: row.file.originalName, sizeBytes: row.file.sizeBytes, status: row.file.status } : null,
      cancelledAt: iso(row.cancelledAt),
      cancelReason: row.cancelReason,
      note: row.note,
      law: RECALL_LAW.authorityNotice,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      may: {
        edit: manage && row.status === 'DRAFT' && open,
        send: send && row.status === 'DRAFT' && open && (row.decision !== 'RISK' || row.registerEntry.risk === 'YES'),
        reference: manage && row.status === 'SENT' && (row.reference === null || row.fileId === null),
        cancel: manage && row.status === 'DRAFT',
      },
    }
  })
}

/** The notices hanging on the entries the caller may view. */
export const noticeReach = (context: OfficeContext): Prisma.AuthorityNoticeWhereInput => ({ registerEntry: scopeWhere(actorOf(context), REGISTER_VIEW, ENTRY_SCOPE) as Prisma.PpeRegisterEntryWhereInput })

async function readNotice(db: Reader, context: OfficeContext, noticeId: string): Promise<NoticeRow> {
  uuidOr404(noticeId, NOTICE_NOT_FOUND)
  const row = await db.authorityNotice.findFirst({ where: { AND: [{ id: noticeId }, noticeReach(context)] }, select: NOTICE_SELECT })
  if (!row) throw new NotFoundError(NOTICE_NOT_FOUND)
  return row
}

async function noticeAnswer(caller: CommandCaller, noticeId: string): Promise<{ notice: NoticeView }> {
  const context = officeOf(caller)
  return caller.withClient(async (db) => ({ notice: (await noticeViews(db, context, [await readNotice(db, context, noticeId)]))[0]! }))
}

function emitNotice(tools: Pick<CommandTools, 'emit'>, row: { id: string; companyId: string; registerEntryId: string; marketCode: string; decision: NoticeDecision; status: NoticeStatus }, change: 'DRAFTED' | 'EDITED' | 'SENT' | 'REFERENCE' | 'CANCELLED'): void {
  tools.emit({ type: 'authority_notice.changed', subject: row.id, companyId: row.companyId, payload: { noticeId: row.id, entryId: row.registerEntryId, marketCode: row.marketCode, decision: row.decision, status: row.status, change } })
}

// ---- reads -----------------------------------------------------------------------------------------------------------------

export interface NoticeQuery {
  readonly status?: NoticeStatus | undefined
  readonly entryId?: string | undefined
  readonly companyId?: string | undefined
  readonly marketCode?: string | undefined
  readonly limit: number
}

/** GET /compliance/authority-notices: notices with the register's tile "authority notices due or sent". */
export async function listNotices(caller: CommandCaller, query: NoticeQuery) {
  const context = officeOf(caller)
  const reach = noticeReach(context)
  const yearStart = businessDayStart(`${businessDate(recallClock().now()).slice(0, 4)}-01-01`)
  return caller.withClient(async (db) => {
    const rows = await db.authorityNotice.findMany({
      where: {
        AND: [
          reach,
          query.status ? { status: query.status } : {},
          query.entryId ? { registerEntryId: query.entryId } : {},
          query.companyId ? { companyId: query.companyId } : {},
          query.marketCode ? { marketCode: query.marketCode } : {},
        ],
      },
      select: NOTICE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: query.limit,
    })
    const entryScopeWhere = scopeWhere(actorOf(context), REGISTER_VIEW, ENTRY_SCOPE) as Prisma.PpeRegisterEntryWhereInput
    const tiles = {
      drafts: await db.authorityNotice.count({ where: { AND: [reach, { status: 'DRAFT' }] } }),
      sentThisYear: await db.authorityNotice.count({ where: { AND: [reach, { status: 'SENT', sentAt: { gte: yearStart } }] } }),
      risksWithoutNotice: await db.ppeRegisterEntry.count({ where: { AND: [entryScopeWhere, { status: 'OPEN', risk: 'YES', authorityNotifiedAt: null, authorityNotices: { none: { status: 'SENT' } } }] } }),
    }
    return { notices: await noticeViews(db, context, rows), tiles }
  })
}

export const getNotice = (caller: CommandCaller, noticeId: string) => noticeAnswer(caller, noticeId)

/** The notices of one entry (the record's Authority notices tab). */
export async function noticesOfEntry(db: Reader, context: OfficeContext, entryId: string): Promise<NoticeView[]> {
  const rows = await db.authorityNotice.findMany({ where: { registerEntryId: entryId }, select: NOTICE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return noticeViews(db, context, rows)
}

// ---- draft and edit --------------------------------------------------------------------------------------------------------

/** The facts a draft is made from: the entry, its company and style. */
export async function draftFactsOf(db: Reader, entry: EntryRecord, scope?: { readonly wholeStyle: boolean; readonly batchNumbers: readonly string[]; readonly serialCount: number }): Promise<DraftFacts> {
  const names = await draftNames(db, entry.companyId, entry.styleId)
  return {
    ...names,
    entryReference: entry.reference,
    reportedOn: businessDate(entry.reportedAt),
    wholeStyle: scope?.wholeStyle ?? false,
    batchNumbers: scope?.batchNumbers ?? entry.batchNumbers,
    serialCount: scope?.serialCount ?? entry.serials.length,
    description: entry.description,
    investigation: entry.investigation,
    risk: entry.risk,
    actionTaken: entry.actionTaken,
  }
}

/** A market of the tenant by its code (Rules & markets), with the languages its declaration is printed in. */
async function marketOf(db: Reader, code: string, companyId: string): Promise<{ code: string; languages: string[] }> {
  const rows = await db.marketProfile.findMany({ where: { code, OR: [{ companyId: null }, { companyId }] }, select: { code: true, docLanguages: true, companyId: true } })
  const row = rows.find((entry) => entry.companyId === companyId) ?? rows[0]
  if (!row) throw new ValidationError('The market is not one of the tenant.', [{ path: 'body/marketCode', message: `${code} is not a market in Rules & markets: add it there first.` }])
  return { code: row.code, languages: [...row.docLanguages] }
}

export interface DraftNoticeBody {
  readonly marketCode: string
  readonly authorityName: string
  readonly channel: AuthorityChannel
  readonly decision?: NoticeDecision | undefined
  readonly words?: Readonly<Record<string, string>> | undefined
  readonly note?: string | undefined
}

/** POST /compliance/register/:entryId/authority-notices: a DRAFT notice to one market's authority, its words drafted from the entry. */
export async function draftAuthorityNotice(caller: CommandCaller, entryId: string, body: DraftNoticeBody, key: string | null | undefined): Promise<{ notice: NoticeView }> {
  const context = officeOf(caller)
  const entry = await caller.withClient((db) => visibleEntry(db, context, entryId))
  assertMay(context, RECALL_MANAGE, entryScope(entry), 'Drafting an authority notice')
  if (entry.status !== 'OPEN') throw new ConflictError(`Register entry ${entry.reference} is closed: a notice is drafted while it is open.`)
  const decision = body.decision ?? defaultDecision(entry.risk)
  const { words, market } = await caller.withClient(async (db) => {
    const market = await marketOf(db, body.marketCode, entry.companyId)
    const words = body.words ?? draftNotice(await draftFactsOf(db, entry), decision, market.languages)
    return { words, market }
  })
  const problems: Issue[] = wordsProblems(words, RECALL_LIMITS.noticeWords, 'body/words')
  if (problems.length > 0) throw new ValidationError('The notice is not valid.', problems)
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.draftNotice', idempotencyKey: key, input: { entryId, ...body } },
      async (tools) => {
        const { tx, now, audit } = tools
        const id = newId()
        const row = await tx.authorityNotice.create({
          data: { id, companyId: entry.companyId, registerEntryId: entry.id, marketCode: market.code, authorityName: body.authorityName.trim(), channel: body.channel, decision, words, note: textOrNull(body.note), createdAt: now, updatedAt: now, createdById: context.actorId },
          select: { id: true, companyId: true, registerEntryId: true, marketCode: true, decision: true, status: true },
        })
        audit({ recordType: 'AuthorityNotice', recordId: id, companyId: entry.companyId, after: { entryId: entry.id, marketCode: market.code, authorityName: body.authorityName.trim(), channel: body.channel, decision, languages: Object.keys(words), status: 'DRAFT' } })
        emitNotice(tools, row, 'DRAFTED')
        return { id }
      },
      settings(),
    ),
  )
  return noticeAnswer(caller, result.id)
}

export interface EditNoticeBody {
  readonly version: number
  readonly authorityName?: string | undefined
  readonly channel?: AuthorityChannel | undefined
  readonly decision?: NoticeDecision | undefined
  readonly words?: Readonly<Record<string, string>> | undefined
  readonly note?: string | null | undefined
}

/** PATCH /compliance/authority-notices/:noticeId: a DRAFT's authority, way, decision, words or note (the market stays). */
export async function editAuthorityNotice(caller: CommandCaller, noticeId: string, body: EditNoticeBody, key: string | null | undefined): Promise<{ notice: NoticeView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readNotice(db, context, noticeId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Editing an authority notice')
  if (before.status !== 'DRAFT') throw new ConflictError(before.status === 'SENT' ? 'This notice was sent: it stays as it was sent (add its reference or copy, or a note).' : 'This notice was cancelled: draft a new one.')
  if (body.words) {
    const problems = wordsProblems(body.words, RECALL_LIMITS.noticeWords, 'body/words')
    if (problems.length > 0) throw new ValidationError('The notice is not valid.', problems)
  }
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.editNotice', idempotencyKey: key, input: { noticeId, ...body }, record: { type: 'AuthorityNotice', id: noticeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const data: Prisma.AuthorityNoticeUncheckedUpdateInput = {
          ...(body.authorityName !== undefined ? { authorityName: body.authorityName.trim() } : {}),
          ...(body.channel !== undefined ? { channel: body.channel } : {}),
          ...(body.decision !== undefined ? { decision: body.decision } : {}),
          ...(body.words !== undefined ? { words: { ...body.words } } : {}),
          ...(body.note !== undefined ? { note: textOrNull(body.note) } : {}),
          updatedAt: now,
        }
        const row = await tx.authorityNotice.update({ where: { id: noticeId }, data, select: { id: true, companyId: true, registerEntryId: true, marketCode: true, decision: true, status: true } })
        audit({
          recordType: 'AuthorityNotice',
          recordId: noticeId,
          companyId: before.companyId,
          before: { authorityName: before.authorityName, channel: before.channel, decision: before.decision, languages: Object.keys(wordsOf(before.words)), note: before.note },
          after: { authorityName: body.authorityName ?? before.authorityName, channel: body.channel ?? before.channel, decision: row.decision, languages: Object.keys(body.words ?? wordsOf(before.words)), note: body.note !== undefined ? textOrNull(body.note) : before.note },
        })
        emitNotice(tools, row, 'EDITED')
        return {}
      },
      settings(),
    ),
  )
  return noticeAnswer(caller, noticeId)
}

// ---- sent, reference, cancel --------------------------------------------------------------------------------------------------

/** The copy as sent: an AVAILABLE file uploaded to this notice. */
async function checkCopy(db: Reader, noticeId: string, fileId: string): Promise<void> {
  const file = await db.storedFile.findUnique({ where: { id: fileId }, select: { recordType: true, recordId: true, status: true } })
  if (!file || file.recordType !== 'AuthorityNotice' || file.recordId !== noticeId) {
    throw new ValidationError('The copy is not a file of this notice.', [{ path: 'body/fileId', message: 'Upload the copy as sent to this notice first (POST /files with recordType AuthorityNotice and this notice), then name it.' }])
  }
  if (file.status !== 'AVAILABLE') throw new ValidationError('The copy is not stored yet.', [{ path: 'body/fileId', message: 'Finish the upload of the copy first.' }])
}

/**
 * W1's entry in step (inside the caller's command, the entry's row locked): the first notice sent fills the entry's
 * "authority notified" date and its reference when they are empty; a date typed by hand stays. A closed entry is left
 * as it is (a reference added after the close).
 */
async function keepEntryInStep(tools: CommandTools, entryId: string, sentAt: Date, reference: string | null): Promise<boolean> {
  const locked = await lockEntry(tools.tx, entryId)
  if (locked.status !== 'OPEN') return false
  const changes = {
    ...(locked.authorityNotifiedAt === null ? { authorityNotifiedAt: sentAt } : {}),
    ...(reference !== null && (locked.authorityReference === null || locked.authorityReference.trim() === '') ? { authorityReference: reference.slice(0, 120) } : {}),
  }
  if (Object.keys(changes).length === 0) return false
  const written = await updateEntry(tools, locked, changes, { action: 'compliance.recall.entryAuthorityNotified' })
  entryChanged(tools, locked, written, 'AUTHORITY_NOTIFIED')
  return true
}

export interface SendNoticeBody {
  readonly version: number
  readonly sentAt?: string | undefined
  readonly reference?: string | undefined
  readonly fileId?: string | undefined
  readonly note?: string | undefined
}

/**
 * POST /compliance/authority-notices/:noticeId/sent (compliance.recall.send, step-up): the person marks the notice as sent
 * by them, on that day, with the authority's reference and the copy when they have them. A notice of a RISK needs the
 * entry's risk decided YES first. The entry's date and reference follow when empty.
 */
export async function markNoticeSent(caller: CommandCaller, noticeId: string, body: SendNoticeBody, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | null | undefined }): Promise<{ notice: NoticeView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readNotice(db, context, noticeId))
  assertMay(context, RECALL_SEND, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Marking an authority notice as sent')
  options.stepUp()
  if (body.fileId) await caller.withClient((db) => checkCopy(db, noticeId, body.fileId!))
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.sendNotice', idempotencyKey: options.idempotencyKey, input: { noticeId, ...body }, record: { type: 'AuthorityNotice', id: noticeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const entry = await lockEntry(tx, before.registerEntryId)
        const refused = noticeSendProblems({ status: before.status as NoticeStatus, decision: before.decision as NoticeDecision }, entry)
        if (refused.length > 0) throw new DomainError('conflict', refused[0]!.message, refused)
        const sentAt = body.sentAt ? new Date(body.sentAt) : now
        const problems = metOnProblems(sentAt, entry.reportedAt, now, 'body/sentAt')
        if (problems.length > 0) throw new ValidationError('The date is not valid.', problems)
        const reference = body.reference?.trim() || null
        const row = await tx.authorityNotice.update({
          where: { id: noticeId },
          data: { status: 'SENT', sentAt, sentById: context.actorId, reference, fileId: body.fileId ?? null, ...(body.note !== undefined ? { note: textOrNull(body.note) } : {}), updatedAt: now },
          select: { id: true, companyId: true, registerEntryId: true, marketCode: true, decision: true, status: true },
        })
        audit({ recordType: 'AuthorityNotice', recordId: noticeId, companyId: before.companyId, before: { status: 'DRAFT' }, after: { status: 'SENT', sentAt: toUtcIso(sentAt), sentById: context.actorId, reference, fileId: body.fileId ?? null } })
        emitNotice(tools, row, 'SENT')
        await keepEntryInStep(tools, before.registerEntryId, sentAt, reference)
        return {}
      },
      settings(),
    ),
  )
  return noticeAnswer(caller, noticeId)
}

/** POST /compliance/authority-notices/:noticeId/reference: the authority's reference and/or the copy of a SENT notice, each once. */
export async function recordNoticeReference(caller: CommandCaller, noticeId: string, body: { readonly version: number; readonly reference?: string | undefined; readonly fileId?: string | undefined }, key: string | null | undefined): Promise<{ notice: NoticeView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readNotice(db, context, noticeId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, "Recording the authority's reference")
  if (before.status !== 'SENT') throw new ConflictError('The reference and the copy are recorded once the notice was sent.')
  if (body.reference === undefined && body.fileId === undefined) throw new ValidationError('Nothing to record.', [{ path: 'body/reference', message: "Give the authority's reference or the copy sent." }])
  const issues: Issue[] = []
  if (body.reference !== undefined && before.reference !== null) issues.push({ path: 'body/reference', message: `The reference is recorded already (${before.reference}).` })
  if (body.fileId !== undefined && before.fileId !== null) issues.push({ path: 'body/fileId', message: 'The copy is recorded already.' })
  if (issues.length > 0) throw new DomainError('conflict', issues[0]!.message, issues)
  if (body.fileId) await caller.withClient((db) => checkCopy(db, noticeId, body.fileId!))
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.noticeReference', idempotencyKey: key, input: { noticeId, ...body }, record: { type: 'AuthorityNotice', id: noticeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const reference = body.reference?.trim()
        const row = await tx.authorityNotice.update({
          where: { id: noticeId },
          data: { ...(reference !== undefined ? { reference } : {}), ...(body.fileId !== undefined ? { fileId: body.fileId } : {}), updatedAt: now },
          select: { id: true, companyId: true, registerEntryId: true, marketCode: true, decision: true, status: true },
        })
        audit({ recordType: 'AuthorityNotice', recordId: noticeId, companyId: before.companyId, before: { reference: before.reference, fileId: before.fileId }, after: { reference: reference ?? before.reference, fileId: body.fileId ?? before.fileId } })
        emitNotice(tools, row, 'REFERENCE')
        if (reference) await keepEntryInStep(tools, before.registerEntryId, before.sentAt!, reference)
        return {}
      },
      settings(),
    ),
  )
  return noticeAnswer(caller, noticeId)
}

/** POST /compliance/authority-notices/:noticeId/cancel: a DRAFT not sent, with why. */
export async function cancelAuthorityNotice(caller: CommandCaller, noticeId: string, body: { readonly version: number; readonly reason: string }, key: string | null | undefined): Promise<{ notice: NoticeView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readNotice(db, context, noticeId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Cancelling an authority notice')
  if (before.status !== 'DRAFT') throw new ConflictError(before.status === 'SENT' ? 'A notice that was sent is never cancelled: it stays as sent.' : 'This notice is cancelled already.')
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.cancelNotice', idempotencyKey: key, input: { noticeId, ...body }, record: { type: 'AuthorityNotice', id: noticeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const reason = body.reason.trim()
        const row = await tx.authorityNotice.update({ where: { id: noticeId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, updatedAt: now }, select: { id: true, companyId: true, registerEntryId: true, marketCode: true, decision: true, status: true } })
        audit({ recordType: 'AuthorityNotice', recordId: noticeId, companyId: before.companyId, before: { status: 'DRAFT' }, after: { status: 'CANCELLED' }, reason })
        emitNotice(tools, row, 'CANCELLED')
        return {}
      },
      settings(),
    ),
  )
  return noticeAnswer(caller, noticeId)
}

// ---- the PDF ---------------------------------------------------------------------------------------------------------------

/** GET /compliance/authority-notices/:noticeId/pdf?language=: the notice on A4 in one of its languages (the first when left out). */
export async function noticePdf(caller: CommandCaller, noticeId: string, language: string | undefined): Promise<{ bytes: Buffer; name: string }> {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => readNotice(db, context, noticeId))
  const words = wordsOf(row.words)
  const chosen = language ?? Object.keys(words)[0]
  if (!chosen || words[chosen] === undefined) {
    throw new ValidationError('The notice has no words in this language.', [{ path: 'querystring/language', message: `Choose one of: ${Object.keys(words).join(', ')}.` }])
  }
  const company = await companyLegalOf(caller, row.companyId)
  const paperLanguage = paperLanguageOf(chosen.slice(0, 2))
  const style = await caller.withClient((db) => db.style.findUnique({ where: { id: row.registerEntry.styleId }, select: { code: true } }))
  const markets = await caller.withClient((db) => marketNames(db, [row.marketCode]))
  const paper = noticePaper({
    language: chosen,
    company: { name: legalName(company, paperLanguage), lines: legalLines(company, paperLanguage), legal: legalFooter(company, paperLanguage) },
    authorityName: row.authorityName,
    market: markets.has(row.marketCode) ? `${markets.get(row.marketCode)} (${row.marketCode})` : row.marketCode,
    channel: row.channel,
    decision: row.decision,
    status: row.status,
    entryReference: row.registerEntry.reference,
    styleCode: style?.code ?? '',
    sentOn: row.sentAt ? businessDate(row.sentAt) : null,
    reference: row.reference,
    words: words[chosen]!,
    madeAt: toUtcIso(row.sentAt ?? row.createdAt),
  })
  return { bytes: await renderPackPdf(paper), name: paper.fileName }
}
