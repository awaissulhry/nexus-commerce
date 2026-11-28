import type { Translate } from '../../../../../lib/i18n/messages'
import type { GridTone, OrdersSheetOrder, SheetChip, SheetColumnId } from '../../../../../lib/orders-sheet/model'
import type { SheetFilter, SheetLineRead, SheetRowRead, SheetTiles } from './api'

/**
 * owb-of3 steps 2–4 — the office door of the ONE orders sheet, pure: its read's rows as the part's orders (the office words, every
 * chip a door), the filters and the six tiles, the bulk acts' plans (each skips what it cannot do and says how many), and where a
 * typed cell goes (L2: a draft saves in place through today's office draft routes; a Sent order reads only; a confirmed order stages
 * ONE change of a line's sizes in the Review and save window; later: read only). No price anywhere.
 */

export const NS = 'orders-sheet'

export const orderKeyOf = (row: Pick<SheetRowRead, 'kind' | 'id'>): string => `${row.kind}:${row.id}`
export const lineKeyOf = (orderKey: string, lineId: string): string => `${orderKey}/${lineId}`

/** The office page of a record: an order's own page (a tab of it); a draft or a sent order keeps today's office page (L3). */
export function pageOf(prefix: string, record: Pick<SheetRowRead, 'kind' | 'id'>, tab?: 'production' | 'shipments' | 'money' | 'changes' | 'lines'): string {
  if (record.kind === 'REQUEST') return `${prefix}/sales/orders/new?draft=${encodeURIComponent(record.id)}`
  return `${prefix}/sales/orders/${encodeURIComponent(record.id)}${tab ? `?tab=${tab}` : ''}`
}

/** The office's own window targets (the part hands them back through `onOpen`). */
export type OfficeWindow = 'asks' | 'print' | 'printAgain' | 'ship'

const page = (path: string): SheetChip['door'] => ({ kind: 'page', target: `page:${path}` })
const windowDoor = (act: OfficeWindow | 'confirm', key: string): SheetChip['door'] => ({ kind: 'window', target: `${act}:${key}` })

/**
 * "Waits · news" in the office's words — each a door (`newsChips` of the design): "n new" · Remake of … · Sent as text · With the
 * designer · Confirm · Print and start… · Print again · Design: waits / approved / change · n problems · Ship · Label received /
 * Waits for the label · n to answer · n open · Late · n "I paid". Tones: the design's colours said with the five grid tones.
 */
