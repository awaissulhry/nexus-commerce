import { describe, expect, it } from 'vitest'
import { addTotals, netOfWastage, yieldFigures, yieldTotals } from './rules'

/** Hide yield (B-W2a-13; MES-057): figures by hand. */

describe('hide yield', () => {
  it('pattern / used, waste = used − pattern; planned from the BOM need when the style sets none', () => {
    // Two cuts: 60 used for 48 of pieces (need 52.8 = 48 × 1.10), 40 used for 30 of pieces (need 33); 5 kept as remnant.
    const totals = yieldTotals([
      { used: '60', remnant: '5', pattern: '48', need: '52.8' },
      { used: '40', remnant: '0', pattern: '30', need: '33' },
    ])
    expect(yieldFigures(totals)).toEqual({
      used: '100.0000',
      unmatched: '0.0000',
      pattern: '78.0000',
      remnant: '5.0000',
      waste: '22.0000',
      wastePct: '22.00',
      yieldPct: '78.00',
      plannedPct: '90.91',
      variancePct: '-12.91',
    })
  })

  it('the style’s planned hide yield wins over the BOM’s; cuts of single parts are left out of the yield (never 100 %)', () => {
    const totals = yieldTotals([
      { used: '10', remnant: '0', pattern: null, need: null },
      { used: '20', remnant: '0', pattern: '17', need: '19' },
    ])
    expect(yieldFigures(totals, '85')).toMatchObject({ used: '30.0000', unmatched: '10.0000', pattern: '17.0000', waste: '3.0000', yieldPct: '85.00', plannedPct: '85.00', variancePct: '0.00', wastePct: '15.00' })
    expect(yieldFigures(yieldTotals([{ used: '10', remnant: '0', pattern: null, need: null }]))).toMatchObject({ unmatched: '10.0000', yieldPct: null, wastePct: null })
    expect(yieldFigures(yieldTotals([]))).toMatchObject({ used: '0.0000', yieldPct: null, plannedPct: null, variancePct: null })
  })

  it('summaries add areas first (never an average of percentages)', () => {
    const a = yieldTotals([{ used: '10', remnant: '0', pattern: '9', need: '10' }])
    const b = yieldTotals([{ used: '90', remnant: '0', pattern: '45', need: '50' }])
    expect(yieldFigures(addTotals([a, b])).yieldPct).toBe('54.00')
    expect(netOfWastage('52.8', '10').toFixed(4)).toBe('48.0000')
  })
})
