import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CAN, demoBom, demoRouting, demoSheetImport, demoStyle, LINE_MATERIALS, MATERIAL, MATERIAL_RESULTS, newStyle, recordModel, REV, REVISIONS, ROWS } from '../demo/fixtures'
import type { StyleRecordViewModel } from '../record/record-model'
import { StyleRecordView } from '../record/view/StyleRecordView'
// B-W2b-241: the BOM in depth (made-up data: depth/demo/fixtures.ts; the pattern pieces of B-W2b-95's design data).
import { demoPieces } from '../record/pieces/fixtures'
import { NO_PIECES } from '../record/pieces/pieces-model'
import { ALT_MATERIALS, demoDepthModel, demoStructure, demoUsedIn, depthBom, LINE_IDS, SUB_STYLES } from './depth/demo/fixtures'
import type { BomDepthModel } from './depth/model'
import { uid } from '../../library/demo'

/**
 * SCR-042 Materials (BOM) of DEMO-JKT-01 — made-up data only (demo/fixtures.ts): eight lines of the draft revision 3
 * (leather by size, lining, membrane, two protectors, a zip by colourway, thread, the care label); two things block its
 * release (leather size 58 has no quantity; the zip has no colour for ANTR). Per role: the Owner and the production
 * manager edit; a released revision is frozen.
 */

const bom = (overrides: Partial<StyleRecordViewModel> = {}, role: 'owner' | 'production' | 'product' = 'owner') => recordModel(role, { tab: 'bom', materials: LINE_MATERIALS, ...overrides })

/** B-W2b-241: the tab in depth — draft revision 3 with the kit and the liner, every part read, the pattern pieces read. */
const deep = (depth: Partial<BomDepthModel> & { check?: 'w1' | 'w2b' | 'none'; released?: boolean } = {}, overrides: Partial<StyleRecordViewModel> = {}, role: 'owner' | 'production' | 'product' = 'owner') =>
  recordModel(role, {
    tab: 'bom',
    materials: { ...LINE_MATERIALS, ...ALT_MATERIALS },
    bom: { status: 'ready', value: depthBom({ released: depth.released }) },
    pieces: { ...NO_PIECES, part: { status: 'ready', value: demoPieces({ revision: depth.released ? REVISIONS[1] : undefined }) } },
    bomDepth: demoDepthModel({ canManage: role !== 'product' || CAN.product.bomManage, ...depth }),
    ...overrides,
  })
