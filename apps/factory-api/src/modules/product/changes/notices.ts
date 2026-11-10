import { can, holds, type Permission } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as changeEvents } from '@nexus/factory-domain/product-changes/events'
import { PRODUCT_CHANGES_APPROVE, PRODUCT_CHANGES_MANAGE, PRODUCT_CHANGES_VIEW } from '@nexus/factory-domain/product/changes/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'
import { followersOf } from '../../../platform/threads/followers'

/**
 * Who is told about change requests and change orders (B-W2b-226; PRD-175 "notifications to followers, the style's owner and
 * the work orders' supervisors"), quiet as every rule of the fan-out, never the person who did it, each only while they reach
 * Home and may see changes of the company:
 *
 *   change_request.raised            SYSTEM to who triages requests of the company (product.changes.manage), the style's
 *                                    owner (who made it) and its followers: "New change request CR-…: JKT-01 · Sleeve too long"
 *   change_request.changed           accepted or rejected: SYSTEM to who raised it (a floor request names nobody)
 *   change_order.changed             approvers asked (submitted, or named while it waits): APPROVAL to each of them;
 *                                    APPROVED / REJECTED: APPROVAL to its author;
 *                                    RELEASED: SYSTEM to its followers, the style's owner and followers, and the supervisors of
 *                                    the work orders it decides for (workorders.view with production.scan.correct at the work
 *                                    order's site: no supervisor column exists) and their followers
 *
 * The bell carries them at once; the person's digest e-mail, when they switched it on, carries them too.
 */

const payloadOf = (type: string) => changeEvents.find((event) => event.type === type)!.payload
const TITLE_MAX = 120
/** The floor supervisor's own permission among those a work order's supervisor holds at its site. */
const SCAN_CORRECT = 'production.scan.correct' satisfies Permission

type Place = { readonly companyId: string; readonly siteId?: string | null }

/** People who reach Home and hold the permission over the place, but `except`. */
async function readersOf(context: RuleContext, candidates: Iterable<string>, permission: Permission, place: Place, except: string | null): Promise<string[]> {
  const people: string[] = []
  for (const userId of new Set(candidates)) {
    if (userId === except) continue
    const reader = await context.reader(userId)
    if (reader && holds(reader.actor, HOME_VIEW) && can(reader.actor, permission, place.siteId ? { companyId: place.companyId, siteId: place.siteId } : { companyId: place.companyId })) people.push(userId)
  }
  return people
}

const short = (words: string): string => (words.length > TITLE_MAX ? `${words.slice(0, TITLE_MAX - 1)}…` : words)

