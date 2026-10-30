import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, canFor, COMPANY_ID, NOW, PREFIX, uid } from '../library/demo'
import type { OperationRow, OperationView } from './api'
import { emptyDraft } from './model'
import { OperationsListView, type NewOperationModel, type OperationsListViewModel } from './view/OperationsListView'

/**
 * SCR-049 Operations — made-up data only: an invented factory's operation library (cutting, sewing, assembly, finishing,
 * inspection, packing), minutes invented. Role cases: the Owner, a product developer (keeps the library), quality and
 * sales (sales does not read routings: no access).
 */

const op = (n: number, fields: Partial<OperationRow> & Pick<OperationRow, 'code' | 'name' | 'workCentreKind' | 'standardMinutes'>): OperationRow => ({
  id: uid('4901', n),
  companyId: COMPANY_ID,
  nameI18n: null,
  machineType: null,
  skill: null,
  status: 'ACTIVE',
  usedIn: 0,
  differing: 0,
  version: 2,
  updatedAt: at(25, 11),
  ...fields,
})

export const OPERATIONS: OperationRow[] = [
  op(1, { code: 'DEMO-TAG-PELLE', name: 'Taglio pelle a mano', nameI18n: { it: 'Taglio pelle a mano', en: 'Hand cut leather' }, workCentreKind: 'CUTTING', machineType: 'Banco di taglio', skill: 'Tagliatore pelle', standardMinutes: '18.5', usedIn: 4 }),
  op(2, { code: 'DEMO-CUC-SPALLA', name: 'Cucitura spalla', nameI18n: { it: 'Cucitura spalla', en: 'Sew shoulder seam' }, workCentreKind: 'SEWING', machineType: 'Piana 1 ago', skill: 'Cucitrice', standardMinutes: '6.2', usedIn: 5, differing: 2 }),
  op(3, { code: 'DEMO-CUC-ZIP', name: 'Montaggio zip anteriore', workCentreKind: 'SEWING', machineType: 'Piana 2 aghi', skill: 'Cucitrice', standardMinutes: '9.75', usedIn: 3 }),
  op(4, { code: 'DEMO-PROT-SPALLA', name: 'Inserimento protezione spalla', workCentreKind: 'ASSEMBLY', standardMinutes: '2.4', usedIn: 5, differing: 1 }),
  op(5, { code: 'DEMO-RIF-BORDI', name: 'Rifinitura bordi', workCentreKind: 'FINISHING', machineType: 'Pressa', standardMinutes: '4' }),
  op(6, { code: 'DEMO-CQ-FINALE', name: 'Controllo finale capo', workCentreKind: 'INSPECTION', skill: 'Controllo qualità', standardMinutes: '5.5', usedIn: 6 }),
  op(7, { code: 'DEMO-IMB', name: 'Imballo capo', workCentreKind: 'PACKING', standardMinutes: '1.8', usedIn: 2 }),
  op(8, { code: 'DEMO-CUC-OLD', name: 'Cucitura tasca vecchia', workCentreKind: 'SEWING', standardMinutes: '3.1', status: 'ARCHIVED', usedIn: 1 }),
]

const open = OPERATIONS.filter((row) => row.status === 'ACTIVE')
const base: OperationsListViewModel = {
  prefix: PREFIX,
  can: canFor('owner'),
  filters: { view: 'open', q: '', kind: '' },
  rows: { items: open, more: false, count: open.length, problem: null },
  tiles: { unused: 1, differs: 2 },
  asOf: NOW,
  updates: 0,
  newOperation: null,
  busy: false,
  notice: null,
}
const newOperation = (extra: Partial<NewOperationModel['draft']> = {}, more: Partial<NewOperationModel> = {}): NewOperationModel => ({
  draft: { ...emptyDraft(COMPANY_ID), ...extra },
  companies: [
    { id: COMPANY_ID, name: 'Officina Demo S.r.l.' },
    { id: '0190f0e2-1111-7000-8000-000000000002', name: 'Pelletteria Esempio S.p.A.' },
  ],
  busy: false,
  problem: null,
  refused: [],
  ...more,
})

