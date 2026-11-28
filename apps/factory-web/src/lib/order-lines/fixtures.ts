import { defineDesignScreen } from '../design/design-screen'
import type { LineRow } from './model'
import type { OwnColumn } from './schema'
import { OrderLinesTable, type OrderLinesModel } from './view/OrderLinesTable'

/**
 * SCR-owb-order-lines — THE ONE LINES TABLE (owb-po3.2): every mode, with and without money, a narrow room's cards, own columns, a line
 * taken out. Made-up data only (Brand Alpha's race suits).
 */

export const COLUMNS: OwnColumn[] = [
  { id: 'c-sizing', name: 'Sizing', kind: 'CHOICE', choices: ['Standard size', 'Made to measure'], closed: false, version: 1 },
  { id: 'c-remake', name: 'Remake', kind: 'YES_NO', choices: [], closed: false, version: 1 },
  { id: 'c-comment', name: 'Comment', kind: 'TEXT', choices: [], closed: false, version: 1 },
]

const material = (value: string, words: string | null) => ({ how: 'COLOURWAY' as const, words, value, options: [{ value: 'cw-black', words: 'Cowhide black' }, { value: 'cw-red', words: 'Cowhide red' }], topic: null })

export const ROWS: LineRow[] = [
  {
    id: 'l-1',
    seq: 1,
    model: { kind: 'OWN', value: 'style:s-1', words: 'Alpha race suit', styleId: 's-1', garmentType: null, fixed: false },
    material: material('cw-black', 'Cowhide black'),
    sizes: { mode: 'SIZES', run: '2 × 50 · 1 × 52', people: 0 },
    pieces: { count: 3, typed: false },
    own: { 'c-sizing': 'Made to measure', 'c-remake': true, 'c-comment': 'Rider 19 wants the collar 1 cm lower.' },
    ownVersions: { 'c-sizing': 1, 'c-remake': 1, 'c-comment': 2 },
  },
  {
    id: 'l-2',
    seq: 2,
    model: { kind: 'NEW', value: 'new:JACKET', words: 'Jacket', styleId: null, garmentType: 'JACKET', fixed: false },
    material: { how: 'NONE', words: null, value: '', options: [], topic: null },
    sizes: { mode: 'NONE', run: null, people: 0 },
    pieces: { count: 6, typed: true },
    own: {},
    ownVersions: {},
  },
  {
    id: 'l-3',
    seq: 3,
    model: { kind: 'TEXT', value: 'text', words: null, styleId: null, garmentType: null, fixed: false },
    material: { how: 'NONE', words: null, value: '', options: [], topic: null },
    sizes: { mode: 'FILE', run: null, people: 0 },
    pieces: { count: null, typed: true },
    own: {},
    ownVersions: {},
  },
]

const base: OrderLinesModel = {
  rows: ROWS,
  mode: 'draft',
  columns: COLUMNS,
  styles: [
    { id: 's-1', code: 'ALP-RS', name: 'Alpha race suit', ownLabel: true },
    { id: 's-2', code: 'FAC-GL', name: 'Track gloves', ownLabel: false },
  ],
  kinds: [
    { code: 'RACE_SUIT', words: 'Race suit' },
    { code: 'JACKET', words: 'Jacket' },
  ],
  prices: { currency: 'EUR', edit: true, byLine: { 'l-1': { list: '45.00', own: '44.00' }, 'l-2': { list: null, own: null }, 'l-3': { list: null, own: null } } },
  pending: false,
  removed: [],
  writeHeld: null,
  saving: [],
  columnsDoor: true,
  room: 'wide',
}

export const designScreen = defineDesignScreen<OrderLinesModel>({
  screen: 'SCR-owb-order-lines',
  title: 'The ONE lines table — model, material, sizes, pieces, own columns, your price (owb-po3)',
  view: OrderLinesTable,
  cases: [
    { id: 'draft', label: 'A draft, with money and three own columns', model: base, note: 'Your price: agreed € 45 on line 1, "the factory answers" on the others.' },
    { id: 'no-money', label: 'A draft read by the customer’s designer: no price anywhere', model: { ...base, prices: null }, note: 'No Your price column and no price key.' },
    { id: 'pending', label: '"Add a line" with nothing above: Choose the model…', model: { ...base, rows: [], pending: true, columns: [] }, note: 'Nothing is chosen for you.' },
    { id: 'removed', label: 'A line taken out: Put it back', model: { ...base, removed: [{ id: 'l-9', seq: 4, words: 'Track gloves', removedAt: '2026-11-28T09:00:00Z' }] } },
    { id: 'sent', label: 'Sent: reads, says why', model: { ...base, mode: 'sent', prices: { ...base.prices!, edit: false } } },
    { id: 'shipped', label: 'Shipped: a change now is a return', model: { ...base, mode: 'shipped', prices: null } },
    { id: 'narrow', label: 'A phone: one card per line', model: { ...base, room: 'narrow' }, note: 'At 375 px each line is a card; no sideways scroll.' },
    { id: 'empty', label: 'No line yet', model: { ...base, rows: [], columns: [] } },
  ],
})
