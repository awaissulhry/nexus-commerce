/**
 * ACR.4.1 — the graduation verdict.
 *
 * The load-bearing property is the ORDER of the branches, not any single one of them. Every
 * case below is a branch that would return a confidently wrong answer if it were reached in a
 * different position — which is exactly what happened to `unseen` on the first cut, where a
 * rule that can never accumulate evidence reported itself "2 of the 3 weeks needed".
 *
 * Cased on the shapes prod actually holds (measured 2026-08-05), not on hypotheticals.
 */
import { describe, it, expect } from 'vitest'
import { decideVerdict, GRADUATION_WEEKS, type VerdictInput } from './ads-graduation-readiness.service.js'

const NOW = new Date('2026-08-05T12:00:00Z')
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

/** A rule with nothing remarkable about it: allowed to reach AUTO, no history. */
const base: VerdictInput = {
  ceilingIsAuto: true,
  ceilingReason: 'Adjusts values the engine can move back.',
  failures: 0,
  decisionWeeks: 0,
  cleanWeeks: 0,
  editedApplies: 0,
  appliedClean: 0,
  pending: 0,
  proposalsEver: 0,
  runs: 0,
  lastDecisionAt: null,
}
const v = (patch: Partial<VerdictInput>) => decideVerdict({ ...base, ...patch }, NOW)

describe('the ceiling outranks every amount of evidence', () => {
  it('a structural rule with a perfect record is still capped', () => {
    const r = v({
      ceilingIsAuto: false,
      ceilingReason: 'Creates negatives.',
      decisionWeeks: 12, cleanWeeks: 12, appliedClean: 40, runs: 500,
      proposalsEver: 40, lastDecisionAt: daysBefore(1),
    })
    expect(r.verdict).toBe('capped')
    // It must carry the CEILING's reason, not a graduation sentence — the operator is being
    // told why this can never happen, not how close it is.
    expect(r.summary).toBe('Creates negatives.')
  })
})

describe('ready — the strict bar', () => {
  it('three distinct weeks of unmodified applies, recent, no failures', () => {
    const r = v({ decisionWeeks: GRADUATION_WEEKS, appliedClean: 5, proposalsEver: 5, runs: 60, cleanWeeks: 4, lastDecisionAt: daysBefore(2) })
    expect(r.verdict).toBe('ready')
  })
  it('one week short is not ready', () => {
    expect(v({ decisionWeeks: GRADUATION_WEEKS - 1, appliedClean: 3, proposalsEver: 3, runs: 60, cleanWeeks: 4, lastDecisionAt: daysBefore(2) }).verdict)
      .not.toBe('ready')
  })

  /**
   * An edit is agreement with the INTENT and disagreement with the NUMBER, and the number is
   * what would run unattended. Recorded by the apply route as `appliedResult.override`.
   */
  it('an applied-with-an-edit proposal disqualifies, however many weeks', () => {
    const r = v({ decisionWeeks: 8, editedApplies: 1, appliedClean: 20, proposalsEver: 21, runs: 200, cleanWeeks: 8, lastDecisionAt: daysBefore(1) })
    expect(r.verdict).toBe('building')
    expect(r.summary).toContain('corrected the magnitude')
  })

  it('evidence goes stale — three clean weeks a month ago is not a description of today', () => {
    const r = v({ decisionWeeks: 5, appliedClean: 9, proposalsEver: 9, runs: 90, cleanWeeks: 5, lastDecisionAt: daysBefore(30) })
    expect(r.verdict).toBe('building')
    expect(r.summary).toContain('describes an account that has since moved')
  })

  it('a single failure inside the window outranks any decision history', () => {
    const r = v({ failures: 1, decisionWeeks: 9, appliedClean: 30, proposalsEver: 30, runs: 300, cleanWeeks: 9, lastDecisionAt: daysBefore(1) })
    expect(r.verdict).toBe('failing')
  })
})

describe('unseen is judged before the week thresholds', () => {
  /**
   * The real prod case: AIREON — Target ACoS bidding, 564 matches across 2 weeks, no failures,
   * zero proposals ever queued. Judged by weeks it read "2 of the 3 needed" — progress toward
   * something it can never reach, because it never puts a decision in front of anyone.
   */
  it('many matches, never a proposal', () => {
    const r = v({ runs: 564, cleanWeeks: 2, proposalsEver: 0 })
    expect(r.verdict).toBe('unseen')
    expect(r.summary).toContain('not one queued proposal')
  })

  it('still unseen once it has ENOUGH weeks — more running cannot fix it', () => {
    expect(v({ runs: 900, cleanWeeks: GRADUATION_WEEKS + 2, proposalsEver: 0 }).verdict).toBe('unseen')
  })

  it('but a failure still outranks it — broken beats uninformative', () => {
    expect(v({ runs: 900, cleanWeeks: 4, proposalsEver: 0, failures: 3 }).verdict).toBe('failing')
  })

  it('a rule that has barely run is early days, not unseen', () => {
    expect(v({ runs: 5, cleanWeeks: 1, proposalsEver: 0 }).verdict).toBe('building')
  })

  it('one queued proposal is enough to leave unseen — you have seen what it does', () => {
    expect(v({ runs: 564, cleanWeeks: 2, proposalsEver: 1, pending: 1 }).verdict).not.toBe('unseen')
  })
})

describe('unreviewed — it works, you have not said whether you agree', () => {
  it('clean weeks with proposals waiting points at the queue', () => {
    const r = v({ runs: 700, cleanWeeks: GRADUATION_WEEKS, proposalsEver: 51, pending: 51 })
    expect(r.verdict).toBe('unreviewed')
    expect(r.summary).toContain('51 proposals waiting on you')
  })
  it('clean weeks, decided history too thin, nothing waiting', () => {
    expect(v({ runs: 700, cleanWeeks: GRADUATION_WEEKS + 1, proposalsEver: 2, pending: 0 }).verdict).toBe('unreviewed')
  })
})

describe('building — the honest default', () => {
  it('never run is stated as such, not as zero progress', () => {
    const r = v({})
    expect(r.verdict).toBe('building')
    expect(r.summary).toBe('Has not run inside the window. There is nothing to judge it on yet.')
  })

  /** The prod shape for Low CTR bid reduction: 1 clean week, 51 pending, nothing decided. */
  it('points the operator at the queue, because deciding it is what builds the rest', () => {
    const r = v({ runs: 699, cleanWeeks: 1, proposalsEver: 51, pending: 51 })
    expect(r.verdict).toBe('building')
    expect(r.summary).toContain(`1 of the ${GRADUATION_WEEKS} weeks needed`)
    expect(r.summary).toContain('51 are waiting on you')
  })

  it('singular reads correctly with one pending', () => {
    expect(v({ runs: 30, cleanWeeks: 1, proposalsEver: 1, pending: 1 }).summary).toContain('1 is waiting on you')
  })
})

describe('nothing but `ready` can be mistaken for permission', () => {
  it('every non-ready verdict is one of the known non-graduating states', () => {
    const cases: Partial<VerdictInput>[] = [
      { ceilingIsAuto: false },
      { failures: 2 },
      { runs: 600, proposalsEver: 0 },
      { runs: 600, cleanWeeks: 4, proposalsEver: 9, pending: 9 },
      { decisionWeeks: 9, editedApplies: 2, lastDecisionAt: daysBefore(1) },
      {},
    ]
    for (const c of cases) {
      expect(v(c).verdict).not.toBe('ready')
    }
  })
})