export const designScreen = defineDesignScreen<OperationsListViewModel>({
  screen: 'SCR-049',
  title: 'Operations',
  view: OperationsListView,
  cases: [
    { id: 'owner', label: 'Owner: the active operations', model: base, note: 'Tiles = saved views; SMV per garment; "used in 6 routings · 2 with other minutes".' },
    { id: 'developer', label: 'Product developer', model: { ...base, can: canFor('developer') }, note: 'Keeps the library (product.operations.manage). No money anywhere.' },
    { id: 'quality', label: 'Quality (reads)', model: { ...base, can: canFor('quality') }, note: 'Reads the library; New operation and Archive held with their reason.' },
    { id: 'selected', label: 'Two rows selected', model: { ...base, selected: [OPERATIONS[1]!.id, OPERATIONS[4]!.id] }, note: 'Export 2, Archive 2; the header box is mixed.' },
    { id: 'archive-dialog', label: 'Archive 2', model: { ...base, selected: [OPERATIONS[1]!.id, OPERATIONS[4]!.id], dialog: 'archive' }, note: 'Routings keep their copied steps.' },
    { id: 'archived-selected', label: 'Archived ones selected', model: { ...base, filters: { ...base.filters, view: 'archived' }, rows: { items: [OPERATIONS[7]!], more: false, count: 1, problem: null }, selected: [OPERATIONS[7]!.id] }, note: 'Reactivate 1 in place of Archive.' },
    { id: 'tile-differs', label: 'Tile: minutes differ', model: { ...base, filters: { ...base.filters, view: 'differs' }, rows: { items: [OPERATIONS[1]!, OPERATIONS[3]!], more: false, count: 2, problem: null } } },
    { id: 'tile-unused', label: 'Tile: in no routing', model: { ...base, filters: { ...base.filters, view: 'unused' }, rows: { items: [OPERATIONS[4]!], more: false, count: 1, problem: null } } },
    { id: 'filtered', label: 'Filtered: sewing, searched', model: { ...base, filters: { view: 'open', q: 'zip', kind: 'SEWING' }, rows: { items: [OPERATIONS[2]!], more: false, count: 1, problem: null } } },
    { id: 'many', label: 'More than a page', model: { ...base, rows: { items: open, more: true, count: 96, problem: null } } },
    { id: 'updates', label: 'Live changes waiting', model: { ...base, updates: 1 } },
    { id: 'notice', label: 'After archiving two', model: { ...base, notice: { key: 'operations.notice.archived', tone: 'success', params: { count: 2 } } } },
    { id: 'new', label: 'New operation', model: { ...base, newOperation: newOperation() }, note: 'Create held until code, name and minutes are given; ⌘↵ creates.' },
    { id: 'new-filled', label: 'New operation, filled', model: { ...base, newOperation: newOperation({ code: 'DEMO-CUC-MANICA', name: 'Cucitura manica', nameIt: 'Cucitura manica', nameEn: 'Sew sleeve', machineType: 'Piana 1 ago', skill: 'Cucitrice', minutes: '7,25', instructions: 'Cucire con punto 3,5 mm; rinforzare a fine cucitura.' }) } },
    { id: 'new-refused', label: 'New operation: code taken', model: { ...base, newOperation: newOperation({ code: 'DEMO-CUC-SPALLA', name: 'Cucitura spalla', minutes: '6' }, { problem: 'problem.write.codeTaken', refused: ['code'] }) } },
    { id: 'no-match', label: 'Nothing matches', model: { ...base, filters: { view: 'open', q: 'zzz', kind: '' }, rows: { items: [], more: false, count: 0, problem: null } } },
    { id: 'empty', label: 'No operations yet', model: { ...base, rows: { items: [], more: false, count: 0, problem: null }, tiles: { unused: 0, differs: 0 } } },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { items: null, more: false, count: null, problem: null }, tiles: { unused: null, differs: null }, asOf: null } },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { items: null, more: false, count: null, problem: 'problem.read.unavailable' }, tiles: { unused: null, differs: null } } },
    { id: 'no-permission', label: 'No access (sales)', model: { ...base, can: canFor('sales'), rows: { items: null, more: false, count: null, problem: 'problem.read.forbidden' }, tiles: {} }, note: 'Sales does not read routings: the page is absent from its navigation; a direct address says who has it.' },
  ],
})

/** The shoulder seam's record: used in six routings, two of them (one a draft) with other minutes. */
export const SHOULDER: OperationView = {
  ...OPERATIONS[1]!,
  instructions: 'Cucire la spalla con punto 3,5 mm e ribattere a 6 mm dal bordo.',
  createdAt: at(3),
  createdById: uid('4705', 1),
  whereUsed: [
    { style: { id: uid('4101', 1), code: 'DEMO-JKT-01', name: 'Giacca Touring Demo' }, revision: { id: uid('4102', 3), revision: 3, status: 'DRAFT' }, stepId: uid('4903', 1), seq: 30, standardMinutes: '6.6', difference: '0.4' },
    { style: { id: uid('4101', 1), code: 'DEMO-JKT-01', name: 'Giacca Touring Demo' }, revision: { id: uid('4102', 2), revision: 2, status: 'RELEASED' }, stepId: uid('4903', 2), seq: 30, standardMinutes: '6.6', difference: '0.4' },
    { style: { id: uid('4101', 2), code: 'DEMO-JKT-02', name: 'Giacca Racing Demo' }, revision: { id: uid('4102', 5), revision: 1, status: 'RELEASED' }, stepId: uid('4903', 3), seq: 20, standardMinutes: '6.2', difference: '0' },
    { style: { id: uid('4101', 3), code: 'DEMO-VST-01', name: 'Gilet Demo' }, revision: { id: uid('4102', 7), revision: 1, status: 'DRAFT' }, stepId: uid('4903', 4), seq: 20, standardMinutes: '6.2', difference: '0' },
    { style: { id: uid('4101', 4), code: 'DEMO-JKT-03', name: 'Giacca Estiva Demo' }, revision: { id: uid('4102', 8), revision: 1, status: 'OBSOLETE' }, stepId: uid('4903', 5), seq: 40, standardMinutes: '5.9', difference: '-0.3' },
  ],
}
