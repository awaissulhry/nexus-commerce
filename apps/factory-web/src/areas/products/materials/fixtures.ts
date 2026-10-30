import { defineDesignScreen } from '../../../lib/design/design-screen'
import { canFor, COMPANY_ID, NOW, PREFIX } from '../library/demo'
import { ROWS, SUPPLIER_ROWS, withoutCost } from './demo'
import type { MaterialsListViewModel, NewMaterialModel } from './list-model'
import { draftFor } from './model'
import { MaterialsListView } from './view/MaterialsListView'

/**
 * SCR-047 Materials & trims — made-up data only (PLAN §3.1): an invented factory's leathers, textiles, thread, hardware,
 * a protector and a label (one archived). Role cases: the Owner (every grain), a product developer (makes materials, no
 * money: no cost column, no Missing cost tile), quality (reads), sales (reads; New material held with its reason).
 */

const open = ROWS.filter((row) => row.status !== 'ARCHIVED')
const base: MaterialsListViewModel = {
  prefix: PREFIX,
  can: canFor('owner'),
  filters: { view: 'open', q: '', kind: '' },
  rows: { items: open, more: false, count: open.length, problem: null },
  tiles: { leather: 2, missingCost: 2, crvi: 2, ppe: 1 },
  asOf: NOW,
  updates: 0,
  newMaterial: null,
  busy: false,
  notice: null,
}
const noCost = (model: MaterialsListViewModel, role: 'developer' | 'quality' | 'sales'): MaterialsListViewModel => ({
  ...model,
  can: canFor(role),
  rows: { ...model.rows, items: model.rows.items?.map(withoutCost) ?? null },
  tiles: { leather: 2, crvi: 2, ppe: 1 },
})

const newMaterial = (draft = draftFor('LEATHER', COMPANY_ID), extra: Partial<NewMaterialModel> = {}): NewMaterialModel => ({
  draft,
  companies: [
    { id: COMPANY_ID, name: 'Officina Demo S.r.l.' },
    { id: '0190f0e2-1111-7000-8000-000000000002', name: 'Pelletteria Esempio S.p.A.' },
  ],
  suppliers: { q: 'demo', results: SUPPLIER_ROWS },
  busy: false,
  problem: null,
  refused: [],
  messages: [],
  ...extra,
})
const leatherFilled = {
  ...draftFor('LEATHER', COMPANY_ID),
  code: 'DEMO-PL-VIT14',
  name: 'Pelle bovina 1,4 mm demo',
  purchaseFactor: '52,5',
  supplier: { id: SUPPLIER_ROWS[0]!.id, code: SUPPLIER_ROWS[0]!.code, name: SUPPLIER_ROWS[0]!.legalName },
  supplierArticleCode: 'VIT-14-DEMO',
  animalSpecies: 'Bovino',
  tannage: 'CHROME' as const,
  grade: 'TR1',
  thicknessMinMm: '1,3',
  thicknessMaxMm: '1,5',
  standardCost: '2,65',
}

