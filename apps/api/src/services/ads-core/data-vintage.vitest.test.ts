/**
 * AX-ZD.5 — data vintage.
 *
 * The boundaries are the product decision here, so they get pinned. The one that
 * matters most is `ruleSafe`: everything inside Amazon's 14-day attribution
 * window must be refused as a rule input, because acting on a number that grows
 * 36% underneath you is how a bid engine chases its own tail.
 */
import { describe, it, expect } from 'vitest'
import { vintageOf, isRuleSafe, attributionWindowDays, describeWindow, vintageBadge, VINTAGE_STATES, ruleWindowBounds } from '@nexus/shared/data-vintage'

const NOW = new Date('2026-07-28T12:00:00Z')
const dAgo = (n: number) => new Date(Date.UTC(2026, 6, 28 - n))

describe('settlement boundaries', () => {
  it('walks provisional → stabilising → settling → settled → final', () => {
    expect(vintageOf(dAgo(0), NOW).state).toBe('provisional')
    expect(vintageOf(dAgo(1), NOW).state).toBe('provisional')
    expect(vintageOf(dAgo(2), NOW).state).toBe('stabilising')
    expect(vintageOf(dAgo(3), NOW).state).toBe('stabilising')
    expect(vintageOf(dAgo(4), NOW).state).toBe('settling')
    expect(vintageOf(dAgo(14), NOW).state).toBe('settling')
    expect(vintageOf(dAgo(15), NOW).state).toBe('settled')
    expect(vintageOf(dAgo(59), NOW).state).toBe('settled')
    expect(vintageOf(dAgo(60), NOW).state).toBe('final')
    expect(vintageOf(dAgo(400), NOW).state).toBe('final')
  })

  it('reports age in whole UTC days, not hours', () => {
    // 12:00 "now" vs a midnight-dated row must not round to a different day.
    expect(vintageOf(new Date('2026-07-28T00:00:00Z'), NOW).ageDays).toBe(0)
    expect(vintageOf(new Date('2026-07-27T23:59:59Z'), NOW).ageDays).toBe(1)
  })

  it('treats a future date as provisional rather than throwing', () => {
    // Clock skew, or a report dated ahead. The caller wants a label, not an error.
    const v = vintageOf(new Date('2026-08-05T00:00:00Z'), NOW)
    expect(v.state).toBe('provisional')
    expect(v.ageDays).toBe(0)
  })
})

describe('the rule guard', () => {
  it('REFUSES everything inside the attribution window', () => {
    // This is the whole point. A conversion on day 14 rewrites day 0's ACOS, so
    // anything younger than that cannot drive a bid.
    for (const age of [0, 1, 2, 3, 4, 7, 13, 14]) {
      expect(isRuleSafe(dAgo(age), NOW), `${age}d`).toBe(false)
    }
  })

  it('allows settled and final data', () => {
    for (const age of [15, 30, 59, 60, 120]) {
      expect(isRuleSafe(dAgo(age), NOW), `${age}d`).toBe(true)
    }
  })

  it('flags conversions as still settling for exactly the unsafe range', () => {
    expect(vintageOf(dAgo(14), NOW).conversionsSettling).toBe(true)
    expect(vintageOf(dAgo(15), NOW).conversionsSettling).toBe(false)
  })

  it('every state carries an explanation an operator can read', () => {
    for (const age of [0, 2, 5, 20, 90]) {
      expect(vintageOf(dAgo(age), NOW).note.length).toBeGreaterThan(30)
    }
  })
})

describe('attribution windows', () => {
  it('is 7 days for Sponsored Products (we are a seller, not a vendor)', () => {
    expect(attributionWindowDays('SPONSORED_PRODUCTS')).toBe(7)
    expect(attributionWindowDays(null)).toBe(7)
  })

  it('is 14 days for Sponsored Brands and Sponsored Display', () => {
    expect(attributionWindowDays('SPONSORED_BRANDS')).toBe(14)
    expect(attributionWindowDays('SPONSORED_DISPLAY')).toBe(14)
  })
})

describe('describing a window', () => {
  it('is only as trustworthy as its least-settled day', () => {
    // A "last 30 days" window contains today. Reporting it as settled would be
    // the exact lie this module exists to prevent.
    const w = describeWindow(dAgo(29), dAgo(0), NOW)
    expect(w.days).toBe(30)
    expect(w.worst).toBe('provisional')
    expect(w.ruleSafe).toBe(false)
    expect(w.breakdown.provisional).toBe(2)   // D-0, D-1
    expect(w.breakdown.stabilising).toBe(2)   // D-2, D-3
    expect(w.breakdown.settling).toBe(11)     // D-4..D-14
    expect(w.breakdown.settled).toBe(15)      // D-15..D-29
  })

  it('calls a fully-settled window safe', () => {
    const w = describeWindow(dAgo(60), dAgo(20), NOW)
    expect(w.ruleSafe).toBe(true)
    expect(w.summary).toContain('safe to optimise')
  })

  it('says plainly that a moving window will not match a later copy', () => {
    // The recurring complaint across every competitor is "the numbers changed".
    const w = describeWindow(dAgo(7), dAgo(0), NOW)
    expect(w.summary).toContain('still moving')
    expect(w.summary).toContain('60 days')
  })

  it('handles a single day and an inverted range without looping', () => {
    expect(describeWindow(dAgo(3), dAgo(3), NOW).days).toBe(1)
    expect(describeWindow(dAgo(0), dAgo(5), NOW).days).toBe(0)
  })
})

