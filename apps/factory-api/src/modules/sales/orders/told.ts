import { z } from 'zod'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { batchGroupKey, orderChangeBatch } from '@nexus/factory-domain/notifications/rules'
import { effectiveSupervisor } from '@nexus/factory-domain/production-brand/supervisor'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayOnThread, wallScopeOf } from '../../../platform/threads/records'
import { customerDefaultsOf, orderSupervisorsOf } from '../../production/supervisor/resolver'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import { officeContextOf } from './access'
import { ORDER_CHANGE_NOTES_HANDLER } from './change-notes'
import type { Speaker } from './change-notes' // B-OC-009
import { officeOrder } from './moves'

/**
 * B-SA-056 (sales page plan P8, R2, R8; 14-change-flow §4.1 "Told: …", §5.2 "Who was told"; review WP-1, WP-2) — who was TOLD about
 * one change of a sales order, never who READ it (no read receipts for anyone, the floor least of all: Statuto dei Lavoratori art. 4):
 *
 *   GET /sales/orders/:orderId/told?batchId=<the change's correlation>   or   ?messageId=<its system line>
 *
 *   people     the office people the change's ONE bell item reached (B-SA-051: the notification rows of the change's batch on the
 *              order and on its noted work orders), by name (office staff, inside the record), grouped by why: the order's
 *              supervisor or the customer's backup · has a task on the order · follows the order · follows WO-… (the work order
 *              named only when the reader reaches it, else "a work order")
 *   floor      "Told the floor at hh:mm · WO-0142, WO-0143": when the floor notes were written and on which work orders (those the
 *              reader reaches by number; the others counted) — nothing about who or which station saw them (R2)
 *   workshop   "Told the workshop at hh:mm": the outside workshops of the open subcontract orders, when their notice was written
 *              (still waiting: counted)
 * Built from what the handler `sales.orderChangeNotes` wrote (its audit row on the order) and the notification rows. THE WALL: the
 * order with orders.view over its company and customer (else "Sales order not found.", the words of an unknown id) and its
 * conversation with threads.read (the line is a note of it; else the same words); office people only — never a contact of the
 * customer, never a portal person; a work order or a subcontract order the reader does not reach is counted, never named. A read:
 * nothing is written.
 */

export const TOLD_WHY = ['SUPERVISOR', 'TASK', 'FOLLOWS_ORDER', 'FOLLOWS_WORK_ORDER'] as const
export type ToldWhy = (typeof TOLD_WHY)[number]

/** The groups' words (the catalogue's: "Supervisore", "Sostituto", "Attività", "segue"). */
export const TOLD_WHY_WORDS: Readonly<Record<ToldWhy, { readonly it: string; readonly en: string }>> = Object.freeze({
  SUPERVISOR: { it: 'Supervisore o sostituto', en: 'Supervisor or backup' },
  TASK: { it: 'Ha un’attività', en: 'Has a task' },
  FOLLOWS_ORDER: { it: 'Segue l’ordine', en: 'Follows the order' },
  FOLLOWS_WORK_ORDER: { it: 'Segue un ordine di lavoro', en: 'Follows a work order' },
})

const NOT_FOUND = 'Change not found.'
const words = output({ it: z.string(), en: z.string() })
const workOrderRef = output({ id: id(), number: z.string() })

export const toldContract = defineContract({
  params: input({ orderId: id() }),
  querystring: input({
    /** The change: the correlation of the command that made it (its bell batch, B-SA-051). */
    batchId: z.string().trim().min(1).max(200).optional(),
    /** Or the change's system line (the thread's message). */
    messageId: id().optional(),
  }),
  response: {
    200: output({
      order: output({ id: id(), number: z.string() }),
      // F-SA-244: `requestId` — the customer's request the change carries out (null: the office's own change, or written before it).
      change: output({ batchId: z.string(), messageId: id(), at: instant(), requestId: id().nullable() }),
      people: output({
        count: z.number().int(),
        groups: z.array(output({ why: z.enum(TOLD_WHY), words, people: z.array(output({ id: id(), name: z.string(), workOrder: workOrderRef.nullable() })) })),
      }),
      floor: output({ at: instant().nullable(), workOrders: z.array(workOrderRef), leftOut: z.number().int() }),
      workshop: output({ at: instant().nullable(), subcontractOrders: z.array(output({ id: id(), number: z.string(), toldAt: instant().nullable() })), waiting: z.number().int(), leftOut: z.number().int() }),
    }),
  },
})

