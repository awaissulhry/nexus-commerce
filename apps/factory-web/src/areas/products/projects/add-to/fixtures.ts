import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { AddToProjectModel, ProjectChoice } from './model'
import { AddToProjectDialog } from './view/AddToProjectDialog'

/**
 * SCR-701-addto — "Add to project" from the Styles and the Samples & prototypes lists (B-TH-251; design X-PRD-STY-LIST.grid,
 * X-PRD-SMP-LIST.grid), made-up data only: the open projects to pick (an outside company or Office only, one on hold), one picked
 * with a note, none open, reading, a failed read, a closed project refused, offline, and the answer in words — all linked, or some
 * skipped with why (another outside company's row: words that name neither company).
 */

const PROJECTS: ProjectChoice[] = [
  { id: '00000000-0000-4000-8000-0000000d0001', number: 'PRJ-26-012', name: 'FW27 airbag line', party: 'Brand Alpha', status: 'ACTIVE' },
  { id: '00000000-0000-4000-8000-0000000d0002', number: 'PRJ-26-014', name: 'Leather change across the touring jackets', party: 'Brand Alpha', status: 'ON_HOLD' },
  { id: '00000000-0000-4000-8000-0000000d0003', number: 'PRJ-26-015', name: 'Airbag pocket R&D', party: null, status: 'ACTIVE' },
]

const STYLES = [
  { id: '00000000-0000-4000-8000-0000000e0001', number: 'AX-100' },
  { id: '00000000-0000-4000-8000-0000000e0002', number: 'AX-101' },
  { id: '00000000-0000-4000-8000-0000000e0003', number: 'AX-102' },
]

const model = (over: Partial<AddToProjectModel> = {}): AddToProjectModel => ({
  kind: 'Style',
  records: STYLES,
  q: '',
  projects: { status: 'ready', items: PROJECTS },
  picked: null,
  note: '',
  busy: false,
  problem: null,
  result: null,
  offline: false,
  ...over,
})

const PROJECT = { number: 'PRJ-26-012', name: 'FW27 airbag line', href: '/w/DEMO/products/projects/00000000-0000-4000-8000-0000000d0001' }

export const designScreen = defineDesignScreen<AddToProjectModel>({
  screen: 'SCR-701-addto',
  title: 'Add to project (Styles, Samples)',
  view: AddToProjectDialog,
  cases: [
    { id: 'pick', label: 'Pick a project', model: model(), note: 'Open projects only: an outside company or Office only; one on hold says so.' },
    { id: 'picked', label: 'A project picked, with a note', model: model({ picked: PROJECTS[0]!.id, note: 'The FW27 line’s jackets.' }) },
    { id: 'rounds', label: 'Sample rounds', model: model({ kind: 'SampleRound', records: [{ id: '00000000-0000-4000-8000-0000000e0011', number: 'SR-0042' }] }) },
    { id: 'searched-none', label: 'No open project matches', model: model({ q: 'winter', projects: { status: 'ready', items: [] } }) },
    { id: 'none-open', label: 'No open project yet', model: model({ projects: { status: 'ready', items: [] } }) },
    { id: 'loading', label: 'Reading the open projects', model: model({ projects: { status: 'loading' } }) },
    { id: 'failed', label: 'The projects could not be read', model: model({ projects: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'refused-closed', label: 'Refused: the project was closed meanwhile', model: model({ picked: PROJECTS[0]!.id, problem: { key: 'refusal.CLOSED' } }) },
    { id: 'offline', label: 'Offline', model: model({ picked: PROJECTS[0]!.id, offline: true }) },
    { id: 'done-all', label: 'Done: all linked', model: model({ result: { linked: 3, skipped: [], project: PROJECT } }) },
    {
      id: 'done-skipped',
      label: 'Done: some skipped, with why',
      model: model({
        records: [...STYLES, { id: '00000000-0000-4000-8000-0000000e0004', number: 'ZX-900' }, { id: '00000000-0000-4000-8000-0000000e0005', number: 'AX-099' }],
        result: { linked: 3, skipped: [{ number: 'ZX-900', reason: { key: 'addTo.skip.LINK_PARTY' } }, { number: 'AX-099', reason: { key: 'addTo.skip.ALREADY_LINKED' } }], project: PROJECT },
      }),
      note: 'Another outside company’s style is skipped in words that name neither company.',
    },
  ],
})
