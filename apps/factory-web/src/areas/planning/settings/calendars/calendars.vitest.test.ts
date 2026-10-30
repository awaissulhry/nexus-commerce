import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as printScreen } from '../print/fixtures'
import { chosenSite, manageHeld, settingsCan, settingsHref, tabOf, writeProblem } from '../model'
import { CALENDARS, COMPANY, LANES, LINE_1, LINE_2, LINE_2_CAL, PATTERNS, PLANT_1, SATURDAY, SHORT, SITE_CAL, TWO_SHIFTS, workingTimeOf } from './demo/fixtures'
import { designScreen } from './fixtures'
import { gridDaysOf, kindOfDay, scopeNamer, weekBaseOf, weekKindsOf } from './kinds'
import {
  chainAbove,
  chainOf,
  closureHeld,
  dayDraftOf,
  dayHeld,
  dayPlanOf,
  freeSpans,
  lanesReached,
  ownCalendarOf,
  ownerOfCalendar,
  ownerOfKey,
  ownersOf,
  patternProblems,
  patternsFor,
  rowsMinutes,
  rowsOfPattern,
  segmentsOfRows,
  takenDates,
  weekdaysWords,
  NEW_PATTERN,
} from './model'

const t = (key: string, params?: Readonly<Record<string, string | number>>) => (params ? `${key}(${Object.values(params).join(',')})` : key)
const site = { scope: 'SITE' as const, id: PLANT_1.id }
const line2 = { scope: 'LINE' as const, id: LINE_2.id }

