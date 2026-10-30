import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, canFor, COMPANY_ID, NOW, PREFIX, uid } from '../library/demo'
import { ROWS as STYLE_ROWS } from '../styles/demo/fixtures'
import type { ScaleRow, ScaleView, SizeView, StyleRow } from './api'
import { SizesListView, type NewScaleModel, type SizesListViewModel } from './view/SizesListView'

/**
 * SCR-049 Sizes & measurements — made-up data only: an invented factory's size scales (EU 44–64, S–4XL, gloves 7–13,
 * women 38–50) and the body measures of the EU scale. Role cases: the Owner, a product developer (keeps the scales),
 * quality and sales (read).
 */

const scale = (n: number, fields: Partial<ScaleRow> & Pick<ScaleRow, 'code' | 'name' | 'codes'>): ScaleRow => ({ id: uid('4911', n), companyId: COMPANY_ID, styleCount: 0, status: 'ACTIVE', version: 2, updatedAt: at(20, 10), ...fields })

export const SCALES: ScaleRow[] = [
  scale(1, { code: 'DEMO-EU-UOMO', name: 'Uomo EU 44–64', codes: ['44', '46', '48', '50', '52', '54', '56', '58', '60', '62', '64'], styleCount: 4 }),
  scale(2, { code: 'DEMO-LETTERE', name: 'Lettere S–4XL', codes: ['S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'], styleCount: 2 }),
  scale(3, { code: 'DEMO-GUANTI', name: 'Guanti 7–13', codes: ['7', '8', '9', '10', '11', '12', '13'], styleCount: 1 }),
  scale(4, { code: 'DEMO-EU-DONNA', name: 'Donna EU 38–50', codes: ['38', '40', '42', '44', '46', '48', '50'] }),
  scale(5, { code: 'DEMO-OLD', name: 'Vecchia scala', codes: ['1', '2', '3'], status: 'ARCHIVED' }),
]

const open = SCALES.filter((row) => row.status === 'ACTIVE')
const base: SizesListViewModel = { prefix: PREFIX, can: canFor('owner'), filters: { view: 'open', q: '' }, rows: { items: open, more: false, count: open.length, problem: null }, asOf: NOW, updates: 0, newScale: null, busy: false, notice: null }
const newScale = (draft: Partial<NewScaleModel['draft']> = {}, extra: Partial<NewScaleModel> = {}): NewScaleModel => ({
  draft: { companyId: COMPANY_ID, code: '', name: '', sizes: '', ...draft },
  companies: [
    { id: COMPANY_ID, name: 'Officina Demo S.r.l.' },
    { id: '0190f0e2-1111-7000-8000-000000000002', name: 'Pelletteria Esempio S.p.A.' },
  ],
  busy: false,
  problem: null,
  refused: [],
  ...extra,
})

