import { describe, expect, it } from 'vitest'
import { addCells, coveredPct, emptySum, gapMinutes, matchOf, summaryShown } from '../reports/attendance/report'
import { hoursText, lulCalendar, lulCsv, lulCsvRows, type LulDay, type LulFacts } from './lul'
import {
  cellOf,
  CLOSE_ITEMS,
  closeChecklist,
  closeHolds,
  closeNotes,
  closePhraseMatches,
  closePhrases,
  correctionProblems,
  differingCells,
  effectiveCells,
  holdWords,
  latestCorrections,
  lulDaysLeft,
  lulDueBy,
  monthOver,
  nextMonth,
  NO_CELLS,
  type CorrectionFact,
  type DayCells,
  type MonthFacts,
} from './rules'

/**
 * The month close's pure rules (B-W2b-48; MES-231, MES-236, MES-303): the checklist and what holds it, the LUL deadline (D.L.
 * 112/2008 art. 39 c.3), the typed phrase (Owner answer P1), a closed figure and its corrections, the generic calendar.
 */

const clean: MonthFacts = { month: '2026-03', today: '2026-04-02', closed: false, days: 40, daysOpen: 0, anomaliesOpen: 0, absencesMissing: 0, lineDaysOpen: 0, manualOpen: 0, overtimePending: 0, gateOffSites: 0, timesheetsOpen: 0, codesWithoutLul: 0, notEmployees: 0 }

describe('the checklist', () => {
  it('lists the design items in order, each with what is left', () => {
    const list = closeChecklist({ ...clean, daysOpen: 2, overtimePending: 1 })
    expect(list.map((entry) => entry.item)).toEqual([...CLOSE_ITEMS])
    expect(list[0]).toMatchObject({ item: 'DAYS_APPROVED', left: 2, done: false, words: '2 days left to approve.' })
    expect(list[5]).toMatchObject({ item: 'OVERTIME_DECIDED', left: 1, done: false })
    expect(list[1]).toMatchObject({ left: 0, done: true, words: 'Anomalies cleared.' })
  })

  it('holds a close for every item left, and frees it when none is', () => {
    expect(closeHolds(clean)).toEqual([])
    expect(closeHolds({ ...clean, daysOpen: 1, anomaliesOpen: 1, absencesMissing: 1, lineDaysOpen: 1, manualOpen: 1, overtimePending: 1 })).toEqual([...CLOSE_ITEMS])
  })

  it('never closes a month that is not over, an empty one, or one with a site whose gate is off', () => {
    expect(closeHolds({ ...clean, today: '2026-03-31' })).toEqual(['MONTH_NOT_OVER'])
    expect(closeHolds({ ...clean, today: '2026-04-01' })).toEqual([])
    expect(closeHolds({ ...clean, days: 0 })).toEqual(['NO_DAYS'])
    expect(closeHolds({ ...clean, gateOffSites: 1 })).toEqual(['GATE_OFF'])
    expect(holdWords('GATE_OFF', { ...clean, gateOffSites: 1 })).toContain('art. 4 c.2')
    expect(monthOver('2026-12', '2027-01-01')).toBe(true)
  })

  it('says a closed month is closed, and nothing else', () => {
    expect(closeHolds({ ...clean, closed: true, daysOpen: 5 })).toEqual(['ALREADY_CLOSED'])
  })

  it('never holds for timesheets, codes without a LUL code or agency people: they are notes (the design has no such item)', () => {
    const facts = { ...clean, timesheetsOpen: 3, codesWithoutLul: 2, notEmployees: 1 }
    expect(closeHolds(facts)).toEqual([])
    expect(closeNotes(facts).map((entry) => entry.note)).toEqual(['TIMESHEETS_NOT_APPROVED', 'CODES_WITHOUT_LUL', 'AGENCY_WORKERS'])
    expect(closeNotes(clean)).toEqual([])
  })
})

