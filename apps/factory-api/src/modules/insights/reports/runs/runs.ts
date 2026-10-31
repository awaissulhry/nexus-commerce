import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../../core/command'

/**
 * The report run log (B-W2b-24, followup Z12:06 of B-W2a-79; design home.reports library "Row: name, the question, last
 * run by me"; table ReportRun, insights.prisma, B-W2b-03): one row per run of a report — who ran it, which report, the
 * filters it ran with, when — and "last run by me" read back from the person's OWN rows, never another person's.
 *
 *   recordRun(caller, run)                  after a run of GET /reports/:key/results answered: one ReportRun row
 *   lastRunsByMe(caller, userId, keys?)     the newest run of each report by that person (the library)
 *   lastRunByMe(caller, userId, key)        the same for one report (its About)
 *
 * Bookkeeping, not a command(): a run is a READ, and the row is itself the record of who read what and when (as the floor
 * device's state report and a person's search reads write no audit row); a command would add an audit row and an
 * idempotency receipt per page view, doubling what the row says. The office runtime may insert and read its rows (the
 * generated policies), the database refuses an UPDATE and checks the key's shape and that the filters are an object
 * (…_followups_platform_w2b_guards). A run log that cannot be written never fails the report: it is logged and the
 * person gets their rows. Retention: none set yet (the privacy step decides how long personal activity is kept;
 * DELETE is granted for it, GDPR art. 5(1)(e)).
 */

/** A report key as the database checks it (`production.daily`, `sales.open-orders`). */
export const REPORT_RUN_KEY = /^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_.-]*$/

/** The filters a run was made with, as the report read them: only the filters given a value, and the grouping asked. */
export function runParamsOf(filters: Readonly<Record<string, string | null | undefined>>, group: string | null): Record<string, string> {
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(filters)) if (typeof value === 'string' && value !== '') params[key] = value
  if (group !== null) params.group = group
  return params
}

export interface ReportRunEntry {
  readonly userId: string
  readonly reportKey: string
  readonly params: Readonly<Record<string, string>>
  readonly at: Date
}

interface Logger {
  warn(details: Record<string, unknown>, message: string): void
}
const loggerOf = (caller: CommandCaller): Logger | null => (caller as unknown as { log?: Logger }).log ?? null

/** One ReportRun row for a run that answered. False (logged) when it could not be written: the report still answers. */
export async function recordRun(caller: CommandCaller, run: ReportRunEntry): Promise<boolean> {
  if (!REPORT_RUN_KEY.test(run.reportKey)) {
    loggerOf(caller)?.warn({ reportKey: run.reportKey }, 'a report run was not logged: its key is not a report key')
    return false
  }
  try {
    await caller.withClient((db) =>
      db.reportRun.create({
        data: { id: newId(), userId: run.userId, reportKey: run.reportKey, params: { ...run.params } as Prisma.InputJsonObject, at: run.at, createdAt: run.at, createdById: run.userId },
        select: { id: true },
      }),
    )
    return true
  } catch (error) {
    loggerOf(caller)?.warn({ err: error, reportKey: run.reportKey }, 'a report run could not be logged (the report answered all the same)')
    return false
  }
}

/** The newest run of each report by this person (UTC ISO), only for `keys` when given. Never another person's runs. */
export async function lastRunsByMe(caller: CommandCaller, userId: string, keys?: readonly string[]): Promise<Map<string, string>> {
  if (keys !== undefined && keys.length === 0) return new Map()
  const rows = await caller.withClient((db) =>
    db.reportRun.groupBy({
      by: ['reportKey'],
      where: { userId, ...(keys ? { reportKey: { in: [...keys] } } : {}) },
      _max: { at: true },
    }),
  )
  const out = new Map<string, string>()
  for (const row of rows) if (row._max.at) out.set(row.reportKey, toUtcIso(row._max.at))
  return out
}

/** The newest run of one report by this person (UTC ISO), or null. */
export async function lastRunByMe(caller: CommandCaller, userId: string, reportKey: string): Promise<string | null> {
  return (await lastRunsByMe(caller, userId, [reportKey])).get(reportKey) ?? null
}
