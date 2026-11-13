import type { Prisma } from '@nexus/factory-db'
import { APPROVALS_DECIDE } from '@nexus/factory-domain/approvals/permissions'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { eventFor } from '@nexus/factory-domain/events/define'
import { INVENTORY_RECEIVE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import { events as followupEvents } from '@nexus/factory-domain/buying-followups/events'
import { z } from 'zod'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { askApproval, withdrawPending } from '../../../platform/approvals/engine'
// B-W2b-377: the kind reads only the database (the registry loads it); its words and code are shared.
import { HOLD_WORDS, KIND } from '../../../platform/approvals/kinds/receipt-over-tolerance'
import { decidersOf } from '../../../platform/approvals/store'
import { heldRoles } from '../../../platform/auth/roles/access'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { officeContextOf } from '../ledger/access'
import { receiptDetail } from '../receipts/read'
import { recordReceiptInCommand, type ReceiptBody } from '../receipts/record'
import { RECEIPT_COLUMNS } from '../receipts/store'

/**
 * A receipt line beyond its delivery tolerance waits for a yes (B-W2b-377; follow-up XF5:03; SCM-061; B-W2b-296's "Needs a
 * yes", B-W2b-354's "Beyond the tolerance"; B-W2b-363's GoodsReceiptLine.heldForApprovalAt and kind RECEIPT_OVER_TOLERANCE).
 *
 *   hold      the office records a receipt (POST /inventory/receipts) whose line brings more than its tolerance over, and the
 *             tolerance says APPROVAL (with the receiver's reason, as W1 asks for any extra): instead of a refusal the receipt
 *             is written OPEN with its lines, each such line held (`heldForApprovalAt` now) and asking a RECEIPT_OVER_TOLERANCE
 *             yes (the engine: a switched-on rule names who decides; else the office role that decides purchase orders);
 *             nothing reaches the ledger, no lot is made, the order does not move. 202 with the waiting receipt and its
 *             requests. The receipt as sent is kept on its audit row (inventory.receiptHeld) to be posted as it was.
 *   yes       the line's hold is cleared (the approver's command); the last one emits inventory.receipt_released and the
 *             worker posts the receipt for the person who recorded it, exactly as sent (records.ts recordReceiptInCommand
 *             with `held`): lots, moves, POSTED, the order moved on. A posting refused then (a closed month, rights) stays
 *             OPEN: the receiver posts it with POST /inventory/receipts/:receiptId/post once it can go.
 *   no        the line stays held: the receipt is not posted; the receiver cancels it (POST …/cancel) and receives within the
 *             tolerance (a "correction" is a new receipt: what came is never changed in place after the yes was asked)
 *   post      a held line answers 409 in words before the database's refusal (GoodsReceipt_held_lines: posted only while no
 *             line is held)
 *
 * The goods-in tablet (the floor's command, no approval grants) and goods without a PO keep refusing the extra beyond a
 * tolerance that needs a yes, in words: the office records it to ask the yes.
 */

export const HELD_ACTION = 'inventory.receiptHeld'
const [heldEvent] = followupEvents

// ---- the hold, inside the receipt's command ------------------------------------------------------------------------------

export interface HeldLine {
  readonly lineId: string
  readonly seq: number
  readonly taskId: string
}

/**
 * The office role that decides a receipt beyond its tolerance when no rule names one: a role holding purchasing.manage and
 * approvals.decide (the buyer's template; the Owner's role last), the first with someone other than the receiver who may
 * decide at the receipt's place; else the first such role; none → null.
 */
async function deciderRoleOf(tools: CommandTools, place: { readonly companyId: string; readonly siteId: string }, askers: readonly string[]): Promise<string | null> {
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : undefined
  if (!tenantId) return null
  const roles = await tools.tx.role.findMany({ where: { audience: 'OFFICE', permissions: { hasEvery: [PURCHASING_MANAGE, APPROVALS_DECIDE] } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, key: true } })
  const ordered = [...roles.filter((role) => role.key !== 'owner'), ...roles.filter((role) => role.key === 'owner')]
  for (const role of ordered) if ((await decidersOf(tools.tx, tenantId, { approverRoleId: role.id, approverUserId: null }, place, askers, tools.now)).length > 0) return role.id
  return ordered[0]?.id ?? null
}

/**
 * The receipt (OPEN, its lines written, the held ones with `heldForApprovalAt`) asks a yes per held line, in the receipt's
 * command. The receipt as sent is kept on its audit row; inventory.receipt_held tells the screens.
 */
export async function holdReceiptInCommand(tools: CommandTools, input: { readonly receipt: { readonly id: string; readonly number: string; readonly companyId: string; readonly siteId: string; readonly purchaseOrderId: string }; readonly body: ReceiptBody; readonly held: readonly { readonly lineId: string; readonly seq: number; readonly reason: string }[] }): Promise<HeldLine[]> {
  const context = tools.context
  if (context.audience !== 'office') throw new InvalidStateError('A receipt beyond its tolerance waits for a yes only when the office records it.')
  const roleId = await deciderRoleOf(tools, input.receipt, [context.actorId])
  const out: HeldLine[] = []
  for (const line of input.held) {
    const asked = await askApproval(tools, { kind: KIND, recordId: line.lineId, requester: { userId: context.actorId }, note: line.reason, ...(roleId ? { whenNoRule: { approverRoleId: roleId, requireStepUp: false } } : {}) })
    if (!asked.asked) throw new DomainError('conflict', HOLD_WORDS.noDecider, [{ path: 'refusal/NO_APPROVER', message: HOLD_WORDS.noDecider }])
    out.push({ lineId: line.lineId, seq: line.seq, taskId: asked.taskId })
  }
  tools.audit({
    action: HELD_ACTION,
    recordType: 'GoodsReceipt',
    recordId: input.receipt.id,
    companyId: input.receipt.companyId,
    siteId: input.receipt.siteId,
    after: { number: input.receipt.number, status: 'OPEN', purchaseOrderId: input.receipt.purchaseOrderId, held: out.map((line) => ({ ...line })), body: JSON.parse(JSON.stringify(input.body)) as Prisma.InputJsonObject },
  })
  tools.emit(eventFor(heldEvent, { subject: input.receipt.id, companyId: input.receipt.companyId, siteId: input.receipt.siteId, payload: { receiptId: input.receipt.id, number: input.receipt.number, purchaseOrderId: input.receipt.purchaseOrderId, lines: out.length } }))
  return out
}

/** The 409 in words when a receipt with a held line would be posted (before the database's refusal). */
export async function refuseHeldLines(tx: Pick<CommandTx, 'goodsReceiptLine'>, receiptId: string): Promise<void> {
  const held = await tx.goodsReceiptLine.findMany({ where: { receiptId, heldForApprovalAt: { not: null } }, select: { seq: true } })
  if (held.length > 0) throw new DomainError('conflict', HOLD_WORDS.held(held.length), held.map((line) => ({ path: `lines/${line.seq}/held`, message: HOLD_WORDS.held(1) })))
}

// ---- posting a released receipt ------------------------------------------------------------------------------------------

/** The receipt as it was sent, from its hold's audit row (null: it was never held). */
async function heldBodyOf(tx: Pick<CommandTx, 'auditLog'>, receiptId: string): Promise<ReceiptBody | null> {
  const row = await tx.auditLog.findFirst({ where: { recordType: 'GoodsReceipt', recordId: receiptId, action: HELD_ACTION }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { after: true } })
  const body = (row?.after as { body?: unknown } | null)?.body
  return body && typeof body === 'object' ? (body as ReceiptBody) : null
}

/** Posts a waiting receipt whose lines are all approved, exactly as it was sent, inside the caller's command. */
async function postInCommand(tools: CommandTools, receiptId: string, key: string) {
  const receipt = await tools.tx.goodsReceipt.findUnique({ where: { id: receiptId }, select: { id: true, number: true, status: true, purchaseOrderId: true } })
  if (!receipt) throw new NotFoundError('Goods receipt not found.')
  if (receipt.status !== 'OPEN') throw new InvalidStateError(HOLD_WORDS.notOpen)
  await refuseHeldLines(tools.tx, receiptId)
  const refusedOne = await tools.tx.approvalTask.count({ where: { kind: KIND, status: 'REJECTED', recordId: { in: (await tools.tx.goodsReceiptLine.findMany({ where: { receiptId }, select: { id: true } })).map((line) => line.id) } } })
  if (refusedOne > 0) throw new InvalidStateError(HOLD_WORDS.refused)
  const body = await heldBodyOf(tools.tx, receiptId)
  if (!body) throw new InvalidStateError(HOLD_WORDS.noBody)
  return recordReceiptInCommand(tools, body, key, { held: { receiptId: receipt.id, number: receipt.number } })
}

/** POST /inventory/receipts/:receiptId/post (inventory.receive): a waiting receipt posted once its lines have their yes. */
export async function postHeldReceipt(caller: CommandCaller, receiptId: string, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const receipt = isUuid(receiptId) ? await caller.withClient((client) => client.goodsReceipt.findUnique({ where: { id: receiptId }, select: { companyId: true, siteId: true } })) : null
  if (!receipt || !can(actorOf(context), INVENTORY_STOCK_VIEW, receipt)) throw new NotFoundError('Goods receipt not found.')
  if (!can(actorOf(context), INVENTORY_RECEIVE, receipt)) throw new ForbiddenError('Receiving goods at this site needs inventory.receive.')
  const { result } = await command(caller, { name: 'inventory.postHeldReceipt', idempotencyKey, input: { receiptId } }, async (tools) => {
    const recorded = await postInCommand(tools, receiptId, `inventory.postHeldReceipt:${idempotencyKey ?? receiptId}`)
    const row = (await tools.tx.goodsReceipt.findUnique({ where: { id: recorded.receiptId }, select: RECEIPT_COLUMNS }))!
    return { receipt: await receiptDetail(tools.tx, tools.context, row), notes: recorded.notes, moves: recorded.moves, held: [] as HeldLine[] }
  })
  return result
}

/** POST /inventory/receipts/:receiptId/cancel (inventory.receive): a receipt still waiting is cancelled; its requests withdrawn. */
export async function cancelHeldReceipt(caller: CommandCaller, receiptId: string, body: { readonly reason: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = isUuid(receiptId) ? await caller.withClient((client) => client.goodsReceipt.findUnique({ where: { id: receiptId }, select: { companyId: true, siteId: true } })) : null
  if (!seen || !can(actorOf(context), INVENTORY_STOCK_VIEW, seen)) throw new NotFoundError('Goods receipt not found.')
  if (!can(actorOf(context), INVENTORY_RECEIVE, seen)) throw new ForbiddenError('Receiving goods at this site needs inventory.receive.')
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'inventory.cancelHeldReceipt', idempotencyKey, input: { receiptId, ...body } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT id FROM "GoodsReceipt" WHERE id = ${receiptId}::uuid FOR UPDATE`
    const receipt = (await tools.tx.goodsReceipt.findUnique({ where: { id: receiptId }, select: RECEIPT_COLUMNS }))!
    if (receipt.status !== 'OPEN') throw new InvalidStateError(HOLD_WORDS.notOpen)
    if (!(await heldBodyOf(tools.tx, receiptId))) throw new InvalidStateError(HOLD_WORDS.noBody)
    const lines = await tools.tx.goodsReceiptLine.findMany({ where: { receiptId }, select: { id: true } })
    for (const line of lines) await withdrawPending(tools, { kind: KIND, recordId: line.id, byId: context.actorId, words: reason })
    await tools.tx.goodsReceipt.update({ where: { id: receiptId }, data: { status: 'CANCELLED', cancelledAt: tools.now, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'inventory.cancelHeldReceipt', recordType: 'GoodsReceipt', recordId: receiptId, companyId: receipt.companyId, siteId: receipt.siteId, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason })
    const row = (await tools.tx.goodsReceipt.findUnique({ where: { id: receiptId }, select: RECEIPT_COLUMNS }))!
    return { receipt: await receiptDetail(tools.tx, tools.context, row) }
  })
  return result
}

// ---- the worker: posted for the receiver after the last yes --------------------------------------------------------------

export const RELEASED_RECEIPT_HANDLER = 'inventory.postReleasedReceipt'
const releasedPayload = z.object({ receiptId: z.uuid(), number: z.string(), purchaseOrderId: z.uuid() })

/** The person who recorded it, as their live roles make them now, over the system's client (one who left: no grants). */
async function asPerson(system: CommandCaller, userId: string, now: Date): Promise<CommandCaller> {
  const base = system.factoryContext
  if (!base || !('tenantId' in base) || !base.tenantId) throw new Error('inventory.postReleasedReceipt: a caller outside a tenant')
  const grants = await system.withClient(async (client) => {
    const user = await client.user.findUnique({ where: { id: userId }, select: { requireMfa: true, status: true } })
    if (!user || user.status !== 'ACTIVE') return []
    return sessionGrants(user, await heldRoles(client, userId, now), true)
  })
  const context: OfficeContext = Object.freeze({ audience: 'office', tenantId: base.tenantId, actorId: userId, grants, requestId: base.requestId })
  return { factoryContext: context, withClient: (work) => system.withClient(work) }
}

/**
 * The receipt released by its last yes, posted for the person who recorded it (their rights now) in ONE command keyed by the
 * receipt; a refusal in words leaves it OPEN with an audit row (the receiver posts it with …/post). Also called by tests.
 */
export async function postReleased(system: CommandCaller, event: { readonly eventId: string; readonly payload: unknown }): Promise<'POSTED' | 'HELD' | 'SETTLED'> {
  const { receiptId } = releasedPayload.parse(event.payload)
  const receipt = await system.withClient((client) => client.goodsReceipt.findUnique({ where: { id: receiptId }, select: { id: true, status: true, companyId: true, siteId: true, createdById: true } }))
  if (!receipt || receipt.status !== 'OPEN' || !receipt.createdById) return 'SETTLED'
  const person = await asPerson(system, receipt.createdById, serverClock.now())
  try {
    await command(person, { name: 'inventory.postReleasedReceipt', idempotencyKey: `receipt-released-${receiptId}`, input: { receiptId } }, async (tools) => {
      if (!can(actorOf(officeContextOf(person)), INVENTORY_RECEIVE, receipt)) throw new ForbiddenError('Receiving goods at this site needs inventory.receive.')
      const recorded = await postInCommand(tools, receiptId, `receipt-released-${receiptId}`)
      return { receiptId: recorded.receiptId }
    })
    return 'POSTED'
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    await command(system, { name: 'inventory.postReleasedReceiptHeld', idempotencyKey: `receipt-released-held-${event.eventId}`, input: { receiptId } }, async (tools) => {
      tools.audit({ action: 'inventory.postReleasedReceiptHeld', recordType: 'GoodsReceipt', recordId: receiptId, companyId: receipt.companyId, siteId: receipt.siteId, after: { status: 'OPEN', code: error.code, words: error.message } })
      return { held: true }
    })
    return 'HELD'
  }
}

export function releasedReceiptHandler(): EventHandler {
  return defineHandler({
    name: RELEASED_RECEIPT_HANDLER,
    events: ['inventory.receipt_released'],
    async handle(event, tools) {
      await postReleased(tools.caller, event)
    },
  })
}
