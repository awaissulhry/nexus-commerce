import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { rolePermissions } from '../../../../shell/design-data'
import { settingsCan, type SaveStatus } from '../model'
import { PlanningSettingsView } from '../view/PlanningSettingsView'
import { inShell } from '../calendars/demo/fixtures'
import { DEFAULT_SETTINGS, ENTRIES, LANES, RULES, SETTINGS, SITE, SITES, SUPPLIER_CHOICES } from './demo'
import { itemRowsOf, markKey, rowKeyOf } from './model'
import { EfficiencyView, type EfficiencyModel } from './view/EfficiencyView'
import { HorizonView, type HorizonModel } from './view/HorizonView'
import { ItemsView, type ItemsModel } from './view/ItemsView'
import { EMPTY_RULE, ReorderView, type ReorderModel } from './view/ReorderView'

/**
 * SCR-127 — Planning settings › Item planning settings (design planning.settings sec:items, sec:reorder, sec:horizon,
 * sec:efficiency; B-W2a-59 on the API of B-W2a-16): each tab in the page's frame, with made-up data only, for the role
 * cases the design names — the planner keeps everything, the buyer keeps item parameters and reorder rules (horizon and
 * efficiency read-only with the reason), the production manager reads. Alone the views work for real (the dialogs, the
 * bulk review, the search); nothing is sent.
 */

type Role = 'planner' | 'buyer' | 'production_manager'
const SHELL_ROLE = { planner: 'planner', buyer: 'buyer', production_manager: 'production' } as const

export interface ParamsCase {
  role: Role
  tab: 'items' | 'reorder' | 'horizon' | 'efficiency'
  status?: SaveStatus | null
  items?: Partial<ItemsModel>
  reorder?: Partial<ReorderModel>
  horizon?: Partial<HorizonModel>
  efficiency?: Partial<EfficiencyModel>
}

const PREFIX = '/w/DEMO'
const ROWS = itemRowsOf(ENTRIES)
const ready = { status: 'ready' as const }

function ParamsDesign({ model }: { model: ParamsCase }) {
  const can = settingsCan(rolePermissions(model.role))
  const base = { site: SITE, can }
  const body =
    model.tab === 'items'
      ? createElement(ItemsView, {
          model: { prefix: PREFIX, sites: SITES, load: ready, rows: ROWS, more: true, loadingMore: false, query: '', method: null, configured: null, marks: {}, notice: null, changedElsewhere: false, busy: false, suppliers: null, ...base, ...model.items },
        })
      : model.tab === 'reorder'
        ? createElement(ReorderView, { model: { load: ready, rules: RULES, marks: {}, notice: null, changedElsewhere: false, busy: false, search: { status: 'ready', items: ENTRIES }, ...base, ...model.reorder } })
        : model.tab === 'horizon'
          ? createElement(HorizonView, { model: { load: ready, read: SETTINGS, busy: false, notice: null, changedElsewhere: false, ...base, ...model.horizon } })
          : createElement(EfficiencyView, { model: { prefix: PREFIX, load: ready, lanes: LANES, marks: {}, notice: null, changedElsewhere: false, busy: false, ...base, ...model.efficiency } })
  // In the office shell, as Calendars & shifts (SCR-124): the page fills the main area, measured at 1440 and 1920.
  return inShell(createElement(PlanningSettingsView, { model: { prefix: PREFIX, can, tab: model.tab, sites: { status: 'ready', items: SITES }, siteId: SITE.id, status: model.status ?? null } }, body), SHELL_ROLE[model.role])
}

const cowhide = ROWS[0]!.key
const kangaroo = rowKeyOf(ENTRIES[1]!.item.id, null)
const mesh = rowKeyOf(ENTRIES[2]!.item.id, null)
const zip = rowKeyOf(ENTRIES[3]!.item.id, null)

