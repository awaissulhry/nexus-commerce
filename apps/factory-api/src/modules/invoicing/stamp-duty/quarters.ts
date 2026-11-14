import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { amountText } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import {
  paymentDueOf,
  quarterEnded,
  quarterEndOf,
  quarterLabel,
  quarterNumberOf,
  quartersOf,
  quarterStartOf,
  quarterStateOf,
  STAMP_DUTY_CHARGED_TYPES,
} from '@nexus/factory-domain/invoicing/stamp-duty/stamp-duty'
import { INVOICES_TAX_MANAGE } from '@nexus/factory-domain/invoicing/tax-codes/permissions'
import { SWITCH_WORDS } from '@nexus/factory-domain/invoicing/tax-codes/switches'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { tenantOf } from '../../payments/locks'
import { officeContextOf, type Reader } from '../store'
import { assertCompany, dayOf, dayValue, lockSwitches, readSwitches, refused, refusingInWords } from '../tax-codes/store'

/**
 * The stamp duty of each quarter (B-W2b-392; FIN-101; DM 17.6.2014 art. 6; design finance.invoices "Stamp duty this
 * quarter"): the issued invoices of a calendar quarter that carry stamp duty (bollo virtuale: W1's rule decides it on
 * every invoice; REJECTED ones count as never issued) and their total, kept in StampDutyQuarter, recounted at every issue
 * (issue.ts, in its command) and on demand until paid; when it is due and its F24 tax code (UNVERIFIED); the payment
 * recorded after the quarter ended, then frozen. Writes only while the company's stamp duty switch is on (GATE-ACCOUNTANT);
 * the list reads what is kept and what the invoices say whatever the switch.
 */

const RULE_WORDS =
  'Stamp duty of 2.00 EUR on every invoice whose amounts without VAT exceed 77.47 EUR (DPR 642/1972 Tariffa art. 13); exports (N3.1), intra-EU supplies (N3.2) and reverse charges (N6.x) do not count (which Natura codes are exempt waits for the accountant). Paid per quarter by F24 (DM 17.6.2014 art. 6): Q1 by 31 May, Q2 by 30 September, Q3 by 30 November, Q4 by the end of February; below 5,000 EUR the first quarters go later (the due days wait for the accountant).'

const QUARTER_COLUMNS = { id: true, companyId: true, quarterStart: true, invoiceCount: true, total: true, paidAt: true, paidById: true, version: true } as const satisfies Prisma.StampDutyQuarterSelect
type QuarterRow = Prisma.StampDutyQuarterGetPayload<{ select: typeof QUARTER_COLUMNS }>

/** The issued invoices of a quarter that carry stamp duty: how many, and the total (minor units). */
async function liveCount(db: Reader, companyId: string, start: BusinessDate, except: string | null = null): Promise<{ count: number; total: number }> {
  const found = await db.invoice.aggregate({
    where: {
      companyId,
      status: { notIn: ['DRAFT', 'REJECTED'] },
      stampDutyAmount: { not: null },
      issueDate: { gte: dayValue(start), lte: dayValue(quarterEndOf(start)) },
      ...(except ? { id: { not: except } } : {}),
    },
    _count: { _all: true },
    _sum: { stampDutyAmount: true },
  })
  return { count: found._count._all, total: found._sum.stampDutyAmount ?? 0 }
}

function quarterView(companyId: string, start: BusinessDate, row: QuarterRow | null, live: { count: number; total: number }, firstHalf: { q1: number; q2: number }, today: BusinessDate) {
  const due = paymentDueOf(start, firstHalf)
  const state = quarterStateOf(start, row?.paidAt != null, due.dueOn, today)
  const kept = { count: row?.invoiceCount ?? 0, total: row?.total ?? 0 }
  const label = quarterLabel(start)
  const words =
    state === 'PAID'
      ? `${label}: ${amountText(kept.total, 'EUR')} for ${kept.count} invoice(s), paid on ${dayOf(row!.paidAt!)}.`
      : state === 'OPEN'
        ? `${label} is running: ${amountText(live.total, 'EUR')} for ${live.count} invoice(s) so far; due by ${due.dueOn} (F24 code ${due.f24Code}).`
        : `${label}: ${amountText(live.total, 'EUR')} for ${live.count} invoice(s) to pay by ${due.dueOn} (F24 code ${due.f24Code})${state === 'LATE' ? ': the day has passed' : ''}.`
  return {
    id: row?.id ?? null,
    version: row?.version ?? null,
    companyId,
    quarterStart: start,
    quarterEnd: quarterEndOf(start),
    label,
    invoiceCount: kept.count,
    total: asMoney('price', kept.total),
    liveCount: live.count,
    liveTotal: asMoney('price', live.total),
    stale: row?.paidAt == null && (kept.count !== live.count || kept.total !== live.total),
    dueOn: due.dueOn,
    f24Code: due.f24Code,
    deferred: due.deferred,
    state,
    paidAt: row?.paidAt ? toUtcIso(row.paidAt) : null,
    paidById: row?.paidById ?? null,
    words,
  }
}

