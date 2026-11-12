import { createElement, type ReactNode } from 'react'
import type { ProductionStrategy } from '@nexus/factory-domain/planning/strategy/rules'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../shell/design-data'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { SITES } from '../board/fixtures'
import type { StrategyBulk, StrategyItem, StrategyRow } from './api'
import { controlsOf, mpsCan, type MpsControls } from './model'
import type { BulkState, MpsModel, StrategyPage } from './view-model'
import { MpsView } from './view/MpsView'

/**
 * SCR-202 Master schedule & S&OP (its W2b part, the production strategy per item) with made-up data: an invented site, finished
 * garments ("JKT-DEMO-07-NER-50 Giacca Demo Strada nero 50"), components ("CMP-DEMO-500 Paraschiena Demo"), an invented planner
 * ("Marta Esempio"). Nothing here is a real company, item, person or number. Drawn inside the Office shell with the role's
 * navigation; the role decides what is held.
 */

const uid = (block: string, n: number) => `0190f0e5-${block}-7000-8000-${String(n).padStart(12, '0')}`
const SITE = SITES[0]!
const AS_OF = '2026-11-12T08:42:00.000Z'
const PLANNER_PERSON = { id: uid('3333', 1), name: 'Marta Esempio' }
const JKT07 = { id: uid('6161', 1), code: 'JKT-DEMO-07', name: 'Giacca Demo Strada' }
const NERO = { id: uid('7272', 1), code: 'NER', name: 'Nero' }
const ROSSO = { id: uid('7272', 2), code: 'ROS', name: 'Rosso' }

function rowOf(n: number, strategy: ProductionStrategy, over: Partial<StrategyRow> = {}): StrategyRow {
  return { itemPlanningId: uid('5151', n), colour: null, stored: strategy, strategy, version: 3, lastChange: null, ...over }
}

function item(over: Partial<StrategyItem> & Pick<StrategyItem, 'item'>): StrategyItem {
  return { sku: null, strategy: 'MAKE_TO_ORDER', set: false, rows: [], lastChange: null, ...over }
}

const change = (from: ProductionStrategy, to: ProductionStrategy, reason: string | null, day = 10) => ({ at: `2026-11-${String(day).padStart(2, '0')}T09:15:00.000Z`, by: PLANNER_PERSON, from, to, reason })

const SKU = (colour: typeof NERO, size: string) => ({ sku: `JKT-DEMO-07-${colour.code}-${size}`, style: JKT07, colourway: colour, size })
const ITEMS: StrategyItem[] = [
  item({
    item: { id: uid('8181', 1), code: 'CMP-DEMO-500', name: 'Paraschiena Demo livello 2', kind: 'COMPONENT' },
    strategy: 'ASSEMBLE_TO_ORDER',
    set: true,
    rows: [rowOf(1, 'ASSEMBLE_TO_ORDER', { lastChange: change('MAKE_TO_ORDER', 'ASSEMBLE_TO_ORDER', 'Kept ready: the backs go in every racing suit (made up).') })],
    lastChange: change('MAKE_TO_ORDER', 'ASSEMBLE_TO_ORDER', 'Kept ready: the backs go in every racing suit (made up).'),
  }),
  item({ item: { id: uid('8181', 2), code: 'CMP-DEMO-510', name: 'Protezione gomito Demo', kind: 'COMPONENT' } }),
  item({
    item: { id: uid('8181', 3), code: 'JKT-DEMO-07-NER-50', name: 'Giacca Demo Strada nero 50', kind: 'FINISHED' },
    sku: SKU(NERO, '50'),
    strategy: 'MAKE_TO_STOCK',
    set: true,
    rows: [rowOf(3, 'MAKE_TO_STOCK', { lastChange: change('MAKE_TO_ORDER', 'MAKE_TO_STOCK', 'Best seller: we keep a few ready (made up).', 9) })],
    lastChange: change('MAKE_TO_ORDER', 'MAKE_TO_STOCK', 'Best seller: we keep a few ready (made up).', 9),
  }),
  item({
    item: { id: uid('8181', 4), code: 'JKT-DEMO-07-NER-52', name: 'Giacca Demo Strada nero 52', kind: 'FINISHED' },
    sku: SKU(NERO, '52'),
    strategy: 'MAKE_TO_STOCK',
    set: true,
    rows: [rowOf(4, 'MAKE_TO_STOCK', { lastChange: change('MAKE_TO_ORDER', 'MAKE_TO_STOCK', null, 9) })],
    lastChange: change('MAKE_TO_ORDER', 'MAKE_TO_STOCK', null, 9),
  }),
  item({ item: { id: uid('8181', 5), code: 'JKT-DEMO-07-ROS-50', name: 'Giacca Demo Strada rosso 50', kind: 'FINISHED' }, sku: SKU(ROSSO, '50') }),
  item({
    item: { id: uid('8181', 6), code: 'CMP-DEMO-520', name: 'Imbottitura spalla Demo', kind: 'COMPONENT' },
    strategy: 'MAKE_TO_ORDER',
    set: true,
    rows: [rowOf(6, 'MAKE_TO_ORDER'), rowOf(7, 'MAKE_TO_STOCK', { colour: NERO, version: 1 })],
    lastChange: null,
  }),
  item({ item: { id: uid('8181', 7), code: 'PNT-DEMO-03-NER-M', name: 'Pantalone Demo nero M', kind: 'FINISHED' }, sku: { sku: 'PNT-DEMO-03-NER-M', style: { id: uid('6161', 3), code: 'PNT-DEMO-03', name: 'Pantalone Demo' }, colourway: NERO, size: 'M' } }),
]
const MANY: StrategyItem[] = Array.from({ length: 36 }, (_, index) =>
  item({
    item: { id: uid('8282', index + 1), code: `JKT-DEMO-${String(20 + index).padStart(2, '0')}-NER-50`, name: `Giacca Demo ${index + 1} nero 50`, kind: 'FINISHED' },
    sku: { sku: `JKT-DEMO-${String(20 + index).padStart(2, '0')}-NER-50`, style: { id: uid('6262', index + 1), code: `JKT-DEMO-${String(20 + index).padStart(2, '0')}`, name: `Giacca Demo ${index + 1}` }, colourway: NERO, size: '50' },
    ...(index % 5 === 0 ? { strategy: 'MAKE_TO_STOCK' as const, set: true, rows: [rowOf(200 + index, 'MAKE_TO_STOCK')], lastChange: change('MAKE_TO_ORDER', 'MAKE_TO_STOCK', null) } : {}),
  }),
)