export function newsChipsOf(row: SheetRowRead, prefix: string, t: Translate): SheetChip[] {
  const key = orderKeyOf(row)
  const news = row.news
  const home = page(pageOf(prefix, row))
  const out: SheetChip[] = []
  const add = (tone: GridTone, icon: string, words: string, door: SheetChip['door'], hint?: string) => out.push({ tone, icon, words, door, ...(hint ? { hint } : {}) })
  if (news.unread > 0) add('info', 'message-circle', t('office.chip.new', { count: news.unread }), home, t('office.chip.newHint', { count: news.unread }))
  if (news.remakeOf) add('neutral', 'undo-2', t('office.chip.remakeOf', { number: news.remakeOf.number }), page(pageOf(prefix, { kind: 'ORDER', id: news.remakeOf.id })), t('office.chip.remakeOfHint'))
  if (news.sentAsText) add('info', 'mail', t('office.chip.sentAsText'), home, t('office.chip.sentAsTextHint'))
  if (news.withDesigner) add('info', 'image', t('office.chip.withDesigner'), home, t('office.chip.withDesignerHint'))
  if (news.next === 'CONFIRM') add('info', 'check', t('office.chip.confirm'), windowDoor('confirm', key), t('office.chip.confirmHint'))
  if (news.next === 'PRINT') add('neutral', 'printer', t('office.chip.print'), windowDoor('print', key), t('office.chip.printHint'))
  if (news.next === 'PRINT_AGAIN') add('danger', 'printer', t('office.chip.printAgain'), windowDoor('printAgain', key), t('office.chip.printAgainHint'))
  if (news.design === 'WAITS') add('info', 'hourglass', t('office.chip.designWaits'), home, t('office.chip.designWaitsHint'))
  if (news.design === 'APPROVED') add('success', 'check', t('office.chip.designApproved'), home)
  if (news.design === 'CHANGE') add('info', 'image', t('office.chip.designChange'), home)
  if (news.problems > 0) add('danger', 'alert-triangle', t('office.chip.problems', { count: news.problems }), page(pageOf(prefix, row, 'production')))
  if (news.next === 'SHIP') add('success', 'truck', t('office.chip.ship'), windowDoor('ship', key))
  if (news.label === 'RECEIVED') add('success', 'check', t('office.chip.labelReceived'), page(pageOf(prefix, row, 'shipments')))
  if (news.label === 'WAITS') add('warning', 'hourglass', t('office.chip.labelWaits'), page(pageOf(prefix, row, 'shipments')))
  if (news.openAsks > 0) add('warning', 'alert-triangle', t('office.chip.toAnswer', { count: news.openAsks }), windowDoor('asks', key), t('office.chip.toAnswerHint', { count: news.openAsks }))
  if (news.openDetails > 0) add('warning', 'hourglass', t('office.chip.open', { count: news.openDetails }), home, t('office.chip.openHint', { count: news.openDetails }))
  if (news.late) add('danger', 'clock', t('office.chip.late'), home)
  if (news.paymentNotices > 0) add('info', 'banknote', t('office.chip.paid', { count: news.paymentNotices }), page(pageOf(prefix, row, 'money')), t('office.chip.paidHint'))
  return out
}

/** A read row as the part's order (the office's: an office number on an ORDER, the request's own on a REQUEST — the read decides). */
export function sheetOrderOf(row: SheetRowRead, prefix: string, t: Translate): OrdersSheetOrder {
  const key = orderKeyOf(row)
  return {
    key,
    record: { kind: row.kind, id: row.id, version: row.version },
    number: row.number,
    subject: row.subject,
    customer: row.party,
    life: row.life,
    wantedFor: row.wantedFor,
    promised: row.promised,
    daysLate: row.daysLate,
    where: row.where,
    picture: row.picture,
    chips: newsChipsOf(row, prefix, t),
    pieces: row.pieces,
    may: { open: true, confirm: row.may.confirm, deleteDraft: row.may.deleteDraft, editLines: row.may.editLines },
    lines: row.lines.map((line) => ({ key: lineKeyOf(key, line.id), id: line.id, seq: line.seq, kind: line.kind, product: line.product, text: line.text, material: line.material, sizes: line.sizes, sizeFileId: line.sizeFileId, pieces: line.pieces, own: line.own, asks: line.asks })),
  }
}

/** The office's columns, in the design's order. NO price column. */
export const OFFICE_COLUMNS: readonly SheetColumnId[] = Object.freeze(['what', 'customer', 'wanted', 'promised', 'where', 'news', 'material', 'sizes', 'pieces', 'details', 'act'])

// ---- filters and the six tiles -----------------------------------------------------------------------------------------------

export type TileId = keyof SheetTiles

/** The six tiles (`officeKpis`): each one's tone and the sheet filter it opens. */
export const TILES: ReadonlyArray<{ readonly id: TileId; readonly tone: GridTone; readonly filter: SheetFilter }> = Object.freeze([
  { id: 'incoming', tone: 'info', filter: 'incoming' },
  { id: 'waitingForPrint', tone: 'neutral', filter: 'confirmed' },
  { id: 'inProduction', tone: 'warning', filter: 'production' },
  { id: 'problems', tone: 'danger', filter: 'production' },
  { id: 'late', tone: 'danger', filter: 'production' },
  { id: 'readyToShip', tone: 'success', filter: 'ready' },
])

