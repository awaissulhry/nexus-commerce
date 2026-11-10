import type { Prisma } from '@nexus/factory-db'
import { REGISTER_MANAGE, REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import { RECALL_MANAGE } from '@nexus/factory-domain/compliance/recall/permissions'
import { cleanCodes, metOnProblems, RECALL_LAW, requestDue, requestProblems, type AuthorityChannel, type RequestStatus } from '@nexus/factory-domain/compliance/recall/rules'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { requestPack } from '../techfiles/packs'
import { openRegisterEntryFor } from '../register/hook'
import { readEntry } from '../register/store'
import type { RequestView } from './contract'
import { assertMay, dateOfDay, dayOf, guarded, mayOn, namesFor, officeOf, recallClock, settings, textOrNull, todayOf, uuidOr404, type Reader } from './common'
import { marketNames } from './notices'

/**
 * The authority request log (B-W2b-260; PRD-390; Reg. (EU) 2019/1020 art. 4(3); PPE Reg. (EU) 2016/425 art. 8(9) "further
 * to a reasoned request from a competent national authority, provide it with all the information and documentation";
 * design compliance.register › tab:authority "Requests: date, authority, scope, deadline (Countdown), documents sent (evidence
 * pack links)", "Log a request; build an evidence pack for it", the band's saved view "Authority requests").
 *
 *   log       what an authority asks (its market, way, reference, the style and batches it is about), when it came and by
 *             when it is due; numbered from the company's AUTHORITY_REQUEST series (AR-…).
 *   entry     the register entry it is about: one named (of its style), or a new AUTHORITY_REQUEST entry opened from it
 *             (W1's hook, source AuthorityRequest; one entry per request).
 *   evidence  the evidence pack sent (B-W2b-251): one built already, or one asked now from the style's technical file for
 *             the request's batches (built by the worker; sent by its read-only link from the technical file).
 *   answer    when and what was sent, by the person; cancelled with why (logged twice, withdrawn by the authority).
 *
 * Event-driven: the Countdown and the tiles read the due day; nothing is sent to an authority from here. Every write is ONE
 * command (audit row, event authority_request.changed, Idempotency-Key, the version the caller read); the database's own
 * refusal answers 409 in words.
 */

export const REQUEST_NOT_FOUND = 'Authority request not found.'

const REQUEST_SELECT = {
  id: true,
  companyId: true,
  number: true,
  authorityName: true,
  marketCode: true,
  authorityReference: true,
  channel: true,
  receivedAt: true,
  styleId: true,
  batchNumbers: true,
  request: true,
  dueOn: true,
  status: true,
  answeredAt: true,
  answeredById: true,
  answerSummary: true,
  evidenceType: true,
  evidenceId: true,
  registerEntryId: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  style: { select: { id: true, code: true, name: true } },
  registerEntry: { select: { id: true, reference: true, kind: true, risk: true, status: true } },
} as const satisfies Prisma.AuthorityRequestSelect
type RequestRow = Prisma.AuthorityRequestGetPayload<{ select: typeof REQUEST_SELECT }>

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const EMIT_SELECT = { id: true, number: true, companyId: true, status: true, dueOn: true, registerEntryId: true } as const satisfies Prisma.AuthorityRequestSelect
type Change = 'LOGGED' | 'EDITED' | 'ENTRY_LINKED' | 'EVIDENCE' | 'ANSWERED' | 'CANCELLED'
function emitRequest(tools: Pick<CommandTools, 'emit'>, row: Prisma.AuthorityRequestGetPayload<{ select: typeof EMIT_SELECT }>, change: Change): void {
  tools.emit({
    type: 'authority_request.changed',
    subject: row.id,
    companyId: row.companyId,
    payload: { requestId: row.id, number: row.number, status: row.status, dueOn: dayOf(row.dueOn)!, entryId: row.registerEntryId, change },
  })
}

/** The requests of the companies the register's view reaches. */
export const requestReach = (context: OfficeContext): Prisma.AuthorityRequestWhereInput => scopeWhere(actorOf(context), REGISTER_VIEW, { company: 'companyId' }) as Prisma.AuthorityRequestWhereInput

export async function requestViews(db: Reader, context: OfficeContext, rows: readonly RequestRow[]): Promise<RequestView[]> {
  const people = await namesFor(db, rows.map((row) => row.answeredById))
  const markets = await marketNames(db, rows.map((row) => row.marketCode))
  const packIds = rows.filter((row) => row.evidenceType === 'EvidencePack' && row.evidenceId).map((row) => row.evidenceId!)
  const packs = new Map((packIds.length ? await db.evidencePack.findMany({ where: { id: { in: packIds } }, select: { id: true, number: true, status: true, purpose: true, builtAt: true, fileId: true, zipFileId: true } }) : []).map((pack) => [pack.id, pack]))
  const packFiles = [...packs.values()].flatMap((pack) => [pack.fileId, pack.zipFileId]).filter((id): id is string => id !== null)
  const links = packFiles.length ? await db.linkFile.findMany({ where: { fileId: { in: packFiles } }, select: { linkId: true, fileId: true } }) : []
  const today = todayOf()
  return rows.map((row) => {
    const manage = mayOn(context, RECALL_MANAGE, { companyId: row.companyId })
    const open = row.status === 'OPEN'
    const pack = row.evidenceId ? packs.get(row.evidenceId) : undefined
    return {
      id: row.id,
      companyId: row.companyId,
      number: row.number,
      authorityName: row.authorityName,
      marketCode: row.marketCode,
      market: markets.has(row.marketCode) ? { code: row.marketCode, name: markets.get(row.marketCode)! } : null,
      authorityReference: row.authorityReference,
      channel: row.channel,
      receivedAt: toUtcIso(row.receivedAt),
      style: row.style ? { id: row.style.id, code: row.style.code, name: row.style.name } : null,
      batchNumbers: [...row.batchNumbers],
      request: row.request,
      dueOn: dayOf(row.dueOn)!,
      due: requestDue({ status: row.status, dueOn: dayOf(row.dueOn)! }, today),
      status: row.status,
      answeredAt: iso(row.answeredAt),
      answeredBy: people(row.answeredById),
      answerSummary: row.answerSummary,
      evidence:
        row.evidenceType && row.evidenceId
          ? {
              type: row.evidenceType,
              id: row.evidenceId,
              pack: pack
                ? { id: pack.id, number: pack.number, status: pack.status, purpose: pack.purpose, links: new Set(links.filter((link) => link.fileId === pack.fileId || link.fileId === pack.zipFileId).map((link) => link.linkId)).size, builtAt: iso(pack.builtAt) }
                : null,
            }
          : null,
      entry: row.registerEntry ? { id: row.registerEntry.id, reference: row.registerEntry.reference, kind: row.registerEntry.kind, risk: row.registerEntry.risk, status: row.registerEntry.status } : null,
      cancelledAt: iso(row.cancelledAt),
      cancelReason: row.cancelReason,
      note: row.note,
      law: RECALL_LAW.authorityRequest,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      may: { edit: manage && open, answer: manage && open, cancel: manage && open, entry: manage && open && row.registerEntryId === null, evidence: manage && open },
    }
  })
}

async function readRequest(db: Reader, context: OfficeContext, requestId: string): Promise<RequestRow> {
  uuidOr404(requestId, REQUEST_NOT_FOUND)
  const row = await db.authorityRequest.findFirst({ where: { AND: [{ id: requestId }, requestReach(context)] }, select: REQUEST_SELECT })
  if (!row) throw new NotFoundError(REQUEST_NOT_FOUND)
  return row
}

async function requestAnswer(caller: CommandCaller, requestId: string): Promise<{ request: RequestView }> {
  const context = officeOf(caller)
  return caller.withClient(async (db) => ({ request: (await requestViews(db, context, [await readRequest(db, context, requestId)]))[0]! }))
}

// ---- reads ------------------------------------------------------------------------------------------------------------------

export interface RequestQuery {
  readonly status?: RequestStatus | undefined
  readonly due?: 'OVERDUE' | 'DUE_SOON' | undefined
  readonly entryId?: string | undefined
  readonly styleId?: string | undefined
  readonly companyId?: string | undefined
  readonly q?: string | undefined
  readonly limit: number
}

const addDays = (day: BusinessDate, days: number): Date => new Date(dateOfDay(day).getTime() + days * 86_400_000)

/** GET /compliance/authority-requests: the log, open ones by due day first, with the tiles. */
export async function listRequests(caller: CommandCaller, query: RequestQuery) {
  const context = officeOf(caller)
  const reach = requestReach(context)
  const today = todayOf()
  const yearStart = businessDayStart(`${today.slice(0, 4)}-01-01`)
  return caller.withClient(async (db) => {
    const rows = await db.authorityRequest.findMany({
      where: {
        AND: [
          reach,
          query.status ? { status: query.status } : {},
          query.due === 'OVERDUE' ? { status: 'OPEN', dueOn: { lt: dateOfDay(today) } } : {},
          query.due === 'DUE_SOON' ? { status: 'OPEN', dueOn: { gte: dateOfDay(today), lte: addDays(today, 7) } } : {},
          query.entryId ? { registerEntryId: query.entryId } : {},
          query.styleId ? { styleId: query.styleId } : {},
          query.companyId ? { companyId: query.companyId } : {},
          query.q
            ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { authorityName: { contains: query.q, mode: 'insensitive' } }, { authorityReference: { contains: query.q, mode: 'insensitive' } }, { batchNumbers: { has: query.q } }] }
            : {},
        ],
      },
      select: REQUEST_SELECT,
      orderBy: [{ status: 'asc' }, { dueOn: 'asc' }, { number: 'asc' }],
      take: query.limit,
    })
    const tiles = {
      open: await db.authorityRequest.count({ where: { AND: [reach, { status: 'OPEN' }] } }),
      overdue: await db.authorityRequest.count({ where: { AND: [reach, { status: 'OPEN', dueOn: { lt: dateOfDay(today) } }] } }),
      dueSoon: await db.authorityRequest.count({ where: { AND: [reach, { status: 'OPEN', dueOn: { gte: dateOfDay(today), lte: addDays(today, 7) } }] } }),
      answeredThisYear: await db.authorityRequest.count({ where: { AND: [reach, { status: 'ANSWERED', answeredAt: { gte: yearStart } }] } }),
    }
    return { requests: await requestViews(db, context, rows), tiles }
  })
}

