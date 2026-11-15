import { describe, expect, it } from 'vitest'
import { BANK_FORMATS as DOMAIN_FORMATS, BANK_LINE_PROBLEMS as DOMAIN_PROBLEMS, STATEMENT_REFUSALS as DOMAIN_STATEMENT_REFUSALS } from '@nexus/factory-domain/payments/bank-formats/statement'
import { IMPORT_REFUSALS as DOMAIN_IMPORT_REFUSALS, LINE_VERDICTS as DOMAIN_VERDICTS, STATEMENT_FILES } from '@nexus/factory-domain/payments/bank/import'
import { MATCH_CONFIDENCES as DOMAIN_CONFIDENCES, MATCH_REASONS as DOMAIN_REASONS } from '@nexus/factory-domain/payments/matching/match'
import { WRITE_OFF_KINDS as DOMAIN_KINDS, WRITE_OFF_REASONS as DOMAIN_WRITE_OFF_REASONS, WRITE_OFF_REFUSALS as DOMAIN_WRITE_OFF_REFUSALS } from '@nexus/factory-domain/payments/write-offs/write-offs'
import { NUMBER_FORMATS as DOMAIN_NUMBER_FORMATS } from '@nexus/factory-domain/imports/cells'
import { FIGURES_REFUSALS, LINE_STATES } from '@nexus/factory-domain/receivables-figures/figures'
import { ApiError } from '../../../lib/api/errors'
import en from '../../../../messages/en/finance-bank.json'
import itWords from '../../../../messages/it/finance-bank.json'
import { BANK_FORMATS, BANK_LINE_PROBLEMS, FORMAT_EXTENSIONS, IMPORT_REFUSALS, LINE_VERDICTS, MATCH_CONFIDENCES, MATCH_REASONS, NUMBER_FORMATS, STATEMENT_COLUMNS, STATEMENT_REFUSALS, WRITE_OFF_KINDS, WRITE_OFF_REASONS, WRITE_OFF_REFUSALS } from './api'
import { F1_ANSWER, L_FEES, L_MATCHED, L_OUT, L_STALE, L_SURE, L_TWO, PLAN, ROLES, TO_MATCH } from './demo'
import {
  acceptHeld,
  addressOf,
  bankCanOf,
  bankHref,
  chooseHeld,
  draftOf,
  EMPTY_ADDRESS,
  emptyFigures,
  entriesOf,
  figuresDraftProblems,
  importHeld,
  linesCsv,
  mappingMissing,
  mappingOf,
  maskIban,
  parseSignedAmount,
  pastedRows,
  reverseHeld,
  softLocked,
  stepLine,
  sureOf,
  writeProblem,
} from './model'

/** B-W2b-406 — Finance › Bank: the lists equal factory-domain's, the page's rules, every code worded in both languages. */

const finance = bankCanOf(ROLES.finance)
const readonly = bankCanOf(ROLES.readonly)
const flat = (value: unknown, prefix = ''): Record<string, string> =>
  Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((out, [key, inner]) => (typeof inner === 'string' ? { ...out, [`${prefix}${key}`]: inner } : { ...out, ...flat(inner, `${prefix}${key}.`) }), {})
const EN = flat(en)
const IT = flat(itWords)
const worded = (key: string) => key in EN || `${key}_one` in EN

