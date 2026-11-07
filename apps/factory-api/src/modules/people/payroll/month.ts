import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { monthLabel } from '@nexus/factory-domain/accounting/periods'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PEOPLE_CHECKS, placeOfCheck, type PayrollCheckCode } from '@nexus/factory-domain/people/payroll/checks'
import { PAYROLL_TO_CONFIRM } from '@nexus/factory-domain/people/payroll/layouts'
import { PEOPLE_PAYROLL_MANAGE, PEOPLE_PAYROLL_RECORDS, PEOPLE_PAYROLL_VIEW } from '@nexus/factory-domain/people/payroll/permissions'
import { monthStateOf, monthStateWords } from '@nexus/factory-domain/people/payroll/rules'
import { changeCounts, codeSums, parseValues, valueChanges, type PayrollValue } from '@nexus/factory-domain/people/payroll/values'
import { command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { fullName, type Client } from '../attendance/store'
import { companyFor, gatesOf, previousMonth, type Place } from '../close/store'
import { officeOf } from '../employees/access'
import { seesPay } from '../piecerates/access'
import { gateClosedError } from '../privacy/gate'
import type { MonthQuery, PreviewBody, ShowBody } from './contract'
import { exportRows } from './views'
import { lineDaysOf, monthChecks, monthPeople, type MonthPeople } from './facts'
import { companyPayrollCode, exportsOfMonth, latestExported, layoutOf, mayDo, requireMonthGates } from './store'
import { correctionsNotCarried } from './pending'

/**
 * The month (B-W2b-54; MES-267, MES-272, MES-273; design people.payroll: the status pill, "1 · Period and company", "2 · Checks",
 * "4 · Preview").
 *
 *   GET  /people/payroll/month          the state, the close, the checks as counts, what the latest file differs in: no figure
 *   POST /people/payroll/month/show     "Show me" of a check that lists people: the right, recorded
 *   POST /people/payroll/preview        the values per employee code: the right, recorded; amounts only with the pay grain
 *
 * A month's figures are read behind the ATTENDANCE gate: with every gate off there is nothing to say (409 gate/ATTENDANCE).
 */

const held = (allowed: boolean, reason: string | null) => ({ allowed, reason: allowed ? null : reason })

const rightWords = 'The values per employee code need people.payroll.records over every site of the company.'

/** The caller holds the right over the whole company (else 403: they may read the month, not its figures). */
function requireRight(context: OfficeContext, place: Place): void {
  if (!mayDo(context, place, PEOPLE_PAYROLL_RECORDS)) throw new ForbiddenError(rightWords)
}

/** GET /people/payroll/month. */
export async function monthView(caller: CommandCaller, query: MonthQuery) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const place = await companyFor(db, context, query.companyId, [PEOPLE_PAYROLL_VIEW])
    const month = query.month ?? previousMonth(place, now)
    const gates = await gatesOf(db, place)
    if (gates.open.length === 0) throw gateClosedError('ATTENDANCE')
    const layout = query.layoutId ? await layoutOf(db, place.company.id, query.layoutId) : null
    const exports = await exportsOfMonth(db, place.company.id, month)
    const latest = latestExported(exports)
    const read = await monthChecks(db, place, month, { layout, lineDaysOpen: await lineDaysOf(db, place, month), now, revision: (latest?.revision ?? 0) + 1 })
    const changes = latest ? valueChanges(parseValues(latest.values), read.people.values) : []
    const counted = changeCounts(changes)
    const state = monthStateOf(latest, changes.length)
    const closed = read.close?.status === 'CLOSED'
    const mayManage = mayDo(context, place, PEOPLE_PAYROLL_MANAGE)
    const pay = !read.carriesPay || seesPay(context)
    const payWords = 'This file carries amounts: making it asks the pay grain.'
    const [row] = latest ? await exportRows(db, [latest]) : []
    return {
      companyId: place.company.id,
      company: { code: place.company.code, legalName: place.company.legalName, payrollCode: await companyPayrollCode(db, place.company.id) },
      month,
      label: monthLabel(month),
      sites: place.sites.map((site) => ({ siteId: site.id, code: site.code, name: site.name, gateOpen: read.gates.open.some((entry) => entry.id === site.id) })),
      state,
      words: monthStateWords(state, month, latest ? { revision: latest.revision, exportedOn: latest.exportedAt ? businessDate(latest.exportedAt) : null } : null, counted),
      close: { state: closed ? ('CLOSED' as const) : ('OPEN' as const), closeId: read.close?.id ?? null, words: closed ? `${monthLabel(month)} is closed.` : `${monthLabel(month)} is not closed: close it in Attendance.` },
      checks: [...read.checks],
      blocking: read.blocking.length,
      people: read.people.rows.length,
      piecePayOn: read.people.piecePayOn,
      payPeriodId: read.people.period?.id ?? null,
      latest: row ?? null,
      correction: latest ? { ...counted, corrections: await correctionsNotCarried(db, place, month, now) } : null,
      toConfirm: [...PAYROLL_TO_CONFIRM],
      carriesPay: read.carriesPay,
      actions: {
        export: held(mayManage && pay && !latest && read.blocking.length === 0, !mayManage ? 'Making a payroll export needs people.payroll.manage.' : latest ? 'This month is exported: make a correction.' : !pay ? payWords : `${read.blocking.length} blocking checks stand in the way.`),
        correct: held(mayManage && pay && latest !== null && changes.length > 0, !mayManage ? 'Making a correction needs people.payroll.manage.' : !latest ? 'This month has no export yet.' : !pay ? payWords : 'Nothing changed since the last file.'),
        preview: held(mayDo(context, place, PEOPLE_PAYROLL_RECORDS), rightWords),
      },
    }
  })
}