const pageOf = (items: readonly StrategyItem[], nextCursor: string | null = null): StrategyPage => ({ items: [...items], nextCursor, more: 'idle', asOf: AS_OF })

export interface MpsCase {
  model: MpsModel
  permissions: readonly string[]
}

function inShell(page: ReactNode, permissions: readonly string[]): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path: '/planning/mps',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/planning/mps' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

function MpsDesign({ model }: { model: MpsCase }) {
  return inShell(createElement(MpsView, { model: model.model }), model.permissions)
}

const PLANNER = rolePermissions('planner')
const BASE: MpsControls = { ...controlsOf(null), site: SITE.id }

function make(over: Partial<Omit<MpsModel, 'controls'>> & { controls?: Partial<MpsControls> } = {}, permissions: readonly string[] = PLANNER): MpsCase {
  const { controls, ...rest } = over
  return {
    permissions,
    model: {
      prefix: '/w/DEMO',
      can: mpsCan(permissions),
      sites: { status: 'ready', value: [SITE] },
      siteId: SITE.id,
      list: { status: 'ready', value: pageOf(ITEMS) },
      marks: {},
      bulk: null,
      notice: null,
      live: 'live',
      updates: 0,
      dialog: null,
      timeZone: 'Europe/Rome',
      ...rest,
      controls: { ...BASE, ...(controls ?? {}) },
    },
  }
}

const PICKED = [ITEMS[1]!, ITEMS[4]!, ITEMS[3]!]
const bulk = (over: Partial<BulkState> = {}): BulkState => ({ ids: PICKED.map((entry) => entry.item.id), next: 'MAKE_TO_STOCK', reason: '', phase: 'ready', items: PICKED, answer: null, problem: null, undoing: false, undone: false, ...over })
const ANSWER: StrategyBulk = {
  changes: [
    { index: 0, itemId: ITEMS[1]!.item.id, itemColourId: null, change: 'CREATED', from: 'MAKE_TO_ORDER', to: 'MAKE_TO_STOCK', row: rowOf(301, 'MAKE_TO_STOCK', { version: 1 }) },
    { index: 1, itemId: ITEMS[4]!.item.id, itemColourId: null, change: 'CREATED', from: 'MAKE_TO_ORDER', to: 'MAKE_TO_STOCK', row: rowOf(302, 'MAKE_TO_STOCK', { version: 1 }) },
  ],
  changed: 2,
  replayed: false,
}

