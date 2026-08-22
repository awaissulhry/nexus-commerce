/**
 * PLC-P4 — `placement_apply`: the merge it uses, and what it says when it is refused.
 *
 * Two defects this pins, both measured on the shipped handler:
 *
 *   ① It rebuilt the wholesale placement payload INLINE instead of calling
 *      `buildManualAdjustments`. `updatePlacementBidding` writes `placementBidding` wholesale, so a
 *      one-lane payload erases the other two — 88 of 88 two-lane campaigns would have lost one —
 *      and a second implementation of that one rule is the kind of duplication whose failure is
 *      silent and account-wide.
 *   ② A gate-blocked write returns `{ ok:false, mode:'blocked', reason, deniedAt }` (PLC.3 added
 *      those two fields for exactly this) and the handler DISCARDED both, returning a bare
 *      `ok:false` with no `error`. The suggestion stayed pending — correct — and the operator was
 *      shown "refused" with nothing after it.
 *
 * 🔴 `buildManualAdjustments` is deliberately NOT mocked: it is the thing under test on the merge
 * side. Only the database and the write call are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ findUnique: vi.fn(), updatePlacementBidding: vi.fn() }))

vi.mock('../../db.js', () => ({ default: { campaign: { findUnique: h.findUnique } } }))
vi.mock('./ads-create.service.js', () => ({ updatePlacementBidding: h.updatePlacementBidding }))

import { ACTION_HANDLERS } from '../automation-rule.service.js'
import './automation-action-handlers.js'

const TOP = 'PLACEMENT_TOP'
const REST = 'PLACEMENT_REST_OF_SEARCH'
const PDP = 'PLACEMENT_PRODUCT_PAGE'

const run = (action: Record<string, unknown>, dryRun = false) =>
  (ACTION_HANDLERS.placement_apply as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; error?: string; output?: Record<string, unknown> }>)(
    { campaignId: 'c1', ...action }, {}, { dryRun, ruleId: 'rule-1' },
  )

const profile = (lanes: Array<{ placement: string; percentage: number }>) => {
  h.findUnique.mockResolvedValue({ dynamicBidding: { placementBidding: lanes } })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.updatePlacementBidding.mockResolvedValue({ ok: true, mode: 'live', adjustments: [] })
})

describe('the merge — a one-lane rule must not erase the other lanes', () => {
  it('🔴 keeps BOTH untouched lanes when it changes the third', async () => {
    profile([{ placement: TOP, percentage: 30 }, { placement: REST, percentage: 45 }, { placement: PDP, percentage: 10 }])
    await run({ placement: TOP, op: 'set', value: 50 })
    const sent = h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ placement: string; percentage: number }>
    expect(Object.fromEntries(sent.map((a) => [a.placement, a.percentage]))).toEqual({
      [TOP]: 50, [REST]: 45, [PDP]: 10,
    })
  })

  it('preserves a NON-MANAGED placement Amazon may add later, untouched', async () => {
    profile([{ placement: TOP, percentage: 30 }, { placement: 'PLACEMENT_AMAZON_BUSINESS', percentage: 12 }])
    await run({ placement: TOP, op: 'set', value: 50 })
    const sent = h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ placement: string; percentage: number }>
    expect(sent).toContainEqual({ placement: 'PLACEMENT_AMAZON_BUSINESS', percentage: 12 })
  })

  it('does not emit an untouched lane that is already 0 — absent and 0 are one instruction', async () => {
    profile([{ placement: TOP, percentage: 0 }, { placement: REST, percentage: 45 }])
    await run({ placement: REST, op: 'set', value: 60 })
    const sent = h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ placement: string; percentage: number }>
    expect(sent.some((a) => a.placement === TOP)).toBe(false)
    expect(sent).toContainEqual({ placement: REST, percentage: 60 })
  })

  it('clamps to the rule’s own guardrails, and never past Amazon’s 0–900', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    await run({ placement: TOP, op: 'set', value: 5000, minPct: 0, maxPct: 900 })
    expect((h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ percentage: number }>)[0].percentage).toBe(900)
    h.updatePlacementBidding.mockClear()
    profile([{ placement: TOP, percentage: 300 }])
    await run({ placement: TOP, op: 'set', value: 10, minPct: 100, maxPct: 900 })
    expect((h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ percentage: number }>)[0].percentage).toBe(100)
  })

  it('🔴 REFUSES a lane this system does not manage instead of writing a payload without it', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    const r = await run({ placement: 'PLACEMENT_SOMETHING_NEW', op: 'set', value: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not a placement this system manages/)
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })
})

describe('a refusal carries the gate’s own sentence', () => {
  it('🔴 passes `reason` through as the error, verbatim', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    h.updatePlacementBidding.mockResolvedValue({
      ok: false, mode: 'blocked', adjustments: [],
      reason: 'live bid writes are disabled for this campaign', deniedAt: 'campaign_allowlist',
    })
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('live bid writes are disabled for this campaign')
    expect(r.output?.deniedAt).toBe('campaign_allowlist')
    expect(r.output?.mode).toBe('blocked')
  })

  it('names a gate that gave no sentence, rather than reporting an empty refusal', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    h.updatePlacementBidding.mockResolvedValue({ ok: false, mode: 'blocked', adjustments: [], deniedAt: 'authority_pin' })
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('authority_pin')
  })

  it('a successful write reports ok with no error', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.output?.percentage).toBe(50)
  })
})

describe('PLC-P4 changed nothing about dryRun or no-change (that is a separate unit)', () => {
  it('dryRun still returns wouldChange and writes nothing', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 }, true)
    expect(r.ok).toBe(true)
    expect(r.output?.wouldChange).toBe('30% → 50%')
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('an unchanged value still short-circuits as noChange, before any merge', async () => {
    profile([{ placement: TOP, percentage: 50 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(true)
    expect(r.output?.noChange).toBe(true)
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  /**
   * 🔴 The ordering PLC-P4 must NOT change (operator decision D-PLC-3): the dryRun return sits
   * BEFORE the noChange check, so a rule proposing no change still emits `wouldChange: "50% → 50%"`
   * and reaches the suggestion queue. That is a real defect, shared with `budget_apply`, and it is
   * its own cross-cutting unit — this test pins the CURRENT behaviour so P4 cannot silently fix
   * half of it here and leave Budget behind.
   */
  it('records that a dryRun no-op still reports wouldChange — deliberately unfixed here', async () => {
    profile([{ placement: TOP, percentage: 50 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 }, true)
    expect(r.output?.wouldChange).toBe('50% → 50%')
    expect(r.output?.noChange).toBeUndefined()
  })
})
