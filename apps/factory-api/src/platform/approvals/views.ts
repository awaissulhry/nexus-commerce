import type { z } from 'zod'
import {
  APPROVAL_KIND_WORDS,
  APPROVAL_REFUSALS,
  changeSize,
  ownRequestWords,
  parseCondition,
  parsePreview,
  ruleSentence,
  staleWords,
  type ApprovalField,
  type ApprovalMeaning,
  type ApprovalTaskKind,
  type Words,
} from '@nexus/factory-domain/approvals/rules'
import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf, type OfficeContext } from '../../core/context'
import type { taskDetail, taskRow } from './contract'
import { recheckSubject, type Recheck } from './engine'
import type { HistoryLine } from './history/source'
import { kindOf } from './kinds'
import { reasonWords } from '../reasons/service'
import { askersOfTask, decideCheck, decidersOf, fieldsOfKind, grainsOf, heldGrain, hiddenFieldsOf, isApprover, peopleNames, roleNames, type HeldApproverRole, type Reader, type TaskRow } from './store'

/**
 * The requests as the screens read them (B-W2b-282; design home.approvals queue, review, why-me): names resolved in one pass,
 * every money fact only with the reader's grain, the rule that named the approver in the reader's sentence, the re-check of a
 * pending request, and whether the reader may approve it now (held with the words otherwise).
 */

export type TaskRowView = z.infer<typeof taskRow>
export type TaskDetailView = z.infer<typeof taskDetail>

// B-W2b-377 (B-W2b-361's gap): a kind no step registered yet is said from the domain's words (it, en), never its code.
export const kindLabelOf = (kind: string): Words => kindOf(kind)?.label ?? APPROVAL_KIND_WORDS[kind as ApprovalTaskKind] ?? { en: kind, it: kind }

const labelOf = (fields: readonly ApprovalField[], field: string): Words | null => fields.find((entry) => entry.id === field)?.label ?? null

export interface ViewContext {
  readonly context: OfficeContext
  readonly roles: readonly HeldApproverRole[]
  readonly now: Date
}

type RuleRef = { id: string; name: string; kind: string; condition: unknown; approverRoleId: string | null; approverUserId: string | null; signatureMeaning: string | null }

/** The names, rules and askers the rows need, read once. */
async function lookups(db: Reader, tasks: readonly TaskRow[], detail: boolean) {
  const ruleIds = [...new Set(tasks.flatMap((task) => task.ruleIds))]
  const rules: RuleRef[] = ruleIds.length ? await db.approvalRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true, kind: true, condition: true, approverRoleId: true, approverUserId: true, signatureMeaning: true } }) : []
  const people = await peopleNames(db, [
    ...tasks.flatMap((task) => [task.requestedById, task.approverUserId, task.decidedById, task.withdrawnById]),
    ...rules.map((rule) => rule.approverUserId),
  ])
  const roles = await roleNames(db, [...tasks.map((task) => task.approverRoleId), ...rules.map((rule) => rule.approverRoleId)])
  const workerIds = [...new Set(tasks.map((task) => task.requestedByWorkerId).filter((id): id is string => id !== null))]
  const workers = workerIds.length ? new Map((await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true, userId: true } })).map((worker) => [worker.id, worker])) : new Map<string, { id: string; displayName: string; userId: string | null }>()
  return { rules: new Map(rules.map((rule) => [rule.id, rule])), people, roles, workers, detail }
}

function sentenceOf(rule: RuleRef, grains: ReadonlySet<Grain>, names: { people: Map<string, string>; roles: Map<string, string> }): Words {
  const fields = fieldsOfKind(rule.kind)
  const input = {
    kindLabel: kindLabelOf(rule.kind),
    condition: parseCondition(rule.condition),
    fields,
    hiddenFields: hiddenFieldsOf(fields, grains),
    approver: rule.approverUserId ? (names.people.get(rule.approverUserId) ?? null) : rule.approverRoleId ? (names.roles.get(rule.approverRoleId) ?? null) : null,
    meaning: rule.signatureMeaning as ApprovalMeaning | null,
  }
  return { en: ruleSentence(input, 'en'), it: ruleSentence(input, 'it') }
}

/** B-W2b-377: what a row says of its subject beyond its code: the record in words now, and the page it belongs to. */
interface SubjectWords {
  readonly label: string | null
  readonly parent: { readonly type: string; readonly id: string } | null
}

