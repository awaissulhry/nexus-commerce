import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import { DIGEST_ITEMS, SECTION_NEEDS, WIP_STUCK_DAYS, sectionsInOrder, type DigestContent, type DigestItem, type DigestSection, type DigestSectionContent } from '@nexus/factory-domain/insights-digest/digest'
import { kpiFileOf } from '@nexus/factory-domain/insights/kpis/registry'
import { periodOf } from '@nexus/factory-domain/insights/periods/periods'
import { daysLate, OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { kpiReading } from '../kpis/value'
import { wipDrill } from '../kpis/drills/wip'
import { dayOrNull } from '../sources/common'
import { today } from '../today'

/**
 * What a person's morning e-mail says (B-W2b-435; ANA-032), read AS THAT PERSON (`person`: a caller with their office context and
 * live grants): yesterday on the digest's clock, over the companies it covers. Every section reads the module's own records and
 * rules the screens read — never a second rule:
 *
 *   SHIPPED      the shipments that left yesterday (SHIPPED or DELIVERED, by the day they left) of the orders the person reads,
 *                with yesterday's "shipped on time" from the metric layer (KPI delivery.shipped_on_time through kpiReading)
 *   LATE         the open orders past their promise date today (the orders list's own daysLate), the latest first
 *   NEW_ORDERS   the orders dated yesterday (cancelled ones left out: the orders source's rule), their value from the metric layer
 *                (KPI sales.orders_in: price, in one currency; null without the price grain or before the facts are built)
 *   WIP_STUCK    the work orders nothing was reported on for more than WIP_STUCK_DAYS days (the WIP drill of B-W2b-429, the same
 *                reader as the KPI), the longest waiting first, with their line and their value at cost (the cost grain only)
 *   ALERTS       the alert rows of the person's Today (exception rules' alerts and the other alerts on their records)
 *   APPROVALS    the approvals waiting for the person on Today
 *
 * A section whose list the person cannot read is NO_ACCESS (left out, and said); one that fails to read is FAILED, never a guess.
 * Records are named by their own number; no person is ever named or counted.
 */

export interface DigestScope {
  /** The companies it covers (at least one). */
  readonly companyIds: readonly string[]
  /** Every company the person reaches is covered (a reading of the metric layer may then take the whole scope). */
  readonly everyCompany: boolean
  /** The digest's clock (the site's): "yesterday" is on it. */
  readonly timeZone: string
}

const LIMIT = 2000

const empty = (section: DigestSection, state: DigestSectionContent['state']): DigestSectionContent => ({ section, state, count: 0, extra: null, percent: null, amount: null, items: [] })
const ready = (section: DigestSection, fields: Partial<Omit<DigestSectionContent, 'section' | 'state'>>): DigestSectionContent => ({ ...empty(section, 'READY'), ...fields })
const item = (label: string, record: DigestItem['record'], days: number | null = null, place: string | null = null): DigestItem => ({ label, days, place, record })

/** The metric layer's place for a reading of the digest's companies: one company, every company, or none (a subset: no reading). */
const placeOf = (scope: DigestScope): { companyId?: string } | null => (scope.companyIds.length === 1 ? { companyId: scope.companyIds[0]! } : scope.everyCompany ? {} : null)

async function shipped(person: CommandCaller, actor: Actor, scope: DigestScope, day: BusinessDate): Promise<DigestSectionContent> {
  const range = businessDayRange(day, scope.timeZone)
  const found = await person.withClient((db) =>
    db.shipment.findMany({
      where: {
        AND: [
          scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.ShipmentWhereInput,
          { companyId: { in: [...scope.companyIds] }, status: { in: ['SHIPPED', 'DELIVERED'] }, shippedAt: { gte: range.start, lt: range.end } },
        ],
      },
      orderBy: [{ shippedAt: 'asc' }, { number: 'asc' }],
      take: LIMIT,
      select: { id: true, number: true },
    }),
  )
  const place = placeOf(scope)
  const file = kpiFileOf('delivery.shipped_on_time')
  const reading = place && file ? await kpiReading(person, actor, file, [periodOf('DAY', day)], place) : null
  return ready('SHIPPED', { count: found.length, percent: reading?.values[0] ?? null, items: found.slice(0, DIGEST_ITEMS).map((row) => item(row.number, { type: 'Shipment', id: row.id })) })
}

async function late(person: CommandCaller, actor: Actor, scope: DigestScope, today: BusinessDate): Promise<DigestSectionContent> {
  const found = await person.withClient((db) =>
    db.salesOrder.findMany({
      where: {
        AND: [
          scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput,
          { companyId: { in: [...scope.companyIds] }, status: { in: [...OPEN_STATUSES] }, promiseDate: { lt: new Date(`${today}T00:00:00Z`) } },
        ],
      },
      take: LIMIT,
      select: { id: true, number: true, status: true, promiseDate: true },
    }),
  )
  const rows = found
    .map((row) => ({ row, days: daysLate(row.status, dayOrNull(row.promiseDate), today) ?? 0 }))
    .filter((entry) => entry.days > 0)
    .sort((a, b) => b.days - a.days || (a.row.number < b.row.number ? -1 : 1))
  return ready('LATE', { count: rows.length, items: rows.slice(0, DIGEST_ITEMS).map((entry) => item(entry.row.number, { type: 'SalesOrder', id: entry.row.id }, entry.days)) })
}

async function newOrders(person: CommandCaller, actor: Actor, scope: DigestScope, day: BusinessDate): Promise<DigestSectionContent> {
  const found = await person.withClient((db) =>
    db.salesOrder.findMany({
      where: {
        AND: [
          scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput,
          { companyId: { in: [...scope.companyIds] }, status: { not: 'CANCELLED' }, orderDate: new Date(`${day}T00:00:00Z`) },
        ],
      },
      orderBy: [{ number: 'asc' }],
      take: LIMIT,
      select: { id: true, number: true },
    }),
  )
  const place = placeOf(scope)
  const file = kpiFileOf('sales.orders_in')
  const reading = found.length > 0 && place && file ? await kpiReading(person, actor, file, [periodOf('DAY', day)], place) : null
  const value = reading?.values[0] ?? null
  const amount = value !== null && reading?.currency && reading.problem === null ? { minor: Number(value), currency: reading.currency, grain: 'price' as const } : null
  return ready('NEW_ORDERS', { count: found.length, amount, items: found.slice(0, DIGEST_ITEMS).map((row) => item(row.number, { type: 'SalesOrder', id: row.id })) })
}

async function wipStuck(person: CommandCaller, scope: DigestScope): Promise<DigestSectionContent> {
  const drill = await wipDrill(person, { minWaitDays: WIP_STUCK_DAYS + 1 })
  const sites = new Set((await person.withClient((db) => db.site.findMany({ where: { companyId: { in: [...scope.companyIds] } }, select: { id: true } }))).map((site) => site.id))
  const rows = drill.rows.filter((row) => row.site !== null && sites.has(row.site.id))
  const whole = scope.everyCompany && drill.more === 0
  const count = whole ? drill.overall.workOrders : rows.length
  const waiting = rows.reduce((total, row) => total + row.stages.reduce((sum, stage) => sum + stage.waiting, 0), 0)
  // One value only in one currency, and only when every row has one (the cost grain and costing.view: else none at all).
  const valued = rows.length > 0 && rows.every((row) => row.value !== null && row.currency !== null)
  const currencies = new Set(rows.map((row) => row.currency))
  const amount = valued && currencies.size === 1 ? { minor: rows.reduce((total, row) => total + (row.value ?? 0), 0), currency: rows[0]!.currency!, grain: 'cost' as const } : null
  return ready('WIP_STUCK', {
    count,
    extra: waiting,
    amount,
    items: rows.slice(0, DIGEST_ITEMS).map((row) => item(row.workOrder.number, { type: 'WorkOrder', id: row.workOrder.id }, row.waitedDays, row.line?.code ?? null)),
  })
}

/** Today's rows of the person, once, for the alert and approval sections. */
async function todayRows(person: CommandCaller, scope: DigestScope) {
  const answer = await today(person, { include: ['ALERTS'], limit: 5000 })
  const covered = new Set(scope.companyIds)
  return answer.items.filter((row) => row.companyId === null || covered.has(row.companyId))
}

const fromToday = (section: 'ALERTS' | 'APPROVALS', rows: Awaited<ReturnType<typeof todayRows>>): DigestSectionContent => {
  const category = section === 'ALERTS' ? 'ALERT' : 'APPROVAL'
  const mine = rows.filter((row) => row.category === category)
  return ready(section, {
    count: mine.length,
    extra: section === 'ALERTS' ? mine.filter((row) => row.severity === 'HIGH').length : null,
    items: mine.slice(0, DIGEST_ITEMS).map((row) => item(row.record.label, { type: row.record.type, id: row.record.id })),
  })
}

/** Is it a refusal of the person's rights (a drill's own check): the section is left out, not failed. */
const isRefusal = (error: unknown): boolean => error instanceof DomainError && error.code === 'forbidden'

/** The digest's content for one person over its sections, as of `now`. */
export async function digestContent(person: CommandCaller, actor: Actor, scope: DigestScope, sections: readonly string[], companies: readonly string[], now: Date, onError?: (section: DigestSection, error: unknown) => void): Promise<DigestContent> {
  const todayDay = businessDate(now, scope.timeZone)
  const day = plusDays(todayDay, -1)
  const wanted = sectionsInOrder(sections)
  let rows: Awaited<ReturnType<typeof todayRows>> | null = null
  const out: DigestSectionContent[] = []
  for (const section of wanted) {
    if (!SECTION_NEEDS[section].every((permission) => holds(actor, permission))) {
      out.push(empty(section, 'NO_ACCESS'))
      continue
    }
    try {
      switch (section) {
        case 'SHIPPED':
          out.push(await shipped(person, actor, scope, day))
          break
        case 'LATE':
          out.push(await late(person, actor, scope, todayDay))
          break
        case 'NEW_ORDERS':
          out.push(await newOrders(person, actor, scope, day))
          break
        case 'WIP_STUCK':
          out.push(await wipStuck(person, scope))
          break
        case 'ALERTS':
        case 'APPROVALS':
          rows ??= await todayRows(person, scope)
          out.push(fromToday(section, rows))
          break
      }
    } catch (error) {
      if (isRefusal(error)) out.push(empty(section, 'NO_ACCESS'))
      else {
        onError?.(section, error)
        out.push(empty(section, 'FAILED'))
      }
    }
  }
  return { day, today: todayDay, companies, sections: out }
}
