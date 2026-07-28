/** Threshold-gated halt — the precondition for applying a file nobody read. */
import { describe, it, expect } from 'vitest'
import {
  evaluateBlastRadius, blastInputFromPreview, UNATTENDED_THRESHOLDS, type BlastInput, INTERACTIVE_THRESHOLDS } from './blast-radius-guard.js'

const small = (over: Partial<BlastInput> = {}): BlastInput => ({
  changedRows: 10, totalRows: 100, archives: 0, pauses: 0,
  bidChanges: 10, largeBidChanges: 0, budgetDeltaEur: 5, campaignsTouched: 3, conflicts: 0,
  ...over,
})

describe('a normal run proceeds', () => {
  it('passes and says what it did', () => {
    const v = evaluateBlastRadius(small())
    expect(v.proceed).toBe(true)
    expect(v.breaches).toEqual([])
    expect(v.summary).toMatch(/Within limits/)
  })
})

describe('absolute AND proportional — neither scale left unguarded', () => {
  it('trips on proportion even when the absolute count is tiny', () => {
    // 9 of 10 rows on a small account: absolutely small, proportionally alarming.
    const v = evaluateBlastRadius(small({ changedRows: 9, totalRows: 10 }))
    expect(v.proceed).toBe(false)
    expect(v.breaches.map((b) => b.metric)).toContain('changedPct')
  })
  it('trips on absolute count even when the proportion is small', () => {
    // 600 of 100,000 rows: 0.6%, but 600 unattended writes.
    const v = evaluateBlastRadius(small({ changedRows: 600, totalRows: 100_000 }))
    expect(v.proceed).toBe(false)
    expect(v.breaches.map((b) => b.metric)).toContain('changedRows')
  })
})

describe('archives are weighted hardest — they are irreversible', () => {
  it('a modest archive count halts the run', () => {
    const v = evaluateBlastRadius(small({ archives: 26 }))
    expect(v.proceed).toBe(false)
    expect(v.breaches.find((b) => b.metric === 'archives')!.message).toMatch(/no unarchive/)
  })
  it('the archive limit is tighter than the pause limit', () => {
    // Pausing is reversible; archiving is not. The thresholds must reflect that.
    expect(UNATTENDED_THRESHOLDS.maxArchives).toBeLessThan(UNATTENDED_THRESHOLDS.maxPauses)
  })
})

describe('the shapes that indicate a broken file', () => {
  it('many large bid moves reads as a decimal-separator error', () => {
    const v = evaluateBlastRadius(small({ largeBidChanges: 51 }))
    expect(v.proceed).toBe(false)
    expect(v.breaches.find((b) => b.metric === 'largeBidChanges')!.message).toMatch(/decimal-separator/)
  })
  it('budget delta is guarded in BOTH directions', () => {
    expect(evaluateBlastRadius(small({ budgetDeltaEur: 250 })).proceed).toBe(false)
    // A large CUT is just as much a mistake as a large raise.
    expect(evaluateBlastRadius(small({ budgetDeltaEur: -250 })).proceed).toBe(false)
  })
  it('ANY conflict halts an unattended run', () => {
    // A conflict means the file disagrees with live Amazon state and nobody is
    // there to adjudicate.
    expect(UNATTENDED_THRESHOLDS.maxConflicts).toBe(0)
    expect(evaluateBlastRadius(small({ conflicts: 1 })).proceed).toBe(false)
  })
})

describe('reporting', () => {
  it('lists EVERY breach, not just the first', () => {
    const v = evaluateBlastRadius(small({ archives: 99, conflicts: 5, budgetDeltaEur: 900, changedRows: 9, totalRows: 10 }))
    expect(v.breaches.length).toBeGreaterThanOrEqual(4)
    expect(v.summary).toMatch(/HALTED/)
  })
  it('every breach carries the value, the limit and a reason', () => {
    for (const b of evaluateBlastRadius(small({ archives: 99, conflicts: 5 })).breaches) {
      expect(b.value).toBeGreaterThan(b.limit)
      expect(b.message.length).toBeGreaterThan(20)
    }
  })
  it('an interactive caller can pass looser thresholds', () => {
    const big = small({ archives: 99 })
    expect(evaluateBlastRadius(big).proceed).toBe(false)
    expect(evaluateBlastRadius(big, { ...UNATTENDED_THRESHOLDS, maxArchives: 500 }).proceed).toBe(true)
  })
})