export const designScreen = defineDesignScreen<MaterialsListViewModel>({
  screen: 'SCR-047',
  title: 'Materials & trims',
  view: MaterialsListView,
  cases: [
    { id: 'owner', label: 'Owner: the active materials', model: base, note: 'Tiles = saved filters; the code is a real link; units read "ft² · buy in hide · use in dm²"; the standard cost per base unit only with the cost grain.' },
    { id: 'developer', label: 'Product developer (no money)', model: noCost(base, 'developer'), note: 'No cost column and no "Missing cost" tile: the API drops the field without the cost grain.' },
    { id: 'quality', label: 'Quality (reads)', model: noCost(base, 'quality'), note: 'New material held with its reason; Export works.' },
    { id: 'sales', label: 'Sales (reads)', model: noCost(base, 'sales') },
    { id: 'selected', label: 'Three rows selected', model: { ...base, selected: [ROWS[0]!.id, ROWS[2]!.id, ROWS[4]!.id] }, note: 'The toolbar swaps to Export 3, Set standard cost for 3, Archive 3; the header box is mixed.' },
    { id: 'selected-developer', label: 'Selected, without the cost right', model: { ...noCost(base, 'developer'), selected: [ROWS[0]!.id, ROWS[1]!.id] }, note: 'Set standard cost is not offered without the cost grain; Archive works.' },
    { id: 'cost-dialog', label: 'Set standard cost for 2', model: { ...base, selected: [ROWS[0]!.id, ROWS[1]!.id], dialog: 'cost' }, note: 'Old → new per material, one reason for the audit row.' },
    { id: 'archive-dialog', label: 'Archive 2', model: { ...base, selected: [ROWS[4]!.id, ROWS[5]!.id], dialog: 'archive' } },
    { id: 'tile-leather', label: 'Tile: leather', model: { ...base, filters: { ...base.filters, view: 'leather' }, rows: { items: ROWS.slice(0, 2), more: false, count: 2, problem: null } }, note: 'The pressed tile is the saved view; its chip shows in the filter row.' },
    { id: 'tile-missing-cost', label: 'Tile: missing cost', model: { ...base, filters: { ...base.filters, view: 'missingCost' }, rows: { items: [ROWS[1]!, ROWS[7]!], more: false, count: 2, problem: null } } },
    { id: 'filtered', label: 'Filtered: lining, searched', model: { ...base, filters: { view: 'textiles', q: 'rete', kind: 'LINING' }, rows: { items: [ROWS[3]!], more: false, count: 1, problem: null } } },
    { id: 'archived', label: 'Archived view', model: { ...base, filters: { ...base.filters, view: 'archived' }, rows: { items: [ROWS[8]!], more: false, count: 1, problem: null } } },
    { id: 'many', label: 'More than a page', model: { ...base, rows: { items: open, more: true, count: 214, problem: null } }, note: '"8 of 214" and Show more in the footer, beside the keys icon.' },
    { id: 'updates', label: 'Live changes waiting', model: { ...base, updates: 2 }, note: 'Rows never move under the cursor: "2 updates · Show".' },
    { id: 'notice', label: 'After setting two costs', model: { ...base, notice: { key: 'materials.notice.costSet', tone: 'success', params: { count: 2 } } } },
    { id: 'new-leather', label: 'New material: leather', model: { ...base, newMaterial: newMaterial() }, note: 'Kind first; leather starts bought by the hide, stocked in ft², cut in dm², Cr VI ≤ 3 mg/kg.' },
    { id: 'new-leather-filled', label: 'New material: leather, filled', model: { ...base, newMaterial: newMaterial(leatherFilled) }, note: 'The converter reads "1 hide = 52.5 ft² = 487.74 dm²"; Create is ready.' },
    { id: 'new-leather-problems', label: 'New material: what to fix', model: { ...base, newMaterial: newMaterial({ ...leatherFilled, purchaseFactor: '', tannage: '', thicknessMaxMm: '1,0', crViLimitMgKg: '5' }) }, note: "The domain's own rules, as typed: the hide's area, the tannage, the thickness range and the legal Cr VI limit." },
    { id: 'new-thread', label: 'New material: thread', model: { ...base, newMaterial: newMaterial({ ...draftFor('THREAD', COMPANY_ID), code: 'DEMO-TH-60', name: 'Filo poliestere 60', purchaseFactor: '5000' }) } },
    { id: 'new-developer', label: 'New material (no cost right)', model: { ...noCost(base, 'developer'), newMaterial: newMaterial({ ...draftFor('PROTECTOR', COMPANY_ID), code: 'DEMO-PR-BK2', name: 'Paraschiena livello 2' }) }, note: 'No standard cost field without the cost grain.' },
    { id: 'new-refused', label: 'New material: code taken', model: { ...base, newMaterial: newMaterial({ ...leatherFilled, code: 'DEMO-PL-NAP12' }, { problem: 'problem.write.codeTaken', refused: ['code'], messages: ['The material code DEMO-PL-NAP12 is taken.'] }) } },
    { id: 'no-match', label: 'Nothing matches', model: { ...base, filters: { view: 'open', q: 'zzz', kind: '' }, rows: { items: [], more: false, count: 0, problem: null } } },
    { id: 'empty', label: 'No materials yet', model: { ...base, rows: { items: [], more: false, count: 0, problem: null }, tiles: { leather: 0, missingCost: 0, crvi: 0, ppe: 0 } } },
    { id: 'empty-sales', label: 'No materials yet (sales)', model: { ...noCost(base, 'sales'), rows: { items: [], more: false, count: 0, problem: null }, tiles: { leather: 0, crvi: 0, ppe: 0 } } },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { items: null, more: false, count: null, problem: null }, tiles: { leather: null, missingCost: null, crvi: null, ppe: null }, asOf: null } },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { items: null, more: false, count: null, problem: 'problem.read.unavailable' }, tiles: { leather: null, missingCost: null, crvi: null, ppe: null } }, note: 'Never drawn as an empty list; the tiles say "—", not 0.' },
    { id: 'no-permission', label: 'No access', model: { ...base, can: { ...canFor('sales'), materials: false }, rows: { items: null, more: false, count: null, problem: 'problem.read.forbidden' }, tiles: {} } },
  ],
})
