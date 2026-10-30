import { defineDesignScreen } from '../../../lib/design/design-screen'
import { CalendarGridLabView, type CalendarGridLabModel, type LabDay, type LabKind } from './view/CalendarGridLabView'

/**
 * SCR-245 — the calendar grid (DS part CalendarGrid, B-W2a-24; NEW id: the DS part has no screen of its own; Planning
 * settings › Calendars & shifts SCR-124 uses it, B-W2a-59, on the calendars API of B-W2a-08). A made-up line calendar
 * for 2026: Monday to Friday one shift, the Italian public holidays, the August and Christmas closures, Saturday extra
 * shifts, short days and a line closed for an overhaul. In the browser it works for real (kept in the view only): click
 * or Enter opens a day, a drag or Shift + arrows selects days. Each case is one state of the design.
 */

const holiday = (date: string, it: string, en: string): LabDay => ({ date, kind: 'holiday', reason: { it, en } })
const closure = (dates: readonly string[], it: string, en: string): LabDay[] => dates.map((date) => ({ date, kind: 'closure', reason: { it, en } }))

const HOLIDAYS: LabDay[] = [
  holiday('2026-01-01', 'Capodanno', 'New Year’s Day'),
  holiday('2026-01-06', 'Epifania', 'Epiphany'),
  holiday('2026-04-05', 'Pasqua', 'Easter Sunday'),
  holiday('2026-04-06', 'Lunedì dell’Angelo', 'Easter Monday'),
  holiday('2026-04-25', 'Festa della Liberazione', 'Liberation Day'),
  holiday('2026-05-01', 'Festa del Lavoro', 'Labour Day'),
  holiday('2026-06-02', 'Festa della Repubblica', 'Republic Day'),
  holiday('2026-08-15', 'Ferragosto', 'Assumption Day (Ferragosto)'),
  holiday('2026-11-01', 'Ognissanti', 'All Saints’ Day'),
  holiday('2026-12-08', 'Immacolata Concezione', 'Feast of the Immaculate Conception'),
  holiday('2026-12-25', 'Natale', 'Christmas Day'),
  holiday('2026-12-26', 'Santo Stefano', 'St Stephen’s Day'),
]

const SUMMER = closure(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'], 'Chiusura estiva', 'Summer closure')
const CHRISTMAS = closure(['2026-12-24', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31'], 'Chiusura natalizia', 'Christmas closure')

const EXCEPTIONS: LabDay[] = [
  { date: '2026-08-07', kind: 'short', reason: { it: 'Pomeriggio di inventario', en: 'Inventory afternoon' }, detail: '06:00–11:00' },
  { date: '2026-09-15', kind: 'lineClosed', reason: { it: 'Revisione macchine', en: 'Machine overhaul' } },
  { date: '2026-09-26', kind: 'extra', reason: { it: 'Sabato mattina', en: 'Saturday morning' }, detail: '06:00–12:00' },
  { date: '2026-12-05', kind: 'extra', reason: { it: 'Picco ordini invernali', en: 'Winter order peak' }, detail: '06:00–12:00' },
  { date: '2026-12-16', kind: 'lineClosed', reason: { it: 'Revisione macchine', en: 'Machine overhaul' } },
  { date: '2026-12-23', kind: 'short', reason: { it: 'Auguri di Natale', en: 'Christmas greetings' }, detail: '06:00–12:00' },
]

const ALL: LabDay[] = [...HOLIDAYS, ...SUMMER, ...CHRISTMAS, ...EXCEPTIONS]
const WEEK: LabKind[] = ['work', 'work', 'work', 'work', 'work', 'weekend', 'weekend']

const base = (patch: Partial<CalendarGridLabModel> = {}): CalendarGridLabModel => ({ view: 'month', month: '2026-08', today: '2026-08-04', week: WEEK, days: ALL, load: 'ready', ...patch })

export const designScreen = defineDesignScreen<CalendarGridLabModel>({
  screen: 'SCR-245',
  title: 'Calendar grid (DS part CalendarGrid)',
  view: CalendarGridLabView,
  cases: [
    {
      id: 'month',
      label: 'A month',
      model: base(),
      note: 'August 2026 for Line 2: weekends hatched, Ferragosto cross-hatched, the summer closure, a short day with its hours, today marked in words. Click a day, or Tab into the grid and use the arrows; Enter opens a day.',
    },
    {
      id: 'year',
      label: 'The year',
      model: base({ view: 'year' }),
      note: 'Twelve small months: every public holiday, the August and Christmas closures, Saturday extra shifts, short days, the line closed for an overhaul. The key counts each kind over the year; a month name opens that month.',
    },
    {
      id: 'exceptions',
      label: 'Dated exceptions',
      model: base({ month: '2026-12' }),
      note: 'December 2026: an extra shift on Saturday 5, the Immacolata, the line closed on the 16th, a short day on the 23rd, Christmas, Santo Stefano and the Christmas closure. Each kind has its own pattern, its word and its reason.',
    },
    {
      id: 'range',
      label: 'Days selected',
      model: base({ month: '2026-12', range: { from: '2026-12-28', to: '2026-12-31' } }),
      note: 'Four days selected by a drag across them (or Shift + arrows, then Enter): the screen now asks "Closure from … to …" and shows the lines whose capacity changes. Escape clears the selection.',
    },
    {
      id: 'empty',
      label: 'No calendar yet',
      model: base({ month: '2026-09', days: [], noCalendar: true }),
      note: 'No calendar set for this line: the site default (Monday to Friday, one shift) is drawn and said, never hidden. The list twin says every day follows the weekly pattern.',
    },
    {
      id: 'loading',
      label: 'Loading',
      model: base({ load: 'loading', days: [...SUMMER, HOLIDAYS[7]!] }),
      note: 'The closures are drawn first; the other days are skeletons and the key has no counts until the read is done.',
    },
    { id: 'error', label: 'Read failed', model: base({ load: 'error' }), note: 'A failed read is never drawn as an empty calendar: the reason in words and Try again.' },
    {
      id: 'read-only',
      label: 'No permission (read-only)',
      model: base({ held: 'readOnly' }),
      note: 'Without the Planning settings permission the calendar is drawn the same and days still open; selecting days is refused with the reason, at rest and on every attempt.',
    },
    {
      id: 'list',
      label: 'Phone: the list',
      model: base({ layout: 'list' }),
      note: 'Below 560 px of its own width (also at Phone 390) the calendar becomes this list, which is also the screen-reader twin: the days that differ from the weekly pattern, each with Open.',
    },
  ],
})
