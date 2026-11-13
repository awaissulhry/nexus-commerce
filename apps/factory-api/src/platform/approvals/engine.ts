import type { Prisma } from '@nexus/factory-db'
import { events as approvalEvents } from '@nexus/factory-domain/approvals/events'
import {
  APPROVAL_LIMITS,
  APPROVAL_REFUSALS,
  approvalFingerprint,
  askersOf,
  changedFacts,
  chooseRules,
  parsePreview,
  type ApprovalField,
  type ApprovalMeaning,
  type ApprovalTaskKind,
  type PreviewChange,
  type PreviewFact,
} from '@nexus/factory-domain/approvals/rules'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import type { CommandTools, CommandTx } from '../../core/command'
import { kindOf } from './kinds'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kinds/kind'
import { TASK_COLUMNS, type TaskRow } from './store'

/**
 * The approval engine's commands (B-W2b-282; PLT-086, PLT-093, PLT-091, PLT-105, PLT-104): the seams a module calls INSIDE its
 * own command (`tools`), and the decision steps the routes call inside theirs.
 *
 *   askApproval(tools, { kind, recordId, requester, note?, changes? })
 *       "One command asks for a yes": the subject is locked and read by its kind; the kind's rules in force are read in
 *       order and the first whose condition holds (and that names someone other than the person asking) names the approver,
 *       the meaning, the step-up and the time; every rule that held is kept on the request. No rule: `{ asked: false }` —
 *       no approval, the module goes on as today. Else the request is written PENDING with the change as it will be written
 *       and its fingerprint, its REQUESTED history line (the note) and approval.requested. One pending request per kind and
 *       subject (409 in words otherwise). A floor worker's request is written by the API in an office or system command.
 *   withdrawPending(tools, { kind, recordId, byId })
 *       the module's own withdrawal (the subject was cancelled …): every pending request of the kind on the subject.
 *   historyLine(tools, line)
 *       a domain approval's line in the record's history (no request): the database refuses a decision by the person of the
 *       record's last REQUESTED line.
 */

const [requested, decided, withdrawnEvent, staleEvent] = approvalEvents

const HOUR_MS = 3_600_000

export type Requester = { readonly userId: string } | { readonly workerId: string; readonly siteId: string }

export interface AskInput {
  readonly kind: ApprovalTaskKind
  readonly recordId: string
  readonly requester: Requester
  /** The request's note: the words of its REQUESTED line (1 to 4000 characters). */
  readonly note?: string | null
  /** The change as it will be written, when the module names it (default: the kind's). */
  readonly changes?: readonly PreviewChange[]
  /**
   * B-W2b-377: a domain rule that always needs a second person's yes (a purchase order sent without a valid document, a receipt
   * beyond its tolerance): when no switched-on rule holds, the request is still asked, of this office role, naming no rule
   * (the database's "none: a domain switch asked"). Left out: no rule, no request (as before).
   */
  readonly whenNoRule?: { readonly approverRoleId: string; readonly requireStepUp: boolean }
}

export type AskOutcome =
  | { readonly asked: false }
  | { readonly asked: true; readonly taskId: string; readonly ruleIds: readonly string[]; readonly approverRoleId: string | null; readonly approverUserId: string | null; readonly dueAt: string | null }

/** The kind's facts as a request shows them (each money fact with its grain); unknown facts are left out. */
export function previewFacts(fields: readonly ApprovalField[], subject: Pick<ApprovalSubject, 'facts'>): PreviewFact[] {
  return fields.flatMap((field) => {
    const value = subject.facts[field.id]
    return value === undefined || value === null ? [] : [{ field: field.id, value, grain: field.grain ?? null }]
  })
}

/** Serialises the asks and decisions of one subject (per tenant, kind and record). */
async function lockSubject(tx: CommandTx, tenantId: string, kind: ApprovalKindDefinition, recordId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.approvals', ${tenantId}::text, ${kind.recordType}::text, ${recordId}::text), 0))`
  await kind.lock?.(tx, recordId)
}

const tenantOf = (tools: CommandTools): string => {
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : undefined
  if (!tenantId) throw new Error('approvals: a command outside a tenant')
  return tenantId
}