export const getRequest = (caller: CommandCaller, requestId: string) => requestAnswer(caller, requestId)

export async function requestsOfEntry(db: Reader, context: OfficeContext, entryId: string): Promise<RequestView[]> {
  return requestViews(db, context, await db.authorityRequest.findMany({ where: { registerEntryId: entryId }, select: REQUEST_SELECT, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] }))
}

// ---- references --------------------------------------------------------------------------------------------------------------

async function checkFacts(db: Reader, companyId: string, facts: { readonly marketCode?: string | undefined; readonly styleId?: string | null | undefined }): Promise<void> {
  const problems: Issue[] = []
  if (facts.marketCode !== undefined && !(await db.marketProfile.findFirst({ where: { code: facts.marketCode, OR: [{ companyId: null }, { companyId }] }, select: { id: true } }))) {
    problems.push({ path: 'body/marketCode', message: `${facts.marketCode} is not a market in Rules & markets: add it there first.` })
  }
  if (facts.styleId) {
    const style = await db.style.findUnique({ where: { id: facts.styleId }, select: { companyId: true } })
    if (!style || (style.companyId !== null && style.companyId !== companyId)) problems.push({ path: 'body/styleId', message: 'Not a style of this company.' })
  }
  if (problems.length > 0) throw new ValidationError('The request is not valid.', problems)
}

