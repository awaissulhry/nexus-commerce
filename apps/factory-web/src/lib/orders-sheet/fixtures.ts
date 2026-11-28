import type { OrdersSheetLine, OrdersSheetOrder } from './model'

/**
 * owb-of3 — made-up orders for the sheet's tests and labs (example names only). A draft with two lines, a sent order with a text
 * line, a confirmed order with a customer's open ask, an order in production.
 */

export const line = (orderKey: string, seq: number, over: Partial<OrdersSheetLine> = {}): OrdersSheetLine => ({
  key: `${orderKey}/L${seq}`,
  id: `L${seq}-${orderKey}`,
  seq,
  kind: 'CATALOGUE',
  product: { styleId: `S${seq}`, code: `RS-0${seq}`, name: 'Race suit' },
  text: null,
  material: 'Cowhide',
  sizes: '48:2 50:3',
  sizeFileId: null,
  pieces: 5,
  own: [],
  asks: [],
  ...over,
})

export const order = (key: string, over: Partial<OrdersSheetOrder> = {}): OrdersSheetOrder => ({
  key,
  record: { kind: 'ORDER', id: key.split(':')[1] ?? key, version: 3 },
  number: 'SO-2026-0101',
  subject: 'Team suits',
  customer: { id: 'P1', code: 'C-ALPHA', name: 'Alpha Racing' },
  life: 'CONFIRMED',
  wantedFor: '2026-12-20',
  promised: '2026-12-18',
  daysLate: null,
  where: { stage: null, health: null, held: false },
  picture: null,
  chips: [],
  pieces: 5,
  may: { open: true, confirm: false, deleteDraft: false, editLines: 'AMEND' },
  lines: [line(key, 1)],
  ...over,
})

export const DRAFT = order('REQUEST:r1', {
  record: { kind: 'REQUEST', id: 'r1', version: 2 },
  number: null,
  life: 'DRAFT',
  promised: null,
  where: null,
  pieces: 8,
  may: { open: true, confirm: true, deleteDraft: true, editLines: 'DRAFT' },
  lines: [line('REQUEST:r1', 1), line('REQUEST:r1', 2, { kind: 'DESCRIBED', product: null, text: 'A rain jacket', material: null, sizes: null, pieces: 3 })],
})

export const SENT_TEXT = order('REQUEST:r2', {
  record: { kind: 'REQUEST', id: 'r2', version: 4 },
  number: 'RQ-0042',
  life: 'SENT',
  promised: null,
  where: null,
  may: { open: true, confirm: true, deleteDraft: false, editLines: null },
  lines: [line('REQUEST:r2', 1, { kind: 'DESCRIBED', product: null, text: 'As in my message', material: null, sizes: null })],
})

export const CONFIRMED_ASKED = order('ORDER:o1', {
  lines: [line('ORDER:o1', 1, { asks: [{ requestId: 'cr1', column: 'pieces', from: '5', to: '7' }] })],
})

export const IN_PRODUCTION = order('ORDER:o2', {
  record: { kind: 'ORDER', id: 'o2', version: 9 },
  number: 'SO-2026-0102',
  life: 'IN_PRODUCTION',
  where: { stage: 'SEWING', health: 'ON_TRACK', held: false },
  may: { open: true, confirm: false, deleteDraft: false, editLines: null },
  lines: [line('ORDER:o2', 1), line('ORDER:o2', 2, { pieces: 4 })],
  pieces: 9,
})

export const SHEET_ORDERS: readonly OrdersSheetOrder[] = [DRAFT, SENT_TEXT, CONFIRMED_ASKED, IN_PRODUCTION]