/** The filters whose count the read gives (a tile counts the same orders). */
const FILTER_COUNT: Partial<Record<SheetFilter, TileId>> = { incoming: 'incoming', confirmed: 'waitingForPrint', production: 'inProduction', ready: 'readyToShip' }

/** All · Drafts · Incoming · Confirmed · In production · Ready to ship · Shipped · Delivered, and the chip "Withdrawn" (hidden by default). */
export function filtersOf(tiles: SheetTiles | null, t: Translate): Array<{ id: SheetFilter; words: string; count?: number }> {
  return (['all', 'drafts', 'incoming', 'confirmed', 'production', 'ready', 'shipped', 'delivered', 'withdrawn'] as const).map((id) => {
    const tile = FILTER_COUNT[id]
    return tile && tiles ? { id, words: t(`office.filter.${id}`), count: tiles[tile] } : { id, words: t(`office.filter.${id}`) }
  })
}

export function tilesOf(tiles: SheetTiles | null, t: Translate, onPick: (filter: SheetFilter) => void): Array<{ id: string; words: string; count: number; tone: GridTone; onPick(): void }> {
  if (!tiles) return []
  return TILES.map((tile) => ({ id: tile.id, words: t(`office.tile.${tile.id}`), count: tiles[tile.id], tone: tile.tone, onPick: () => onPick(tile.filter) }))
}

// ---- the bulk acts' plans: each skips what it cannot do and says how many ---------------------------------------------------------

/** A text order: the customer sent words, no product is picked yet (design § 5g). */
export const isTextOrder = (row: Pick<SheetRowRead, 'news'>): boolean => row.news.sentAsText

/** A Sent order that holds (A-5: Confirm needs a product on every line; a customer on hold waits). */
export const holdsConfirm = (row: Pick<SheetRowRead, 'lines' | 'customerOnHold'>): boolean => row.customerOnHold || row.lines.some((line) => line.product === null)

/** Confirm N: the Sent orders the person may confirm; text orders and the ones that hold are skipped and counted. */
export function confirmPlanOf(rows: readonly SheetRowRead[], keys: readonly string[]): { readonly go: SheetRowRead[]; readonly text: number; readonly held: number; readonly other: number } {
  const picked = rows.filter((row) => keys.includes(orderKeyOf(row)))
  const go: SheetRowRead[] = []
  let text = 0
  let held = 0
  let other = 0
  for (const row of picked) {
    if (row.kind !== 'REQUEST' || row.life !== 'SENT' || !row.may.confirm) other++
    else if (isTextOrder(row)) text++
    else if (holdsConfirm(row)) held++
    else go.push(row)
  }
  return { go, text, held, other }
}

/** Delete the drafts: only drafts the person may delete (a sent order is never deleted). */
export function deletePlanOf(rows: readonly SheetRowRead[], keys: readonly string[]): { readonly go: SheetRowRead[]; readonly other: number } {
  const picked = rows.filter((row) => keys.includes(orderKeyOf(row)))
  const go = picked.filter((row) => row.kind === 'REQUEST' && row.life === 'DRAFT' && row.may.deleteDraft)
  return { go, other: picked.length - go.length }
}

/** Restrict: confirmed orders (a SalesOrder) not restricted yet. */
export function restrictPlanOf(rows: readonly SheetRowRead[], keys: readonly string[]): { readonly go: SheetRowRead[]; readonly other: number } {
  const picked = rows.filter((row) => keys.includes(orderKeyOf(row)))
  const go = picked.filter((row) => row.kind === 'ORDER' && !row.restricted && row.life !== 'WITHDRAWN')
  return { go, other: picked.length - go.length }
}