interface NotesRecord {
  readonly written?: boolean
  readonly messageId?: string
  /** F-SA-244: the event that spoke, when it happened, and the customer's request it carried out. */
  readonly eventType?: string
  readonly at?: string
  readonly requestId?: string | null
  /** Told of the same act by B-PR-32's notice (a withdrawal: the supervisor and the backup), not by the change's bell. */
  readonly alreadyTold?: readonly string[]
  readonly floor?: readonly { readonly workOrderId: string; readonly messageId: string }[]
  readonly workshops?: readonly { readonly subcontractOrderId: string; readonly workOrderId: string }[]
  /** B-OC-009: what spoke for the change (read with storedSpeakerOf; absent on a row written before). */
  readonly speaker?: unknown
}

/** GET /sales/orders/:orderId/told. */
export async function whoWasTold(caller: CommandCaller, orderId: string, query: { batchId?: string | undefined; messageId?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const order = await officeOrder(caller, orderId)
  if (!query.batchId && !query.messageId) throw new ValidationError('Name the change.', [{ path: 'querystring/batchId', message: 'Send batchId or messageId.' }])
  return caller.withClient(async (db) => {
    const thread = await db.thread.findFirst({ where: { recordType: 'SalesOrder', recordId: order.id }, select: { recordType: true, recordId: true, companyId: true, siteId: true, partyId: true } })
    if (!thread || !mayOnThread(actor, THREADS_READ, 'SalesOrder', await wallScopeOf(db, thread))) throw new NotFoundError(NOT_FOUND)
    // What the handler wrote for this change of this order (its own audit row on the order).
    const row = await db.auditLog.findFirst({
      where: { recordType: 'SalesOrder', recordId: order.id, action: ORDER_CHANGE_NOTES_HANDLER, ...(query.batchId ? { requestId: query.batchId } : { after: { path: ['messageId'], equals: query.messageId! } }) },
      orderBy: { at: 'desc' },
      select: { requestId: true, after: true },
    })
    const notes = (row?.after ?? {}) as NotesRecord
    if (!row || notes.written !== true || !notes.messageId) throw new NotFoundError(NOT_FOUND)
    const line = await db.message.findUnique({ where: { id: notes.messageId }, select: { id: true, at: true } })
    if (!line) throw new NotFoundError(NOT_FOUND)
    const batchId = row.requestId

    // The work orders the notes went on, read once (the reader names only those it reaches).
    const floorRows = notes.floor ?? []
    const shopRows = notes.workshops ?? []
    const workOrderIds = [...new Set([...floorRows.map((entry) => entry.workOrderId), ...shopRows.map((entry) => entry.workOrderId)])]
    const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true } }) : []).map((entry) => [entry.id, entry]))
    const reached = (workOrderId: string) => {
      const workOrder = workOrders.get(workOrderId)
      return workOrder && reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder) ? { id: workOrder.id, number: workOrder.number } : null
    }

    // People: the rows of the change's ONE bell item (office rows only: no party), on the order and its noted work orders.
    const told = await db.notification.findMany({
      where: { partyId: null, groupKey: batchGroupKey(orderChangeBatch(batchId, order.id), 'FOLLOWING'), OR: [{ recordType: 'SalesOrder', recordId: order.id }, ...(floorRows.length > 0 ? [{ recordType: 'WorkOrder', recordId: { in: floorRows.map((entry) => entry.workOrderId) } }] : [])] },
      select: { userId: true, recordType: true, recordId: true },
      orderBy: { createdAt: 'asc' },
    })
    const userIds = [...new Set([...told.map((entry) => entry.userId), ...(notes.alreadyTold ?? [])])]
    const names = new Map((userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds }, audience: 'OFFICE' }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))
    const defaults = (await customerDefaultsOf(db, [order.partyId])).get(order.partyId) ?? null
    const own = (await orderSupervisorsOf(db, [order.id])).get(order.id) ?? null
    const supervisors = new Set([effectiveSupervisor(own, defaults?.supervisorId ?? null).userId, defaults?.backupId ?? null].filter((entry): entry is string => entry !== null))
    const tasked = new Set(
      userIds.length > 0
        ? (await db.task.findMany({ where: { status: 'OPEN', assigneeId: { in: userIds }, OR: [{ recordType: 'SalesOrder', recordId: order.id }, ...(floorRows.length > 0 ? [{ recordType: 'WorkOrder', recordId: { in: floorRows.map((entry) => entry.workOrderId) } }] : [])] }, select: { assigneeId: true } })).flatMap((task) => (task.assigneeId ? [task.assigneeId] : []))
        : [],
    )
    const groups = new Map<ToldWhy, { id: string; name: string; workOrder: { id: string; number: string } | null }[]>()
    for (const userId of userIds) {
      const name = names.get(userId)
      if (name === undefined) continue
      const rows = told.filter((entry) => entry.userId === userId)
      const onOrder = rows.some((entry) => entry.recordType === 'SalesOrder')
      const why: ToldWhy = supervisors.has(userId) || (notes.alreadyTold ?? []).includes(userId) ? 'SUPERVISOR' : tasked.has(userId) ? 'TASK' : onOrder ? 'FOLLOWS_ORDER' : 'FOLLOWS_WORK_ORDER'
      const workOrder = why === 'FOLLOWS_WORK_ORDER' ? reached(rows.find((entry) => entry.recordType === 'WorkOrder')?.recordId ?? '') : null
      groups.set(why, [...(groups.get(why) ?? []), { id: userId, name, workOrder }])
    }
    const people = TOLD_WHY.flatMap((why) => {
      const list = groups.get(why)
      return list ? [{ why, words: TOLD_WHY_WORDS[why], people: [...list].sort((a, b) => a.name.localeCompare(b.name)) }] : []
    })

    // The floor: when the notes were written, on which work orders (never who saw them).
    const floorMessages = floorRows.length > 0 ? await db.message.findMany({ where: { id: { in: floorRows.map((entry) => entry.messageId) } }, select: { at: true } }) : []
    const floorAt = floorMessages.reduce<Date | null>((first, message) => (first === null || message.at < first ? message.at : first), null)
    const floorNamed = floorRows.flatMap((entry) => {
      const named = reached(entry.workOrderId)
      return named ? [named] : []
    })

    // The workshops: the notice of each open subcontract order (B-SA-054's partner rule), when it was written.
    const shopIds = shopRows.map((entry) => entry.subcontractOrderId)
    const shops = new Map((shopIds.length > 0 ? await db.subcontractOrder.findMany({ where: { id: { in: shopIds } }, select: { id: true, number: true, workOrderId: true } }) : []).map((entry) => [entry.id, entry]))
    const notices = shopIds.length > 0 ? await db.notification.findMany({ where: { recordType: 'SubcontractOrder', recordId: { in: shopIds }, partyId: { not: null }, eventType: 'production.floor_note_posted', createdAt: { gte: line.at } }, select: { recordId: true, createdAt: true } }) : []
    const toldAt = new Map<string, Date>()
    for (const notice of notices) if (!toldAt.has(notice.recordId) || notice.createdAt < toldAt.get(notice.recordId)!) toldAt.set(notice.recordId, notice.createdAt)
    const shopNamed = shopRows.flatMap((entry) => {
      const shop = shops.get(entry.subcontractOrderId)
      if (!shop || !reached(shop.workOrderId)) return []
      const at = toldAt.get(shop.id) ?? null
      return [{ id: shop.id, number: shop.number, toldAt: at ? toUtcIso(at) : null }]
    })
    const shopAt = [...toldAt.values()].reduce<Date | null>((first, at) => (first === null || at < first ? at : first), null)

    return {
      order: { id: order.id, number: order.number },
      change: { batchId, messageId: line.id, at: toUtcIso(line.at), requestId: notes.requestId ?? null /* F-SA-244 */ },
      people: { count: people.reduce((sum, group) => sum + group.people.length, 0), groups: people },
      floor: { at: floorAt ? toUtcIso(floorAt) : null, workOrders: floorNamed, leftOut: floorRows.length - floorNamed.length },
      workshop: { at: shopAt ? toUtcIso(shopAt) : null, subcontractOrders: shopNamed, waiting: shopRows.filter((entry) => !toldAt.has(entry.subcontractOrderId)).length, leftOut: shopRows.length - shopNamed.length },
    }
  })
}