describe('the page: tabs, rights, the site, refusals', () => {
  it('reads the tab and the site from the address; a planner keeps everything, a buyer the items only', () => {
    expect(tabOf('horizon')).toBe('horizon')
    expect(tabOf('nonsense')).toBe('calendars')
    expect(chosenSite([PLANT_1], 'missing')).toBe(PLANT_1)
    expect(settingsHref('/w/DEMO', PLANT_1.id, 'items')).toBe(`/w/DEMO/planning/settings?site=${PLANT_1.id}&tab=items`)
    const buyer = settingsCan(['planning.view', 'planning.items.manage', 'calendars.view', 'calendars.suppliers.manage'])
    expect(manageHeld('items', buyer)).toBeNull()
    expect(manageHeld('calendars', buyer)).toBe('ps.held.calendars')
    expect(manageHeld('horizon', buyer)).toBe('ps.held.settings')
  })

  it('a lost answer is "may or may not be saved", never refused or saved', () => {
    expect(writeProblem(new ApiError('unavailable', 0, 'network', 'x')).unknown).toBe(true)
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x')).conflict).toBe(true)
    expect(writeProblem(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/dayBucketWeeks' }])).field).toBe('dayBucketWeeks')
  })
})

describe('calendar kinds (one key for every Office calendar)', () => {
  const time = workingTimeOf(site)
  const chain = chainOf(time.owner.calendars, CALENDARS)
  const base = weekBaseOf(chain, PATTERNS)

  it('the week comes from the most specific calendar; the pattern from the first that has one', () => {
    expect(chain.map((calendar) => calendar.scope)).toEqual(['SITE', 'COMPANY'])
    expect(base.weekdays).toEqual([1, 2, 3, 4, 5])
    expect(base.pattern?.code).toBe('TWO-SHIFTS')
    expect(base.minutes[1]).toBe(930)
    expect(weekKindsOf(base)).toEqual(['work', 'work', 'work', 'work', 'work', 'off', 'off'])
    expect(weekBaseOf([], PATTERNS).minutes[1]).toBe(480)
  })

  it('a holiday, a closure, a weekend and a plain day', () => {
    const at = (date: string) => time.days.find((day) => day.date === date)!
    expect(kindOfDay(at('2026-08-15'), base, PATTERNS)).toBe('holiday')
    expect(kindOfDay(at('2026-08-12'), base, PATTERNS)).toBe('closure')
    expect(kindOfDay(at('2026-08-16'), base, PATTERNS)).toBe('off')
    expect(kindOfDay(at('2026-08-04'), base, PATTERNS)).toBe('work')
  })

  it('a working exception: extra on a day off or with more minutes, short with fewer, opened with the week’s', () => {
    const line = workingTimeOf(line2)
    const lineBase = weekBaseOf(chainOf(line.owner.calendars, CALENDARS), PATTERNS)
    const at = (date: string) => line.days.find((day) => day.date === date)!
    expect(kindOfDay(at('2026-09-26'), lineBase, PATTERNS)).toBe('extra')
    expect(kindOfDay(at('2026-08-07'), lineBase, PATTERNS)).toBe('short')
    expect(kindOfDay(at('2026-12-08'), lineBase, PATTERNS)).toBe('opened')
    expect(kindOfDay(at('2026-09-15'), lineBase, PATTERNS)).toBe('closure')
  })

  it('the grid days: only what differs from the week, with its name, hours and who decided', () => {
    const line = workingTimeOf(line2)
    const lineChain = chainOf(line.owner.calendars, CALENDARS)
    const grid = gridDaysOf(line.days, weekBaseOf(lineChain, PATTERNS), PATTERNS, { ownCalendarId: LINE_2_CAL.id, scopeName: scopeNamer(lineChain, t), timeZone: 'Europe/Rome', t })
    expect(grid.days['2026-09-02']).toBeUndefined()
    expect(grid.days['2026-09-26']).toEqual({ kind: 'extra', reason: 'Sabato mattina', detail: '06:00–12:00' })
    expect(grid.days['2026-08-12']?.kind).toBe('closure')
    expect(grid.days['2026-08-12']?.detail).toBe('cal.from(Plant 1)')
    expect(grid.days['2026-12-25']?.detail).toBe('cal.from(cal.scope.companyOf(Atelier Demo Srl))')
  })
})

describe('whose calendar', () => {
  it('the picker: the company, the site, its lines and workshops, each with its own calendar or none', () => {
    const options = ownersOf(PLANT_1, 'Atelier Demo Srl', LANES, CALENDARS)
    expect(options.map((option) => option.key.split(':')[0])).toEqual(['COMPANY', 'SITE', 'LINE', 'LINE', 'WORK_CENTRE', 'WORK_CENTRE'])
    expect(options.find((option) => option.id === LINE_2.id)?.calendar?.id).toBe(LINE_2_CAL.id)
    expect(options.find((option) => option.id === LINE_1.id)?.calendar).toBeNull()
    expect(ownerOfCalendar(CALENDARS, LINE_2_CAL.id)).toEqual(line2)
    expect(ownerOfKey(`LINE:${LINE_2.id}`)).toEqual(line2)
    expect(ownerOfKey('SUPPLIER:x')).toBeNull()
  })

  it('a new calendar starts from the calendars above it; a site change reaches every lane, a line only itself', () => {
    expect(chainAbove(CALENDARS, { scope: 'LINE', id: LINE_1.id }, PLANT_1).map((calendar) => calendar.id)).toEqual([SITE_CAL.id, CALENDARS[0]!.id])
    expect(chainAbove(CALENDARS, { scope: 'COMPANY', id: COMPANY }, PLANT_1)).toEqual([])
    expect(lanesReached(site, LANES)).toHaveLength(4)
    expect(lanesReached(line2, LANES).map((lane) => lane.code)).toEqual(['L2'])
    expect(ownCalendarOf(CALENDARS, site)?.id).toBe(SITE_CAL.id)
  })
})

describe('pop:day — a day’s exception', () => {
  const own = LINE_2_CAL && { id: 'd', date: '2026-09-26', kind: 'WORKING' as const, name: 'Sabato mattina', shiftPattern: { id: SATURDAY.id, code: SATURDAY.code, name: SATURDAY.name, status: 'ACTIVE' as const }, note: null, holidaySet: null, version: 1, updatedAt: '' }

  it('opens with the day’s own exception; "as the week" takes it back; an unchanged day saves nothing', () => {
    const draft = dayDraftOf(own, 'extra')
    expect(draft).toEqual({ choice: 'extra', patternId: SATURDAY.id, name: 'Sabato mattina', note: '' })
    expect(dayPlanOf('2026-09-26', draft, own)).toEqual({ action: 'none' })
    expect(dayPlanOf('2026-09-26', { ...draft, choice: 'week' }, own)).toEqual({ action: 'remove' })
    expect(dayPlanOf('2026-09-26', { choice: 'closure', patternId: '', name: 'Fermo', note: '' }, own)).toEqual({
      action: 'set',
      body: { from: '2026-09-26', kind: 'CLOSURE', name: 'Fermo', shiftPatternId: null, note: null, replace: true },
    })
  })

  it('holds Save with the reason: no right, no pattern for an extra shift, no name, nothing changed', () => {
    const none = { choice: 'extra' as const, patternId: '', name: 'Extra', note: '' }
    expect(dayHeld(none, dayPlanOf('2026-11-03', none, null), false, false)).toBe('ps.held.calendars')
    expect(dayHeld(none, dayPlanOf('2026-11-03', none, null), true, false)).toBe('cal.day.held.pattern')
    const unnamed = { choice: 'holiday' as const, patternId: '', name: '  ', note: '' }
    expect(dayHeld(unnamed, dayPlanOf('2026-11-03', unnamed, null), true, false)).toBe('cal.day.held.name')
    expect(dayHeld({ choice: 'week', patternId: '', name: '', note: '' }, { action: 'none' }, true, false)).toBe('cal.day.held.same')
  })

  it('offers for an extra shift only patterns with more time that weekday, for a short day only fewer', () => {
    const base = weekBaseOf([SITE_CAL], PATTERNS)
    expect(patternsFor('extra', 6, base, PATTERNS).map((pattern) => pattern.code)).toEqual(['ONE-SHIFT', 'TWO-SHIFTS', 'SAT-MORNING', 'SHORT-DAY'])
    // A pattern with no shift that weekday works its first weekday with shifts (the service's rule): Saturday morning is short on a Tuesday.
    expect(patternsFor('short', 2, base, PATTERNS).map((pattern) => pattern.code)).toEqual(['ONE-SHIFT', 'SAT-MORNING', 'SHORT-DAY'])
    expect(patternsFor('extra', 2, base, PATTERNS)).toEqual([])
    expect(SHORT.weeklyMinutes).toBe(1500)
  })
})

describe('pop:closure — over several calendars', () => {
  const draft = { from: '2026-12-21', to: '2026-12-23', reason: 'Inventario', targets: [`SITE:${PLANT_1.id}` as const], taken: [], takenChoice: null }

  it('holds Add until the days, a reason and a calendar are given, and the days already set are decided', () => {
    expect(closureHeld(draft, true, false)).toBeNull()
    expect(closureHeld({ ...draft, to: '2026-12-20' }, true, false)).toBe('cal.closure.held.order')
    expect(closureHeld({ ...draft, reason: '' }, true, false)).toBe('cal.closure.held.reason')
    expect(closureHeld({ ...draft, targets: [] }, true, false)).toBe('cal.closure.held.where')
    expect(closureHeld({ ...draft, from: '2026-01-01', to: '2027-01-02' }, true, false)).toBe('cal.closure.held.long')
    expect(closureHeld({ ...draft, taken: ['2026-12-22'] }, true, false)).toBe('cal.closure.held.taken')
    expect(closureHeld({ ...draft, taken: ['2026-12-22'], takenChoice: 'keep' }, true, false)).toBeNull()
    expect(closureHeld(draft, false, false)).toBe('ps.held.calendars')
  })

  it('reads the days a 409 names, and closes the other days around them', () => {
    const error = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/days/2026-12-08' }, { path: 'body.days.2026-12-10' }])
    expect(takenDates(error)).toEqual(['2026-12-08', '2026-12-10'])
    expect(takenDates(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual([])
    expect(freeSpans('2026-12-07', '2026-12-11', ['2026-12-08', '2026-12-10'])).toEqual([
      { from: '2026-12-07', to: '2026-12-07' },
      { from: '2026-12-09', to: '2026-12-09' },
      { from: '2026-12-11', to: '2026-12-11' },
    ])
    expect(freeSpans('2026-12-07', '2026-12-08', ['2026-12-07', '2026-12-08'])).toEqual([])
  })
})

describe('the shift pattern editor', () => {
  it('groups the API’s segments (one per weekday) into rows and back, the same segments', () => {
    const rows = rowsOfPattern(TWO_SHIFTS)
    expect(rows.map((row) => `${row.kind} ${row.label} ${row.days.join('')} ${row.start}-${row.end}`)).toEqual([
      'SHIFT Morning 12345 06:00-14:00',
      'SHIFT Afternoon 12345 14:00-22:00',
      'BREAK  12345 10:00-10:15',
      'BREAK  12345 18:00-18:15',
    ])
    const { segments } = segmentsOfRows(rows)
    const key = (segment: { weekday: number; kind: string; startMinute: number; endMinute: number }) => `${segment.weekday}${segment.kind}${segment.startMinute}-${segment.endMinute}`
    expect(segments.map(key).sort()).toEqual(TWO_SHIFTS.segments.map(key).sort())
    expect(rowsMinutes(rows)[1]).toBe(930)
  })

  it('a night shift ends the next morning; its break after midnight is in the night', () => {
    const { segments } = segmentsOfRows([
      { days: [1], kind: 'SHIFT', label: 'Night', start: '22:00', end: '06:00' },
      { days: [1], kind: 'BREAK', label: '', start: '02:00', end: '02:30' },
    ])
    expect(segments).toEqual([
      { weekday: 1, kind: 'SHIFT', label: 'Night', startMinute: 1320, endMinute: 1800 },
      { weekday: 1, kind: 'BREAK', label: null, startMinute: 1560, endMinute: 1590 },
    ])
  })

  it('says what is wrong at its row before anything is sent', () => {
    const draft = { ...NEW_PATTERN, code: 'NIGHT', name: 'Night', rows: [{ days: [1, 2], kind: 'SHIFT' as const, label: '', start: '22:00', end: '06:00' }, { days: [2], kind: 'SHIFT' as const, label: '', start: '05:00', end: '13:00' }] }
    expect(patternProblems(draft, []).map((problem) => `${problem.row}:${problem.key}`)).toEqual(['0:cal.pattern.problem.overlap'])
    expect(patternProblems({ ...draft, code: 'two shifts' }, []).some((problem) => problem.key === 'cal.pattern.problem.code')).toBe(true)
    expect(patternProblems({ ...draft, code: 'TWO-SHIFTS' }, ['TWO-SHIFTS']).some((problem) => problem.key === 'cal.pattern.problem.codeTaken')).toBe(true)
    expect(patternProblems({ ...NEW_PATTERN, code: 'X', name: 'X', rows: [{ days: [], kind: 'SHIFT', label: '', start: '8:00', end: 'x' }] }, []).map((problem) => problem.key)).toEqual([
      'cal.pattern.problem.days',
      'cal.pattern.problem.time',
    ])
    expect(patternProblems({ ...NEW_PATTERN, code: 'ONE', name: 'One' }, [])).toEqual([])
  })

  it('says weekdays in words', () => {
    const name = (day: number) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day]!
    expect(weekdaysWords([5, 1, 2, 3, 4], name, { to: 'to', and: 'and' })).toBe('Mon to Fri')
    expect(weekdaysWords([1, 3, 5], name, { to: 'to', and: 'and' })).toBe('Mon, Wed and Fri')
    expect(weekdaysWords([6], name, { to: 'to', and: 'and' })).toBe('Sat')
  })
})

const draw = (screen: typeof designScreen | typeof printScreen, locale: 'it' | 'en', id: string) => {
  const found = screen.cases.find((item) => item.id === id)!
  return render(h(I18nProvider, { locale, messages: {} }, h(screen.view as never, { model: found.model })))
}

describe('SCR-124 and SCR-124-print design cases', () => {
  it('every state the design names is a case', () => {
    expect(designScreen.screen).toBe('SCR-124')
    for (const id of ['site-month', 'site-year', 'line-own', 'line-follows', 'company', 'day', 'closure', 'closure-taken', 'pattern', 'no-calendar', 'loading', 'error', 'changed', 'read-only']) expect(designScreen.cases.some((item) => item.id === id), id).toBe(true)
    expect(printScreen.cases.map((item) => item.id)).toEqual(['year', 'site-only', 'loading', 'error'])
  })

  it('draws every case in Italian and English with no message key on screen', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const item of [...designScreen.cases, ...printScreen.cases]) {
        const out = draw(designScreen.cases.includes(item as never) ? designScreen : printScreen, locale, item.id)
        expect(out, `${locale} ${item.id}`).not.toMatch(/\b(ps|cal|print)\.[a-zA-Z]+\.[a-zA-Z]/)
      }
    }
  })

  it('says the words of the design', () => {
    const it = draw(designScreen, 'it', 'site-month')
    expect(it).toContain('Calendario di')
    expect(it).toContain('Ricalcola subito la capacità')
    expect(it).toContain('Schemi di turni')
    expect(it).toContain('Chiusura estiva')
    expect(draw(designScreen, 'en', 'line-follows')).toContain('Line 1 follows the calendars above')
    expect(draw(designScreen, 'en', 'no-calendar')).toContain('the site default (Monday to Friday, one shift 08:00–17:00) is used until you set one')
    expect(draw(designScreen, 'en', 'read-only')).toContain('Keeping calendars needs the Calendars right')
    expect(draw(designScreen, 'en', 'error')).toContain('Try again')
    const print = draw(printScreen, 'en', 'year')
    expect(print).toContain('Plant calendar 2026 — P1 · Plant 1')
    expect(print).toContain('Holidays, closures and exceptions')
    expect(print).toContain('Ferragosto')
    expect(print).toContain('Lines and workshops that differ')
    expect(print).toContain('Revisione macchine')
  })
})
