import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { periodOf, periodRange, type DayRange } from '@nexus/factory-domain/insights/reports/results'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../viewer'
import type { ReportRun } from './report'
import { sitesReached, type ReachedSite } from './run'

/**
 * Small helpers the report definitions share (B-W2a-79). Not a registry file: ./defs/ holds only reports.
 */

/** The run's person as an actor (office only: every report route is office only). */
export const actorOfRun = (run: ReportRun): Actor => actorOf(officeContextOf(run.caller))

/** A day from the API (a Date at midnight UTC, or text) as YYYY-MM-DD; null stays null. */
export function dayOf(value: Date | string | null | undefined): BusinessDate | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.slice(0, 10)
  return value.toISOString().slice(0, 10)
}

/** The range of a period filter, or null when the run asked for any time. */
export function rangeOf(run: ReportRun, key = 'period'): DayRange | null {
  const period = periodOf(run.filters[key])
  return period ? periodRange(period, run.today) : null
}

/** The sites a run reads: the one its site filter names, else every site the person reaches with the permission. */
export async function runSites(run: ReportRun, permission: Permission, key = 'site'): Promise<ReachedSite[]> {
  const sites = await sitesReached(run.caller, actorOfRun(run), permission)
  const asked = run.filters[key]
  return asked ? sites.filter((site) => site.id === asked) : sites
}

/**
 * Reads a cursor-paged module list until `limit` rows (or its end): `page(cursor)` returns one page. `complete` is false
 * when rows were left.
 */
export async function readPages<Row>(limit: number, page: (cursor: string | undefined) => Promise<{ rows: readonly Row[]; next: string | null }>): Promise<{ rows: Row[]; complete: boolean }> {
  const rows: Row[] = []
  let cursor: string | undefined
  for (;;) {
    const answer = await page(cursor)
    rows.push(...answer.rows)
    if (answer.next === null) return { rows: rows.slice(0, limit), complete: rows.length <= limit }
    if (rows.length >= limit) return { rows: rows.slice(0, limit), complete: false }
    cursor = answer.next
  }
}

/** A Prisma or JSON number (minor units, a count) as a number. */
export const numberOf = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

/** The sales order statuses that are open (factory-domain sales/orders OPEN_STATUSES). */
export const OPEN_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const

/** A party's name as its lists show it. */
export const partyName = (party: { readonly tradeName: string | null; readonly legalName: string }): string => party.tradeName ?? party.legalName
