import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, NOW, PREFIX, ROLE_PERMISSIONS } from '../../library/demo'
import { pricesModel, withoutCost as sourcesWithoutCost, materialSources } from '../../../purchasing/suppliers/sources/demo/fixtures'
import { sourcesCan } from '../../../purchasing/suppliers/sources/model'
import { failed, ready } from '../../library/model'
import { CERTIFICATES, LEATHER, LIBRARY_COLOURS, LOTS, PROTECTOR, STOCK, SUPPLIER_ROWS, TEXTILE, withoutCost } from '../demo'
import type { MaterialRecordViewModel } from './record-model'
import { MaterialRecordView } from './view/MaterialRecordView'

/**
 * SCR-048 the material record — made-up data only: a chrome-tanned leather bought by the hide (52.5 ft²), stocked in
 * ft² and cut in dm², three colours and an archived one, three lots (released, waiting, failed); a lining with its
 * composition; a protector covered by a made-up EN 1621 certificate. Role cases: the Owner, a product developer (no
 * money), quality and sales (read). B-W2a-69: Suppliers & prices › Supplier prices (`supplier-prices-*`): Purchasing's
 * approved sources of the leather, read only — normal, no cost grain, only the default supplier, none, couldn't load,
 * loading, and a role without purchasing.view.
 */

const base: MaterialRecordViewModel = {
  prefix: PREFIX,
  can: canFor('owner'),
  tab: 'overview',
  material: { status: 'ready', value: LEATHER },
  libraryColours: LIBRARY_COLOURS,
  certificates: null,
  lots: ready({ lots: LOTS, capped: false }),
  stock: ready(STOCK),
  suppliers: { q: 'demo', results: SUPPLIER_ROWS },
  save: { state: 'idle', at: null },
  busy: false,
  notice: null,
  changed: null,
  dialog: null,
  refused: null,
  supplierPrices: pricesModel(LEATHER.id, { defaultSupplier: LEATHER.defaultSupplier }),
}
const as = (role: 'developer' | 'quality' | 'sales', model: MaterialRecordViewModel): MaterialRecordViewModel => {
  const sources = sourcesCan(ROLE_PERMISSIONS[role])
  return {
    ...model,
    can: canFor(role),
    material: model.material.status === 'ready' ? { status: 'ready', value: withoutCost(model.material.value) } : model.material,
    lots: canFor(role).lots ? model.lots : null,
    stock: canFor(role).stock ? model.stock : null,
    supplierPrices: pricesModel(LEATHER.id, { defaultSupplier: LEATHER.defaultSupplier, can: { view: sources.view, cost: sources.cost } }),
  }
}
const prices = (over: Parameters<typeof pricesModel>[1]): MaterialRecordViewModel => ({ ...base, tab: 'suppliers', supplierPrices: pricesModel(LEATHER.id, { defaultSupplier: LEATHER.defaultSupplier, ...over }) })
const protector: MaterialRecordViewModel = { ...base, material: { status: 'ready', value: PROTECTOR }, certificates: ready(CERTIFICATES), lots: ready({ lots: [], capped: false }), stock: ready({ rows: [], totals: [], truncated: false }) }
const textile: MaterialRecordViewModel = { ...base, material: { status: 'ready', value: TEXTILE }, lots: ready({ lots: [], capped: true }), stock: ready({ rows: [], totals: [], truncated: false }) }

