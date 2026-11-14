import { describe, expect, it } from 'vitest'
import type { Instalment } from '../../sales/terms/terms'
import { conventionsOf, conventionWords, dueDateUnder, invoiceDueUnder, NO_CONVENTIONS, normalSkipMonths, outOfSkippedMonths, skipMonthsProblems } from './due-dates'

// B-W2b-396 (FIN-076): Italian due-date conventions; every amount and term here is made up.
const at = (days: number, endOfMonth = false): Instalment => ({ sharePct: '100.0000', from: 'INVOICE', days, endOfMonth })

describe('due dates from the invoice date or the end of the month (FIN-076)', () => {
  it('counts from the invoice date, or from the end of its month, then the end of month when the instalment says so', () => {
    expect(dueDateUnder('2026-03-10', at(30))).toBe('2026-04-09')
    expect(dueDateUnder('2026-03-10', at(30, true))).toBe('2026-04-30')
    expect(dueDateUnder('2026-03-10', at(30), { fromEndOfMonth: true, skipMonths: [] })).toBe('2026-04-30')
    expect(dueDateUnder('2026-01-15', at(30), { fromEndOfMonth: true, skipMonths: [] })).toBe('2026-03-02')
    expect(dueDateUnder('2026-01-15', at(30, true), { fromEndOfMonth: true, skipMonths: [] })).toBe('2026-03-31')
    expect(dueDateUnder('2026-03-10', at(0), NO_CONVENTIONS)).toBe('2026-03-10')
  })

  it('moves a due day out of the skipped months: same day of the next month not skipped, or its end', () => {
    expect(outOfSkippedMonths('2026-08-15', [8])).toBe('2026-09-15')
    expect(outOfSkippedMonths('2026-08-31', [8])).toBe('2026-09-30')
    expect(outOfSkippedMonths('2026-07-31', [8])).toBe('2026-07-31')
    expect(outOfSkippedMonths('2026-12-20', [12, 1])).toBe('2027-02-20')
    expect(outOfSkippedMonths('2027-01-31', [1])).toBe('2027-02-28')
    // 60 days end of month from 10 June: 9 August → 31 August → skipped → 30 September.
    expect(dueDateUnder('2026-06-10', at(60, true), { fromEndOfMonth: false, skipMonths: [8] })).toBe('2026-09-30')
    expect(dueDateUnder('2026-06-20', at(60), { fromEndOfMonth: false, skipMonths: [8] })).toBe('2026-09-19')
  })

  it('checks the skipped months as the database does, and reads a stored row', () => {
    expect(skipMonthsProblems([8, 12])).toEqual([])
    expect(skipMonthsProblems([0]).map((issue) => issue.message)).toEqual(['Months are 1 (January) to 12 (December).'])
    expect(skipMonthsProblems([8, 8]).map((issue) => issue.message)).toEqual(['Each month once.'])
    expect(skipMonthsProblems([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map((issue) => issue.message)).toEqual(['At most 11 months are skipped: one month at least stays to pay in.'])
    expect(normalSkipMonths([12, 8, 8])).toEqual([8, 12])
    expect(conventionsOf({ fromEndOfMonth: true, skipMonths: [12, 8] })).toEqual({ fromEndOfMonth: true, skipMonths: [8, 12] })
    expect(conventionsOf({})).toEqual({ fromEndOfMonth: false, skipMonths: [] })
  })

  it("dates each instalment of an invoice under the terms' conventions; the amounts stay W2a's", () => {
    const terms = { method: 'MP12', instalments: [{ ...at(30, true), sharePct: '50.0000' }, { ...at(60, true), sharePct: '50.0000' }], earlyPaymentDiscountPct: null, earlyPaymentDays: null, fromEndOfMonth: false, skipMonths: [8] }
    const due = invoiceDueUnder(terms, '2026-06-15', 100_001)
    expect(due.condition).toBe('TP01')
    expect(due.instalments).toEqual([
      { dueDate: '2026-07-31', amount: 50_001 },
      { dueDate: '2026-09-30', amount: 50_000 },
    ])
    // Everything due before the invoice: one instalment on its day, no convention moves it.
    const before = invoiceDueUnder({ ...terms, instalments: [{ sharePct: '100.0000', from: 'BEFORE_SHIPPING', days: 0, endOfMonth: false }], skipMonths: [6] }, '2026-06-15', 1000)
    expect(before.instalments).toEqual([{ dueDate: '2026-06-15', amount: 1000 }])
  })

  it('says the conventions in words, Italian and English', () => {
    expect(conventionWords({ fromEndOfMonth: true, skipMonths: [8, 12] }, 'it')).toBe('giorni contati dalla fine del mese · escluso agosto e dicembre (la scadenza passa al mese dopo)')
    expect(conventionWords({ fromEndOfMonth: false, skipMonths: [8] }, 'en')).toBe('August skipped (the due day moves to the next month)')
    expect(conventionWords(NO_CONVENTIONS, 'it')).toBeNull()
  })
})
