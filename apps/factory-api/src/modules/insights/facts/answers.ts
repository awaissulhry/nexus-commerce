import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { daysOf } from '@nexus/factory-domain/calendars/working-time'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { HOME_KPIS_MANAGE, HOME_KPIS_VIEW } from '@nexus/factory-domain/insights/kpis/permissions'
import { MEASURES, measureOf, type Measure } from '@nexus/factory-domain/insights/kpis/measures'
import { shiftOfHour, shiftWindows } from '@nexus/factory-domain/insights/periods/periods'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { workingCalendarFor } from '../../../platform/calendars/service'
import { officeContextOf } from '../viewer'
import { checkRange, REBUILD_MAX_DAYS, rebuildFacts } from './rebuild'

/**
 * The facts and measures as the API answers them (B-W2b-428; ANA-069 reporting projections, ANA-028 periods aligned to
 * calendars), office:
 *
 *   GET  /insights/measures         home.kpis.view   the measure registry (what each counts from, its unit, grain, kind, levels,
 *                                                    whether I may read it) and how fresh each company's facts are
 *   GET  /insights/facts            home.kpis.view   one measure's facts of some days in my scope, per DAY (the stored rows),
 *                                                    HOUR (the hourly rows) or SHIFT (the hourly rows summed per shift of the
 *                                                    site's or line's working calendar, a night shift on the day it began);
 *                                                    the measure's own list permission and grain, or 403 in words
 *   POST /insights/facts/rebuild    home.kpis.manage the facts of up to 93 days rebuilt from the records, for the companies my
 *                                                    grant reaches (or one of them)
 */

export const FACT_GROUPINGS = ['DAY', 'HOUR', 'SHIFT'] as const
export type FactGrouping = (typeof FACT_GROUPINGS)[number]

/** At most this many rows in one answer (`complete: false` beyond). */
export const FACT_ROW_LIMIT = 2000

export interface FactsQuery {
  readonly measure: string
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly by?: FactGrouping | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
}

/** May the person read this measure: its list permission and money grain (403 in words, as the reports say it). */
function checkMeasure(actor: Actor, measure: Measure): void {
  if (!holds(actor, measure.permission)) throw new DomainError('forbidden', `Its records are not yours to read: it needs ${measure.permission}.`, [{ path: `permission/${measure.permission}`, message: 'Not held.' }])
  if (measure.grain && !heldGrains(actor).has(measure.grain)) throw new DomainError('forbidden', `Its amounts need the ${measure.grain} rights.`, [{ path: `grain/${measure.grain}`, message: 'Not held.' }])
}

const marked = (measure: Measure, value: string): unknown => (measure.grain ? markMoney(measure.grain, value) : value)

const numberText = (row: { value: Prisma.Decimal | null; priceAmount: number | null; costAmount: number | null; marginAmount: number | null }): string =>
  row.value !== null ? new Dec(row.value.toString()).toString() : String(row.priceAmount ?? row.costAmount ?? row.marginAmount ?? 0)

