import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PEOPLE_EARNINGS_VIEW } from '@nexus/factory-domain/people/earnings/permissions'
import { TOO_FEW_WORDS, groupShown } from '@nexus/factory-domain/people/privacy/groups'
import { monthPeriod } from '@nexus/factory-domain/people/overtime/timesheets'
import { reportRows, type ReportEntry } from '@nexus/factory-domain/people/reports/earnings/report'
import { command, type CommandCaller } from '../../../../core/command'
import { actorOf } from '../../../../core/context'
import { serverClock } from '../../../../core/time'
import { fullName, type Client } from '../../attendance/store'
import { dateOf, dayOf } from '../../employees/access'
import { officeOf, requireRight, seesPay } from '../../earnings/access'
import { minimumGroupSizeFor } from '../../privacy/groups'
import type { EarningsReportQuery } from './contract'

/**
 * The earnings report (B-W2b-43; MES-304; design people.reports "Earnings report": "Group by line for people without
 * individual access"; "Needs the wages grain"). Per line (or month), for people.earnings.view with the pay grain: the groups
 * under the company's minimum size are emptied. Per worker, only with the right, as a recorded opening (a POST with its
 * audit row): the one list that names people, because the feature asks for it and HR pays from it; nobody else reaches it.
 * The line of an entry: its scan's station or tablet, its block's; a make-up or an adjustment goes to the person's home line.
 * Figures from the ledger, reversals included.
 */

interface Row extends ReportEntry {
  readonly line: string | null
  readonly month: string
}

async function rowsOf(db: Client, input: { readonly companyId: string; readonly from: string; readonly to: string; readonly siteId?: string | undefined }): Promise<Row[]> {
  const where: Prisma.EarningsEntryWhereInput = { companyId: input.companyId, workDate: { gte: dateOf(monthPeriod(input.from)!.periodStart), lte: dateOf(monthPeriod(input.to)!.periodEnd) }, ...(input.siteId ? { siteId: input.siteId } : {}) }
  const entries = await db.earningsEntry.findMany({ where, select: { kind: true, employeeId: true, pieces: true, sharePct: true, amount: true, workDate: true, sourceType: true, sourceId: true, operationScan: { select: { station: { select: { lineId: true } }, device: { select: { lineId: true } } } } } })
  const blocks = entries.flatMap((row) => (row.sourceType === 'OffStandardEntry' && row.sourceId ? [row.sourceId] : []))
  const lineOfBlock = new Map((blocks.length === 0 ? [] : await db.offStandardEntry.findMany({ where: { id: { in: blocks } }, select: { id: true, lineId: true } })).map((row) => [row.id, row.lineId]))
  const homes = new Map((await db.employee.findMany({ where: { id: { in: [...new Set(entries.map((row) => row.employeeId))] } }, select: { id: true, homeLineId: true } })).map((row) => [row.id, row.homeLineId]))
  return entries.map((row) => ({
    // BONUS is in the schema (B-W2b-75), but nothing books one before B-W2b-84: it widens the kinds and drops this `as`.
    kind: row.kind as ReportEntry['kind'],
    employeeId: row.employeeId,
    pieces: row.pieces,
    sharePct: row.sharePct?.toString() ?? null,
    amount: row.amount,
    month: dayOf(row.workDate).slice(0, 7),
    line: row.operationScan ? (row.operationScan.station?.lineId ?? row.operationScan.device?.lineId ?? null) : row.sourceId && lineOfBlock.has(row.sourceId) ? (lineOfBlock.get(row.sourceId) ?? null) : (homes.get(row.employeeId) ?? null),
  }))
}

const NO_LINE = 'none'

