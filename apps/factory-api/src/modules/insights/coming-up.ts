import type { Prisma } from '@nexus/factory-db'
import { isoWeekday, plusDays } from '@nexus/factory-domain/calendars/dates'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { matchesScope } from '@nexus/factory-domain/insights/attention'
import { COMING_LIMIT, COMING_RULES, comingDays, comingKindsFor, comingWindow, landsOn, type ComingItem, type ComingKind } from '@nexus/factory-domain/insights/coming-up'
import { personalPhrase } from '@nexus/factory-domain/insights/personal'
import type { CommandCaller } from '../../core/command'
import { workingTimeFor, type CalendarOwner } from '../../platform/calendars/service'
import { asDay, dayOf, partyNames } from './sources/common'
import { scopeFilterOf, viewerOf } from './viewer'

/**
 * GET /home/coming-up (B-W2a-20 API for B-W2a-40; design home.today `coming-up`; rules factory-domain insights/coming-up):
 * what lands on me in the next five working days, by day: my tasks due, the promise dates of the open orders I act on,
 * the deliveries due on the purchase orders I act on, the certificates I keep that expire. Working days by the business
 * calendar (platform/calendars) of the site or company the page is filtered to; without a filter Monday to Friday. Read
 * only, at the moment asked; no amount and no person in it.
 */

const OPEN_ORDERS = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const
const DUE_PURCHASES = ['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED'] as const

