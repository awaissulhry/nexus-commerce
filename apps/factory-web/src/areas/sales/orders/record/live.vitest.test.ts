import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { order } from '../_demo/fixtures'
import { changedBy, COALESCE, EMPTY_QUEUE, enqueue, nextDue, opened, partsOf, piecesDue, take, watchedIds, type LiveWatch } from './live'

/**
 * F-SA-239 (sales page plan P17, R9; review C-18, C-21) — the order page live, part by part: the read's own watch list decides which
 * parts an event re-reads, only when it names the order's own records; ONE coalesce table (parts 700 ms; piece counts 3 s trailing, at
 * most one read in 10 s) that never drops the last event; Money, Shipments and Files stale while hidden; typed work kept with
 * "Changed by <name> at hh:mm · Reload".
 */

const value = order('IN_PRODUCTION')
const LIVE: LiveWatch = {
  events: [
    { type: 'sales_order.status_changed', parts: ['order', 'lines', 'changes'] },
    { type: 'production.scan_recorded', parts: ['lines', 'headline'] },
    { type: 'shipment.status_changed', parts: ['money', 'shipments'] },
    { type: 'file.available', parts: ['files'] },
    { type: 'brand_production.stage_reached', parts: ['headline', 'people'] },
  ],
  ids: { workOrderIds: ['wo-1'], shipmentIds: ['sh-1'], invoiceIds: [], depositRequestIds: [], requestIds: ['rq-1'], changeIds: [] },
}

describe('which parts an event re-reads', () => {
  const ids = watchedIds(value, LIVE)

  it('the read’s watch list, only for an event that names the order or one of its own records; never a party id', () => {
    expect(partsOf({ type: 'sales_order.status_changed', fields: { orderId: value.id } }, LIVE, ids)).toEqual(['order', 'lines', 'changes'])
    expect(partsOf({ type: 'production.scan_recorded', fields: { workOrderId: 'wo-1' } }, LIVE, ids)).toEqual(['lines', 'headline'])
    expect(partsOf({ type: 'sales_order.status_changed', fields: { orderId: 'another' } }, LIVE, ids)).toEqual([])
    // A type the server does not list for this page: nothing (LIVE_PREFIXES went; a new event joins on the server).
    expect(partsOf({ type: 'thread.message_posted', fields: { recordId: value.id } }, LIVE, ids)).toEqual([])
    // No watch list (an older answer): only the order, on an event that names it.
    expect(partsOf({ type: 'anything', fields: { orderId: value.id } }, undefined, watchedIds(value, undefined))).toEqual(['order'])
    expect(ids.has('rq-1') && ids.has('sh-1') && ids.has(value.id)).toBe(true)
    const source = readFileSync(new URL('../model.ts', import.meta.url), 'utf8')
    expect(source).not.toContain("const LIVE_PREFIXES = ['sales_order.'")
  })
})

describe('ONE coalesce table: parts 700 ms, piece counts 3 s trailing and at most one read in 10 s, the last event never dropped', () => {
  it('a burst of part events is ONE read 700 ms after its first event, with every part of the burst', () => {
    let queue = enqueue(EMPTY_QUEUE, 'sales_order.status_changed', ['order', 'lines', 'changes'], 1_000, 'overview')
    queue = enqueue(queue, 'brand_production.stage_reached', ['headline', 'people'], 1_300, 'overview')
    expect(nextDue(queue)).toBe(1_000 + COALESCE.partsMs)
    expect(take(queue, 1_600).read).toEqual([])
    const due = take(queue, 1_700)
    expect([...due.read].sort()).toEqual(['changes', 'headline', 'lines', 'order', 'people'])
    expect(nextDue(due.queue)).toBeNull()
  })

  it('floor scans: 3 s after the LAST scan, never sooner than 10 s after the last read; the last scan is always read', () => {
    let queue = enqueue(EMPTY_QUEUE, 'production.scan_recorded', ['lines', 'headline'], 0, 'overview')
    queue = enqueue(queue, 'production.scan_recorded', ['lines', 'headline'], 2_000, 'overview')
    expect(piecesDue(queue)).toBe(2_000 + COALESCE.piecesTrailingMs)
    const first = take(queue, 5_000)
    expect([...first.read].sort()).toEqual(['headline', 'lines'])
    // A scan right after: 3 s trailing would be 8 s, but one read in 10 s holds it to 15 s — and it is still read then.
    const later = enqueue(first.queue, 'production.scan_recorded', ['lines'], 5_000, 'overview')
    expect(piecesDue(later)).toBe(5_000 + COALESCE.piecesAtMostEveryMs)
    expect(take(later, 9_000).read).toEqual([])
    expect(take(later, 15_000).read).toEqual(['lines'])
  })
})

describe('stale tabs and typed work', () => {
  it('Money, Shipments and Files read only while they show; hidden, they are stale and read when opened', () => {
    const queue = enqueue(EMPTY_QUEUE, 'shipment.status_changed', ['money', 'shipments'], 0, 'overview')
    expect(queue.stale).toEqual(['money', 'shipments'])
    expect(nextDue(queue)).toBeNull()
    const money = opened(queue, 'money')
    expect(money.read).toEqual(['money'])
    expect(money.queue.stale).toEqual(['shipments'])
    expect(opened(money.queue, 'lines').read).toEqual([])
    // Shown: read with the parts.
    expect(enqueue(EMPTY_QUEUE, 'file.available', ['files'], 0, 'files').parts).toEqual(['files'])
  })

  it('under typed work the order waits: "Changed by <name> at hh:mm" from the order read’s own last change; the floor, never a worker', () => {
    const lastChange = { order: { by: { kind: 'OFFICE' as const, name: 'Bea Esempio', words: { it: 'Bea Esempio', en: 'Bea Esempio' } }, at: '2026-11-18T09:42:00Z' }, changes: { by: { kind: 'CUSTOMER' as const, name: 'Brand Alpha', words: { it: 'Brand Alpha', en: 'Brand Alpha' } }, at: '2026-11-18T09:40:00Z' }, work: null, shipments: null, money: { by: { kind: 'FLOOR' as const, name: null, words: { it: 'Il reparto', en: 'The floor' } }, at: '2026-11-18T09:41:00Z' } }
    expect(changedBy(lastChange, ['order', 'lines'], 'en')).toEqual({ name: 'Bea Esempio', at: '2026-11-18T09:42:00Z' })
    expect(changedBy(lastChange, ['changes'], 'en')).toEqual({ name: 'Brand Alpha', at: '2026-11-18T09:40:00Z' })
    expect(changedBy(lastChange, ['money'], 'it')).toEqual({ name: 'Il reparto', at: '2026-11-18T09:41:00Z' })
    expect(changedBy(undefined, ['order'], 'en')).toEqual({ name: null, at: null })
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('record.changedBy', { name: 'Bea Esempio', time: '10:42' })).toMatch(/Bea Esempio.*10:42/)
    }
    const container = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain('if (typed) {')
    expect(container).not.toContain('liveTouches(')
  })
})
