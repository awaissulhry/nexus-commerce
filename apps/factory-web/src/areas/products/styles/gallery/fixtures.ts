import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BRANDS, CAN, DEMO_PRICES, GRAINS, PREFIX, ROWS } from '../demo/fixtures'
import { pricesByStyle, type ListPrices, type StylesListViewModel } from '../list/list-model'
import { StylesListView } from '../list/view/StylesListView'
import type { LooksState, StyleLook } from './gallery-model'

/**
 * SCR-303 (new id, B-W2b-236) — Styles › Gallery (design products.styles sec:styles.view "List · Gallery (W2b)" and
 * sec:styles.gallery): the list's own rows as big pictures, made-up data only (an invented factory's styles; the pictures are
 * drawn here as plain shapes, never a real product photo). Cases per role and state: the product office, sales (reads,
 * Archive held), loading, the first read, cards selected, nothing yet, nothing matching, a failed read, pictures that could
 * not be read, no access, a phone.
 */

/** A made-up garment picture: a plain shape in one colour, as an inline SVG (design cases only). */
export function demoPicture(fill: string, kind: 'jacket' | 'trousers' | 'glove' | 'page' = 'jacket', label = ''): string {
  const shapes: Record<string, string> = {
    jacket: `<path d="M120 40 L160 30 L200 40 L250 70 L280 160 L250 170 L235 120 L235 260 L85 260 L85 120 L70 170 L40 160 L70 70 Z" fill="${fill}" stroke="#2b2b2b" stroke-width="3"/><path d="M160 30 L160 260" stroke="#d9d9d9" stroke-width="3"/>`,
    trousers: `<path d="M100 30 L220 30 L240 270 L180 270 L160 110 L140 270 L80 270 Z" fill="${fill}" stroke="#2b2b2b" stroke-width="3"/>`,
    glove: `<path d="M110 270 L110 150 L95 60 L120 55 L135 130 L140 40 L165 40 L168 125 L180 50 L205 55 L196 135 L215 80 L238 90 L215 170 L210 270 Z" fill="${fill}" stroke="#2b2b2b" stroke-width="3"/>`,
    page: `<rect x="40" y="30" width="240" height="240" rx="8" fill="#ffffff" stroke="#2b2b2b" stroke-width="3"/><path d="M110 70 L160 60 L210 70 L230 120 L215 125 L205 100 L205 230 L115 230 L115 100 L105 125 L90 120 Z" fill="${fill}" stroke="#2b2b2b" stroke-width="2"/>`,
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 300"><rect width="320" height="300" fill="#f4f4f4"/>${shapes[kind]}${label ? `<text x="160" y="292" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#555">${label}</text>` : ''}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const open = ROWS.filter((row) => row.status !== 'ARCHIVED')
const PRICES: ListPrices = { state: 'ready', list: DEMO_PRICES.list, byStyle: pricesByStyle(DEMO_PRICES.entries) }
const SWATCHES = {
  black: { code: 'NERO', name: 'Nero', hex: '#1F1F1F' },
  grey: { code: 'ANTR', name: 'Antracite', hex: '#4A4D52' },
  red: { code: 'ROSSO', name: 'Rosso corsa', hex: '#B3122E' },
  sand: { code: 'SABB', name: 'Sabbia', hex: '#C8B48A' },
  blue: { code: 'BLU', name: 'Blu notte', hex: '#1E2A44' },
  own: { code: 'SPEC', name: 'Colore del cliente', hex: null },
}
const PICTURES: Record<string, { fill: string; kind?: 'jacket' | 'trousers' | 'glove'; swatches: StyleLook['colourways']; count: number; caption?: string } | null> = {
  'DEMO-JKT-01': { fill: '#1F1F1F', swatches: [SWATCHES.black, SWATCHES.grey, SWATCHES.red], count: 6, caption: 'Nero, davanti' },
  'DEMO-JKT-02': { fill: '#B3122E', swatches: [SWATCHES.red, SWATCHES.black], count: 3 },
  'DEMO-JKT-03': { fill: '#C8B48A', swatches: [SWATCHES.sand, SWATCHES.own], count: 2 },
  'DEMO-PNT-01': { fill: '#4A4D52', kind: 'trousers', swatches: [SWATCHES.grey, SWATCHES.black], count: 4 },
  'DEMO-PNT-02': null,
  'DEMO-GLV-01': { fill: '#1E2A44', kind: 'glove', swatches: [SWATCHES.blue, SWATCHES.black], count: 1 },
}

function looksOf(rows = open): LooksState {
  const byStyle: Record<string, StyleLook> = {}
  rows.forEach((row, index) => {
    const entry = PICTURES[row.code]
    byStyle[row.id] = {
      styleId: row.id,
      picture: entry ? { id: `0190f0e2-3030-7000-8000-${String(index + 1).padStart(12, '0')}`, kind: 'PHOTO', caption: entry.caption ?? null, look: { url: demoPicture(entry.fill, entry.kind ?? 'jacket') } } : null,
      pictures: entry?.count ?? 0,
      colourways: entry?.swatches ?? [SWATCHES.black],
    }
  })
  return { status: 'ready', byStyle, at: '2026-11-10T09:00:00.000Z' }
}

const base: StylesListViewModel = {
  prefix: PREFIX,
  can: CAN.owner,
  grains: GRAINS.owner,
  prices: PRICES,
  duplicate: null,
  filters: { view: 'open', q: '', type: '', ppe: '' },
  rows: { items: open, more: false, count: open.length, problem: null },
  tiles: { drafts: 2, waiting: 2, active: 6, archived: 1 },
  asOf: '2026-11-10T08:42:00.000Z',
  updates: 0,
  newStyle: null,
  busy: false,
  notice: null,
  gallery: { on: true, looks: looksOf() },
}
const gallery = (over: Partial<StylesListViewModel> = {}): StylesListViewModel => ({ ...base, ...over })

export const designScreen = defineDesignScreen<StylesListViewModel>({
  screen: 'SCR-303',
  title: 'Styles › Gallery (List · Gallery)',
  view: StylesListView,
  cases: [
    { id: 'owner', label: 'Gallery: the main picture of each style', model: gallery(), note: 'Product office. DEMO-PNT-02 has no main picture yet; DEMO-JKT-03 has a customer colour without a hex (the code shows). Each card is a link; its box selects (x on a focused card).' },
    { id: 'selected', label: 'Two styles selected: the bulk actions', model: gallery({ selected: [open[0]!.id, open[2]!.id] }) },
    { id: 'sales', label: 'Sales reads: New style and Archive N held', model: gallery({ can: CAN.sales, grains: GRAINS.sales, selected: [open[1]!.id] }) },
    { id: 'looks-loading', label: 'Pictures being read', model: gallery({ gallery: { on: true, looks: { status: 'loading' } } }) },
    { id: 'loading', label: 'First read of the styles', model: gallery({ rows: { items: null, more: false, count: null, problem: null }, asOf: null, gallery: { on: true, looks: { status: 'idle' } } }) },
    { id: 'looks-failed', label: 'Pictures could not be read (the cards still show)', model: gallery({ gallery: { on: true, looks: { status: 'error', problem: 'styles.gallery.looksFailed' } } }) },
    { id: 'filtered', label: 'Filters (same chips as the list)', model: gallery({ filters: { view: 'open', q: '', type: 'JACKET', ppe: '' }, rows: { items: open.filter((row) => row.productType === 'JACKET'), more: false, count: 3, problem: null } }) },
    { id: 'filtered-empty', label: 'Nothing matches the filters', model: gallery({ filters: { view: 'open', q: 'zzz', type: '', ppe: '' }, rows: { items: [], more: false, count: 0, problem: null } }) },
    { id: 'empty', label: 'No styles yet', model: gallery({ rows: { items: [], more: false, count: 0, problem: null }, tiles: {}, gallery: { on: true, looks: { status: 'idle' } } }) },
    { id: 'error', label: 'The styles could not be read', model: gallery({ rows: { items: null, more: false, count: null, problem: 'problem.read.unavailable' }, gallery: { on: true, looks: { status: 'idle' } } }) },
    { id: 'no-permission', label: 'No access to styles', model: gallery({ rows: { items: null, more: false, count: null, problem: 'problem.read.forbidden' }, gallery: { on: true, looks: { status: 'idle' } } }) },
    { id: 'more', label: 'More styles to read (Show more)', model: gallery({ rows: { items: open, more: true, count: 42, problem: null } }) },
    { id: 'phone', label: 'Phone: the gallery in two columns', model: gallery({ phone: true }) },
    { id: 'list-switch', label: 'List with the List · Gallery switch', model: gallery({ gallery: { on: false, looks: { status: 'idle' } } }), note: `The same rows as a table; Gallery switches to the cards (kept in the address as ?mode=gallery, so a saved view keeps it). Brand: ${BRANDS[0]!.legalName}.` },
  ],
})
