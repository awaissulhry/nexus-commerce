import type { FactoryClient } from '@nexus/factory-db'
import { REGISTER_MANAGE, REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import {
  cleanList,
  closeProblems,
  completeActionProblems,
  dutiesOf,
  dutyDateProblems,
  editProblems,
  entryProblems,
  registerEntryMachine,
  type RegisterKind,
  type RegisterProblem,
  type RegisterRisk,
  type RegisterStatus,
} from '@nexus/factory-domain/compliance/register/rules'
import { leftShipmentNumbers, type TraceView } from '@nexus/factory-domain/compliance/register/trace'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { cleanBody, uniqueIds } from '@nexus/factory-domain/threads/rules'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { ensureThread, mentionProblems, writeMessage } from '../../../platform/threads/threads'
import type { EntryDetail, EntryView } from './contract'
import { insertEntry, lockEntry, nextReference, readEntries, readEntry, updateEntry, type EntryChanges, type EntryRecord } from './store'
import { traceOf, type TraceConcern } from './trace'

/**
 * The PPE register, office side (B-W1-43; QHS-118; A2 compliance.register, SCR-113): list and read the entries (each
 * with its trace to the shipments and customers that got the garments, its duties and what still stops it from
 * closing), record one, edit it while OPEN (the risk assessment among it), mark the corrective action done, record that
 * the distributors were informed and that the authority was told, close it, and write notes on its thread. Every write
 * is ONE command() that locks the entry's row first (store.ts lockEntry: FOR UPDATE + the version the caller read), then
 * checks the domain's rules in words (409 with `problem/<CODE>` issues) before the …_quality_shipping_guards trigger
 * would refuse it; audit rows and events in the same transaction. The storage is store.ts (the one seam).
 *
 * Scope: an entry belongs to its company and to the party that reported it (none: every party); each one is checked with
 * can(), lists are filtered with scopeWhere(). An entry the caller may not view is not found. Office only.
 */

export const ENTRY_SCOPE: ScopeColumns = { company: 'companyId', party: { field: 'partyId', nullable: true } }
const scopeOf = (row: { companyId: string; partyId: string | null }) => ({ companyId: row.companyId, partyId: row.partyId })

let clock: Clock = serverClock
/** Test only: the clock of the register's commands (default the server clock). */
export function useRegisterClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const registerClock = (): Clock => clock

/** command() on the register's clock. */
export function registerCommand<Result>(caller: CommandCaller, spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>) {
  return runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock })
}

/** A refusal in plain words: 409, each problem an issue `problem/<CODE>`. */
export class RegisterRefusedError extends InvalidStateError {
  override name = 'RegisterRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    message: string,
    readonly problems: readonly RegisterProblem[],
  ) {
    super(`${message} ${problems.map((problem) => problem.message).join(' ')}`)
    this.issues = problems.map((problem) => ({ path: `problem/${problem.code}`, message: problem.message }))
  }
}

function officeOf(caller: CommandCaller): RequestContext & { audience: 'office' } {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

function mayManage(caller: CommandCaller, row: { companyId: string; partyId: string | null }): void {
  if (!can(actorOf(officeOf(caller)), REGISTER_MANAGE, scopeOf(row))) throw new ForbiddenError()
}

/** An entry the caller may view, or not found. */
async function visibleEntry(caller: CommandCaller, entryId: string): Promise<EntryRecord> {
  const context = officeOf(caller)
  if (!isUuid(entryId)) throw new NotFoundError('Register entry not found.')
  const record = await caller.withClient((client) => readEntry(client, entryId))
  if (!record || !can(actorOf(context), REGISTER_VIEW, scopeOf(record))) throw new NotFoundError('Register entry not found.')
  return record
}

// ---- views ---------------------------------------------------------------------------------------------------------------

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

async function namesOf(client: FactoryClient | CommandTx, records: readonly EntryRecord[]) {
  const styleIds = [...new Set(records.map((record) => record.styleId))]
  const partyIds = [...new Set(records.map((record) => record.partyId).filter((id): id is string => id !== null))]
  const styles = styleIds.length ? await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []
  const parties = partyIds.length ? await client.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true } }) : []
  return {
    style: new Map(styles.map((style) => [style.id, style])),
    party: new Map(parties.map((party) => [party.id, { id: party.id, code: party.code, name: party.legalName }])),
  }
}

