/**
 * KT.7 — the sentence after money moves, and the null-branch discipline the health queries need.
 *
 * `applyProposal` itself is I/O against a live account, so it is exercised for real on prod by
 * `_kt7-gate.mts` rather than mocked here — this programme has already had a mocked shape-assertion
 * test pin a bug in place. What IS tested here is everything pure: the post-write sentence, and the
 * `NOT`-excludes-NULL complement that six separate defects in this programme have come from.
 */
import { describe, it, expect } from 'vitest'
import { applySummary, KT7_UNDO_WINDOW_HOURS } from './kt7-apply.service.js'

const base = {
  term: 'giacca moto', marketplace: 'IT', bidCents: 55,
  applied: 30, refused: 0, skipped: 0, capped: false, cappedTo: 30,
  radiusExcluded: {} as Record<string, number>,
  suppressedCampaigns: 0, shareAgeDays: 18, shareWeekLabel: '19 Jul',
  ceilingMessage: '', ceilingVerdict: 'NO_CEILING',
}

describe('applySummary — past tense, and every number named', () => {
  it('says what it DID, and can be told apart from the pre-write confirmation', () => {
    const s = applySummary(base)
    expect(s).toContain('Set the bid to €0.55 on 30 targets')
    // The pre-write sentence begins "Propose setting…" / "Set the bid to…" in the FUTURE sense and
    // carries "Nothing changes until the proposal is approved". An operator who cannot tell the two
    // apart cannot tell whether they have already spent the money.
    expect(s).not.toContain('Nothing changes until')
    expect(s).not.toContain('Propose')
    expect(s).toContain(`undone together in one action for the next ${KT7_UNDO_WINDOW_HOURS} hours`)
  })

  it('agrees in number for a single target', () => {
    const s = applySummary({ ...base, applied: 1, cappedTo: 1 })
    expect(s).toContain('on 1 target for')
    expect(s).not.toContain('1 targets')
    expect(s).toContain('This change can be undone in one action')
    expect(s).not.toContain('All 1 change')
  })

  it('names the §6 cap as deliberate rather than as a limitation', () => {
    const s = applySummary({ ...base, applied: 1, capped: true, cappedTo: 1, skipped: 29 })
    expect(s).toContain('deliberately limited to 1 target')
    expect(s).toContain('smallest reversible change')
  })

  it('reports a fully-refused apply as "nothing was changed", not as a success', () => {
    const s = applySummary({ ...base, applied: 0, refused: 30 })
    expect(s.startsWith('Nothing was changed')).toBe(true)
    expect(s).not.toContain('Set the bid')
    // and it must NOT promise an undo for something that never happened
    expect(s).not.toContain('can be undone')
  })

  it('names a suppressed campaign as the reason its targets were skipped', () => {
    const s = applySummary({ ...base, applied: 2, refused: 1, suppressedCampaigns: 1 })
    expect(s).toContain('currently bid-suppressed')
    expect(s).toContain('overwrite anything written now')
  })

  it('separates the allowlist from the suppression, because they have different fixes', () => {
    const s = applySummary({ ...base, applied: 30, skipped: 70, radiusExcluded: { not_write_enabled: 58, suppressed_flag: 9, suppressed_by_bid: 3 } })
    expect(s).toContain('58 targets in campaigns that are not write-enabled')
    expect(s).toContain("default-deny allowlist, not a failure here")
    expect(s).toContain('12 suppressed targets')
    expect(s).not.toMatch(/70 (targets|excluded)/) // never a single undifferentiated total
  })

  it('names the week rather than a bare age, so it cannot contradict the drawer header', () => {
    // KT.6 shipped "ended 18 days ago" next to a header saying "(24d old)" — same week, two numbers.
    const s = applySummary(base)
    expect(s).toContain('the Brand Analytics week of 19 Jul, which ended 18 days ago')
  })

  it('omits the ceiling sentence when there is no ceiling, rather than saying "unlimited"', () => {
    const s = applySummary(base)
    expect(s.toLowerCase()).not.toContain('unlimited')
    const withCeiling = applySummary({ ...base, ceilingVerdict: 'ALLOWED', ceilingMessage: 'Within the €40.00/day ceiling for the IT market.' })
    expect(withCeiling).toContain('Within the €40.00/day ceiling')
  })
})

/**
 * 🔴 The complement that has produced six defects in this programme, most recently
 * `maxExecutionsPerDay` counting literally zero forever. Prisma's `NOT: { f: v }` compiles to
 * `NOT (f = v)`, which is NULL — not TRUE — for a null column, so those rows are DROPPED.
 *
 * These assert the SHAPE of the predicate a health query must use, so a future edit that reintroduces
 * the bare `NOT` fails here instead of silently reporting a healthy feed.
 */
describe('the null-safe "not this value" predicate', () => {
  /** What a health query must build to mean "errorMessage is not X, including when it is null". */
  const notValueIncludingNull = (field: string, value: string) => ({
    OR: [{ [field]: null }, { [field]: { not: value } }],
  })

  it('includes the null branch explicitly', () => {
    const w = notValueIncludingNull('errorMessage', 'DAILY_CAP_EXCEEDED')
    expect(w.OR).toHaveLength(2)
    expect(w.OR[0]).toEqual({ errorMessage: null })
    expect(w.OR[1]).toEqual({ errorMessage: { not: 'DAILY_CAP_EXCEEDED' } })
  })

  it('is not the bare NOT form, which measured 0 rows against 214,090 real ones', () => {
    const w = notValueIncludingNull('errorMessage', 'DAILY_CAP_EXCEEDED') as Record<string, unknown>
    expect(w.NOT).toBeUndefined()
    expect(JSON.stringify(w)).toContain('null')
  })

  it('excludes DAILY_CAP_EXCEEDED from a success rate, since a refusal is not a failure', () => {
    // 907,793 executions in 60 days, 693,704 of them DAILY_CAP_EXCEEDED. Counting refusals as
    // failures would report a 23% success rate for engines that mostly worked.
    const total = 907_793, capped = 693_704, succeeded = 214_090
    const naive = succeeded / total
    const honest = succeeded / (total - capped)
    expect(Math.round(naive * 100)).toBe(24)
    expect(Math.round(honest * 100)).toBe(100)
    expect(honest).toBeGreaterThan(naive)
  })
})
