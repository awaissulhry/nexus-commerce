import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { MyProjectRow, MyProjectsModel } from './model'
import { MyProjectsView } from './view/MyProjectsView'

/**
 * SCR-029-projects — Today › My projects (B-TH-252; design PROJ.home-F03, F04). Made-up data only: every name, number and company
 * is invented (Brand Alpha style names).
 */

const id = (n: number) => `0190f0e2-7a11-7000-8000-${String(n).padStart(12, '0')}`
const href = (n: number) => `/w/DEMO/products/projects/${id(n)}`

function row(n: number, extra: Partial<MyProjectRow> & Pick<MyProjectRow, 'number' | 'name' | 'targetDate'>): MyProjectRow {
  return {
    id: id(n),
    party: 'Brand Alpha',
    status: 'ACTIVE',
    target: { tone: 'neutral', phrase: null },
    newForMe: 0,
    muted: false,
    lead: false,
    stale: false,
    href: href(n),
    threadHref: `${href(n)}?thread=new`,
    ...extra,
  }
}

const ROWS: MyProjectRow[] = [
  row(1, { number: 'PRJ-26-012', name: 'FW27 airbag line', targetDate: '2026-11-01', target: { tone: 'danger', phrase: { key: 'target.overdue', params: { count: 16 } } }, lead: true, stale: true }),
  row(2, { number: 'PRJ-26-015', name: 'Leather change across touring jackets', targetDate: '2026-11-20', target: { tone: 'warning', phrase: { key: 'target.soon', params: { count: 3 } } }, newForMe: 3 }),
  row(3, { number: 'PRJ-26-018', name: 'Find a second lining supplier', party: null, targetDate: '2027-01-15', lead: true }),
  row(4, { number: 'PRJ-26-020', name: 'Made-to-measure programme 2027', party: 'Brand Alpha Racing Team', status: 'ON_HOLD', targetDate: '2027-02-28', muted: true }),
]

const ready = (items: readonly MyProjectRow[]): MyProjectsModel['rows'] => ({ status: 'ready', data: { items } })
const base: MyProjectsModel = { rows: ready(ROWS), allHref: '/w/DEMO/products/projects' }

export const designScreen = defineDesignScreen<MyProjectsModel>({
  screen: 'SCR-029-projects',
  title: 'Today › My projects',
  view: MyProjectsView,
  cases: [
    { id: 'normal', label: 'My projects', model: base, note: 'A project I lead past its target and quiet comes first with "close or update it"; then new messages; then by target date.' },
    { id: 'many', label: 'More than eight', model: { ...base, rows: ready(Array.from({ length: 11 }, (_, index) => row(10 + index, { number: `PRJ-26-${String(30 + index).padStart(3, '0')}`, name: `Collection study ${index + 1}`, targetDate: `2027-0${(index % 8) + 1}-15` }))) }, note: 'Eight lines, then "All my projects (11)".' },
    { id: 'none', label: 'In no project (hidden)', model: { ...base, rows: ready([]) }, note: 'The panel is hidden: nothing is drawn.' },
    { id: 'failed', label: 'Could not read', model: { ...base, rows: { status: 'error', problem: 'unavailable' } }, note: 'A failed read is said, with Retry; never an empty panel.' },
  ],
})
