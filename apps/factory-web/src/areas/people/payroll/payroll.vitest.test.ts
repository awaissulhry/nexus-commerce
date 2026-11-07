import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { PAYROLL_CHECKS, PEOPLE_CHECKS } from '@nexus/factory-domain/people/payroll/checks'
import { CHECK_PLACES } from '@nexus/factory-domain/people/payroll/checks'
import { PAYROLL_CODE_KINDS } from '@nexus/factory-domain/people/payroll/codes'
import { COLUMN_KEYS, definitionProblems, LAYOUT_STARTERS, PAYROLL_FORMATS, PAYROLL_TO_CONFIRM } from '@nexus/factory-domain/people/payroll/layouts'
import { PAYROLL_EXPORT_STATUSES, PAYROLL_REFUSALS } from '@nexus/factory-domain/people/payroll/rules'
import { LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { archiveLayout, cancelExport, createExport, createLayout, exportValues, getMonth, listExports, openFile, patchLayout, previewMonth, putCode, sendExport, showCheck, withdrawLink } from './api'
import { CODES, EXPORTS, LAYOUT_CONFIRMED, LAYOUT_CSV, LAYOUT_EXCEL, LAYOUT_ZUCCHETTI, MONTH, MONTH_EXPORTED, MONTH_HELD, MONTH_OPEN, MONTH_PENDING, RECORD, VALUES, VALUES_CORRECTION, VALUES_NO_PAY } from './demo/fixtures'
import { designScreen as fileScreen } from './file/fixtures'
import { designScreen as payrollScreen } from './fixtures'
import {
  activeLayouts,
  changeSides,
  checkState,
  checkWords,
  chosenLayout,
  columnsBody,
  columnsDraftOf,
  columnsHeld,
  confirmHeld,
  continueHeld,
  correctHeld,
  csvRow,
  fileHeld,
  fileHref,
  fileKindOf,
  fileOf,
  formatChoices,
  formatWords,
  isGateClosed,
  isLatest,
  layoutUnconfirmed,
  makeHeld,
  mappingChange,
  meaningOf,
  monthBefore,
  monthChoices,
  monthName,
  monthPill,
  monthWords,
  newColumn,
  nextRevision,
  orderedChecks,
  payrollAddressOf,
  payrollCan,
  payrollHref,
  payrollProblem,
  placeOf,
  previewColumns,
  previewRows,
  primaryOf,
  quantityText,
  recordHref,
  refusalCodeOf,
  refusedChecks,
  rowCorrectHeld,
  sealShort,
  sendBody,
  sendDraftOf,
  sendHeld,
  sendRowHeld,
  showKindOf,
  stepOpen,
  STEPS,
  toConfirmKeys,
  valueText,
  withKey,
  wizardHref,
  type PayrollCan,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * People › Payroll export (SCR-159; B-W2b-63 on the API of B-W2b-54): the rights, the address, the months, what holds each step,
 * a check in words and where its Show me goes, the layout in use and the warning of one nobody confirmed, the CSV columns draft
 * against the API's own rule, the preview by employee code (never a name, amounts only with the pay grain, from → to), Send, a
 * refusal in words, the calls as the API takes them (a key on every write, the figures only from the recorded POSTs), and every
 * design case in Italian and English with no key on screen. Nexus does not run payroll: it makes a file for the consultant.
 */

const template = (key: string) => [...(templateOf(key)?.permissions ?? [])]
const HR: PayrollCan = { view: true, records: true, manage: true, pay: true, people: true }
const facts = (month: typeof MONTH | null, can: PayrollCan = HR) => ({ month, can })

function mockApi(answers: ReadonlyArray<{ status: number; body: unknown }>): { api: ApiClient; calls: { method: string; url: string; body: unknown; headers: Headers }[] } {
  const calls: { method: string; url: string; body: unknown; headers: Headers }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers) })
    const answer = answers[calls.length - 1]!
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('payroll: who may do what', () => {
  it('the admin template holds the three rights but not the pay grain; read-only sees states and counts; sales nothing', () => {
    expect(payrollCan(template('admin'))).toMatchObject({ view: true, records: true, manage: true, pay: false })
    expect(payrollCan(template('read_only'))).toMatchObject({ view: true, records: false, manage: false, pay: false })
    expect(payrollCan(template('sales'))).toMatchObject({ view: false, records: false, manage: false })
    expect(payrollCan(['money.pay']).pay).toBe(true)
  })

  it('an export opens as Past export; the page, its record and its tab are built', () => {
    expect(recordAddress({ type: 'PayrollExport', id: 'x1' }, OFFICE_PAGES)).toBe('/people/payroll/x1')
    for (const page of ['/people/payroll', '/people/payroll/[id]', '/people/payroll/[id]/file']) expect(OFFICE_PAGES.has(page), page).toBe(true)
  })
})