describe('the lists equal factory-domain’s', () => {
  it('formats, verdicts, problems, refusals, confidence, reasons and write-offs', () => {
    expect(BANK_FORMATS).toEqual(DOMAIN_FORMATS)
    expect(BANK_LINE_PROBLEMS).toEqual(DOMAIN_PROBLEMS)
    expect(STATEMENT_REFUSALS).toEqual(DOMAIN_STATEMENT_REFUSALS)
    expect(IMPORT_REFUSALS).toEqual(DOMAIN_IMPORT_REFUSALS)
    expect(LINE_VERDICTS).toEqual(DOMAIN_VERDICTS)
    expect(MATCH_CONFIDENCES).toEqual(DOMAIN_CONFIDENCES)
    expect(MATCH_REASONS).toEqual(DOMAIN_REASONS)
    expect(WRITE_OFF_KINDS).toEqual(DOMAIN_KINDS)
    expect(WRITE_OFF_REASONS).toEqual(DOMAIN_WRITE_OFF_REASONS)
    expect(WRITE_OFF_REFUSALS).toEqual(DOMAIN_WRITE_OFF_REFUSALS)
    expect(NUMBER_FORMATS).toEqual(DOMAIN_NUMBER_FORMATS)
    for (const format of BANK_FORMATS) expect(FORMAT_EXTENSIONS[format]).toEqual(STATEMENT_FILES[format].extensions)
  })

  it('every code has its words in both languages', () => {
    const keys = [
      ...MATCH_CONFIDENCES.map((code) => `confidence.${code}`),
      ...MATCH_REASONS.map((code) => `reason.${code}`),
      ...WRITE_OFF_KINDS.map((code) => `difference.${code}`),
      ...WRITE_OFF_REASONS.map((code) => `writeOff.reasons.${code}`),
      ...WRITE_OFF_REFUSALS.map((code) => `writeOff.refusal.${code}`),
      ...BANK_FORMATS.map((code) => `format.${code}`),
      ...LINE_VERDICTS.map((code) => `import.verdict.${code}`),
      ...BANK_LINE_PROBLEMS.map((code) => `import.problem.${code}`),
      ...IMPORT_REFUSALS.map((code) => `import.refusal.${code}`),
      ...STATEMENT_REFUSALS.map((code) => `import.file.${code}`),
      ...STATEMENT_COLUMNS.map((code) => `import.column.${code}`),
      ...NUMBER_FORMATS.map((code) => `import.numbers.${code}`),
      ...LINE_STATES.map((code) => `figures.state.${code}`),
      ...FIGURES_REFUSALS.map((code) => `figures.refusal.${code}`),
    ]
    expect(keys.filter((key) => !worded(key))).toEqual([])
    expect(Object.keys(EN).sort()).toEqual(Object.keys(IT).sort())
  })
})

describe('the page’s address', () => {
  it('keeps the view, the open line, the statement, the import and the figures', () => {
    const address = addressOf(new URLSearchParams(`view=SURE&line=${L_SURE.id}&import=1&figures=new`))
    expect(address).toEqual({ view: 'SURE', statement: null, line: L_SURE.id, importing: true, figures: 'new', correct: false })
    expect(bankHref('/w/DEMO', address)).toBe(`/w/DEMO/finance/bank?view=SURE&line=${L_SURE.id}&import=1&figures=new`)
    expect(bankHref('/w/DEMO', EMPTY_ADDRESS)).toBe('/w/DEMO/finance/bank')
    // A statement wins over the view; a wrong view is the default; a correction needs figures open.
    expect(addressOf(new URLSearchParams(`view=NOPE&statement=${L_SURE.statementId}&correct=1`))).toMatchObject({ view: 'TO_MATCH', statement: L_SURE.statementId, correct: false })
  })
})

