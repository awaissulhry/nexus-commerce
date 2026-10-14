/**
 * Matrix bulk Edit v2 (2026-10-12) — a verb preview says what the GRID says. The Edit dialog shows each preview line's
 * `fromLabel → toLabel` verbatim beside the rows' current values, which the page reads with the grid's own word functions.
 *
 * `@nexus/shared/matrix-preview` RESTATES the design system's cell words (`renderers/matrixCells.ts` is mirrored
 * byte-for-byte into apps/factory, which has no `@nexus/shared`, so the grid cannot import them). This test — in apps/web,
 * free to import both — holds the two equal for every sync kind and queue state, and the "Sells from" label equal to the
 * From cell (`fromCellText`). A word changed on one side only is a red test, not a second truth.
 */
import { describe, expect, it } from 'vitest'
import { matrixBusinessPriceText, matrixBusinessSettingOfCell, matrixBusinessTiersText, matrixCellText, matrixModeWord, matrixQtyText, matrixQueueWord } from '@/design-system/grid/renderers/matrixCells'
import { MATRIX_COPY, type BusinessCell, type MatrixCells, type QueueCell, type QueueState, type SourceCell, type SyncCell, type SyncKind } from './contract'
import { businessPriceWords, businessSettingOfCell, businessTiersWords, queueStateWord, syncBufferText, syncLabel, syncModeWord, syncQtyText } from './preview'
import { fromCellText } from './sellsFrom'

const cellsWith = (over: Partial<MatrixCells>): MatrixCells => ({
  listingId: 'l1', version: 1, listing: null, fulfilment: null, sync: null, queue: null, price: null, sale: null, writable: {}, writeBlockedReason: {}, ...over,
})

const KINDS: SyncKind[] = ['FOLLOW', 'PINNED', 'PAUSED', 'FBA_EXCLUDED', 'UNCOUNTED', 'CLOSED']
const syncs: SyncCell[] = KINDS.flatMap((kind) => (['FOLLOW', 'PINNED'] as const).flatMap((mode) => [
  { kind, via: kind === 'PAUSED' ? 'LISTING' : null, mode, intended: 7, held: 5, buffer: 2, poolAvailable: 9, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
  { kind, via: kind === 'PAUSED' ? 'POLICY' : null, mode, intended: null, held: null, buffer: 0, poolAvailable: null, routedLocations: [], fbaAtAmazon: 3, oversold: true },
] satisfies SyncCell[]))

describe('preview words = grid words', () => {
  it('Mode, Qty and Buffer, for every sync kind and mode', () => {
    for (const s of [...syncs, null]) {
      const cells = cellsWith({ sync: s })
      const label = JSON.stringify(s)
      expect(syncModeWord(s), label).toBe(matrixModeWord(s))
      expect(syncQtyText(s), label).toBe(matrixQtyText(cells))
      expect(syncBufferText(s), label).toBe(matrixCellText('syncBuffer', cells, { currency: 'EUR' }))
      const mode = matrixModeWord(s), qty = matrixQtyText(cells)
      expect(syncLabel(s), label).toBe(mode === '—' ? qty : `${mode} · ${qty}`)
    }
  })

  it('the Sync word, for every queue state (with the age when given the clock)', () => {
    const now = Date.parse('2026-10-12T10:02:00.000Z')
    const STATES: QueueState[] = ['sent', 'queued', 'sending', 'failed', 'dead', 'paused', 'never']
    for (const state of STATES) for (const via of ['POLICY', 'LISTING', null] as const) for (const at of [null, '2026-10-12T10:00:00.000Z']) {
      const q: QueueCell = { state, at, reason: null, syncType: null, via }
      expect(queueStateWord(q, now), JSON.stringify(q)).toBe(matrixQueueWord(cellsWith({ queue: q }), now))
      if (at === null) expect(queueStateWord(q)).toBe(matrixQueueWord(cellsWith({ queue: q }), now))
    }
    expect(queueStateWord(null)).toBe(matrixQueueWord(cellsWith({ queue: null })))
  })

  it('Amazon Business: the B2B price and Tiers words, and the setting a cell shows, for every rule and tier type', () => {
    const base: BusinessCell = { rule: null, percent: null, exact: null, tiers: null, price: null, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR', warnings: [], held: null, send: null, live: null, reported: null }
    const cells: BusinessCell[] = [
      base,
      { ...base, reported: { price: 95 } },
      { ...base, rule: 'PERCENT_OFF', percent: 5, price: 99.75 },
      { ...base, rule: 'PERCENT_OFF', percent: 0, price: 105, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 101.85 }, { minQty: 5, value: 5.5, unitPrice: 99.23 }] } },
      { ...base, rule: 'PERCENT_OFF', percent: 7.25, price: null, normalPrice: null },
      { ...base, rule: 'FIXED', exact: 32.95, price: 32.95, tiers: { type: 'fixed', levels: [{ minQty: 3, value: 30, unitPrice: 30 }, { minQty: 10, value: 28.5, unitPrice: 28.5 }] } },
      { ...base, rule: 'FIXED', exact: 80, price: 80, currency: 'GBP', tiers: { type: 'percent', levels: [] } },
    ]
    for (const b of [...cells, null]) {
      const label = JSON.stringify(b)
      expect(businessPriceWords(b), label).toBe(matrixBusinessPriceText(b))
      expect(businessTiersWords(b), label).toBe(matrixBusinessTiersText(b))
      if (b) expect(businessSettingOfCell(b), label).toEqual(matrixBusinessSettingOfCell(b))
    }
  })

  it('Sells from reads as the From cell: the codes in sale order, or None', () => {
    const row = { role: 'variant' as const, stock: { available: 10, uncounted: false, locations: [] as Array<{ code: string; available: number }>, source: null } }
    const coord = { kind: 'market' as const, channel: 'EBAY', label: 'eBay · IT' }
    const sync: SyncCell = { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 4, held: 4, buffer: 0, poolAvailable: 4, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }
    const sources: SourceCell[] = [
      { own: [], marketDefault: ['IT-MAIN'], defaultOrigin: 'routes', effective: [{ code: 'IT-MAIN', available: 4 }], writable: true, blockedReason: null },
      { own: ['MI-3PL', 'IT-MAIN'], marketDefault: ['IT-MAIN'], defaultOrigin: 'market', effective: [{ code: 'MI-3PL', available: 1 }, { code: 'IT-MAIN', available: 3 }], writable: true, blockedReason: null },
      { own: ['MI-3PL'], marketDefault: ['IT-MAIN'], defaultOrigin: 'market', effective: [], writable: true, blockedReason: null },
      { own: [], marketDefault: ['IT-MAIN', 'MI-3PL'], defaultOrigin: 'routes', effective: [], writable: true, blockedReason: null },
      { own: [], marketDefault: [], defaultOrigin: 'routes', effective: [], writable: true, blockedReason: null },
    ]
    for (const src of sources) {
      const now = src.effective.length ? src.effective.map((e) => e.code) : src.own
      expect(MATRIX_COPY.sourceLabel(now, src.marketDefault), JSON.stringify(src)).toBe(fromCellText(row, cellsWith({ sync, source: src }), coord))
    }
  })
})
