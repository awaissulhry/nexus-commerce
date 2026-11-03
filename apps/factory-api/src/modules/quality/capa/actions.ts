import { ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { QUALITY_CAPA_MANAGE } from '@nexus/factory-domain/quality/capa/permissions'
import { actionDraftProblems, CAPA_LIMITS, CAPA_RECORD, MAX_REMINDERS, type ActionChange, type ActionKind } from '@nexus/factory-domain/quality/capa/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { followInCommand } from '../../../platform/threads/followers'
import { assertOpen, contextOf, held, mayOn, officeCapa, refuse } from './access'
import { answerOf, lockCapaRow, peopleProblems } from './capa'
import { closeReminderTasks, remindInCommand } from './reminders'
import { ACTION_COLUMNS, asDay, dayOf, scopeOf, type ActionRow, type CapaRow } from './store'

/**
 * A CAPA's corrective and preventive actions (B-W2b-108; QHS-096; design quality.capa Actions tab capa-actions "action,
 * kind, owner, due, status, reminders sent, escalated to, evidence" and the docked drawer capa-action). Each write is ONE
 * command: the CAPA's row FOR UPDATE first (open; the action's row holds it FOR SHARE too), then the action's row at the
 * version the screen read, bumped. An action's write leaves the CAPA's own version as it is (the screen saves cell by
 * cell); its audit row is on the CAPA (its Activity) and capa.action_changed tells the screens.
 *
 *   add      (quality.capa.manage) kind, what to do, owner (the caller unless named; an ACTIVE office person who sees the
 *            CAPA), due day (today or later), escalation path (one such person, or none: the rule's audience); the owner
 *            follows the CAPA (ASSIGNEE)
 *   change   (manage) while OPEN: kind, words, owner, due day (moved: today or later), escalation path
 *   done     (manage, or the action's own owner with quality.capa.view) with its evidence: a note, or a file of the action
 *            uploaded first (POST /files, recordType "CapaAction"); its open reminder and escalation tasks are done too
 *   cancel   (manage) with the reason; its open tasks cancelled
 *   remind   (manage) a reminder now, by hand (./reminders.ts remindInCommand), at most MAX_REMINDERS
 */

export interface AddActionBody {
  readonly kind: ActionKind
  readonly description: string
  readonly ownerId?: string | undefined
  readonly dueOn: BusinessDate
  readonly escalateToId?: string | null | undefined
}

export interface EditActionBody {
  readonly version: number
  readonly kind?: ActionKind | undefined
  readonly description?: string | undefined
  readonly ownerId?: string | undefined
  readonly dueOn?: BusinessDate | undefined
  readonly escalateToId?: string | null | undefined
}

function emitAction(tools: Pick<CommandTools, 'emit'>, capa: Pick<CapaRow, 'id' | 'number' | 'companyId'>, action: Pick<ActionRow, 'id' | 'seq' | 'kind'>, change: ActionChange): void {
  tools.emit({ type: 'capa.action_changed', subject: capa.id, companyId: capa.companyId, payload: { capaId: capa.id, number: capa.number, actionId: action.id, seq: action.seq, kind: action.kind as ActionKind, change } })
}

/** Inside the command: the action's row locked, of this CAPA, OPEN, at the version the caller read. */
async function lockAction(tools: CommandTools, capaId: string, actionId: string, version: number): Promise<ActionRow> {
  if (!isUuid(actionId)) throw new NotFoundError('Action not found.')
  await tools.tx.$queryRaw`SELECT "id" FROM "CapaAction" WHERE "id" = ${actionId}::uuid FOR UPDATE`
  const row = await tools.tx.capaAction.findUnique({ where: { id: actionId }, select: ACTION_COLUMNS })
  if (!row || row.capaId !== capaId) throw new NotFoundError('Action not found.')
  if (row.status !== 'OPEN') throw held('ACTION_ENDED', `Action ${row.seq} is ${row.status === 'DONE' ? 'done' : 'cancelled'}: it never changes.`)
  if (row.version !== version) throw new StaleVersionError('CapaAction', actionId, row.version, version)
  return row
}

async function followCapa(tools: CommandTools, capa: Pick<CapaRow, 'id' | 'companyId'>, userId: string, by: string): Promise<void> {
  if (!isUuid(userId) || !(await tools.tx.user.findUnique({ where: { id: userId }, select: { id: true } }))) return
  await followInCommand(tools, { type: CAPA_RECORD, id: capa.id, companyId: capa.companyId, siteId: null }, userId, 'ASSIGNEE', by)
}

const actionAudit = (row: Pick<ActionRow, 'id' | 'seq' | 'kind' | 'description' | 'ownerId' | 'dueOn' | 'status' | 'escalateToId'>) => ({ actionId: row.id, seq: row.seq, kind: row.kind, description: row.description, ownerId: row.ownerId, dueOn: dayOf(row.dueOn), status: row.status, escalateToId: row.escalateToId })

/** POST /quality/capa/:capaId/actions */
export async function addAction(caller: CommandCaller, capaId: string, body: AddActionBody, idempotencyKey?: string) {
  const { capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  assertOpen(capa)
  const { result } = await command(caller, { name: 'quality.addCapaAction', idempotencyKey, input: { capaId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const context = contextOf(tools)
    const row = await lockCapaRow(tools, capaId, { bump: false })
    const count = await tx.capaAction.count({ where: { capaId } })
    const problems: Issue[] = [
      ...actionDraftProblems(body, true, businessDate(now)),
      ...(await peopleProblems(tx, context, scopeOf(row), [{ path: 'ownerId', userId: body.ownerId }, { path: 'escalateToId', userId: body.escalateToId }], now)),
    ]
    if (count >= CAPA_LIMITS.actions) problems.push({ path: 'description', message: `A CAPA has at most ${CAPA_LIMITS.actions} actions.` })
    if (problems.length > 0) refuse(problems, 'The action is not complete.')
    const last = await tx.capaAction.findFirst({ where: { capaId }, select: { seq: true }, orderBy: { seq: 'desc' } })
    const action = await tx.capaAction.create({
      data: { id: newId(), capaId, seq: (last?.seq ?? 0) + 1, kind: body.kind, description: body.description.trim(), ownerId: body.ownerId ?? context.actorId, dueOn: asDay(body.dueOn), escalateToId: body.escalateToId ?? null, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: ACTION_COLUMNS,
    })
    tools.audit({ action: 'quality.addCapaAction', recordType: CAPA_RECORD, recordId: capaId, companyId: row.companyId, after: actionAudit(action) })
    emitAction(tools, row, action, 'ADDED')
    if (action.ownerId !== context.actorId) await followCapa(tools, row, action.ownerId, context.actorId)
    return { ...(await answerOf(tools, capaId)), actionId: action.id }
  })
  return result
}

/** PATCH /quality/capa/:capaId/actions/:actionId */
export async function editAction(caller: CommandCaller, capaId: string, actionId: string, body: EditActionBody, idempotencyKey?: string) {
  const { capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  assertOpen(capa)
  const { result } = await command(caller, { name: 'quality.editCapaAction', idempotencyKey, input: { capaId, actionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const context = contextOf(tools)
    const row = await lockCapaRow(tools, capaId, { bump: false })
    const before = await lockAction(tools, capaId, actionId, body.version)
    const dueMoved = body.dueOn !== undefined && body.dueOn !== dayOf(before.dueOn)
    const problems: Issue[] = [
      ...actionDraftProblems({ description: body.description }, false, businessDate(now)),
      ...(dueMoved && body.dueOn! < businessDate(now) ? [{ path: 'dueOn', message: 'A due day moves to today or later.' }] : []),
      ...(await peopleProblems(
        tx,
        context,
        scopeOf(row),
        [...(body.ownerId !== undefined && body.ownerId !== before.ownerId ? [{ path: 'ownerId', userId: body.ownerId }] : []), ...(body.escalateToId && body.escalateToId !== before.escalateToId ? [{ path: 'escalateToId', userId: body.escalateToId }] : [])],
        now,
      )),
    ]
    if (problems.length > 0) refuse(problems, 'The change is not valid.')
    const data = {
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.description !== undefined ? { description: body.description.trim() } : {}),
      ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
      ...(dueMoved ? { dueOn: asDay(body.dueOn!) } : {}),
      ...(body.escalateToId !== undefined ? { escalateToId: body.escalateToId } : {}),
    }
    const action = await tx.capaAction.update({ where: { id: actionId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: ACTION_COLUMNS })
    tools.audit({ action: 'quality.editCapaAction', recordType: CAPA_RECORD, recordId: capaId, companyId: row.companyId, before: actionAudit(before), after: actionAudit(action) })
    emitAction(tools, row, action, 'CHANGED')
    if (action.ownerId !== before.ownerId && action.ownerId !== context.actorId) await followCapa(tools, row, action.ownerId, context.actorId)
    return answerOf(tools, capaId)
  })
  return result
}

/** Whether the caller may record this action done: quality.capa.manage, or it is their own action (they see the CAPA). */
const mayRecordDone = (context: OfficeContext, capa: CapaRow, action: Pick<ActionRow, 'ownerId'>): boolean => mayOn(context, QUALITY_CAPA_MANAGE, capa) || action.ownerId === context.actorId

/** POST /quality/capa/:capaId/actions/:actionId/done {version, evidenceNote?} */
export async function doneAction(caller: CommandCaller, capaId: string, actionId: string, body: { readonly version: number; readonly evidenceNote?: string | null | undefined }, idempotencyKey?: string) {
  const { context, capa } = await officeCapa(caller, capaId)
  assertOpen(capa)
  const { result } = await command(caller, { name: 'quality.doneCapaAction', idempotencyKey, input: { capaId, actionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockCapaRow(tools, capaId, { bump: false })
    const before = await lockAction(tools, capaId, actionId, body.version)
    if (!mayRecordDone(context, row, before)) throw new ForbiddenError('Only its owner, or quality (quality.capa.manage), records an action done.')
    const note = body.evidenceNote?.trim() || null
    if (note && note.length > CAPA_LIMITS.evidence) refuse([{ path: 'evidenceNote', message: `At most ${CAPA_LIMITS.evidence} characters.` }], 'The evidence is too long.')
    const files = await tx.storedFile.count({ where: { recordType: 'CapaAction', recordId: actionId, status: 'AVAILABLE' } })
    if (!note && files === 0) refuse([{ path: 'evidenceNote', message: 'Say what was done, or add a file of it first.' }], 'The evidence is missing.')
    const action = await tx.capaAction.update({ where: { id: actionId }, data: { status: 'DONE', doneAt: now, doneById: context.actorId, evidenceNote: note, version: { increment: 1 }, updatedAt: now }, select: ACTION_COLUMNS })
    const closed = await closeReminderTasks(tools, row, before, 'DONE', context.actorId)
    tools.audit({ action: 'quality.doneCapaAction', recordType: CAPA_RECORD, recordId: capaId, companyId: row.companyId, before: { actionId, status: 'OPEN' }, after: { actionId, seq: action.seq, status: 'DONE', doneAt: now.toISOString(), doneById: context.actorId, evidenceNote: note, files, tasksClosed: closed } })
    emitAction(tools, row, action, 'DONE')
    return answerOf(tools, capaId)
  })
  return result
}

/** POST /quality/capa/:capaId/actions/:actionId/cancel {version, reason} */
export async function cancelAction(caller: CommandCaller, capaId: string, actionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  assertOpen(capa)
  if (!body.reason.trim()) refuse([{ path: 'reason', message: 'Say why the action is cancelled.' }], 'Say why it is cancelled.')
  const { result } = await command(caller, { name: 'quality.cancelCapaAction', idempotencyKey, input: { capaId, actionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const context = contextOf(tools)
    const row = await lockCapaRow(tools, capaId, { bump: false })
    const before = await lockAction(tools, capaId, actionId, body.version)
    const action = await tx.capaAction.update({ where: { id: actionId }, data: { status: 'CANCELLED', cancelReason: body.reason.trim().slice(0, CAPA_LIMITS.reason), version: { increment: 1 }, updatedAt: now }, select: ACTION_COLUMNS })
    const closed = await closeReminderTasks(tools, row, before, 'CANCELLED', context.actorId)
    tools.audit({ action: 'quality.cancelCapaAction', recordType: CAPA_RECORD, recordId: capaId, companyId: row.companyId, before: { actionId, status: 'OPEN' }, after: { actionId, seq: action.seq, status: 'CANCELLED', cancelReason: action.cancelReason, tasksClosed: closed } })
    emitAction(tools, row, action, 'CANCELLED')
    return answerOf(tools, capaId)
  })
  return result
}

/** POST /quality/capa/:capaId/actions/:actionId/remind {version}: a reminder now, by hand. */
export async function remindAction(caller: CommandCaller, capaId: string, actionId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  assertOpen(capa)
  const { result } = await command(caller, { name: 'quality.remindCapaAction', idempotencyKey, input: { capaId, actionId, ...body } }, async (tools) => {
    const context = contextOf(tools)
    const row = await lockCapaRow(tools, capaId, { bump: false })
    const action = await lockAction(tools, capaId, actionId, body.version)
    if (action.remindersSent >= MAX_REMINDERS) throw held('TOO_MANY_REMINDERS', `Action ${action.seq} was reminded ${MAX_REMINDERS} times already.`)
    const sent = await remindInCommand(tools, context.tenantId, row, action, { byHand: true, moment: null, by: context.actorId })
    return { ...(await answerOf(tools, capaId)), reminder: sent }
  })
  return result
}