/** A row's subject read once by its kind: its re-check (pending only) and its words. */
async function subjectOfTask(db: Reader, task: TaskRow): Promise<{ readonly recheck: Recheck | null; readonly words: SubjectWords }> {
  const kind = kindOf(task.kind)
  if (!kind || kind.recordType !== task.recordType) return { recheck: task.status === 'PENDING' ? { state: 'UNKNOWN_KIND' } : null, words: { label: null, parent: null } }
  const subject = await kind.read(db, task.recordId)
  const parent = kind.parent ? await kind.parent(db, task.recordId) : null
  return { recheck: task.status === 'PENDING' ? recheckSubject(task, kind, subject) : null, words: { label: subject?.label ?? null, parent: parent ? { type: parent.type, id: parent.id } : null } }
}

function rowOf(task: TaskRow, view: ViewContext, data: Awaited<ReturnType<typeof lookups>>, recheckState: Recheck | null, words: SubjectWords): TaskRowView {
  const me = view.context.actorId
  const grains = grainsOf(actorOf(view.context))
  const fields = fieldsOfKind(task.kind)
  const preview = parsePreview(task.preview)
  const worker = task.requestedByWorkerId ? data.workers.get(task.requestedByWorkerId) : undefined
  const askers = [task.requestedById, task.createdById, worker?.userId ?? null].filter((id): id is string => id !== null)
  const deciding = task.ruleIds.map((id) => data.rules.get(id)).find((rule) => rule && rule.approverRoleId === task.approverRoleId && rule.approverUserId === task.approverUserId)
  const check = decideCheck(view.context, task, askers, view.roles)
  const pending = task.status === 'PENDING'
  return {
    id: task.id,
    kind: task.kind as ApprovalTaskKind,
    kindLabel: kindLabelOf(task.kind),
    status: task.status,
    summary: task.summary,
    record: { type: task.recordType, id: task.recordId, label: words.label, parent: words.parent },
    companyId: task.companyId,
    siteId: task.siteId,
    requester: task.requestedById
      ? { kind: 'PERSON', id: task.requestedById, name: data.people.get(task.requestedById) ?? '', me: task.requestedById === me }
      : { kind: 'WORKER', id: task.requestedByWorkerId!, name: data.detail ? (worker?.displayName ?? '') : 'A floor worker', me: false },
    approver: task.approverUserId
      ? { kind: 'PERSON', id: task.approverUserId, name: data.people.get(task.approverUserId) ?? '', me: task.approverUserId === me }
      : { kind: 'ROLE', id: task.approverRoleId!, name: data.roles.get(task.approverRoleId!) ?? '', me: isApprover(task, me, view.roles) },
    rule: deciding ? { id: deciding.id, name: deciding.name, sentence: sentenceOf(deciding, grains, data) } : null,
    signatureMeaning: task.signatureMeaning as ApprovalMeaning | null,
    requireStepUp: task.requireStepUp,
    changeSize: changeSize(preview.changes),
    facts: preview.facts.filter((fact) => !heldGrain(fact.grain, grains)).map((fact) => ({ field: fact.field, label: labelOf(fields, fact.field), value: fact.value, grain: fact.grain ?? null })),
    requestedAt: toUtcIso(task.requestedAt),
    dueAt: task.dueAt ? toUtcIso(task.dueAt) : null,
    overdue: pending && task.dueAt !== null && task.dueAt.getTime() < view.now.getTime(),
    decidedAt: task.decidedAt ? toUtcIso(task.decidedAt) : null,
    recheck: recheckState && recheckState.state !== 'UNKNOWN_KIND' ? recheckState.state : null,
    approve: check.allowed
      ? kindOf(task.kind)
        ? recheckState?.state === 'CHANGED' || recheckState?.state === 'GONE'
          ? { allowed: false, why: recheckState.state === 'GONE' ? APPROVAL_REFUSALS.SUBJECT_GONE : APPROVAL_REFUSALS.STALE }
          : { allowed: true, why: null }
        : { allowed: false, why: APPROVAL_REFUSALS.NO_KIND }
      : { allowed: false, why: APPROVAL_REFUSALS[check.code] },
    version: task.version,
  }
}

/** The rows of a list (pending ones re-read: `recheck`). */
export async function taskRows(db: Reader, tasks: readonly TaskRow[], view: ViewContext): Promise<TaskRowView[]> {
  const data = await lookups(db, tasks, false)
  const rows: TaskRowView[] = []
  for (const task of tasks) {
    const subject = await subjectOfTask(db, task)
    rows.push(rowOf(task, view, data, subject.recheck, subject.words))
  }
  return rows
}