describe('badge', () => {
  it('reads as state plus age', () => {
    expect(vintageBadge(dAgo(0), NOW)).toBe('provisional · 0d old')
    expect(vintageBadge(dAgo(21), NOW)).toBe('settled · 21d old')
  })

  it('orders states least to most trustworthy', () => {
    expect(VINTAGE_STATES).toEqual(['provisional', 'stabilising', 'settling', 'settled', 'final'])
  })
})

// ── AX-ZD.5 enforcement (Phase 2) ──────────────────────────────────────────
// Before this, `isRuleSafe` had ZERO call sites outside its own test, and the
// Amazon rule evaluator used a bare `date >= now - N` with no upper bound — so
// every rule read D-0 and D-1 (provisional) on every run.
describe('ruleWindowBounds — the teeth', () => {
  const now = new Date('2026-07-28T12:00:00Z')

  it('excludes the provisional tail (today and yesterday)', () => {
    const w = ruleWindowBounds(14, now)
    // Newest day considered is D-2, not D-0.
    expect(w.until.toISOString().slice(0, 10)).toBe('2026-07-26')
    expect(vintageOf(w.until, now).state).not.toBe('provisional')
  })

  it('keeps the requested number of days, shifted back', () => {
    const w = ruleWindowBounds(7, now)
    expect(w.since.toISOString().slice(0, 10)).toBe('2026-07-20')
    expect(w.until.toISOString().slice(0, 10)).toBe('2026-07-26')
    expect(w.vintage.days).toBe(7)
  })

  it('no day inside the window is provisional', () => {
    for (const days of [1, 7, 14, 30, 90]) {
      const w = ruleWindowBounds(days, now)
      expect(w.vintage.breakdown.provisional, `${days}d window leaked a provisional day`).toBe(0)
    }
  })

  it('reports the window’s settledness instead of hiding it', () => {
    const w = ruleWindowBounds(14, now)
    // A 14-day window is legitimately still settling — the point is to SAY so,
    // not to refuse to act on it.
    expect(w.vintage.worst).toBe('stabilising')
    expect(w.vintage.summary).toMatch(/still moving/)
  })

  it('a degenerate window still excludes provisional days', () => {
    const w = ruleWindowBounds(0, now)
    expect(w.vintage.breakdown.provisional).toBe(0)
    expect(w.vintage.days).toBeGreaterThan(0)
  })

  it('does NOT gate on isRuleSafe — that would disable every rule', () => {
    // ruleSafe is only true from ageDays >= 15. The evaluator's windows are 7,
    // 14 and 30 days, so gating on it would mean no rule could ever fire. This
    // asserts the deliberate choice rather than leaving it to a comment.
    const w = ruleWindowBounds(14, now)
    expect(w.vintage.ruleSafe).toBe(false)   // the window is not fully settled…
    expect(w.vintage.breakdown.provisional).toBe(0) // …but it is not provisional either
    expect(isRuleSafe(w.until, now)).toBe(false)
  })
})

describe('AX-ZD.5 ratchet — the evaluator must not read provisional data', () => {
  it('no rule window in the evaluator uses an unbounded date filter', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'jobs', 'advertising-rule-evaluator.job.ts')
    const src = readFileSync(p, 'utf8')
    // `date: { gte: since }` with no `lte` is the shape that read D-0/D-1.
    const unbounded = src.split('\n')
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /date:\s*\{\s*gte:\s*since\s*\}/.test(l))
    expect(unbounded.map((u) => u.i), 'add `lte: until` — these read provisional data').toEqual([])
    expect(src).toMatch(/ruleWindowBounds\(/)
  })
})

describe('AX-ZD.5 — the summary an operator actually reads', () => {
  const now = new Date('2026-07-28T12:00:00Z')
  const daysAgo = (n: number): Date => {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - n); return d
  }

  it('a one-day window does not list the states it does not have', () => {
    // "1 of 1 day are still moving (1 provisional, 0 stabilising, 0 settling)"
    // is noise, and noise is what makes an operator stop reading the warning
    // that matters.
    const s = describeWindow(now, now, now).summary
    expect(s).toBe('This day is still provisional and will change. Amazon restates for up to 60 days, so this window will not match a copy taken later.')
    expect(s).not.toMatch(/0 stabilising|0 settling|1 of 1/)
  })

  it('a fully-unsettled window says "all", not "N of N"', () => {
    const s = describeWindow(daysAgo(6), now, now).summary
    expect(s).toMatch(/^All 7 days are still moving \(2 provisional, 2 stabilising, 3 settling\)\./)
  })

  it('a partly-settled window keeps the ratio, and omits absent states', () => {
    const s = describeWindow(daysAgo(29), now, now).summary
    expect(s).toMatch(/^15 of 30 days are still moving \(2 provisional, 2 stabilising, 11 settling\)\./)
  })

  it('a fully-settled window says so plainly and never mentions restatement', () => {
    const s = describeWindow(daysAgo(40), daysAgo(20), now).summary
    expect(s).toMatch(/settled — safe to optimise against/)
    expect(s).not.toMatch(/still moving|restates/)
  })
})
