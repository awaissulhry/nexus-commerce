import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { monthOf, type StatementStatus } from '@nexus/factory-domain/people/earnings/rules'
import type { StatementSummary } from '@nexus/factory-domain/people/earnings/statement'
import { STATION_SITE } from '@nexus/factory-domain/production/labour/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { systemContext } from '../../../platform/outbox/system'
import { asContext } from '../clock/access'
import { dateOf } from '../employees/access'
import { scanSubjectFor } from '../../production/settings/subject'
import { floorOf } from './access'
import { monthOfPeriod, periodOfMonth } from './store'

/**
 * My pay on the floor (B-W2b-43; MES-111, MES-261; c.c. art. 2101 c.3; design floor.myday "Today", "Statement for the
 * period"): the signed-in worker's OWN entries and statement, the same statement HR approves. floor.work with the PIN again
 * (the route's requireFloorStepUp). The floor role has no grant on any pay table: the API reads them in the tenant's system
 * scope, after the session is checked, and only this person's rows. The worker always reads their own pay; a site that
 * records stations names nobody, so there is no personal list.
 */
export async function floorMine(caller: CommandCaller, query: { readonly month?: string | undefined }) {
  const context = floorOf(caller)
  const system = asContext(caller, systemContext(context.tenantId, context.requestId))
  const now = serverClock.now()
  return system.withClient(async (db) => {
    const site = await db.site.findUnique({ where: { id: context.siteId }, select: { companyId: true, timezone: true } })
    if (!site) throw new NotFoundError('Site not found.')
    const today = businessDate(now, site.timezone)
    const month = query.month ?? monthOf(today)
    const empty = { subject: 'WORKER' as const, today, month, status: null, currency: 'EUR', todayPieces: 0, todayEarnings: asMoney('pay', 0), periodPieces: 0, periodEarnings: asMoney('pay', 0), held: 0, statement: null, words: [] as string[] }
    if ((await scanSubjectFor(db, context.siteId)) === 'STATION') return { ...empty, subject: 'STATION' as const, words: [STATION_SITE.message] }
    const worker = await db.worker.findUnique({ where: { id: context.actorId }, select: { employeeId: true } })
    if (!worker?.employeeId) return { ...empty, words: ['Your floor sign-in is not linked to your employee record yet: ask the office.'] }
    const period = await periodOfMonth(db, site.companyId, month)
    if (!period) return empty
    const entries = await db.earningsEntry.findMany({ where: { payPeriodId: period.id, employeeId: worker.employeeId }, select: { kind: true, workDate: true, pieces: true, sharePct: true, amount: true, currency: true } })
    const paid = entries.filter((row) => row.kind !== 'MAKE_UP')
    const piecesOf = (rows: typeof entries): number => rows.filter((row) => row.kind === 'SCAN').reduce((sum, row) => sum + (row.pieces ?? 0), 0)
    const sum = (rows: typeof entries): number => rows.reduce((total, row) => total + row.amount, 0)
    const todays = paid.filter((row) => row.workDate.getTime() === dateOf(today).getTime())
    const held = await db.heldScan.count({ where: { payPeriodId: period.id, employeeId: worker.employeeId, status: 'OPEN' } })
    const statement = await db.workerStatement.findFirst({ where: { payPeriodId: period.id, employeeId: worker.employeeId, status: { not: 'SUPERSEDED' } }, orderBy: { revision: 'desc' }, select: { id: true, status: true, revision: true, summary: true, earningsAmount: true, makeUpAmount: true, currency: true } })
    const summary = (statement?.summary ?? null) as StatementSummary | null
    const money = <T>(value: T) => asMoney('pay', value)
    return {
      subject: 'WORKER' as const,
      today,
      month: monthOfPeriod(period),
      status: period.status,
      currency: entries[0]?.currency ?? 'EUR',
      todayPieces: piecesOf(todays),
      todayEarnings: money(sum(todays)),
      periodPieces: piecesOf(paid),
      periodEarnings: money(sum(paid)),
      held,
      statement:
        statement && summary
          ? {
              id: statement.id,
              status: statement.status as StatementStatus,
              revision: statement.revision,
              currency: statement.currency,
              lines: summary.lines.map((line) => ({ operationCode: line.operationCode, operationName: line.operationName, pieces: line.pieces, minutes: line.minutes, sharePct: line.sharePct, rate: money(line.rate), amount: money(line.amount) })),
              time: summary.time.map((line) => ({ code: line.code, minutes: line.minutes, rate: money(line.rate), amount: money(line.amount) })),
              bonus: summary.bonus ? { ...summary.bonus, amount: money(summary.bonus.amount) } : null,
              earningsAmount: money(statement.earningsAmount),
              makeUpAmount: money(statement.makeUpAmount),
            }
          : null,
      words: [],
    }
  })
}
