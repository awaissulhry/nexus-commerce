import type { Prisma } from '@nexus/factory-db'
import { heldGrains, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { holds, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { grainsOfKpi, permissionsOfKpi } from '@nexus/factory-domain/insights/kpis/catalogue'
import { kpiFileOf } from '@nexus/factory-domain/insights/kpis/registry'
import { periodOf } from '@nexus/factory-domain/insights/periods/periods'
import type { CommandCaller } from '../../../../core/command'
import { actorOf } from '../../../../core/context'
import { serverClock } from '../../../../core/time'
import { factCompanies, type FactCompany, type FactSite, type Reader } from '../../facts/rows'
import { officeContextOf } from '../../viewer'

/**
 * What every drill of the ready KPIs shares (B-W2b-429; follow-up KP2:01 "each KPI's drill opens its list with the filters it
 * needs"): the person may open a KPI's records only with the permissions and money grains its value needs (the manifest asks
 * home.kpis.view; each measure's list permission and grain, as kpis/value.ts asks them, 403 in words otherwise), within the
 * companies and sites of their grant; the period is the KPI's own period up to today unless one is asked (at most
 * DRILL_MAX_DAYS); at most DRILL_ROW_LIMIT records in an answer (`more` says how many were left out; the groups and totals
 * count them all). Nothing here names a person.
 */

export const DRILL_ROW_LIMIT = 500
const DRILL_MAX_DAYS = 366

/** The person, if they may open the records of these KPIs (each one's measures' permissions and grains). */
export function drillActor(caller: CommandCaller, kpiKeys: readonly string[]): Actor {
  const actor = actorOf(officeContextOf(caller))
  const grains = heldGrains(actor)
  for (const key of kpiKeys) {
    const file = kpiFileOf(key)!
    for (const permission of permissionsOfKpi(file)) {
      if (!holds(actor, permission)) throw new DomainError('forbidden', `The records behind this KPI are not yours to read: it needs ${permission}.`, [{ path: `permission/${permission}`, message: 'Not held.' }])
    }
    for (const grain of grainsOfKpi(file)) {
      if (!grains.has(grain)) throw new DomainError('forbidden', `The records behind this KPI show amounts that need the ${grain} rights.`, [{ path: `grain/${grain}`, message: 'Not held.' }])
    }
  }
  return actor
}

export const holdsGrain = (actor: Actor, grain: Grain): boolean => heldGrains(actor).has(grain)

export interface Span {
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/**
 * The asked period, else the KPI's current period, up to today at most (nothing is due, shipped, cut or received in the days
 * to come: the facts stop at today too); 400 in words when it runs backwards, has not begun or is too long.
 */
export function spanOf(kpiKey: string, query: { readonly from?: BusinessDate | undefined; readonly to?: BusinessDate | undefined }): Span {
  const today = businessDate(serverClock.now())
  const period = periodOf(kpiFileOf(kpiKey)!.period, query.to ?? today)
  const from = query.from ?? period.from
  const asked = query.to ?? period.to
  if (from > asked) throw new ValidationError('The period ends before it begins.', [{ path: 'querystring/from', message: 'On or before `to`.' }])
  if (from > today) throw new ValidationError('The period has not begun yet.', [{ path: 'querystring/from', message: 'On or before today.' }])
  const to = asked < today ? asked : today
  if (daysFrom(from, to) + 1 > DRILL_MAX_DAYS) throw new ValidationError(`A drill reads at most ${DRILL_MAX_DAYS} days.`, [{ path: 'querystring/from', message: `At most ${DRILL_MAX_DAYS} days before \`to\`.` }])
  return { from, to }
}

/** The companies (with their sites) the person reaches with a permission, or the one asked (none when outside the grant). */
export async function companiesFor(db: Reader, actor: Actor, permission: Permission, companyId?: string): Promise<FactCompany[]> {
  const reached = await db.company.findMany({ where: { AND: [scopeWhere(actor, permission, { company: 'id' }) as Prisma.CompanyWhereInput, companyId ? { id: companyId } : {}] }, select: { id: true } })
  if (reached.length === 0) return []
  return factCompanies(db, reached.map((company) => company.id))
}

/** The sites the person reaches with a permission (their company's and their own scope), or the one asked. */
export async function sitesFor(db: Reader, actor: Actor, permission: Permission, filter: { readonly companyId?: string | undefined; readonly siteId?: string | undefined } = {}): Promise<(FactSite & { readonly code: string })[]> {
  return db.site.findMany({
    where: { AND: [scopeWhere(actor, permission, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, filter.companyId ? { companyId: filter.companyId } : {}, filter.siteId ? { id: filter.siteId } : {}] },
    select: { id: true, companyId: true, code: true, name: true, timezone: true },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  })
}

const unique = (values: readonly (string | null | undefined)[]): string[] => [...new Set(values.filter((value): value is string => typeof value === 'string'))]

/** Names of the records the rows point at (customers and suppliers, styles, sites, lines, seasons, items), read once. */
export async function namesOf(db: Reader, ids: { parties?: readonly (string | null)[]; styles?: readonly (string | null)[]; sites?: readonly (string | null)[]; lines?: readonly (string | null)[]; seasons?: readonly (string | null)[]; items?: readonly (string | null)[] }) {
  const parties = unique(ids.parties ?? [])
  const styles = unique(ids.styles ?? [])
  const sites = unique(ids.sites ?? [])
  const lines = unique(ids.lines ?? [])
  const seasons = unique(ids.seasons ?? [])
  const items = unique(ids.items ?? [])
  const [partyRows, styleRows, siteRows, lineRows, seasonRows, itemRows] = await Promise.all([
    parties.length ? db.party.findMany({ where: { id: { in: parties } }, select: { id: true, code: true, legalName: true, tradeName: true } }) : [],
    styles.length ? db.style.findMany({ where: { id: { in: styles } }, select: { id: true, code: true, name: true, productType: true } }) : [],
    sites.length ? db.site.findMany({ where: { id: { in: sites } }, select: { id: true, code: true, name: true } }) : [],
    lines.length ? db.line.findMany({ where: { id: { in: lines } }, select: { id: true, code: true, name: true } }) : [],
    seasons.length ? db.season.findMany({ where: { id: { in: seasons } }, select: { id: true, code: true, name: true } }) : [],
    items.length ? db.item.findMany({ where: { id: { in: items } }, select: { id: true, code: true, name: true, kind: true, baseUom: true } }) : [],
  ])
  return {
    party: new Map(partyRows.map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }])),
    style: new Map(styleRows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, family: row.productType as string }])),
    site: new Map(siteRows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name }])),
    line: new Map(lineRows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name }])),
    season: new Map(seasonRows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name }])),
    item: new Map(itemRows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, kind: row.kind as string, uom: row.baseUom as string }])),
  }
}


/** A reference for an answer (null when the record is unknown). */
export const refOf = <T extends { id: string; code: string; name: string }>(map: ReadonlyMap<string, T>, id: string | null | undefined): { id: string; code: string; name: string } | null => {
  const row = id ? map.get(id) : undefined
  return row ? { id: row.id, code: row.code, name: row.name } : null
}

/** Rows in the answer's order, at most DRILL_ROW_LIMIT, and how many were left out. */
export const limited = <T>(rows: readonly T[]): { rows: T[]; more: number } => ({ rows: rows.slice(0, DRILL_ROW_LIMIT), more: Math.max(0, rows.length - DRILL_ROW_LIMIT) })

/** Groups rows by a key, first met first, with a value read once per group. */
export function groupBy<T, K extends string>(rows: readonly T[], keyOf: (row: T) => K | null): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    if (key === null) continue
    out.set(key, [...(out.get(key) ?? []), row])
  }
  return out
}

export const asOf = (): string => serverClock.now().toISOString()