describe('what holds an action, and why', () => {
  it('accept, choose, take back', () => {
    expect(acceptHeld(L_SURE, L_SURE.suggestions[0]!, finance)).toBeNull()
    expect(acceptHeld(L_SURE, L_SURE.suggestions[0]!, readonly)).toEqual({ key: 'held.match' })
    expect(acceptHeld(L_STALE, L_STALE.suggestions[0]!, finance)).toEqual({ key: 'held.stale' })
    expect(acceptHeld({ ...L_SURE, currency: 'USD' }, L_SURE.suggestions[0]!, finance)).toEqual({ key: 'held.currency', params: { currency: 'USD' } })
    expect(acceptHeld(L_OUT, L_OUT.suggestions[0]!, { ...finance, record: false })).toBeNull()
    expect(acceptHeld(L_SURE, L_SURE.suggestions[0]!, { ...finance, record: false })).toEqual({ key: 'held.record' })
    expect(chooseHeld(L_TWO, finance)).toBeNull()
    expect(chooseHeld(L_OUT, finance)).toEqual({ key: 'held.chooseOut' })
    expect(chooseHeld(L_MATCHED, finance)).toEqual({ key: 'held.matched' })
    expect(reverseHeld(L_MATCHED, finance)).toBeNull()
    expect(reverseHeld(L_MATCHED, { ...finance, void: false })).toEqual({ key: 'held.void' })
    expect(reverseHeld(L_SURE, finance)).toEqual({ key: 'held.notMatched' })
  })

  it('accept all High takes one sure match per line; J / K step through the list', () => {
    expect(sureOf(TO_MATCH, finance).map((entry) => entry.line.id)).toEqual([L_SURE.id])
    expect(sureOf(TO_MATCH, readonly)).toEqual([])
    expect(stepLine(TO_MATCH, L_FEES.id, 1)).toBe(L_OUT.id)
    expect(stepLine(TO_MATCH, L_FEES.id, -1)).toBeNull()
    expect(stepLine(TO_MATCH, null, 1)).toBe(L_FEES.id)
    expect(stepLine(TO_MATCH, null, -1)).toBe(L_SURE.id)
  })

  it('never draws an IBAN whole', () => {
    expect(maskIban('IT00A0000000000000000004101')).toBe('IT** **** **** 4101')
    expect(maskIban(null)).toBe('')
  })
})

describe('refusals in the page’s words', () => {
  const refused = (status: number, paths: string[]) => new ApiError(status === 409 ? 'conflict' : 'invalid', status, 'conflict', 'English the page never shows.', 'r', paths.map((path) => ({ path, message: 'x' })))
  it('import, file, write-off, period, figures, items', () => {
    expect(writeProblem(refused(409, ['import/NOTHING_NEW']))).toEqual([{ key: 'import.refusal.NOTHING_NEW' }])
    expect(writeProblem(refused(400, ['file/SEVERAL_ACCOUNTS']))).toEqual([{ key: 'import.file.SEVERAL_ACCOUNTS' }])
    expect(writeProblem(refused(400, ['file/header.Importo']))).toEqual([{ key: 'import.file.sheet' }])
    expect(writeProblem(refused(409, ['writeOff/OVER_TOLERANCE']))).toEqual([{ key: 'writeOff.refusal.OVER_TOLERANCE' }])
    expect(writeProblem(refused(409, ['line/RECORDED_ALREADY']))).toEqual([{ key: 'match.refusal.recorded' }])
    expect(writeProblem(refused(409, ['period/SOFT_LOCKED', 'matchId']))).toEqual([{ key: 'period.soft' }, { key: 'problem.write.moved' }])
    expect(softLocked(refused(409, ['period/SOFT_LOCKED']))).toBe(true)
    expect(writeProblem(refused(409, ['figures/NOT_A_CUSTOMER']))).toEqual([{ key: 'figures.refusal.NOT_A_CUSTOMER' }])
    expect(writeProblem(refused(400, ['body/figures/orders/0/amount']))).toEqual([{ key: 'figures.problem.amount' }])
    expect(writeProblem(refused(409, ['items/1']))).toEqual([{ key: 'match.refusal.items' }])
    expect(writeProblem(refused(409, []))).toEqual([{ key: 'problem.write.state' }])
    expect(writeProblem(new Error('x'))).toEqual([{ key: 'problem.write.internal' }])
  })
})

