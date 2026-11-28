import type { SheetLineRead, SheetNews, SheetRowRead, SheetTiles } from './api'

/** owb-of3 — made-up rows of `GET /sales/orders/sheet` (the of1 Shape) for the office door's tests. Example names only. */

export const NO_NEWS: SheetNews = Object.freeze({ unread: 0, openAsks: 0, openDetails: 0, sentAsText: false, remakeOf: null, withDesigner: false, design: null, problems: 0, late: false, label: null, next: null, paymentNotices: 0 })

export const readLine = (seq: number, over: Partial<SheetLineRead> = {}): SheetLineRead => ({
  id: `line-${seq}`,
  seq,
  kind: 'CATALOGUE',
  product: { styleId: `style-${seq}`, code: `RS-0${seq}`, name: 'Race suit' },
  text: null,
  material: 'Cowhide',
  sizes: '48:2 50:3',
  sizeFileId: null,
  pieces: 5,
  own: [],
  asks: [],
  ...over,
})

export const readRow = (over: Partial<SheetRowRead> = {}): SheetRowRead => ({
  kind: 'ORDER',
  id: 'order-1',
  version: 3,
  number: 'SO-2026-0101',
  subject: 'Team suits',
  party: { id: 'party-1', code: 'C-ALPHA', name: 'Alpha Racing' },
  life: 'CONFIRMED',
  wantedFor: '2026-12-20',
  promised: '2026-12-18',
  daysLate: null,
  where: { stage: null, health: null, held: false },
  picture: null,
  news: NO_NEWS,
  restricted: false,
  customerOnHold: false,
  pieces: 5,
  may: { confirm: false, deleteDraft: false, editLines: 'AMEND' },
  lines: [readLine(1)],
  ...over,
})

export const DRAFT_ROW = readRow({ kind: 'REQUEST', id: 'req-draft', number: null, life: 'DRAFT', promised: null, where: null, may: { confirm: true, deleteDraft: true, editLines: 'DRAFT' }, lines: [readLine(1), readLine(2, { kind: 'DESCRIBED', product: null, text: 'A rain jacket', material: null, sizes: null, pieces: 3 })], pieces: 8 })
export const SENT_ROW = readRow({ kind: 'REQUEST', id: 'req-sent', number: 'RQ-0042', life: 'SENT', promised: null, where: null, may: { confirm: true, deleteDraft: false, editLines: null }, news: { ...NO_NEWS, next: 'CONFIRM', openDetails: 2 } })
export const TEXT_ROW = readRow({ kind: 'REQUEST', id: 'req-text', number: 'RQ-0043', life: 'SENT', promised: null, where: null, may: { confirm: true, deleteDraft: false, editLines: null }, news: { ...NO_NEWS, sentAsText: true, next: 'CONFIRM' }, lines: [readLine(1, { kind: 'DESCRIBED', product: null, text: 'As in my message' })] })
export const HELD_ROW = readRow({ kind: 'REQUEST', id: 'req-held', number: 'RQ-0044', life: 'SENT', promised: null, where: null, may: { confirm: true, deleteDraft: false, editLines: null }, lines: [readLine(1), readLine(2, { kind: 'CUSTOM', product: null, text: 'Custom gloves' })] })
export const CONFIRMED_ROW = readRow({ news: { ...NO_NEWS, next: 'PRINT', openAsks: 1 }, lines: [readLine(1, { asks: [{ requestId: 'ask-1', column: 'pieces', from: '5', to: '7' }] })] })
export const PRODUCTION_ROW = readRow({ id: 'order-2', number: 'SO-2026-0102', life: 'IN_PRODUCTION', where: { stage: 'SEWING', health: 'LATE', held: false }, may: { confirm: false, deleteDraft: false, editLines: null }, news: { ...NO_NEWS, problems: 2, late: true, unread: 3 } })

export const TILES: SheetTiles = Object.freeze({ incoming: 3, waitingForPrint: 2, inProduction: 7, problems: 1, late: 4, readyToShip: 5 })