function viewOf(record: EntryRecord, names: Awaited<ReturnType<typeof namesOf>>): EntryView {
  return {
    id: record.id,
    companyId: record.companyId,
    reference: record.reference,
    kind: record.kind,
    status: record.status,
    styleId: record.styleId,
    style: names.style.get(record.styleId) ?? { id: record.styleId, code: '', name: '' },
    styleRevisionId: record.styleRevisionId,
    batchNumbers: [...record.batchNumbers],
    serials: [...record.serials],
    lotIds: [...record.lotIds],
    workOrderIds: [...record.workOrderIds],
    shipmentIds: [...record.shipmentIds],
    partyId: record.partyId,
    party: record.partyId ? (names.party.get(record.partyId) ?? null) : null,
    ownerId: record.ownerId,
    source: record.sourceType && record.sourceId ? { type: record.sourceType, id: record.sourceId } : null,
    reportedAt: toUtcIso(record.reportedAt),
    description: record.description,
    investigation: record.investigation,
    risk: record.risk,
    actionTaken: record.actionTaken,
    actionCompletedAt: iso(record.actionCompletedAt),
    distributorsInformedAt: iso(record.distributorsInformedAt),
    authorityNotifiedAt: iso(record.authorityNotifiedAt),
    authorityReference: record.authorityReference,
    closedAt: iso(record.closedAt),
    closedById: record.closedById,
    closeReason: record.closeReason,
    version: record.version,
    createdAt: toUtcIso(record.createdAt),
    updatedAt: toUtcIso(record.updatedAt),
  }
}

/** What still stops an open entry from closing, beyond the reason the close asks. */
function toCloseOf(record: EntryRecord, trace: TraceView): RegisterProblem[] {
  if (record.status !== 'OPEN') return []
  return closeProblems({ entry: record, reason: null, shippedGoods: trace.shippedGoods, shipmentNumbers: leftShipmentNumbers(trace) }).filter((problem) => problem.code !== 'NO_REASON')
}

/** The entry as its record page shows it: the view, the trace, the duties and what still stops it from closing. */
export async function entryDetail(client: FactoryClient | CommandTx, entryId: string): Promise<EntryDetail> {
  const record = await readEntry(client, entryId)
  if (!record) throw new NotFoundError('Register entry not found.')
  const trace = await traceOf(client, record.companyId, record)
  return { ...viewOf(record, await namesOf(client, [record])), trace, duties: dutiesOf(record, trace.shippedGoods), toClose: toCloseOf(record, trace) }
}

// ---- reads ---------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly kind?: RegisterKind | undefined
  readonly status?: RegisterStatus | undefined
  readonly risk?: RegisterRisk | undefined
  readonly styleId?: string | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly q?: string | undefined
  readonly limit: number
}

/** SCR-113's register: the entries the caller may view, newest report first; the period is business days (Europe/Rome). */
export async function listEntries(caller: CommandCaller, query: ListQuery): Promise<{ entries: EntryView[] }> {
  const context = officeOf(caller)
  if (query.from && query.to && query.from > query.to) throw new ValidationError('The period is not valid.', [{ path: 'querystring/to', message: 'The period ends before it starts.' }])
  return caller.withClient(async (client) => {
    const records = await readEntries(client, {
      scope: scopeWhere(actorOf(context), REGISTER_VIEW, ENTRY_SCOPE),
      companyId: query.companyId,
      kind: query.kind,
      status: query.status,
      risk: query.risk,
      styleId: query.styleId,
      from: query.from ? businessDayStart(query.from) : undefined,
      to: query.to ? businessDayRange(query.to).end : undefined,
      search: query.q,
      limit: query.limit,
    })
    const names = await namesOf(client, records)
    return { entries: records.map((record) => viewOf(record, names)) }
  })
}

