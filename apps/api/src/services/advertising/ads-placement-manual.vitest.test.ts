import { describe, it, expect } from 'vitest'
import { buildManualAdjustments, currentLanes, isNoOp, servingBaseBidByCampaign } from './ads-placement-manual.js'
import { cpcCapPct } from './rank-controller.js'

/**
 * PLC.3 — these tests exist because of one line in the write path.
 *
 * `ads-create.service.ts:972` writes `placementBidding: adjustments` WHOLESALE. A one-lane request
 * therefore leaves the other two absent, and absent is 0 to Amazon. Every assertion below is a
 * guard against a future caller re-introducing the mass-erase behind a one-lane edit.
 */
const pmap = (arr: Array<{ placement: string; percentage: number }>) =>
  Object.fromEntries(arr.map((x) => [x.placement, x.percentage]))

const TOP = 'PLACEMENT_TOP'
const REST = 'PLACEMENT_REST_OF_SEARCH'
const PROD = 'PLACEMENT_PRODUCT_PAGE'

describe('buildManualAdjustments — one lane in, THREE lanes out', () => {
  it('🔴 preserves the two lanes it was not asked to change', () => {
    const out = buildManualAdjustments(
      [{ placement: TOP, percentage: 150 }, { placement: REST, percentage: 45 }, { placement: PROD, percentage: 30 }],
      TOP, 60,
    )
    expect(pmap(out)).toEqual({ [TOP]: 60, [REST]: 45, [PROD]: 30 })
  })

  it('preserves them on a REAL prod profile shape (all 88 two-lane campaigns behave like this)', () => {
    // MISANO JACKET BLACK PHRASE, as stored: the naive payload would have zeroed product=6.
    const out = buildManualAdjustments(
      [{ placement: TOP, percentage: 28 }, { placement: PROD, percentage: 6 }],
      TOP, 60,
    )
    expect(pmap(out)).toEqual({ [TOP]: 60, [PROD]: 6 })
  })

  it('🔴 the naive one-lane payload would have erased them — this is the regression', () => {
    const existing = [{ placement: TOP, percentage: 150 }, { placement: REST, percentage: 45 }]
    // What a caller writing the obvious thing would send:
    const naive = [{ placement: REST, percentage: 60 }]
    expect(pmap(naive)[TOP]).toBeUndefined()          // Top vanishes → Amazon reads 0
    // What this function sends instead — Top survives; Product stays absent because it was absent.
    expect(pmap(buildManualAdjustments(existing, REST, 60))).toEqual({ [TOP]: 150, [REST]: 60 })
  })

  /**
   * 🔴 Found by the first real write on production, not here.
   *
   * The merge used to emit all three lanes always, so a first edit on a bare campaign wrote THREE
   * ledger rows — the change, plus `top absent→0` and `rest absent→0`, because
   * `updatePlacementBidding` reads `undefined !== 0` as a change. Absent and 0 are the same
   * instruction to Amazon, so a lane at 0 need not be sent; a lane with a VALUE must be, or the
   * wholesale write drops it. Same rule as `buildBlendedAdjustments`.
   */
  it('does NOT materialise an absent lane as an explicit 0 (ledger noise)', () => {
    const out = buildManualAdjustments([], TOP, 100)
    expect(pmap(out)).toEqual({ [TOP]: 100 })
    expect(out).toHaveLength(1)
  })

  it('…but still emits every lane that CARRIES a value, which is the anti-erase guarantee', () => {
    const out = buildManualAdjustments([{ placement: TOP, percentage: 20 }], PROD, 5)
    expect(pmap(out)).toEqual({ [TOP]: 20, [PROD]: 5 })   // Rest absent in, absent out
  })

  it('emits the target lane even when it is being set to 0 — that is how a lane is cleared', () => {
    const out = buildManualAdjustments([{ placement: TOP, percentage: 150 }], TOP, 0)
    expect(pmap(out)).toEqual({ [TOP]: 0 })
  })

  it('clamps to Amazon\'s 0–900 and rounds to an integer', () => {
    expect(pmap(buildManualAdjustments([], TOP, 1000))[TOP]).toBe(900)
    expect(pmap(buildManualAdjustments([], TOP, -50))[TOP]).toBe(0)
    expect(pmap(buildManualAdjustments([], TOP, 61.7))[TOP]).toBe(62)
  })

  it('clamps values it did not touch, so a corrupt stored profile cannot be written back out', () => {
    const out = buildManualAdjustments([{ placement: REST, percentage: 5000 }], TOP, 10)
    expect(pmap(out)[REST]).toBe(900)   // emitted because it carries a value, and clamped
  })

  it('preserves a NON-managed placement Amazon may add (e.g. Amazon Business)', () => {
    const out = buildManualAdjustments(
      [{ placement: TOP, percentage: 10 }, { placement: 'PLACEMENT_AMAZON_BUSINESS', percentage: 25 }],
      TOP, 40,
    )
    expect(pmap(out)).toEqual({ [TOP]: 40, PLACEMENT_AMAZON_BUSINESS: 25 })
  })

  it('setting a lane to 0 zeroes only that lane', () => {
    const out = buildManualAdjustments(
      [{ placement: TOP, percentage: 150 }, { placement: REST, percentage: 45 }],
      TOP, 0,
    )
    expect(pmap(out)).toEqual({ [TOP]: 0, [REST]: 45 })
  })
})

