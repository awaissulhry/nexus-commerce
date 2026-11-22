import { z } from 'zod'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { businessDate as businessDateField, id, instant, output } from '@nexus/factory-domain/core/contracts'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { FILE_ASK_ADDRESSEES, FILE_ASK_KINDS, lateDaysOf } from '@nexus/factory-domain/files/asks'
import { seesPrices } from '@nexus/factory-domain/files/priced'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { taskWords } from '@nexus/factory-domain/portal/tasks/kinds'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import type { Reader } from '../orders/store'
import { ASK_COLUMNS, dayOf, mayKeepAsks, type AskRow } from './file-asks'

/**
 * B-OF-033 (order files tab; 13-backend §2): the asks of one sales order, as the order's files read sends them (GET
 * /sales/orders/:orderId/files, ../orders/order-files.ts — the tab and the order's thread window read the same answer):
 *
 *   asks          the OPEN and ARRIVED asks ("Waiting for files"; an accepted one leaves the band: its file says it, `askId`), arrived
 *                 first, then by due day: what (a priced ask's words null for a reader without prices — counted, never named), where it
 *                 lands, who (an office person's name, a role's or a team's name, the step's), whether the reader holds one of its open
 *                 Tasks (`forMe`), the due day and how late (derived: the company's day; an arrived ask is not late), who asked, the
 *                 rounds and the newest reason, the last chase, what arrived (`by`: an office person by name, or the floor — never a
 *                 worker), how many of its files the virus scan still holds, and what the reader may do
 *   asksLeftOut   asks the reader does not reach (on a work order it does not reach, body data without the measurements right): counted
 *   customerAsks  the order's open UPLOAD_DOCUMENT requests to its customer (PartnerTask): what, due, late
 *   askOfFile     each file sent for an arrived or accepted ask → that ask (the files' `askId`)
 * One query per kind for the order's asks (never one per ask). A read: no command, no event, nothing written ("seen" never exists).
 */

export const askView = output({
  id: id(),
  version: z.number().int(),
  status: z.enum(['OPEN', 'ARRIVED']),
  /** What is needed; null for a priced ask when the reader does not see prices. */
  words: z.string().nullable(),
  priced: notMoney(z.boolean()),
  bodyData: z.boolean(),
  fileKind: z.enum(FILE_ASK_KINDS),
  lands: output({
    type: z.enum(['SalesOrder', 'SalesOrderLine', 'WorkOrder']),
    id: id(),
    label: z.string(),
    step: output({ id: id(), seq: z.number().int(), name: z.string() }).nullable(),
  }),
  /** Who is asked: an office person's name, a role's or a team's name, the step's name (never a floor worker). */
  who: output({ kind: z.enum(FILE_ASK_ADDRESSEES), label: z.string() }),
  /** The reader holds one of its open Tasks ("Upload for this ask"). */
  forMe: z.boolean(),
  dueOn: businessDateField(),
  lateDays: z.number().int(),
  askedBy: output({ name: z.string() }),
  askedAt: instant(),
  rounds: z.number().int(),
  /** The newest reason it was asked again (null: never; or a priced ask for a reader without prices). */
  lastReason: z.string().nullable(),
  chasedAt: instant().nullable(),
  answered: output({
    at: instant(),
    by: z.discriminatedUnion('kind', [output({ kind: z.literal('OFFICE'), name: z.string() }), output({ kind: z.literal('FLOOR') })]),
    fileIds: z.array(id()),
    /** Files of this round the virus scan still holds (never opened, never accepted). */
    held: z.number().int(),
  }).nullable(),
  may: output({ answer: z.boolean(), decide: z.boolean(), change: z.boolean() }),
})
export type AskView = z.infer<typeof askView>

export const customerAskView = output({
  id: id(),
  words: output({ it: z.string(), en: z.string() }),
  dueOn: businessDateField().nullable(),
  lateDays: z.number().int(),
  status: z.enum(['OPEN']),
})
export type CustomerAskView = z.infer<typeof customerAskView>

export interface OrderAsks {
  readonly asks: AskView[]
  readonly asksLeftOut: number
  readonly customerAsks: CustomerAskView[]
  readonly askOfFile: ReadonlyMap<string, string>
}