export async function getEntry(caller: CommandCaller, entryId: string): Promise<EntryDetail> {
  await visibleEntry(caller, entryId)
  return caller.withClient((client) => entryDetail(client, entryId))
}

interface ConcernInput {
  readonly styleId: string
  readonly styleRevisionId?: string | null | undefined
  readonly batchNumbers?: readonly string[] | undefined
  readonly serials?: readonly string[] | undefined
  readonly lotIds?: readonly string[] | undefined
  readonly workOrderIds?: readonly string[] | undefined
  readonly shipmentIds?: readonly string[] | undefined
}

const concernOf = (input: ConcernInput): TraceConcern & { styleRevisionId: string | null } => ({
  styleId: input.styleId,
  styleRevisionId: input.styleRevisionId ?? null,
  batchNumbers: cleanList(input.batchNumbers),
  serials: cleanList(input.serials),
  lotIds: uniqueIds(input.lotIds),
  workOrderIds: uniqueIds(input.workOrderIds),
  shipmentIds: uniqueIds(input.shipmentIds),
})

/** The New entry modal's preview: where the garments a concern names went, before anything is recorded. */
export async function previewTrace(caller: CommandCaller, body: ConcernInput & { readonly companyId: string }): Promise<{ trace: TraceView }> {
  const context = officeOf(caller)
  if (!can(actorOf(context), REGISTER_VIEW, { companyId: body.companyId })) throw new ForbiddenError()
  const concern = concernOf(body)
  await caller.withClient((client) => checkConcern(client, body.companyId, concern, 'body'))
  return { trace: await caller.withClient((client) => traceOf(client, body.companyId, concern)) }
}

// ---- references (checked before the command, in the caller's scope) -------------------------------------------------------

/**
 * The company, style (the company's or tenant-wide), style revision (of that style), lots, work orders and shipments
 * (the company's; work orders of the style) exist. Batch numbers and serials are kept as reported: what the trace cannot
 * follow is listed in its problems, never refused.
 */
async function checkConcern(client: FactoryClient | CommandTx, companyId: string, concern: TraceConcern & { styleRevisionId: string | null }, at: string): Promise<void> {
  const problems: Issue[] = []
  if (!(await client.company.findUnique({ where: { id: companyId }, select: { id: true } }))) {
    throw new ValidationError('The register entry is not valid.', [{ path: `${at}/companyId`, message: 'Not a company of the tenant.' }])
  }
  const style = await client.style.findUnique({ where: { id: concern.styleId }, select: { companyId: true } })
  if (!style || (style.companyId !== null && style.companyId !== companyId)) problems.push({ path: `${at}/styleId`, message: 'Not a style of this company.' })
  if (concern.styleRevisionId && !(await client.styleRevision.findFirst({ where: { id: concern.styleRevisionId, styleId: concern.styleId }, select: { id: true } }))) {
    problems.push({ path: `${at}/styleRevisionId`, message: 'Not a revision of this style.' })
  }
  if (concern.lotIds.length) {
    const found = new Set((await client.lot.findMany({ where: { id: { in: [...concern.lotIds] }, companyId }, select: { id: true } })).map((lot) => lot.id))
    concern.lotIds.forEach((lotId, index) => found.has(lotId) || problems.push({ path: `${at}/lotIds/${index}`, message: 'Not a material lot of this company.' }))
  }
  if (concern.workOrderIds.length) {
    const found = new Set((await client.workOrder.findMany({ where: { id: { in: [...concern.workOrderIds] }, companyId, styleId: concern.styleId }, select: { id: true } })).map((row) => row.id))
    concern.workOrderIds.forEach((workOrderId, index) => found.has(workOrderId) || problems.push({ path: `${at}/workOrderIds/${index}`, message: "Not a work order of this company and this entry's style." }))
  }
  if (concern.shipmentIds.length) {
    const found = new Set((await client.shipment.findMany({ where: { id: { in: [...concern.shipmentIds] }, companyId }, select: { id: true } })).map((row) => row.id))
    concern.shipmentIds.forEach((shipmentId, index) => found.has(shipmentId) || problems.push({ path: `${at}/shipmentIds/${index}`, message: 'Not a shipment of this company.' }))
  }
  if (problems.length > 0) throw new ValidationError('The register entry is not valid.', problems)
}

