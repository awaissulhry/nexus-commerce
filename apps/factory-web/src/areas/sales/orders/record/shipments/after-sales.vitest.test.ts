import { describe, expect, it } from 'vitest'
import type { OrderLinks } from '../links/api'
import { readyLinks } from '../links/model'
import { afterSalesOf } from './after-sales'

/**
 * F-OS-104 (order SHIPMENTS tab, 10-design §6) — Complaints & returns, pure: ONE list newest first, both kinds; titled by what the reader
 * may see; each row's shipment, pieces, status and what comes next; the closed ones folded; a list cut at its limit says so. Made-up.
 */

const links = (over: Partial<OrderLinks> = {}): OrderLinks => ({
  order: { id: 'so-2', number: 'SEED-SO-0002' },
  complaints: [
    { id: 'c1', number: 'CMP-0012', status: 'INVESTIGATING', receivedAt: '2026-11-20T09:00:00.000Z', category: 'FIT', severity: 'MAJOR', answerDueOn: '2026-11-28', shipment: { id: 'sh-11', number: 'SEED-SH-0011' } },
    { id: 'c2', number: 'CMP-0009', status: 'CLOSED', receivedAt: '2026-11-02T09:00:00.000Z', category: null, severity: null, answerDueOn: null, shipment: null },
  ],
  returns: [{ id: 'r1', number: 'RMA-0007', status: 'REQUESTED', requestedAt: '2026-11-21T09:00:00.000Z', closedAt: null, outcomeWanted: 'REPLACE', pieces: 4, replacementOrder: { id: 'so-31', number: 'SEED-SO-0031' } }],
  rePromises: [],
  gates: [],
  asOf: '2026-11-22T09:00:00.000Z',
  ...over,
})
const SHIPMENTS = [{ id: 'sh-11' }, { id: 'sh-12' }]

describe('one list, newest first, both kinds', () => {
  it('each row: its kind and number, about (its shipment\'s row; a return names no shipment), what, status, next; closed folded', () => {
    const after = afterSalesOf(readyLinks(links()), SHIPMENTS)
    if (after.state !== 'ready') throw new Error('ready expected')
    expect(after.title).toEqual({ ns: 'orders', key: 'links.title' })
    expect(after.open.map((row) => row.number)).toEqual(['RMA-0007', 'CMP-0012'])
    expect(after.closed.map((row) => row.number)).toEqual(['CMP-0009'])
    const [rma, cmp] = after.open
    expect(rma).toMatchObject({ kind: 'return', about: { kind: 'returnLines' }, waiting: true, replacement: { id: 'so-31', number: 'SEED-SO-0031' }, what: [{ key: 'ships.carries.pieces', params: { count: 4 } }] })
    expect(rma!.next).toEqual([{ key: 'after.next.wants', words: { outcome: { ns: 'orders', key: 'links.wanted.REPLACE' } } }])
    expect(cmp).toMatchObject({ kind: 'complaint', about: { kind: 'shipment', id: 'sh-11', number: 'SEED-SH-0011', onThisOrder: true }, waiting: false, what: [{ ns: 'complaints', key: 'category.FIT' }, { ns: 'orders', key: 'links.severity.MAJOR' }] })
    expect(cmp!.next).toEqual([{ key: 'after.next.answerDue', days: { day: '2026-11-28' } }])
    expect(after.closed[0]!.about).toEqual({ kind: 'order' })
    expect(after.answer).toEqual([
      { key: 'after.answer.open', params: { count: 2 } },
      { key: 'after.answer.waiting', params: { count: 1 } },
      { key: 'after.answer.closed', params: { count: 1 } },
    ])
    expect(after.truncated).toBe(false)
  })

  it('titled by what the reader may see; neither right: no section; nothing reported: one line', () => {
    const returnsOnly = afterSalesOf(readyLinks(links({ complaints: null })), SHIPMENTS)
    expect(returnsOnly.state === 'ready' && returnsOnly.title).toEqual({ ns: 'orders', key: 'links.returns.title' })
    const complaintsOnly = afterSalesOf(readyLinks(links({ returns: null })), SHIPMENTS)
    expect(complaintsOnly.state === 'ready' && complaintsOnly.title).toEqual({ ns: 'orders', key: 'links.complaints.title' })
    expect(afterSalesOf(readyLinks(links({ complaints: null, returns: null })), SHIPMENTS)).toEqual({ state: 'hidden' })
    const none = afterSalesOf(readyLinks(links({ complaints: [], returns: [] })), SHIPMENTS)
    expect(none.state === 'ready' && none.answer).toEqual([{ key: 'after.answer.empty' }])
    expect(afterSalesOf(null, SHIPMENTS)).toEqual({ state: 'hidden' })
    expect(afterSalesOf({ state: 'loading' }, SHIPMENTS)).toEqual({ state: 'loading' })
    expect(afterSalesOf({ state: 'error', problem: 'links.problem.unavailable' }, SHIPMENTS)).toEqual({ state: 'error', problem: 'links.problem.unavailable' })
  })

  it('a shipment not of this order is named but not linked; a list cut at 50 says so (only a list the reader may see)', () => {
    const other = afterSalesOf(readyLinks(links()), [{ id: 'sh-12' }])
    expect(other.state === 'ready' && other.open[1]!.about).toEqual({ kind: 'shipment', id: 'sh-11', number: 'SEED-SH-0011', onThisOrder: false })
    const cut = afterSalesOf(readyLinks(links({ truncated: { complaints: false, returns: true } })), SHIPMENTS)
    expect(cut.state === 'ready' && cut.truncated).toBe(true)
    const hiddenCut = afterSalesOf(readyLinks(links({ returns: null, truncated: { complaints: false, returns: true } })), SHIPMENTS)
    expect(hiddenCut.state === 'ready' && hiddenCut.truncated).toBe(false)
  })
})