describe('payroll: the address', () => {
  it('reads the wizard and the list, refuses what is not a month or a step', () => {
    expect(payrollAddressOf(new URLSearchParams())).toEqual({ wizard: false, step: 'period', month: null, layoutId: null, year: null })
    expect(payrollAddressOf(new URLSearchParams('new=1')).wizard).toBe(true)
    expect(payrollAddressOf(new URLSearchParams('month=2026-10&step=checks&layout=l1'))).toEqual({ wizard: true, step: 'checks', month: '2026-10', layoutId: 'l1', year: null })
    expect(payrollAddressOf(new URLSearchParams('month=2026-13&step=nope&year=3000'))).toEqual({ wizard: false, step: 'period', month: null, layoutId: null, year: null })
    expect(payrollAddressOf(new URLSearchParams('year=2025')).year).toBe(2025)
  })

  it('writes short addresses, a file by kind', () => {
    expect(wizardHref('/w/D', '2026-10')).toBe('/w/D/people/payroll?month=2026-10')
    expect(wizardHref('/w/D', null)).toBe('/w/D/people/payroll?new=1')
    expect(wizardHref('/w/D', '2026-10', 'send', 'l1')).toBe('/w/D/people/payroll?month=2026-10&step=send&layout=l1')
    expect(payrollHref('/w/D', 2025)).toBe('/w/D/people/payroll?year=2025')
    expect(recordHref('/w/D', 'e 1')).toBe('/w/D/people/payroll/e%201')
    expect(fileHref('/w/D', 'e1', 'data')).toBe('/w/D/people/payroll/e1/file?kind=data')
    expect(fileKindOf(new URLSearchParams('kind=data'))).toBe('data')
    expect(fileKindOf(new URLSearchParams('kind=other'))).toBe('summary')
  })
})

describe('payroll: months and the band', () => {
  it('offers this month and the twelve before, keeps an older month in the address', () => {
    expect(monthBefore('2026-01')).toBe('2025-12')
    const months = monthChoices('2026-11-02', null)
    expect(months).toHaveLength(13)
    expect(months[0]).toBe('2026-11')
    expect(months.at(-1)).toBe('2025-11')
    expect(monthChoices('2026-11-02', '2024-05').at(-1)).toBe('2024-05')
  })

  it('says a month in the language of the page', () => {
    expect(monthWords('2026-10', 'it')).toBe('ottobre 2026')
    expect(monthWords('2026-10', 'en')).toBe('October 2026')
    expect(monthName('2026-10', 'en')).toBe('October')
  })

  it("the pill and the band's main action follow the month's state", () => {
    expect(monthPill(MONTH)).toEqual({ tone: 'neutral', words: 'pill.NOT_EXPORTED' })
    expect(monthPill(MONTH_EXPORTED).tone).toBe('success')
    expect(monthPill(MONTH_PENDING)).toEqual({ tone: 'warning', words: 'pill.CORRECTION_PENDING' })
    expect([primaryOf(null), primaryOf(MONTH), primaryOf(MONTH_EXPORTED), primaryOf(MONTH_PENDING)]).toEqual(['start', 'start', 'open', 'correct'])
  })
})

