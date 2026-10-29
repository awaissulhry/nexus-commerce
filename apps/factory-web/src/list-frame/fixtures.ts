import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../lib/design/design-screen'
import { permissionCheck } from '../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../shell/design-data'
import { officeNavFor } from '../shell/nav/office-nav'
import { OfficeShellView } from '../shell/office/view/OfficeShellView'
import { ListFrameLab, type LabRow, type ListFrameLabModel } from './lab/ListFrameLab'

/**
 * The list frame's lab (`/design/list-frame`, Owner rule 2026-10-29): made-up records ("Demo …", invented codes) in the
 * ONE frame every Office list uses. Each case is a starting state; in the browser the ticks, the header box, shift-click,
 * j / k / x / Enter / ? and the footer's keys icon work for real. Light and dark, 1440 and 390, English and Italian are
 * the gallery's own switches.
 */

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 9, 0)).toISOString()
const NAMES = ['Demo Alfa', 'Demo Beta', 'Demo Gamma', 'Demo Delta', 'Demo Epsilon', 'Demo Zeta', 'Demo Eta', 'Demo Theta', 'Demo Iota', 'Demo Kappa', 'Demo Lambda', 'Demo Mu']
const STATUSES: LabRow['status'][] = ['ACTIVE', 'ACTIVE', 'PROSPECT', 'ACTIVE', 'BLOCKED', 'ACTIVE', 'PROSPECT', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'PROSPECT', 'ACTIVE']
const COUNTRIES = ['IT', 'DE', 'FR', 'IT', 'AT', 'ES', 'IT', 'PT', 'IT', 'NL', 'IT', 'BE']
export const LAB_ROWS: LabRow[] = NAMES.map((name, index) => ({
  id: `0190f0e2-abab-7000-8000-${String(index + 1).padStart(12, '0')}`,
  code: `DEMO-${String(index + 1).padStart(3, '0')}`,
  name: `${name} S.r.l.`,
  status: STATUSES[index]!,
  country: COUNTRIES[index]!,
  updatedAt: at(28 - index),
}))
const ids = (...indexes: number[]) => indexes.map((index) => LAB_ROWS[index]!.id)

/** The Office shell around the lab (the owner's navigation, Home › Mail to sort's place): the frame as a page sees it. */
function inShellPage(page: ReactNode): ReactNode {
  const path = '/home/mail-to-sort'
  return createElement(
    OfficeShellView,
    {
      model: {
        nav: officeNavFor(permissionCheck(OWNER_PERMISSIONS)),
        path,
        switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
        user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
        tenantTag: DEMO_TAG,
        banners: [],
      },
    },
    page,
  )
}

const lab = (over: Partial<ListFrameLabModel> = {}): ListFrameLabModel => ({ rows: LAB_ROWS, total: LAB_ROWS.length, selected: [], ...over })

function ListFrameDesign({ model }: { model: ListFrameLabModel }) {
  return inShellPage(createElement(ListFrameLab, { model }))
}

export const designScreen = defineDesignScreen<ListFrameLabModel>({
  screen: 'list-frame',
  title: 'List frame (every Office list)',
  view: ListFrameDesign,
  cases: [
    {
      id: 'none-selected',
      label: 'Nothing selected: count, search, keys icon in the footer',
      model: lab(),
      note: 'Tick a row: the toolbar swaps to the bulk actions. Shift-click a second box: the range between them.',
    },
    { id: 'some-selected', label: 'Some selected: the header box is mixed, the bulk actions say their reach', model: lab({ selected: ids(1, 3, 4) }) },
    { id: 'all-selected', label: 'Every loaded row selected', model: lab({ selected: LAB_ROWS.map((row) => row.id) }) },
    { id: 'more-pages', label: 'More pages: Show 50 more in the footer', model: lab({ total: 132, more: true }) },
    { id: 'live-updates', label: 'Live: 3 updates waiting behind Show', model: lab({ updates: 3 }) },
    { id: 'keys-open', label: 'The footer keys icon, open', model: lab({ keysOpen: true }) },
    { id: 'keyboard', label: 'Keyboard: a focused row (j / k move it, x ticks it, Enter opens)', model: lab({ focusRow: 2, selected: ids(2) }) },
    { id: 'help', label: '? opens the full shortcut list', model: lab({ helpOpen: true }) },
    { id: 'read-only', label: 'A read-only list: no checkboxes, the same frame', model: lab({ readOnly: true }) },
    { id: 'row-locked', label: 'Rows that may not be selected: their box is disabled and says why', model: lab({ blockedLocked: true, selected: ids(1) }), note: 'isRowSelectable: the header box and x skip them.' },
    { id: 'loading', label: 'Loading', model: lab({ rows: null, total: null }) },
    { id: 'failed', label: 'The read failed (never drawn as empty)', model: lab({ state: 'failed' }) },
    { id: 'empty', label: 'Nothing yet', model: lab({ rows: [], total: 0, state: 'empty' }) },
    { id: 'no-match', label: 'No rows match these filters', model: lab({ rows: [], total: 0, state: 'no-match' }) },
  ],
})