export async function comingUp(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }) {
  const viewer = viewerOf(caller)
  const filter = await scopeFilterOf(caller, query)
  const owner: CalendarOwner | null = filter.site ? { scope: 'SITE', id: filter.site.id } : query.companyId ? { scope: 'COMPANY', id: query.companyId } : null
  const reach = plusDays(viewer.today, 31)
  const calendar = owner ? await caller.withClient((client) => workingTimeFor(client as Prisma.TransactionClient, owner, plusDays(viewer.today, 1), reach)) : null
  const working = new Map(calendar?.days.map((day) => [day.date, day.working]) ?? [])
  const days = comingWindow(viewer.today, (date) => (calendar ? (working.get(date) ?? false) : isoWeekday(date) <= 5), plusDays)
  const from = days[0]?.date ?? plusDays(viewer.today, 1)
  const to = days.at(-1)?.date ?? from
  const window = { gte: asDay(from), lte: asDay(to) }
  const kinds = comingKindsFor(viewer.actor)
  const complete: Partial<Record<ComingKind, boolean>> = {}
  const items: ComingItem[] = []

  await caller.withClient(async (db) => {
    const add = (item: ComingItem) => {
      if (matchesScope(item.scope, filter)) items.push(item)
    }
    if (kinds.includes('TASK')) {
      const tasks = await db.task.findMany({ where: { assigneeId: viewer.personId, status: 'OPEN', dueDate: window }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: COMING_LIMIT + 1, select: { id: true, title: true, dueDate: true, companyId: true, siteId: true, partyId: true } })
      complete.TASK = tasks.length <= COMING_LIMIT
      for (const task of tasks.slice(0, COMING_LIMIT)) {
        add({ kind: 'TASK', date: dayOf(task.dueDate!), record: { type: 'Task', id: task.id, label: task.title }, scope: { companyId: task.companyId, siteId: task.siteId, partyId: task.partyId }, words: personalPhrase('COMING.TASK', { title: task.title }) })
      }
    }
    if (kinds.includes('ORDER')) {
      const scope = scopeWhere(viewer.actor, COMING_RULES.ORDER.act, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput
      const orders = await db.salesOrder.findMany({ where: { AND: [scope, { status: { in: [...OPEN_ORDERS] }, promiseDate: window }] }, orderBy: [{ promiseDate: 'asc' }, { id: 'asc' }], take: COMING_LIMIT + 1, select: { id: true, number: true, companyId: true, partyId: true, promiseDate: true } })
      complete.ORDER = orders.length <= COMING_LIMIT
      const names = await partyNames(db, orders.map((order) => order.partyId))
      for (const order of orders.slice(0, COMING_LIMIT)) {
        const scoped = { companyId: order.companyId, siteId: null, partyId: order.partyId }
        if (!landsOn(viewer.actor, 'ORDER', scoped)) continue
        add({ kind: 'ORDER', date: dayOf(order.promiseDate!), record: { type: 'SalesOrder', id: order.id, label: order.number }, scope: scoped, words: personalPhrase('COMING.ORDER', { number: order.number, customer: names.get(order.partyId) ?? 'the customer' }) })
      }
    }
    if (kinds.includes('DELIVERY')) {
      const scope = scopeWhere(viewer.actor, COMING_RULES.DELIVERY.act, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.PurchaseOrderWhereInput
      const orders = await db.purchaseOrder.findMany({ where: { AND: [scope, { status: { in: [...DUE_PURCHASES] }, requestedDate: window }] }, orderBy: [{ requestedDate: 'asc' }, { id: 'asc' }], take: COMING_LIMIT + 1, select: { id: true, number: true, companyId: true, siteId: true, partyId: true, requestedDate: true } })
      complete.DELIVERY = orders.length <= COMING_LIMIT
      const names = await partyNames(db, orders.map((order) => order.partyId))
      for (const order of orders.slice(0, COMING_LIMIT)) {
        const scoped = { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId }
        if (!landsOn(viewer.actor, 'DELIVERY', scoped)) continue
        add({ kind: 'DELIVERY', date: dayOf(order.requestedDate!), record: { type: 'PurchaseOrder', id: order.id, label: order.number }, scope: scoped, words: personalPhrase('COMING.DELIVERY', { number: order.number, supplier: names.get(order.partyId) ?? 'The supplier' }) })
      }
    }
    if (kinds.includes('CERTIFICATE')) {
      const scope = scopeWhere(viewer.actor, COMING_RULES.CERTIFICATE.act, { company: 'companyId' }) as Prisma.CertificateWhereInput
      const certificates = await db.certificate.findMany({ where: { AND: [scope, { status: 'VALID', validTo: window }] }, orderBy: [{ validTo: 'asc' }, { id: 'asc' }], take: COMING_LIMIT + 1, select: { id: true, number: true, companyId: true, validTo: true } })
      complete.CERTIFICATE = certificates.length <= COMING_LIMIT
      for (const certificate of certificates.slice(0, COMING_LIMIT)) {
        const scoped = { companyId: certificate.companyId, siteId: null, partyId: null }
        if (!landsOn(viewer.actor, 'CERTIFICATE', scoped)) continue
        add({ kind: 'CERTIFICATE', date: dayOf(certificate.validTo), record: { type: 'Certificate', id: certificate.id, label: certificate.number }, scope: scoped, words: personalPhrase('COMING.CERTIFICATE', { number: certificate.number }) })
      }
    }
  })

  return {
    asOf: toUtcIso(viewer.now),
    today: viewer.today,
    /** The calendar the days follow (null: Monday to Friday, no calendar asked). */
    calendar: owner,
    kinds,
    complete: kinds.map((kind) => ({ kind, complete: complete[kind] ?? true })),
    days: comingDays(days, items).map((day) => ({
      date: day.date as BusinessDate,
      working: day.working,
      items: day.items.map((item) => ({
        kind: item.kind,
        record: item.record,
        companyId: item.scope.companyId,
        siteId: item.scope.siteId,
        partyId: item.scope.partyId,
        sentence: item.words.text,
        words: { key: item.words.key, params: item.words.params },
      })),
    })),
    live: { events: ['task.created', 'task.assigned', 'task.completed', 'task.changed', 'sales_order.promise_changed', 'sales_order.status_changed', 'purchase_order.sent', 'purchase_order.confirmed', 'purchase_order.cancelled'] },
  }
}