/** One quarter's view (the year's first half read for its due day). */
async function viewOf(db: Reader, companyId: string, start: BusinessDate, today: BusinessDate) {
  const year = start.slice(0, 4)
  const rows = await db.stampDutyQuarter.findMany({ where: { companyId, quarterStart: { gte: dayValue(`${year}-01-01`), lte: dayValue(`${year}-12-31`) } }, select: QUARTER_COLUMNS })
  const totalOf = async (quarter: BusinessDate) => rows.find((row) => dayOf(row.quarterStart) === quarter && row.paidAt !== null)?.total ?? (await liveCount(db, companyId, quarter)).total
  const firstHalf = { q1: await totalOf(`${year}-01-01`), q2: await totalOf(`${year}-04-01`) }
  return quarterView(companyId, start, rows.find((row) => dayOf(row.quarterStart) === start) ?? null, await liveCount(db, companyId, start), firstHalf, today)
}

/** invoices.view over the company: its four quarters of a year (this year by default). */
export async function listQuarters(caller: CommandCaller, query: { companyId: string; year?: number | undefined }) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_VIEW, { companyId: query.companyId }, 'Company')
  const today = businessDate(serverClock.now())
  const year = query.year ?? Number.parseInt(today.slice(0, 4), 10)
  return caller.withClient(async (client) => {
    if (!(await client.company.findUnique({ where: { id: query.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const switches = await readSwitches(client, query.companyId)
    const quarters = []
    for (const start of quartersOf(year)) quarters.push(await viewOf(client, query.companyId, start, today))
    return { companyId: query.companyId, year, today, stampDutyOn: switches.stampDutyOn, waits: switches.stampDutyOn ? null : SWITCH_WORDS.stampDutyOn.off, rule: `${RULE_WORDS} Charged to the customer as a line on ${STAMP_DUTY_CHARGED_TYPES.join(', ')}.`, quarters }
  })
}

/** The quarter's lock (transaction-scoped): its counts are read and written by one command at a time. */
async function lockQuarter(tools: CommandTools, companyId: string, start: BusinessDate): Promise<void> {
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.tax.stampDutyQuarter'::text, ${tenantOf(tools.context)}::uuid, ${companyId}::uuid, ${start}::text), 0))`
}

/**
 * Inside a command: counts the quarter of `start` again (and `plus`: the invoice being issued in this command, not yet
 * ISSUED when this runs) and keeps it, under the quarter's lock. A paid quarter is never touched. Returns whether it
 * changed what is kept (then with an audit row and the event).
 */
export async function recountInCommand(tools: CommandTools, companyId: string, start: BusinessDate, plus: { readonly invoiceId: string; readonly amount: number } | null = null): Promise<boolean> {
  await lockQuarter(tools, companyId, start)
  const row = await tools.tx.stampDutyQuarter.findUnique({ where: { tenantId_companyId_quarterStart: { tenantId: tenantOf(tools.context), companyId, quarterStart: dayValue(start) } }, select: QUARTER_COLUMNS })
  if (row?.paidAt) return false
  const live = await liveCount(tools.tx, companyId, start, plus?.invoiceId ?? null)
  const count = live.count + (plus ? 1 : 0)
  const total = live.total + (plus?.amount ?? 0)
  if (row ? row.invoiceCount === count && row.total === total : count === 0) return false
  const id = row?.id ?? newId()
  if (row) await tools.tx.stampDutyQuarter.update({ where: { id: row.id }, data: { invoiceCount: count, total, version: { increment: 1 } }, select: { id: true } })
  else await tools.tx.stampDutyQuarter.create({ data: { id, companyId, quarterStart: dayValue(start), invoiceCount: count, total, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
  tools.audit({ action: 'invoices.recountStampDuty', recordType: 'StampDutyQuarter', recordId: id, companyId, before: { invoiceCount: row?.invoiceCount ?? 0, total: markMoney('price', row?.total ?? 0) }, after: { quarterStart: start, invoiceCount: count, total: markMoney('price', total), ...(plus ? { invoiceId: plus.invoiceId } : {}) } })
  tools.emit({ type: 'stamp_duty_quarter.changed', subject: id, companyId, payload: { quarterId: id, quarterStart: start, action: 'RECOUNTED', invoiceCount: count } })
  return true
}

/** invoices.tax.manage: counts a quarter again from its issued invoices (the stamp duty switch on). */
export async function recountQuarter(caller: CommandCaller, body: { companyId: string; quarterStart: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_TAX_MANAGE, { companyId: body.companyId }, 'Company')
  const start = quarterStartOf(body.quarterStart)
  if (start !== body.quarterStart) throw new ValidationError(`A quarter starts on 1 January, April, July or October: ${body.quarterStart} is in the quarter from ${start}.`, [{ path: 'body/quarterStart', message: `The quarter from ${start}.` }])
  return refusingInWords(async () => {
    const { result } = await command(caller, { name: 'invoices.recountStampDuty', idempotencyKey, input: body }, async (tools) => {
      if (!(await tools.tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
      const switches = await lockSwitches(tools.tx, body.companyId)
      if (!switches.stampDutyOn) throw refused('SWITCH_OFF', `${SWITCH_WORDS.stampDutyOn.off} Switch it on in the company's tax set-up when the accountant confirms.`)
      const kept = await tools.tx.stampDutyQuarter.findFirst({ where: { companyId: body.companyId, quarterStart: dayValue(start) }, select: { paidAt: true } })
      if (kept?.paidAt) throw refused('QUARTER_PAID', `${quarterLabel(start)} was paid on ${dayOf(kept.paidAt)}: it is counted no more.`)
      // A command records at least one audit row: a count that was already right says so.
      if (!(await recountInCommand(tools, body.companyId, start))) tools.audit({ action: 'invoices.recountStampDuty', recordType: 'Company', recordId: body.companyId, companyId: body.companyId, after: { stampDutyQuarter: start, unchanged: true } })
      return { quarter: await viewOf(tools.tx, body.companyId, start, businessDate(tools.now)) }
    })
    return result
  })
}

/**
 * invoices.tax.manage: records that a quarter's stamp duty was paid (after the quarter ended; `paidOn` not in the future),
 * counted once more first; then the quarter is frozen.
 */
export async function payQuarter(caller: CommandCaller, quarterId: string, body: { version: number; paidOn?: string | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const row = isUuid(quarterId) ? await caller.withClient((client) => client.stampDutyQuarter.findUnique({ where: { id: quarterId }, select: QUARTER_COLUMNS })) : null
  assertCompany(context, INVOICES_VIEW, INVOICES_TAX_MANAGE, row ? { companyId: row.companyId } : null, 'Stamp duty quarter')
  return refusingInWords(async () => {
    const { result } = await command(caller, { name: 'invoices.payStampDuty', idempotencyKey, input: { quarterId, ...body }, record: { type: 'StampDutyQuarter', id: row!.id, expectedVersion: body.version } }, async (tools) => {
      const today = businessDate(tools.now)
      const start = dayOf(row!.quarterStart)
      const switches = await lockSwitches(tools.tx, row!.companyId)
      if (!switches.stampDutyOn) throw refused('SWITCH_OFF', `${SWITCH_WORDS.stampDutyOn.off} Switch it on in the company's tax set-up when the accountant confirms.`)
      const current = (await tools.tx.stampDutyQuarter.findUnique({ where: { id: row!.id }, select: QUARTER_COLUMNS }))!
      if (current.paidAt) throw refused('QUARTER_PAID', `${quarterLabel(start)} was paid on ${dayOf(current.paidAt)}.`)
      const paidOn = body.paidOn ?? today
      if (!quarterEnded(start, paidOn) || paidOn > today) throw refused('QUARTER_OPEN', `${quarterLabel(start)} ends on ${quarterEndOf(start)}: it is paid after it ended, on a day not in the future.`)
      const live = await liveCount(tools.tx, row!.companyId, start)
      const paidAt = paidOn === today ? tools.now : businessDayStart(paidOn)
      await tools.tx.stampDutyQuarter.update({ where: { id: current.id }, data: { invoiceCount: live.count, total: live.total, paidAt, paidById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
      tools.audit({ recordType: 'StampDutyQuarter', recordId: current.id, companyId: current.companyId, before: { invoiceCount: current.invoiceCount, total: markMoney('price', current.total), paidAt: null }, after: { invoiceCount: live.count, total: markMoney('price', live.total), paidOn, quarter: quarterNumberOf(start) } })
      tools.emit({ type: 'stamp_duty_quarter.changed', subject: current.id, companyId: current.companyId, payload: { quarterId: current.id, quarterStart: start, action: 'PAID', invoiceCount: live.count } })
      return { quarter: await viewOf(tools.tx, current.companyId, start, today) }
    })
    return result
  })
}
