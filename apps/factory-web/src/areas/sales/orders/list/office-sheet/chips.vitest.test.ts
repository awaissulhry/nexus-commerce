import { describe, expect, it } from 'vitest'
import { createTranslator, catalogueFor } from '../../../../../lib/i18n/messages'
import { NO_NEWS, PRODUCTION_ROW, SENT_ROW, TILES, readRow } from './fixtures'
import { OFFICE_COLUMNS, filtersOf, newsChipsOf, sheetOrderOf, tilesOf } from './map'
import type { SheetNews } from './api'

const t = createTranslator('en', catalogueFor('en', 'orders-sheet', 'office'))
const PREFIX = '/w/demo'

const chipsOf = (news: Partial<SheetNews>, over: Parameters<typeof readRow>[0] = {}) => newsChipsOf(readRow({ ...over, news: { ...NO_NEWS, ...news } }), PREFIX, t)

describe('owb-of3 step 2 — each "Waits · news" fact is its chip, and each chip a door', () => {
  it('"n new" opens the order', () => {
    expect(chipsOf({ unread: 2 })).toEqual([expect.objectContaining({ words: '2 new', tone: 'info', icon: 'message-circle', door: { kind: 'page', target: 'page:/w/demo/sales/orders/order-1' } })])
  })

  it('Remake of … opens the order it is a remake of', () => {
    expect(chipsOf({ remakeOf: { id: 'order-9', number: 'SO-2026-0009' } })[0]).toMatchObject({ words: 'Remake of SO-2026-0009', door: { kind: 'page', target: 'page:/w/demo/sales/orders/order-9' } })
  })

  it('Sent as text and With the designer open the order; a draft or sent order opens today’s draft page (L3)', () => {
    const chips = newsChipsOf(readRow({ kind: 'REQUEST', id: 'req-1', life: 'SENT', news: { ...NO_NEWS, sentAsText: true, withDesigner: true } }), PREFIX, t)
    expect(chips.map((chip) => chip.words)).toEqual(['Sent as text', 'With the designer'])
    for (const chip of chips) expect(chip.door).toEqual({ kind: 'page', target: 'page:/w/demo/sales/orders/new?draft=req-1' })
  })

  it('the next act is a window: Confirm · Print and start… · Print again · Ship', () => {
    expect(chipsOf({ next: 'CONFIRM' })[0]).toMatchObject({ words: 'Confirm', door: { kind: 'window', target: 'confirm:ORDER:order-1' } })
    expect(chipsOf({ next: 'PRINT' })[0]).toMatchObject({ words: 'Print and start…', door: { kind: 'window', target: 'print:ORDER:order-1' } })
    expect(chipsOf({ next: 'PRINT_AGAIN' })[0]).toMatchObject({ words: 'Print again', tone: 'danger', door: { kind: 'window', target: 'printAgain:ORDER:order-1' } })
    expect(chipsOf({ next: 'SHIP' })[0]).toMatchObject({ words: 'Ship', door: { kind: 'window', target: 'ship:ORDER:order-1' } })
  })

  it('Design: waits / approved / change', () => {
    expect(chipsOf({ design: 'WAITS' })[0]?.words).toBe('Design: waits')
    expect(chipsOf({ design: 'APPROVED' })[0]?.words).toBe('Design approved')
    expect(chipsOf({ design: 'CHANGE' })[0]?.words).toBe('Design: change asked')
  })

  it('n problems opens Production; the label opens Shipments; "I paid" opens Money', () => {
    expect(chipsOf({ problems: 2 })[0]).toMatchObject({ words: '2 problems', door: { target: 'page:/w/demo/sales/orders/order-1?tab=production' } })
    expect(chipsOf({ label: 'RECEIVED' })[0]).toMatchObject({ words: 'Label received', door: { target: 'page:/w/demo/sales/orders/order-1?tab=shipments' } })
    expect(chipsOf({ label: 'WAITS' })[0]).toMatchObject({ words: 'Waits for the label', tone: 'warning' })
    expect(chipsOf({ paymentNotices: 1 })[0]).toMatchObject({ words: '1 “I paid”', door: { target: 'page:/w/demo/sales/orders/order-1?tab=money' } })
  })

  it('n to answer opens the asks window; n open and Late open the order', () => {
    expect(chipsOf({ openAsks: 3 })[0]).toMatchObject({ words: '3 to answer', door: { kind: 'window', target: 'asks:ORDER:order-1' } })
    expect(chipsOf({ openDetails: 2 })[0]).toMatchObject({ words: '2 open', tone: 'warning' })
    expect(chipsOf({ late: true })[0]).toMatchObject({ words: 'Late', tone: 'danger', icon: 'clock' })
  })

  it('no fact, no chip; facts keep the design’s order', () => {
    expect(chipsOf({})).toEqual([])
    expect(newsChipsOf(PRODUCTION_ROW, PREFIX, t).map((chip) => chip.words)).toEqual(['3 new', '2 problems', 'Late'])
  })
})

describe('owb-of3 step 2 — the office columns, filters and tiles', () => {
  it('the office sheet has no price column', () => {
    expect(OFFICE_COLUMNS).toEqual(['what', 'customer', 'wanted', 'promised', 'where', 'news', 'material', 'sizes', 'pieces', 'details', 'act'])
    expect(JSON.stringify(sheetOrderOf(SENT_ROW, PREFIX, t))).not.toMatch(/price|amount/i)
  })

  it('a tile’s count is its filter’s count, and the tile opens that filter', () => {
    const filters = filtersOf(TILES, t)
    const picked: string[] = []
    const tiles = tilesOf(TILES, t, (filter) => picked.push(filter))
    const countOf = (id: string) => filters.find((filter) => filter.id === id)?.count
    expect(countOf('incoming')).toBe(tiles.find((tile) => tile.id === 'incoming')?.count)
    expect(countOf('confirmed')).toBe(tiles.find((tile) => tile.id === 'waitingForPrint')?.count)
    expect(countOf('production')).toBe(tiles.find((tile) => tile.id === 'inProduction')?.count)
    expect(countOf('ready')).toBe(tiles.find((tile) => tile.id === 'readyToShip')?.count)
    tiles.forEach((tile) => tile.onPick())
    expect(picked).toEqual(['incoming', 'confirmed', 'production', 'production', 'production', 'ready'])
  })

  it('the filters: All · Drafts · Incoming · Confirmed · In production · Ready to ship · Shipped · Delivered, and Withdrawn last', () => {
    expect(filtersOf(TILES, t).map((filter) => filter.words)).toEqual(['All', 'Drafts', 'Incoming', 'Confirmed', 'In production', 'Ready to ship', 'Shipped', 'Delivered', 'Withdrawn'])
    expect(tilesOf(TILES, t, () => undefined).map((tile) => tile.words)).toEqual(['Incoming', 'Waiting for the print', 'In production', 'Problems', 'Late', 'Ready to ship'])
  })

  it('a row as the part’s order keeps the read’s number (a request never takes an office number)', () => {
    const order = sheetOrderOf(SENT_ROW, PREFIX, t)
    expect(order).toMatchObject({ key: 'REQUEST:req-sent', number: 'RQ-0042', record: { kind: 'REQUEST', id: 'req-sent', version: 3 } })
    expect(order.lines[0]?.key).toBe('REQUEST:req-sent/line-1')
  })
})