describe('the deadline and the phrase', () => {
  it('is the end of the following month (art. 39 c.3)', () => {
    expect(lulDueBy('2026-10')).toBe('2026-11-30')
    expect(lulDueBy('2026-12')).toBe('2027-01-31')
    expect(lulDueBy('2028-01')).toBe('2028-02-29')
    expect(nextMonth('2026-12')).toBe('2027-01')
    expect(lulDaysLeft('2026-10', '2026-11-02')).toBe(28)
    expect(lulDaysLeft('2026-10', '2026-12-01')).toBe(-1)
  })

  it('closes only with the month typed, in either language (Owner answer P1)', () => {
    expect(closePhrases('2026-10')).toEqual({ en: 'close October 2026', it: 'chiudi ottobre 2026' })
    expect(closePhraseMatches('2026-10', ' Close   october 2026 ')).toBe(true)
    expect(closePhraseMatches('2026-10', 'CHIUDI OTTOBRE 2026')).toBe(true)
    expect(closePhraseMatches('2026-10', 'close November 2026')).toBe(false)
    expect(closePhraseMatches('2026-10', undefined)).toBe(false)
  })
})

const cells: DayCells = { present: 480, ordinary: 450, night: 0, holiday: 0, overtimeDay: 30, overtimeNight: 0, overtimeHoliday: 0, absences: new Map([['fer', 60]]) }
const at = (minute: number) => new Date(Date.UTC(2026, 3, 1, 8, minute))
const fact = (id: string, kind: CorrectionFact['kind'], minutesAfter: number, minute: number, absenceCodeId: string | null = null): CorrectionFact => ({ id, kind, absenceCodeId, minutesAfter, createdAt: at(minute) })

describe('a closed figure and its corrections', () => {
  it('asks a reason, a whole figure and a code exactly for an absence', () => {
    expect(correctionProblems({ kind: 'ORDINARY', absenceCodeId: null, minutesAfter: 420, reason: 'Wrong shift entered' })).toEqual([])
    expect(correctionProblems({ kind: 'ORDINARY', absenceCodeId: null, minutesAfter: 420, reason: '  ' }).map((entry) => entry.path)).toEqual(['reason'])
    expect(correctionProblems({ kind: 'ABSENCE', absenceCodeId: null, minutesAfter: 60, reason: 'Certificate came late' }).map((entry) => entry.path)).toEqual(['absenceCodeId'])
    expect(correctionProblems({ kind: 'NIGHT', absenceCodeId: 'x', minutesAfter: 60, reason: 'Certificate came late' }).map((entry) => entry.path)).toEqual(['absenceCodeId'])
    expect(correctionProblems({ kind: 'NIGHT', absenceCodeId: null, minutesAfter: 1441, reason: 'Too long a day' }).map((entry) => entry.path)).toEqual(['minutesAfter'])
    expect(correctionProblems({ kind: 'NIGHT', absenceCodeId: null, minutesAfter: 7.5, reason: 'Half a minute' }).map((entry) => entry.path)).toEqual(['minutesAfter'])
  })

  it('takes the latest per kind and code, by time then id, as the database chain does', () => {
    const list = [fact('b', 'ORDINARY', 420, 1), fact('a', 'ORDINARY', 400, 1), fact('c', 'ORDINARY', 410, 0), fact('d', 'ABSENCE', 90, 2, 'fer'), fact('e', 'ABSENCE', 30, 3, 'rol')]
    expect(latestCorrections(list).map((entry) => entry.id).sort()).toEqual(['b', 'd', 'e'])
  })

  it('replaces each figure by its latest correction, and leaves the closed ones alone', () => {
    const now = effectiveCells(cells, [fact('a', 'ORDINARY', 420, 1), fact('b', 'OVERTIME_DAY', 60, 2), fact('c', 'ABSENCE', 90, 3, 'fer'), fact('d', 'ABSENCE', 15, 4, 'rol')])
    expect(now).toMatchObject({ ordinary: 420, overtimeDay: 60, present: 480 })
    expect([...now.absences]).toEqual([['fer', 90], ['rol', 15]])
    expect(cells.ordinary).toBe(450)
    expect([...cells.absences]).toEqual([['fer', 60]])
    expect(cellOf(now, 'ABSENCE', 'nobody')).toBe(0)
    expect(cellOf(NO_CELLS, 'OVERTIME_HOLIDAY', null)).toBe(0)
  })

  it('counts as a difference only what still differs from the closed calendar', () => {
    expect(differingCells(cells, [])).toEqual([])
    expect(differingCells(cells, [fact('a', 'ORDINARY', 420, 1)])).toEqual([{ kind: 'ORDINARY', absenceCodeId: null, closedMinutes: 450, nowMinutes: 420 }])
    // Corrected and put back: the calendar is right again.
    expect(differingCells(cells, [fact('a', 'ORDINARY', 420, 1), fact('b', 'ORDINARY', 450, 2)])).toEqual([])
    expect(differingCells(cells, [fact('c', 'ABSENCE', 30, 1, 'rol')])).toEqual([{ kind: 'ABSENCE', absenceCodeId: 'rol', closedMinutes: 0, nowMinutes: 30 }])
  })
})

