import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, NOW, PREFIX, ROLE_PERMISSIONS } from '../../library/demo'
import { pricesModel, withoutCost as sourcesWithoutCost, materialSources } from '../../../purchasing/suppliers/sources/demo/fixtures'
import { sourcesCan } from '../../../purchasing/suppliers/sources/model'
import { failed, ready } from '../../library/model'
import { CERTIFICATES, LEATHER, LIBRARY_COLOURS, LOTS, PROTECTOR, STOCK, SUPPLIER_ROWS, TEXTILE, withoutCost } from '../demo'
import type { MaterialRecordViewModel } from './record-model'
import { MaterialRecordView } from './view/MaterialRecordView'
import { GRADE_ROWS, GRADES_VIEW, gradesModel, REFUSED_MARKS, SAVING_MARKS, WAITING_MARKS } from './grades/demo'
import { NO_GRADES } from './grades/grades-model'
// B-W2b-238: materials in depth (properties of its kind, fibres, approval, where used).
import { depthModel, LEATHER_DEPTH, PROTECTOR_DEPTH, WHERE_USED } from '../approval/demo'
import type { MaterialDepthModel } from '../approval/depth-model'

/**
 * SCR-048 the material record — made-up data only: a chrome-tanned leather bought by the hide (52.5 ft²), stocked in
 * ft² and cut in dm², three colours and an archived one, three lots (released, waiting, failed); a lining with its
 * composition; a protector covered by a made-up EN 1621 certificate. Role cases: the Owner, a product developer (no
 * money), quality and sales (read). B-W2a-69: Suppliers & prices › Supplier prices (`supplier-prices-*`): Purchasing's
 * approved sources of the leather, read only — normal, no cost grain, only the default supplier, none, couldn't load,
 * loading, and a role without purchasing.view. B-W2b-131: Properties & grades › Grades and usable area (`grades-*`): the
 * leather's grades with the article's own rules and the grades' defaults, saving, waiting offline, refused, read only (no
 * edit right, a material of every company, archived), not tracked by the hide, none, loading, couldn't load, the selection
 * and the earlier rules.
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
  grades: gradesModel(),
  depth: depthModel('owner', { depth: { status: 'ready', value: LEATHER_DEPTH } }),
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
    depth: model.depth ? { ...model.depth, can: depthModel(role).can } : model.depth,
  }
}
const prices = (over: Parameters<typeof pricesModel>[1]): MaterialRecordViewModel => ({ ...base, tab: 'suppliers', supplierPrices: pricesModel(LEATHER.id, { defaultSupplier: LEATHER.defaultSupplier, ...over }) })
const protector: MaterialRecordViewModel = { ...base, material: { status: 'ready', value: PROTECTOR }, certificates: ready(CERTIFICATES), lots: ready({ lots: [], capped: false }), stock: ready({ rows: [], totals: [], truncated: false }), grades: NO_GRADES, depth: depthModel('owner', { depth: { status: 'ready', value: PROTECTOR_DEPTH } }) }
const textile: MaterialRecordViewModel = { ...base, material: { status: 'ready', value: TEXTILE }, lots: ready({ lots: [], capped: true }), stock: ready({ rows: [], totals: [], truncated: false }), grades: NO_GRADES, depth: depthModel('owner') }
/** B-W2b-238: a tab of a material with its depth model as given. */
const deep = (model: MaterialRecordViewModel, tab: MaterialRecordViewModel['tab'], over: Partial<MaterialDepthModel> = {}): MaterialRecordViewModel => ({ ...model, tab, depth: { ...(model.depth ?? depthModel('owner')), ...over } })
/** B-W2b-131: the Properties & grades tab of the leather with its grades section as given. */
const grades = (over: Parameters<typeof gradesModel>[0] = {}, view = GRADES_VIEW, model: MaterialRecordViewModel = base): MaterialRecordViewModel => ({ ...model, tab: 'properties', grades: gradesModel(over, view) })

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
    {
      id: 'grades',
      label: 'B-W2b-131 — Grades and usable area (Owner): A by this article (88 %), B on the grade default, C with its panels, a retired grade D',
      model: grades(),
      note: 'Each cell saves by itself (Enter or leaving it; Esc puts the stored value back). Typing into B creates the article’s own rule.',
    },
    { id: 'grades-saving', label: 'B-W2b-131 — Grades: two cells on their way (B’s share, C’s panels)', model: grades({ marks: SAVING_MARKS, busy: true }) },
    { id: 'grades-offline', label: 'B-W2b-131 — Grades offline: two cell edits wait on this page', model: grades({ marks: WAITING_MARKS, offline: true }), note: 'Nothing else is kept; they go when the browser is back online.' },
    { id: 'grades-refused', label: 'B-W2b-131 — Grades: a share of 120 refused, a rule changed meanwhile (read again)', model: grades({ marks: REFUSED_MARKS }), note: 'The "!" says why in our words; the stored value shows again.' },
    { id: 'grades-selected', label: 'B-W2b-131 — Grades: A and C selected — Back to the grade default for 2', model: grades({ selected: [GRADE_ROWS[0]!.grade.id, GRADE_ROWS[2]!.grade.id] }) },
    { id: 'grades-selected-held', label: 'B-W2b-131 — Grades: only B selected — held (no rule of this article to retire)', model: grades({ selected: [GRADE_ROWS[1]!.grade.id] }) },
    { id: 'grades-default-done', label: 'B-W2b-131 — Grades: back to the grade default (notice)', model: grades({ notice: { key: 'material.grades.notice.default', tone: 'success', params: { count: 1 } } }) },
    { id: 'grades-history', label: 'B-W2b-131 — Grades: the earlier rules of C, each with Use again (held while C has a rule)', model: grades({ historyOpen: true }) },
    { id: 'grades-read-only', label: 'B-W2b-131 — Grades read only (quality: no product.materials.manage): banner, cells as text', model: as('quality', grades({}, { ...GRADES_VIEW, canManage: false })) },
    {
      id: 'grades-every-company',
      label: 'B-W2b-131 — Grades of a material of every company, for an Owner over one company: read only, said why',
      model: grades({}, { ...GRADES_VIEW, material: { ...GRADES_VIEW.material, companyId: null }, canManage: false }),
    },
    { id: 'grades-archived', label: 'B-W2b-131 — Grades of an archived leather: read only', model: grades({ archived: true }, GRADES_VIEW, { ...base, material: { status: 'ready', value: { ...LEATHER, status: 'ARCHIVED' } } }) },
    { id: 'grades-not-leather', label: 'B-W2b-131 — Grades: a leather counted by the lot, not by the hide (grades do not apply)', model: grades({}, { ...GRADES_VIEW, material: { ...GRADES_VIEW.material, tracksHides: false }, grades: [], canManage: false }) },
    { id: 'grades-empty', label: 'B-W2b-131 — Grades: no grade set up yet', model: grades({}, { ...GRADES_VIEW, grades: [] }) },
    { id: 'grades-loading', label: 'B-W2b-131 — Grades: loading (the rest of the tab is usable)', model: grades({ part: { status: 'loading' } }) },
    { id: 'grades-error', label: "B-W2b-131 — Grades: couldn't load + Try again (the rest of the record stays usable)", model: grades({ part: { status: 'error', problem: 'problem.read.unavailable' } }) },
    {
      id: 'w2b238-props-textile',
      label: 'B-W2b-238 — Properties of its kind: the lining typed as a fabric (220 g/m², 150 cm, knitted); its fibres as the label reads them',
      model: deep(textile, 'properties'),
      note: '"nylon" is not the official name: the label says polyamide (poliammide). Saved together with Discard / Save properties.',
    },
    { id: 'w2b238-props-protector', label: 'B-W2b-238 — Properties of its kind: a protector (EN 1621-1:2012, shoulder, level 2, size A)', model: deep(protector, 'properties') },
    { id: 'w2b238-props-draft', label: 'B-W2b-238 — Properties: a weight typed wrong — Save held with the reason', model: deep(textile, 'properties', { propertiesDraft: { weightGsm: '22o', widthCm: '150', construction: 'knitted' } }) },
    { id: 'w2b238-props-offline', label: 'B-W2b-238 — Properties offline: the change stays on the page, Save held', model: deep(textile, 'properties', { offline: true, propertiesDraft: { weightGsm: '240', widthCm: '150', construction: 'knitted' } }) },
    { id: 'w2b238-props-saved', label: 'B-W2b-238 — Properties saved (notice)', model: deep(textile, 'properties', { notice: { key: 'properties.notice.saved', tone: 'success' } }) },
    {
      id: 'w2b238-props-refused',
      label: 'B-W2b-238 — Properties refused by the server: the field marked, its sentence kept as data',
      model: deep(textile, 'properties', { notice: { key: 'problem.write.invalid', tone: 'danger' }, refused: { key: 'problem.write.invalid', reload: false, paths: ['properties/widthCm'], messages: ['Expected a number above 0 with at most 8 digits and 4 decimals.'] } }),
    },
    { id: 'w2b238-props-read-only', label: 'B-W2b-238 — Properties read only (quality: no product.materials.manage): drawn as text', model: as('quality', deep(textile, 'properties')) },
    { id: 'w2b238-props-archived', label: 'B-W2b-238 — Properties of an archived material: read only, said why', model: deep({ ...textile, material: { status: 'ready', value: { ...TEXTILE, status: 'ARCHIVED' } } }, 'properties') },
    { id: 'w2b238-props-loading', label: 'B-W2b-238 — Properties loading (the rest of the tab is usable)', model: deep(textile, 'properties', { depth: { status: 'loading' } }) },
    { id: 'w2b238-props-error', label: "B-W2b-238 — Properties couldn't load + Try again", model: deep(textile, 'properties', { depth: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'w2b238-approval', label: 'B-W2b-238 — Approval status (Owner): approved on a condition, by whom and when, what it reaches', model: deep(textile, 'compliance'), note: 'Four RadioCards; the condition is required; "See where it is used" opens the tab.' },
    { id: 'w2b238-approval-quality', label: 'B-W2b-238 — Approval status (quality decides)', model: as('quality', deep(textile, 'compliance')) },
    { id: 'w2b238-approval-block-held', label: 'B-W2b-238 — Blocked picked without why: Block material held with the reason', model: deep(textile, 'compliance', { approvalDraft: { approval: 'BLOCKED', note: '' } }) },
    { id: 'w2b238-approval-block-confirm', label: 'B-W2b-238 — Block material: what it does, asked once more', model: deep(textile, 'compliance', { approvalDraft: { approval: 'BLOCKED', note: 'Lab test failed: nickel above the limit (made-up).' }, confirmBlock: true }), note: 'No new BOM line; 1 draft revision held at release; 2 released ones keep it; 2 open work orders go on.' },
    { id: 'w2b238-approval-decided', label: 'B-W2b-238 — Decided (notice)', model: deep(protector, 'compliance', { depth: { status: 'ready', value: PROTECTOR_DEPTH }, notice: { key: 'approval.notice.decided', tone: 'success', params: { approval: 'APPROVED' } } }) },
    { id: 'w2b238-approval-pending', label: 'B-W2b-238 — A leather not reviewed yet (pending, nobody decided)', model: deep(base, 'compliance') },
    { id: 'w2b238-approval-sales', label: 'B-W2b-238 — Approval read only (sales: no product.materials.approve): drawn as text', model: as('sales', deep(textile, 'compliance')) },
    { id: 'w2b238-approval-archived', label: 'B-W2b-238 — Approval of an archived material: read only, said why', model: deep({ ...textile, material: { status: 'ready', value: { ...TEXTILE, status: 'ARCHIVED' } } }, 'compliance') },
    { id: 'w2b238-approval-offline', label: 'B-W2b-238 — Approval offline: Apply held, the choice stays on the page', model: deep(textile, 'compliance', { offline: true, approvalDraft: { approval: 'APPROVED', note: '' } }) },
    {
      id: 'w2b238-approval-refused',
      label: 'B-W2b-238 — Decision refused (changed meanwhile): read again, said in our words',
      model: deep(textile, 'compliance', { notice: { key: 'problem.write.moved', tone: 'danger' }, refused: { key: 'problem.write.moved', reload: true, paths: [], messages: [] } }),
    },
    { id: 'w2b238-approval-loading', label: 'B-W2b-238 — Approval loading', model: deep(textile, 'compliance', { depth: { status: 'loading' } }) },
    { id: 'w2b238-approval-error', label: "B-W2b-238 — Approval couldn't load + Try again (the rest of the tab stays usable)", model: deep(textile, 'compliance', { depth: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'w2b238-where-used', label: 'B-W2b-238 — Where used (Owner): every style, revision and open work order', model: deep(base, 'whereused'), note: 'A line per revision (draft, released, obsolete) and the line it is an alternate on; colours per colourway; work orders link to their record.' },
    { id: 'w2b238-where-used-colour', label: 'B-W2b-238 — Where used: only the red colour', model: deep(base, 'whereused', { colourId: LEATHER.colours[1]!.id, whereUsed: { status: 'ready', value: { ...WHERE_USED, itemColourId: LEATHER.colours[1]!.id, rows: WHERE_USED.rows.slice(0, 2) } } }) },
    { id: 'w2b238-where-used-selected', label: 'B-W2b-238 — Where used: two rows selected — Export 2', model: deep(base, 'whereused', { selected: WHERE_USED.rows.slice(0, 2).map((row) => `${row.lineId}:${row.priority ?? 0}`) }) },
    {
      id: 'w2b238-where-used-no-orders',
      label: 'B-W2b-238 — Where used without workorders.view (sales): work orders "Not in your role", never 0',
      model: as('sales', deep(base, 'whereused', { whereUsed: { status: 'ready', value: { ...WHERE_USED, workOrdersAllowed: false, summary: { ...WHERE_USED.summary, openWorkOrders: null }, rows: WHERE_USED.rows.map((row) => ({ ...row, openWorkOrders: null })) } } })),
    },
    { id: 'w2b238-where-used-no-styles', label: 'B-W2b-238 — Where used without product.styles.view: said why', model: deep(base, 'whereused', { whereUsed: { status: 'ready', value: { ...WHERE_USED, stylesAllowed: false, rows: [], summary: { ...WHERE_USED.summary, styles: 0 } } } }) },
    { id: 'w2b238-where-used-empty', label: 'B-W2b-238 — Where used: not used in any BOM', model: deep(protector, 'whereused', { whereUsed: { status: 'ready', value: { ...WHERE_USED, material: PROTECTOR_DEPTH.material, rows: [], colours: [], summary: { styles: 0, draftRevisions: 0, releasedRevisions: 0, obsoleteRevisions: 0, lines: 0, alternates: 0, openWorkOrders: 0 } } } }) },
    { id: 'w2b238-where-used-more', label: 'B-W2b-238 — Where used: more lines than one answer holds', model: deep(base, 'whereused', { whereUsed: { status: 'ready', value: { ...WHERE_USED, more: true } } }) },
    { id: 'w2b238-where-used-loading', label: 'B-W2b-238 — Where used loading', model: deep(base, 'whereused', { whereUsed: { status: 'loading' } }) },
    { id: 'w2b238-where-used-error', label: "B-W2b-238 — Where used couldn't load + Try again", model: deep(base, 'whereused', { whereUsed: { status: 'error', problem: 'problem.read.unavailable' } }) },
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