// ---- log and edit ------------------------------------------------------------------------------------------------------------

export interface LogRequestBody {
  readonly companyId: string
  readonly authorityName: string
  readonly marketCode: string
  readonly authorityReference?: string | undefined
  readonly channel: AuthorityChannel
  readonly receivedAt: string
  readonly styleId?: string | undefined
  readonly batchNumbers?: readonly string[] | undefined
  readonly request: string
  readonly dueOn: BusinessDate
  readonly registerEntryId?: string | undefined
  readonly note?: string | undefined
}

/** POST /compliance/authority-requests: an OPEN request, numbered AR-…. */
export async function logRequest(caller: CommandCaller, body: LogRequestBody, key: string | null | undefined): Promise<{ request: RequestView }> {
  const context = officeOf(caller)
  assertMay(context, RECALL_MANAGE, { companyId: body.companyId }, 'Logging an authority request')
  const receivedAt = new Date(body.receivedAt)
  const batchNumbers = cleanCodes(body.batchNumbers)
  const problems = requestProblems({ receivedAt, dueOn: body.dueOn, batchNumbers, styleId: body.styleId ?? null }, recallClock().now())
  if (problems.length > 0) throw new ValidationError('The request is not valid.', problems)
  await caller.withClient(async (db) => {
    if (!(await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new ValidationError('The request is not valid.', [{ path: 'body/companyId', message: 'Not a company of the tenant.' }])
    await checkFacts(db, body.companyId, body)
    if (body.registerEntryId) await checkEntry(db, context, body.companyId, body.styleId ?? null, body.registerEntryId)
  })
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.logRequest', idempotencyKey: key, input: body },
      async (tools) => {
        const { tx, now, audit } = tools
        const id = newId()
        const issued = await allocateNumber(tools, { companyId: body.companyId, kind: 'AUTHORITY_REQUEST' }, { type: 'AuthorityRequest', id, date: businessDate(receivedAt) })
        const row = await tx.authorityRequest.create({
          data: {
            id,
            companyId: body.companyId,
            number: issued.formatted,
            authorityName: body.authorityName.trim(),
            marketCode: body.marketCode,
            authorityReference: textOrNull(body.authorityReference),
            channel: body.channel,
            receivedAt,
            styleId: body.styleId ?? null,
            batchNumbers,
            request: body.request.trim(),
            dueOn: dateOfDay(body.dueOn),
            registerEntryId: body.registerEntryId ?? null,
            note: textOrNull(body.note),
            createdAt: now,
            updatedAt: now,
            createdById: context.actorId,
          },
          select: EMIT_SELECT,
        })
        audit({ recordType: 'AuthorityRequest', recordId: id, companyId: body.companyId, after: { number: issued.formatted, authorityName: body.authorityName.trim(), marketCode: body.marketCode, channel: body.channel, receivedAt: toUtcIso(receivedAt), styleId: body.styleId ?? null, batchNumbers, dueOn: body.dueOn, registerEntryId: body.registerEntryId ?? null, status: 'OPEN' } })
        emitRequest(tools, row, 'LOGGED')
        return { id }
      },
      settings(),
    ),
  )
  return requestAnswer(caller, result.id)
}