// ---- F-SA-244 (sales page plan P8, R2, R7, R8; 14-change-flow §4.1, §5.2; 10-order-page §2.4 C5 "Told", §2.3): the told lines of
// ALL the order's changes in ONE read for the order page — each system line's card ("Told the floor at hh:mm", "Who was told",
// its Still to do by the request it carried out), History's "Told: conversation · bell to N people · floor note on WO-… ·
// workshop notice", the Production tab's "Told the floor at hh:mm" per work order and Overview's "Told about changes: N people".
// Counts and times only (the names stay in Who was told, above), never who read anything (R2); the same wall as above: the order
// with orders.view, its conversation with threads.read, office people only, a work order the reader does not reach counted, never
// named. A read: nothing is written.

/** The newest changes the page reads at once (older ones keep their line in the conversation; Who was told still reads each). */
export const TOLD_CHANGES_LIMIT = 50

// ── B-OC-009 (order changes tab R5 + R7; 13-backend §4): what spoke for each change, as the handler's audit row keeps it ──
export const SPEAKER_KINDS = ['REQUEST', 'AMENDED', 'LINES', 'CANCELLED', 'PROMISE', 'WORK_ORDER_CHANGE', 'HOLD', 'ECO'] as const

/**
 * The change's speaker (null: a line written before the row kept it): the customer's request it carried out (REQUEST), the office's
 * own revision (AMENDED), lines closed short or reopened (LINES), the order cancelled (CANCELLED), a new promise (PROMISE, from → to),
 * a work-order change applied or left as is (WORK_ORDER_CHANGE), a pause placed or lifted (HOLD: its work order named only when the
 * reader reaches it, else counted in `leftOut`), a change order released (ECO, by its number). Ids, codes and dates: never a person.
 */