export const designScreen = defineDesignScreen<ParamsCase>({
  screen: 'SCR-127',
  title: 'Item planning settings (Planning settings)',
  view: ParamsDesign,
  cases: [
    {
      id: 'items',
      label: 'Item parameters (planner)',
      model: { role: 'planner', tab: 'items', status: { kind: 'saved', at: '2026-10-29T09:42:00.000Z' } },
      note: 'One row per item and colour: method, where it comes from, the preferred supplier or make site, lead times, safety stock, order minimum, step and maximum in the base unit. Items with no row show their own defaults faint. Type in a cell to save it on its own; the method and source cells open their choice (Enter). Import is held: no importer yet.',
    },
    {
      id: 'items-saving-marks',
      label: 'Cells saving, saved, refused, unknown',
      model: {
        role: 'planner',
        tab: 'items',
        status: { kind: 'failed', count: 2 },
        items: {
          marks: {
            [markKey(cowhide, 'safetyStock')]: { state: 'saving' },
            [markKey(mesh, 'buyLeadTimeDays')]: { state: 'refused', problem: { key: 'pp.problem.days', params: { field: 'pp.field.buyLeadTimeDays' } } },
            [markKey(kangaroo, 'maxOrderQty')]: { state: 'unknown', problem: { key: 'ps.problem.unknown' } },
            [markKey(zip, 'minOrderQty')]: { state: 'refused', problem: { key: 'pp.problem.aboveZero', params: { field: 'pp.field.minOrderQty' } } },
          },
        },
      },
      note: 'A cell shows ↻ while its write is in flight, "!" with the reason when refused (checked before sending: "The buying lead time is a whole number of calendar days"), "?" when no answer came back. The band counts what was not saved.',
    },
    { id: 'items-selected', label: 'Rows selected: the bulk actions', model: { role: 'planner', tab: 'items', items: { selected: [cowhide, kangaroo, mesh] } }, note: 'Three rows selected: the toolbar swaps to Edit 3 and Plan 2 by defaults (only rows with parameters of their own are removed).' },
    {
      id: 'items-review',
      label: 'Edit 3: the review',
      model: { role: 'planner', tab: 'items', items: { selected: [cowhide, kangaroo, mesh], dialog: { kind: 'bulk', step: 'review', draft: { fields: { safetyLeadTimeDays: '5', maxOrderQty: '30' }, method: null } } } },
      note: 'Old → new per row, and what happens: the cowhide refuses an order maximum below its order minimum (50), so it is held with the reason; the others will be saved. Apply saves one after the other and names every refused row.',
    },
    {
      id: 'items-method-dialog',
      label: 'Method: reorder point',
      model: { role: 'planner', tab: 'items', items: { dialog: { kind: 'method', key: mesh, method: 'REORDER_POINT', first: '300', second: '' } } },
      note: 'A reorder point needs its lot size too: Save is held with the reason until both are given. Min / max asks for both stocks the same way.',
    },
    { id: 'items-supplier-dialog', label: 'Where it comes from: bought', model: { role: 'planner', tab: 'items', items: { dialog: { kind: 'source', key: kangaroo, source: 'BUY' }, suppliers: { itemId: ENTRIES[1]!.item.id, status: 'ready', items: SUPPLIER_CHOICES } } }, note: 'The item\'s own supplier and its approved sources; made: the plants of the company.' },
    { id: 'items-buyer', label: 'Buyer', model: { role: 'buyer', tab: 'items' }, note: 'The buyer keeps item parameters and reorder rules (planning.items.manage): the same grid, editable.' },
    { id: 'items-read-only', label: 'Production manager (read-only)', model: { role: 'production_manager', tab: 'items' }, note: 'Shown read-only: the cells do not edit; the choices and the bulk actions stay focusable and say the missing right.' },
    { id: 'items-loading', label: 'Loading', model: { role: 'planner', tab: 'items', items: { load: { status: 'loading' }, rows: null } } },
    { id: 'items-error', label: 'Read failed', model: { role: 'planner', tab: 'items', items: { load: { status: 'error', problem: 'ps.problem.offline' }, rows: null } }, note: 'A failed read is never drawn as empty: the reason in words and Try again.' },
    { id: 'items-empty', label: 'No items yet', model: { role: 'planner', tab: 'items', items: { rows: [], more: false } } },
    { id: 'reorder', label: 'Reorder rules', model: { role: 'planner', tab: 'reorder' }, note: 'Reorder point (with its lot size) or min/max per item and colour; the warehouse is the site (the API keeps rules per site). A cell that the rule\'s method does not use shows —.' },
    { id: 'reorder-new-rule', label: 'New rule', model: { role: 'planner', tab: 'reorder', reorder: { dialog: { kind: 'new', draft: { ...EMPTY_RULE, query: 'DEMO-L', itemId: ENTRIES[1]!.item.id, method: 'MIN_MAX', first: '20', second: '15' } } } }, note: 'Search the item, pick its colour or every colour, the method and its two values; a maximum below the minimum is refused before anything is sent.' },
    { id: 'reorder-selected', label: 'Rules selected: plan from orders', model: { role: 'planner', tab: 'reorder', reorder: { selected: [RULES[0]!.id, RULES[2]!.id] } } },
    { id: 'reorder-empty', label: 'No reorder rules', model: { role: 'planner', tab: 'reorder', reorder: { rules: [] } }, note: '"No reorder rules — items are planned from orders only", with New rule.' },
    { id: 'horizon', label: 'Horizon & fences', model: { role: 'planner', tab: 'horizon' }, note: 'Days for 2 weeks, weeks to week 13, months to week 26; the default efficiency and the nightly run. The buckets are said in words. Time fences come later (W3): one line, no controls.' },
    { id: 'horizon-edited', label: 'Edited: the save bar', model: { role: 'planner', tab: 'horizon', status: { kind: 'unsaved', count: 2 }, horizon: { draft: { horizonWeeks: 30, dayBucketWeeks: 2, weekBucketWeeks: 12, defaultEfficiencyPct: '85', scheduledRunTime: '02:00' } } }, note: 'Two changes: the preview follows the typed values; ⌘S saves, Discard puts them back; leaving the page asks first.' },
    { id: 'horizon-refused', label: 'A field refused', model: { role: 'planner', tab: 'horizon', status: { kind: 'unsaved', count: 1 }, horizon: { draft: { horizonWeeks: 26, dayBucketWeeks: 14, weekBucketWeeks: 13, defaultEfficiencyPct: '85', scheduledRunTime: '02:00' } } }, note: 'Day buckets past the week buckets: the field says why and Save is held until it is fixed.' },
    { id: 'horizon-default', label: 'A site on the defaults', model: { role: 'planner', tab: 'horizon', horizon: { read: DEFAULT_SETTINGS } } },
    { id: 'horizon-held', label: 'Buyer (read-only here)', model: { role: 'buyer', tab: 'horizon' }, note: 'Without planning.settings.manage the form reads only and says why.' },
    { id: 'horizon-loading', label: 'Loading', model: { role: 'planner', tab: 'horizon', horizon: { load: { status: 'loading' }, read: null } } },
    { id: 'efficiency', label: 'Line efficiency', model: { role: 'planner', tab: 'efficiency' }, note: 'Planned % per line and work centre with the last four weeks\' actual next to it (a week with nothing available keeps its place). People per shift is a headcount; empty = one per active station. Never a person.' },
    { id: 'efficiency-selected', label: 'Lanes selected: the same %', model: { role: 'planner', tab: 'efficiency', efficiency: { selected: [`LINE:${LANES.lines[1]!.id}`, `WORK_CENTRE:${LANES.workCentres[2]!.id}`], bulkOpen: true } } },
    { id: 'efficiency-no-lines', label: 'No lines yet', model: { role: 'planner', tab: 'efficiency', efficiency: { lanes: { ...LANES, lines: [], workCentres: [] } } }, note: '"No lines yet" with the link to the site\'s production lines.' },
    { id: 'efficiency-read-only', label: 'Production manager (read-only)', model: { role: 'production_manager', tab: 'efficiency' } },
    { id: 'efficiency-error', label: 'Read failed', model: { role: 'planner', tab: 'efficiency', efficiency: { load: { status: 'error', problem: 'ps.problem.read' }, lanes: null } } },
    { id: 'changed-elsewhere', label: 'Changed by someone else', model: { role: 'planner', tab: 'items', items: { changedElsewhere: true } }, note: 'A live change from another screen: "Changed by someone else · Reload"; nothing moves under the cursor.' },
  ],
})