/** One request as the review popup reads it: its change, its re-check line, its rules, who may decide, its history. */
export async function taskDetailOf(db: Reader, task: TaskRow, view: ViewContext, history: readonly HistoryLine[]): Promise<TaskDetailView> {
  const data = await lookups(db, [task], true)
  const subject = await subjectOfTask(db, task)
  const state = subject.recheck
  const row = rowOf(task, view, data, state, subject.words)
  const me = view.context.actorId
  const grains = grainsOf(actorOf(view.context))
  const fields = fieldsOfKind(task.kind)
  const preview = parsePreview(task.preview)
  const askers = await askersOfTask(db, task)
  const deciders = task.status === 'PENDING' ? await decidersOf(db, view.context.tenantId, task, task, askers, view.now) : []
  const label = (field: string) => labelOf(fields, field)?.en ?? field
  const historyPeople = await peopleNames(db, history.map((entry) => entry.byId))
  const historyWorkers = new Map((await db.worker.findMany({ where: { id: { in: [...new Set(history.map((entry) => entry.byWorkerId).filter((id): id is string => id !== null))] } }, select: { id: true, displayName: true } })).map((worker) => [worker.id, worker.displayName]))
  const reasons = task.rejectReasonCode ? await reasonWords(db as Parameters<typeof reasonWords>[0], 'APPROVAL_REJECT') : new Map()
  const reason = task.rejectReasonCode ? reasons.get(task.rejectReasonCode) : undefined
  const person = (id: string | null) => (id ? { id, name: data.people.get(id) ?? '', me: id === me } : null)
  const check = decideCheck(view.context, task, askers, view.roles)
  const approve = check.allowed ? row.approve : check.code === 'OWN_REQUEST' ? { allowed: false, why: ownRequestWords(deciders.map((entry) => entry.name)) } : row.approve
  const changed = state?.state === 'CHANGED' ? state.changed.filter((entry) => !heldGrain(entry.grain, grains)) : []
  return {
    ...row,
    approve,
    changes: preview.changes.filter((change) => !heldGrain(change.grain, grains)).map((change) => ({ field: change.field, label: labelOf(fields, change.field), from: change.from, to: change.to, grain: change.grain ?? null })),
    fingerprint: task.fingerprint,
    recheckLine:
      state === null || state.state === 'UNKNOWN_KIND'
        ? null
        : {
            checkedAt: toUtcIso(view.now),
            words: state.state === 'CURRENT' ? `Still current · checked ${toUtcIso(view.now)}` : state.state === 'GONE' ? APPROVAL_REFUSALS.SUBJECT_GONE : staleWords(changed, label),
            changed: changed.map((entry) => ({ field: entry.field, label: labelOf(fields, entry.field), was: entry.was, now: entry.now, grain: entry.grain })),
          },
    rules: task.ruleIds.flatMap((id) => {
      const rule = data.rules.get(id)
      return rule ? [{ id: rule.id, name: rule.name, sentence: sentenceOf(rule, grains, data) }] : []
    }),
    deciders,
    decided: task.decidedAt && task.decidedById
      ? {
          by: person(task.decidedById)!,
          at: toUtcIso(task.decidedAt),
          comment: task.comment,
          reasonCode: task.rejectReasonCode,
          reasonLabel: reason ? { en: reason.labelEn, it: reason.labelIt } : null,
          reason: task.rejectReason,
          stepUpAt: task.stepUpAt ? toUtcIso(task.stepUpAt) : null,
        }
      : null,
    withdrawn: task.withdrawnAt ? { at: toUtcIso(task.withdrawnAt), by: person(task.withdrawnById) } : null,
    staleAt: task.staleAt ? toUtcIso(task.staleAt) : null,
    history: history.map((entry) => historyLineView(entry, me, historyPeople, historyWorkers)),
    reject: check.allowed ? { allowed: true, why: null } : check.code === 'OWN_REQUEST' ? approve : { allowed: false, why: APPROVAL_REFUSALS[check.code] },
    withdraw: task.status !== 'PENDING' ? { allowed: false, why: APPROVAL_REFUSALS.NOT_PENDING } : askers.includes(me) ? { allowed: true, why: null } : { allowed: false, why: APPROVAL_REFUSALS.NOT_REQUESTER },
  }
}

export function historyLineView(entry: HistoryLine, me: string, people: Map<string, string>, workers: Map<string, string>) {
  return {
    id: entry.id,
    source: entry.source,
    action: entry.action,
    at: toUtcIso(entry.at),
    by: entry.byId
      ? { kind: 'PERSON' as const, id: entry.byId, name: people.get(entry.byId) ?? '', me: entry.byId === me }
      : entry.byWorkerId
        ? { kind: 'WORKER' as const, id: entry.byWorkerId, name: workers.get(entry.byWorkerId) ?? '', me: false }
        : { kind: 'SYSTEM' as const, id: null, name: 'Nexus', me: false },
    words: entry.words,
    reasonCode: entry.reasonCode,
    meaning: entry.meaning,
    taskId: entry.taskId,
  }
}