const speakerView = output({
  kind: z.enum(SPEAKER_KINDS),
  requestId: id().optional(),
  amendmentId: id().optional(),
  change: z.enum(['CLOSED', 'REOPENED']).optional(),
  lineIds: z.array(id()).optional(),
  workOrderChangeId: id().optional(),
  from: z.string().nullable().optional(),
  to: z.string().optional(),
  hold: output({ placed: z.boolean(), workOrder: workOrderRef.nullable(), leftOut: z.number().int() }).optional(),
  changeOrder: output({ number: z.string() }).nullable().optional(),
})

const textOf = (row: Readonly<Record<string, unknown>>, key: string): string | null => (typeof row[key] === 'string' ? (row[key] as string) : null)

/** A speaker as the audit row kept it (null: none kept — a row written before — or one this read does not know). Pure. */
export function storedSpeakerOf(value: unknown): Speaker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Readonly<Record<string, unknown>>
  const requestId = textOf(row, 'requestId')
  const amendmentId = textOf(row, 'amendmentId')
  const changeId = textOf(row, 'changeId')
  const holdId = textOf(row, 'holdId')
  const changeOrderId = textOf(row, 'changeOrderId')
  const to = textOf(row, 'to')
  const change = row.change
  const lineIds = row.lineIds
  const placed = row.placed
  switch (row.kind) {
    case 'REQUEST':
      return requestId ? { kind: 'REQUEST', requestId } : null
    case 'AMENDED':
      return amendmentId ? { kind: 'AMENDED', amendmentId } : null
    case 'LINES':
      return (change === 'CLOSED' || change === 'REOPENED') && Array.isArray(lineIds) ? { kind: 'LINES', change, lineIds: lineIds.filter((entry): entry is string => typeof entry === 'string') } : null
    case 'CANCELLED':
      return { kind: 'CANCELLED' }
    case 'PROMISE':
      return to ? { kind: 'PROMISE', from: textOf(row, 'from'), to } : null
    case 'WORK_ORDER_CHANGE':
      return changeId ? { kind: 'WORK_ORDER_CHANGE', changeId } : null
    case 'HOLD':
      return holdId && typeof placed === 'boolean' ? { kind: 'HOLD', holdId, placed } : null
    case 'ECO':
      return changeOrderId ? { kind: 'ECO', changeOrderId } : null
    default:
      return null
  }
}

