import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { Order } from '../../api'
import type { ToldChange } from '../told'
import { moveReasonOf, promiseHistoryOf, toldOfMove } from './history'

// F-PT-204 (order PRODUCTION tab, W2): the promise history — "Date set" never a move (B21), each line's own day (B23), the reason in
// office words with the note apart and what the customer reads (B22), its Who was told line.

type Entry = Order['promiseHistory'][number]
const entry = (at: string, from: string | null, to: string, over: Partial<Entry> = {}): Entry => ({ at, actorId: 'u1', from, to, lineIds: [], reason: null, ...over })

describe('F-PT-204: the moves and the first promise', () => {
  it('SET is "Date set", never a move; the moves newest first with how many days later', () => {
    const view = promiseHistoryOf([entry('2026-11-12T09:00:00Z', null, '2026-12-01', { kind: 'SET' }), entry('2026-11-19T10:00:00Z', '2026-12-01', '2026-12-07', { kind: 'MOVED' }), entry('2026-11-20T10:00:00Z', '2026-12-07', '2026-12-05', { kind: 'MOVED' })])
    expect(view.set).toEqual({ to: '2026-12-01', at: '2026-11-12T09:00:00Z', actorId: 'u1' })
    expect(view.moves.map((move) => move.delta)).toEqual([-2, 6])
  })

  it('an older answer without `kind`: the oldest row with no day before is the first promise', () => {
    const view = promiseHistoryOf([entry('2026-11-19T10:00:00Z', '2026-12-01', '2026-12-07'), entry('2026-11-12T09:00:00Z', null, '2026-12-01')])
    expect(view.set?.to).toBe('2026-12-01')
    expect(view.moves).toHaveLength(1)
  })

  it('a lines’ move on different days says each line’s own day (never "— → 19 Dec"), no single delta', () => {
    const view = promiseHistoryOf([entry('2026-11-19T10:00:00Z', null, '2026-12-19', { kind: 'MOVED', lineIds: ['l1', 'l2'], fromByLine: [{ lineId: 'l1', from: '2026-12-05' }, { lineId: 'l2', from: '2026-12-10' }] })])
    expect(view.moves[0]!.from).toEqual([{ lineId: 'l1', from: '2026-12-05' }, { lineId: 'l2', from: '2026-12-10' }])
    expect(view.moves[0]!.delta).toBeNull()
    expect(view.set).toBeNull()
  })
})

describe('F-PT-204: why, split (B22)', () => {
  it('a curated code with the office’s note apart; free words are all the office’s (the customer reads "Our planning changed")', () => {
    expect(moveReasonOf('MATERIAL_LATE: tannery batch 12 late')).toEqual({ kind: 'given', code: 'MATERIAL_LATE', note: 'tannery batch 12 late' })
    expect(moveReasonOf('CAPACITY')).toEqual({ kind: 'given', code: 'CAPACITY', note: null })
    expect(moveReasonOf('Il cliente ha chiamato')).toEqual({ kind: 'given', code: 'PLANNING', note: 'Il cliente ha chiamato' })
  })

  it('no reason given: the automatic words (translated on screen), or none', () => {
    expect(moveReasonOf('Date changed on the order page.')).toEqual({ kind: 'automatic' })
    expect(moveReasonOf(null)).toEqual({ kind: 'none' })
    expect(moveReasonOf('  ')).toEqual({ kind: 'none' })
  })

  it('Who was told…: the promise change nearest the move (≤ 10 min), never another kind of change', () => {
    const change = (eventType: string, occurredAt: string): ToldChange => ({ batchId: 'b', messageId: `m-${occurredAt}`, occurredAt, at: occurredAt, eventType, requestId: null, people: 2, floor: { at: null, workOrders: [], leftOut: 0 }, workshop: { at: null, told: 0, waiting: 0 } })
    const changes = [change('sales_order.amended', '2026-11-19T10:00:30Z'), change('sales_order.promise_changed', '2026-11-19T10:02:00Z'), change('sales_order.promise_changed', '2026-11-19T12:00:00Z')]
    expect(toldOfMove('2026-11-19T10:00:00Z', changes)?.messageId).toBe('m-2026-11-19T10:02:00Z')
    expect(toldOfMove('2026-11-19T11:00:00Z', changes)).toBeNull()
  })

  it('the words in it + en; Changes › History points here once', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['productionTab.history.title', 'productionTab.history.never', 'productionTab.history.neverNoSince', 'productionTab.history.noPromise', 'productionTab.history.later', 'productionTab.history.sooner', 'productionTab.history.lines', 'productionTab.history.reasonAutomatic', 'productionTab.history.reasonNone', 'productionTab.history.officeNote', 'productionTab.history.customerReads', 'productionTab.history.by', 'productionTab.history.set', 'productionTab.history.setNote', 'productionTab.history.earlier', 'productionTab.history.tell', 'productionTab.history.pointer'])
        expect(t(key, { date: 'd', since: 's', count: 2, lines: 'l', note: 'n', words: 'w', name: 'n', at: 'a' }), `${locale} ${key}`).not.toMatch(/^productionTab\.|\{/)
    }
    const changes = readFileSync(new URL('../changes/view/HistorySection.tsx', import.meta.url), 'utf8') // F-OC-101: What changed's own file
    expect(changes).toContain("{t('productionTab.history.pointer')}")
    expect(changes).toContain("'production', search)}#promise-moves`}")
  })
})
