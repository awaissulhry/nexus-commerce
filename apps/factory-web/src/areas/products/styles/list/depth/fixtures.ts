import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { StyleRow } from '../../api'
import { CAN, DEMO_PRICES, GRAINS, PREFIX, ROWS } from '../../demo/fixtures'
import type { GateSummaryRow } from '../../record/overview/api'
import { pricesByStyle, type StylesListViewModel } from '../list-model'
import { StylesListView } from '../view/StylesListView'
import type { ListGate } from './model'

/**
 * SCR-343 — Styles list in depth (B-W2b-237; design products.styles sec:styles.grid "Release blockers (count; completeness
 * % W2b)", the selection row's "Set season (W2b)"), made-up data only (the styles' demo rows): the release column read
 * from the release gate for the rows on screen (W1's readiness while it is read or when it fails), and Set season on the
 * selected rows, its held reasons and its outcome. The phone card list carries the same release line.
 */

const open = ROWS.filter((row) => row.status !== 'ARCHIVED')
const summary = (row: StyleRow, n: number): GateSummaryRow => {
  if (row.draftRevision === null && row.releasedRevision === null) return { styleId: row.id, code: row.code, revision: null, checked: false, completenessPct: null, blockers: 0, warnings: 0, first: null, open: 0 }
  if (row.draftRevision === null) return { styleId: row.id, code: row.code, revision: { id: row.id, revision: row.releasedRevision ?? 1, status: 'RELEASED' }, checked: false, completenessPct: n % 2 === 0 ? '100' : '87.5', blockers: 0, warnings: 0, first: null, open: 0 }
  const blockers = n % 3 === 0 ? 1 : 0
  const items = ['BOM', 'SMV', 'CERTIFICATE', 'MEASUREMENTS'] as const
  const openCount = (n % 4) + blockers
  return {
    styleId: row.id,
    code: row.code,
    revision: { id: row.id, revision: row.draftRevision, status: 'DRAFT' },
    checked: true,
    completenessPct: openCount === 0 ? '100' : String(100 - openCount * 10),
    blockers,
    warnings: openCount - blockers,
    first: openCount === 0 ? null : { code: blockers ? 'BOM' : items[n % items.length]!, state: blockers ? 'BLOCKED' : 'WARNING', message: 'x', fix: blockers ? 'bom' : 'minutes' },
    open: openCount,
  }
}
const ALL: ListGate = { state: 'ready', byStyle: Object.fromEntries(ROWS.map((row, index) => [row.id, summary(row, index)])) }

const base: StylesListViewModel = {
  prefix: PREFIX,
  can: CAN.owner,
  grains: GRAINS.owner,
  prices: { state: 'ready', list: DEMO_PRICES.list, byStyle: pricesByStyle(DEMO_PRICES.entries) },
  duplicate: null,
  filters: { view: 'open', q: '', type: '', ppe: '' },
  rows: { items: open, more: false, count: open.length, problem: null },
  tiles: { drafts: 2, waiting: 2, active: 6, archived: 1 },
  asOf: '2026-11-10T08:42:00.000Z',
  updates: 0,
  newStyle: null,
  busy: false,
  notice: null,
  gate: ALL,
}

const withAll = { ...base, filters: { ...base.filters, view: 'all' as const }, rows: { items: ROWS, more: false, count: ROWS.length, problem: null } }
const pick = (codes: string[]) => ROWS.filter((row) => codes.includes(row.code)).map((row) => row.id)
const actions = { onSetSeason: async () => undefined }

const View = ({ model }: { model: StylesListViewModel }) => createElement(StylesListView, { model, actions })

export const designScreen = defineDesignScreen<StylesListViewModel>({
  screen: 'SCR-343',
  title: 'Styles › release check and Set season',
  view: View,
  cases: [
    { id: 'release', label: 'The release column', model: base, note: 'Per row: the completeness meter of its newest draft with what is open and the first item, or the score at release; "No revision" without one. The tone follows what is open, never the percentage.' },
    { id: 'release-reading', label: 'The column while it is read', model: { ...base, gate: { state: 'loading', byStyle: {} } } },
    { id: 'release-failed', label: 'The column could not be read', model: { ...base, gate: { state: 'error', problem: 'fault.unavailable', byStyle: {} } }, note: 'W1’s readiness stays, never an empty column.' },
    { id: 'selected', label: 'Rows selected: Set season in the bar', model: { ...base, selected: pick(['DEMO-JKT-01', 'DEMO-JKT-02', 'DEMO-PNT-01']) } },
    { id: 'season', label: 'Set season (pop-up)', model: { ...base, selected: pick(['DEMO-JKT-01', 'DEMO-JKT-02', 'DEMO-PNT-01']), season: { result: null, open: true } }, note: 'One text for all; the seasons this list uses as quick picks; each style before → after; ⌘↵ applies.' },
    { id: 'season-archived', label: 'Set season with an archived style', model: { ...withAll, selected: pick(['DEMO-JKT-03', 'DEMO-JKT-90', 'DEMO-VST-01']), season: { result: null, open: true } }, note: 'The archived one is left out with why; two are SS28 already once SS28 is typed.' },
    { id: 'season-done', label: 'Set season: the outcome', model: { ...base, selected: pick(['DEMO-JKT-01', 'DEMO-JKT-02', 'DEMO-PNT-01']), season: { result: { done: 2, refused: [{ id: ROWS[3]!.id, code: 'DEMO-PNT-01', key: 'refusal.EDIT_BLOCKED' }] }, open: true } }, note: 'How many changed; each refused style with its reason in words.' },
    { id: 'season-held', label: 'Sales: Set season held', model: { ...base, can: CAN.sales, grains: GRAINS.sales, selected: pick(['DEMO-JKT-01', 'DEMO-JKT-02']) }, note: 'The role does not change styles: held with why.' },
    { id: 'all-archived', label: 'Only archived styles selected', model: { ...withAll, selected: pick(['DEMO-JKT-90']) } },
    { id: 'phone', label: 'Phone: the release line on each card', model: { ...base, phone: true } },
  ],
})
