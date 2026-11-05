import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import {
  CABINETS,
  CHEMICAL_ROLES_DEMO,
  CHEMICALS,
  CHOICES,
  COUNTS,
  DEMO_PDF,
  GLUE,
  glueRecord,
  inChemicalsShell,
  LIBRARY,
  listAnswer,
  OLD,
  ORIGIN,
  PREFIX,
  SCOPE_ALL,
  SCOPE_ONE,
  SITE_N,
  SOLVENT,
  SOUTH,
  TODAY,
  NOW,
  type ChemicalRoleDemo,
} from './_demo/fixtures'
import { chemicalsCan, draftOf, EMPTY_ADDRESS, EMPTY_DRAFT, sheetDraft, type ChemicalsAddress } from './model'
import type { ChemicalsPageModel, OpenState } from './view-model'
import { ChemicalsPageView } from './view/ChemicalsPageView'

/**
 * SCR-213 — Plant › Health & safety › Chemicals & waste (B-W2b-143; design plant.chemicals). Made-up data only (./_demo): an
 * invented company with two sites, invented products, suppliers, roles and PPE, a made-up one-page sheet. Roles from
 * factory-domain's templates: the safety officer keeps the register; the production manager and read-only look; sales has no
 * safety.view. The labels and notes are English (the design index only); the screen's words come from the catalogues.
 */

interface ChemicalsCase {
  role: ChemicalRoleDemo
  model: ChemicalsPageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }

function base(role: ChemicalRoleDemo, over: Partial<ChemicalsPageModel> = {}, address: Partial<ChemicalsAddress> = {}, scope: OfficeScope = SCOPE_ONE): ChemicalsCase {
  const can = chemicalsCan(CHEMICAL_ROLES_DEMO[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      scope,
      companyId: scope.company?.id ?? null,
      address: { ...EMPTY_ADDRESS, ...address },
      today: TODAY,
      origin: ORIGIN,
      counts: ready(COUNTS),
      register: ready(listAnswer({ canManage: can.manage, chemicals: CHEMICALS.map((row) => ({ ...row, canManage: can.manage })) })),
      library: ready({ ...LIBRARY, sheets: LIBRARY.sheets.map((row) => ({ ...row, canManage: can.manage })) }),
      readAt: NOW,
      notice: null,
      selected: [],
      add: null,
      open: null,
      archiveMany: null,
      qr: null,
      ...over,
    },
  }
}

const open = (over: Partial<OpenState> = {}): OpenState => ({
  id: GLUE.id,
  read: ready(glueRecord()),
  mode: 'view',
  draft: null,
  choices: null,
  sheet: sheetDraft('it'),
  reason: '',
  busy: false,
  problem: null,
  pdf: { sheetId: GLUE.current[0]!.id, read: ready({ bytes: DEMO_PDF, fileName: GLUE.current[0]!.fileName }) },
  saved: null,
  ...over,
})

const addState = (over: Partial<NonNullable<ChemicalsPageModel['add']>> = {}): NonNullable<ChemicalsPageModel['add']> => ({ draft: { ...EMPTY_DRAFT, siteId: SITE_N.id }, sheet: sheetDraft('it'), choices: ready(CHOICES), busy: false, problem: null, addedWithoutSheet: null, ...over })

const filled = {
  ...EMPTY_DRAFT,
  siteId: SITE_N.id,
  name: 'Primer Demo P2',
  supplierMode: 'party' as const,
  supplierPartyId: CHOICES.suppliers[1]!.id,
  use: 'PRIMER' as const,
  ghsPictograms: ['GHS02', 'GHS07'],
  signalWord: 'DANGER' as const,
  hazards: 'H225 H319',
  precautions: 'P210 P280',
  storagePlace: 'Armadio infiammabili, finissaggio',
  cabinetCode: 'CAB-FIN-1',
  maxQuantity: '2,5',
  maxQuantityUnit: 'L' as const,
  roleSheetIds: [CHOICES.roles[2]!.id],
  ppeItemIds: [CHOICES.ppe[0]!.id],
}

function ChemicalsDesign({ model }: { model: ChemicalsCase }) {
  return inChemicalsShell('/plant/chemicals', createElement(ChemicalsPageView, { model: model.model }), model.role, model.model.scope)
}