/** What the speaker's view reads beside it: a hold's work order, whether the reader reaches it, a change order's number. */
export interface SpeakerFacts {
  readonly holdWorkOrderOf: (holdId: string) => string | undefined
  readonly reached: (workOrderId: string) => { readonly id: string; readonly number: string } | null
  readonly changeOrderNumberOf: (changeOrderId: string) => string | undefined
}

/** The speaker as the read answers it (null: none kept). Pure. */
export function speakerViewOf(speaker: Speaker | null, facts: SpeakerFacts) {
  if (!speaker) return null
  switch (speaker.kind) {
    case 'REQUEST':
      return { kind: speaker.kind, requestId: speaker.requestId }
    case 'AMENDED':
      return { kind: speaker.kind, amendmentId: speaker.amendmentId }
    case 'LINES':
      return { kind: speaker.kind, change: speaker.change, lineIds: [...speaker.lineIds] }
    case 'CANCELLED':
      return { kind: speaker.kind }
    case 'PROMISE':
      return { kind: speaker.kind, from: speaker.from, to: speaker.to }
    case 'WORK_ORDER_CHANGE':
      return { kind: speaker.kind, workOrderChangeId: speaker.changeId }
    case 'HOLD': {
      const workOrderId = facts.holdWorkOrderOf(speaker.holdId)
      const workOrder = workOrderId ? facts.reached(workOrderId) : null
      return { kind: speaker.kind, hold: { placed: speaker.placed, workOrder, leftOut: workOrderId && !workOrder ? 1 : 0 } }
    }
    case 'ECO': {
      const number = facts.changeOrderNumberOf(speaker.changeOrderId)
      return { kind: speaker.kind, changeOrder: number ? { number } : null }
    }
  }
}
// ── end B-OC-009 ──

export const toldChangesContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      order: output({ id: id(), number: z.string() }),
      /** The office people told about any of these changes, each counted once. */
      people: z.number().int(),
      /** Newest first. */
      changes: z.array(
        output({
          batchId: z.string(),
          messageId: id(),
          /** When the change happened (the act) and when its line was written. */
          occurredAt: instant(),
          at: instant(),
          /** The event that spoke for the change (sales_order.amended, order_change_request.answered, …). */
          eventType: z.string(),
          /** The customer's request it carried out (null: the office's own change, or written before it). */
          requestId: id().nullable(),
          people: z.number().int(),
          floor: output({ at: instant().nullable(), workOrders: z.array(workOrderRef), leftOut: z.number().int() }),
          workshop: output({ at: instant().nullable(), told: z.number().int(), waiting: z.number().int() }),
          /** B-OC-009: what spoke for the change (null: a line written before the row kept it). */
          speaker: speakerView.nullable(),
        }),
      ),
    }),
  },
})

