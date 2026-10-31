import { createElement } from 'react'
import { defineDesignScreen } from '../../lib/design/design-screen'
import { LAB_ROWS } from '../../list-frame/fixtures'
import { ListFrameLab, type ListFrameLabModel } from '../../list-frame/lab/ListFrameLab'
import { DEMO_COMPANIES, DEMO_SITES, DEMO_USER } from '../design-data'
import { PrintModeProvider } from './print-mode'
import { PrintFrameView, type PrintFrameModel } from './view/PrintFrameView'

/**
 * SCR-232-print — "Print this view" (B-W2b-05, PLT-171; design shell.lists tab:print-view): any Office list in its print
 * view, a new tab opened from the band's Print. The paper's head (company, site, place, who printed it and when), then
 * the list frame for paper: every loaded row, no checkboxes, no menus, no footer. Made-up rows (the list frame's lab).
 */

interface PrintViewCase {
  frame: PrintFrameModel
  list: ListFrameLabModel
}

const frame = (over: Partial<PrintFrameModel> = {}): PrintFrameModel => ({
  kind: 'view',
  company: { name: DEMO_COMPANIES[0].name, code: DEMO_COMPANIES[0].code },
  site: { kind: 'site', name: DEMO_SITES[0].name },
  place: 'Sales › Customers',
  printedBy: DEMO_USER.displayName,
  printedAt: new Date(Date.UTC(2026, 9, 31, 9, 42)).toISOString(),
  backHref: '/w/DEMO/sales/customers?status=ACTIVE',
  ...over,
})

function PrintViewDesign({ model }: { model: PrintViewCase }) {
  return createElement(PrintModeProvider, { printing: true }, createElement(PrintFrameView, { model: model.frame }, createElement(ListFrameLab, { model: model.list })))
}

export const designScreen = defineDesignScreen<PrintViewCase>({
  screen: 'SCR-232-print',
  title: 'Print this view (any list)',
  view: PrintViewDesign,
  cases: [
    {
      id: 'normal',
      label: 'A list on one site',
      model: { frame: frame(), list: { rows: LAB_ROWS, total: LAB_ROWS.length, selected: [] } },
      note: 'On screen: Print and Back to the view (never on paper). On paper: the head, every loaded row, page numbers at the foot.',
    },
    {
      id: 'all-sites',
      label: 'All sites, more rows than loaded',
      model: { frame: frame({ site: { kind: 'all', limited: false } }), list: { rows: LAB_ROWS.slice(0, 8), total: 132, selected: [], more: true } },
      note: 'The count says "8 of 132": the print view prints the rows loaded, and says how many there are.',
    },
    {
      id: 'selected-ignored',
      label: 'Rows were selected on screen',
      model: { frame: frame({ site: null }), list: { rows: LAB_ROWS, total: LAB_ROWS.length, selected: LAB_ROWS.slice(0, 3).map((row) => row.id) } },
      note: 'Paper has no checkboxes and no bulk actions: the selection is not drawn.',
    },
    {
      id: 'empty',
      label: 'Nothing matches',
      model: { frame: frame(), list: { rows: [], total: 0, selected: [], state: 'no-match' } },
    },
    {
      id: 'failed',
      label: 'The list could not be read',
      model: { frame: frame(), list: { rows: null, total: null, selected: [], state: 'failed' } },
      note: 'The page says why in its own words; nothing prints that was not read.',
    },
  ],
})
