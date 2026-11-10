import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, canFor, COMPANY_ID, NOW, PREFIX, uid } from '../library/demo'
import { demoSheetImport } from '../styles/demo/fixtures'
import type { OperationRow, OperationView } from './api'
import { emptyDraft } from './model'
import { OperationsListView, type NewOperationModel, type OperationsListViewModel } from './view/OperationsListView'
// B-W2b-235: the tile "SMV changes waiting for approval", its rows, Propose SMV change from the SMV cell (made-up data).
import { minutesModel, READER_ID, WAITING } from './depth/demo'
import type { WaitingModel } from './depth/use-waiting'

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
  importHeld: null,
  sheetImport: null,
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
    { id: 'import', label: 'W2a: Import — the sheet', model: { ...base, sheetImport: demoSheetImport('product.operations', 'upload') }, note: 'Importer "Operations", keyed by code: new operations and changed names, departments (Italian names too), minutes, machines; nothing written before Apply.' },
    { id: 'import-check', label: 'W2a: Import — the dry run', model: { ...base, sheetImport: demoSheetImport('product.operations', 'planned') }, note: '1 new, 3 changed (6,2 → 6,5 min), 1 refused row; routings keep their copied minutes (Where used offers the update).' },
    { id: 'import-result', label: 'W2a: Import — applied', model: { ...base, sheetImport: demoSheetImport('product.operations', 'applied') } },
    { id: 'import-held', label: 'W2a: Import held (quality reads)', model: { ...base, can: canFor('quality'), importHeld: 'held.noManage' }, note: 'Import and New operation held with their reason.' },
    { id: 'import-held-right', label: 'W2a: Import held (no import right)', model: { ...base, importHeld: 'operations.import.held' } },
    { id: 'no-match', label: 'Nothing matches', model: { ...base, filters: { view: 'open', q: 'zzz', kind: '' }, rows: { items: [], more: false, count: 0, problem: null } } },
    { id: 'empty', label: 'No operations yet', model: { ...base, rows: { items: [], more: false, count: 0, problem: null }, tiles: { unused: 0, differs: 0 } } },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { items: null, more: false, count: null, problem: null }, tiles: { unused: null, differs: null }, asOf: null } },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { items: null, more: false, count: null, problem: 'problem.read.unavailable' }, tiles: { unused: null, differs: null } } },
    { id: 'no-permission', label: 'No access (sales)', model: { ...base, can: canFor('sales'), rows: { items: null, more: false, count: null, problem: 'problem.read.forbidden' }, tiles: {} }, note: 'Sales does not read routings: the page is absent from its navigation; a direct address says who has it.' },
    // ---- B-W2b-235: SMV changes waiting for approval, Propose SMV change from the SMV cell ------------------------------------
    { id: 'w2b-235-tile', label: 'W2b: the tile "SMV changes waiting"', model: w2b(), note: 'A third tile counts the SMV changes waiting for approval (3); the SMV cell has Propose SMV change (pencil) for a production manager; ⋯ adds "Minutes and SMV versions" and Propose SMV change.' },
    { id: 'w2b-235-waiting', label: 'W2b: the waiting changes', model: w2b({ filters: { view: 'smv', q: '', kind: '' } }), note: 'Old → new SMV, from which day, why, who proposed it; oldest first. The change the reader proposed (DEMO-TAG-PELLE) is not selectable: its box says a second person decides it.' },
    { id: 'w2b-235-waiting-selected', label: 'W2b: Approve 2', model: w2b({ filters: { view: 'smv', q: '', kind: '' }, waitingSelected: [WAITING[0]!.proposal.id, WAITING[2]!.proposal.id], waitingConfirm: true }), note: 'Each takes effect on its day; one approval per change, at its version.' },
    { id: 'w2b-235-waiting-empty', label: 'W2b: nothing waiting', model: w2b({ filters: { view: 'smv', q: '', kind: '' }, waiting: waitingModel({ count: 0, entries: [] }) }) },
    { id: 'w2b-235-waiting-loading', label: 'W2b: waiting changes loading', model: w2b({ filters: { view: 'smv', q: '', kind: '' }, waiting: waitingModel({ count: null, entries: null }) }) },
    { id: 'w2b-235-waiting-error', label: 'W2b: waiting changes could not load', model: w2b({ filters: { view: 'smv', q: '', kind: '' }, waiting: waitingModel({ count: null, entries: null, problem: 'problem.read.unavailable' }) }), note: 'The tile says "—" (never 0); the view says why with Try again.' },
    { id: 'w2b-235-propose', label: 'W2b: Propose SMV change from the SMV cell', model: w2b({ smvChange: minutesModel('developer', {}, { pending: false }) }), note: 'Old → new SMV from basic time and allowances (5.5 min + 5 % + 4.5 % + 3.2273 % = 6.2), where the time comes from, the day (from today), why; the routings and piece rates it reaches. Send for approval held until the reason is typed.' },
    { id: 'w2b-235-propose-loading', label: 'W2b: Propose SMV change, minutes being read', model: w2b({ smvChange: minutesModel('developer', { part: { status: 'loading' } }) }) },
    { id: 'w2b-235-proposed', label: 'W2b: after Send for approval', model: w2b({ smvNotice: { key: 'notice.proposed', tone: 'success', params: { code: 'DEMO-CUC-SPALLA' } } }) },
    { id: 'w2b-235-quality', label: 'W2b: quality (reads, proposes nothing)', model: w2b({ can: canFor('quality'), canPropose: false, waiting: waitingModel({ entries: WAITING.map((entry) => ({ ...entry, mayDecide: false })) }) }), note: 'No pencil in the SMV cell; the waiting rows are read only (no approve right, said on each box).' },
  ],
})

/** B-W2b-235: the waiting changes as the list reads them. */
function waitingModel(overrides: Partial<WaitingModel> = {}): WaitingModel {
  return { count: WAITING.length, entries: WAITING, problem: null, busy: false, notice: null, ...overrides }
}

/** B-W2b-235: the list with its W2b parts, for a production manager (proposes and approves). */
function w2b(overrides: Partial<OperationsListViewModel> = {}): OperationsListViewModel {
  return { ...base, can: canFor('developer'), waiting: waitingModel(), canPropose: true, userId: READER_ID, ...overrides }
}

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