async function checkPeople(client: FactoryClient | CommandTx, partyId: string | null, ownerId: string | null): Promise<void> {
  const problems: Issue[] = []
  if (partyId && !(await client.party.findUnique({ where: { id: partyId }, select: { id: true } }))) problems.push({ path: 'body/partyId', message: 'Not a party of the tenant.' })
  if (ownerId && !(await client.user.findFirst({ where: { id: ownerId, status: 'ACTIVE' }, select: { id: true } }))) problems.push({ path: 'body/ownerId', message: 'Not an active person of the tenant.' })
  if (problems.length > 0) throw new ValidationError('The register entry is not valid.', problems)
}

const textOrNull = (value: string | null | undefined): string | null => (value === null || value === undefined ? null : value.trim() || null)

// ---- create ----------------------------------------------------------------------------------------------------------------

export interface CreateInput extends ConcernInput {
  readonly companyId: string
  readonly kind: RegisterKind
  readonly partyId?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly reportedAt?: string | undefined
  readonly description: string
  readonly investigation?: string | null | undefined
  readonly risk?: RegisterRisk | undefined
  readonly actionTaken?: string | null | undefined
}

/** compliance.register.create: an OPEN entry with the company's next reference; the event says whether goods left. */
export async function createEntry(caller: CommandCaller, input: CreateInput, idempotencyKey?: string): Promise<EntryDetail> {
  const context = officeOf(caller)
  const now = clock.now()
  const concern = concernOf(input)
  const entry = {
    kind: input.kind,
    reportedAt: input.reportedAt ? new Date(input.reportedAt) : now,
    description: input.description.trim(),
    investigation: textOrNull(input.investigation),
    actionTaken: textOrNull(input.actionTaken),
    ...concern,
  }
  const problems = entryProblems(entry, now)
  if (problems.length > 0) throw new ValidationError('The register entry is not valid.', problems)
  const partyId = input.partyId ?? null
  const ownerId = input.ownerId ?? null
  mayManage(caller, { companyId: input.companyId, partyId })
  await caller.withClient(async (client) => {
    await checkConcern(client, input.companyId, concern, 'body')
    await checkPeople(client, partyId, ownerId)
  })
  const { result } = await registerCommand(caller, { name: 'compliance.register.create', idempotencyKey, input }, async (tools) => {
    const reference = await nextReference(tools, input.companyId, entry.reportedAt)
    const record = await insertEntry(tools, {
      id: newId(),
      companyId: input.companyId,
      reference,
      ...entry,
      partyId,
      ownerId,
      risk: input.risk ?? 'ASSESSING',
      createdById: context.actorId,
    })
    const trace = await traceOf(tools.tx, record.companyId, record)
    opened(tools, record, trace.shippedGoods)
    return { entryId: record.id }
  })
  return caller.withClient((client) => entryDetail(client, result.entryId))
}

/** The `compliance.register_entry_opened` event of a new entry. */
export function opened(tools: Pick<CommandTools, 'emit'>, record: EntryRecord, shippedGoods: boolean): void {
  tools.emit({
    type: 'compliance.register_entry_opened',
    subject: record.id,
    companyId: record.companyId,
    payload: { ...about(record), sourceType: record.sourceType, sourceId: record.sourceId, shippedGoods },
  })
}

const about = (record: EntryRecord) => ({ entryId: record.id, reference: record.reference, kind: record.kind, styleId: record.styleId, risk: record.risk })

