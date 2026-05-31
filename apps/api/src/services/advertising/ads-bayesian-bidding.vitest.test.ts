import { describe, it, expect } from 'vitest'
import { fitBetaPrior, shrunkConversionRate, dataConfidence, thompsonSampleCr, type Rng } from './ads-bayesian-bidding.service.js'

// Deterministic LCG so Thompson sampling is reproducible in tests.
function seededRng(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('fitBetaPrior', () => {
  it('poolMean is the pooled CR (Σorders/Σclicks)', () => {
    const p = fitBetaPrior([{ orders: 10, clicks: 100 }, { orders: 20, clicks: 100 }])
    expect(p.poolMean).toBeCloseTo(0.15, 5)
    expect(p.alpha / (p.alpha + p.beta)).toBeCloseTo(0.15, 5)
  })

  it('tightly-agreeing arms → strong prior; spread-out arms → weak prior', () => {
    const tight = fitBetaPrior(Array.from({ length: 10 }, () => ({ orders: 10, clicks: 100 })))
    const spread = fitBetaPrior([
      { orders: 0, clicks: 100 }, { orders: 30, clicks: 100 }, { orders: 2, clicks: 100 },
      { orders: 25, clicks: 100 }, { orders: 1, clicks: 100 }, { orders: 28, clicks: 100 },
    ])
    expect(tight.strength).toBeGreaterThan(spread.strength)
  })

  it('falls back to default strength with too little pool signal', () => {
    const p = fitBetaPrior([{ orders: 1, clicks: 10 }], { defaultStrength: 15 })
    expect(p.strength).toBe(15)
  })
})

describe('shrunkConversionRate', () => {
  const prior = fitBetaPrior(Array.from({ length: 20 }, () => ({ orders: 10, clicks: 100 })), { defaultStrength: 15 })
  // poolMean = 0.10, strength large (tight agreement).

  it('a sparse 0/3 keyword stays near the pool mean, not 0', () => {
    const cr = shrunkConversionRate(0, 3, prior)
    expect(cr).toBeGreaterThan(0.05)
    expect(cr).toBeLessThan(prior.poolMean + 0.01)
  })

  it('a high-data keyword trusts its own rate over the pool', () => {
    const heavy = shrunkConversionRate(60, 200, { alpha: 1, beta: 9, poolMean: 0.1, strength: 10 })
    // own rate 30%, pool 10%, lots of data → estimate well above pool
    expect(heavy).toBeGreaterThan(0.25)
  })

  it('never exceeds [0,1] and clamps orders ≤ clicks', () => {
    const cr = shrunkConversionRate(999, 5, prior)
    expect(cr).toBeGreaterThan(0)
    expect(cr).toBeLessThanOrEqual(1)
  })
})

describe('dataConfidence', () => {
  it('rises from ~0 (no data) toward 1 (lots of data)', () => {
    const prior = { alpha: 1.5, beta: 13.5, poolMean: 0.1, strength: 15 }
    expect(dataConfidence(0, prior)).toBe(0)
    expect(dataConfidence(15, prior)).toBeCloseTo(0.5, 5)
    expect(dataConfidence(285, prior)).toBeGreaterThan(0.94)
  })
})

describe('thompsonSampleCr', () => {
  const prior = { alpha: 2, beta: 18, poolMean: 0.1, strength: 20 }

  it('is deterministic for a fixed seed', () => {
    const a = thompsonSampleCr(5, 50, prior, seededRng(42))
    const b = thompsonSampleCr(5, 50, prior, seededRng(42))
    expect(a).toBe(b)
  })

  it('stays within (0,1)', () => {
    const rng = seededRng(7)
    for (let i = 0; i < 200; i++) {
      const s = thompsonSampleCr(3, 20, prior, rng)
      expect(s).toBeGreaterThan(0)
      expect(s).toBeLessThan(1)
    }
  })

  it('sample mean over many draws ≈ posterior mean', () => {
    const rng = seededRng(123)
    const orders = 8, clicks = 40
    const posteriorMean = (orders + prior.alpha) / (clicks + prior.alpha + prior.beta)
    let sum = 0
    const N = 4000
    for (let i = 0; i < N; i++) sum += thompsonSampleCr(orders, clicks, prior, rng)
    expect(sum / N).toBeCloseTo(posteriorMean, 1) // within ~0.05
  })

  it('a sparse arm has a wider sample spread than a data-rich arm (exploration)', () => {
    const rng = seededRng(99)
    const spread = (o: number, c: number) => {
      const xs = Array.from({ length: 1500 }, () => thompsonSampleCr(o, c, prior, rng))
      const m = xs.reduce((a, b) => a + b, 0) / xs.length
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length)
    }
    expect(spread(1, 4)).toBeGreaterThan(spread(50, 500))
  })
})
