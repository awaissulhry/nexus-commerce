import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PEOPLE_LEAVERS_MANAGE } from '@nexus/factory-domain/people/leavers/permissions'
import { heldIssueOf, PPE_REFUSALS, receiptsOf, standingIssues, type PpeIssueKind, type PpeReceiptMethod } from '@nexus/factory-domain/safety/ppe/rules'
import type { CommandCaller } from '../../../core/command'
import { RECORD_ISSUE } from '../../safety/ppe/store'
import { assertMayWrite, may, officeOf, refuse } from '../employees/access'
import { leaverRecord, moveStep } from './leavers'

/**
 * The leaver step "PPE returned" linked to the issue (B-W2b-134 for B-W2b-26's leaver steps; design people.employees "Start
 * leaver steps", plant.ppe): what the person holds and the step's link to the issue the PPE was handed over with. The leaver
 * routes and their rules stay B-W2b-26's (./leavers.ts); these two are registered by modules/safety/ppe/routes.ts.
 *
 *   GET  /people/leavers/:caseId/ppe                             (people.view) the person's standing issues per item (units,
 *                                                                last handed over, the issues) and their receipts, newest
 *                                                                first; the PPE_RETURNED step when the leaving has one
 *   POST /people/leavers/:caseId/steps/:stepId/ppe-returned      (people.leavers.manage) {version, issueId}: the step done,
 *                                                                naming the issue (recordType PpeIssue): one of the person's,
 *                                                                not voided; through B-W2b-26's own step command (moveStep:
 *                                                                the case's lock, the step's version, its audit row and event,
 *                                                                the case settled)
 * A returned item is not a row of the PPE register (no RETURN kind: a schema need); the step names the issue it was handed
 * over with. Nothing held: skip the step with the reason (B-W2b-26's skip).
 */

/** The person's standing PPE (ISSUE rows no VOID voids), read with the caller's client. */
async function heldOf(caller: CommandCaller, employeeId: string) {
  const rows = await caller.withClient((client) =>
    client.ppeIssue.findMany({
      where: { employeeId },
      select: { id: true, kind: true, employeeId: true, ppeItemId: true, quantity: true, issuedAt: true, voidsId: true, siteId: true, method: true, ppeItem: { select: { code: true, name: true } } },
    }),
  )
  return rows.map((row) => ({ ...row, kind: row.kind as PpeIssueKind }))
}

/** GET /people/leavers/:caseId/ppe. */
export async function leaverPpe(caller: CommandCaller, caseId: string) {
  const context = officeOf(caller)
  const { leaver, canManage } = await leaverRecord(caller, caseId)
  const rows = await heldOf(caller, leaver.employeeId)
  const standing = standingIssues(rows)
  const byItem = new Map<string, { ppeItemId: string; code: string; name: string; units: number; lastIssuedAt: Date; issueIds: string[] }>()
  for (const row of standing) {
    const entry = byItem.get(row.ppeItemId) ?? { ppeItemId: row.ppeItemId, code: row.ppeItem.code, name: row.ppeItem.name, units: 0, lastIssuedAt: row.issuedAt, issueIds: [] }
    entry.units += row.quantity
    entry.issueIds.push(row.id)
    if (row.issuedAt > entry.lastIssuedAt) entry.lastIssuedAt = row.issuedAt
    byItem.set(row.ppeItemId, entry)
  }
  const step = leaver.steps.find((entry) => entry.kind === 'PPE_RETURNED') ?? null
  return {
    employee: { id: leaver.employee.id, name: leaver.employee.name },
    step: step ? { id: step.id, status: step.status, version: step.version, recordType: step.recordType, recordId: step.recordId } : null,
    held: [...byItem.values()].sort((a, b) => a.code.localeCompare(b.code)).map((entry) => ({ ...entry, lastIssuedAt: toUtcIso(entry.lastIssuedAt) })),
    receipts: receiptsOf(standing).map((receipt) => ({ receiptId: receipt.receiptId, issuedAt: toUtcIso(receipt.rows[0]!.issuedAt), method: receipt.rows[0]!.method as PpeReceiptMethod, units: receipt.rows.reduce((sum, row) => sum + row.quantity, 0) })),
    canManage: canManage && may(context, PEOPLE_LEAVERS_MANAGE, { companyId: leaver.employee.companyId, siteId: leaver.employee.site.id }),
  }
}

/** POST /people/leavers/:caseId/steps/:stepId/ppe-returned. */
export async function markPpeReturned(caller: CommandCaller, caseId: string, stepId: string, body: { readonly version: number; readonly issueId: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { leaver } = await leaverRecord(caller, caseId)
  assertMayWrite(context, PEOPLE_LEAVERS_MANAGE, { companyId: leaver.employee.companyId, siteId: leaver.employee.site.id }, 'Leaver steps are kept by a role that keeps them (people.leavers.manage).')
  const step = leaver.steps.find((entry) => entry.id === stepId)
  if (!step) throw new NotFoundError('Leaver step not found.')
  if (step.kind !== 'PPE_RETURNED') refuse('NOT_PPE_STEP', PPE_REFUSALS.NOT_PPE_STEP)
  const issue = isUuid(body.issueId) ? heldIssueOf(await heldOf(caller, leaver.employeeId), leaver.employeeId, body.issueId) : null
  if (!issue) refuse('NOT_HELD', PPE_REFUSALS.NOT_HELD, 'issueId')
  return moveStep(caller, caseId, stepId, 'DONE', { version: body.version, recordType: RECORD_ISSUE, recordId: body.issueId }, idempotencyKey)
}