export interface EditRequestBody {
  readonly version: number
  readonly authorityName?: string | undefined
  readonly marketCode?: string | undefined
  readonly authorityReference?: string | null | undefined
  readonly channel?: AuthorityChannel | undefined
  readonly receivedAt?: string | undefined
  readonly styleId?: string | null | undefined
  readonly batchNumbers?: readonly string[] | undefined
  readonly request?: string | undefined
  readonly dueOn?: BusinessDate | undefined
  readonly note?: string | null | undefined
}

/** PATCH /compliance/authority-requests/:requestId: the facts corrected while OPEN (the note also later). */
export async function editRequest(caller: CommandCaller, requestId: string, body: EditRequestBody, key: string | null | undefined): Promise<{ request: RequestView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRequest(db, context, requestId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId }, 'Correcting an authority request')
  const factsGiven = Object.keys(body).some((field) => field !== 'version' && field !== 'note')
  if (before.status !== 'OPEN' && factsGiven) throw new ConflictError(`Request ${before.number} is ${before.status}: only its note changes; log a new request.`)
  const after = {
    receivedAt: body.receivedAt ? new Date(body.receivedAt) : before.receivedAt,
    dueOn: body.dueOn ?? dayOf(before.dueOn)!,
    batchNumbers: body.batchNumbers !== undefined ? cleanCodes(body.batchNumbers) : [...before.batchNumbers],
    styleId: body.styleId !== undefined ? body.styleId : before.styleId,
  }
  if (before.registerEntryId !== null && body.styleId !== undefined && body.styleId !== before.styleId) {
    throw new ConflictError(`Request ${before.number} names register entry ${before.registerEntry?.reference ?? ''}: its style stays the entry's.`)
  }
  const problems = requestProblems(after, recallClock().now())
  if (problems.length > 0) throw new ValidationError('The request is not valid.', problems)
  await caller.withClient((db) => checkFacts(db, before.companyId, { marketCode: body.marketCode, styleId: body.styleId }))
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.editRequest', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'AuthorityRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const data: Prisma.AuthorityRequestUncheckedUpdateInput = {
          ...(body.authorityName !== undefined ? { authorityName: body.authorityName.trim() } : {}),
          ...(body.marketCode !== undefined ? { marketCode: body.marketCode } : {}),
          ...(body.authorityReference !== undefined ? { authorityReference: textOrNull(body.authorityReference) } : {}),
          ...(body.channel !== undefined ? { channel: body.channel } : {}),
          ...(body.receivedAt !== undefined ? { receivedAt: after.receivedAt } : {}),
          ...(body.styleId !== undefined ? { styleId: body.styleId } : {}),
          ...(body.batchNumbers !== undefined ? { batchNumbers: after.batchNumbers } : {}),
          ...(body.request !== undefined ? { request: body.request.trim() } : {}),
          ...(body.dueOn !== undefined ? { dueOn: dateOfDay(body.dueOn) } : {}),
          ...(body.note !== undefined ? { note: textOrNull(body.note) } : {}),
          updatedAt: now,
        }
        const row = await tx.authorityRequest.update({ where: { id: requestId }, data, select: EMIT_SELECT })
        audit({
          recordType: 'AuthorityRequest',
          recordId: requestId,
          companyId: before.companyId,
          before: { authorityName: before.authorityName, marketCode: before.marketCode, authorityReference: before.authorityReference, channel: before.channel, receivedAt: toUtcIso(before.receivedAt), styleId: before.styleId, batchNumbers: [...before.batchNumbers], dueOn: dayOf(before.dueOn), note: before.note },
          after: { ...Object.fromEntries(Object.entries(body).filter(([field]) => field !== 'version')), dueOn: after.dueOn },
        })
        emitRequest(tools, row, 'EDITED')
        return {}
      },
      settings(),
    ),
  )
  return requestAnswer(caller, requestId)
}

