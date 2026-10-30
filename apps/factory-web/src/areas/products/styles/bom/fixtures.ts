import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CAN, demoBom, demoSheetImport, demoStyle, LINE_MATERIALS, MATERIAL, MATERIAL_RESULTS, newStyle, recordModel, REV, REVISIONS } from '../demo/fixtures'
import type { StyleRecordViewModel } from '../record/record-model'
import { StyleRecordView } from '../record/view/StyleRecordView'

/**
 * SCR-042 Materials (BOM) of DEMO-JKT-01 — made-up data only (demo/fixtures.ts): eight lines of the draft revision 3
 * (leather by size, lining, membrane, two protectors, a zip by colourway, thread, the care label); two things block its
 * release (leather size 58 has no quantity; the zip has no colour for ANTR). Per role: the Owner and the production
 * manager edit; a released revision is frozen.
 */

const bom = (overrides: Partial<StyleRecordViewModel> = {}, role: 'owner' | 'production' | 'product' = 'owner') => recordModel(role, { tab: 'bom', materials: LINE_MATERIALS, ...overrides })
const released = { style: { status: 'ready' as const, value: demoStyle() }, revisionId: REV.r2, bom: { status: 'ready' as const, value: demoBom({ revision: REVISIONS[1] }) } }

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-042',
  title: 'Style studio: Materials (BOM)',
  view: StyleRecordView,
  cases: [
    { id: 'lines', label: 'Lines (draft revision 3)', model: bom(), note: 'The BOM check first, each finding with Show me; n adds a material; Alt+↑ / Alt+↓ move a line; v cycles the views.' },
    { id: 'by-size', label: 'By size', model: bom({ bomView: 'sizes' }), note: 'Decimals typed either way; size 58 is "— missing" in an error tone, never 0; the base size is marked; leather totals per size.' },
    { id: 'by-colourway', label: 'By colourway', model: bom({ bomView: 'colours' }), note: 'Only the material\'s own colours; the zip has no colour for ANTR.' },
    { id: 'production', label: 'Production manager', model: bom({}, 'production'), note: 'Edits the BOM; sees no money anywhere.' },
    { id: 'add-search', label: 'Add a material: search', model: bom({ dialog: { kind: 'bomLine', lineId: null }, materialSearch: { query: 'pel', results: MATERIAL_RESULTS, problem: null } }) },
    { id: 'add-chosen', label: 'Add a material: chosen', model: bom({ dialog: { kind: 'bomLine', lineId: null }, lineDraft: { material: MATERIAL }, materials: { ...LINE_MATERIALS, [MATERIAL.id]: MATERIAL } }), note: 'Leather: the wastage hint says the hide\'s yield goes in it; Cr VI test per lot is said.' },
    { id: 'edit-line', label: 'Edit a line', model: bom({ dialog: { kind: 'bomLine', lineId: demoBom().lines[5]!.id } }) },
    { id: 'remove-line', label: 'Remove a line', model: bom({ dialog: { kind: 'removeLine', lineId: demoBom().lines[7]!.id } }) },
    { id: 'released', label: 'Released revision 2 (frozen)', model: bom(released), note: 'Read only with the banner: Go to revision 3 (draft).' },
    { id: 'empty', label: 'No materials yet', model: recordModel('owner', { tab: 'bom', style: { status: 'ready', value: newStyle() }, revisionId: REV.r1, bom: { status: 'ready', value: demoBom({ revision: { ...REVISIONS[2]!, status: 'DRAFT' }, empty: true }) }, compliance: { status: 'idle' } }) },
    { id: 'no-revision', label: 'No revision yet', model: recordModel('owner', { tab: 'bom', style: { status: 'ready', value: { ...newStyle(), revisions: [] } }, revisionId: null, bom: { status: 'idle' }, compliance: { status: 'idle' } }) },
    { id: 'import-upload', label: 'W2a: Import BOM — the sheet', model: bom({ bomImport: demoSheetImport('product.bom', 'upload') }), note: 'The import flow on importer "BOM lines": each row names its style and place (export first, edit, import); numbers as written; nothing is written before Apply.' },
    { id: 'import-check', label: 'W2a: Import BOM — the dry run', model: bom({ bomImport: demoSheetImport('product.bom', 'planned') }), note: 'The columns read, 1 new and 2 changed lines (before → after), 1 refused row in our sentence with the API\'s quoted (a style without a draft); Apply 3.' },
    { id: 'import-result', label: 'W2a: Import BOM — applied', model: bom({ bomImport: demoSheetImport('product.bom', 'applied') }), note: 'Closing reads the BOM again.' },
    { id: 'import-no-apply', label: 'W2a: Import BOM without the apply right', model: bom({ bomImport: demoSheetImport('product.bom', 'planned', { run: true, apply: false }) }), note: 'Apply held with its reason.' },
    { id: 'import-held-frozen', label: 'W2a: Import held on a released revision', model: bom({ ...released, style: { status: 'ready', value: demoStyle({ revisions: [REVISIONS[1]!, REVISIONS[2]!] }) } }), note: 'Import BOM: "Start revision 3 first" (rows go into a draft); Export ▾ still offers XLSX, CSV and PDF.' },
    { id: 'import-held-right', label: 'W2a: Import held (no import right)', model: bom({ can: { ...CAN.product, imports: false } }, 'product'), note: 'Import BOM: "Your role cannot load sheets".' },
    { id: 'exporting', label: 'W2a: Export being made', model: bom({ exporting: 'xlsx' }), note: 'Export ▾ says "Making the file…" until the download starts.' },
    { id: 'loading', label: 'Loading', model: bom({ bom: { status: 'loading' } }) },
    { id: 'error', label: 'Could not load', model: bom({ bom: { status: 'error', problem: 'problem.read.unavailable' } }), note: 'The rest of the record stays usable.' },
  ],
})