export const designScreen = defineDesignScreen<SizesListViewModel>({
  screen: 'SCR-049-sizes',
  title: 'Sizes & measurements',
  view: SizesListView,
  cases: [
    { id: 'owner', label: 'Owner: the size scales', model: base, note: '"44 46 48 … 64", the styles on each; the order stays once styles use a scale.' },
    { id: 'developer', label: 'Product developer', model: { ...base, can: canFor('developer') } },
    { id: 'quality', label: 'Quality (reads)', model: { ...base, can: canFor('quality') }, note: 'New size scale and Archive held with their reason.' },
    { id: 'sales', label: 'Sales (reads)', model: { ...base, can: canFor('sales') } },
    { id: 'selected', label: 'Two rows selected', model: { ...base, selected: [SCALES[2]!.id, SCALES[3]!.id] } },
    { id: 'archive-dialog', label: 'Archive 1', model: { ...base, selected: [SCALES[3]!.id], dialog: 'archive' } },
    { id: 'archived', label: 'Archived view', model: { ...base, filters: { view: 'archived', q: '' }, rows: { items: [SCALES[4]!], more: false, count: 1, problem: null } } },
    { id: 'filtered', label: 'Searched', model: { ...base, filters: { view: 'open', q: 'guanti' }, rows: { items: [SCALES[2]!], more: false, count: 1, problem: null } } },
    { id: 'updates', label: 'Live changes waiting', model: { ...base, updates: 1 } },
    { id: 'new', label: 'New size scale', model: { ...base, newScale: newScale() } },
    { id: 'new-filled', label: 'New size scale, pasted sizes', model: { ...base, newScale: newScale({ code: 'DEMO-BAMBINO', name: 'Bambino 4–14', sizes: '4, 6, 8, 10, 12, 14' }) }, note: 'Sizes typed or pasted in order: "6 sizes: 4 · 6 · 8 · 10 · 12 · 14".' },
    { id: 'new-bad', label: 'New size scale: a bad size', model: { ...base, newScale: newScale({ code: 'DEMO-X', name: 'Prova', sizes: '44 46-48 50' }) }, note: '"46-48" is not a size code (no hyphen): Create says so.' },
    { id: 'no-match', label: 'Nothing matches', model: { ...base, filters: { view: 'open', q: 'zzz' }, rows: { items: [], more: false, count: 0, problem: null } } },
    { id: 'empty', label: 'No size scales yet', model: { ...base, rows: { items: [], more: false, count: 0, problem: null } } },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { items: null, more: false, count: null, problem: null }, asOf: null } },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { items: null, more: false, count: null, problem: 'problem.read.unavailable' } } },
    { id: 'no-permission', label: 'No access', model: { ...base, can: { ...canFor('sales'), styles: false }, rows: { items: null, more: false, count: null, problem: 'problem.read.forbidden' } } },
  ],
})

// ---- the EU scale's record (SCR-049-scale) ------------------------------------------------------------------------------

const MEASURES: Record<string, [number, number]> = { '44': [84, 88], '46': [88, 92], '48': [92, 96], '50': [96, 100], '52': [100, 104], '54': [104, 108], '56': [108, 112], '58': [112, 116], '60': [116, 120], '62': [120, 124], '64': [124, 128] }
const HEIGHT: Record<string, [number, number]> = { '44': [164, 170], '46': [166, 172], '48': [168, 174], '50': [170, 176], '52': [172, 178], '54': [174, 180], '56': [176, 182], '58': [178, 184], '60': [180, 186], '62': [182, 188] }

export const EU_SCALE: ScaleView = {
  ...SCALES[0]!,
  sizes: SCALES[0]!.codes.map(
    (code, index): SizeView => ({
      id: uid('4912', index + 1),
      code,
      label: code === '52' ? '52 (L)' : code === '50' ? '50 (M)' : null,
      seq: index + 1,
      bodyMeasures: {
        chest: { min: String(MEASURES[code]![0]), max: String(MEASURES[code]![1]), unit: 'cm' },
        ...(HEIGHT[code] ? { height: { min: String(HEIGHT[code]![0]), max: String(HEIGHT[code]![1]), unit: 'cm' as const } } : {}),
      },
      status: 'ACTIVE',
      version: 1,
      inUse: index < 9,
    }),
  ),
  measureUnits: { chest: 'cm', height: 'cm' },
  createdAt: at(1),
  createdById: uid('4705', 1),
}

/** A new scale no style uses yet: its order may change, its codes too. */
export const NEW_SCALE: ScaleView = {
  ...SCALES[3]!,
  sizes: SCALES[3]!.codes.map((code, index): SizeView => ({ id: uid('4913', index + 1), code, label: null, seq: index + 1, bodyMeasures: null, status: 'ACTIVE', version: 1, inUse: false })),
  measureUnits: {},
  createdAt: at(26),
  createdById: uid('4705', 1),
}

/** The styles on the EU scale (the styles screens' own made-up rows). */
export const STYLES_ON_EU: StyleRow[] = STYLE_ROWS.slice(0, 4)