describe('importing a statement', () => {
  it('the mapping needs the day and an amount; Import waits for the check, the new lines and the unreadable ones left out', () => {
    expect(mappingMissing(mappingOf(PLAN))).toEqual([])
    expect(mappingMissing({ ...mappingOf(PLAN), Importo: null }).map((entry) => entry.key)).toEqual(['import.mapping.needAmount'])
    expect(mappingMissing({ A: 'bookedOn', B: 'bookedOn', C: 'amount' }).map((entry) => entry.key)).toEqual(['import.mapping.twice'])
    expect(importHeld(null, false, finance, false)).toEqual({ key: 'held.dryRunFirst' })
    expect(importHeld(PLAN, false, finance, false)).toEqual({ key: 'held.skipErrors', params: { count: 1 } })
    expect(importHeld(PLAN, true, finance, false)).toBeNull()
    expect(importHeld({ ...PLAN, counts: { new: 0, duplicate: 4, error: 0 } }, true, finance, false)).toEqual({ key: 'import.refusal.NOTHING_NEW' })
    expect(importHeld(PLAN, true, readonly, false)).toEqual({ key: 'held.import' })
  })
})

describe('their figures as typed', () => {
  it('reads amounts either way, signed; checks each field; pasted rows from a spreadsheet', () => {
    expect(parseSignedAmount('1.250,50')).toBe(125050)
    expect(parseSignedAmount('-80')).toBe(-8000)
    expect(parseSignedAmount('(12.5)')).toBe(-1250)
    expect(parseSignedAmount('0')).toBe(0)
    expect(parseSignedAmount('12,5x')).toBeNull()
    const draft = { ...emptyFigures('2026-11-15'), asOf: '2026-11-20', balance: 'abc', orders: [{ reference: '', amount: '12' }], payments: [{ reference: 'B', date: '2026-11-21', amount: '1' }] }
    expect(figuresDraftProblems(draft, '2026-11-15', true)).toEqual({ party: 'figures.problem.party', asOf: 'figures.problem.asOf', balance: 'figures.problem.amount', 'orders.0.reference': 'figures.problem.reference', 'payments.0.date': 'figures.problem.date' })
    expect(entriesOf(draft, '2026-11-15', true)).toBeNull()
    const good = { ...emptyFigures('2026-11-15'), partyId: 'p', asOf: '2026-11-10', balance: '210,00', orders: [{ reference: ' PO  5521 ', amount: '410,00' }, { reference: '', amount: '' }], payments: [{ reference: 'CRO 1', date: '2026-11-02', amount: '400' }] }
    expect(entriesOf(good, '2026-11-15', true)).toEqual({ orders: [{ reference: 'PO 5521', amount: 41000 }], payments: [{ reference: 'CRO 1', date: '2026-11-02', amount: 40000 }], balance: 21000 })
    expect(pastedRows('Riferimento\tImporto\nPO 5521\t410,00\nFT-2026-00029\t200,00', 'orders')).toEqual([
      { reference: 'PO 5521', amount: '410,00' },
      { reference: 'FT-2026-00029', amount: '200,00' },
    ])
    expect(pastedRows('02/11/2026;CRO 0000 5555;400,00', 'payments')).toEqual([{ reference: 'CRO 0000 5555', date: '2026-11-02', amount: '400,00' }])
  })

  it('reads recorded figures back as a draft, in the order typed', () => {
    const draft = draftOf(F1_ANSWER, 'it')
    expect(draft.orders).toEqual([
      { reference: 'PO 5521', amount: '410,00' },
      { reference: 'FT-2026-00029', amount: '200,00' },
    ])
    expect(draft.payments.map((entry) => entry.reference)).toEqual(['CRO 0000 5555', 'Bonifico 9 novembre'])
    expect(draft.balance).toBe('210,00')
  })
})

describe('the CSV of the lines', () => {
  it('masks the IBAN and leaves the amount out without the price grain', () => {
    const words = { header: (key: string) => key, state: () => 'S', confidence: () => 'C', amount: (minor: number) => (minor / 100).toFixed(2) }
    const withPrice = linesCsv([L_SURE], true, words)
    expect(withPrice).toContain('409.60')
    expect(withPrice).toContain('IT** **** **** 4101')
    expect(withPrice).not.toContain('IT00A0000000000000000004101')
    expect(linesCsv([L_SURE], false, words).split('\r\n')[0]).not.toContain('amount')
  })
})
