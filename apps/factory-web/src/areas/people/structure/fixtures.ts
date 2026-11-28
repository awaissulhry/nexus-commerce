import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { PersonRow, Structure, UnitRecord, UnitRow } from './api'
import { treeOf } from './model'
import { StructureView, type StructureViewModel } from './view/StructureView'

/**
 * owb-ss8 — People › Factory structure with made-up data (design index `/design/SCR-owb-factory-structure`): the owner → a floor with
 * three teams, a quality service beside it, a closed old floor (not drawn), a shared pattern master in no unit yet. The tests read the
 * same data. Made-up names only; no figure about one person's work.
 */

const pic = (kind: 'LETTERS' | 'ICON', icon: string | null, colour: string, letters: string) => ({ kind, icon, colour, letters })
const unit = (id: string, parentId: string | null, name: string, over: Partial<UnitRow> = {}): UnitRow => ({
  id,
  parentId,
  name,
  kindWord: null,
  picture: pic('LETTERS', null, 'slate', ''),
  leader: null,
  takesOrders: false,
  closed: false,
  siteId: 'site-a1',
  people: 0,
  ...over,
})
const person = (employeeId: string, name: string, unitId: string | null, role: string | null, isLeader = false): PersonRow => ({ employeeId, name, unitId, isLeader, role, picture: pic('LETTERS', null, 'slate', '') })

export const UNITS: readonly UnitRow[] = [
  unit('u-top', null, 'Seed Factory A', { kindWord: 'Company', picture: pic('ICON', 'factory', 'emerald', 'SF'), leader: { employeeId: 'e-otto', name: 'Otto Owner' }, people: 1 }),
  unit('u-floor', 'u-top', 'Floor A', { kindWord: 'Group', picture: pic('LETTERS', null, 'blue', 'FA'), leader: { employeeId: 'e-sven', name: 'Sven Supervisor' }, people: 1 }),
  unit('u-quality', 'u-top', 'Quality', { kindWord: 'Service', picture: pic('ICON', 'shield', 'purple', 'QU'), leader: { employeeId: 'e-quinn', name: 'Quinn Quality' }, people: 2 }),
  unit('t-noor', 'u-floor', 'Team Noor', { takesOrders: true, picture: pic('ICON', 'scissors', 'orange', 'TN'), leader: { employeeId: 'e-noor', name: 'Noor Nadir' }, people: 6 }),
  unit('t-kian', 'u-floor', 'Team Kian', { takesOrders: true, picture: pic('ICON', 'shirt', 'cyan', 'TK'), leader: { employeeId: 'e-kian', name: 'Kian Kole' }, people: 2 }),
  unit('t-lia', 'u-floor', 'Team Lia', { takesOrders: true, picture: pic('LETTERS', null, 'violet', 'TL'), people: 1 }),
  unit('u-old', 'u-top', 'Old floor', { closed: true }),
]

export const PEOPLE: readonly PersonRow[] = [
  person('e-otto', 'Otto Owner', 'u-top', 'Owner', true),
  person('e-sven', 'Sven Supervisor', 'u-floor', 'Supervisor', true),
  person('e-quinn', 'Quinn Quality', 'u-quality', 'Quality checker', true),
  person('e-chen', 'Chen Checker', 'u-quality', 'Quality checker'),
  person('e-noor', 'Noor Nadir', 't-noor', 'Team leader', true),
  person('e-omar', 'Omar Ortis', 't-noor', 'Worker'),
  person('e-petra', 'Petra Pane', 't-noor', 'Worker'),
  person('e-wes', 'Wes Weaver', 't-noor', 'Worker'),
  person('e-willa', 'Willa Wool', 't-noor', 'Worker'),
  person('e-wade', 'Wade Wick', 't-noor', 'Worker'),
  person('e-kian', 'Kian Kole', 't-kian', 'Team leader', true),
  person('e-carla', 'Carla Corte', 't-kian', 'Worker'),
  person('e-lia', 'Lia Lunde', 't-lia', 'Worker'),
  person('e-pavel', 'Pavel Pattern', null, 'Pattern master'),
]

export const STRUCTURE: Structure = { units: UNITS, people: PEOPLE, may: { manage: true } }

/** Team Lia's profile as read: one open order, one done. */
export const LIA_RECORD: UnitRecord = {
  ...UNITS.find((each) => each.id === 't-lia')!,
  about: null,
  standIn: null,
  worksFor: [],
  maxBaskets: 8,
  takesNewOrders: false,
  ownFacts: [{ label: 'Room', value: 'B2' }],
  work: [
    { orderId: 'order-105', number: 'SO-2026-0105', customerCode: 'C-BETA', state: 'IN_PRODUCTION' },
    { orderId: 'order-090', number: 'SO-2026-0090', customerCode: 'C-ALPHA', state: 'DELIVERED' },
  ],
  members: PEOPLE.filter((row) => row.unitId === 't-lia'),
  version: 4,
}

const tree = treeOf(UNITS, PEOPLE)
const page = (over: Partial<StructureViewModel> = {}): StructureViewModel => ({ path: '/w/demo/people/structure', state: 'ready', problem: null, tree, manage: true, addPerson: true, view: 'chart', query: '', shut: new Set(), notice: null, ...over })

export const designScreen = defineDesignScreen<StructureViewModel>({
  screen: 'SCR-owb-factory-structure',
  title: 'People › Factory structure — chart and list, find, drag to move (owb-ss8)',
  view: StructureView,
  cases: [
    { id: 'chart', label: 'The owner: the chart (a unit under a unit, a team takes orders), one person in no unit yet', model: page() },
    { id: 'list', label: 'The list (a phone starts with it)', model: page({ view: 'list' }) },
    { id: 'find', label: 'Find "worker": the teams with workers are marked', model: page({ query: 'worker' }) },
    { id: 'shut', label: 'Floor A closed: its teams hidden', model: page({ shut: new Set(['u-floor']) }) },
    { id: 'read-only', label: 'Sales reads it: no buttons, no drag', model: page({ manage: false, addPerson: false }) },
    { id: 'failed', label: 'Not read', model: page({ state: 'failed', tree: null, problem: 'error.offline' }) },
  ],
})
