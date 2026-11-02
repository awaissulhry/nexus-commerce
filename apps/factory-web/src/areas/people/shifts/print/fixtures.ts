import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_ROSTER, RANGE } from '../demo/fixtures'
import { RosterPrintView, type RosterPrintModel } from './view/RosterPrintView'

/** SCR-263-print — the roster for the notice board, a page per line, made-up people only. */
const print = (over: Partial<RosterPrintModel> = {}): RosterPrintModel => ({
  person: 'Anna Esempio',
  at: '2026-11-02T09:42:00.000Z',
  company: 'Officina Demo',
  range: RANGE,
  roster: { value: DEMO_ROSTER, problem: null },
  ...over,
})

export const designScreen = defineDesignScreen<RosterPrintModel>({
  screen: 'SCR-263-print',
  title: 'Roster (print, for the notice board)',
  view: RosterPrintView,
  cases: [
    { id: 'week', label: 'A week, a page per line', model: print(), note: 'Drafts are said on top. No overtime, absence or warning on paper: it hangs on a board.' },
    { id: 'published', label: 'Everything published', model: print({ roster: { value: { ...DEMO_ROSTER, rows: DEMO_ROSTER.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => ({ ...cell, entry: cell.entry ? { ...cell.entry, status: 'PUBLISHED' as const } : null })) })) }, problem: null } }) },
    { id: 'empty', label: 'Nobody in this view', model: print({ roster: { value: { ...DEMO_ROSTER, rows: [], footer: [] }, problem: null } }) },
    { id: 'loading', label: 'Loading', model: print({ roster: { value: null, problem: null } }) },
    { id: 'error', label: "The roster couldn't be read", model: print({ roster: { value: null, problem: 'problem.unavailable' } }) },
  ],
})