// ---- the register entry ----------------------------------------------------------------------------------------------------

/** An entry the caller sees, of the request's company and (when it names one) its style. */
async function checkEntry(db: Reader, context: OfficeContext, companyId: string, styleId: string | null, entryId: string): Promise<void> {
  const entry = await readEntry(db, entryId)
  if (!entry || !can(actorOf(context), REGISTER_VIEW, { companyId: entry.companyId, partyId: entry.partyId })) {
    throw new ValidationError('The register entry is not found.', [{ path: 'body/registerEntryId', message: 'Not a register entry you can see.' }])
  }
  if (entry.companyId !== companyId) throw new ValidationError('The register entry is of another company.', [{ path: 'body/registerEntryId', message: "Choose an entry of the request's company." }])
  if (styleId !== null && entry.styleId !== styleId) throw new ValidationError('The register entry is about another style.', [{ path: 'body/registerEntryId', message: 'Choose an entry about the style the request is about.' }])
}

/**
 * POST /compliance/authority-requests/:requestId/register-entry: the entry it is about, set once — one named, or a new
 * AUTHORITY_REQUEST entry opened from it (W1's hook: numbered from the PPE_REGISTER series, source AuthorityRequest, its
 * description the request's words, risk being assessed). Opening one needs compliance.register.manage too.
 */