/** GET /sales/orders/:orderId/told/changes. */
export async function toldChanges(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (db) => {
    const thread = await db.thread.findFirst({ where: { recordType: 'SalesOrder', recordId: order.id }, select: { recordType: true, recordId: true, companyId: true, siteId: true, partyId: true } })
    // No conversation yet: no change was ever told.
    if (!thread) return { order: { id: order.id, number: order.number }, people: 0, changes: [] }
    if (!mayOnThread(actor, THREADS_READ, 'SalesOrder', await wallScopeOf(db, thread))) throw new NotFoundError(NOT_FOUND)
    const rows = await db.auditLog.findMany({
      where: { recordType: 'SalesOrder', recordId: order.id, action: ORDER_CHANGE_NOTES_HANDLER, after: { path: ['written'], equals: true } },
      orderBy: { at: 'desc' },
      take: TOLD_CHANGES_LIMIT,
      select: { requestId: true, after: true },
    })
    const written = rows.flatMap((row) => {
      const notes = (row.after ?? {}) as NotesRecord
      return notes.written === true && notes.messageId && row.requestId ? [{ batchId: row.requestId, messageId: notes.messageId, notes }] : []
    })
    const lines = new Map((written.length > 0 ? await db.message.findMany({ where: { id: { in: written.map((entry) => entry.messageId) } }, select: { id: true, at: true } }) : []).map((line) => [line.id, line.at]))
    const changes = written.filter((entry) => lines.has(entry.messageId))

    // B-OC-009: what spoke for each change; a pause's work order and a change order's number, read once.
    const speakers = changes.map((entry) => storedSpeakerOf(entry.notes.speaker))
    const holdIds = [...new Set(speakers.flatMap((speaker) => (speaker?.kind === 'HOLD' ? [speaker.holdId] : [])))]
    const holdWorkOrder = new Map((holdIds.length > 0 ? await db.workOrderHold.findMany({ where: { id: { in: holdIds } }, select: { id: true, workOrderId: true } }) : []).map((hold) => [hold.id, hold.workOrderId]))
    const changeOrderIds = [...new Set(speakers.flatMap((speaker) => (speaker?.kind === 'ECO' ? [speaker.changeOrderId] : [])))]
    const changeOrderNumber = new Map((changeOrderIds.length > 0 ? await db.changeOrder.findMany({ where: { id: { in: changeOrderIds } }, select: { id: true, number: true } }) : []).map((eco) => [eco.id, eco.number]))

    // The work orders the notes went on (B-OC-009: and the pauses' work orders), read once (named only when the reader reaches them).
    const floorRows = changes.flatMap((entry) => entry.notes.floor ?? [])
    const shopRows = changes.flatMap((entry) => entry.notes.workshops ?? [])
    const workOrderIds = [...new Set([...floorRows.map((entry) => entry.workOrderId), ...shopRows.map((entry) => entry.workOrderId), ...holdWorkOrder.values()])]
    const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true } }) : []).map((entry) => [entry.id, entry]))
    const reached = (workOrderId: string) => {
      const workOrder = workOrders.get(workOrderId)
      return workOrder && reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder) ? { id: workOrder.id, number: workOrder.number } : null
    }

    // People: the rows of each change's ONE bell item (office rows only), with those B-PR-32's notice told of the same act.
    const keyOf = (batchId: string) => batchGroupKey(orderChangeBatch(batchId, order.id), 'FOLLOWING')
    const noted = [...new Set(floorRows.map((entry) => entry.workOrderId))]
    const told = changes.length > 0 ? await db.notification.findMany({ where: { partyId: null, groupKey: { in: changes.map((entry) => keyOf(entry.batchId)) }, OR: [{ recordType: 'SalesOrder', recordId: order.id }, ...(noted.length > 0 ? [{ recordType: 'WorkOrder', recordId: { in: noted } }] : [])] }, select: { userId: true, groupKey: true } }) : []
    const candidates = [...new Set([...told.map((entry) => entry.userId), ...changes.flatMap((entry) => entry.notes.alreadyTold ?? [])])]
    const office = new Set((candidates.length > 0 ? await db.user.findMany({ where: { id: { in: candidates }, audience: 'OFFICE' }, select: { id: true } }) : []).map((user) => user.id))
    const everyone = new Set<string>()

    // The floor notes' times; the workshops' notices (B-SA-054's partner rule) after the oldest line.
    const floorAt = new Map((floorRows.length > 0 ? await db.message.findMany({ where: { id: { in: floorRows.map((entry) => entry.messageId) } }, select: { id: true, at: true } }) : []).map((message) => [message.id, message.at]))
    const oldest = [...lines.values()].reduce<Date | null>((first, at) => (first === null || at < first ? at : first), null)
    const shopIds = [...new Set(shopRows.map((entry) => entry.subcontractOrderId))]
    const notices = shopIds.length > 0 && oldest ? await db.notification.findMany({ where: { recordType: 'SubcontractOrder', recordId: { in: shopIds }, partyId: { not: null }, eventType: 'production.floor_note_posted', createdAt: { gte: oldest } }, select: { recordId: true, createdAt: true } }) : []

    const out = changes.map((entry, index) => {
      const lineAt = lines.get(entry.messageId)!
      const key = keyOf(entry.batchId)
      const people = new Set([...told.filter((row) => row.groupKey === key).map((row) => row.userId), ...(entry.notes.alreadyTold ?? [])].filter((userId) => office.has(userId)))
      for (const userId of people) everyone.add(userId)
      const floor = entry.notes.floor ?? []
      const floorTimes = floor.flatMap((row) => (floorAt.has(row.messageId) ? [floorAt.get(row.messageId)!] : []))
      const named = floor.flatMap((row) => {
        const workOrder = reached(row.workOrderId)
        return workOrder ? [workOrder] : []
      })
      // A workshop is told by the first notice on its subcontract order since this change's line.
      const shops = entry.notes.workshops ?? []
      const shopTimes = shops.flatMap((row) => {
        const first = notices.filter((notice) => notice.recordId === row.subcontractOrderId && notice.createdAt >= lineAt).reduce<Date | null>((earliest, notice) => (earliest === null || notice.createdAt < earliest ? notice.createdAt : earliest), null)
        return first ? [first] : []
      })
      const earliest = (times: readonly Date[]) => times.reduce<Date | null>((first, at) => (first === null || at < first ? at : first), null)
      const floorFirst = earliest(floorTimes)
      const shopFirst = earliest(shopTimes)
      const occurred = typeof entry.notes.at === 'string' && !Number.isNaN(Date.parse(entry.notes.at)) ? new Date(entry.notes.at) : lineAt
      return {
        batchId: entry.batchId,
        messageId: entry.messageId,
        occurredAt: toUtcIso(occurred),
        at: toUtcIso(lineAt),
        eventType: entry.notes.eventType ?? '',
        requestId: entry.notes.requestId ?? null,
        people: people.size,
        floor: { at: floorFirst ? toUtcIso(floorFirst) : null, workOrders: named, leftOut: floor.length - named.length },
        workshop: { at: shopFirst ? toUtcIso(shopFirst) : null, told: shopTimes.length, waiting: shops.length - shopTimes.length },
        // B-OC-009
        speaker: speakerViewOf(speakers[index] ?? null, { holdWorkOrderOf: (holdId) => holdWorkOrder.get(holdId), reached, changeOrderNumberOf: (changeOrderId) => changeOrderNumber.get(changeOrderId) }),
      }
    })
    return { order: { id: order.id, number: order.number }, people: everyone.size, changes: out }
  })
}
// ---- end F-SA-244