export const designScreen = defineDesignScreen<MpsCase>({
  screen: 'SCR-202',
  title: 'Master schedule & S&OP',
  view: MpsDesign,
  cases: [
    { id: 'planner', label: 'The planner: production strategy per item', model: make(), note: 'Each Strategy cell saves by itself; an item never set is make to order by default; the reason and the last change come from the audit.' },
    { id: 'saving', label: 'A cell saving', model: make({ marks: { [ITEMS[4]!.item.id]: { state: 'saving' } } }) },
    { id: 'saved', label: 'A cell saved', model: make({ marks: { [ITEMS[1]!.item.id]: { state: 'saved' } } }) },
    { id: 'refused', label: 'A cell refused: changed by someone else since it was read', model: make({ marks: { [ITEMS[3]!.item.id]: { state: 'refused', problem: 'refusal.changed' } } }) },
    { id: 'refused-item', label: 'A cell refused: the item cannot take a strategy (in words)', model: make({ marks: { [ITEMS[6]!.item.id]: { state: 'refused', problem: 'refusal.item' } } }) },
    { id: 'filter-mts', label: 'Filter: make to stock', model: make({ controls: { strategy: 'MAKE_TO_STOCK' }, list: { status: 'ready', value: pageOf(ITEMS.filter((entry) => entry.strategy === 'MAKE_TO_STOCK')) } }) },
    { id: 'filter-default', label: 'Filter: on the default (never set)', model: make({ controls: { set: 'default' }, list: { status: 'ready', value: pageOf(ITEMS.filter((entry) => !entry.set)) } }) },
    { id: 'selection', label: 'Three ticked: Change strategy for 3', model: make({ selected: PICKED.map((entry) => entry.item.id) }) },
    { id: 'bulk-reading', label: 'Change strategy: reading the items again', model: make({ selected: PICKED.map((entry) => entry.item.id), bulk: bulk({ phase: 'reading', items: [] }) }) },
    { id: 'bulk-ready', label: 'Change strategy: 2 change, 1 already so', model: make({ selected: PICKED.map((entry) => entry.item.id), bulk: bulk({ reason: 'Winter season: keep the best sizes ready (made up).' }) }) },
    { id: 'bulk-refused', label: 'Change strategy: an item changed since it was read', model: make({ selected: PICKED.map((entry) => entry.item.id), bulk: bulk({ problem: 'refusal.changed' }) }) },
    { id: 'bulk-saving', label: 'Change strategy: saving', model: make({ selected: PICKED.map((entry) => entry.item.id), bulk: bulk({ phase: 'saving' }) }) },
    { id: 'bulk-done', label: 'Change strategy: done, with Undo', model: make({ bulk: bulk({ phase: 'done', answer: ANSWER }) }) },
    { id: 'bulk-undone', label: 'Change strategy: undone', model: make({ bulk: bulk({ phase: 'done', answer: ANSWER, undone: true }) }) },
    { id: 'bulk-failed', label: 'Change strategy: the items could not be read again', model: make({ bulk: bulk({ phase: 'failed', items: [], problem: 'error.offline' }) }) },
    { id: 'notice', label: 'After the change: the notice', model: make({ notice: { tone: 'success', key: 'notice.bulkDone', params: { count: 2 } } }) },
    { id: 'more', label: 'Many items: Show more', model: make({ list: { status: 'ready', value: pageOf(MANY, uid('8282', 36)) } }) },
    { id: 'updates', label: 'Another planner changed two items: Show', model: make({ updates: 2 }) },
    { id: 'empty', label: 'No items yet', model: make({ list: { status: 'ready', value: pageOf([]) } }) },
    { id: 'filtered-empty', label: 'A search that matches nothing', model: make({ controls: { q: 'zzz' }, list: { status: 'ready', value: pageOf([]) } }) },
    { id: 'loading', label: 'Loading', model: make({ list: { status: 'loading' }, live: 'connecting' }) },
    { id: 'error', label: 'Couldn’t load production strategy per item', model: make({ list: { status: 'error', problem: 'error.failed' }, live: 'offline' }) },
    { id: 'two-sites', label: 'Two sites: picked in the band', model: make({ sites: { status: 'ready', value: SITES } }) },
    { id: 'production-manager', label: 'The production manager changes strategies too', model: make({}, rolePermissions('production_manager')) },
    { id: 'read-only', label: 'Read only: the strategies shown, changing them held with the reason', model: make({ selected: [ITEMS[1]!.item.id] }, rolePermissions('read_only')) },
    { id: 'no-permission', label: 'Sales: no planning.view — the page says so', model: make({}, rolePermissions('sales').filter((permission) => permission !== 'planning.view')) },
    { id: 'keys', label: 'Keyboard shortcuts', model: make({ dialog: { kind: 'keys' } }) },
    { id: 'keyboard', label: 'Keyboard: the keys sit in the footer icon', model: make({ focusRow: 0, keysOpen: true }) },
  ],
})

export const FIXTURES = { ITEMS, ANSWER, PICKED }
