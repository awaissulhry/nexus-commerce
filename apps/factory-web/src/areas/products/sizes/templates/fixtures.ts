import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { COMPANY_ID, PREFIX } from '../../library/demo'
import { NO_DEPTH_FILTERS } from '../depth/model'
import { canOf, NOW, ROW_FACTS, SUIT, TEMPLATE_ROWS } from './demo/fixtures'
import { copyPointsOf, emptyNewDraft } from './model'
import { TemplatesListView, type NewTemplateModel, type TemplatesListModel } from './view/TemplatesListView'

/**
 * SCR-049-templates — Products › Sizes & measurements › Measurement templates (B-W1-17, B-W2b-362) — made-up data only: an
 * invented factory's garment types (race suit, jacket with made-to-measure started, trousers, gloves of one company, an archived
 * vest). Role cases: the Owner, a product developer (keeps the library, cannot start made-to-measure), sales (reads).
 */

const active = TEMPLATE_ROWS.filter((row) => row.status === 'ACTIVE')
const base: TemplatesListModel = {
  prefix: PREFIX,
  can: canOf('owner'),
  filters: NO_DEPTH_FILTERS,
  rows: { items: active, more: false, problem: null },
  facts: ROW_FACTS,
  asOf: NOW,
  updates: 0,
  notice: null,
  newTemplate: null,
  switch: { library: 'templates', importHeld: null },
}

const companies = [
  { id: COMPANY_ID, name: 'Officina Demo S.r.l.' },
  { id: '0190f0e2-1111-7000-8000-000000000002', name: 'Pelletteria Esempio S.p.A.' },
]
const newTemplate = (draft: Partial<NewTemplateModel['draft']> = {}, extra: Partial<NewTemplateModel> = {}): NewTemplateModel => ({
  draft: { ...emptyNewDraft(null), ...draft },
  companies,
  templates: active,
  copy: null,
  busy: false,
  problem: null,
  refused: [],
  ...extra,
})

const many = Array.from({ length: 24 }, (_, index) => ({ ...TEMPLATE_ROWS[index % 4]!, id: `${TEMPLATE_ROWS[index % 4]!.id.slice(0, -3)}${String(100 + index)}`, code: `${TEMPLATE_ROWS[index % 4]!.code}_${index + 1}` }))

export const designScreen = defineDesignScreen<TemplatesListModel>({
  screen: 'SCR-049-templates',
  title: 'Sizes & measurements: Measurement templates',
  view: TemplatesListView,
  cases: [
    { id: 'list', label: 'Owner: the templates', model: base, note: 'Points with how many are required, where each is used, Made-to-measure On / Off (Off: nothing is checked; started per template). Gloves: its use could not be read ("—").' },
    { id: 'many', label: 'Many templates', model: { ...base, rows: { items: many, more: false, problem: null }, facts: {} }, note: 'Where-used still being read: "—".' },
    { id: 'selected', label: 'Two rows selected', model: { ...base, selected: [active[0]!.id, active[2]!.id] }, note: 'Export 2 in the selection bar.' },
    { id: 'archived', label: 'Archived view', model: { ...base, filters: { ...NO_DEPTH_FILTERS, status: 'archived' }, rows: { items: [TEMPLATE_ROWS[4]!], more: false, problem: null } } },
    { id: 'updates', label: 'Live changes waiting', model: { ...base, updates: 2 } },
    { id: 'empty', label: 'No templates yet', model: { ...base, rows: { items: [], more: false, problem: null } } },
    { id: 'filtered-empty', label: 'Nothing matches', model: { ...base, filters: { ...NO_DEPTH_FILTERS, q: 'zzz' }, rows: { items: [], more: false, problem: null } } },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { items: null, more: false, problem: null }, asOf: null } },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { items: null, more: false, problem: 'problem.unavailable' } } },
    { id: 'no-permission', label: 'No access', model: { ...base, can: { view: false, manage: false, switch: false }, rows: { items: null, more: false, problem: 'problem.forbidden' } } },
    { id: 'read-only', label: 'Sales (reads)', model: { ...base, can: canOf('sales'), switch: { library: 'templates', importHeld: 'held.noManage' } }, note: 'New template held with its reason.' },
    { id: 'developer', label: 'Product developer', model: { ...base, can: canOf('developer') } },
    { id: 'new', label: 'New template', model: { ...base, newTemplate: newTemplate() }, note: 'Create held until the code, the name and the type are given.' },
    { id: 'new-held', label: 'New template: code taken', model: { ...base, newTemplate: newTemplate({ code: 'JACKET', name: 'Another jacket', productType: 'JACKET', firstCode: 'chest', firstName: 'Chest' }) }, note: '"JACKET is a template already".' },
    { id: 'new-filled', label: 'New template: blank, first point', model: { ...base, newTemplate: newTemplate({ code: 'RAIN_JACKET', name: 'Rain jacket', productType: 'JACKET', firstCode: 'chest', firstName: 'Chest' }) } },
    { id: 'new-copy', label: 'New template: a copy', model: { ...base, newTemplate: newTemplate({ code: 'KART_SUIT', name: 'Kart suit', productType: 'SUIT', start: 'copy', copyFromId: SUIT.id }, { copy: copyPointsOf(SUIT) }) }, note: 'The race suit\'s 10 active points will be copied.' },
    { id: 'new-refused', label: 'New template: refused', model: { ...base, newTemplate: newTemplate({ code: 'RAIN_JACKET', name: 'Rain jacket', productType: 'JACKET', firstCode: 'chest', firstName: 'Chest' }, { problem: 'problem.codeTaken', refused: ['code'] }) } },
  ],
})
