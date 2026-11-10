import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANY_ID, NOW, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../library/demo'
import { colourDraftOf, coloursCan, NO_FILTERS, setDraftOf, type BrandingSetRow, type BrandingSetView, type ColourCountsView, type ColourLibraryRow, type SetDraft } from './model'
import type { ColourFormModel, ColoursViewModel, NewSetModel, SetModalModel } from './view-model'
import { ColoursView } from './view/ColoursView'

/**
 * SCR-118 Colours & artwork — made-up data only (PLAN §3.1): an invented factory's colour library (DEMO- codes, made-up
 * Pantone / RAL / NCS references used only as format examples), two made-up private-label customers and their branding
 * sets, pictures drawn as plain inline SVG (design data only). Role cases: the Owner, a product developer (the production
 * manager's template: keeps colours and sets), sales (keeps sets, reads colours), quality (reads).
 */

const svg = (fill: string, text: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${fill}"/><text x="32" y="38" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#ffffff">${text}</text></svg>`)}`

const colour = (n: number, code: string, name: string, extra: Partial<ColourLibraryRow> = {}): ColourLibraryRow => ({
  id: uid('4701', n),
  companyId: null,
  code,
  name,
  names: {},
  system: null,
  reference: null,
  family: null,
  hex: null,
  photo: null,
  use: { materialColours: 0, colourways: 0, brandingSets: 0, inUse: false },
  status: 'ACTIVE',
  version: 1,
  updatedAt: NOW,
  ...extra,
})

const ROWS: ColourLibraryRow[] = [
  colour(1, 'DEMO-BLK', 'Nero', { names: { it: 'Nero', en: 'Black' }, system: 'RAL', reference: 'RAL 9005', family: 'nero', hex: '#111111', photo: { fileId: uid('4702', 1), name: 'demo black.png', url: svg('#111111', 'BLK') }, use: { materialColours: 4, colourways: 6, brandingSets: 1, inUse: true } }),
  colour(2, 'DEMO-RED', 'Rosso corsa', { names: { it: 'Rosso corsa', en: 'Racing red' }, system: 'PANTONE', reference: '18-1662 TCX', family: 'rosso', hex: '#C8102E', use: { materialColours: 2, colourways: 3, brandingSets: 1, inUse: true } }),
  colour(3, 'DEMO-GRY', 'Grigio antracite', { names: { en: 'Anthracite' }, system: 'NCS', reference: 'S 7500-N', family: 'grigio', hex: '#3D3F42', use: { materialColours: 1, colourways: 2, brandingSets: 0, inUse: true } }),
  colour(4, 'DEMO-WHT', 'Bianco ottico', { system: 'RAL', reference: 'RAL 9016', family: 'bianco', hex: '#F6F6F6', use: { materialColours: 0, colourways: 1, brandingSets: 0, inUse: true } }),
  colour(5, 'DEMO-HIVIS', 'Giallo alta visibilità', { companyId: COMPANY_ID, names: { en: 'Hi-vis yellow' }, system: 'PANTONE', reference: '803 C', family: 'giallo', hex: '#E8F000', use: { materialColours: 1, colourways: 1, brandingSets: 1, inUse: true } }),
  colour(6, 'DEMO-NAVY', 'Blu notte', { system: 'OWN', reference: 'NX-NAVY-02', family: 'blu', hex: '#1F2A44' }),
  colour(7, 'DEMO-SAND', 'Sabbia', { family: 'beige', use: { materialColours: 1, colourways: 0, brandingSets: 0, inUse: true } }),
  colour(8, 'DEMO-OLIVE', 'Verde oliva', { system: 'PANTONE', reference: '18-0430 TCX', family: 'verde', hex: '#5B5E3A', status: 'ARCHIVED', version: 3 }),
]
const ACTIVE = ROWS.filter((row) => row.status === 'ACTIVE')
const UNUSED = ACTIVE.filter((row) => !row.use.inUse)
const ref = (row: ColourLibraryRow) => ({ id: row.id, code: row.code, name: row.name, hex: row.hex, status: row.status })

const LOGO = { fileId: uid('4703', 1), role: 'LOGO' as const, name: 'demo brand logo.png', contentType: 'image/png', kind: 'PHOTO', picture: true, available: true, url: svg('#0B3D91', 'DB') }
const ARTWORK = { fileId: uid('4703', 2), role: 'ARTWORK' as const, name: 'demo main label.pdf', contentType: 'application/pdf', kind: 'DOCUMENT', picture: false, available: true, url: null }
const HANGTAG = { fileId: uid('4703', 3), role: 'ARTWORK' as const, name: 'demo hang tag.png', contentType: 'image/png', kind: 'PHOTO', picture: true, available: true, url: svg('#C8102E', 'TAG') }

const SETS: BrandingSetRow[] = [
  {
    id: uid('4704', 1),
    companyId: COMPANY_ID,
    party: { id: uid('4705', 1), code: 'DEMO-C1', name: 'Demo Racing Brand' },
    code: 'BS-DEMO-C1-2027',
    name: 'Demo Racing Brand, 2027',
    logos: 1,
    artwork: 2,
    logo: LOGO,
    colours: [ref(ROWS[0]!), ref(ROWS[1]!), ref(ROWS[4]!)],
    rules: 2,
    stylesLinked: 4,
    status: 'ACTIVE',
    version: 5,
    updatedAt: NOW,
  },
  {
    id: uid('4704', 2),
    companyId: COMPANY_ID,
    party: { id: uid('4705', 2), code: 'DEMO-C2', name: 'Demo Touring Club' },
    code: 'BS-DEMO-C2-2027',
    name: 'Demo Touring Club',
    logos: 0,
    artwork: 0,
    logo: null,
    colours: [],
    rules: 0,
    stylesLinked: 1,
    status: 'ACTIVE',
    version: 1,
    updatedAt: NOW,
  },
  {
    id: uid('4704', 3),
    companyId: COMPANY_ID,
    party: { id: uid('4705', 1), code: 'DEMO-C1', name: 'Demo Racing Brand' },
    code: 'BS-DEMO-C1-2026',
    name: 'Demo Racing Brand, 2026',
    logos: 0,
    artwork: 1,
    logo: null,
    colours: [ref(ROWS[0]!)],
    rules: 0,
    stylesLinked: null,
    status: 'ARCHIVED',
    version: 4,
    updatedAt: NOW,
  },
]

const SET_VIEW: BrandingSetView = {
  ...SETS[0]!,
  files: [LOGO, ARTWORK, HANGTAG],
  packagingRules: [
    { key: 'polybag', text: 'One garment per polybag with the brand sticker', item: { id: uid('4706', 1), code: 'DEMO-PKG-POLY', name: 'Polybag 60×80 demo', status: 'ACTIVE' }, quantity: '1', per: 'GARMENT' },
    { key: 'hang-tag', text: 'Brand hang tag on the left sleeve zip puller' },
  ].map((rule) => ({ item: null, quantity: null, per: null, ...rule }) as BrandingSetView['packagingRules'][number]),
  note: 'The brand sends new artwork each season (made-up).',
  styles: [
    { id: uid('4707', 1), code: 'DEMO-JKT-01', name: 'Giacca racing demo', status: 'ACTIVE' },
    { id: uid('4707', 2), code: 'DEMO-JKT-02', name: 'Giacca touring demo', status: 'ACTIVE' },
    { id: uid('4707', 3), code: 'DEMO-PNT-01', name: 'Pantalone demo', status: 'DRAFT' },
    { id: uid('4707', 4), code: 'DEMO-GLV-01', name: 'Guanto demo', status: 'ACTIVE' },
  ],
  stylesMore: false,
  activeOther: null,
  createdAt: NOW,
}
const MATERIALS = [
  { id: uid('4706', 1), code: 'DEMO-PKG-POLY', name: 'Polybag 60×80 demo', kind: 'PACKAGING' },
  { id: uid('4706', 2), code: 'DEMO-LBL-TAG', name: 'Hang tag demo', kind: 'LABEL' },
  { id: uid('4706', 3), code: 'DEMO-PKG-CTN', name: 'Cartone 10 capi demo', kind: 'PACKAGING' },
]

const COUNTS: ColourCountsView = {
  tiles: { unused: UNUSED.length, brandingSets: 2 },
  brandsWithoutSet: { count: 1, brands: [{ partyId: uid('4705', 3), code: 'DEMO-C3', name: 'Demo Enduro Team', companyId: COMPANY_ID, styles: 2 }] },
  noHex: 1,
}

const canOf = (role: RoleCase) => coloursCan(ROLE_PERMISSIONS[role])

const base: ColoursViewModel = {
  prefix: PREFIX,
  companyId: COMPANY_ID,
  can: canOf('owner'),
  filters: NO_FILTERS,
  rows: { items: ACTIVE, more: false, count: ACTIVE.length, problem: null, ignored: [], families: ['beige', 'bianco', 'blu', 'giallo', 'grigio', 'nero', 'rosso', 'verde'] },
  counts: COUNTS,
  countsFailed: false,
  sets: { items: SETS, problem: null },
  asOf: NOW,
  updates: 0,
  dismissed: [],
  notice: null,
  busy: false,
  colourForm: null,
  setModal: null,
  newSet: null,
}
const asRole = (role: RoleCase, model: ColoursViewModel = base): ColoursViewModel => ({ ...model, can: canOf(role) })

const form = (mode: 'new' | 'edit', row: ColourLibraryRow | null, extra: Partial<ColourFormModel> = {}): ColourFormModel => ({
  mode,
  row,
  draft: colourDraftOf(row, ''),
  companies: [
    { id: COMPANY_ID, name: 'Officina Demo S.r.l.' },
    { id: uid('1111', 2), name: 'Pelletteria Esempio S.p.A.' },
  ],
  everyCompany: true,
  busy: false,
  problem: null,
  refused: [],
  messages: [],
  photo: { busy: false, problem: null },
  ...extra,
})

const modal = (set: BrandingSetView | null, extra: Partial<SetModalModel> = {}, draft?: SetDraft): SetModalModel => ({
  id: set?.id ?? SETS[0]!.id,
  set,
  problem: null,
  draft: draft ?? (set ? setDraftOf(set) : null),
  colours: ACTIVE,
  materials: MATERIALS,
  busy: false,
  saveProblem: null,
  refused: [],
  messages: [],
  uploading: null,
  uploadProblem: null,
  confirm: null,
  ...extra,
})
const dirty: SetDraft = { ...setDraftOf(SET_VIEW), name: 'Demo Racing Brand, 2027 (season 2)', colourIds: [ROWS[0]!.id, ROWS[1]!.id, ROWS[4]!.id, ROWS[2]!.id], artworkIds: [HANGTAG.fileId, ARTWORK.fileId] }
const badRules: SetDraft = { ...setDraftOf(SET_VIEW), rules: [...setDraftOf(SET_VIEW).rules, { key: 'Box 10', text: '', itemId: MATERIALS[2]!.id, quantity: '0', per: '' }] }
const archivedSet: BrandingSetView = { ...SET_VIEW, ...SETS[2]!, files: [ARTWORK], packagingRules: [], note: null, styles: SET_VIEW.styles, stylesMore: false, activeOther: { id: SETS[0]!.id, code: SETS[0]!.code, name: SETS[0]!.name }, createdAt: NOW }

const brands = [
  { id: uid('4705', 1), code: 'DEMO-C1', name: 'Demo Racing Brand', active: [{ id: SETS[0]!.id, code: SETS[0]!.code, name: SETS[0]!.name, companyId: COMPANY_ID }] },
  { id: uid('4705', 3), code: 'DEMO-C3', name: 'Demo Enduro Team', active: [] },
]
const newSet = (extra: Partial<NewSetModel> = {}, draft: Partial<NewSetModel['draft']> = {}): NewSetModel => ({
  draft: { brand: null, code: '', name: '', replace: false, ...draft },
  search: { q: 'demo', results: brands },
  busy: false,
  problem: null,
  refused: [],
  messages: [],
  ...extra,
})

export const designScreen = defineDesignScreen<ColoursViewModel>({
  screen: 'SCR-118',
  title: 'Colours & artwork',
  view: ColoursView,
  cases: [
    { id: 'owner', label: 'Owner: the colour library and the branding sets', model: base, note: 'Tiles = saved filters; one notice Banner (the most serious) and "1 more notice"; swatch, Pantone or RAL, hex, photo, what uses each colour; the sets below, a row opens its DetailModal.' },
    { id: 'developer', label: 'Product developer (production manager): keeps colours and sets', model: asRole('developer') },
    { id: 'sales', label: 'Sales: keeps the brands’ sets, reads the colours', model: asRole('sales'), note: 'New colour held with the right that has it; cells read only; material colour counts "—" (not in the role).' },
    { id: 'quality', label: 'Quality: reads', model: asRole('quality'), note: 'New colour and New branding set held with their reasons; Export works.' },
    { id: 'notices-open', label: 'Every notice listed', model: { ...base, rows: { ...base.rows, ignored: ['system=XYZ'] }, filters: { ...NO_FILTERS, system: 'XYZ' }, noticesOpen: true }, note: 'The ignored filter first (warning), then the brands without a set, then the colours without a hex (info); each dismissed by its value.' },
    { id: 'ignored-filter', label: 'A filter the API could not apply', model: { ...base, filters: { ...NO_FILTERS, system: 'XYZ' }, rows: { ...base.rows, ignored: ['system=XYZ'] } }, note: 'Its chip says "Not applied"; the Banner offers to remove it; the list shows every colour.' },
    { id: 'selected', label: 'Three colours selected', model: { ...base, selected: [ROWS[0]!.id, ROWS[5]!.id, ROWS[6]!.id] }, note: 'The toolbar swaps to Restore 3 (held: none archived), Archive 3, Export 3; the header box is mixed.' },
    { id: 'archive-dialog', label: 'Archive 2 (one in use)', model: { ...base, selected: [ROWS[0]!.id, ROWS[5]!.id], dialog: 'archive' } },
    { id: 'tile-unused', label: 'Tile: unused colours (pressed)', model: { ...base, filters: { ...NO_FILTERS, view: 'unused' }, rows: { ...base.rows, items: UNUSED, count: UNUSED.length } } },
    { id: 'filtered', label: 'Filtered: RAL, nero, searched', model: { ...base, filters: { ...NO_FILTERS, system: 'RAL', family: 'nero', q: '9005' }, rows: { ...base.rows, items: [ROWS[0]!], count: 1 } } },
    { id: 'archived', label: 'Archived view', model: { ...base, filters: { ...NO_FILTERS, view: 'archived' }, rows: { ...base.rows, items: [ROWS[7]!], count: 1 } }, note: 'Cells of an archived colour are held ("restore it to change it").' },
    { id: 'many', label: 'More than a page', model: { ...base, rows: { ...base.rows, more: true, count: 214 } }, note: '"7 of 214" and Show more in the footer, beside the keys icon.' },
    { id: 'updates', label: 'Live changes waiting', model: { ...base, updates: 3 } },
    { id: 'result', label: 'After saving a colour', model: { ...base, notice: { key: 'notice.saved', tone: 'success', params: { code: 'DEMO-NAVY' } } } },
    { id: 'new-colour', label: 'New colour', model: { ...base, colourForm: form('new', null) } },
    { id: 'new-colour-filled', label: 'New colour, filled', model: { ...base, colourForm: form('new', null, { draft: { companyId: '', code: 'demo-teal', name: 'Petrolio', it: 'Petrolio', en: 'Teal', system: 'PANTONE', reference: '19-4524 tcx', family: 'Blu', hex: '1d5c63' } }) }, note: 'The reference takes Pantone’s form on save; the swatch draws the typed hex.' },
    { id: 'new-colour-problems', label: 'New colour: what to fix', model: { ...base, colourForm: form('new', null, { draft: { companyId: '', code: 'demo teal', name: 'Petrolio', it: '', en: '', system: 'RAL', reference: '', family: '', hex: 'teal' } }) }, note: 'factory-domain’s own rules as typed: the code, the RAL reference, the hex; Add colour held with the count.' },
    { id: 'new-colour-refused', label: 'New colour: code taken', model: { ...base, colourForm: form('new', null, { draft: { companyId: '', code: 'DEMO-BLK', name: 'Nero bis', it: '', en: '', system: '', reference: '', family: '', hex: '' }, problem: 'problem.write.codeTaken', refused: ['code'], messages: ['The colour code DEMO-BLK is taken: pick another.'] }) } },
    { id: 'edit-colour', label: 'Edit colour with its photo', model: { ...base, colourForm: form('edit', ROWS[0]!) } },
    { id: 'edit-colour-sending', label: 'Edit colour: a photo being sent', model: { ...base, colourForm: form('edit', ROWS[5]!, { photo: { busy: true, problem: null } }) } },
    { id: 'set', label: 'Branding set (Owner)', model: { ...base, setModal: modal(SET_VIEW) }, note: 'Logos and artwork (a picture drawn, a PDF opened in a new tab), packaging rules, brand colours, the styles that read it; J / K the next set.' },
    { id: 'set-dirty', label: 'Branding set: changes not saved', model: { ...base, setModal: modal(SET_VIEW, {}, dirty) }, note: 'The EditModeBar counts 3 changes (name, artwork order, a colour added); ⌘S saves.' },
    { id: 'set-problems', label: 'Branding set: a rule to fix', model: { ...base, setModal: modal(SET_VIEW, {}, badRules) }, note: 'The key, the words, the quantity and what it is per, as factory-domain says; Save held.' },
    { id: 'set-sending', label: 'Branding set: a logo being sent', model: { ...base, setModal: modal(SET_VIEW, { uploading: 'demo logo 2.png' }) } },
    { id: 'set-refused', label: 'Branding set: refused (moved meanwhile)', model: { ...base, setModal: modal(SET_VIEW, { saveProblem: 'problem.write.moved' }, dirty) } },
    { id: 'set-quality', label: 'Branding set read by quality', model: { ...asRole('quality'), setModal: { ...modal(SET_VIEW), colours: null, materials: null } }, note: 'Text only, no inputs; Archive is not offered.' },
    { id: 'set-archived', label: 'Archived set: restore held while the brand uses another', model: { ...base, setModal: modal(archivedSet) } },
    { id: 'set-archive', label: 'Archive a set: confirm', model: { ...base, setModal: modal(SET_VIEW, { confirm: 'archive' }) } },
    { id: 'set-loading', label: 'Branding set: reading', model: { ...base, setModal: modal(null) } },
    { id: 'set-error', label: 'Branding set: could not be read', model: { ...base, setModal: modal(null, { problem: 'problem.read.unavailable' }) } },
    { id: 'new-set', label: 'New branding set: pick the brand', model: { ...base, newSet: newSet() } },
    { id: 'new-set-replace', label: 'New branding set for a brand with a set in use', model: { ...base, newSet: newSet({}, { brand: brands[0]!, code: 'BS-DEMO-C1-2028', name: 'Demo Racing Brand, 2028' }) }, note: 'Start set held until the box to archive the set in use is ticked.' },
    { id: 'new-set-ready', label: 'New branding set: ready', model: { ...base, newSet: newSet({}, { brand: brands[1]!, code: 'BS-DEMO-C3-2027', name: 'Demo Enduro Team' }) } },
    { id: 'sets-selected', label: 'Branding sets: one selected', model: { ...base, selectedSets: [SETS[1]!.id] }, note: 'Archive 1; an archived set’s box says why it cannot be selected.' },
    { id: 'sets-empty', label: 'No branding sets yet', model: { ...base, sets: { items: [], problem: null }, counts: { ...COUNTS, tiles: { ...COUNTS.tiles, brandingSets: 0 } } } },
    { id: 'no-match', label: 'Nothing matches', model: { ...base, filters: { ...NO_FILTERS, q: 'zzz' }, rows: { ...base.rows, items: [], count: 0 } } },
    { id: 'empty', label: 'No colours yet', model: { ...base, rows: { ...base.rows, items: [], count: 0, families: [] }, sets: { items: [], problem: null }, counts: { tiles: { unused: 0, brandingSets: 0 }, brandsWithoutSet: { count: 0, brands: [] }, noHex: 0 } } },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { ...base.rows, items: null, count: null }, counts: null, sets: { items: null, problem: null }, asOf: null }, note: 'Tiles "—" until counted.' },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { ...base.rows, items: null, count: null, problem: 'problem.read.unavailable' }, counts: null, countsFailed: true, sets: { items: null, problem: 'problem.read.unavailable' } }, note: 'Never drawn as an empty list; the tiles say "—" with "Couldn’t count".' },
    { id: 'offline', label: 'Offline: the rows stay with their time', model: { ...base, notice: { key: 'problem.read.unavailable', tone: 'danger' } }, note: 'A re-read that could not reach the server: the rows stay readable with their "Updated" time; a cell that could not be saved keeps its mark and Retry (the list frame).' },
    { id: 'no-permission', label: 'No access', model: { ...base, can: { ...canOf('quality'), view: false }, rows: { ...base.rows, items: null, count: null, problem: 'problem.read.forbidden' }, counts: null, sets: { items: null, problem: 'problem.read.forbidden' } }, note: 'The page is absent from the Pages overlay; a direct address says who has access.' },
  ],
})