export async function linkRequestEntry(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly registerEntryId?: string | undefined }, key: string | null | undefined): Promise<{ request: RequestView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRequest(db, context, requestId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId }, "Naming an authority request's register entry")
  if (before.status !== 'OPEN') throw new ConflictError(`Request ${before.number} is ${before.status}: it stays as it ended.`)
  if (before.registerEntryId !== null) throw new ConflictError(`Request ${before.number} names register entry ${before.registerEntry?.reference ?? ''} already (set once).`)
  if (body.registerEntryId) await caller.withClient((db) => checkEntry(db, context, before.companyId, before.styleId, body.registerEntryId!))
  else {
    if (before.styleId === null) throw new ConflictError(`Name the style request ${before.number} is about first: a register entry is about one style.`)
    if (!can(actorOf(context), REGISTER_MANAGE, { companyId: before.companyId })) throw new ForbiddenError(`Opening a register entry needs ${REGISTER_MANAGE} over this company.`)
  }
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.requestEntry', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'AuthorityRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        let entryId = body.registerEntryId ?? null
        if (entryId === null) {
          const opened = await openRegisterEntryFor(tools, {
            companyId: before.companyId,
            kind: 'AUTHORITY_REQUEST',
            styleId: before.styleId!,
            batchNumbers: [...before.batchNumbers],
            description: `${before.authorityName} (${before.marketCode}${before.authorityReference ? `, ${before.authorityReference}` : ''}) asks: ${before.request}`.slice(0, 4000),
            reportedAt: before.receivedAt,
            source: { type: 'AuthorityRequest', id: requestId },
          })
          entryId = opened.entryId
        }
        const row = await tx.authorityRequest.update({ where: { id: requestId }, data: { registerEntryId: entryId, updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'AuthorityRequest', recordId: requestId, companyId: before.companyId, before: { registerEntryId: null }, after: { registerEntryId: entryId, opened: body.registerEntryId === undefined } })
        emitRequest(tools, row, 'ENTRY_LINKED')
        return {}
      },
      settings(),
    ),
  )
  return requestAnswer(caller, requestId)
}

// ---- the evidence ------------------------------------------------------------------------------------------------------------

async function checkPack(db: Reader, companyId: string, packId: string): Promise<void> {
  const pack = await db.evidencePack.findUnique({ where: { id: packId }, select: { companyId: true } })
  if (!pack || pack.companyId !== companyId) throw new ValidationError('The evidence pack is not one of this company.', [{ path: 'body/packId', message: "Choose an evidence pack of the request's company (Technical files › Evidence pack)." }])
}

/**
 * POST /compliance/authority-requests/:requestId/evidence: the evidence pack the answer sends — one built already (packId), or
 * one asked now from the style's live technical file (purpose AUTHORITY, the request's batches, else the whole style; the
 * worker builds it). Asking one needs compliance.techfiles.manage too (the technical file's own route checks it).
 */
