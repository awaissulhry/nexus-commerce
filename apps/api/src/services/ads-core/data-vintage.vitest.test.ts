/**
 * AX-ZD.5 — data vintage.
 *
 * The boundaries are the product decision here, so they get pinned. The one that
 * matters most is `ruleSafe`: everything inside Amazon's 14-day attribution
 * window must be refused as a rule input, because acting on a number that grows
 * 36% underneath you is how a bid engine chases its own tail.
 */
import { describe, it, expect } from 'vitest'
import {
  vintageOf, isRuleSafe, attributionWindowDays, describeWindow, vintageBadge,
  VINTAGE_STATES,
} from './data-vintage.js'

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