/** Export: the selected orders as a spreadsheet file (CSV), the order's words only — never a price. */
export function csvOf(rows: readonly SheetRowRead[], keys: readonly string[], t: Translate, lifeWords: (row: SheetRowRead) => string): string {
  const cell = (value: string | number | null): string => {
    const text = value === null ? '' : String(value)
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const head = ['number', 'subject', 'customer', 'state', 'wanted', 'promised', 'lines', 'pieces'].map((column) => cell(t(`office.export.${column}`)))
  const body = rows.filter((row) => keys.includes(orderKeyOf(row))).map((row) => [row.number, row.subject, row.party.name, lifeWords(row), row.wantedFor, row.promised, row.lines.length, row.pieces].map(cell).join(','))
  return [head.join(','), ...body].join('\n')
}

// ---- typing (L2): where a typed cell goes ----------------------------------------------------------------------------------------

/** Sizes as typed ("48:2 50:3", "48 × 2 · 50 × 3", "XL x 1") → pieces by size; null: it does not read as sizes. */
export function sizesFromText(text: string): Array<{ size: string; quantity: number }> | null {
  const source = text.trim()
  if (source === '') return []
  const parts = source
    .replace(/\s*[×:]\s*/g, ':')
    .replace(/\s+x\s+/gi, ':')
    .split(/[\s·,;]+/)
    .filter(Boolean)
  const out = new Map<string, number>()
  for (const part of parts) {
    const found = /^(.+):(\d+)$/.exec(part)
    if (!found) return null
    const quantity = Number(found[2])
    if (quantity > 0) out.set(found[1]!, (out.get(found[1]!) ?? 0) + quantity)
  }
  return out.size > 0 ? [...out].map(([size, quantity]) => ({ size, quantity })) : null
}

export type CommitRoute =
  | { readonly kind: 'header'; readonly requestId: string; readonly body: { readonly subject: string | null } | { readonly requestedDate: string | null } }
  | { readonly kind: 'line'; readonly requestId: string; readonly lineId: string; readonly body: { readonly sizes: Array<{ size: string; quantity: number }> } }
  | { readonly kind: 'customLine'; readonly requestId: string; readonly lineId: string; readonly body: { readonly description: string | null } | { readonly colourText: string | null } | { readonly quantity: number } | { readonly sizes: Array<{ size: string; quantity: number }> } }
  | { readonly kind: 'review'; readonly orderId: string; readonly lineId: string; readonly sizes: Readonly<Record<string, number>> }
  | { readonly kind: 'refused'; readonly why: 'confirmFirst' | 'readOnly' | 'sizes' | 'catalogueMaterial' | 'cataloguePieces' | 'catalogueProduct' }

/**
 * L2 per row kind: a DRAFT saves in place (the subject and the wanted day; a catalogue line's sizes; a described or custom line's
 * words, material, pieces and sizes — a catalogue line's colour and pieces are the order page's); a SENT order reads only ("Confirm it
 * first"); a CONFIRMED order (AMEND) stages ONE change of a line's sizes for the Review and save window; later: read only.
 */
export function commitRouteOf(row: SheetRowRead, line: SheetLineRead | null, column: SheetColumnId, value: string): CommitRoute {
  if (row.life === 'SENT' && row.kind === 'REQUEST') return { kind: 'refused', why: 'confirmFirst' }
  const mode = row.may.editLines
  if (mode === 'DRAFT' && row.kind === 'REQUEST') {
    if (!line) {
      if (column === 'what') return { kind: 'header', requestId: row.id, body: { subject: value.trim() === '' ? null : value.trim() } }
      if (column === 'wanted') return { kind: 'header', requestId: row.id, body: { requestedDate: value === '' ? null : value } }
      return { kind: 'refused', why: 'readOnly' }
    }
    if (column === 'sizes') {
      const sizes = sizesFromText(value)
      if (sizes === null) return { kind: 'refused', why: 'sizes' }
      return line.kind === 'CATALOGUE' ? { kind: 'line', requestId: row.id, lineId: line.id, body: { sizes } } : { kind: 'customLine', requestId: row.id, lineId: line.id, body: { sizes } }
    }
    if (line.kind === 'CATALOGUE') return { kind: 'refused', why: column === 'material' ? 'catalogueMaterial' : column === 'pieces' ? 'cataloguePieces' : 'catalogueProduct' }
    if (column === 'what') return { kind: 'customLine', requestId: row.id, lineId: line.id, body: { description: value.trim() === '' ? null : value.trim() } }
    if (column === 'material') return { kind: 'customLine', requestId: row.id, lineId: line.id, body: { colourText: value.trim() === '' ? null : value.trim() } }
    if (column === 'pieces') return { kind: 'customLine', requestId: row.id, lineId: line.id, body: { quantity: Number(value) } }
    return { kind: 'refused', why: 'readOnly' }
  }
  if (mode === 'AMEND' && row.kind === 'ORDER' && line && column === 'sizes') {
    const sizes = sizesFromText(value)
    if (sizes === null || sizes.length === 0) return { kind: 'refused', why: 'sizes' }
    return { kind: 'review', orderId: row.id, lineId: line.id, sizes: Object.fromEntries(sizes.map((entry) => [entry.size, entry.quantity])) }
  }
  return { kind: 'refused', why: 'readOnly' }
}

/** The row and line a commit names (by the part's keys). */
export function rowOfKey(rows: readonly SheetRowRead[], orderKey: string, lineKey: string | null): { readonly row: SheetRowRead; readonly line: SheetLineRead | null } | null {
  const row = rows.find((entry) => orderKeyOf(entry) === orderKey)
  if (!row) return null
  if (lineKey === null) return { row, line: null }
  const line = row.lines.find((entry) => lineKeyOf(orderKey, entry.id) === lineKey)
  return line ? { row, line } : null
}

/** A saved draft cell, put in place on the row as read (rows never jump; the next read brings the server's own words). */
export function patchRow(row: SheetRowRead, lineId: string | null, column: SheetColumnId, value: string, version: number): SheetRowRead {
  if (lineId === null) {
    if (column === 'what') return { ...row, version, subject: value.trim() === '' ? null : value.trim() }
    if (column === 'wanted') return { ...row, version, wantedFor: value === '' ? null : value }
    return { ...row, version }
  }
  const lines = row.lines.map((line) => {
    if (line.id !== lineId) return line
    if (column === 'what') return { ...line, text: value.trim() === '' ? null : value.trim() }
    if (column === 'material') return { ...line, material: value.trim() === '' ? null : value.trim() }
    if (column === 'pieces') return { ...line, pieces: Number(value) }
    if (column === 'sizes') {
      const sizes = sizesFromText(value) ?? []
      const pieces = sizes.reduce((sum, entry) => sum + entry.quantity, 0)
      return { ...line, sizes: value.trim() === '' ? null : value.trim(), pieces: pieces > 0 ? pieces : line.pieces }
    }
    return line
  })
  return { ...row, version, lines, pieces: lines.reduce((sum, line) => sum + line.pieces, 0) }
}

/**
 * owb-of4 extra step — Give to the designer: confirmed orders (a SalesOrder: the route takes order ids) that are not withdrawn and not
 * with the designer already; the others are skipped and counted; at most 100 at once.
 */
export function designerPlanOf(rows: readonly SheetRowRead[], keys: readonly string[], max = 100): { readonly go: SheetRowRead[]; readonly already: number; readonly other: number; readonly tooMany: boolean } {
  const picked = rows.filter((row) => keys.includes(orderKeyOf(row)))
  const go: SheetRowRead[] = []
  let already = 0
  let other = 0
  for (const row of picked) {
    if (row.kind !== 'ORDER' || row.life === 'WITHDRAWN') other++
    else if (row.news.withDesigner) already++
    else go.push(row)
  }
  return { go, already, other, tooMany: go.length > max }
}