describe('payroll: checks', () => {
  it('a check says itself: a blocking one fails, a warning warns, what passes passes', () => {
    expect(checkState({ passed: true, blocking: true })).toBe('pass')
    expect(checkState({ passed: false, blocking: true })).toBe('fail')
    expect(checkState({ passed: false, blocking: false })).toBe('warning')
    expect(checkWords({ code: 'CODES_MAPPED', passed: false, blocking: false, count: 2 }, '2026-10', 'en').detail.key).toBe('check.CODES_MAPPED.warn')
    expect(checkWords({ code: 'CODES_MAPPED', passed: false, blocking: true, count: 2 }, '2026-10', 'en').detail).toEqual({ key: 'check.CODES_MAPPED.left', params: { count: 2, month: 'October 2026' } })
    expect(checkWords({ code: 'MONTH_CLOSED', passed: true, blocking: true, count: 0 }, '2026-10', 'it').detail.key).toBe('check.MONTH_CLOSED.done')
  })

  it('blocking checks first, then the warnings', () => {
    const order = orderedChecks([...MONTH.checks].reverse()).map((check) => check.blocking)
    expect(order.lastIndexOf(true)).toBeLessThan(order.indexOf(false))
  })

  it('Show me: people and codes open a recorded list, the others go to the page that fixes it', () => {
    for (const code of PEOPLE_CHECKS) expect(showKindOf(code)).toBe('people')
    expect(showKindOf('CODES_MAPPED')).toBe('codes')
    expect(showKindOf('DAYS_APPROVED')).toBe('place')
  })

  it('a fix goes to a built page in a new tab or to a step; a page not built yet is said, never a dead link', () => {
    const pages = new Set(['/people/employees'])
    expect(placeOf('EMPLOYEES', '/w/D', '2026-10', pages)).toEqual({ kind: 'page', href: '/w/D/people/employees?rows=MISSING_DATA', words: 'place.EMPLOYEES' })
    expect(placeOf('ATTENDANCE', '/w/D', '2026-10', pages)).toEqual({ kind: 'notBuilt', words: 'place.ATTENDANCE' })
    expect(placeOf('ATTENDANCE', '/w/D', '2026-10', new Set(['/people/attendance']))).toMatchObject({ href: '/w/D/people/attendance?month=2026-10' })
    expect(placeOf('CODE_MAPPING', '/w/D', '2026-10', pages)).toMatchObject({ kind: 'step', step: 'mapping' })
    expect(placeOf('LAYOUTS', '/w/D', '2026-10', pages)).toMatchObject({ kind: 'step', step: 'send' })
  })
})

describe('payroll: the steps', () => {
  it('Continue on step 1 is held by the month close, in words', () => {
    expect(continueHeld('period', facts(MONTH))).toBeNull()
    expect(continueHeld('period', facts(MONTH_OPEN))).toEqual({ key: 'held.notClosed', params: { month: '2026-10' } })
    expect(continueHeld('period', facts(null))).toEqual({ key: 'held.notRead' })
  })

  it('Continue on Checks and Mapping is held with the count of blocking checks; a preview holds nothing', () => {
    expect(continueHeld('checks', facts(MONTH_HELD))).toEqual({ key: 'held.blocking', params: { count: 4 } })
    expect(continueHeld('mapping', facts(MONTH_HELD))).toEqual({ key: 'held.blocking', params: { count: 4 } })
    expect(continueHeld('checks', facts(MONTH))).toBeNull()
    expect(continueHeld('preview', facts(MONTH))).toBeNull()
  })

  it('the stepper opens done steps, the mapping at any time, Preview and Send only with nothing blocking', () => {
    expect(stepOpen('period', 'send', facts(MONTH_HELD))).toBe(true)
    expect(stepOpen('mapping', 'period', facts(MONTH_HELD))).toBe(true)
    expect(stepOpen('preview', 'checks', facts(MONTH_HELD))).toBe(false)
    expect(stepOpen('send', 'checks', facts(MONTH))).toBe(true)
    expect(stepOpen('checks', 'period', facts(MONTH_OPEN))).toBe(false)
    expect(stepOpen('mapping', 'period', facts(null))).toBe(false)
  })

  it('Make the file is held with why: the right, the month, the checks, the format, the pay grain', () => {
    const make = (month: typeof MONTH, can: PayrollCan = HR, layout: typeof LAYOUT_CSV | null = LAYOUT_CSV, busy = false) => makeHeld({ month, can, layout, busy })
    expect(make(MONTH)).toBeNull()
    expect(make(MONTH, { ...HR, manage: false })).toEqual({ key: 'held.noManage' })
    expect(make(MONTH_OPEN)?.key).toBe('held.notClosed')
    expect(make(MONTH_HELD)).toEqual({ key: 'held.blocking', params: { count: 4 } })
    expect(make(MONTH, HR, null)).toEqual({ key: 'held.noLayout' })
    expect(make(MONTH, { ...HR, pay: false })).toEqual({ key: 'held.noPay' })
    expect(make({ ...MONTH, carriesPay: false }, { ...HR, pay: false })).toBeNull()
    expect(make(MONTH, HR, LAYOUT_CSV, true)).toEqual({ key: 'held.busy' })
    expect(make(MONTH_EXPORTED)).toEqual({ key: 'held.nothingChanged', params: { version: 2 } })
    expect(make({ ...MONTH, actions: { ...MONTH.actions, export: { allowed: false } } })).toEqual({ key: 'held.noReach' })
  })

  it('an unconfirmed provider layout warns: it never holds the file', () => {
    expect(makeHeld({ month: MONTH, can: HR, layout: LAYOUT_ZUCCHETTI, busy: false })).toBeNull()
    expect(layoutUnconfirmed(LAYOUT_ZUCCHETTI)).toBe(true)
    expect(layoutUnconfirmed(LAYOUT_CONFIRMED)).toBe(false)
    expect(layoutUnconfirmed(LAYOUT_CSV)).toBe(false)
    expect(layoutUnconfirmed(null)).toBe(false)
  })

  it('a correction needs something changed, the right and the grain', () => {
    expect(correctHeld({ month: MONTH_PENDING, can: HR, busy: false })).toBeNull()
    expect(correctHeld({ month: MONTH_EXPORTED, can: HR, busy: false })).toEqual({ key: 'held.nothingChanged', params: { version: 2 } })
    expect(correctHeld({ month: MONTH, can: HR, busy: false })).toEqual({ key: 'held.noExportYet' })
    expect(correctHeld({ month: MONTH_PENDING, can: { ...HR, pay: false }, busy: false })).toEqual({ key: 'held.noPay' })
    expect(correctHeld({ month: null, can: HR, busy: false })).toEqual({ key: 'held.notRead' })
  })

  it('the next file is v1, then the version after the latest', () => {
    expect(nextRevision(MONTH)).toBe(1)
    expect(nextRevision(MONTH_PENDING)).toBe(3)
    expect(nextRevision(null)).toBe(1)
  })

  it('names five steps, in order', () => {
    expect(STEPS).toEqual(['period', 'checks', 'mapping', 'preview', 'send'])
  })
})