function changed(tools: Pick<CommandTools, 'emit'>, before: EntryRecord, after: EntryRecord, change: 'EDITED' | 'ACTION_COMPLETED' | 'DISTRIBUTORS_INFORMED' | 'AUTHORITY_NOTIFIED'): void {
  tools.emit({ type: 'compliance.register_entry_changed', subject: after.id, companyId: after.companyId, payload: { ...about(after), change, previousRisk: before.risk } })
}

/** The entry's row, locked, still OPEN. */
async function lockOpen(tx: CommandTx, entryId: string, version: number): Promise<EntryRecord> {
  const locked = await lockEntry(tx, entryId, version)
  if (locked.status !== 'OPEN') throw new RegisterRefusedError(`Register entry ${locked.reference} is closed.`, [{ code: 'CLOSED', message: 'A closed register entry never changes; add a note to its thread instead.' }])
  return locked
}

// ---- edit -------------------------------------------------------------------------------------------------------------------

export interface UpdateInput extends Partial<ConcernInput> {
  readonly version: number
  readonly partyId?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly description?: string | undefined
  readonly investigation?: string | null | undefined
  readonly risk?: RegisterRisk | undefined
  readonly actionTaken?: string | null | undefined
}

/** compliance.register.update: edits an OPEN entry (a field left out keeps its value; null clears an optional one). */
export async function editEntry(caller: CommandCaller, entryId: string, input: UpdateInput, idempotencyKey?: string): Promise<EntryDetail> {
  const before = await visibleEntry(caller, entryId)
  mayManage(caller, before)
  const changes: EntryChanges = {
    ...(input.styleId !== undefined ? { styleId: input.styleId } : {}),
    ...(input.styleRevisionId !== undefined ? { styleRevisionId: input.styleRevisionId } : {}),
    ...(input.batchNumbers !== undefined ? { batchNumbers: cleanList(input.batchNumbers) } : {}),
    ...(input.serials !== undefined ? { serials: cleanList(input.serials) } : {}),
    ...(input.lotIds !== undefined ? { lotIds: uniqueIds(input.lotIds) } : {}),
    ...(input.workOrderIds !== undefined ? { workOrderIds: uniqueIds(input.workOrderIds) } : {}),
    ...(input.shipmentIds !== undefined ? { shipmentIds: uniqueIds(input.shipmentIds) } : {}),
    ...(input.partyId !== undefined ? { partyId: input.partyId } : {}),
    ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    ...(input.investigation !== undefined ? { investigation: textOrNull(input.investigation) } : {}),
    ...(input.risk !== undefined ? { risk: input.risk } : {}),
    ...(input.actionTaken !== undefined ? { actionTaken: textOrNull(input.actionTaken) } : {}),
  }
  const merged: EntryRecord = { ...before, ...changes }
  // A new reporting party needs manage over it too.
  mayManage(caller, merged)
  await caller.withClient(async (client) => {
    await checkConcern(client, merged.companyId, merged, 'body')
    await checkPeople(client, input.partyId ?? null, input.ownerId ?? null)
  })
  await registerCommand(caller, { name: 'compliance.register.update', idempotencyKey, input: { entryId, ...input } }, async (tools) => {
    const locked = await lockOpen(tools.tx, entryId, input.version)
    const after: EntryRecord = { ...locked, ...changes }
    const refused = editProblems(locked, after)
    if (refused.length > 0) throw new RegisterRefusedError(`Register entry ${locked.reference} cannot change like this.`, refused)
    const problems = entryProblems(after, tools.now)
    if (problems.length > 0) throw new ValidationError('The register entry is not valid.', problems)
    const written = await updateEntry(tools, locked, changes)
    changed(tools, locked, written, 'EDITED')
    return { entryId }
  })
  return caller.withClient((client) => entryDetail(client, entryId))
}

// ---- duties -----------------------------------------------------------------------------------------------------------------

const instantOr = (value: string | undefined, now: Date): Date => (value ? new Date(value) : now)
const dateLine = (at: Date): string => `${businessDate(at)} (${toUtcIso(at)})`

