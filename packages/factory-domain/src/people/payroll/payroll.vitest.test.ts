import { describe, expect, it } from 'vitest'
import { blockingLeft, parseChecks, payrollChecks, storedChecks, type CheckFacts } from './checks'
import { CODE_MEANINGS, codeOrder, EARNING_CODES, HOUR_CODES, mappingKey } from './codes'
import {
  confirmationOf,
  confirmationWords,
  dateText,
  definitionAsUsed,
  definitionProblems,
  delimitedFile,
  fixedWidthFile,
  layoutConfirmed,
  NOT_CONFIRMED_WORDS,
  overflowingValues,
  PAYROLL_TO_CONFIRM,
  printsProviderCode,
  spreadsheetFile,
  STARTERS,
  storedDefinition,
  type FileContext,
  type LayoutDefinition,
} from './layouts'
import { payrollLinkMail } from './mail'
import { monthStateOf, monthStateWords } from './rules'
import { consultantProblemOf, payrollCodeOf, payrollCodeProblems, printerProblemOf } from './settings'
import { amountWords, payrollSummary } from './summary'
import { carriesPay, changeCounts, codeSums, earningFacts, flatValues, hoursOf, parseValues, personValues, valueChanges, valuesText, type MappedCode, type PayrollValue, type PersonFacts } from './values'

