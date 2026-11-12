import { createHash } from 'node:crypto'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { can, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { INVENTORY_UNPLANNED_DECIDE } from '@nexus/factory-domain/inventory/unplanned/permissions'
import { buyerTaskWords } from '@nexus/factory-domain/inventory/unplanned/rules'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { mayBeAssigned } from '../../../platform/tasks/tasks'
import { followInCommand } from '../../../platform/threads/followers'
import { asTenantSystem } from '../../production/bundles/codes'
import { buyerTaskIdOf, lockUnplanned, readUnplannedLines, type UnplannedRow } from './store'

/**
 * The buyer's task of goods without a purchase order (B-W2b-300; SCM-122 "a buyer task asks for the PO or a return"): ONE task
 * on the receipt (platform/tasks' Task, recordType GoodsReceipt), due the day the goods came, named on the receipt once
 * (GoodsReceipt.buyerTaskId: the office's or the system's, never a floor session's — the database refuses it).
 *
 * Who: the person who last made a purchase order to that supplier for the receipt's company (they know what was asked), else the
 * first ACTIVE person by name who may decide on goods without a PO there (inventory.unplanned.decide), each only when platform/tasks
 * may give them a task on the receipt (`mayBeAssigned`: home, tasks.manage, threads.read over it). Nobody: the task waits
 * unassigned on the receipt (its record panel shows it). The task's id is derived from the receipt: it is asked once.
 *
 * After the floor's receipt commits, the system asks it in a command of its own (the floor role may not write tasks), keyed by
 * the floor request's key (a resend of the request mends a task never asked). The office asks again with
 * POST /inventory/unplanned/:id/buyer when that failed.
 */

const [taskCreated, taskAssigned, taskCompleted] = taskEvents

type Tools = Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit' | 'context'>

/** The person the task goes to, or null. */
export async function buyerFor(tools: Tools, receipt: Pick<UnplannedRow, 'id' | 'companyId' | 'siteId' | 'supplierId'>): Promise<string | null> {
  const { tx, now } = tools
  const tenantId = tools.context.audience === 'platform' ? '' : tools.context.tenantId
  const scope: ScopedRecord = { companyId: receipt.companyId, siteId: receipt.siteId, partyId: receipt.supplierId }
  const orders = await tx.purchaseOrder.findMany({ where: { companyId: receipt.companyId, partyId: receipt.supplierId, createdById: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5, select: { createdById: true } })
  for (const maker of [...new Set(orders.map((order) => order.createdById!))]) if (await mayBeAssigned(tx, tenantId, maker, scope, true, now)) return maker
  const people = await tx.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: 200, select: { id: true } })
  for (const person of people) {
    const actor = { audience: 'office' as const, tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(tx, person.id, now), true) }
    if (can(actor, INVENTORY_UNPLANNED_DECIDE, scope) && (await mayBeAssigned(tx, tenantId, person.id, scope, true, now))) return person.id
  }
  return null
}

/**
 * Inside a command (system or office): the buyer's task of an OPEN receipt, made once and named on it. Answers its id (null:
 * the receipt is no longer waiting). `by` is the office user who asked (null: the system).
 */