/** Figures per line of a range of months: a group under the minimum, or a caller without the pay grain, sees no figure. */
export async function lineRows(db: Client, input: { readonly companyId: string; readonly from: string; readonly to: string; readonly siteId?: string | undefined; readonly minimum: number; readonly payShown: boolean }) {
  const rows = await rowsOf(db, input)
  const made = reportRows(rows.map((row) => ({ ...row, group: row.line ?? NO_LINE })))
  const ids = made.flatMap((row) => (row.key === NO_LINE ? [] : [row.key]))
  const lines = new Map((ids.length === 0 ? [] : await db.line.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  return made
    .map((row) => {
      const shown = input.payShown && groupShown(row.people, input.minimum)
      return {
        line: row.key === NO_LINE ? null : (lines.get(row.key) ?? null),
        people: shown ? row.people : null,
        pieces: shown ? row.pieces : null,
        earnings: asMoney('pay', shown ? row.earnings : null),
        makeUp: asMoney('pay', shown ? row.makeUp : null),
        makeUpSharePct: shown ? row.makeUpSharePct : null,
        tooFew: !groupShown(row.people, input.minimum),
      }
    })
    .sort((a, b) => (a.line?.code ?? '~').localeCompare(b.line?.code ?? '~'))
}

function requireMonths(query: EarningsReportQuery): { from: string; to: string } {
  const to = query.to ?? query.from
  return { from: query.from, to }
}

/** Per line (the default) or per month. */
export async function earningsReport(caller: CommandCaller, query: EarningsReportQuery) {
  const context = officeOf(caller)
  if (!can(actorOf(context), PEOPLE_EARNINGS_VIEW, { companyId: query.companyId })) throw new ForbiddenError()
  if (!seesPay(context)) throw new ForbiddenError('The earnings report needs the pay grain.')
  const { from, to } = requireMonths(query)
  return caller.withClient(async (db) => {
    const minimum = await minimumGroupSizeFor(db, query.companyId)
    const lines = await lineRows(db, { companyId: query.companyId, from, to, siteId: query.siteId, minimum, payShown: true })
    const months = reportRows((await rowsOf(db, { companyId: query.companyId, from, to, siteId: query.siteId })).map((row) => ({ ...row, group: row.month }))).map((row) => {
      const shown = groupShown(row.people, minimum)
      return { month: row.key, people: shown ? row.people : null, pieces: shown ? row.pieces : null, earnings: asMoney('pay', shown ? row.earnings : null), makeUp: asMoney('pay', shown ? row.makeUp : null), makeUpSharePct: shown ? row.makeUpSharePct : null, tooFew: !shown }
    })
    return { companyId: query.companyId, from, to, lines, months: months.sort((a, b) => a.month.localeCompare(b.month)), asOf: toUtcIso(serverClock.now()), words: lines.some((row) => row.tooFew) || months.some((row) => row.tooFew) ? [TOO_FEW_WORDS] : [] }
  })
}

/** Per worker: only with the right, written down. */
export async function earningsByWorker(caller: CommandCaller, body: EarningsReportQuery) {
  const context = officeOf(caller)
  requireRight(context, { companyId: body.companyId, siteId: body.siteId ?? null })
  const { from, to } = requireMonths(body)
  const { result } = await command(caller, { name: 'people.openEarningsByWorker', input: { ...body, at: serverClock.now().toISOString() } }, async (tools) => {
    const rows = reportRows((await rowsOf(tools.tx, { companyId: body.companyId, from, to, siteId: body.siteId })).map((row) => ({ ...row, group: row.employeeId })))
    const people = new Map((await tools.tx.employee.findMany({ where: { id: { in: rows.map((row) => row.key) } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })).map((row) => [row.id, row]))
    tools.audit({ action: 'people.openEarningsByWorker', recordType: 'Company', recordId: body.companyId, companyId: body.companyId, after: { from, to, siteId: body.siteId ?? null, people: rows.length } })
    return rows
      .map((row) => {
        const person = people.get(row.key)!
        return { employeeId: row.key, name: fullName(person), code: person.employeeCode, pieces: row.pieces, earnings: asMoney('pay', row.earnings), makeUp: asMoney('pay', row.makeUp), makeUpSharePct: row.makeUpSharePct }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  return { companyId: body.companyId, from, to, workers: result, words: ['Opening this list is recorded. It stays with HR: no export, no comparison.'] }
}