const NO_HOURS = Object.fromEntries(HOUR_CODES.map((code) => [code, 0])) as PersonFacts['hours']
const person = (id: string, code: string | null, parts: Partial<PersonFacts> = {}): PersonFacts => ({ employeeId: id, employeeCode: code, kind: 'EMPLOYEE', lastDay: null, hours: NO_HOURS, absences: new Map(), earnings: [], ...parts })
const MAPPING = new Map<string, MappedCode>([[mappingKey('HOUR', 'ORD'), { providerCode: 'V01', meaning: 'Ore ordinarie' }]])
const context: FileContext = { companyCode: 'ACME', month: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30', revision: 1 }
const value = (parts: Partial<PayrollValue>): PayrollValue => ({ employeeCode: 'M1', kind: 'HOUR', code: 'ORD', providerCode: 'V01', meaning: 'Ore ordinarie', unit: 'HOURS', quantity: '7.50', minutes: 450, amount: null, currency: null, lastDay: null, ...parts })

describe('the values (MES-267)', () => {
  it('adds minutes, never rounded hours', () => {
    expect(hoursOf(450)).toBe('7.50')
    expect(hoursOf(445)).toBe('7.42')
    // Three days of 7h 25m: 22.25 hours, not 3 × 7.42.
    const [row] = personValues([person('a', 'M1', { hours: { ...NO_HOURS, ORD: 445 * 3 } })], MAPPING, (code) => code)
    expect(row!.values[0]).toMatchObject({ quantity: '22.25', minutes: 1335, providerCode: 'V01', meaning: 'Ore ordinarie', unit: 'HOURS' })
  })

  it('lists one row per code, hours first, then absences, then earnings, and the people by code', () => {
    const rows = personValues(
      [
        person('b', 'M2', { hours: { ...NO_HOURS, ORD: 60 } }),
        person('a', 'M1', { hours: { ...NO_HOURS, ORD: 60, OT_NIGHT: 30, NIGHT: 30 }, absences: new Map([['ROL', 60], ['FER', 480]]), earnings: [{ code: 'MAKE_UP', pieces: null, minutes: '120.000', amount: 500, currency: 'EUR' }, { code: 'PIECE', pieces: 4, minutes: null, amount: 600, currency: 'EUR' }] }),
      ],
      MAPPING,
      (code) => `words of ${code}`,
    )
    expect(rows.map((row) => row.employeeCode)).toEqual(['M1', 'M2'])
    expect(rows[0]!.values.map((row) => row.code)).toEqual(['ORD', 'OT_NIGHT', 'NIGHT', 'FER', 'ROL', 'PIECE', 'MAKE_UP'])
    expect(rows[0]!.values.find((row) => row.code === 'FER')).toMatchObject({ kind: 'ABSENCE', meaning: 'words of FER', providerCode: null })
    expect(rows[0]!.values.find((row) => row.code === 'PIECE')).toMatchObject({ unit: 'PIECES', quantity: '4', minutes: null, amount: 600, currency: 'EUR' })
    expect(rows[0]!.values.find((row) => row.code === 'MAKE_UP')).toMatchObject({ unit: 'HOURS', quantity: '2.00', amount: 500 })
  })

  it('leaves agency and external people out (MES-211): their employer pays them', () => {
    const rows = personValues([person('a', 'M1', { kind: 'AGENCY', hours: { ...NO_HOURS, ORD: 60 } }), person('b', 'M2', { kind: 'EXTERNAL', hours: { ...NO_HOURS, ORD: 60 } })], MAPPING, (code) => code)
    expect(rows).toEqual([])
  })

  it('writes nothing for a person with no figure, and no row for a code at zero', () => {
    expect(personValues([person('a', 'M1', { absences: new Map([['FER', 0]]), earnings: [{ code: 'ADJUSTMENT', pieces: null, minutes: null, amount: 0, currency: 'EUR' }] })], MAPPING, (code) => code)).toEqual([])
  })

  it('flags a leaver on each of their rows (MES-214), and a person with no code stays visible for the check', () => {
    const rows = personValues([person('a', null, { lastDay: '2026-09-20', hours: { ...NO_HOURS, ORD: 60 } })], MAPPING, (code) => code)
    expect(rows[0]).toMatchObject({ employeeId: 'a', employeeCode: null, lastDay: '2026-09-20' })
    expect(rows[0]!.values[0]).toMatchObject({ employeeCode: '', lastDay: '2026-09-20' })
  })

  it('sums the ledger by kind, reversals included; work of an earlier month is its own code', () => {
    const facts = earningFacts([
      { kind: 'SCAN', correctsPeriodId: null, currency: 'EUR', amount: 1000, pieces: 10, minutes: null },
      { kind: 'SCAN', correctsPeriodId: null, currency: 'EUR', amount: -300, pieces: -3, minutes: null },
      { kind: 'TEAM_SPLIT', correctsPeriodId: null, currency: 'EUR', amount: 200, pieces: 2, minutes: null },
      { kind: 'OFF_STANDARD', correctsPeriodId: null, currency: 'EUR', amount: 90, pieces: null, minutes: '30.000' },
      { kind: 'SCAN', correctsPeriodId: 'p1', currency: 'EUR', amount: 50, pieces: 1, minutes: null },
      { kind: 'MAKE_UP', correctsPeriodId: 'p2', currency: 'EUR', amount: 25, pieces: null, minutes: '10.000' },
    ])
    expect(facts.find((fact) => fact.code === 'PIECE')).toMatchObject({ amount: 700, pieces: 7 })
    expect(facts.find((fact) => fact.code === 'TEAM_SHARE')).toMatchObject({ amount: 200 })
    expect(facts.find((fact) => fact.code === 'OFF_STANDARD')).toMatchObject({ amount: 90, minutes: '30' })
    expect(facts.find((fact) => fact.code === 'EARLIER_MONTH')).toMatchObject({ amount: 75 })
    expect(facts.some((fact) => fact.code === 'MAKE_UP')).toBe(false)
  })

  it('carries a standard-minute bonus as its own code, an amount alone; pieces no scheme paid travel nowhere (B-W2b-84)', () => {
    const facts = earningFacts([
      { kind: 'BONUS', correctsPeriodId: null, currency: 'EUR', amount: 3600, pieces: null, minutes: '240.000' },
      { kind: 'SCAN', correctsPeriodId: null, currency: 'EUR', amount: 0, pieces: 60, minutes: null },
    ])
    expect(facts.find((fact) => fact.code === 'BONUS')).toMatchObject({ amount: 3600 })
    const [row] = personValues([person('a', 'M1', { earnings: facts })], MAPPING, (code) => code)
    expect(row!.values.map((item) => [item.code, item.unit, item.quantity, item.amount])).toEqual([['BONUS', null, null, 3600]])
    expect(row!.values[0]!.meaning).toBe('Standard-minute bonus')
  })

  it('sums per code across people, hours by their minutes, and tells who carries pay', () => {
    const values = [value({}), value({ employeeCode: 'M2', minutes: 445, quantity: '7.42' }), value({ kind: 'EARNING', code: 'PIECE', unit: 'PIECES', quantity: '3', minutes: null, amount: 450, currency: 'EUR' }), value({ employeeCode: 'M2', kind: 'EARNING', code: 'PIECE', unit: 'PIECES', quantity: '2', minutes: null, amount: 300, currency: 'EUR' })]
    const sums = codeSums(values)
    expect(sums[0]).toMatchObject({ code: 'ORD', quantity: '14.92', people: 2 })
    expect(sums[1]).toMatchObject({ code: 'PIECE', quantity: '5', amount: 750, people: 2 })
    expect(carriesPay(values)).toBe(true)
    expect(carriesPay([value({})])).toBe(false)
  })

  it('keeps to the catalogue order for every fixed code', () => {
    const sorted = [...EARNING_CODES].reverse().map((code) => ({ kind: 'EARNING' as const, code })).sort(codeOrder)
    expect(sorted.map((row) => row.code)).toEqual([...EARNING_CODES])
    for (const code of [...HOUR_CODES, ...EARNING_CODES]) expect(CODE_MEANINGS[code].it).not.toBe('')
  })
})

describe('corrections (MES-273)', () => {
  const before = [value({}), value({ code: 'OT_DAY', minutes: 60, quantity: '1.00' }), value({ kind: 'ABSENCE', code: 'FER', minutes: 480, quantity: '8.00', providerCode: null })]

  it('shows from → to, what was added and what is gone, and counts people and values', () => {
    const after = [value({ minutes: 420, quantity: '7.00' }), value({ code: 'OT_DAY', minutes: 60, quantity: '1.00' }), value({ employeeCode: 'M2' })]
    const changes = valueChanges(before, after)
    expect(changes.map((change) => [change.employeeCode, change.code, change.change, change.fromQuantity, change.toQuantity])).toEqual([
      ['M1', 'ORD', 'CHANGED', '7.50', '7.00'],
      ['M1', 'FER', 'REMOVED', '8.00', null],
      ['M2', 'ORD', 'ADDED', null, '7.50'],
    ])
    expect(changeCounts(changes)).toEqual({ people: 2, values: 3 })
  })

  it('sees nothing in a figure put back, and sees a provider code mapped since', () => {
    expect(valueChanges(before, [...before])).toEqual([])
    expect(valueChanges([value({ providerCode: null })], [value({ providerCode: 'V01' })])).toMatchObject([{ change: 'CHANGED', fromProviderCode: null, toProviderCode: 'V01' }])
  })

  it('reads the rows the schema seed wrote, and survives what is no row', () => {
    expect(parseValues([{ employeeCode: 'M1', code: 'ORD', quantity: '1.00' }, 'nonsense', { code: 'x' }])).toMatchObject([{ employeeCode: 'M1', kind: 'HOUR', code: 'ORD', quantity: '1.00', minutes: null, amount: null }])
    expect(parseValues(null)).toEqual([])
  })

  it('reads the same text from what it stored', () => {
    const rows = [value({}), value({ kind: 'EARNING', code: 'PIECE', amount: 450, currency: 'EUR', minutes: null, unit: 'PIECES', quantity: '3' })]
    expect(valuesText(parseValues(JSON.parse(JSON.stringify(rows))))).toBe(valuesText(rows))
  })
})

const CLEAN: CheckFacts = { month: '2026-09', closed: true, noEmployeeCode: 0, daysOpen: 0, anomaliesOpen: 0, lineDaysOpen: 0, piecePayOn: false, payPeriodStatus: null, unmapped: 0, printsProviderCode: true, overflowing: 0, leftOut: 0, leavers: 0, notOnFile: 0, layoutNotConfirmed: false }
const codesLeft = (facts: Partial<CheckFacts>): string[] => blockingLeft(payrollChecks({ ...CLEAN, ...facts })).map((check) => check.code)

describe('the checks (MES-272)', () => {
  it('passes a clean month', () => {
    expect(codesLeft({})).toEqual([])
    expect(payrollChecks(CLEAN).every((check) => check.passed)).toBe(true)
  })

  it('stops the file on each thing the design names, each in words', () => {
    expect(codesLeft({ closed: false })).toEqual(['MONTH_CLOSED'])
    expect(codesLeft({ noEmployeeCode: 2 })).toEqual(['EMPLOYEE_CODES'])
    expect(codesLeft({ daysOpen: 1 })).toEqual(['DAYS_APPROVED'])
    expect(codesLeft({ anomaliesOpen: 1 })).toEqual(['ANOMALIES_CLEARED'])
    expect(codesLeft({ lineDaysOpen: 3 })).toEqual(['PRODUCTION_DAYS'])
    expect(codesLeft({ unmapped: 1 })).toEqual(['CODES_MAPPED'])
    expect(codesLeft({ overflowing: 1 })).toEqual(['LAYOUT_FITS'])
    expect(payrollChecks({ ...CLEAN, closed: false }).find((check) => check.code === 'MONTH_CLOSED')!.words).toBe('September 2026 is not closed: close it in Attendance first.')
    expect(payrollChecks({ ...CLEAN, noEmployeeCode: 1 }).find((check) => check.code === 'EMPLOYEE_CODES')!.words).toBe('1 person has no employee code.')
  })

  it('asks the pay period only when piece pay reaches the month', () => {
    expect(codesLeft({ payPeriodStatus: 'OPEN' })).toEqual([])
    expect(codesLeft({ piecePayOn: true, payPeriodStatus: 'REVIEW' })).toEqual(['PAY_PERIOD_LOCKED'])
    expect(codesLeft({ piecePayOn: true, payPeriodStatus: null })).toEqual(['PAY_PERIOD_LOCKED'])
    expect(codesLeft({ piecePayOn: true, payPeriodStatus: 'LOCKED' })).toEqual([])
  })

  it('lets a layout of our own codes go with codes unmapped, and says so', () => {
    expect(codesLeft({ unmapped: 2, printsProviderCode: false })).toEqual([])
    const check = payrollChecks({ ...CLEAN, unmapped: 2, printsProviderCode: false }).find((entry) => entry.code === 'CODES_MAPPED')!
    expect(check).toMatchObject({ blocking: false, passed: false, count: 2 })
    expect(check.words).toContain('prints our own codes')
  })

  it('only warns of agency people, leavers, people not on the file and an unconfirmed layout', () => {
    const checks = payrollChecks({ ...CLEAN, leftOut: 1, leavers: 2, notOnFile: 3, layoutNotConfirmed: true })
    expect(blockingLeft(checks)).toEqual([])
    expect(checks.filter((check) => !check.passed).map((check) => check.code)).toEqual(['AGENCY_LEFT_OUT', 'LEAVERS', 'NOT_ON_FILE', 'LAYOUT_NOT_CONFIRMED'])
  })

  it('stores its checks alone, in the shape the database asks; what the file carried is a column (B-W2b-89)', () => {
    const stored = storedChecks(payrollChecks(CLEAN))
    expect(stored.every((row) => { const check = row as { code?: unknown; blocking?: unknown; passed?: unknown }; return typeof check.code === 'string' && typeof check.blocking === 'boolean' && typeof check.passed === 'boolean' })).toBe(true)
    expect(stored).toHaveLength(payrollChecks(CLEAN).length)
    expect(parseChecks(stored).length).toBe(payrollChecks(CLEAN).length)
    // A row of an older export (B-W2b-54's CARRIED row) or a code this version does not know is left out.
    expect(parseChecks([...stored, { code: 'CARRIED', corrections: ['c1'] }]).length).toBe(payrollChecks(CLEAN).length)
  })
})

describe('the layouts (MES-268, MES-270)', () => {
  const generic = STARTERS.GENERIC_CSV.definition

  it('writes the generic CSV: its header, its separators, CRLF, a BOM for UTF-8', () => {
    const file = delimitedFile(generic, [value({}), value({ kind: 'EARNING', code: 'PIECE', providerCode: 'V90', unit: 'PIECES', quantity: '3', minutes: null, amount: 12345, currency: 'EUR' })], context)
    expect(file.text).toBe('﻿Matricola;Voce;Quantita;Importo\r\nM1;V01;7,50;\r\nM1;V90;3,00;123,45\r\n')
    expect(file).toMatchObject({ extension: 'csv', format: 'CSV', contentType: 'text/csv', rowCount: 2, encoding: 'UTF-8' })
  })

  it('takes the column map as data: order, headers, separators, no header row, our code, a date format', () => {
    const definition: LayoutDefinition = { columns: [{ key: 'ourCode', header: 'Cod' }, { key: 'employeeCode', header: 'Mat' }, { key: 'periodEnd', format: 'date:YYYYMMDD' }, { key: 'quantity', format: 'number:1' }, { key: 'constant', value: 'X' }, { key: 'meaning' }], delimiter: ',', decimalSeparator: '.', headerRow: false, encoding: 'ISO-8859-1' }
    expect(delimitedFile(definition, [value({ meaning: 'Ore, ordinarie' })], context).text).toBe('ORD,M1,20260930,7.5,X,"Ore, ordinarie"\r\n')
    expect(printsProviderCode(definition)).toBe(false)
    expect(printsProviderCode(generic)).toBe(true)
  })

  it('writes a fixed-width record: words to the left, implied decimals zero padded, signs kept', () => {
    const file = fixedWidthFile(STARTERS.ZUCCHETTI.definition, [value({ quantity: '168.50' }), value({ kind: 'EARNING', code: 'ADJUSTMENT', providerCode: 'V9', quantity: null, unit: null, minutes: null, amount: -1250, currency: 'EUR' })], context)
    expect(file.text).toBe('ACME  M1     092026V01   0016850           \r\nACME  M1     092026V9           -0000001250\r\n')
    expect(file).toMatchObject({ extension: 'txt', format: 'TXT', contentType: 'text/plain', encoding: 'ISO-8859-1' })
    expect(file.text.split('\r\n')[0]!.length).toBe(43)
  })

  it('uses the company code the layout gives, not ours', () => {
    const definition: LayoutDefinition = { ...STARTERS.ZUCCHETTI.definition, companyCode: '000123' }
    expect(fixedWidthFile(definition, [value({})], context).text.startsWith('000123M1')).toBe(true)
  })

  it('counts a value too long for its column: such a file would shift the rest', () => {
    const definition = STARTERS.ZUCCHETTI.definition
    expect(overflowingValues(definition, 'FIXED_WIDTH', [value({ employeeCode: 'TOOLONG12' }), value({})], context)).toBe(1)
    expect(overflowingValues(generic, 'DELIMITED', [value({ employeeCode: 'TOOLONG12' })], context)).toBe(0)
  })

  it('gives a spreadsheet numbers and days, not text', () => {
    const sheet = spreadsheetFile({ columns: [{ key: 'employeeCode', header: 'Mat' }, { key: 'quantity' }, { key: 'amount' }, { key: 'periodEnd' }, { key: 'lastDay' }] }, [value({ amount: 150, currency: 'EUR', lastDay: '2026-09-20' })], context)
    expect(sheet.headings).toEqual(['Mat', 'quantity', 'amount', 'periodEnd', 'lastDay'])
    expect(sheet.rows[0]).toEqual(['M1', { decimal: '7.50' }, { minor: 150, currency: 'EUR' }, { day: '2026-09-30' }, { day: '2026-09-20' }])
  })

  it('writes dates in every format it offers', () => {
    expect(dateText('2026-09-30', 'DD/MM/YYYY')).toBe('30/09/2026')
    expect(dateText('2026-09-30', 'YYYYMMDD')).toBe('20260930')
    expect(dateText('2026-09', 'MMYYYY')).toBe('092026')
    expect(dateText('2026-09', 'MM/YYYY')).toBe('09/2026')
    expect(dateText('2026-09-30', 'YYYY-MM-DD')).toBe('2026-09-30')
  })

  it('refuses a definition that could not be written, each at its field', () => {
    const paths = (format: Parameters<typeof definitionProblems>[0], definition: LayoutDefinition) => definitionProblems(format, definition).map((problem) => problem.path)
    expect(paths('DELIMITED', { columns: [] })).toEqual(['definition/columns'])
    expect(paths('FIXED_WIDTH', { columns: [{ key: 'code' }] })).toEqual(['definition/columns/0/width'])
    expect(paths('DELIMITED', { columns: [{ key: 'code', width: 4 }] })).toEqual(['definition/columns/0/width'])
    expect(paths('DELIMITED', { columns: [{ key: 'constant' }] })).toEqual(['definition/columns/0/value'])
    expect(paths('DELIMITED', { columns: [{ key: 'code', format: 'implied:2' }] })).toEqual(['definition/columns/0/format'])
    expect(paths('DELIMITED', { columns: [{ key: 'quantity', format: 'date:YYYYMMDD' }] })).toEqual(['definition/columns/0/format'])
    expect(paths('DELIMITED', { columns: [{ key: 'code' }], delimiter: 'x', decimalSeparator: ':', dateFormat: 'DD', encoding: 'EBCDIC' })).toEqual(['definition/delimiter', 'definition/decimalSeparator', 'definition/dateFormat', 'definition/encoding'])
    for (const starter of Object.values(STARTERS)) expect(paths(starter.format, starter.definition)).toEqual([])
  })

  it('marks a provider layout not confirmed in words until a person records who confirmed it (GATE-PAYROLL)', () => {
    const zucchetti = { provider: STARTERS.ZUCCHETTI.provider, definition: STARTERS.ZUCCHETTI.definition }
    expect(layoutConfirmed(zucchetti)).toBe(false)
    expect(confirmationWords(zucchetti)).toBe(NOT_CONFIRMED_WORDS)
    const confirmed = { ...zucchetti, definition: { ...zucchetti.definition, confirmation: { on: '2026-11-20', by: 'Made-up consultant' } } }
    expect(layoutConfirmed(confirmed)).toBe(true)
    expect(confirmationWords(confirmed)).toBe('Confirmed by Made-up consultant on 2026-11-20.')
    expect(layoutConfirmed({ provider: null, definition: generic })).toBe(true)
    // B-W2b-89: a live layout keeps the confirmation in its columns; the export's copy carries it in its definition.
    expect(confirmationOf({ confirmedOn: null, confirmedByName: 'Made-up consultant' })).toBeNull()
    expect(confirmationOf({ confirmedOn: '2026-11-20', confirmedByName: 'Made-up consultant' }, 'Office user')).toEqual({ on: '2026-11-20', by: 'Made-up consultant' })
    expect(confirmationOf({ confirmedOn: '2026-11-20', confirmedByName: null }, 'Office user')).toEqual({ on: '2026-11-20', by: 'Office user' })
    expect(STARTERS.ZUCCHETTI.note).toContain('made-up')
    expect(PAYROLL_TO_CONFIRM.join(' ')).toContain('sample')
  })
})

describe('the month', () => {
  it('says where it stands', () => {
    expect(monthStateOf(null, 0)).toBe('NOT_EXPORTED')
    expect(monthStateOf({ revision: 1 }, 0)).toBe('EXPORTED')
    expect(monthStateOf({ revision: 1 }, 2)).toBe('CORRECTION_PENDING')
    expect(monthStateWords('NOT_EXPORTED', '2026-10', null, { people: 0, values: 0 })).toBe('October 2026 · not exported')
    expect(monthStateWords('EXPORTED', '2026-10', { revision: 1, exportedOn: '2026-11-03' }, { people: 0, values: 0 })).toBe('Exported 2026-11-03 · v1')
    expect(monthStateWords('CORRECTION_PENDING', '2026-10', { revision: 1, exportedOn: '2026-11-03' }, { people: 3, values: 7 })).toBe('Exported 2026-11-03 · v1 · correction pending: 3 people, 7 values')
  })
})

describe('the summary', () => {
  const values = flatValues(personValues([person('a', 'M1', { lastDay: '2026-09-20', hours: { ...NO_HOURS, ORD: 450 }, earnings: [{ code: 'PIECE', pieces: 4, minutes: null, amount: 123456, currency: 'EUR' }] })], MAPPING, (code) => code))
  const facts = { context, company: { legalName: 'Made-up Spa', vatNumber: null }, layoutName: 'Generic CSV', confirmed: true, values, changes: [], replaces: null, leftOut: 0, createdAt: new Date('2026-10-02T08:00:00.000Z') }

  it('gives totals per employee code, never a name, in Italian', () => {
    const summary = payrollSummary(facts)
    expect(summary.heading).toBe('Made-up Spa · settembre 2026')
    expect(summary.blocks[0]).toMatchObject({ title: 'Matricola M1', note: 'cessazione: ultimo giorno 20/09/2026' })
    expect(summary.blocks[0]!.rows.map((row) => [row.voice, row.words, row.quantity, row.amount])).toEqual([
      ['V01', 'Ore ordinarie', '7,50 h', ''],
      ['', 'Cottimo', '4 pz', '1.234,56 EUR'],
    ])
    expect(summary.totals.map((row) => row.quantity)).toEqual(['7,50 h', '4 pz'])
    expect(summary.fileName).toBe('PAGHE_ACME_2026-09_v1_riepilogo.pdf')
  })

  it('says what a correction replaces and what changed, and that a layout is not confirmed', () => {
    const summary = payrollSummary({ ...facts, confirmed: false, leftOut: 2, replaces: { number: 'PAY-2026-0001', revision: 1 }, changes: valueChanges([value({})], [value({ minutes: 420, quantity: '7.00' })]) })
    expect(summary.notes.join(' ')).toContain('Sostituisce la versione v1 (PAY-2026-0001)')
    expect(summary.notes.join(' ')).toContain('Tracciato da confermare')
    expect(summary.notes.join(' ')).toContain('non comprese: 2')
    expect(summary.changes).toEqual([{ employeeCode: 'M1', words: 'Ore ordinarie', from: '7,50 h (V01)', to: '7,00 h (V01)' }])
  })

  it('writes amounts the Italian way, signs and thousands included', () => {
    expect(amountWords(123456789, 'EUR')).toBe('1.234.567,89 EUR')
    expect(amountWords(-5, null)).toBe('-0,05')
    expect(amountWords(null, 'EUR')).toBe('')
  })
})

describe('the mail (GDPR art. 32)', () => {
  const mail = { locale: 'it' as const, companyName: 'Made-up Spa', month: '2026-09', number: 'PAY-2026-0002', revision: 1, expiresAt: new Date('2026-11-10T10:00:00.000Z'), uses: 10, message: null, notConfirmed: false }

  it('carries the link and the terms, no figure and no attachment', () => {
    const { subject, body } = payrollLinkMail(mail, 'https://example.test/l#token=abc')
    expect(subject).toBe('Paghe settembre 2026: file per il consulente del lavoro (PAY-2026-0002)')
    expect(body).toContain('https://example.test/l#token=abc')
    expect(body).toContain('10 aperture')
    expect(body).toContain('Ogni scaricamento viene registrato')
  })

  it('names the version of a correction, the note of the sender and an unconfirmed layout, in either language', () => {
    const { subject, body } = payrollLinkMail({ ...mail, locale: 'en', revision: 2, message: 'Made-up note.', notConfirmed: true }, 'https://example.test/l#token=abc')
    expect(subject).toContain('PAY-2026-0002, v2')
    expect(body).toContain('This version (v2) replaces the one before.')
    expect(body).toContain('Made-up note.')
    expect(body).toContain('still to be confirmed')
  })
})

describe('the layout as stored and as used (B-W2b-89)', () => {
  const generic = STARTERS.GENERIC_CSV.definition

  it('stores a definition without the payroll code and the confirmation, which live in columns', () => {
    const typed: LayoutDefinition = { ...generic, companyCode: '000123', confirmation: { on: '2026-11-20', by: 'Made-up consultant' } }
    expect(storedDefinition(typed)).toEqual(generic)
    expect(storedDefinition(typed)).not.toHaveProperty('companyCode')
    expect(storedDefinition(typed)).not.toHaveProperty('confirmation')
  })

  it("puts the company's payroll code and the confirmation in the export's copy, and the file prints the code", () => {
    const used = definitionAsUsed(generic, { payrollCode: '000777', confirmation: { on: '2026-11-20', by: 'Made-up consultant' } })
    expect(used.companyCode).toBe('000777')
    expect(used.confirmation).toEqual({ on: '2026-11-20', by: 'Made-up consultant' })
    expect(layoutConfirmed({ provider: 'Made-up provider', definition: used })).toBe(true)
    const columns: LayoutDefinition = { columns: [{ key: 'companyCode' }, { key: 'employeeCode' }], headerRow: false, encoding: 'ISO-8859-1' }
    expect(delimitedFile(definitionAsUsed(columns, { payrollCode: '000777', confirmation: null }), [value({})], context).text.split(/\r?\n/)[0]).toBe('000777;M1')
    // None given: the company's own code.
    const plain = definitionAsUsed(columns, { payrollCode: null, confirmation: null })
    expect(plain).not.toHaveProperty('companyCode')
    expect(delimitedFile(plain, [value({})], context).text.split(/\r?\n/)[0]).toBe('ACME;M1')
  })
})

describe('People settings › Payroll and statements (B-W2b-89)', () => {
  it('takes a consultant that is an active party with the Consultant role, of the company or of every company', () => {
    expect(consultantProblemOf({ companyId: 'c1', roles: ['CONSULTANT'], status: 'ACTIVE' }, 'c1')).toBeNull()
    expect(consultantProblemOf({ companyId: null, roles: ['SUPPLIER', 'CONSULTANT'], status: 'ACTIVE' }, 'c1')).toBeNull()
    expect(consultantProblemOf({ companyId: 'c1', roles: ['SUPPLIER'], status: 'ACTIVE' }, 'c1')).toBe('NOT_CONSULTANT')
    expect(consultantProblemOf({ companyId: 'c1', roles: ['CONSULTANT'], status: 'BLOCKED' }, 'c1')).toBe('NOT_ACTIVE')
    expect(consultantProblemOf({ companyId: 'c2', roles: ['CONSULTANT'], status: 'ACTIVE' }, 'c1')).toBe('OTHER_COMPANY')
    expect(consultantProblemOf(null, 'c1')).toBe('GONE')
  })

  it('takes an active A4 printer for statements', () => {
    expect(printerProblemOf({ kind: 'A4_PDF', status: 'ACTIVE' })).toBeNull()
    expect(printerProblemOf({ kind: 'LABEL_ZPL', status: 'ACTIVE' })).toBe('NOT_A4')
    expect(printerProblemOf({ kind: 'A4_PDF', status: 'ARCHIVED' })).toBe('NOT_ACTIVE')
    expect(printerProblemOf(null)).toBe('GONE')
  })

  it('keeps the payroll code trimmed, at most 20 characters', () => {
    expect(payrollCodeOf('  000777 ')).toBe('000777')
    expect(payrollCodeOf('   ')).toBeNull()
    expect(payrollCodeOf(null)).toBeNull()
    expect(payrollCodeProblems('X'.repeat(21)).map((issue) => issue.path)).toEqual(['body/payrollCode'])
    expect(payrollCodeProblems('X'.repeat(20))).toEqual([])
  })
})
