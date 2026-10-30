import { describe, expect, it } from 'vitest'
import { byCutDate, inView, kitOf, proposePicks, type PickSource } from './kit-rules'

/**
 * Picking & kits' pure rules (B-W2a-58): what a pick list proposes for one material (whole hides oldest first, a lot by
 * quantity, any lot), never stock another demand holds, what stays short; the kit's state; the saved rows; the order.
 */

const hide = (code: string, lot: string, onHand: string, location = 'A1-BIN'): PickSource => ({ lotId: lot, lotCode: lot, hideId: code, hideCode: code, locationId: location, locationCode: location, onHand })
const lotAt = (lot: string, onHand: string, location: string): PickSource => ({ lotId: lot, lotCode: lot, hideId: null, hideCode: null, locationId: location, locationCode: location, onHand })

describe('proposePicks', () => {
  it('takes whole hides oldest first until the need is covered, skipping a hide another demand holds', () => {
    const proposal = proposePicks({
      tracking: 'HIDE',
      toIssue: '90.0000',
      sources: [hide('H1', 'L1', '50.0000'), hide('H2', 'L1', '50.0000'), hide('H3', 'L1', '50.0000')],
      mine: [],
      others: [{ id: 'r1', lotId: 'L1', hideId: 'H1', open: '50.0000' }],
    })
    expect(proposal.picks.map((pick) => pick.hideCode)).toEqual(['H2', 'H3'])
    expect(proposal).toMatchObject({ reserved: '0.0000', short: '0.0000' })
  })

  it('counts its own reservations first and proposes only the rest; what nothing covers is short', () => {
    const proposal = proposePicks({ tracking: 'HIDE', toIssue: '120.0000', sources: [hide('H9', 'L1', '40.0000'), hide('H2', 'L1', '50.0000')], mine: [{ id: 'm1', lotId: 'L1', hideId: 'H9', open: '40.0000' }], others: [] })
    expect(proposal).toMatchObject({ reserved: '40.0000', short: '30.0000' })
    expect(proposal.picks.map((pick) => [pick.hideCode, pick.quantity])).toEqual([['H2', '50.0000']])
  })

  it('reserves a lot by quantity per lot, within what the lot and the whole material have free', () => {
    const proposal = proposePicks({
      tracking: 'LOT',
      toIssue: '30.0000',
      sources: [lotAt('OLD', '10.0000', 'B'), lotAt('OLD', '5.0000', 'A'), lotAt('NEW', '40.0000', 'C')],
      mine: [],
      others: [{ id: 'r', lotId: 'OLD', hideId: null, open: '12.0000' }],
    })
    expect(proposal.picks.map((pick) => [pick.lotCode, pick.quantity, pick.locations.map((place) => place.locationCode)])).toEqual([
      ['OLD', '3.0000', ['A', 'B']],
      ['NEW', '27.0000', ['C']],
    ])
    expect(proposal.short).toBe('0.0000')
  })

  it('takes an untracked material from any lot; an any-lot reservation of another demand lowers what is free', () => {
    const proposal = proposePicks({ tracking: 'NONE', toIssue: '10.0000', sources: [{ ...lotAt('-', '8.0000', 'A'), lotId: null, lotCode: null }], mine: [], others: [{ id: 'r', lotId: null, hideId: null, open: '5.0000' }] })
    expect(proposal.picks).toEqual([expect.objectContaining({ kind: 'ANY', quantity: '3.0000' })])
    expect(proposal.short).toBe('7.0000')
  })

  it('proposes nothing when the need is covered', () => {
    expect(proposePicks({ tracking: 'LOT', toIssue: '0.0000', sources: [lotAt('L', '9.0000', 'A')], mine: [], others: [] }).picks).toEqual([])
  })
})

describe('the kit, the saved rows, the order', () => {
  it('is OPEN, PARTLY or COMPLETE from what was issued per line', () => {
    expect(kitOf([{ planned: '10', issued: '0' }, { planned: '5', issued: '0' }])).toEqual({ status: 'OPEN', all: 2, picked: 0, short: 2 })
    expect(kitOf([{ planned: '10', issued: '10' }, { planned: '5', issued: '1' }])).toEqual({ status: 'PARTLY', all: 2, picked: 1, short: 1 })
    expect(kitOf([{ planned: '10', issued: '11' }, { planned: '5', issued: '5' }]).status).toBe('COMPLETE')
    expect(kitOf([]).status).toBe('OPEN')
  })

  it('puts a row in the saved rows', () => {
    const row = { kit: 'OPEN' as const, word: 'DELAYED', cutDate: '2026-10-30', created: false, status: 'RELEASED' }
    expect(inView('today', row, '2026-10-30')).toBe(true)
    expect(inView('today', { ...row, status: 'ON_HOLD' }, '2026-10-30')).toBe(false)
    expect(inView('today', { ...row, cutDate: '2026-10-31' }, '2026-10-30')).toBe(false)
    expect(inView('waiting', row, '2026-10-30')).toBe(true)
    expect(inView('waiting', { ...row, word: 'NOT_BOOKED' }, '2026-10-30')).toBe(false)
    expect(inView('complete', { ...row, kit: 'COMPLETE' }, '2026-10-30')).toBe(true)
    expect(inView('toCreate', row, '2026-10-30')).toBe(true)
    expect(inView('toCreate', { ...row, created: true }, '2026-10-30')).toBe(false)
    expect(inView('toCreate', { ...row, status: 'ON_HOLD' }, '2026-10-30')).toBe(false)
  })

  it('orders by cut date (none last), then priority, due date, number', () => {
    const row = (number: string, cutDate: string | null, priority = 0, dueDate: string | null = null) => ({ cutDate, workOrder: { number, priority, dueDate } })
    const rows = [row('C', null), row('B', '2026-11-02'), row('A', '2026-11-02', 5), row('D', '2026-11-01')]
    expect(rows.sort(byCutDate).map((entry) => entry.workOrder.number)).toEqual(['D', 'A', 'B', 'C'])
  })
})