const day = (date: string, more: Partial<LulDay> = {}): LulDay => ({ date, plannedWork: true, presence: true, manual: false, ordinaryMinutes: 470, nightMinutes: 0, holidayMinutes: 0, overtime: { DAY: 0, NIGHT: 0, HOLIDAY: 0 }, absences: [], ...more })
const facts: LulFacts = {
  company: { code: 'A', legalName: 'Pelletteria Fittizia S.r.l.', vatNumber: 'IT00000000000' },
  month: '2026-02',
  closedAt: new Date('2026-03-02T09:00:00.000Z'),
  closedOn: '2026-03-02',
  closedBy: 'Nome Finto',
  people: [
    { employeeCode: 'E1', name: 'Alba Uno', kind: 'EMPLOYEE', days: [day('2026-02-02'), day('2026-02-03', { manual: true, overtime: { DAY: 30, NIGHT: 0, HOLIDAY: 60 }, nightMinutes: 45 }), day('2026-02-04', { ordinaryMinutes: 0, presence: false, absences: [{ code: 'FER', lulCode: null, minutes: 450 }] }), day('2026-02-05', { ordinaryMinutes: 0, presence: false, absences: [{ code: 'MAL', lulCode: 'M1', minutes: 450 }] })] },
    { employeeCode: null, name: 'Bruno Due', kind: 'AGENCY', days: [day('2026-02-02', { plannedWork: false, presence: false, ordinaryMinutes: 0 })] },
  ],
}