interface OrderOfAsks {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]
const WAITING: ReadonlySet<string> = new Set(['OPEN', 'ARRIVED'])

/** The order's open requests to its customer for a document (the portal's UPLOAD_DOCUMENT tasks). */
async function customerAsksOf(db: Reader, order: OrderOfAsks, today: string): Promise<CustomerAskView[]> {
  const rows = await db.partnerTask.findMany({ where: { recordType: 'SalesOrder', recordId: order.id, kind: 'UPLOAD_DOCUMENT', status: 'OPEN' }, select: { id: true, recordLabel: true, dueAt: true }, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }] })
  return rows.map((row) => {
    const dueOn = row.dueAt ? businessDate(row.dueAt) : null
    return { id: row.id, words: { it: taskWords('UPLOAD_DOCUMENT', row.recordLabel, 'it'), en: taskWords('UPLOAD_DOCUMENT', row.recordLabel, 'en') }, dueOn, lateDays: dueOn ? lateDaysOf(dueOn, today) : 0, status: 'OPEN' as const }
  })
}

/** The asks of one order for this reader (see the head). */
export async function orderAsksOf(db: Reader, actor: Actor, actorId: string, order: OrderOfAsks, now: Date): Promise<OrderAsks> {
  const today = businessDate(now)
  const customerAsks = await customerAsksOf(db, order, today)
  const rows: AskRow[] = await db.fileAsk.findMany({ where: { salesOrderId: order.id, status: { in: ['OPEN', 'ARRIVED', 'ACCEPTED'] } }, select: ASK_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (rows.length === 0) return { asks: [], asksLeftOut: 0, customerAsks, askOfFile: new Map() }

  // ---- the walls: a work order the reader reaches; body data only with the measurements right -------------------------------
  const workOrderIds = unique(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))
  const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true } }) : []).map((row) => [row.id, row]))
  const measurements = can(actor, SALES_MEASUREMENTS_VIEW, { companyId: order.companyId, partyId: order.partyId })
  const reaches = (row: AskRow): boolean => {
    if (row.bodyData && !measurements) return false
    if (!row.workOrderId) return true
    const workOrder = workOrders.get(row.workOrderId)
    return workOrder !== undefined && reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder)
  }
  const reached = rows.filter(reaches)
  const reachedIds = new Set(reached.map((row) => row.id))
  const asksLeftOut = rows.filter((row) => WAITING.has(row.status) && !reachedIds.has(row.id)).length
  const askOfFile = new Map<string, string>()
  for (const row of reached) if (row.status === 'ARRIVED' || row.status === 'ACCEPTED') for (const fileId of row.fileIds) askOfFile.set(fileId, row.id)
  const waiting = reached.filter((row) => WAITING.has(row.status))
  if (waiting.length === 0) return { asks: [], asksLeftOut, customerAsks, askOfFile }

  // ---- the names, one query per kind ------------------------------------------------------------------------------------------
  const lineIds = unique(waiting.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))
  const stepIds = unique(waiting.flatMap((row) => (row.workOrderOperationId ? [row.workOrderOperationId] : [])))
  const userIds = unique(waiting.flatMap((row) => [row.askedById, ...(row.addresseeUserId ? [row.addresseeUserId] : []), ...(row.answeredById ? [row.answeredById] : [])]))
  const roleIds = unique(waiting.flatMap((row) => (row.addresseeRoleId ? [row.addresseeRoleId] : [])))
  const teamIds = unique(waiting.flatMap((row) => (row.addresseeTeamId ? [row.addresseeTeamId] : [])))
  const taskIds = unique(waiting.flatMap((row) => row.taskIds))
  const fileIds = unique(waiting.flatMap((row) => (row.status === 'ARRIVED' ? row.fileIds : [])))
  const lines = new Map((lineIds.length > 0 ? await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, seq: true } }) : []).map((row) => [row.id, row.seq]))
  const steps = new Map((stepIds.length > 0 ? await db.workOrderOperation.findMany({ where: { id: { in: stepIds } }, select: { id: true, seq: true, name: true } }) : []).map((row) => [row.id, row]))
  const users = new Map((userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row.displayName]))
  const roles = new Map((roleIds.length > 0 ? await db.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }) : []).map((row) => [row.id, row.name]))
  const teams = new Map((teamIds.length > 0 ? await db.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } }) : []).map((row) => [row.id, row.name]))
  const mine = new Set((taskIds.length > 0 ? await db.task.findMany({ where: { id: { in: taskIds }, assigneeId: actorId, status: 'OPEN' }, select: { id: true } }) : []).map((row) => row.id))
  const available = new Set((fileIds.length > 0 ? await db.storedFile.findMany({ where: { id: { in: fileIds }, status: 'AVAILABLE' }, select: { id: true } }) : []).map((row) => row.id))

  const sees = seesPrices(actor)
  const keeps = mayKeepAsks(actor, order, false)
  const view = (row: AskRow): AskView => {
    const workOrder = row.workOrderId ? workOrders.get(row.workOrderId) : undefined
    const step = row.workOrderOperationId ? steps.get(row.workOrderOperationId) : undefined
    const named = !row.priced || sees
    const lands =
      row.target === 'SALES_ORDER'
        ? { type: 'SalesOrder' as const, id: order.id, label: order.number, step: null }
        : row.target === 'SALES_ORDER_LINE'
          ? { type: 'SalesOrderLine' as const, id: row.salesOrderLineId!, label: `${order.number} · ${lines.get(row.salesOrderLineId!) ?? ''}`, step: null }
          : { type: 'WorkOrder' as const, id: row.workOrderId!, label: workOrder?.number ?? '', step: step ? { id: step.id, seq: step.seq, name: step.name } : null }
    const who =
      row.addressee === 'PERSON'
        ? users.get(row.addresseeUserId!) ?? ''
        : row.addressee === 'OFFICE_ROLE' || row.addressee === 'FLOOR_ROLE'
          ? roles.get(row.addresseeRoleId!) ?? ''
          : row.addressee === 'FLOOR_TEAM'
            ? teams.get(row.addresseeTeamId!) ?? ''
            : step?.name ?? ''
    // The office person who may add files where it lands (the order's scope, a work order's own).
    const uploadScope = workOrder ? { companyId: workOrder.companyId, siteId: workOrder.siteId, partyId: workOrder.partyId } : { companyId: order.companyId, siteId: null, partyId: order.partyId }
    const marksHeld = named
    return {
      id: row.id,
      version: row.version,
      status: row.status as 'OPEN' | 'ARRIVED',
      words: named ? row.words : null,
      priced: row.priced,
      bodyData: row.bodyData,
      fileKind: row.fileKind as AskView['fileKind'],
      lands,
      who: { kind: row.addressee, label: who },
      forMe: row.taskIds.some((taskId) => mine.has(taskId)),
      dueOn: dayOf(row.dueOn),
      lateDays: row.status === 'OPEN' ? lateDaysOf(dayOf(row.dueOn), today) : 0,
      askedBy: { name: users.get(row.askedById) ?? '' },
      askedAt: toUtcIso(row.createdAt),
      rounds: row.rounds,
      lastReason: named ? row.lastReason : null,
      chasedAt: row.lastChasedAt ? toUtcIso(row.lastChasedAt) : null,
      answered:
        row.status === 'ARRIVED' && row.answeredAt
          ? {
              at: toUtcIso(row.answeredAt),
              by: row.answeredById ? { kind: 'OFFICE' as const, name: users.get(row.answeredById) ?? '' } : { kind: 'FLOOR' as const },
              fileIds: [...row.fileIds],
              held: row.fileIds.filter((fileId) => !available.has(fileId)).length,
            }
          : null,
      may: {
        answer: row.status === 'OPEN' && marksHeld && can(actor, FILES_UPLOAD, uploadScope),
        decide: row.status === 'ARRIVED' && marksHeld && keeps,
        change: marksHeld && keeps,
      },
    }
  }
  const asks = [...waiting]
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'ARRIVED' ? -1 : 1) || a.dueOn.getTime() - b.dueOn.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    .map(view)
  return { asks, asksLeftOut, customerAsks, askOfFile }
}