describe('payroll: layouts', () => {
  const layouts = [LAYOUT_ZUCCHETTI, LAYOUT_CSV, LAYOUT_EXCEL, { ...LAYOUT_EXCEL, id: 'gone', status: 'ARCHIVED' as const }]

  it('the layout in use: the address, the last file, the first generic one; an archived one never', () => {
    expect(chosenLayout(layouts, LAYOUT_EXCEL.id, LAYOUT_CSV.id)?.id).toBe(LAYOUT_EXCEL.id)
    expect(chosenLayout(layouts, null, LAYOUT_ZUCCHETTI.id)?.id).toBe(LAYOUT_ZUCCHETTI.id)
    expect(chosenLayout(layouts, null, null)?.id).toBe(LAYOUT_CSV.id)
    expect(chosenLayout(layouts, 'gone', null)?.id).toBe(LAYOUT_CSV.id)
    expect(chosenLayout([LAYOUT_ZUCCHETTI], null, null)?.id).toBe(LAYOUT_ZUCCHETTI.id)
    expect(chosenLayout([], null, null)).toBeNull()
    expect(activeLayouts(layouts)).toHaveLength(3)
  })

  it("says every question the labour consultant must confirm, by position", () => {
    expect(toConfirmKeys()).toHaveLength(PAYROLL_TO_CONFIRM.length)
  })

  it("the consultant's confirmation needs who and when", () => {
    expect(confirmHeld({ by: ' ', on: '2026-10-01' }, HR, false)).toEqual({ key: 'confirm.held.by' })
    expect(confirmHeld({ by: 'Studio Demo', on: '' }, HR, false)).toEqual({ key: 'confirm.held.on' })
    expect(confirmHeld({ by: 'Studio Demo', on: '2026-10-01' }, HR, false)).toBeNull()
    expect(confirmHeld({ by: 'Studio Demo', on: '2026-10-01' }, { ...HR, manage: false }, false)).toEqual({ key: 'held.noManage' })
  })
})