const writerOf = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export const taskRefOf = (task: Pick<TaskRow, 'id' | 'kind' | 'recordType' | 'recordId' | 'companyId' | 'siteId' | 'requestedById' | 'requestedByWorkerId' | 'signatureMeaning' | 'decidedById'>): TaskRef => ({
  id: task.id,
  kind: task.kind as ApprovalTaskKind,
  recordType: task.recordType,
  recordId: task.recordId,
  companyId: task.companyId,
  siteId: task.siteId,
  requestedById: task.requestedById,
  requestedByWorkerId: task.requestedByWorkerId,
  signatureMeaning: task.signatureMeaning as ApprovalMeaning | null,
  decidedById: task.decidedById,
})

const subjectOf = (task: Pick<TaskRow, 'id' | 'kind' | 'recordType' | 'recordId'>) => ({ taskId: task.id, kind: task.kind as ApprovalTaskKind, recordType: task.recordType, recordId: task.recordId })

/** One pending request per kind and subject (the engine's: no partial unique index in the database). */
async function pendingOf(tx: Reader, kind: ApprovalTaskKind, recordType: string, recordId: string) {
  return tx.approvalTask.findMany({ where: { kind, recordType, recordId, status: 'PENDING' }, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }], select: TASK_COLUMNS })
}

export async function askApproval(tools: CommandTools, input: AskInput): Promise<AskOutcome> {
  const { tx, now } = tools
  if (tools.context.audience !== 'office' && tools.context.audience !== 'system') throw new Error('approvals: a request for a yes is written in an office or system command')
  const kind = kindOf(input.kind)
  if (!kind) throw new ConflictError(APPROVAL_REFUSALS.NO_KIND)
  const tenantId = tenantOf(tools)
  await lockSubject(tx, tenantId, kind, input.recordId)
  const subject = await kind.read(tx, input.recordId)
  if (!subject) throw new NotFoundError(APPROVAL_REFUSALS.SUBJECT_GONE)
  if (subject.held) throw new DomainError('conflict', subject.held, [{ path: 'recordId', message: subject.held }])
  if ((await pendingOf(tx, kind.kind, kind.recordType, input.recordId)).length > 0) throw new DomainError('conflict', APPROVAL_REFUSALS.PENDING_EXISTS, [{ path: 'recordId', message: APPROVAL_REFUSALS.PENDING_EXISTS }])
  const note = input.note?.trim() ? input.note.trim() : null
  if (note !== null && note.length > APPROVAL_LIMITS.note) throw new ValidationError('The note is at most 4000 characters.', [{ path: 'body/note', message: 'At most 4000 characters.' }])

  const worker = 'workerId' in input.requester ? await tx.worker.findUnique({ where: { id: input.requester.workerId }, select: { siteId: true, userId: true, companyId: true } }) : null
  if ('workerId' in input.requester && (!worker || worker.siteId !== input.requester.siteId)) throw new NotFoundError('The floor worker who asks is not a worker of this site.')
  const requestedById = 'userId' in input.requester ? input.requester.userId : null
  const createdById = writerOf(tools)
  const askers = askersOf({ requestedById, createdById }, worker?.userId ?? null)

  const rules = await tx.approvalRule.findMany({
    where: { kind: kind.kind, active: true, OR: [{ companyId: null }, { companyId: subject.companyId }] },
    select: { id: true, companyId: true, sequence: true, createdAt: true, active: true, effectiveFrom: true, condition: true, approverRoleId: true, approverUserId: true, signatureMeaning: true, requireStepUp: true, dueHours: true },
  })
  const choice = chooseRules(rules, { companyId: subject.companyId, facts: subject.facts, askers }, kind.fields, now)
  if (choice.matched.length === 0 && !input.whenNoRule) return { asked: false }
  // B-W2b-377: no rule holds, and the module's own rule asks a yes anyway: its role decides, with no rule named.
  const rule = choice.matched.length === 0 && input.whenNoRule ? { approverRoleId: input.whenNoRule.approverRoleId, approverUserId: null, signatureMeaning: null, requireStepUp: input.whenNoRule.requireStepUp, dueHours: null } : choice.deciding
  if (!rule) throw new DomainError('conflict', APPROVAL_REFUSALS.NAMED_SELF, [{ path: 'approver', message: APPROVAL_REFUSALS.NAMED_SELF }])

  const changes = input.changes ?? subject.changes
  const preview = { changes, facts: previewFacts(kind.fields, subject) }
  const fingerprint = approvalFingerprint({ kind: kind.kind, recordType: kind.recordType, recordId: input.recordId, subject: subject.snapshot, changes })
  const siteId = 'workerId' in input.requester ? input.requester.siteId : subject.siteId
  const id = newId()
  const dueAt = rule.dueHours === null ? null : new Date(now.getTime() + rule.dueHours * HOUR_MS)
  await tx.approvalTask.create({
    data: {
      id,
      kind: kind.kind,
      recordType: kind.recordType,
      recordId: input.recordId,
      companyId: subject.companyId,
      siteId,
      ruleIds: choice.matched.map((entry) => entry.id),
      summary: subject.summary.slice(0, APPROVAL_LIMITS.summary),
      preview: JSON.parse(JSON.stringify(preview)) as Prisma.InputJsonObject,
      fingerprint,
      requestedById,
      requestedByWorkerId: 'workerId' in input.requester ? input.requester.workerId : null,
      requestedAt: now,
      approverRoleId: rule.approverRoleId,
      approverUserId: rule.approverUserId,
      signatureMeaning: rule.signatureMeaning,
      requireStepUp: rule.requireStepUp,
      dueAt,
      createdAt: now,
      updatedAt: now,
      createdById,
    },
  })
  await tx.approvalEvent.create({
    data: {
      id: newId(),
      companyId: subject.companyId,
      taskId: id,
      recordType: kind.recordType,
      recordId: input.recordId,
      action: 'REQUESTED',
      byId: requestedById,
      byWorkerId: 'workerId' in input.requester ? input.requester.workerId : null,
      at: now,
      words: note,
      createdAt: now,
      createdById,
    },
  })
  tools.audit({
    action: 'approvals.request',
    recordType: 'ApprovalTask',
    recordId: id,
    companyId: subject.companyId,
    siteId,
    after: { kind: kind.kind, recordType: kind.recordType, recordId: input.recordId, status: 'PENDING', ruleIds: choice.matched.map((entry) => entry.id), approverRoleId: rule.approverRoleId, approverUserId: rule.approverUserId, signatureMeaning: rule.signatureMeaning, requireStepUp: rule.requireStepUp, dueAt: dueAt ? toUtcIso(dueAt) : null, fingerprint },
  })
  tools.emit(
    eventFor(requested, {
      subject: id,
      companyId: subject.companyId,
      siteId,
      payload: { taskId: id, kind: kind.kind, recordType: kind.recordType, recordId: input.recordId, requestedById, approverRoleId: rule.approverRoleId, approverUserId: rule.approverUserId, dueAt: dueAt ? toUtcIso(dueAt) : null },
    }),
  )
  return { asked: true, taskId: id, ruleIds: choice.matched.map((entry) => entry.id), approverRoleId: rule.approverRoleId, approverUserId: rule.approverUserId, dueAt: dueAt ? toUtcIso(dueAt) : null }
}