export async function askBuyerInCommand(tools: Tools, receiptId: string, by: string | null): Promise<string | null> {
  const { tx, now } = tools
  const receipt = await lockUnplanned(tx, receiptId)
  if (!receipt || receipt.status !== 'OPEN') return null
  if (receipt.buyerTaskId) return receipt.buyerTaskId
  const taskId = buyerTaskIdOf(receipt.id)
  const scope = { companyId: receipt.companyId, siteId: receipt.siteId }
  const known = await tx.task.findUnique({ where: { id: taskId }, select: { id: true } })
  if (!known) {
    const assigneeId = await buyerFor(tools, receipt)
    const locale = assigneeId ? (await tx.user.findUnique({ where: { id: assigneeId }, select: { locale: true } }))?.locale : null
    const supplier = await tx.party.findUnique({ where: { id: receipt.supplierId }, select: { code: true, tradeName: true, legalName: true } })
    const place = receipt.holdingLocationId ? await tx.location.findUnique({ where: { id: receipt.holdingLocationId }, select: { code: true } }) : null
    const lines = (await readUnplannedLines(tx, receipt.id)).length
    const words = buyerTaskWords(locale, { number: receipt.number, supplier: supplier?.tradeName ?? supplier?.legalName ?? supplier?.code ?? '—', place: place?.code ?? '—', lines })
    await tx.task.create({
      data: {
        id: taskId,
        companyId: receipt.companyId,
        siteId: receipt.siteId,
        partyId: receipt.supplierId,
        title: words.title,
        description: words.description,
        recordType: 'GoodsReceipt',
        recordId: receipt.id,
        recordLabel: receipt.number,
        assigneeId,
        // Assignee, assigner and time come together (the table's rule); the system names nobody else, so the row names the
        // assignee as giving it (the event below says the system did: their bell rings).
        assignedById: assigneeId ? (by ?? assigneeId) : null,
        assignedAt: assigneeId ? now : null,
        dueDate: new Date(`${businessDate(receipt.receivedAt)}T00:00:00.000Z`),
        checklist: [],
        createdAt: now,
        updatedAt: now,
        createdById: by,
      },
      select: { id: true },
    })
    tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: taskId, ...scope, after: { title: words.title, assigneeId, status: 'OPEN', recordType: 'GoodsReceipt', recordId: receipt.id, by: 'unplanned' } })
    const about = { taskId, recordType: 'GoodsReceipt', recordId: receipt.id }
    tools.emit(eventFor(taskCreated, { subject: taskId, ...scope, payload: { ...about, assigneeId } }))
    if (assigneeId) {
      tools.emit(eventFor(taskAssigned, { subject: taskId, ...scope, payload: { ...about, assigneeId, assignedById: by } }))
      await followInCommand(tools, { type: 'GoodsReceipt', id: receipt.id, companyId: receipt.companyId, siteId: receipt.siteId }, assigneeId, 'ASSIGNEE', by)
    }
  }
  await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { buyerTaskId: taskId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'inventory.askBuyer', recordType: 'GoodsReceipt', recordId: receipt.id, ...scope, after: { buyerTaskId: taskId } })
  tools.emit({
    type: 'inventory.unplanned_changed',
    subject: receipt.id,
    ...scope,
    payload: { receiptId: receipt.id, number: receipt.number, change: 'BUYER_ASKED', supplierId: receipt.supplierId, holdingLocationId: receipt.holdingLocationId!, purchaseOrderId: null, buyerTaskId: taskId, lines: (await readUnplannedLines(tx, receipt.id)).length },
  })
  return taskId
}

/** Inside the command that names the order or sends the goods back: the buyer's task is done (by who decided). */
export async function closeBuyerTaskInCommand(tools: Tools, receipt: Pick<UnplannedRow, 'buyerTaskId' | 'companyId' | 'siteId'>, by: string | null): Promise<boolean> {
  if (!receipt.buyerTaskId) return false
  const { tx, now } = tools
  const row = await tx.task.findUnique({ where: { id: receipt.buyerTaskId }, select: { id: true, status: true, recordType: true, recordId: true } })
  if (!row || row.status !== 'OPEN') return false
  const { count } = await tx.task.updateMany({ where: { id: row.id, status: 'OPEN' }, data: { status: 'DONE', closedAt: now, closedById: by, snoozedUntil: null, version: { increment: 1 }, updatedAt: now } })
  if (count === 0) return false
  const scope = { companyId: receipt.companyId, siteId: receipt.siteId }
  tools.audit({ action: 'tasks.status', recordType: 'Task', recordId: row.id, ...scope, before: { status: 'OPEN' }, after: { status: 'DONE', by: 'unplanned' } })
  tools.emit(eventFor(taskCompleted, { subject: row.id, ...scope, payload: { taskId: row.id, recordType: row.recordType, recordId: row.recordId } }))
  return true
}

/** The follow-up's key, one per floor request key (keys are at most 128 characters: a digest of it). */
export const askKeyOf = (floorKey: string): string => `unplanned-buyer.${createHash('sha256').update(floorKey).digest('hex').slice(0, 48)}`

/** Right after the floor's receipt commits: the buyer asked, as the tenant's system (the floor may not write tasks). */
export async function askBuyerAfterFloor(caller: CommandCaller, context: FloorContext, receiptId: string, floorKey: string): Promise<string | null> {
  const { result } = await command(asTenantSystem(caller, context), { name: 'inventory.askBuyer', idempotencyKey: askKeyOf(floorKey), input: { receiptId } }, (tools) => askBuyerInCommand(tools, receiptId, null))
  return result
}