export async function requestEvidence(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly packId?: string | undefined; readonly language?: string | undefined; readonly note?: string | undefined }, key: string | null | undefined): Promise<{ request: RequestView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRequest(db, context, requestId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId }, "Naming an authority request's evidence")
  if (before.status !== 'OPEN') throw new ConflictError(`Request ${before.number} is ${before.status}: it stays as it ended.`)
  let packId = body.packId ?? null
  if (packId) await caller.withClient((db) => checkPack(db, before.companyId, packId!))
  else {
    if (before.styleId === null) throw new ConflictError(`Name the style request ${before.number} is about first: an evidence pack is built from its technical file.`)
    const file = await caller.withClient((db) => db.technicalFile.findFirst({ where: { styleId: before.styleId!, companyId: before.companyId, status: { not: 'ARCHIVED' } }, select: { id: true }, orderBy: [{ createdAt: 'desc' }] }))
    if (!file) throw new ConflictError(`Style ${before.style?.code ?? ''} has no live technical file: open it in Technical files first, then build the pack.`)
    const language = body.language ?? (await caller.withClient((db) => db.marketProfile.findFirst({ where: { code: before.marketCode }, select: { docLanguages: true } })))?.docLanguages[0] ?? 'en'
    const { pack } = await requestPack(
      caller,
      file.id,
      {
        purpose: 'AUTHORITY',
        language,
        recipient: before.authorityName,
        scope: before.batchNumbers.length > 0 ? { kind: 'BATCHES', batchNumbers: [...before.batchNumbers] } : { kind: 'STYLE' },
        note: (body.note ?? `For authority request ${before.number}${before.authorityReference ? ` (${before.authorityReference})` : ''}.`).slice(0, 1000),
      },
      key ? `${key}:pack` : null,
    )
    packId = pack.id
  }
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.requestEvidence', idempotencyKey: key, input: { requestId, ...body, packId }, record: { type: 'AuthorityRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const row = await tx.authorityRequest.update({ where: { id: requestId }, data: { evidenceType: 'EvidencePack', evidenceId: packId, updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'AuthorityRequest', recordId: requestId, companyId: before.companyId, before: { evidenceType: before.evidenceType, evidenceId: before.evidenceId }, after: { evidenceType: 'EvidencePack', evidenceId: packId, built: body.packId === undefined } })
        emitRequest(tools, row, 'EVIDENCE')
        return {}
      },
      settings(),
    ),
  )
  return requestAnswer(caller, requestId)
}

// ---- answer and cancel --------------------------------------------------------------------------------------------------------

/** POST /compliance/authority-requests/:requestId/answer: when and what was sent, by the person (with the pack when named). */
export async function answerRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly answeredAt?: string | undefined; readonly answerSummary: string; readonly packId?: string | undefined }, key: string | null | undefined): Promise<{ request: RequestView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRequest(db, context, requestId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId }, 'Answering an authority request')
  if (before.status !== 'OPEN') throw new ConflictError(`Request ${before.number} is ${before.status} already.`)
  if (body.packId) await caller.withClient((db) => checkPack(db, before.companyId, body.packId!))
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.answerRequest', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'AuthorityRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const answeredAt = body.answeredAt ? new Date(body.answeredAt) : now
        const problems = metOnProblems(answeredAt, before.receivedAt, now, 'body/answeredAt')
        if (problems.length > 0) throw new ValidationError('The date is not valid.', problems)
        if (answeredAt.getTime() < before.receivedAt.getTime()) throw new ValidationError('The date is not valid.', [{ path: 'body/answeredAt', message: 'The answer is after the request came.' }])
        const summary = body.answerSummary.trim()
        const row = await tx.authorityRequest.update({
          where: { id: requestId },
          data: { status: 'ANSWERED', answeredAt, answeredById: context.actorId, answerSummary: summary, ...(body.packId ? { evidenceType: 'EvidencePack', evidenceId: body.packId } : {}), updatedAt: now },
          select: EMIT_SELECT,
        })
        audit({ recordType: 'AuthorityRequest', recordId: requestId, companyId: before.companyId, before: { status: 'OPEN' }, after: { status: 'ANSWERED', answeredAt: toUtcIso(answeredAt), answeredById: context.actorId, evidenceId: body.packId ?? before.evidenceId } })
        emitRequest(tools, row, 'ANSWERED')
        return {}
      },
      settings(),
    ),
  )
  return requestAnswer(caller, requestId)
}

/** POST /compliance/authority-requests/:requestId/cancel: logged twice, or withdrawn by the authority; with why. */
export async function cancelRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly reason: string }, key: string | null | undefined): Promise<{ request: RequestView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRequest(db, context, requestId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId }, 'Cancelling an authority request')
  if (before.status !== 'OPEN') throw new ConflictError(`Request ${before.number} is ${before.status} already.`)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.cancelRequest', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'AuthorityRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const reason = body.reason.trim()
        const row = await tx.authorityRequest.update({ where: { id: requestId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'AuthorityRequest', recordId: requestId, companyId: before.companyId, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason })
        emitRequest(tools, row, 'CANCELLED')
        return {}
      },
      settings(),
    ),
  )
  return requestAnswer(caller, requestId)
}