describe('payroll: CSV columns', () => {
  it('a starter comes back as itself: its draft is a definition the API accepts', () => {
    for (const layout of [LAYOUT_CSV, LAYOUT_EXCEL, LAYOUT_ZUCCHETTI]) {
      const body = columnsBody(columnsDraftOf(layout))
      expect(body.columns.map((column) => column.key), layout.name).toEqual(layout.definition.columns.map((column) => column.key))
      expect(definitionProblems(layout.format, body), layout.name).toEqual([])
    }
  })

  it('a fixed-width layout keeps its widths and has no header row', () => {
    const body = columnsBody(columnsDraftOf(LAYOUT_ZUCCHETTI))
    expect(body.columns[0]).toMatchObject({ key: 'companyCode', width: 6 })
    expect(body.headerRow).toBe(false)
    expect(body).not.toHaveProperty('delimiter')
  })

  it('Save layout is held with the first problem, by the rules of the API, naming the column', () => {
    const draft = columnsDraftOf(LAYOUT_ZUCCHETTI)
    expect(columnsHeld(draft, HR, false)).toBeNull()
    expect(columnsHeld({ ...draft, columns: draft.columns.map((column, index) => (index === 1 ? { ...column, width: '' } : column)) }, HR, false)).toEqual({ key: 'columns.held.width', params: { number: 2 } })
    expect(columnsHeld({ ...draft, columns: [] }, HR, false)).toEqual({ key: 'columns.held.none' })
    expect(columnsHeld({ ...draft, name: ' ' }, HR, false)).toEqual({ key: 'columns.held.name' })
    const csv = columnsDraftOf(LAYOUT_CSV)
    expect(columnsHeld({ ...csv, columns: [...csv.columns, newColumn(csv.columns, 'constant')] }, HR, false)).toEqual({ key: 'columns.held.value', params: { number: 5 } })
    expect(columnsHeld(csv, { ...HR, manage: false }, false)).toEqual({ key: 'held.noManage' })
  })

  it('a new row never takes an id the list holds; a format follows its column', () => {
    const csv = columnsDraftOf(LAYOUT_CSV)
    const shorter = csv.columns.slice(1)
    const added = newColumn(shorter, 'amount')
    expect(shorter.map((column) => column.id)).not.toContain(added.id)
    expect(formatChoices('amount')).toContain('implied:2')
    expect(formatChoices('periodEnd')).toContain('date:YYYYMMDD')
    expect(formatChoices('employeeCode')).toEqual([''])
    expect(withKey({ ...added, key: 'amount', format: 'implied:2' }, 'employeeCode').format).toBe('')
    expect(withKey({ ...added, key: 'amount', format: 'implied:2' }, 'quantity').format).toBe('implied:2')
    expect(formatWords('date:MMYYYY')).toBe('MMYYYY')
    expect(formatWords('number:2')).toEqual({ key: 'columns.number', params: { count: 2 } })
  })
})

describe('payroll: the preview, by employee code', () => {
  it('one column per code in the file order: hours, absences, earnings', () => {
    expect(previewColumns(VALUES, 'en').map((column) => column.code)).toEqual(['ORD', 'OT_DAY', 'NIGHT', 'FERIE', 'PIECE', 'MAKE_UP'])
    expect(previewColumns(VALUES, 'it')[0]!.meaning).toBe('Ore ordinarie')
    expect(meaningOf('ABSENCE', 'FERIE', 'Holiday (ferie)', 'it')).toBe('Holiday (ferie)')
  })

  it('without the pay grain no earning column is drawn, and no amount exists to draw', () => {
    expect(previewColumns(VALUES_NO_PAY, 'en').some((column) => column.money)).toBe(false)
    expect(VALUES_NO_PAY.people.flatMap((person) => person.cells).every((cell) => cell.amount === undefined)).toBe(true)
  })

  it('a row is an employee code; it holds no name', () => {
    const rows = previewRows(VALUES, false)
    expect(rows.map((row) => row.employeeCode)).toEqual(['D-0001', 'D-0002', 'D-0003'])
    expect(rows[2]!.lastDay).toBe('2026-10-30')
    expect(JSON.stringify(rows)).not.toMatch(/name/i)
  })

  it('a correction marks what changed; the filter keeps those rows', () => {
    const rows = previewRows(VALUES_CORRECTION, true)
    expect(rows.map((row) => [row.employeeCode, row.changed])).toEqual([['D-0001', 1], ['D-0002', 2]])
    expect(changeSides(rows[1]!.changes['ABSENCE|FERIE']!, 'en')).toEqual({ from: null, to: '16.00' })
    expect(changeSides(rows[1]!.changes['EARNING|MAKE_UP']!, 'en')).toEqual({ from: '€10.00', to: '€12.50' })
  })

  it('a person a correction took off the file keeps a row, so the loss shows', () => {
    const gone = { ...VALUES_CORRECTION, changes: { people: 1, values: 1, rows: [{ ...VALUES_CORRECTION.changes!.rows[0]!, employeeCode: 'D-0099', change: 'REMOVED' as const, toQuantity: null }] } }
    const rows = previewRows(gone, true)
    expect(rows.map((row) => row.employeeCode)).toEqual(['D-0099'])
    expect(changeSides(rows[0]!.changes['HOUR|ORD']!, 'it')).toEqual({ from: '160,00', to: null })
  })

  it('a value says the amount where the grain gave it, else the quantity, else nothing', () => {
    expect(valueText({ quantity: '168.50', currency: null }, 'it')).toBe('168,50')
    expect(valueText({ quantity: null, amount: 41250, currency: 'EUR' }, 'en')).toBe('€412.50')
    expect(valueText({ quantity: null, currency: 'EUR' }, 'en')).toBeNull()
    expect(valueText(undefined, 'en')).toBeNull()
    expect(quantityText('6.5', 'en')).toBe('6.50')
  })

  it('a mapping row sends only a change; empty clears the code', () => {
    const row = CODES.find((entry) => entry.ourCode === 'ORD')!
    expect(mappingChange(row, row.providerCode!)).toBeUndefined()
    expect(mappingChange(row, ` V900 `)).toBe('V900')
    expect(mappingChange(row, '  ')).toBeNull()
    expect(mappingChange({ ...row, providerCode: null }, '')).toBeUndefined()
  })
})