describe('currentLanes', () => {
  it('absent is 0, and only the three managed lanes are returned', () => {
    expect(currentLanes([{ placement: TOP, percentage: 12 }, { placement: 'PLACEMENT_AMAZON_BUSINESS', percentage: 9 }]))
      .toEqual({ [TOP]: 12, [REST]: 0, [PROD]: 0 })
  })
  it('survives null, undefined and junk', () => {
    expect(currentLanes(null)).toEqual({ [TOP]: 0, [REST]: 0, [PROD]: 0 })
    expect(currentLanes(undefined)).toEqual({ [TOP]: 0, [REST]: 0, [PROD]: 0 })
    expect(currentLanes([{ placement: TOP, percentage: Number.NaN }])).toEqual({ [TOP]: 0, [REST]: 0, [PROD]: 0 })
  })
})

describe('isNoOp — an unchanged lane must not be counted as a write', () => {
  it('is true when the value already matches, including absent vs 0', () => {
    expect(isNoOp([{ placement: TOP, percentage: 60 }], TOP, 60)).toBe(true)
    expect(isNoOp([], REST, 0)).toBe(true)                      // absent and 0 are the same instruction
    expect(isNoOp([{ placement: TOP, percentage: 60 }], TOP, 61)).toBe(false)
  })
  it('compares AFTER clamping, so 1000 → 900 on a lane already at 900 is a no-op', () => {
    expect(isNoOp([{ placement: TOP, percentage: 900 }], TOP, 1000)).toBe(true)
  })
})

/**
 * C2 (2026-10-07) — the CPC ceiling's base bid is the highest bid that SERVES. On 2026-10-07 the auto campaign
 * IT_Auto_Close (ad group default 50¢; its one live auto target at 14¢, three paused at 30¢) read "base bid ALONE exceeds
 * the €0.45 CPC ceiling" and its 150 % Top of search was capped to 0 %: the default no target uses was the base.
 */
describe('servingBaseBidByCampaign — the bids that serve', () => {
  const group = (id: string, campaignId: string, defaultBidCents: number, suppressedFromBidCents: number | null = null) => ({ id, campaignId, defaultBidCents, suppressedFromBidCents })
  const target = (adGroupId: string, bidCents: number, status = 'ENABLED', suppressedFromBidCents: number | null = null) => ({ adGroupId, status, bidCents, suppressedFromBidCents })

  it('an auto ad group whose targets bid for themselves: its live target, not its default or its paused targets', () => {
    const base = servingBaseBidByCampaign([group('g', 'IT_Auto_Close', 50)], [target('g', 14), target('g', 30, 'PAUSED')])
    expect(base.get('IT_Auto_Close')).toBe(14)
    // The ceiling then caps nothing at 150 %: €0.45 / 14¢ − 1 = 221 % (it was 0 %, "base bid ALONE exceeds it").
    expect(cpcCapPct(45, base.get('IT_Auto_Close'))).toEqual({ capPct: 221, baseAlone: false })
    expect(cpcCapPct(45, 50)).toEqual({ capPct: 0, baseAlone: true })
  })

  it('an ad group with no target of its own serves its default bid', () => {
    const base = servingBaseBidByCampaign([group('g1', 'c', 60), group('g2', 'c', 50)], [target('g2', 20)])
    expect(base.get('c')).toBe(60)
  })

  it('the bid a suppression gives back still counts — it is what serves the moment the floor lifts', () => {
    expect(servingBaseBidByCampaign([group('g', 'c', 50)], [target('g', 2, 'ENABLED', 35)]).get('c')).toBe(35)
    expect(servingBaseBidByCampaign([group('g', 'c', 2, 70)], []).get('c')).toBe(70)
  })

  it('the highest serving bid across ad groups wins', () => {
    const base = servingBaseBidByCampaign([group('g1', 'c', 50), group('g2', 'c', 50)], [target('g1', 14), target('g2', 22), target('g2', 90, 'ARCHIVED')])
    expect(base.get('c')).toBe(22)
  })

  it('a campaign where nothing serves (every target paused) keeps the reading of every bid, so its ceiling is never looser', () => {
    const base = servingBaseBidByCampaign([group('g', 'c', 50)], [target('g', 30, 'PAUSED')])
    expect(base.get('c')).toBe(50)
    expect(servingBaseBidByCampaign([], []).size).toBe(0)
  })
})