describe('blastInputFromPreview', () => {
  it('maps a preview result onto the guard input', () => {
    const input = blastInputFromPreview({
      counts: { total: 50, create: 2, update: 8, archive: 1, conflict: 3 },
      blastRadius: { archives: 1, pauses: 4, bidChanges: 8, largeBidChanges: 2, dailyBudget: { deltaEur: 12.5, campaigns: 6 } },
    })
    expect(input.changedRows).toBe(11) // create + update + archive
    expect(input.totalRows).toBe(50)
    expect(input.conflicts).toBe(3)
    expect(input.budgetDeltaEur).toBe(12.5)
  })
  it('unchanged rows are not counted as changes', () => {
    const input = blastInputFromPreview({
      counts: { total: 1000, create: 0, update: 0, archive: 0, conflict: 0 },
      blastRadius: { archives: 0, pauses: 0, bidChanges: 0, largeBidChanges: 0, dailyBudget: { deltaEur: 0, campaigns: 0 } },
    })
    expect(input.changedRows).toBe(0)
    expect(evaluateBlastRadius(input).proceed).toBe(true)
  })
})

describe('AX-ZD.6 — interactive vs unattended are different questions', () => {
  const base: BlastInput = {
    changedRows: 0, totalRows: 100, archives: 0, pauses: 0, bidChanges: 0,
    largeBidChanges: 0, budgetDeltaEur: 0, campaignsTouched: 0, conflicts: 0,
  }

  it('a normal human edit passes interactively but trips unattended', () => {
    // 60 rows of a 100-row file, one archive: an ordinary afternoon for an
    // operator, and something nobody should wake up to having happened.
    const run = { ...base, changedRows: 60, archives: 1, pauses: 5 }
    expect(evaluateBlastRadius(run, INTERACTIVE_THRESHOLDS).proceed).toBe(true)
    expect(evaluateBlastRadius(run, UNATTENDED_THRESHOLDS).proceed).toBe(false)
  })

  it('a conflict stops an unattended run and never blocks a human', () => {
    // The apply route makes the operator choose conflicts: 'mine' | 'skip', so
    // interactively a conflict is a decision already taken. Unattended there is
    // nobody to take it.
    const run = { ...base, changedRows: 1, conflicts: 1 }
    expect(evaluateBlastRadius(run, INTERACTIVE_THRESHOLDS).proceed).toBe(true)
    expect(evaluateBlastRadius(run, UNATTENDED_THRESHOLDS).proceed).toBe(false)
  })

  it('a catastrophe is refused even with a human present', () => {
    // The whole point of gating the interactive path too: a truncated export or
    // a formula dragged down a column, which the preview counts will not make
    // obvious at a glance.
    const run = { ...base, changedRows: 400, totalRows: 400, archives: 400 }
    const v = evaluateBlastRadius(run, INTERACTIVE_THRESHOLDS)
    expect(v.proceed).toBe(false)
    expect(v.breaches.map((b) => b.metric)).toContain('archives')
  })

  it('interactive is looser than unattended on every shared limit', () => {
    // A guard that was accidentally TIGHTER interactively would block ordinary
    // work while letting schedules through — the exact inversion of the intent.
    const keys = ['maxChangedRows', 'maxChangedPct', 'maxArchives', 'maxPauses',
      'maxLargeBidChanges', 'maxBudgetDeltaEur', 'maxConflicts'] as const
    for (const k of keys) {
      expect(INTERACTIVE_THRESHOLDS[k], k).toBeGreaterThanOrEqual(UNATTENDED_THRESHOLDS[k])
    }
  })
})