/** An internal note on the entry's thread (made with its first note), written by the command's office user. */
async function threadNote(tools: CommandTools, record: EntryRecord, body: string, mentions: readonly string[] = []): Promise<{ messageId: string; threadId: string }> {
  const { thread } = await ensureThread(tools, { type: 'PpeRegisterEntry', id: record.id }, tools.context.audience === 'office' ? tools.context.actorId : null)
  if (thread.status !== 'OPEN') throw new InvalidStateError("This entry's thread is closed; reopen it to write a note.")
  const issues = await mentionProblems(tools.tx, tools.context, thread, mentions, tools.now)
  if (issues.length > 0) throw new ValidationError('The note is not valid.', issues)
  const authorId = tools.context.audience === 'office' ? tools.context.actorId : null
  const author = authorId ? await tools.tx.user.findUnique({ where: { id: authorId }, select: { displayName: true } }) : null
  const message = await writeMessage(tools, thread, {
    direction: 'INTERNAL_NOTE',
    channel: 'APP',
    author: authorId ? { kind: 'USER', id: authorId, name: author?.displayName ?? null } : { kind: 'SYSTEM', id: null, name: null },
    bodyText: cleanBody(body),
    mentions,
  })
  return { messageId: message.id, threadId: thread.id }
}

/** compliance.register.completeAction: the corrective action (art. 8(8)) is done; its text may be given with it. */
export async function completeAction(caller: CommandCaller, entryId: string, input: { readonly version: number; readonly actionTaken?: string | undefined; readonly completedAt?: string | undefined }, idempotencyKey?: string): Promise<EntryDetail> {
  const before = await visibleEntry(caller, entryId)
  mayManage(caller, before)
  await registerCommand(caller, { name: 'compliance.register.completeAction', idempotencyKey, input: { entryId, ...input } }, async (tools) => {
    const locked = await lockOpen(tools.tx, entryId, input.version)
    const actionTaken = input.actionTaken !== undefined && locked.actionCompletedAt === null ? textOrNull(input.actionTaken) : locked.actionTaken
    const refused = completeActionProblems({ ...locked, actionTaken })
    if (refused.length > 0) throw new RegisterRefusedError(`Register entry ${locked.reference}:`, refused)
    const completedAt = instantOr(input.completedAt, tools.now)
    const problems = dutyDateProblems(completedAt, locked.reportedAt, tools.now, 'body/completedAt')
    if (problems.length > 0) throw new ValidationError('The date is not valid.', problems)
    const written = await updateEntry(tools, locked, { actionTaken, actionCompletedAt: completedAt })
    changed(tools, locked, written, 'ACTION_COMPLETED')
    return { entryId }
  })
  return caller.withClient((client) => entryDetail(client, entryId))
}

/**
 * compliance.register.informDistributors: the distributors were kept informed (art. 8(4)) on that day; how and whom is
 * a note on the entry's thread (the "distributor information log"). Informing them again moves the date; every round
 * stays on the thread.
 */
export async function informDistributors(caller: CommandCaller, entryId: string, input: { readonly version: number; readonly informedAt?: string | undefined; readonly note: string }, idempotencyKey?: string): Promise<EntryDetail> {
  const before = await visibleEntry(caller, entryId)
  mayManage(caller, before)
  await registerCommand(caller, { name: 'compliance.register.informDistributors', idempotencyKey, input: { entryId, ...input } }, async (tools) => {
    const locked = await lockOpen(tools.tx, entryId, input.version)
    const informedAt = instantOr(input.informedAt, tools.now)
    const problems = dutyDateProblems(informedAt, locked.reportedAt, tools.now, 'body/informedAt')
    if (problems.length > 0) throw new ValidationError('The date is not valid.', problems)
    const written = await updateEntry(tools, locked, { distributorsInformedAt: informedAt })
    await threadNote(tools, written, `Distributors informed on ${dateLine(informedAt)}.\n${input.note}`)
    changed(tools, locked, written, 'DISTRIBUTORS_INFORMED')
    return { entryId }
  })
  return caller.withClient((client) => entryDetail(client, entryId))
}