describe('the LUL calendar (generic form)', () => {
  it('writes minutes as decimal hours', () => {
    expect(hoursText(450)).toBe('7,50')
    expect(hoursText(470)).toBe('7,83')
    expect(hoursText(5)).toBe('0,08')
    expect(hoursText(0)).toBe('')
  })

  it('has a column per day of the month, one block per person, rest days marked', () => {
    const calendar = lulCalendar(facts)
    expect(calendar.days).toHaveLength(28)
    expect(calendar.days[0]).toEqual({ day: '1', weekday: 'D' })
    expect(calendar.days[1]).toEqual({ day: '2', weekday: 'L' })
    const [alba, bruno] = calendar.blocks
    const ordinary = alba!.rows[0]!
    expect(ordinary.cells).toHaveLength(28)
    expect(ordinary.cells.slice(0, 5)).toEqual(['R', '7,83', '7,83', '', ''])
    expect(bruno!.rows[0]!.cells[1]).toBe('R')
    expect(bruno!.note).toBe('somministrato')
    expect(alba!.title).toBe('Alba Uno (matr. E1)')
    expect(calendar.heading).toBe('Pelletteria Fittizia S.r.l. · febbraio 2026')
    expect(calendar.facts).toEqual(['P. IVA IT00000000000', 'Mese chiuso il 02/03/2026 da Nome Finto', 'Persone: 2'])
    expect(calendar.fileName).toBe('LUL_A_2026-02.pdf')
    expect(calendar.createdAt).toEqual(facts.closedAt)
  })

  it('adds the minutes, never the rounded hours', () => {
    const ordinary = lulCalendar(facts).blocks[0]!.rows[0]!
    // 940 minutes: 15,67; two rounded days would say 15,66.
    expect(ordinary.sum).toBe('15,67')
  })

  it('shows approved overtime by class, night and holiday hours, absences by code and the manual mark', () => {
    const labels = lulCalendar(facts).blocks[0]!.rows.map((row) => row.label)
    expect(labels).toEqual(['Ore ordinarie', 'Straord. diurno', 'Straord. festivo', 'di cui notturne', 'Assenza FER', 'Assenza M1', 'Note'])
    const note = lulCalendar(facts).blocks[0]!.rows.at(-1)!
    expect(note.cells[2]).toBe('M')
    expect(note.cells[1]).toBe('')
  })

  it('prints the consultant\'s code when there is one, ours until then', () => {
    const rows = lulCsvRows(facts)
    expect(rows.filter((row) => row[4] === 'ASSENZA').map((row) => row[5])).toEqual(['FER', 'M1'])
  })

  it('has a CSV of one row per voice with minutes: the same facts give the same text', () => {
    const csv = lulCsv(facts)
    expect(csv.text.startsWith('﻿')).toBe(true)
    expect(csv.text).toContain('formato generico (da confermare con il consulente del lavoro)')
    expect(csv.text).toContain('E1;Alba Uno;EMPLOYEE;2026-02-03;STRAORDINARIO_FESTIVO;;1,00;60;SI')
    expect(csv.rows).toBe(7)
    expect(lulCsv(facts).text).toBe(csv.text)
    expect(csv.fileName).toBe('LUL_A_2026-02.csv')
  })
})

describe('the attendance report', () => {
  it('sums whole days, absences by code', () => {
    const sum = addCells(addCells(emptySum(), cells), { ...cells, absences: new Map([['fer', 30], ['rol', 15]]) })
    expect(sum).toMatchObject({ ordinaryMinutes: 900, presentMinutes: 960, overtimeDayMinutes: 60, absenceMinutes: 105 })
    expect([...sum.absences]).toEqual([['fer', 90], ['rol', 15]])
  })

  it('hides a total that would give away a hidden group (the sum less the groups shown)', () => {
    expect(summaryShown(0, 8, 3)).toBe(true)
    expect(summaryShown(3, 8, 3)).toBe(true)
    expect(summaryShown(2, 8, 3)).toBe(false)
    expect(summaryShown(0, 2, 3)).toBe(false)
  })

  it('says whether it matches the closed LUL', () => {
    expect(matchOf({ closed: false, sealed: false, differing: 0, monthWords: 'October 2026' }).state).toBe('NOT_CLOSED')
    expect(matchOf({ closed: true, sealed: false, differing: 0, monthWords: 'October 2026' }).state).toBe('NOT_SEALED')
    expect(matchOf({ closed: true, sealed: true, differing: 0, monthWords: 'October 2026' })).toEqual({ state: 'MATCHES', cells: 0, words: 'Matches the closed LUL for October 2026.' })
    expect(matchOf({ closed: true, sealed: true, differing: 2, monthWords: 'October 2026' })).toMatchObject({ state: 'DIFFERS', cells: 2 })
  })

  it('counts the gap exactly, negative when it is', () => {
    expect(gapMinutes(1000, '812.500', 37)).toBe('150.500')
    expect(gapMinutes(100, '120.000', 0)).toBe('-20.000')
    expect(coveredPct(1000, '812.500')).toBe('81.3')
    expect(coveredPct(0, '10.000')).toBeNull()
  })
})
