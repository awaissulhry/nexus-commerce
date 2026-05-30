import { describe, it, expect } from 'vitest'
import { forecastDailyDemand } from '../holt-winters.service.js'

// Build a 365-day series with a non-zero demand of `size` every `every` days.
function intermittent(every: number, size: number, len = 365): number[] {
  return Array.from({ length: len }, (_, i) => (i % every === every - 1 ? size : 0))
}

describe('RX.B2 — intermittent-demand routing', () => {
  it('routes sparse demand to Croston and does NOT collapse to zero', () => {
    const series = intermittent(10, 5) // ~0.5 units/day, ADI≈10
    const r = forecastDailyDemand(series, 90)
    expect(['CROSTON', 'SBA']).toContain(r.regime)
    // Croston rate ≈ size/interval = 5/10 = 0.5; stable across the horizon.
    expect(r.points[0].value).toBeGreaterThan(0.2)
    expect(r.points[89].value).toBeGreaterThan(0.2) // no decay to 0
    expect(r.points[89].value).toBeCloseTo(r.points[0].value, 5)
  })

  it('routes steady daily demand to Holt linear, not Croston', () => {
    const series = Array.from({ length: 365 }, () => 4) // demand every day
    const r = forecastDailyDemand(series, 90)
    expect(r.regime).toBe('HOLT_LINEAR')
    expect(r.points[0].value).toBeGreaterThan(3)
  })

  it('lumpy demand (high size variance + intermittent) uses SBA', () => {
    // Intermittent with wildly varying sizes → high CV².
    const series = Array.from({ length: 365 }, (_, i) =>
      i % 12 === 11 ? (i % 24 === 23 ? 50 : 1) : 0,
    )
    const r = forecastDailyDemand(series, 90)
    expect(r.regime).toBe('SBA')
  })

  it('run-rate floor prevents a decaying fit from zeroing a live SKU', () => {
    // Steady recent sales but engineered so a naive trend could decay:
    // demand only in the most-recent 60 days, zero before.
    const series = Array.from({ length: 365 }, (_, i) => (i >= 305 ? 3 : 0))
    const r = forecastDailyDemand(series, 90)
    // recent-90d run-rate ≈ (60*3)/90 = 2.0 → floor 1.0; far horizon must
    // not collapse below it.
    expect(r.points[89].value).toBeGreaterThanOrEqual(0.9)
  })

  it('a genuinely dead SKU (all zeros) forecasts zero — floor never resurrects', () => {
    const series = new Array(365).fill(0)
    const r = forecastDailyDemand(series, 90)
    expect(r.points[0].value).toBe(0)
    expect(r.points[89].value).toBe(0)
  })
})
