import { defineDesignScreen } from '../../../lib/design/design-screen'
import { ready, reading, failedRead } from '../../quality/_shared/model'
import { CAN, GLOVES_R1, JACKET_R1, MANY, NOW, PREFIX, ROWS, SHARED_R1 } from './demo'
import { NEW_LABEL } from './model'
import type { LabelsListModel, NewLabelModel, StyleHit } from './view-model'
import { LabelsListView } from './view/LabelsListView'

/**
 * SCR-053 Labels & marking — made-up data only (PLAN §3.1): an invented factory's seven garment labels (a touring
 * jacket's active r1 and its r2 draft, a glove label ready to activate, a shared company label, a retired one, an airbag
 * vest and a t-shirt). Roles: the Owner, the product developer (production manager template: reads, every write held
 * with its reason), quality (quality inspector template: writes and test-prints), sales (no access).
 */

const base: LabelsListModel = {
  prefix: PREFIX,
  can: CAN.owner,
  view: 'all',
  query: '',
  rows: ready(ROWS),
  asOf: NOW,
  live: 'live',
  updates: 0,
  selected: [],
  notice: null,
  newLabel: null,
}

const newLabel = (extra: Partial<NewLabelModel> = {}): NewLabelModel => ({ draft: { ...NEW_LABEL }, styles: null, styleQuery: '', sources: ROWS.filter((row) => row.status !== 'RETIRED'), busy: false, problem: null, ...extra })
const FOUND: StyleHit[] = [
  { id: JACKET_R1.style!.id, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', ppeStandard: 'EN 17092-4:2020', ppeClass: 'A' },
  { id: GLOVES_R1.style!.id, code: 'DEMO-GLV-01', name: 'Guanto Estivo Demo', ppeStandard: 'EN 13594:2015', ppeClass: '1KP' },
]

export const designScreen = defineDesignScreen<LabelsListModel>({
  screen: 'SCR-053',
  title: 'Labels & marking',
  view: LabelsListView,
  cases: [
    { id: 'owner', label: 'Owner: every label', model: base, note: 'Tiles = saved views; the code + revision is a real link; Checks say "Ready to activate" or "N things to fix"; an active label is frozen.' },
    { id: 'developer', label: 'Product developer (reads)', model: { ...base, can: CAN.developer }, note: 'New label is held with its reason; Retire and New revision are held in each row’s ⋯.' },
    { id: 'quality', label: 'Quality (writes)', model: { ...base, can: CAN.quality } },
    { id: 'selected', label: 'Two rows selected', model: { ...base, selected: [JACKET_R1.id, SHARED_R1.id] }, note: 'The toolbar swaps to Export 2 (CSV); the header box is mixed.' },
    { id: 'tile-drafts', label: 'Tile: drafts', model: { ...base, view: 'drafts' }, note: 'The pressed tile is the view; its chip shows in the toolbar.' },
    { id: 'filtered', label: 'Searched "jkt"', model: { ...base, query: 'jkt' } },
    { id: 'many', label: 'Many labels', model: { ...base, rows: ready([...ROWS, ...MANY]) } },
    { id: 'updates', label: 'Live changes waiting', model: { ...base, updates: 2 }, note: 'Rows never move under the cursor: "2 updates · Show".' },
    { id: 'exported', label: 'After an export', model: { ...base, notice: { key: 'done.exported', params: { count: 2 }, tone: 'success' } } },
    { id: 'new-label', label: 'New label', model: { ...base, newLabel: newLabel() }, note: 'Create is held until a style is chosen (or a shared code typed).' },
    { id: 'new-label-search', label: 'New label: style search', model: { ...base, newLabel: newLabel({ styleQuery: 'demo', styles: ready(FOUND) }) } },
    { id: 'new-label-style', label: 'New label: for a style', model: { ...base, newLabel: newLabel({ draft: { ...NEW_LABEL, style: { id: JACKET_R1.style!.id, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo' }, fromTemplateId: SHARED_R1.id, languages: ['it', 'en', 'de'] } }) }, note: 'From a style’s Compliance tab (?new=1&style=…) the style is chosen already.' },
    { id: 'new-label-shared', label: 'New label: shared, code taken', model: { ...base, newLabel: newLabel({ draft: { ...NEW_LABEL, kind: 'shared', code: 'LBL-DEMO-STD' }, problem: 'new.problem.taken' }) } },
    { id: 'no-match', label: 'Nothing matches', model: { ...base, query: 'zzz' } },
    { id: 'empty', label: 'No labels yet', model: { ...base, rows: ready([]) } },
    { id: 'empty-developer', label: 'No labels yet (reads)', model: { ...base, can: CAN.developer, rows: ready([]) } },
    { id: 'loading', label: 'Loading', model: { ...base, rows: reading(), asOf: null, live: 'connecting' } },
    { id: 'error', label: 'Could not load', model: { ...base, rows: failedRead('problem.unavailable'), asOf: null }, note: 'Never drawn as an empty list; the tiles say "—", not 0.' },
    { id: 'no-permission', label: 'Sales: no access', model: { ...base, can: CAN.sales }, note: 'The page names the permission it needs.' },
  ],
})
