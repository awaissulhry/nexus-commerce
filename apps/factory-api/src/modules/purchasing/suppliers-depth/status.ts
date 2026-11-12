import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { cleanReason, NO_NEW_ORDER, STATUS_WORDS, statusChangeProblems, type SupplierStatus } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import { PURCHASING_SUPPLIERS_STATUS } from '@nexus/factory-domain/purchasing/suppliers-depth/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMayWrite, assertWritable, contextOf } from '../../parties/store'
import type { Reader } from '../store'
import { nameOf, readSupplier, readSupplierRow, type SupplierRow } from './store'
import { supplierView } from './view'

/**
 * Where a supplier stands with us (B-W2b-311; SCM-008; design purchasing.suppliers › "Now" status pill and since when, the
 * Block confirm's reach): purchasing.suppliers.status over the supplier's company and itself. PROSPECT → APPROVED |
 * CONDITIONAL → ON_HOLD | BLOCKED → … INACTIVE (factory-domain STATUS_MOVES), a reason for CONDITIONAL, ON_HOLD and
 * BLOCKED; the same status with a new reason corrects the reason only (the time and the person stay). A change records
 * when and by whom (the …_suppliers_depth_w2b_guards trigger: later than the last, an active office user). ON_HOLD, BLOCKED
 * and INACTIVE stop new purchase orders and hold the drafts at their send (purchasing orders.ts / send checks); sent
 * orders run on. W1's Block (parties.block) stays beside it. Audited; supplier.status_changed.
 */

export interface StatusBody {
  readonly version: number
  readonly status: SupplierStatus
  readonly reason?: string | null | undefined
}

const prefixed = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))

/** Inside a command (the party locked or guarded): the status set, with its audit row and event. Answers whether it moved. */
export async function setStatusInCommand(tools: CommandTools, row: SupplierRow, to: SupplierStatus, reason: string | null, by: string | null): Promise<{ readonly moved: boolean }> {
  const from = row.supplierStatus as SupplierStatus | null
  const moved = from !== to
  await tools.tx.party.update({
    where: { id: row.id },
    data: { supplierStatus: to, supplierStatusReason: reason, ...(moved ? { supplierStatusChangedAt: tools.now, supplierStatusChangedById: by } : {}) },
    select: { id: true },
  })
  tools.audit({ action: 'purchasing.suppliers.status', recordType: 'Party', recordId: row.id, companyId: row.companyId, before: { supplierStatus: from, reason: row.supplierStatusReason }, after: { supplierStatus: to, reason } })
  tools.emit({ type: 'supplier.status_changed', subject: row.id, companyId: row.companyId, payload: { partyId: row.id, code: row.code, from, status: to } })
  return { moved }
}

/** purchasing.suppliers.status: the supplier's status and reason. */
export async function setStatus(caller: CommandCaller, partyId: string, body: StatusBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const seen = await readSupplier(caller, partyId)
  assertMayWrite(context, PURCHASING_SUPPLIERS_STATUS, seen)
  assertWritable(seen.status)
  const reasonOf = (row: SupplierRow) => (body.reason !== undefined ? cleanReason(body.reason) : body.status === row.supplierStatus ? row.supplierStatusReason : null)
  const problems = statusChangeProblems(seen.supplierStatus as SupplierStatus | null, body.status, reasonOf(seen))
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, prefixed(problems))

  const { result } = await command(
    caller,
    { name: 'purchasing.suppliers.status', idempotencyKey, input: { partyId, ...body }, record: { type: 'Party', id: partyId, expectedVersion: body.version } },
    async (tools) => {
      const row = (await readSupplierRow(tools.tx, partyId))!
      assertWritable(row.status)
      const reason = reasonOf(row)
      const again = statusChangeProblems(row.supplierStatus as SupplierStatus | null, body.status, reason)
      if (again.length > 0) throw new ValidationError(again[0]!.message, prefixed(again))
      await setStatusInCommand(tools, row, body.status, reason, context.audience === 'office' ? context.actorId : null)
      return { supplier: await supplierView(tools.tx, (await readSupplierRow(tools.tx, partyId))!, tools.now) }
    },
  )
  return result
}

/** The orders a status change reaches: drafts (or waiting for a yes) held at the send, sent and still open ones unchanged. */
export async function reachOf(db: Reader, row: SupplierRow, to: SupplierStatus) {
  const drafts = await db.purchaseOrder.count({ where: { partyId: row.id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } } })
  const open = await db.purchaseOrder.count({ where: { partyId: row.id, status: { in: ['SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED'] } } })
  const stops = NO_NEW_ORDER.includes(to) || to === 'PROSPECT'
  const draftsHeld = stops ? drafts : 0
  const orders = (count: number, what: string) => `${count} ${what} purchase order${count === 1 ? '' : 's'}`
  const sentence = stops
    ? `${nameOf(row)} ${to === 'PROSPECT' ? 'as a prospect gets sample orders only' : `${STATUS_WORDS[to]} gets no new purchase order`}: ${orders(draftsHeld, 'draft')} held at the send, ${orders(open, 'sent')} unchanged; receipts go on.`
    : `${nameOf(row)} ${STATUS_WORDS[to]} may get new purchase orders: ${orders(drafts, 'draft')} can be sent, ${orders(open, 'sent')} unchanged.`
  return { status: to, draftsHeld, openUnchanged: open, sentence }
}

/** parties.view: what a status change would reach (the confirm dialog's "Reach"). */
export async function statusReach(caller: CommandCaller, partyId: string, status: SupplierStatus) {
  const row = await readSupplier(caller, partyId)
  return { reach: await caller.withClient((client) => reachOf(client, row, status)) }
}
