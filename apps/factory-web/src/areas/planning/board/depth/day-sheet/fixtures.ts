import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { PAPER } from '../../fixtures'
import type { DaySheetPaper } from '../api'
import { DaySheetView } from '../view/DaySheetView'

/**
 * SCR-407 — Day sheet per line (NEW id, B-W2b-337; design planning.board tab:day-sheets "A document to print for each line
 * leader"): what the PDF says, sheet by sheet (B-W2b-329's paper: the published version the floor works to that day, or the
 * working plan with its banner). The PDF itself is the API's, opened in a new tab from Print day sheets; this preview is the
 * same one the print dialog shows. Made-up site, lines and work orders; the sheets in Italian and in English.
 */

const ENGLISH: DaySheetPaper = {
  ...PAPER,
  language: 'en',
  title: 'Day sheets',
  columns: ['Start', 'End', 'Work order', 'Style', 'Operation', 'Pieces', 'Min', 'Due', 'Status', 'Done'],
  sheets: PAPER.sheets.map((sheet, index) => ({
    ...sheet,
    heading: index === 0 ? 'Line L1 · Linea 1' : 'Line L2 · Linea 2',
    facts: [
      { label: 'Site', value: 'ST1 · Stabilimento Esempio' },
      { label: 'Day', value: 'Tue 17 Nov 2026' },
      { label: 'Plan', value: 'v3, published 2026-11-12 17:30' },
    ],
    rows: sheet.rows.map((row) => ({ ...row, cells: ['08:00', '16:00 (Wed 18)', 'WO-0101', 'MOD-001 Giacca Aero', 'Op 20 Cucito', '120', '3600', '27 Nov', 'Running 30/120', ''] })),
    empty: sheet.empty ? 'Nothing planned on this line that day.' : null,
    footer: index === 0 ? 'Total: 120 pieces · 3600 min · load 58.8% (1800 / 3060 min)' : 'Total: 0 pieces · 0 min · load 0% (0 / 2160 min)',
  })),
  foot: 'Printed from the planning board · Stabilimento Esempio',
  pageLabel: 'Page',
  fileName: 'day-sheets-2026-11-17.pdf',
}

const WORKING: DaySheetPaper = { ...PAPER, sheets: PAPER.sheets.map((sheet) => ({ ...sheet, banner: 'Piano di lavoro, non ancora pubblicato: il reparto lavora con la v3.' })) }

export const designScreen = defineDesignScreen<DaySheetPaper>({
  screen: 'SCR-407',
  title: 'Day sheet per line (PDF)',
  view: DaySheetView,
  cases: [
    { id: 'published', label: 'Sheets in Italian, the published version', model: PAPER, note: 'A sheet per line: heading, site, day and plan, the bars in start order with an empty Done column, the footer with the line’s load; a line with nothing planned says so.' },
    { id: 'english', label: 'Sheets in English', model: ENGLISH, note: 'The sheets’ language is picked in Print day sheets, apart from the page’s.' },
    { id: 'working', label: 'The working plan, with its banner', model: WORKING },
  ],
})