// ---- the re-check -------------------------------------------------------------------------------------------------------

export type Recheck =
  | { readonly state: 'CURRENT' }
  | { readonly state: 'CHANGED'; readonly changed: ReturnType<typeof changedFacts> }
  | { readonly state: 'GONE' }
  | { readonly state: 'UNKNOWN_KIND' }

/** Reads the subject again and compares its fingerprint with the request's (PLT-093). */
export async function recheck(db: Reader, task: Pick<TaskRow, 'kind' | 'recordType' | 'recordId' | 'preview' | 'fingerprint'>): Promise<Recheck> {
  const kind = kindOf(task.kind)
  if (!kind || kind.recordType !== task.recordType) return { state: 'UNKNOWN_KIND' }
  return recheckSubject(task, kind, await kind.read(db, task.recordId))
}

/** B-W2b-377: the re-check of a subject read already (the inbox reads each row's subject once for its words too). */
export function recheckSubject(task: Pick<TaskRow, 'kind' | 'recordType' | 'recordId' | 'preview' | 'fingerprint'>, kind: ApprovalKindDefinition, subject: ApprovalSubject | null): Recheck {
  if (!subject) return { state: 'GONE' }
  const preview = parsePreview(task.preview)
  const now = approvalFingerprint({ kind: task.kind, recordType: task.recordType, recordId: task.recordId, subject: subject.snapshot, changes: preview.changes })
  if (now === task.fingerprint) return { state: 'CURRENT' }
  return { state: 'CHANGED', changed: changedFacts(preview.facts, previewFacts(kind.fields, subject)) }
}