export const designScreen = defineDesignScreen<MaterialRecordViewModel>({
  screen: 'SCR-048',
  title: 'Material record',
  view: MaterialRecordView,
  cases: [
    { id: 'overview', label: 'Overview: leather (Owner)', model: base, note: 'Identity and units with the live converter "1 hide = 52.5 ft² = 487.74 dm²"; beside it the facts people ask first, each a link to its tab.' },
    { id: 'overview-developer', label: 'Overview: product developer', model: as('developer', base), note: 'No standard cost anywhere: the API drops it without the cost grain.' },
    { id: 'overview-sales', label: 'Overview: sales (reads)', model: as('sales', base), note: 'Fields drawn as text, never greyed inputs; New colour held with its reason.' },
    { id: 'overview-warning', label: 'Overview: lining without a supplier', model: textile, note: 'The API\'s warning in our words.' },
    { id: 'colours', label: 'Colours', model: { ...base, tab: 'colours' }, note: 'The shared list frame: Archive N / Restore N; the archived colour stays listed; library swatches.' },
    { id: 'colour-add', label: 'New colour', model: { ...base, tab: 'colours', dialog: { kind: 'colour', colourId: null } } },
    { id: 'colour-edit', label: 'Change a colour', model: { ...base, tab: 'colours', dialog: { kind: 'colour', colourId: LEATHER.colours[1]!.id } }, note: 'Our code is fixed once the colour exists.' },
    { id: 'colours-none', label: 'Colours: none', model: { ...protector, tab: 'colours' } },
    { id: 'properties-leather', label: 'Properties: leather', model: { ...base, tab: 'properties' } },
    { id: 'properties-textile', label: 'Properties: composition', model: { ...textile, tab: 'properties' }, note: 'Fibres add up to 100 % before Save (held with the gap).' },
    { id: 'suppliers', label: 'Suppliers & prices (Owner)', model: { ...base, tab: 'suppliers' }, note: 'The standard cost per ft², per hide and per dm²; set with a reason for the audit row.' },
    { id: 'suppliers-developer', label: 'Suppliers & prices: no cost grain', model: { ...as('developer', base), tab: 'suppliers' }, note: 'The production manager reads no purchasing either: Supplier prices says what is missing.' },
    { id: 'supplier-prices', label: 'Supplier prices (Owner)', model: prices({}), note: 'Purchasing\u2019s approved sources of the leather: primary first; Open the supplier goes to its Items & prices.' },
    {
      id: 'supplier-prices-no-cost',
      label: 'Supplier prices: no cost grain (a planner)',
      model: { ...as('developer', base), tab: 'suppliers', supplierPrices: pricesModel(LEATHER.id, { defaultSupplier: LEATHER.defaultSupplier, can: { view: true, cost: false }, read: { status: 'ready', rows: sourcesWithoutCost(materialSources(LEATHER.id)), more: false } }) },
      note: 'Reads Purchasing without the cost grain: no price column, not even as —.',
    },
    { id: 'supplier-prices-default', label: 'Supplier prices: only the default supplier', model: prices({ read: { status: 'ready', rows: [], more: false } }) },
    { id: 'supplier-prices-none', label: 'Supplier prices: no source, no default supplier', model: prices({ read: { status: 'ready', rows: [], more: false }, defaultSupplier: null }) },
    { id: 'supplier-prices-error', label: "Supplier prices: couldn't load", model: prices({ read: { status: 'error', problem: 'problem.offline' } }), note: 'The standard cost and the default supplier stay usable.' },
    { id: 'supplier-prices-loading', label: 'Supplier prices: loading', model: prices({ read: { status: 'loading' } }) },
    { id: 'supplier-prices-no-access', label: 'Supplier prices: no purchasing.view', model: prices({ can: { view: false, cost: true } }) },
    { id: 'compliance-leather', label: 'Compliance: leather and its lots', model: { ...base, tab: 'compliance' }, note: 'Cr VI ≤ 3 mg/kg (never above: refused at the field); the lots\' results link to Compliance › Tests.' },
    { id: 'compliance-protector', label: 'Compliance: a protector', model: { ...protector, tab: 'compliance' }, note: 'A PPE component: the EN 1621 certificate covering it, linked to Compliance › Certificates.' },
    { id: 'compliance-capped', label: 'Compliance: no lot among the newest', model: { ...textile, tab: 'compliance' } },
    { id: 'compliance-quality', label: 'Compliance: quality (reads)', model: { ...as('quality', base), tab: 'compliance' } },
    { id: 'stock', label: 'Stock', model: { ...base, tab: 'stock' }, note: 'On hand, available and on hold in ft², hides counted beside; each location, lot and hide.' },
    { id: 'stock-empty', label: 'Stock: none', model: { ...protector, tab: 'stock' } },
    { id: 'stock-failed', label: 'Stock: could not load', model: { ...base, tab: 'stock', stock: failed('problem.read.unavailable') } },
    { id: 'archived', label: 'Archived material', model: { ...base, material: { status: 'ready', value: { ...LEATHER, status: 'ARCHIVED' } } }, note: 'Read only until it is reactivated (⋯ Reactivate).' },
    { id: 'archive-dialog', label: 'Archive', model: { ...base, dialog: { kind: 'archive' } } },
    { id: 'saved', label: 'Just saved', model: { ...base, save: { state: 'idle', at: NOW }, notice: { key: 'material.notice.costSet', tone: 'success' } } },
    { id: 'refused', label: 'A unit change refused', model: { ...base, save: { state: 'failed', at: null }, notice: { key: 'problem.write.state', tone: 'danger' }, refused: { key: 'problem.write.state', reload: true, paths: ['baseUom'], messages: ['DEMO-PL-NAP12 is on a BOM line: its base unit no longer changes.'] } }, note: "Our words first; the API's sentence kept as data." },
    { id: 'changed', label: 'Changed meanwhile', model: { ...base, changed: { at: NOW } } },
    { id: 'keys', label: 'Keyboard shortcuts', model: { ...base, dialog: { kind: 'help' } } },
    { id: 'loading', label: 'Loading', model: { ...base, material: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, material: { status: 'error', problem: 'problem.read.unavailable' } } },
    { id: 'not-found', label: 'Not found', model: { ...base, material: { status: 'notFound' } } },
    { id: 'no-permission', label: 'No access', model: { ...base, can: { ...canFor('sales'), materials: false }, material: { status: 'forbidden' } } },
  ],
})
