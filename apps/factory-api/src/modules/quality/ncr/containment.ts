import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { ContainmentChange } from '@nexus/factory-domain/quality/ncr/changes'
import { QUALITY_HOLDS_PLACE } from '@nexus/factory-domain/quality/holds/permissions'
import type { HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import { QUALITY_NCR_MANAGE } from '@nexus/factory-domain/quality/ncr/permissions'
import { containmentProblems, doneProblems, NCR_LIMITS, problemEditable, stageWords, type ContainmentKind, type NcrStage } from '@nexus/factory-domain/quality/ncr/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { placeHoldInCommand } from '../holds/holds'
import { answerOf, assertOpen, contextOf, lockNcrRow, may, refuse, visibleNcr } from './ncr'
import { ACTION_COLUMNS, type ActionRow, type NcrRow } from './store'

/**
 * Containment actions of an NCR (B-W2a-47; QHS-082; design ncr-cont: "action (Hold stock / Check WIP / Check goods
 * already shipped / Tell the customer / Other) · owner · due · done · evidence · link"; "'Hold stock' creates the hold
 * through the Place hold dialog; done needs evidence or a note"). quality.ncr.manage; the actions change while the NCR is
 * OPEN or CONTAINED (the guard's rule). Each write is one command: the NCR's row locked and its version bumped first,
 * then the action at the version the caller read.
 *
 *   add      a new action (OPEN), its owner and due time; HOLD_STOCK with a hold placed now (holds.ts placeHoldInCommand:
 *            quality.holds.place, the NCR its source) or a hold of the goods named: the action is done with it at once,
 *            and the NCR decides that hold (its NCR set once).
 *   change   the words, owner, due time of an OPEN action.
 *   done     with its evidence (a note, or a file of the action uploaded first: POST /files recordType
 *            "NcrContainmentAction"), the hold for HOLD_STOCK, or the record it made (a message).
 *   cancel   with the reason (B-W2b-17: NcrContainmentAction.cancelReason; before, "Cancelled: …" in its evidence note). An NCR is contained once every action is done or cancelled and one
 *            is done.
 */

type HoldInput = {
  readonly subjectType: HoldSubjectType
  readonly subjectIds: readonly string[]
  readonly reasonCode: string
  readonly reasonNote?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly expectedReleaseOn?: string | null | undefined
  readonly askQuarantine?: boolean | undefined
  readonly quarantineLocationId?: string | null | undefined
}

const scopeOf = (row: Pick<NcrRow, 'companyId' | 'siteId'>) => ({ companyId: row.companyId, siteId: row.siteId })

function assertContainable(row: Pick<NcrRow, 'stage'>): void {
  assertOpen(row)
  if (!problemEditable(row.stage as NcrStage)) throw new InvalidStateError(`The NCR is ${stageWords(row.stage as NcrStage)}: its containment actions change only while it is open or contained.`)
}

/** The hold of a HOLD_STOCK action: placed now from the NCR, or one of the goods named; the NCR decides it. */
async function holdFor(tools: CommandTools, ncr: NcrRow, input: { readonly hold?: HoldInput | undefined; readonly holdId?: string | undefined }): Promise<{ id: string; words: string } | null> {
  const { tx, now } = tools
  const context = contextOf(tools)
  if (!input.hold && !input.holdId) return null
  if (input.hold && input.holdId) refuse([{ path: 'holdId', message: 'Place a hold or name one, not both.' }], 'Place a hold or name one.')
  if (!may(context, QUALITY_HOLDS_PLACE, ncr)) throw new ForbiddenError('Holding stock needs quality.holds.place at the NCR\'s site.')
  if (input.hold) {
    const placed = await placeHoldInCommand(tools, { ...input.hold, sourceType: 'Nonconformance', sourceId: ncr.id })
    await tx.qualityHold.update({ where: { id: placed.hold.id }, data: { ncrId: ncr.id, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'quality.decideHoldInNcr', recordType: 'QualityHold', recordId: placed.hold.id, ...scopeOf(ncr), before: { ncrId: null }, after: { ncrId: ncr.id } })
    const what = placed.subjects.map((subject) => subject.label).filter(Boolean).join(', ')
    return { id: placed.hold.id, words: `Hold placed on ${what || `${placed.subjects.length} records`}${placed.workOrdersHeld.length > 0 ? `; ${placed.workOrdersHeld.map((entry) => entry.number).join(', ')} on hold` : ''}.` }
  }
  const hold = isUuid(input.holdId) ? await tx.qualityHold.findUnique({ where: { id: input.holdId! }, select: { id: true, siteId: true, status: true, ncrId: true, subjectType: true, subjectIds: true, reasonCode: true } }) : null
  if (!hold || hold.siteId !== ncr.siteId) refuse([{ path: 'holdId', message: "Not a hold of the NCR's site." }], 'The hold is not found.')
  if (hold!.status !== 'ACTIVE') refuse([{ path: 'holdId', message: `This hold is ${hold!.status.toLowerCase()}: name an active hold, or place one.` }], 'The hold is not active.')
  if (hold!.ncrId !== null && hold!.ncrId !== ncr.id) {
    const other = await tx.nonconformance.findUnique({ where: { id: hold!.ncrId }, select: { number: true } })
    throw new ConflictError(`This hold is decided in ${other?.number ?? 'another NCR'}.`)
  }
  if (hold!.ncrId === null) {
    await tx.qualityHold.update({ where: { id: hold!.id }, data: { ncrId: ncr.id, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'quality.decideHoldInNcr', recordType: 'QualityHold', recordId: hold!.id, ...scopeOf(ncr), before: { ncrId: null }, after: { ncrId: ncr.id } })
  }
  return { id: hold!.id, words: `The goods are on hold (${hold!.reasonCode.toLowerCase().replace(/_/g, ' ')}): ${hold!.subjectIds.length} ${hold!.subjectType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}${hold!.subjectIds.length === 1 ? '' : 's'}.` }
}

function emit(tools: CommandTools, ncr: NcrRow, action: Pick<ActionRow, 'id' | 'seq' | 'kind'>, change: ContainmentChange, holdId: string | null): void {
  tools.emit({ type: 'ncr.containment_changed', subject: ncr.id, ...scopeOf(ncr), payload: { ncrId: ncr.id, number: ncr.number, actionId: action.id, seq: action.seq, kind: action.kind as ContainmentKind, change, holdId } })
}

async function ownerProblem(tools: CommandTools, ownerId: string | null | undefined): Promise<void> {
  if (!ownerId) return
  const owner = isUuid(ownerId) ? await tools.tx.user.findUnique({ where: { id: ownerId }, select: { status: true } }) : null
  if (!owner || owner.status !== 'ACTIVE') refuse([{ path: 'ownerId', message: 'The owner is an active person of the office.' }], 'The owner is not an active person.')
}

// ---- add ----------------------------------------------------------------------------------------------------------------

export interface AddActionBody {
  readonly version: number
  readonly kind: ContainmentKind
  readonly description?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly dueAt?: string | null | undefined
  readonly hold?: HoldInput | undefined
  readonly holdId?: string | undefined
  readonly evidenceNote?: string | null | undefined
}

/** POST /quality/ncr/:ncrId/containment. */
export async function addAction(caller: CommandCaller, ncrId: string, body: AddActionBody, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertContainable(row)
  const problems = containmentProblems(body)
  if ((body.hold || body.holdId) && body.kind !== 'HOLD_STOCK') problems.push({ path: 'kind', message: 'A hold is placed by a HOLD_STOCK action.' })
  if (problems.length > 0) refuse(problems, 'The action is not valid.')
  const { result } = await command(caller, { name: 'quality.addNcrAction', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockNcrRow(tools, ncrId, body.version)
    assertContainable(ncr)
    const count = await tx.ncrContainmentAction.count({ where: { ncrId } })
    if (count >= NCR_LIMITS.actions) throw new ConflictError(`An NCR has at most ${NCR_LIMITS.actions} containment actions.`)
    await ownerProblem(tools, body.ownerId)
    const last = await tx.ncrContainmentAction.findFirst({ where: { ncrId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    const hold = await holdFor(tools, ncr, body)
    const id = newId()
    const created = await tx.ncrContainmentAction.create({
      data: {
        id,
        siteId: ncr.siteId,
        ncrId,
        seq: (last?.seq ?? 0) + 1,
        kind: body.kind,
        description: body.description?.trim() || null,
        ownerId: body.ownerId ?? null,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        status: hold ? 'DONE' : 'OPEN',
        doneAt: hold ? now : null,
        doneById: hold ? context.actorId : null,
        evidenceNote: hold ? body.evidenceNote?.trim() || hold.words : null,
        recordType: hold ? 'QualityHold' : null,
        recordId: hold?.id ?? null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: ACTION_COLUMNS,
    })
    tools.audit({ action: 'quality.addNcrAction', recordType: 'NcrContainmentAction', recordId: id, ...scopeOf(ncr), after: { ncrId, seq: created.seq, kind: created.kind, status: created.status, ownerId: created.ownerId, dueAt: created.dueAt, holdId: hold?.id ?? null } })
    emit(tools, ncr, created, hold ? 'DONE' : 'ADDED', hold?.id ?? null)
    return answerOf(tools, ncrId)
  })
  return result
}

/** The action of this NCR, OPEN, at the version the caller read (inside the command, after the NCR's lock). */
async function openAction(tools: CommandTools, ncrId: string, actionId: string, expectedVersion: number): Promise<ActionRow> {
  const action = isUuid(actionId) ? await tools.tx.ncrContainmentAction.findUnique({ where: { id: actionId }, select: ACTION_COLUMNS }) : null
  if (!action || action.ncrId !== ncrId) throw new NotFoundError('Containment action not found.')
  if (action.status !== 'OPEN') throw new InvalidStateError(`This action is ${action.status.toLowerCase()}: it never changes.`)
  if (action.version !== expectedVersion) throw new StaleVersionError('NcrContainmentAction', actionId, action.version, expectedVersion)
  return action
}

// ---- change -------------------------------------------------------------------------------------------------------------

/** PATCH /quality/ncr/:ncrId/containment/:actionId: words, owner, due time of an OPEN action. */
export async function editAction(caller: CommandCaller, ncrId: string, actionId: string, body: { readonly version: number; readonly description?: string | null | undefined; readonly ownerId?: string | null | undefined; readonly dueAt?: string | null | undefined }, idempotencyKey?: string) {
  const { row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertContainable(row)
  const { result } = await command(caller, { name: 'quality.editNcrAction', idempotencyKey, input: { ncrId, actionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockNcrRow(tools, ncrId)
    assertContainable(ncr)
    const action = await openAction(tools, ncrId, actionId, body.version)
    const description = body.description === undefined ? action.description : body.description?.trim() || null
    const problems = containmentProblems({ kind: action.kind as ContainmentKind, description })
    if (problems.length > 0) refuse(problems, 'The action is not valid.')
    await ownerProblem(tools, body.ownerId)
    const after = await tx.ncrContainmentAction.update({
      where: { id: actionId },
      data: { description, ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}), ...(body.dueAt !== undefined ? { dueAt: body.dueAt ? new Date(body.dueAt) : null } : {}), version: { increment: 1 }, updatedAt: now },
      select: ACTION_COLUMNS,
    })
    tools.audit({ action: 'quality.editNcrAction', recordType: 'NcrContainmentAction', recordId: actionId, ...scopeOf(ncr), before: { description: action.description, ownerId: action.ownerId, dueAt: action.dueAt }, after: { description: after.description, ownerId: after.ownerId, dueAt: after.dueAt } })
    emit(tools, ncr, after, 'CHANGED', null)
    return answerOf(tools, ncrId)
  })
  return result
}

// ---- done, cancel -------------------------------------------------------------------------------------------------------

export interface DoneActionBody {
  readonly version: number
  readonly evidenceNote?: string | null | undefined
  readonly hold?: HoldInput | undefined
  readonly holdId?: string | undefined
  readonly record?: { readonly type: string; readonly id: string } | undefined
}

/** POST /quality/ncr/:ncrId/containment/:actionId/done: with its evidence (and its hold, for HOLD_STOCK). */
export async function doneAction(caller: CommandCaller, ncrId: string, actionId: string, body: DoneActionBody, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertContainable(row)
  if (body.record && !/^[A-Z][A-Za-z0-9]{0,59}$/.test(body.record.type)) refuse([{ path: 'record/type', message: "The record's model name (QualityHold, ThreadEntry …)." }], 'The record is not valid.')
  const { result } = await command(caller, { name: 'quality.doneNcrAction', idempotencyKey, input: { ncrId, actionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockNcrRow(tools, ncrId)
    assertContainable(ncr)
    const action = await openAction(tools, ncrId, actionId, body.version)
    if ((body.hold || body.holdId) && action.kind !== 'HOLD_STOCK') refuse([{ path: 'hold', message: 'A hold is placed by a HOLD_STOCK action.' }], 'Not a HOLD_STOCK action.')
    const hold = await holdFor(tools, ncr, body)
    const files = await tx.storedFile.count({ where: { recordType: 'NcrContainmentAction', recordId: actionId, status: { not: 'DELETED' } } })
    const evidenceNote = body.evidenceNote?.trim() || hold?.words || null
    const problems = doneProblems({ kind: action.kind as ContainmentKind, evidenceNote, files, holdId: hold?.id ?? (action.recordType === 'QualityHold' ? action.recordId : null) })
    if (problems.length > 0) refuse(problems, 'The action is not done yet.')
    const record = hold ? { recordType: 'QualityHold', recordId: hold.id } : body.record ? { recordType: body.record.type, recordId: body.record.id } : {}
    const after = await tx.ncrContainmentAction.update({ where: { id: actionId }, data: { status: 'DONE', doneAt: now, doneById: context.actorId, evidenceNote, ...record, version: { increment: 1 }, updatedAt: now }, select: ACTION_COLUMNS })
    tools.audit({ action: 'quality.doneNcrAction', recordType: 'NcrContainmentAction', recordId: actionId, ...scopeOf(ncr), before: { status: 'OPEN' }, after: { status: 'DONE', evidenceNote, files, recordType: after.recordType, recordId: after.recordId } })
    emit(tools, ncr, after, 'DONE', hold?.id ?? null)
    return answerOf(tools, ncrId)
  })
  return result
}

/** POST /quality/ncr/:ncrId/containment/:actionId/cancel: not needed after all, with the reason (B-W2b-17: its own column). */
export async function cancelAction(caller: CommandCaller, ncrId: string, actionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertContainable(row)
  const { result } = await command(caller, { name: 'quality.cancelNcrAction', idempotencyKey, input: { ncrId, actionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockNcrRow(tools, ncrId)
    assertContainable(ncr)
    await openAction(tools, ncrId, actionId, body.version)
    const reason = body.reason.trim()
    const after = await tx.ncrContainmentAction.update({ where: { id: actionId }, data: { status: 'CANCELLED', cancelReason: reason, version: { increment: 1 }, updatedAt: now }, select: ACTION_COLUMNS })
    tools.audit({ action: 'quality.cancelNcrAction', recordType: 'NcrContainmentAction', recordId: actionId, ...scopeOf(ncr), before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason })
    emit(tools, ncr, after, 'CANCELLED', null)
    return answerOf(tools, ncrId)
  })
  return result
}

