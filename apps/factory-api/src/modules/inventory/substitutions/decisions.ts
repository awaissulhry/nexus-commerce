import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { INVENTORY_ISSUE } from '@nexus/factory-domain/inventory/permissions'
import { SUBSTITUTION_LIMITS, withdrawRefusal, type SubstitutionStatus } from '@nexus/factory-domain/inventory/substitutions/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { withdrawPending } from '../../../platform/approvals/engine'
import { mayAt, officeContextOf } from '../ledger/access'
import { changed, lockSubstitution, readSubstitution, refuse, substitutionViews, SUBSTITUTION_COLUMNS, type SubstitutionRow } from './store'

/**
 * A substitute's yes, no and withdrawal (B-W2b-298; MES-139). The yes and the no come from the approval engine (the kind file
 * platform/approvals/kinds/material-substitution.ts calls these in the approver's command, the approver's scope): WAITING →
 * APPROVED with who said yes, or REFUSED with who said no and why (the request's reason words). A request taken back in Home ›
 * Approvals, or found changed since it was asked (its approval task is named once), withdraws the substitution with why: ask
 * again. The office withdraws a WAITING or APPROVED one itself (POST /inventory/substitutions/:id/withdraw, inventory.issue at
 * the site, with the reason): its pending request is withdrawn with it. Nobody decides their own request (the engine refuses
 * it; the database too).
 */

async function companyOf(tools: Pick<CommandTools, 'tx'>, row: SubstitutionRow): Promise<string> {
  return (await tools.tx.workOrder.findUnique({ where: { id: row.workOrderId }, select: { companyId: true } }))?.companyId ?? ''
}

async function written(tools: CommandTools, id: string, data: Prisma.MaterialSubstitutionUncheckedUpdateInput): Promise<SubstitutionRow> {
  return tools.tx.materialSubstitution.update({ where: { id }, data: { ...data, version: { increment: 1 }, updatedAt: tools.now }, select: SUBSTITUTION_COLUMNS })
}

function audited(tools: CommandTools, before: SubstitutionRow, after: SubstitutionRow, companyId: string, action: string, reason?: string | null): void {
  tools.audit({
    action,
    recordType: 'MaterialSubstitution',
    recordId: after.id,
    companyId,
    siteId: after.siteId,
    before: { status: before.status, decidedById: before.decidedById, approvalTaskId: before.approvalTaskId },
    after: { status: after.status, decidedById: after.decidedById, approvalTaskId: after.approvalTaskId, refuseReason: after.refuseReason, withdrawReason: after.withdrawReason },
    ...(reason ? { reason } : {}),
  })
}

/** The engine's yes: WAITING → APPROVED, decided by the approver (never the person who asked: the engine and the database). */
export async function approvedByEngine(tools: CommandTools, substitutionId: string, deciderId: string | null): Promise<void> {
  const row = await lockSubstitution(tools.tx, substitutionId)
  if (!row || row.status !== 'WAITING') return
  const after = await written(tools, row.id, { status: 'APPROVED', decidedAt: tools.now, decidedById: deciderId })
  const companyId = await companyOf(tools, row)
  audited(tools, row, after, companyId, 'inventory.substitute.approved')
  changed(tools, after, companyId, 'APPROVED')
}

/** The engine's no: WAITING → REFUSED, with who said no and why (the request's reason code and words). */
export async function refusedByEngine(tools: CommandTools, substitutionId: string, deciderId: string, why: string): Promise<void> {
  const row = await lockSubstitution(tools.tx, substitutionId)
  if (!row || row.status !== 'WAITING') return
  const words = [...why.trim()].slice(0, SUBSTITUTION_LIMITS.reason).join('') || 'Refused.'
  const after = await written(tools, row.id, { status: 'REFUSED', decidedAt: tools.now, decidedById: deciderId, refuseReason: words })
  const companyId = await companyOf(tools, row)
  audited(tools, row, after, companyId, 'inventory.substitute.refused', words)
  changed(tools, after, companyId, 'REFUSED')
}

/** The request taken back, or found changed: a WAITING substitution is withdrawn with why (ask again). */
export async function withdrawnByEngine(tools: CommandTools, substitutionId: string, why: string): Promise<void> {
  const row = await lockSubstitution(tools.tx, substitutionId)
  if (!row || row.status !== 'WAITING') return
  const after = await written(tools, row.id, { status: 'WITHDRAWN', withdrawnAt: tools.now, withdrawReason: why.slice(0, SUBSTITUTION_LIMITS.withdrawReason) })
  const companyId = await companyOf(tools, row)
  audited(tools, row, after, companyId, 'inventory.substitute.withdrawn', why)
  changed(tools, after, companyId, 'WITHDRAWN')
}

export interface WithdrawInput {
  readonly version: number
  readonly reason: string
}

/** POST /inventory/substitutions/:id/withdraw: the office takes a WAITING or APPROVED substitute back, with the reason. */
export async function withdrawSubstitute(caller: CommandCaller, substitutionId: string, body: WithdrawInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const found = await caller.withClient((db) => readSubstitution(db, substitutionId))
  const header = found ? await caller.withClient((db) => db.workOrder.findUnique({ where: { id: found.workOrderId }, select: { companyId: true, siteId: true } })) : null
  if (!found || !header || !mayAt(context, INVENTORY_ISSUE, header)) throw new NotFoundError('Substitute not found.')
  const { result } = await command(caller, { name: 'inventory.substitute', idempotencyKey, input: { substitutionId, ...body } }, async (tools) => {
    const row = await lockSubstitution(tools.tx, substitutionId)
    if (!row) throw new NotFoundError('Substitute not found.')
    if (row.version !== body.version) {
      throw new DomainError('conflict', 'This substitute changed since you looked: read it again.', [{ path: 'body/version', message: `Now version ${row.version}.` }])
    }
    refuse(withdrawRefusal(row.status as SubstitutionStatus))
    const reason = body.reason.trim()
    const after = await written(tools, row.id, { status: 'WITHDRAWN', withdrawnAt: tools.now, withdrawReason: reason })
    await withdrawPending(tools, { kind: 'MATERIAL_SUBSTITUTION', recordId: row.id, byId: context.actorId, words: reason })
    audited(tools, row, after, header.companyId, 'inventory.substitute.withdraw', reason)
    changed(tools, after, header.companyId, 'WITHDRAWN')
    const [view] = await substitutionViews(tools.tx, [after])
    return { substitution: view! }
  })
  return result
}