describe('payroll: a file', () => {
  it('finds its two files; opening is held with why', () => {
    expect(fileOf(RECORD, 'data')?.kind).toBe('DATA')
    expect(fileOf(RECORD, 'summary')?.kind).toBe('SUMMARY')
    expect(fileHeld(RECORD, HR)).toBeNull()
    expect(fileHeld(RECORD, { ...HR, records: false })).toEqual({ key: 'held.noRecords' })
    expect(fileHeld(RECORD, { ...HR, pay: false })).toEqual({ key: 'held.noPay' })
    expect(fileHeld({ ...RECORD, carriesPay: false }, { ...HR, pay: false })).toBeNull()
    expect(fileHeld({ ...RECORD, status: 'DRAFT' }, HR)).toEqual({ key: 'held.notExported' })
    expect(fileHeld({ ...RECORD, actions: { ...RECORD.actions, open: { allowed: false } } }, HR)).toEqual({ key: 'held.noReach' })
  })

  it('only the latest exported file is corrected and sent', () => {
    const replaced = EXPORTS[1]!
    expect(isLatest(EXPORTS[0]!)).toBe(true)
    expect(isLatest(replaced)).toBe(false)
    expect(rowCorrectHeld(replaced, HR)).toEqual({ key: 'held.replaced' })
    expect(sendRowHeld(replaced, HR)).toEqual({ key: 'held.replaced' })
    expect(sendRowHeld(EXPORTS[3]!, HR)).toEqual({ key: 'held.notExported' })
    expect(sendRowHeld(EXPORTS[0]!, { ...HR, manage: false })).toEqual({ key: 'held.noManage' })
    // B-W2b-163's rule on the record: a file with amounts never goes by link; one of hours may.
    expect(sendRowHeld({ ...EXPORTS[0]!, carriesPay: true }, HR)).toEqual({ key: 'held.payByLink' })
    expect(sendRowHeld({ ...EXPORTS[0]!, carriesPay: false }, HR)).toBeNull()
  })

  it('a selected rows CSV carries no person and no figure', () => {
    const line = csvRow(EXPORTS[0]!, { status: 'Esportato', format: 'CSV', month: 'settembre 2026' }, (at) => at ?? '')
    expect(line).toHaveLength(11)
    expect(line[3]).toBe('v2')
    expect(sealShort('a'.repeat(64))).toBe('aaaaaaaa…aaaa')
  })

  it('Send is held with why, within the link terms; it sends only what the API takes', () => {
    const draft = sendDraftOf('en', 'studio@example.com')
    expect(sendHeld(draft, HR, false)).toBeNull()
    expect(sendHeld({ ...draft, email: 'nope' }, HR, false)).toEqual({ key: 'send.held.email' })
    expect(sendHeld({ ...draft, days: '31' }, HR, false)).toEqual({ key: 'send.held.days', params: { max: 30 } })
    expect(sendHeld({ ...draft, uses: '0' }, HR, false)).toEqual({ key: 'send.held.uses', params: { max: 20 } })
    expect(sendHeld(draft, { ...HR, manage: false }, false)).toEqual({ key: 'held.noManage' })
    expect(sendBody({ ...draft, email: ' a@b.it ', message: '  ' })).toEqual({ email: 'a@b.it', expiresInDays: 7, maxUses: 10, language: 'en' })
    expect(sendBody({ ...draft, message: ' Ciao ' }).message).toBe('Ciao')
  })
})

