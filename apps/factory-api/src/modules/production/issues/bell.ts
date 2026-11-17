import type { MessageKey } from '@nexus/factory-domain/notifications/rules'
import type { Reader } from '../supervisor/resolver'
import { issueEscalationTaskId } from './raise'

/**
 * F-PR-05b — the office bell's words for an issue's task (production plan §3 "Issues"; L24; R-42, R-43, R-44; 10-steps-web F-PR-05b
 * "office bell words for a reported problem and its escalation"). The tasks of an issue are made by the SYSTEM (./tasks.ts
 * writeSystemTask) and reach their person as an ASSIGNMENT bell through platform/notifications/rules/assignments.ts (`task.assigned`):
 * that rule asks here what the task is, so the bell says it in plain words instead of "<someone> assigned you the task …":
 *
 *   the batch task of a customer's "Report a problem"   "Brand Alpha reported a problem on SO-0142: answer in the order's thread"
 *                                                        (several orders: "… on 3 orders: answer in the thread of SO-0142")
 *   an escalation task, step 1 (raise + 1 working day)   "No answer after 1 working day on SO-0142 (Brand Alpha): it now waits on you"
 *                                                        (the customer's backup, else the production managers)
 *   an escalation task, step 2 (raise + 2 working days)  "… after 2 working days …: it now waits on the Owner and Admin"
 *
 * Any other task (an office "Needs an answer" batch task included: its note's mention already told them) keeps the generic words.
 * The wall (PW-17): the task was given only to a person who reads its record (./tasks.ts takesIssueTask), so naming its customer
 * tells nobody of another customer; the bell names no other person (nobody "assigned" it: the system did).
 */

export interface IssueBell {
  readonly messageKey: MessageKey
  /** The bell's words' values: the customer's name and how many orders (or records) the batch holds. */
  readonly params: { readonly customer: string; readonly count: number }
}

/** The most issues one batch counts (a customer reports on at most 50 orders at once; the office notes on at most 100 records). */
const BATCH_COUNT_CAP = 200

/** The customer's name as the office reads it (its trade name, else its legal name). */
async function customerName(db: Reader, partyId: string): Promise<string> {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { tradeName: true, legalName: true } })
  return party?.tradeName ?? party?.legalName ?? ''
}

/** What an issue's task is, for its bell; null: not an issue's task (or one whose bell keeps the generic words). */
export async function issueBellOf(db: Reader, task: { readonly id: string; readonly recordType: string | null; readonly recordId: string | null; readonly assigneeId: string | null; readonly createdById: string | null }): Promise<IssueBell | null> {
  // The batch task: its issues name it as theirs.
  const own = await db.productionIssue.findMany({ where: { taskId: task.id }, select: { source: true, partyId: true }, take: BATCH_COUNT_CAP })
  if (own.length > 0) {
    if (own[0]!.source !== 'BRAND') return null
    return { messageKey: own.length === 1 ? 'notifications.production.problemReported' : 'notifications.production.problemReportedMany', params: { customer: await customerName(db, own[0]!.partyId), count: own.length } }
  }
  // An escalation task: made by the system (no maker) beside its batch task, on the batch task's record, its id derived from the batch
  // task, the step and the person (./raise.ts issueEscalationTaskId) — never a column of its own.
  if (task.createdById !== null || !task.recordType || !task.recordId || !task.assigneeId) return null
  const beside = await db.task.findMany({ where: { recordType: task.recordType, recordId: task.recordId, id: { not: task.id } }, select: { id: true }, take: BATCH_COUNT_CAP })
  for (const batch of beside) {
    const step = ([1, 2] as const).find((at) => issueEscalationTaskId(batch.id, at, task.assigneeId!) === task.id)
    if (!step) continue
    const issues = await db.productionIssue.findMany({ where: { taskId: batch.id }, select: { partyId: true }, take: BATCH_COUNT_CAP })
    if (issues.length === 0) return null
    return { messageKey: step === 1 ? 'notifications.production.issueEscalatedBackup' : 'notifications.production.issueEscalatedOwner', params: { customer: await customerName(db, issues[0]!.partyId), count: issues.length } }
  }
  return null
}
