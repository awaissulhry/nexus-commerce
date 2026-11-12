import { describe, expect, it } from 'vitest'
import { STOCK_MOVE_REASONS } from '../ledger/moves'
import { BRIDGE_ORDER, bridgeOf, bridgeWords, dayText, REASON_WORDS, signOf } from './bridge'

describe('the balance bridge of a stock figure (B-W2b-314, SCM-191)', () => {
  it('lists every reason of the ledger once, each with its words and sign', () => {
    expect([...BRIDGE_ORDER].sort()).toEqual([...STOCK_MOVE_REASONS].sort())
    for (const reason of STOCK_MOVE_REASONS) expect(REASON_WORDS[reason].en.length).toBeGreaterThan(0)
    expect(signOf('RECEIPT')).toBe('+')
    expect(signOf('ISSUE')).toBe('−')
    expect(signOf('ADJUSTMENT')).toBe('±')
    expect(signOf('TRANSFER_OUT')).toBe('−')
  })

  it('walks from the start through each reason, in the formula order, to the end', () => {
    const bridge = bridgeOf({
      start: '80',
      sums: [
        { reason: 'ISSUE', in: '0', out: '5.8', moves: 2 },
        { reason: 'RECEIPT', in: '10', out: '0', moves: 1 },
        { reason: 'ADJUSTMENT', in: '0', out: '0', moves: 0 },
      ],
      end: '84.2',
    })
    expect(bridge.steps.map((step) => [step.reason, step.net, step.before, step.after])).toEqual([
      ['RECEIPT', '10.0000', '80.0000', '90.0000'],
      ['ISSUE', '-5.8000', '90.0000', '84.2000'],
    ])
    expect(bridge).toMatchObject({ start: '80.0000', sum: '84.2000', end: '84.2000', addsUp: true, gap: '0.0000', moves: 3 })
    expect(bridgeWords(bridge, { from: '2026-10-01', to: '2026-11-12' }, 'M2', 'en')).toBe('80 m² on 1 Oct 2026 + 10 m² receipts − 5.8 m² issues = 84.2 m² on 12 Nov 2026 ✓')
    expect(bridgeWords(bridge, { from: '2026-10-01', to: '2026-11-12' }, 'M2', 'it')).toBe('80 m² al 1 ott 2026 + 10 m² ricevimenti − 5,8 m² prelievi = 84,2 m² al 12 nov 2026 ✓')
  })

  it('says a gap in words (a gap is a bug)', () => {
    const bridge = bridgeOf({ start: '0', sums: [{ reason: 'RECEIPT', in: '10', out: '0', moves: 1 }], end: '10.2' })
    expect(bridge).toMatchObject({ addsUp: false, gap: '0.2000' })
    expect(bridgeWords(bridge, { from: null, to: '2026-11-12' }, 'M', 'en')).toBe('0 m at the start + 10 m receipts does not add up to 10.2 m on 12 Nov 2026 by 0.2 m: reported')
  })

  it('writes a day in both languages', () => {
    expect(dayText('2026-01-09', 'it')).toBe('9 gen 2026')
    expect(dayText('2026-12-31', 'en')).toBe('31 Dec 2026')
  })
})