/**
 * compliance.register.notifyAuthority: the market surveillance authorities were told (art. 8(8): where the PPE presents
 * a risk), on that day, with their reference; which authority and what was sent is a note on the entry's thread.
 * Nothing is sent from here.
 */
export async function notifyAuthority(caller: CommandCaller, entryId: string, input: { readonly version: number; readonly notifiedAt?: string | undefined; readonly reference: string; readonly note: string }, idempotencyKey?: string): Promise<EntryDetail> {
  const before = await visibleEntry(caller, entryId)
  mayManage(caller, before)
  await registerCommand(caller, { name: 'compliance.register.notifyAuthority', idempotencyKey, input: { entryId, ...input } }, async (tools) => {
    const locked = await lockOpen(tools.tx, entryId, input.version)
    const notifiedAt = instantOr(input.notifiedAt, tools.now)
    const problems = dutyDateProblems(notifiedAt, locked.reportedAt, tools.now, 'body/notifiedAt')
    if (problems.length > 0) throw new ValidationError('The date is not valid.', problems)
    const reference = input.reference.trim()
    const written = await updateEntry(tools, locked, { authorityNotifiedAt: notifiedAt, authorityReference: reference })
    await threadNote(tools, written, `Authority notified on ${dateLine(notifiedAt)}, reference ${reference}.\n${input.note}`)
    changed(tools, locked, written, 'AUTHORITY_NOTIFIED')
    return { entryId }
  })
  return caller.withClient((client) => entryDetail(client, entryId))
}

/**
 * compliance.register.close: OPEN → CLOSED with a reason, when closeProblems finds nothing missing — the trace is read
 * again under the row's lock, so goods that left since the page was read are seen. 409 lists every problem.
 */
export async function closeEntry(caller: CommandCaller, entryId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<EntryDetail> {
  const before = await visibleEntry(caller, entryId)
  mayManage(caller, before)
  const context = officeOf(caller)
  await registerCommand(caller, { name: 'compliance.register.close', idempotencyKey, input: { entryId, ...input } }, async (tools) => {
    const locked = await lockOpen(tools.tx, entryId, input.version)
    const trace = await traceOf(tools.tx, locked.companyId, locked)
    const reason = input.reason.trim() || null
    const facts = { entry: locked, reason, shippedGoods: trace.shippedGoods, shipmentNumbers: leftShipmentNumbers(trace) }
    const problems = closeProblems(facts)
    if (problems.length > 0) throw new RegisterRefusedError(`Register entry ${locked.reference} cannot close yet.`, problems)
    assertTransition(registerEntryMachine, locked.status, 'CLOSED', facts)
    const written = await updateEntry(tools, locked, { status: 'CLOSED', closedAt: tools.now, closedById: context.actorId, closeReason: reason }, { ...(reason ? { reason } : {}) })
    tools.emit({ type: 'compliance.register_entry_closed', subject: written.id, companyId: written.companyId, payload: { ...about(written), shippedGoods: trace.shippedGoods } })
    return { entryId }
  })
  return caller.withClient((client) => entryDetail(client, entryId))
}

/**
 * compliance.register.note: an internal note on the entry's thread (an action taken, a call with a distributor, a
 * correction of a closed entry: "a correction is a note with who and when"). Also on a CLOSED entry; the entry's row does
 * not change.
 */
export async function addNote(caller: CommandCaller, entryId: string, input: { readonly body: string; readonly mentions?: readonly string[] | undefined }, idempotencyKey?: string): Promise<{ messageId: string; threadId: string }> {
  const record = await visibleEntry(caller, entryId)
  mayManage(caller, record)
  const { result } = await registerCommand(caller, { name: 'compliance.register.note', idempotencyKey, input: { entryId, ...input } }, (tools) => threadNote(tools, record, input.body, uniqueIds(input.mentions)))
  return result
}