export const CHANGE_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'changes.requestRaised',
    events: ['change_request.raised'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('change_request.raised').parse(raw) as { changeRequestId: string; number: string | null; styleId: string }
      const request = await context.tx.changeRequest.findUnique({ where: { id: payload.changeRequestId }, select: { companyId: true, status: true, title: true, createdById: true, number: true } })
      if (!request || request.status !== 'OPEN') return []
      const style = await context.tx.style.findUnique({ where: { id: payload.styleId }, select: { code: true, createdById: true } })
      const triage = await readersOf(context, await context.people(), PRODUCT_CHANGES_MANAGE, request, request.createdById)
      const owners = await readersOf(context, [...(style?.createdById ? [style.createdById] : []), ...(await followersOf(context.tx, { type: 'Style', id: payload.styleId }))], PRODUCT_CHANGES_VIEW, request, request.createdById)
      return [...new Set([...triage, ...owners])].map((userId) => ({
        userId,
        category: 'SYSTEM' as const,
        record: { type: 'ChangeRequest', id: payload.changeRequestId, label: request.number ?? 'Floor request' },
        companyId: request.companyId,
        anchor: `change-request:${payload.changeRequestId}`,
        messageKey: 'notifications.changes.requestRaised' as const,
        params: { title: short(`${style?.code ?? ''} · ${request.title}`), styleId: payload.styleId },
        actorId: request.createdById,
      }))
    },
  },
  {
    name: 'changes.requestDecided',
    events: ['change_request.changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('change_request.changed').parse(raw) as { changeRequestId: string; number: string; change: string }
      if (payload.change !== 'ACCEPTED' && payload.change !== 'REJECTED') return []
      const request = await context.tx.changeRequest.findUnique({ where: { id: payload.changeRequestId }, select: { companyId: true, createdById: true, decidedById: true, decisionNote: true } })
      if (!request?.createdById) return []
      const [userId] = await readersOf(context, [request.createdById], PRODUCT_CHANGES_VIEW, request, request.decidedById)
      if (!userId) return []
      return [
        {
          userId,
          category: 'SYSTEM',
          record: { type: 'ChangeRequest', id: payload.changeRequestId, label: payload.number },
          companyId: request.companyId,
          anchor: `change-request:${payload.changeRequestId}`,
          messageKey: payload.change === 'ACCEPTED' ? 'notifications.changes.requestAccepted' : 'notifications.changes.requestRejected',
          params: { actorId: request.decidedById, title: short(request.decisionNote ?? '') },
          actorId: request.decidedById,
        },
      ]
    },
  },
  {
    name: 'changes.approvalAsked',
    events: ['change_order.changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('change_order.changed').parse(raw) as { changeOrderId: string; number: string; approverIds: string[] }
      if (payload.approverIds.length === 0) return []
      const order = await context.tx.changeOrder.findUnique({ where: { id: payload.changeOrderId }, select: { companyId: true, status: true, title: true, authorId: true } })
      if (!order || order.status !== 'SUBMITTED') return []
      const waiting = await context.tx.changeApproval.findMany({ where: { changeOrderId: payload.changeOrderId, approverId: { in: payload.approverIds }, decision: null }, select: { approverId: true } })
      const people = await readersOf(context, waiting.map((approval) => approval.approverId), PRODUCT_CHANGES_APPROVE, order, order.authorId)
      return people.map((userId) => ({
        userId,
        category: 'APPROVAL' as const,
        record: { type: 'ChangeOrder', id: payload.changeOrderId, label: payload.number },
        companyId: order.companyId,
        anchor: `change-order:${payload.changeOrderId}`,
        messageKey: 'notifications.changes.approvalAsked' as const,
        params: { actorId: order.authorId, title: short(order.title) },
        actorId: order.authorId,
      }))
    },
  },
  {
    name: 'changes.orderDecided',
    events: ['change_order.changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('change_order.changed').parse(raw) as { changeOrderId: string; number: string; change: string }
      if (payload.change !== 'APPROVED' && payload.change !== 'REJECTED') return []
      const order = await context.tx.changeOrder.findUnique({ where: { id: payload.changeOrderId }, select: { companyId: true, status: true, authorId: true } })
      // Still as decided (an approved one may be released by the time the worker runs: the author still hears it).
      if (!order || (order.status !== payload.change && !(payload.change === 'APPROVED' && order.status === 'RELEASED'))) return []
      const last = await context.tx.changeApproval.findFirst({ where: { changeOrderId: payload.changeOrderId, decision: { not: null } }, orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], select: { approverId: true } })
      const [userId] = await readersOf(context, [order.authorId], PRODUCT_CHANGES_VIEW, order, last?.approverId ?? null)
      if (!userId) return []
      return [
        {
          userId,
          category: 'APPROVAL',
          record: { type: 'ChangeOrder', id: payload.changeOrderId, label: payload.number },
          companyId: order.companyId,
          anchor: `change-order:${payload.changeOrderId}`,
          messageKey: 'notifications.changes.orderDecided',
          params: { actorId: last?.approverId ?? null, status: payload.change },
          actorId: last?.approverId ?? null,
        },
      ]
    },
  },
  {
    name: 'changes.orderReleased',
    events: ['change_order.changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('change_order.changed').parse(raw) as { changeOrderId: string; number: string; styleId: string; change: string }
      if (payload.change !== 'RELEASED') return []
      const order = await context.tx.changeOrder.findUnique({ where: { id: payload.changeOrderId }, select: { companyId: true, status: true, title: true, releasedById: true } })
      if (!order || order.status !== 'RELEASED') return []
      const style = await context.tx.style.findUnique({ where: { id: payload.styleId }, select: { createdById: true } })
      const record = { type: 'ChangeOrder', id: payload.changeOrderId, label: payload.number }
      const base = { category: 'SYSTEM' as const, record, companyId: order.companyId, anchor: `change-order:${payload.changeOrderId}`, actorId: order.releasedById }
      const told = new Set<string>()
      const drafts: Draft[] = []
      // The work orders it decides for: their supervisors at the site and their followers hear which ones.
      const lines = await context.tx.changeOrderItem.findMany({ where: { changeOrderId: payload.changeOrderId, kind: 'WORK_IN_PROGRESS' }, select: { workOrderId: true, disposition: true, workOrder: { select: { number: true, siteId: true, companyId: true } } } })
      const people = await context.people()
      const bySupervisor = new Map<string, { numbers: string[]; decided: { workOrder: string; disposition: string }[] }>()
      for (const line of lines) {
        if (!line.workOrder) continue
        const place = { companyId: line.workOrder.companyId, siteId: line.workOrder.siteId }
        const followers = new Set(await followersOf(context.tx, { type: 'WorkOrder', id: line.workOrderId! }))
        for (const userId of await readersOf(context, [...people, ...followers], WORKORDERS_VIEW, place, order.releasedById)) {
          const reader = await context.reader(userId)
          if (!followers.has(userId) && !(reader !== null && can(reader.actor, SCAN_CORRECT, place))) continue
          const entry = bySupervisor.get(userId) ?? { numbers: [], decided: [] }
          if (!entry.numbers.includes(line.workOrder.number)) entry.numbers.push(line.workOrder.number)
          entry.decided.push({ workOrder: line.workOrder.number, disposition: line.disposition ?? 'FINISH_OLD' })
          bySupervisor.set(userId, entry)
        }
      }
      for (const [userId, entry] of bySupervisor) {
        told.add(userId)
        drafts.push({ ...base, userId, messageKey: 'notifications.changes.workInProgress', params: { title: short(order.title), kindLabel: entry.numbers.join(', '), decided: entry.decided } })
      }
      const others = await readersOf(
        context,
        [...(await followersOf(context.tx, { type: 'ChangeOrder', id: payload.changeOrderId })), ...(style?.createdById ? [style.createdById] : []), ...(await followersOf(context.tx, { type: 'Style', id: payload.styleId }))],
        PRODUCT_CHANGES_VIEW,
        order,
        order.releasedById,
      )
      for (const userId of others) {
        if (told.has(userId)) continue
        drafts.push({ ...base, userId, messageKey: 'notifications.changes.orderReleased', params: { title: short(order.title) } })
      }
      return drafts
    },
  },
])