/** The people behind a check, with their names (one record's words: this list opens only with the right, recorded). */
async function peopleOf(db: Client, people: MonthPeople, code: PayrollCheckCode) {
  const ids = code === 'EMPLOYEE_CODES' ? people.noCode : code === 'AGENCY_LEFT_OUT' ? people.leftOut : code === 'LEAVERS' ? people.leavers : code === 'NOT_ON_FILE' ? people.notOnFile : []
  if (ids.length === 0) return []
  const rows = await db.employee.findMany({ where: { id: { in: [...ids] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }] })
  const lastDay = new Map(people.rows.map((row) => [row.employeeId, row.lastDay]))
  return rows.map((row) => ({ employeeId: row.id, name: fullName(row), employeeCode: row.employeeCode, lastDay: lastDay.get(row.id) ?? null }))
}

/** POST /people/payroll/month/show: what is behind one check. Each opening that names people is recorded. */
export async function showCheck(caller: CommandCaller, body: ShowBody, key?: string) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const { place, read } = await caller.withClient(async (db) => {
    const found = await companyFor(db, context, body.companyId, [PEOPLE_PAYROLL_VIEW])
    requireRight(context, found)
    await requireMonthGates(db, found, body.month)
    return { place: found, read: await monthPeople(db, found, body.month, now) }
  })
  const code = body.code
  const names = PEOPLE_CHECKS.includes(code)
  if (names) {
    await command(caller, { name: 'people.openPayrollCheck', idempotencyKey: key, input: body }, async (tools) => {
      tools.audit({ recordType: 'Company', recordId: place.company.id, companyId: place.company.id, after: { month: body.month, check: code } })
      return { code }
    })
  }
  const people = names ? await caller.withClient((db) => peopleOf(db, read, code)) : []
  const unmapped = code === 'CODES_MAPPED' ? [...new Map(read.values.filter((value) => value.providerCode === null).map((value) => [`${value.kind}|${value.code}`, { kind: value.kind, ourCode: value.code, meaning: value.meaning }])).values()] : []
  return { code, place: placeOfCheck(code), people, codes: unmapped }
}

const cellOf = (value: PayrollValue) => ({ kind: value.kind, code: value.code, providerCode: value.providerCode, meaning: value.meaning, unit: value.unit, quantity: value.quantity, minutes: value.minutes, amount: asMoney('pay', value.amount), currency: value.currency })

/** The values as the preview and an export's record show them, per employee code. */
export function valuesView(month: string, rows: readonly { readonly employeeId: string | null; readonly employeeCode: string | null; readonly lastDay: string | null; readonly values: readonly PayrollValue[] }[], values: readonly PayrollValue[], before: readonly PayrollValue[] | null, payShown: boolean) {
  const changes = before ? valueChanges(before, values) : null
  return {
    month,
    label: monthLabel(month),
    people: rows.map((row) => ({ employeeId: row.employeeId, employeeCode: row.employeeCode, lastDay: row.lastDay, cells: row.values.map(cellOf) })),
    sums: codeSums(values).map((sum) => ({ ...sum, amount: asMoney('pay', sum.amount) })),
    changes: changes ? { ...changeCounts(changes), rows: changes.map((change) => ({ ...change, fromAmount: asMoney('pay', change.fromAmount), toAmount: asMoney('pay', change.toAmount) })) } : null,
    payShown,
  }
}

/** POST /people/payroll/preview: the numbers that would be sent; against the month's latest file when it has one. */
export async function previewMonth(caller: CommandCaller, body: PreviewBody, key?: string) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const { place, read, latest } = await caller.withClient(async (db) => {
    const found = await companyFor(db, context, body.companyId, [PEOPLE_PAYROLL_VIEW])
    requireRight(context, found)
    await requireMonthGates(db, found, body.month)
    return { place: found, read: await monthPeople(db, found, body.month, now), latest: latestExported(await exportsOfMonth(db, found.company.id, body.month)) }
  })
  await command(caller, { name: 'people.openPayrollPreview', idempotencyKey: key, input: body }, async (tools) => {
    tools.audit({ recordType: 'Company', recordId: place.company.id, companyId: place.company.id, after: { month: body.month, people: read.rows.length } })
    return { month: body.month }
  })
  return valuesView(body.month, read.rows, read.values, latest ? parseValues(latest.values) : null, seesPay(context))
}