/** GET /insights/measures */
export async function measuresAnswer(caller: CommandCaller) {
  const actor = actorOf(officeContextOf(caller))
  const grains = heldGrains(actor)
  const companies = await caller.withClient(async (db) => {
    const list = await db.company.findMany({ where: scopeWhere(actor, HOME_KPIS_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput, select: { id: true, code: true, timezone: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    const stamps = list.length ? await db.factDaily.groupBy({ by: ['companyId'], where: { companyId: { in: list.map((company) => company.id) } }, _max: { rebuiltAt: true, day: true } }) : []
    const of = new Map(stamps.map((row) => [row.companyId, row._max]))
    return list.map((company) => ({ id: company.id, code: company.code, today: businessDate(serverClock.now(), company.timezone), lastRebuiltAt: of.get(company.id)?.rebuiltAt ? toUtcIso(of.get(company.id)!.rebuiltAt!) : null, lastDay: of.get(company.id)?.day ? of.get(company.id)!.day!.toISOString().slice(0, 10) : null }))
  })
  return {
    asOf: toUtcIso(serverClock.now()),
    measures: MEASURES.map((measure) => ({
      key: measure.key,
      source: measure.source,
      unit: measure.unit,
      grain: measure.grain,
      kind: measure.kind,
      levels: [...measure.levels],
      hourly: measure.hourly,
      permission: measure.permission,
      records: [...measure.records],
      readable: holds(actor, measure.permission) && (!measure.grain || grains.has(measure.grain)),
    })),
    companies,
  }
}

/** GET /insights/facts */
export async function factsAnswer(caller: CommandCaller, query: FactsQuery) {
  const actor = actorOf(officeContextOf(caller))
  const measure = measureOf(query.measure)
  if (!measure) throw new NotFoundError('No such measure.')
  checkMeasure(actor, measure)
  if (query.to < query.from) throw new ValidationError('The last day comes after the first.', [{ path: 'querystring/to', message: 'Not before the first day.' }])
  if (daysFrom(query.from, query.to) + 1 > REBUILD_MAX_DAYS) throw new ValidationError(`At most ${REBUILD_MAX_DAYS} days at a time.`, [{ path: 'querystring/from', message: `At most ${REBUILD_MAX_DAYS} days.` }])
  const by = query.by ?? 'DAY'
  if (by !== 'DAY' && !measure.hourly) throw new ValidationError('This measure is kept per day only.', [{ path: 'querystring/by', message: 'DAY only.' }])
  if (query.lineId && !measure.levels.includes('LINE')) throw new ValidationError('This measure is not kept per line.', [{ path: 'querystring/lineId', message: 'Not a line measure.' }])
  if (by === 'SHIFT' && !query.siteId) throw new ValidationError('Shifts are a site’s: choose the site.', [{ path: 'querystring/siteId', message: 'Required with SHIFT.' }])
  const scope = scopeWhere(actor, measure.permission, { company: 'companyId', ...(measure.levels.includes('COMPANY') ? {} : { site: 'siteId' }) })
  const place = {
    ...(query.companyId ? { companyId: query.companyId } : {}),
    ...(query.siteId && !measure.levels.includes('COMPANY') ? { siteId: query.siteId } : {}),
    ...(query.lineId ? { lineId: query.lineId } : query.siteId || by === 'SHIFT' ? { lineId: null } : {}),
  }
  const days = { gte: new Date(`${query.from}T00:00:00.000Z`), lte: new Date(`${query.to}T00:00:00.000Z`) }
  const base = { measure: measure.key, unit: measure.unit, grain: measure.grain, kind: measure.kind, by, from: query.from, to: query.to }
  if (by === 'DAY') {
    const rows = await caller.withClient((db) =>
      db.factDaily.findMany({
        where: { AND: [scope as Prisma.FactDailyWhereInput, { measureKey: measure.key, day: days }, place] },
        select: { companyId: true, siteId: true, lineId: true, day: true, value: true, priceAmount: true, costAmount: true, marginAmount: true, currency: true, rebuiltAt: true },
        orderBy: [{ day: 'asc' }, { companyId: 'asc' }, { siteId: 'asc' }, { lineId: 'asc' }],
        take: FACT_ROW_LIMIT + 1,
      }),
    )
    return {
      ...base,
      complete: rows.length <= FACT_ROW_LIMIT,
      rows: rows.slice(0, FACT_ROW_LIMIT).map((row) => ({ companyId: row.companyId, siteId: row.siteId, lineId: row.lineId, day: row.day.toISOString().slice(0, 10), hourStart: null, shift: null, value: marked(measure, numberText(row)), currency: row.currency, rebuiltAt: toUtcIso(row.rebuiltAt) })),
    }
  }
  const hours = await caller.withClient((db) =>
    db.factHourly.findMany({
      where: { AND: [scope as Prisma.FactHourlyWhereInput, { measureKey: measure.key, day: days }, place] },
      select: { companyId: true, siteId: true, lineId: true, day: true, hourStart: true, value: true, priceAmount: true, costAmount: true, marginAmount: true, currency: true, rebuiltAt: true },
      orderBy: [{ hourStart: 'asc' }, { siteId: 'asc' }, { lineId: 'asc' }],
      take: FACT_ROW_LIMIT * 4,
    }),
  )
  if (by === 'HOUR') {
    return {
      ...base,
      complete: hours.length <= FACT_ROW_LIMIT,
      rows: hours.slice(0, FACT_ROW_LIMIT).map((row) => ({ companyId: row.companyId, siteId: row.siteId, lineId: row.lineId, day: row.day.toISOString().slice(0, 10), hourStart: toUtcIso(row.hourStart), shift: null, value: marked(measure, numberText(row)), currency: row.currency, rebuiltAt: toUtcIso(row.rebuiltAt) })),
    }
  }
  // SHIFT: the site's (or the line's) working calendar, the day before too (its night shift reaches into the first day).
  const siteId = query.siteId!
  const site = isUuid(siteId) ? await caller.withClient((db) => db.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } })) : null
  if (!site || !can(actor, measure.permission, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
  const calendar = await caller.withClient((db) => workingCalendarFor(db, query.lineId ? { scope: 'LINE', id: query.lineId } : { scope: 'SITE', id: site.id }, { from: plusDays(query.from, -1), to: query.to }))
  const windows = shiftWindows(daysOf(calendar.calendar, plusDays(query.from, -1), query.to)).filter((window) => window.day >= query.from)
  const sums = new Map<string, { day: BusinessDate; label: string; start: Date; end: Date; total: Decimal; rebuiltAt: Date | null }>()
  for (const window of windows) sums.set(`${window.day}|${window.label}|${window.start.toISOString()}`, { ...window, total: new Dec(0), rebuiltAt: null })
  const keyOf = (window: { day: string; label: string; start: Date }) => `${window.day}|${window.label}|${window.start.toISOString()}`
  // The hours of the night shift that began the last day reach past it: read the day after too.
  const after = await caller.withClient((db) =>
    db.factHourly.findMany({
      where: { AND: [scope as Prisma.FactHourlyWhereInput, { measureKey: measure.key, day: new Date(`${plusDays(query.to, 1)}T00:00:00.000Z`) }, place] },
      select: { companyId: true, siteId: true, lineId: true, day: true, hourStart: true, value: true, priceAmount: true, costAmount: true, marginAmount: true, currency: true, rebuiltAt: true },
    }),
  )
  for (const row of [...hours, ...after]) {
    const window = shiftOfHour(row.hourStart, windows)
    if (!window) continue
    const sum = sums.get(keyOf(window))!
    sum.total = sum.total.plus(new Dec(numberText(row)))
    if (!sum.rebuiltAt || row.rebuiltAt < sum.rebuiltAt) sum.rebuiltAt = row.rebuiltAt
  }
  return {
    ...base,
    complete: hours.length < FACT_ROW_LIMIT * 4,
    rows: [...sums.values()].map((sum) => ({ companyId: site.companyId, siteId: site.id, lineId: query.lineId ?? null, day: sum.day, hourStart: toUtcIso(sum.start), shift: { label: sum.label, start: toUtcIso(sum.start), end: toUtcIso(sum.end) }, value: marked(measure, sum.total.toString()), currency: null, rebuiltAt: sum.rebuiltAt ? toUtcIso(sum.rebuiltAt) : null })),
  }
}

/** POST /insights/facts/rebuild: the companies my manage grant reaches (or the one named). */
export async function rebuildAnswer(caller: CommandCaller, body: { readonly from: BusinessDate; readonly to: BusinessDate; readonly companyId?: string | undefined }, idempotencyKey: string | null | undefined) {
  const actor = actorOf(officeContextOf(caller))
  checkRange(body.from, body.to, businessDate(serverClock.now()))
  const grants = grantsFor(actor, HOME_KPIS_MANAGE)
  let companyIds: string[] | undefined
  if (body.companyId) {
    if (!can(actor, HOME_KPIS_MANAGE, { companyId: body.companyId })) throw new NotFoundError('Company not found.')
    companyIds = [body.companyId]
  } else if (!grants.some((grant) => grant.companies === 'all')) {
    companyIds = [...new Set(grants.flatMap((grant) => (grant.companies === 'all' ? [] : grant.companies)))]
  }
  const outcome = await rebuildFacts(caller, { from: body.from, to: body.to, ...(companyIds ? { companyIds } : {}), trigger: 'PERSON', idempotencyKey })
  return outcome
}