describe('payroll: a refusal in words', () => {
  const refused = (path: string, ...more: string[]) => new ApiError('conflict', 409, 'invalid_state', 'English', null, [{ path }, ...more.map((entry) => ({ path: entry }))])

  it('names the refusal by its code; CHECKS_OPEN counts the checks', () => {
    expect(payrollProblem(refused('refusal/ALREADY_EXPORTED'))).toEqual({ key: 'refusal.ALREADY_EXPORTED' })
    expect(payrollProblem(refused('refusal/PAY_FIGURES'))).toEqual({ key: 'refusal.PAY_FIGURES' })
    expect(refusalCodeOf(refused('refusal/NOPE'))).toBeNull()
    const open = refused('refusal/CHECKS_OPEN', 'check/EMPLOYEE_CODES', 'check/DAYS_APPROVED')
    expect(refusedChecks(open)).toEqual(['EMPLOYEE_CODES', 'DAYS_APPROVED'])
    expect(payrollProblem(open)).toEqual({ key: 'refusal.CHECKS_OPEN', params: { count: 2 } })
  })

  it('the legal gate has its own words, never a failed read', () => {
    const closed = refused('gate/ATTENDANCE')
    expect(isGateClosed(closed)).toBe(true)
    expect(payrollProblem(closed)).toEqual({ key: 'problem.gate' })
  })

  it('the kinds of failure, and an address the API refused', () => {
    expect(payrollProblem(new ApiError('conflict', 409, 'stale', 'x')).key).toBe('problem.conflict')
    expect(payrollProblem(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('problem.forbidden')
    expect(payrollProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/email' }])).key).toBe('problem.email')
    expect(payrollProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/definition/columns/1/width' }])).key).toBe('problem.definition')
    expect(payrollProblem(new TypeError('x')).key).toBe('problem.unavailable')
  })
})

describe('payroll: the calls, as the API takes them', () => {
  it('the month is read for the layout in use, and its English words are not kept', async () => {
    const { api, calls } = mockApi([{ status: 200, body: { ...MONTH, words: 'English', label: 'x', toConfirm: ['English'] } }])
    const month = await getMonth(api, { companyId: 'c1', month: '2026-10', layoutId: 'l1' })
    expect(calls[0]!.url).toBe('/api/people/payroll/month?companyId=c1&month=2026-10&layoutId=l1')
    expect(month).not.toHaveProperty('words')
    expect(month).not.toHaveProperty('toConfirm')
  })

  it('a list asks by year and cursor; an amount the API left out is not an error', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { rows: EXPORTS, nextCursor: null } },
      { status: 200, body: VALUES_NO_PAY },
    ])
    await listExports(api, { companyId: 'c1', year: 2026, cursor: 'x' })
    expect(calls[0]!.url).toBe('/api/people/payroll/exports?companyId=c1&year=2026&cursor=x')
    const values = await previewMonth(api, { companyId: 'c1', month: '2026-10' })
    expect(values.payShown).toBe(false)
    expect(values.people[0]!.cells[0]).not.toHaveProperty('amount')
  })

  it('every write carries an Idempotency-Key, the version read, and the CSRF token', async () => {
    const download = { fileId: 'f1', fileName: 'x.csv', sha256: 'a', download: { method: 'GET', url: '/local-files?token=t', headers: {}, expiresAt: '2026-11-02T09:00:00.000Z' } }
    const { api, calls } = mockApi([
      { status: 200, body: { code: 'EMPLOYEE_CODES', place: 'EMPLOYEES', people: [], codes: [] } },
      { status: 200, body: VALUES },
      { status: 200, body: VALUES },
      { status: 200, body: CODES[2]! },
      { status: 201, body: LAYOUT_CSV },
      { status: 200, body: LAYOUT_CSV },
      { status: 200, body: LAYOUT_CSV },
      { status: 201, body: RECORD },
      { status: 200, body: RECORD },
      { status: 200, body: download },
      { status: 201, body: { link: { id: 'l1', email: 'a@b.it', expiresAt: '2026-11-09T09:00:00.000Z', maxUses: 10 }, withdrawn: [], delivery: 'SENT' } },
      { status: 200, body: { id: 'l1', state: 'REVOKED', revokedAt: '2026-11-02T09:00:00.000Z' } },
    ])
    await showCheck(api, { companyId: 'c1', month: '2026-10', code: 'EMPLOYEE_CODES' })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/people/payroll/month/show', body: { companyId: 'c1', month: '2026-10', code: 'EMPLOYEE_CODES' } })
    await previewMonth(api, { companyId: 'c1', month: '2026-10' })
    await exportValues(api, 'e1')
    expect(calls[2]).toMatchObject({ method: 'POST', url: '/api/people/payroll/exports/e1/values' })
    await putCode(api, { companyId: 'c1', kind: 'HOUR', ourCode: 'ORD', providerCode: 'V1', version: 3 })
    expect(calls[3]).toMatchObject({ method: 'PUT', url: '/api/people/payroll/codes', body: { kind: 'HOUR', ourCode: 'ORD', providerCode: 'V1', version: 3 } })
    await createLayout(api, { companyId: 'c1', starter: 'ZUCCHETTI' })
    await patchLayout(api, 'l1', { version: 2, confirmation: null })
    expect(calls[5]).toMatchObject({ method: 'PATCH', url: '/api/people/payroll/layouts/l1', body: { version: 2, confirmation: null } })
    await archiveLayout(api, 'l1', 2)
    await createExport(api, { companyId: 'c1', month: '2026-10', layoutId: 'l1' }, 'key-1')
    expect(calls[7]!.headers.get('idempotency-key')).toBe('key-1')
    await cancelExport(api, 'e1', { version: 1, reason: 'made in error' })
    const link = await openFile(api, 'e1', 'f1')
    expect(calls[9]).toMatchObject({ method: 'POST', url: '/api/people/payroll/exports/e1/files/f1/open' })
    expect(link.url).toBe('/local-files?token=t')
    await sendExport(api, 'e1', { email: 'a@b.it', expiresInDays: 7, maxUses: 10, language: 'it' }, 'key-2')
    await withdrawLink(api, 'e1', 'l1')
    expect(calls[11]).toMatchObject({ method: 'POST', url: '/api/people/payroll/exports/e1/links/l1/withdraw' })
    for (const call of calls) {
      expect(call.headers.get('idempotency-key'), call.url).toBeTruthy()
      expect(call.headers.get('x-csrf-token'), call.url).toBe('csrf-demo')
    }
  })
})