// ---- the decision's steps (inside the route's command on the ApprovalTask) -----------------------------------------------

/** The request read in the decision's command (command() has locked it with its version bump). */
export async function taskInCommand(tx: CommandTx, taskId: string): Promise<TaskRow> {
  const task = await tx.approvalTask.findUnique({ where: { id: taskId }, select: TASK_COLUMNS })
  if (!task) throw new NotFoundError()
  return task
}

async function line(tools: CommandTools, task: Pick<TaskRow, 'id' | 'companyId' | 'recordType' | 'recordId'>, data: { action: 'APPROVED' | 'SIGNED' | 'REJECTED' | 'WITHDRAWN' | 'STALE'; byId: string | null; words?: string | null; reasonCode?: string | null; meaning?: ApprovalMeaning | null }): Promise<void> {
  await tools.tx.approvalEvent.create({
    data: {
      id: newId(),
      companyId: task.companyId,
      taskId: task.id,
      recordType: task.recordType,
      recordId: task.recordId,
      action: data.action,
      byId: data.byId,
      at: tools.now,
      words: data.words ?? null,
      reasonCode: data.reasonCode ?? null,
      meaning: data.meaning ?? null,
      createdAt: tools.now,
      createdById: writerOf(tools),
    },
  })
}

/** STALE: the subject changed since it was asked (the system's line, approval.stale; the kind's hook). */
export async function markStale(tools: CommandTools, task: TaskRow): Promise<void> {
  await tools.tx.approvalTask.update({ where: { id: task.id }, data: { status: 'STALE', staleAt: tools.now } })
  await line(tools, task, { action: 'STALE', byId: null })
  tools.audit({ action: 'approvals.stale', recordType: 'ApprovalTask', recordId: task.id, companyId: task.companyId, siteId: task.siteId, before: { status: 'PENDING' }, after: { status: 'STALE', fingerprint: task.fingerprint } })
  tools.emit(eventFor(staleEvent, { subject: task.id, companyId: task.companyId, siteId: task.siteId, payload: { ...subjectOf(task), requestedById: task.requestedById } }))
  await kindOf(task.kind)?.onStale?.(tools, taskRefOf(task))
}

/** WITHDRAWN: taken back by a person, or by the system (byId null) when the subject went away. */
export async function markWithdrawn(tools: CommandTools, task: TaskRow, byId: string | null, words: string | null = null): Promise<void> {
  await tools.tx.approvalTask.update({ where: { id: task.id }, data: { status: 'WITHDRAWN', withdrawnAt: tools.now, withdrawnById: byId } })
  await line(tools, task, { action: 'WITHDRAWN', byId, words })
  tools.audit({ action: 'approvals.withdraw', recordType: 'ApprovalTask', recordId: task.id, companyId: task.companyId, siteId: task.siteId, before: { status: 'PENDING' }, after: { status: 'WITHDRAWN', withdrawnById: byId }, ...(words ? { reason: words } : {}) })
  tools.emit(eventFor(withdrawnEvent, { subject: task.id, companyId: task.companyId, siteId: task.siteId, payload: subjectOf(task) }))
  await kindOf(task.kind)?.onWithdrawn?.(tools, taskRefOf(task))
}