export const designScreen = defineDesignScreen<ChemicalsCase>({
  screen: 'SCR-213',
  title: 'Chemicals & waste (Plant › Health & safety)',
  view: ChemicalsDesign,
  cases: [
    {
      id: 'normal',
      label: 'Safety officer: the register and the SDS library',
      model: base('safety'),
      note: 'Tiles (products in use, without SDS, SDS to request, cabinets) · the register with GHS pictogram stand-ins, H and P codes, place and cabinet, most kept, roles, SDS version and date (a product with none, one with none in Italian) · the SDS library with the superseded versions kept and the product with no sheet above it. c adds a chemical.',
    },
    { id: 'all-sites', label: 'All sites: a Site column and the site chip', model: base('safety', { register: ready(listAnswer({ chemicals: [...CHEMICALS, SOUTH] })) }, {}, SCOPE_ALL) },
    { id: 'tile-without', label: 'Tile "Products without SDS" as the filter', model: base('safety', { register: ready(listAnswer({ chemicals: [SOLVENT] })) }, { tile: 'withoutSds' }) },
    { id: 'archived', label: 'Archived products (status filter)', model: base('safety', { register: ready(listAnswer({ chemicals: [OLD] })) }, { status: 'ARCHIVED' }) },
    { id: 'selected', label: 'Two rows chosen: Archive 2 and Export 2', model: base('safety', { selected: [CHEMICALS[2]!.id, CHEMICALS[3]!.id] }) },
    { id: 'archive-many', label: 'Archive 2: one reason for both', model: base('safety', { selected: [CHEMICALS[2]!.id, CHEMICALS[3]!.id], archiveMany: { ids: [CHEMICALS[2]!.id, CHEMICALS[3]!.id], reason: '', busy: false } }), note: 'Held "Say why it is no longer in use." until a reason is typed.' },
    { id: 'empty', label: 'Empty register: "Add your glues and solvents first"', model: base('safety', { counts: ready({ active: 0, withoutSds: 0, toRequest: 0, cabinets: 0 }), register: ready(listAnswer({ chemicals: [] })), library: ready({ sheets: [], missing: [] }) }) },
    { id: 'filtered-empty', label: 'Filters match nothing', model: base('safety', { register: ready(listAnswer({ chemicals: [] })) }, { q: 'nitro', use: 'DYE' }) },
    { id: 'loading', label: 'Loading: each section in its shape', model: base('safety', { counts: loading, register: loading, library: loading, readAt: null }) },
    { id: 'error', label: 'Failed reads: said with Try again, never drawn as empty', model: base('safety', { counts: failed, register: failed, library: failed }) },
    { id: 'read-only', label: 'Production manager: reads; Add chemical held with the reason', model: base('production') },
    { id: 'read-only-role', label: 'Read-only role', model: base('readOnly') },
    { id: 'no-permission', label: 'Sales: no safety.view', model: base('sales') },
    { id: 'notice', label: 'After Add chemical: the notice', model: base('safety', { notice: { tone: 'success', key: 'notice.added', params: { name: 'Primer Demo P2' } } }) },
    { id: 'bulk-result', label: 'After Archive 2: one refused, said in words', model: base('safety', { notice: { tone: 'warning', key: 'bulk.archivedResult', params: { count: 1 }, refused: [{ label: 'Olio macchine Demo 22', key: 'problem.conflict' }] } }) },
    { id: 'add', label: 'Add chemical: empty, Add held "Choose what it is used for."', model: base('safety', { add: addState() }, { add: true }) },
    { id: 'add-filled', label: 'Add chemical: filled, with the first SDS', model: base('safety', { add: addState({ draft: filled, sheet: { file: { name: 'SDS primer demo 2.0.pdf', type: 'application/pdf', size: 210_000 }, versionLabel: '2.0', revisedOn: '2026-10-02', language: 'it' } }) }, { add: true }) },
    { id: 'add-bad-codes', label: 'Add chemical: a code CLP would not take, said at its field', model: base('safety', { add: addState({ draft: { ...filled, hazards: 'H225 H31', maxQuantityUnit: '' } }) }, { add: true }) },
    { id: 'add-all-sites', label: 'Add chemical with "All sites": the site is chosen in the dialog', model: base('safety', { add: addState({ draft: { ...EMPTY_DRAFT, siteId: null }, choices: null }) }, { add: true }, SCOPE_ALL) },
    { id: 'add-refused', label: 'Add chemical refused: a role of another site', model: base('safety', { add: addState({ draft: filled, problem: { key: 'refusal.ROLE_OTHER_SITE', field: 'roleSheetIds' } }) }, { add: true }) },
    { id: 'add-sheet-refused', label: 'Added, but its sheet was not taken: open it to add the sheet', model: base('safety', { add: addState({ draft: filled, addedWithoutSheet: SOLVENT.id, problem: { key: 'refusal.FILE_NOT_READY', field: 'fileId' } }) }, { add: true }) },
    {
      id: 'chemical',
      label: 'The chemical: facts, sheets (current and superseded) and the PDF',
      model: base('safety', { open: open() }, { open: GLUE.id }),
      note: 'J / K move through the register; Replace SDS is the primary action; Edit and Archive beside it.',
    },
    { id: 'chemical-saved', label: 'After Replace SDS: the new version is current, the old one kept', model: base('safety', { open: open({ saved: { key: 'saved.replaced', params: { version: '3.1', old: '3.0' } } }) }, { open: GLUE.id }) },
    { id: 'chemical-pdf-loading', label: 'The PDF still reading', model: base('safety', { open: open({ pdf: { sheetId: GLUE.current[0]!.id, read: loading } }) }, { open: GLUE.id }) },
    { id: 'chemical-pdf-failed', label: 'The PDF failed: Try again', model: base('safety', { open: open({ pdf: { sheetId: GLUE.current[0]!.id, read: failed } }) }, { open: GLUE.id }) },
    { id: 'chemical-no-sheet', label: 'A product with no sheet yet', model: base('safety', { open: open({ id: SOLVENT.id, read: ready({ chemical: SOLVENT, sheets: [], today: TODAY }), pdf: null }) }, { open: SOLVENT.id }) },
    { id: 'chemical-loading', label: 'The window loading', model: base('safety', { open: open({ read: loading, pdf: null }) }, { open: GLUE.id }) },
    { id: 'chemical-error', label: 'The window failed', model: base('safety', { open: open({ read: failed, pdf: null }) }, { open: GLUE.id }) },
    { id: 'chemical-read-only', label: 'Production manager: Replace SDS, Edit, Archive held with the reason', model: base('production', { open: open({ read: ready(glueRecord({ chemical: { ...GLUE, canManage: false } })) }) }, { open: GLUE.id }) },
    { id: 'chemical-edit', label: 'Edit: the same fields as Add; Save held "Nothing changed."', model: base('safety', { open: open({ mode: 'edit', draft: draftOf(GLUE), choices: ready(CHOICES) }) }, { open: GLUE.id, mode: 'edit' }) },
    {
      id: 'chemical-replace',
      label: 'Replace SDS: the new PDF and what it supersedes',
      model: base('safety', { open: open({ mode: 'replace', sheet: { file: { name: 'SDS colla demo v3.2 it.pdf', type: 'application/pdf', size: 190_000 }, versionLabel: '3.2', revisedOn: '2026-10-28', language: 'it' } }) }, { open: GLUE.id, mode: 'replace' }),
      note: 'Says "Version 3.1 in Italian will be kept, superseded." and that the site\'s tablets take the new sheet at their next connection.',
    },
    { id: 'chemical-replace-older', label: 'Replace SDS refused before sending: older than the current one', model: base('safety', { open: open({ mode: 'replace', sheet: { file: { name: 'SDS vecchia.pdf', type: 'application/pdf', size: 90_000 }, versionLabel: '2.9', revisedOn: '2023-01-10', language: 'it' } }) }, { open: GLUE.id, mode: 'replace' }) },
    { id: 'chemical-replace-empty', label: 'Replace SDS: held "Choose the sheet\'s PDF."', model: base('safety', { open: open({ mode: 'replace' }) }, { open: GLUE.id, mode: 'replace' }) },
    { id: 'chemical-archive', label: 'Archive: the reason; its sheets are kept', model: base('safety', { open: open({ mode: 'archive', reason: 'Non più acquistata' }) }, { open: GLUE.id, mode: 'archive' }) },
    { id: 'chemical-archived', label: 'An archived product: Put back in use; Replace SDS held', model: base('safety', { open: open({ id: OLD.id, read: ready({ chemical: OLD, sheets: OLD.current, today: TODAY }), pdf: { sheetId: OLD.current[0]!.id, read: ready({ bytes: DEMO_PDF, fileName: OLD.current[0]!.fileName }) } }) }, { open: OLD.id }) },
    { id: 'qr', label: 'Print cabinet QR: the label to scale with the QR to its list', model: base('safety', { qr: { cabinets: ready(CABINETS), chosen: `${CABINETS[1]!.siteId}|${CABINETS[1]!.code}` } }, { qr: true }), note: 'Print opens the cabinet sheet (the label and every product) in a new tab.' },
    { id: 'qr-without-sheet', label: 'A cabinet with a product still without its sheet', model: base('safety', { qr: { cabinets: ready(CABINETS), chosen: `${CABINETS[0]!.siteId}|${CABINETS[0]!.code}` } }, { qr: true }) },
    { id: 'qr-empty', label: 'No cabinet yet: Print held', model: base('safety', { qr: { cabinets: ready([]), chosen: null } }, { qr: true }) },
    { id: 'qr-loading', label: 'Print cabinet QR loading', model: base('safety', { qr: { cabinets: loading, chosen: null } }, { qr: true }) },
    { id: 'qr-error', label: 'Print cabinet QR failed', model: base('safety', { qr: { cabinets: failed, chosen: null } }, { qr: true }) },
    { id: 'keys', label: 'Keyboard shortcuts (?)', model: base('safety', { keysOpen: true }) },
  ],
})