const LEFT_KEY =
  /\b(?:common|noAccess|privacy|pill|band|keys|gate|month|wizard|step|period|checks|check|place|held|aside|kind|mapping|col|preview|send|format|starter|layout|confirm|columns|column|status|list|csv|show|sendDialog|link|correct|change|cancel|record|file|notice|problem|refusal)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs people.payroll.manage"); addresses, files and domains are not keys. */
const SAID = /\b(?:people\.[a-zA-Z.]+|factory\.example|example\.com|art\.\s?\d+|[\w-]+\.(?:csv|pdf|xlsx|txt))\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'people', 'people-payroll', 'ds-words']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [payrollScreen, recordScreen, fileScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(50)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    }, 240_000)
  }

  it('an unconfirmed layout is a warning on every page that shows it; the dialogs say it in the browser sweep (a portal draws nothing here)', () => {
    const it_ = (id: string, screen: DesignScreen<unknown> = payrollScreen as unknown as DesignScreen<unknown>) => render(screen, screen.cases.find((item) => item.id === id)!.model, 'en')
    for (const id of ['period-unconfirmed', 'send-unconfirmed', 'checks-unconfirmed']) expect(it_(id), id).toContain('not confirmed by the labour consultant')
    expect(it_('unconfirmed', recordScreen as unknown as DesignScreen<unknown>)).toContain('not confirmed by the labour consultant')
    expect(it_('summary-unconfirmed', fileScreen as unknown as DesignScreen<unknown>)).toContain('not confirmed by the labour consultant')
    expect(it_('send-done')).toContain('cannot fetch the file in a browser')
    expect(it_('file', recordScreen as unknown as DesignScreen<unknown>)).toContain('cannot fetch the file in a browser')
  })

  it('Nexus says it does not run payroll, where a file is made', () => {
    const html = render(payrollScreen as unknown as DesignScreen<unknown>, payrollScreen.cases.find((item) => item.id === 'send')!.model, 'en')
    expect(html).toContain('Nexus does not run payroll')
  })

  it('the dynamic words exist in both languages (checks, places, refusals, columns, states, what the consultant confirms)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['people-payroll'])['people-payroll']!)
      const has = (key: string, params?: Record<string, number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const code of PAYROLL_CHECKS) {
        has(`check.${code}.name`)
        has(`check.${code}.done`)
        has(`check.${code}.left`, { count: 2 })
      }
      has('check.CODES_MAPPED.warn', { count: 2 })
      for (const place of CHECK_PLACES) has(`place.${place}`)
      for (const code of PAYROLL_REFUSALS) has(`refusal.${code}`, { count: 2 })
      for (const key of COLUMN_KEYS) has(`column.${key}`)
      for (const kind of PAYROLL_CODE_KINDS) has(`kind.${kind}`)
      for (const format of PAYROLL_FORMATS) has(`format.${format}`)
      for (const starter of LAYOUT_STARTERS) has(`starter.${starter}`)
      for (const status of PAYROLL_EXPORT_STATUSES) has(`status.${status}`)
      for (const state of LINK_STATES) has(`link.${state}`)
      for (const key of toConfirmKeys()) has(key)
    }
  })
})