const lineCase = (lineId: string, part: 'structure' | 'alternates', depth: Partial<BomDepthModel> = {}) => deep({ dialog: { kind: 'line', lineId, part }, ...depth })
const customers = { query: 'esem', results: [{ id: '0190f0e2-6666-7000-8000-000000000001', code: 'BR-DEMO', legalName: 'Marchio Esempio S.r.l.', tradeName: 'Esempio Moto' }, { id: '0190f0e2-6666-7000-8000-000000000002', code: 'CL-DEMO', legalName: 'Cliente Esempio S.p.A.', tradeName: null }], problem: null }

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
    { id: 'operations', label: 'W2b: lines tied to the operation that uses them', model: bom({ bom: { status: 'ready', value: demoBom({ tied: true }) } }), note: 'Column "Operation": the protectors at Op 70 · ASS-PROT, the zip at Op 50 · CUC-ZIP, the rest "Any operation".' },
    { id: 'line-operation', label: 'W2b: Edit a line — the operation that uses it', model: bom({ bom: { status: 'ready', value: demoBom({ tied: true }) }, routing: { status: 'ready', value: demoRouting() }, dialog: { kind: 'bomLine', lineId: demoBom().lines[3]!.id } }), note: 'Select "Operation that uses it": Any operation, or one of the revision\'s nine operations; the hint says what it changes on the floor.' },
    { id: 'line-operation-none', label: 'W2b: Edit a line — no routing yet', model: bom({ routing: { status: 'ready', value: demoRouting({ empty: true }) }, dialog: { kind: 'bomLine', lineId: demoBom().lines[3]!.id } }), note: 'Only "Any operation"; the hint says to add the operations first.' },
    // ---- B-W2b-241: the BOM in depth -----------------------------------------------------------------------------------
    { id: 'w2b-241-lines', label: 'W2b: lines in depth', model: deep(), note: 'Section column (filed or from the material), the kit 90 as the group row of the protectors 40 and 50 (one step in), the liner 100 a sub-assembly only for "Thermal liner: Yes"; alternates, who sends it (the label by the brand; leather and lining for the workshop). The leather card shows the grade mix and minimum grade per pattern piece.' },
    { id: 'w2b-241-check', label: 'W2b: the BOM check with W2b findings', model: deep({ check: 'w2b' }), note: 'Blocked material, circular sub-assembly, a draft sub-assembly, W1\'s two, and the warnings (PPE material not approved, archived alternate); Show me lands on the cell or opens the line at its part.' },
    { id: 'w2b-241-selected', label: 'W2b: two lines selected', model: deep({ selected: [LINE_IDS.shoulder, LINE_IDS.kit] }), note: 'Section… 2, Group… 2, Supply… 2 replace the toolbar.' },
    { id: 'w2b-241-section', label: 'W2b: Section… for 2 lines', model: deep({ selected: [LINE_IDS.shoulder, LINE_IDS.kit], dialog: { kind: 'section', lineIds: [LINE_IDS.shoulder, LINE_IDS.kit] } }) },
    { id: 'w2b-241-group', label: 'W2b: Group… for 2 lines', model: deep({ dialog: { kind: 'group', lineIds: [LINE_IDS.leather, LINE_IDS.lining] } }), note: 'Under a line of this BOM, or Not grouped; a line never under one grouped under it.' },
    { id: 'w2b-241-supply', label: 'W2b: Supply… for 2 lines', model: deep({ dialog: { kind: 'supply', lineIds: [LINE_IDS.membrane, LINE_IDS.shoulder] }, customers }), note: 'Who sends them (leave, we buy, a customer: searched), the workshop mark (leave, yes, no); Apply held until something changes.' },
    { id: 'w2b-241-supply-blocked', label: 'W2b: Supply… held (a sub-assembly)', model: deep({ dialog: { kind: 'supply', lineIds: [LINE_IDS.liner, LINE_IDS.shoulder] }, customers }), note: 'Choose "A customer sends them": held naming line 100 (a sub-assembly we make).' },
    { id: 'w2b-241-line', label: 'W2b: the line in depth (sub-assembly, option)', model: lineCase(LINE_IDS.liner, 'structure'), note: 'Section filed by hand, not grouped, sub-assembly DEMO-LNR-01 revision 2 with Open its BOM, we make it, the workshop mark, only for "Thermal liner: Yes" with the link to Options & rules. Each field saves by itself; ⌘↑ / ⌘↓ the next line.' },
    { id: 'w2b-241-line-group', label: 'W2b: the line in depth (a group row)', model: lineCase(LINE_IDS.kit, 'structure', { styles: { query: 'dem', results: SUB_STYLES.map((style, index) => ({ ...ROWS[index]!, id: style.id, code: style.code, name: style.name })), problem: null } }), note: 'Lines 40, 50 are grouped under it; a component we make: search the style of its sub-assembly.' },
    { id: 'w2b-241-line-sub-pick', label: 'W2b: the line in depth (sub-assembly revision)', model: lineCase(LINE_IDS.kit, 'structure', { subStyle: { status: 'ready', value: { id: SUB_STYLES[0]!.id, code: SUB_STYLES[0]!.code, name: SUB_STYLES[0]!.name, status: 'ACTIVE', revisions: [{ ...REVISIONS[1]!, id: uid('2418', 2), revision: 2 }, { ...REVISIONS[0]!, id: uid('2418', 3), revision: 3 }] } } }), note: 'Released first, then the draft (it would stop the release); Take revision 2.' },
    { id: 'w2b-241-line-customer', label: 'W2b: the line in depth (sent by the brand)', model: lineCase(LINE_IDS.label, 'structure', { customers }), note: 'The care label is sent by Esempio Moto: We buy it, or another customer.' },
    { id: 'w2b-241-line-held', label: 'W2b: the line in depth (no sub-assembly on leather)', model: lineCase(LINE_IDS.leather, 'structure'), note: 'Sub-assembly held: a bought material; the leather goes to the workshop cut.' },
    { id: 'w2b-241-alternates', label: 'W2b: alternates of a PPE line', model: lineCase(LINE_IDS.shoulder, 'alternates'), note: 'The protector\'s alternate needs approval and the certificate check (held on: a PPE component), no certificate covers it; move, remove; add by search.' },
    { id: 'w2b-241-alternates-add', label: 'W2b: add an alternate', model: lineCase(LINE_IDS.lining, 'alternates', { materials: { query: 'fod', results: MATERIAL_RESULTS, problem: null } }), note: 'Only when short, its note; the search leaves out the line\'s own material and its alternates.' },
    { id: 'w2b-241-alternate-remove', label: 'W2b: remove an alternate', model: deep({ dialog: { kind: 'removeAlternate', lineId: LINE_IDS.lining, alternateId: '0190f0e2-2412-7000-8000-000000000002' } }) },
    { id: 'w2b-241-by-size', label: 'W2b: By size on SizeColumns', model: deep({}, { bomView: 'sizes' }), note: 'Size 58 of the leather "— missing" in the error tone; the base 52 marked; type or paste; Fill… per line; the leather total under it.' },
    { id: 'w2b-241-by-size-marks', label: 'W2b: By size saving, refused, offline', model: deep({ offline: true, marks: { [`${LINE_IDS.leather}:58`]: { state: 'waiting', value: '8,45' }, [`${LINE_IDS.leather}:46`]: { state: 'refused', problem: 'mark.refused' } } }, { bomView: 'sizes' }), note: '58 waits offline ("…"), 46 refused ("!"); the banner counts what waits.' },
    { id: 'w2b-241-fill', label: 'W2b: Fill from base by increment', model: deep({ dialog: { kind: 'fill', lineId: LINE_IDS.leather } }, { bomView: 'sizes' }), note: 'The DS SizeFill in a sheet: base 52 = 7,4 ft², increment per size, the preview; Fill sends the changed sizes at once.' },
    { id: 'w2b-241-tree', label: 'W2b: Tree (sub-assemblies)', model: deep({}, { bomView: 'tree' }), note: 'Level 1 the liner (DEMO-LNR-01 r2, released), level 2 inside it the thermal panel (DEMO-PAD-01 r1); Open its BOM; used in DEMO-SET-01.' },
    { id: 'w2b-241-tree-empty', label: 'W2b: Tree, no sub-assemblies', model: deep({ structure: { status: 'ready', value: demoStructure({ noTree: true }) }, usedIn: { status: 'ready', value: demoUsedIn(true) } }, { bomView: 'tree' }) },
    { id: 'w2b-241-tree-loading', label: 'W2b: Tree loading', model: deep({ structure: { status: 'loading' }, usedIn: { status: 'idle' } }, { bomView: 'tree' }) },
    { id: 'w2b-241-tree-error', label: 'W2b: Tree could not load', model: deep({ structure: { status: 'error', problem: 'problem.read.unavailable' } }, { bomView: 'tree' }), note: 'The rest of the record stays usable.' },
    { id: 'w2b-241-depth-error', label: 'W2b: structure could not load', model: deep({ structure: { status: 'error', problem: 'problem.read.unavailable' }, depth: { status: 'error', problem: 'problem.read.unavailable' } }), note: 'The lines show without the W2b columns, W1\'s check stays; Try again.' },
    { id: 'w2b-241-depth-loading', label: 'W2b: structure loading', model: deep({ structure: { status: 'loading' }, depth: { status: 'loading' } }) },
    { id: 'w2b-241-notice', label: 'W2b: after a change', model: deep({ notice: { key: 'done.grouped', tone: 'success', params: { count: 2 } } }) },
    { id: 'w2b-241-offline', label: 'W2b: offline', model: deep({ offline: true, dialog: { kind: 'line', lineId: LINE_IDS.liner, part: 'structure' } }), note: 'Every change held "Offline — nothing is sent"; the line drawn as text.' },
    { id: 'w2b-241-released', label: 'W2b: released revision 2 (frozen)', model: deep({ released: true }, { style: { status: 'ready' as const, value: demoStyle() }, revisionId: REV.r2 }), note: 'Read only: selection held with why; the check is not shown (a frozen revision is not checked again).' },
    { id: 'w2b-241-read-only', label: 'W2b: a role that reads the BOM', model: deep({ canManage: false }, { can: { ...CAN.viewer } }, 'production'), note: 'No selection boxes; the line opens read only with why.' },
    { id: 'w2b-241-leather-none', label: 'W2b: leather with no pattern pieces yet', model: deep({}, { pieces: { ...NO_PIECES, part: { status: 'ready', value: demoPieces({ empty: true }) } } }), note: 'The leather card links to Files & patterns › Pattern pieces.' },
    { id: 'loading', label: 'Loading', model: bom({ bom: { status: 'loading' } }) },
    { id: 'error', label: 'Could not load', model: bom({ bom: { status: 'error', problem: 'problem.read.unavailable' } }), note: 'The rest of the record stays usable.' },
  ],
})