/** The yes: APPROVED (comment, step-up time), its APPROVED line (and SIGNED with the meaning), approval.decided, the kind's hook. */
export async function markApproved(tools: CommandTools, task: TaskRow, input: { readonly deciderId: string; readonly comment: string | null; readonly stepUpAt: Date | null }): Promise<void> {
  const meaning = task.signatureMeaning as ApprovalMeaning | null
  await tools.tx.approvalTask.update({ where: { id: task.id }, data: { status: 'APPROVED', decidedAt: tools.now, decidedById: input.deciderId, comment: input.comment, stepUpAt: task.requireStepUp ? input.stepUpAt : null } })
  await line(tools, task, { action: 'APPROVED', byId: input.deciderId, words: input.comment, meaning })
  if (meaning) await line(tools, task, { action: 'SIGNED', byId: input.deciderId, meaning })
  tools.audit({
    action: 'approvals.approve',
    recordType: 'ApprovalTask',
    recordId: task.id,
    companyId: task.companyId,
    siteId: task.siteId,
    before: { status: 'PENDING' },
    after: { status: 'APPROVED', decidedById: input.deciderId, signatureMeaning: meaning, stepUp: task.requireStepUp, fingerprint: task.fingerprint },
  })
  tools.emit(eventFor(decided, { subject: task.id, companyId: task.companyId, siteId: task.siteId, payload: { ...subjectOf(task), status: 'APPROVED', meaning, requestedById: task.requestedById, decidedById: input.deciderId } }))
  await kindOf(task.kind)?.onApproved?.(tools, { ...taskRefOf(task), decidedById: input.deciderId })
}

/** The no: REJECTED with a reason code and words, its REJECTED line, approval.decided, the kind's hook. */
export async function markRejected(tools: CommandTools, task: TaskRow, input: { readonly deciderId: string; readonly reasonCode: string; readonly reason: string }): Promise<void> {
  await tools.tx.approvalTask.update({ where: { id: task.id }, data: { status: 'REJECTED', decidedAt: tools.now, decidedById: input.deciderId, rejectReasonCode: input.reasonCode, rejectReason: input.reason } })
  await line(tools, task, { action: 'REJECTED', byId: input.deciderId, words: input.reason, reasonCode: input.reasonCode })
  tools.audit({ action: 'approvals.reject', recordType: 'ApprovalTask', recordId: task.id, companyId: task.companyId, siteId: task.siteId, before: { status: 'PENDING' }, after: { status: 'REJECTED', decidedById: input.deciderId, rejectReasonCode: input.reasonCode }, reason: input.reason })
  tools.emit(eventFor(decided, { subject: task.id, companyId: task.companyId, siteId: task.siteId, payload: { ...subjectOf(task), status: 'REJECTED', meaning: null, requestedById: task.requestedById, decidedById: input.deciderId } }))
  await kindOf(task.kind)?.onRejected?.(tools, { ...taskRefOf(task), decidedById: input.deciderId })
}

/**
 * A module's own withdrawal, inside its command (the subject was cancelled, deleted or changed so that its request no
 * longer stands): every pending request of the kind on the subject, by the person (or the system, byId null).
 */
export async function withdrawPending(tools: CommandTools, input: { readonly kind: ApprovalTaskKind; readonly recordId: string; readonly byId: string | null; readonly words?: string | null }): Promise<number> {
  const kind = kindOf(input.kind)
  if (!kind) return 0
  await lockSubject(tools.tx, tenantOf(tools), kind, input.recordId)
  const tasks = await pendingOf(tools.tx, kind.kind, kind.recordType, input.recordId)
  for (const task of tasks) await markWithdrawn(tools, task, input.byId, input.words ?? null)
  return tasks.length
}

export interface DomainLine {
  readonly companyId: string
  readonly recordType: string
  readonly recordId: string
  readonly action: 'REQUESTED' | 'COMMENTED' | 'APPROVED' | 'REJECTED' | 'SIGNED'
  readonly byId: string | null
  readonly byWorkerId?: string | null
  readonly words?: string | null
  readonly reasonCode?: string | null
  readonly meaning?: ApprovalMeaning | null
}

/** A domain approval's line in a record's history (no request); the database refuses a decision by the person who asked. */
export async function historyLine(tools: CommandTools, input: DomainLine): Promise<string> {
  const id = newId()
  await tools.tx.approvalEvent.create({
    data: {
      id,
      companyId: input.companyId,
      taskId: null,
      recordType: input.recordType,
      recordId: input.recordId,
      action: input.action,
      byId: input.byId,
      byWorkerId: input.byWorkerId ?? null,
      at: tools.now,
      words: input.words ?? null,
      reasonCode: input.reasonCode ?? null,
      meaning: input.meaning ?? null,
      createdAt: tools.now,
      createdById: writerOf(tools),
    },
  })
  return id
}
