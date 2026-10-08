/**
 * ONE BRAIN AB-1 — the Owner's overrides over the brain's defaults (brain/settings.ts resolveBrainSettings). Owner 10-08:
 * "I should be able to control it individually as well".
 *
 *   defaults    no override: every lever OBSERVE and every setting its default, source "default"
 *   precedence  campaign override > product override > default, for a level and for a setting; each value names its
 *               source, who and when
 *   lever       the most specific scope that says anything about a lever decides; inside it a lock beats a level
 *   exclusion   a campaign or product exclusion wins over every lever (EXCLUDED, nothing owned)
 *   lock        a locked lever writes nothing (LOCKED); a lock of one thing inside a lever is listed, the level stays
 *   scope       only this product × market's product overrides and this campaign's overrides count; ended rows never
 *   fail closed a stored row that no longer validates is ignored and listed
 *   validate    the writer's checks: identity and value per kind
 *
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { resolveBrainSettings, validateIdentity, validateOverride, type OverrideRow } from './settings.js'

let n = 0
const row = (o: Partial<OverrideRow> & Pick<OverrideRow, 'scope' | 'kind' | 'key'>): OverrideRow => ({
  id: `o-${++n}`, productId: 'p-1', marketplace: 'IT', campaignId: null, ref: '', value: null, by: 'user:owner', reason: null,
  createdAt: new Date(Date.parse('2026-10-08T06:00:00Z') + n * 60_000), endedAt: null, ...o,
})
const resolve = (overrides: OverrideRow[], campaignId: string | null = 'c-1', enrolled = true) =>
  resolveBrainSettings({ productId: 'p-1', market: 'IT', campaignId, enrolled, overrides })

describe('resolveBrainSettings', () => {
  it('with no override every lever is OBSERVE and every setting its default, from the brain', () => {
    const s = resolve([])
    expect(s.levers.bids).toMatchObject({ level: { value: 'OBSERVE', source: 'default', by: null }, lock: null, locks: [], effective: 'OBSERVE', owned: false })
    expect(s.values.portfolioCapOn).toEqual({ value: true, source: 'default', overrideId: null, by: null, at: null, reason: null })
    expect(s.values.paceTargetPct.value).toBe(90)
    expect(s.excluded).toMatchObject({ value: false, source: 'default' })
  })

  it('a campaign override beats a product override beats the default — and says who and when', () => {
    const product = row({ scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO', by: 'user:owner', reason: 'go', createdAt: new Date('2026-10-08T09:00:00Z') })
    const campaign = row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LEVEL', key: 'bids', value: 'OBSERVE', by: 'user:owner-2', createdAt: new Date('2026-10-08T09:30:00Z') })
    expect(resolve([product]).levers.bids).toMatchObject({ level: { value: 'AUTO', source: 'product', by: 'user:owner', at: '2026-10-08T09:00:00.000Z', reason: 'go', overrideId: product.id }, effective: 'AUTO', owned: true })
    expect(resolve([product, campaign]).levers.bids).toMatchObject({ level: { value: 'OBSERVE', source: 'campaign', by: 'user:owner-2' }, effective: 'OBSERVE', owned: false })
    // The product view (no campaign) and another campaign keep the product's level.
    expect(resolve([product, campaign], null).levers.bids.level.source).toBe('product')
    expect(resolve([product, campaign], 'c-2').levers.bids.effective).toBe('AUTO')
    // Settings follow the same order.
    const capP = row({ scope: 'PRODUCT', kind: 'VALUE', key: 'negativesPerEntityMax', value: 900 })
    const capC = row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'VALUE', key: 'negativesPerEntityMax', value: 500 })
    expect(resolve([capP]).values.negativesPerEntityMax).toMatchObject({ value: 900, source: 'product' })
    expect(resolve([capP, capC]).values.negativesPerEntityMax).toMatchObject({ value: 500, source: 'campaign' })
    expect(resolve([capP, capC], 'c-2').values.negativesPerEntityMax.value).toBe(900)
  })

  it('per lever the most specific scope decides, and a lock beats a level inside it', () => {
    const productAuto = row({ scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO' })
    const campaignLock = row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LOCK', key: 'bids' })
    expect(resolve([productAuto, campaignLock]).levers.bids).toMatchObject({ level: { value: 'AUTO', source: 'product' }, lock: { value: null, source: 'campaign' }, effective: 'LOCKED', owned: false })
    expect(resolve([productAuto, campaignLock]).levers.bids.why).toMatch(/locked at the Owner's own value .*only recommends/)
    // A product-wide lock holds every campaign, unless a campaign says its own level.
    const productLock = row({ scope: 'PRODUCT', kind: 'LOCK', key: 'budgets', value: null })
    const campaignBudgetLevel = row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LEVEL', key: 'budgets', value: 'OBSERVE' })
    expect(resolve([productLock], 'c-2').levers.budgets.effective).toBe('LOCKED')
    expect(resolve([productLock, campaignBudgetLevel]).levers.budgets).toMatchObject({ lock: null, effective: 'OBSERVE' })
    // The Owner's own value travels with the lock.
    const strategy = row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LOCK', key: 'biddingStrategy', value: 'LEGACY_FOR_SALES' })
    expect(resolve([strategy]).levers.biddingStrategy.lock?.value).toBe('LEGACY_FOR_SALES')
  })

  it('the brain runs bids on a campaign but not its budget', () => {
    const s = resolve([
      row({ scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO' }),
      row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LEVEL', key: 'budgets', value: 'OFF' }),
    ])
    expect(s.levers.bids.effective).toBe('AUTO')
    expect(s.levers.budgets).toMatchObject({ effective: 'OFF', level: { source: 'campaign' } })
  })

  it('an exclusion of the campaign or of the product wins over every lever', () => {
    const auto = row({ scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO' })
    const campaignAuto = row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LEVEL', key: 'bids', value: 'AUTO' })
    const outCampaign = row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'EXCLUDE', key: '*', by: 'user:owner', reason: 'my own campaign' })
    const s = resolve([auto, outCampaign])
    expect(s.excluded).toMatchObject({ value: true, source: 'campaign', reason: 'my own campaign' })
    expect(s.levers.bids).toMatchObject({ effective: 'EXCLUDED', owned: false })
    expect(s.levers.bids.why).toMatch(/excluded by the Owner's campaign override/)
    expect(resolve([auto, outCampaign], 'c-2').levers.bids.effective).toBe('AUTO')
    const outProduct = row({ scope: 'PRODUCT', kind: 'EXCLUDE', key: '*' })
    expect(resolve([auto, campaignAuto, outProduct]).levers.bids.effective).toBe('EXCLUDED')
    expect(resolve([outProduct], null).excluded.source).toBe('product')
  })

  it('a lock of one thing inside a lever is listed and leaves the level', () => {
    const s = resolve([
      row({ scope: 'PRODUCT', kind: 'LOCK', key: 'hours', ref: 'hourCell:d1h14' }),
      row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LOCK', key: 'hours', ref: 'hourCell:d2h9' }),
      row({ scope: 'CAMPAIGN', campaignId: 'c-9', kind: 'LOCK', key: 'hours', ref: 'hourCell:d3h9' }),
    ])
    expect(s.levers.hours).toMatchObject({ lock: null, effective: 'OBSERVE' })
    expect(s.levers.hours.locks.map((l) => [l.ref, l.source])).toEqual([['hourCell:d1h14', 'product'], ['hourCell:d2h9', 'campaign']])
  })

  it('counts only this product × market, this campaign and open rows; the newest of one identity wins', () => {
    const s = resolve([
      row({ scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO', productId: 'p-other' }),
      row({ scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO', marketplace: 'DE' }),
      row({ scope: 'PRODUCT', kind: 'EXCLUDE', key: '*', endedAt: new Date('2026-10-08T11:00:00Z') }),
      row({ scope: 'PRODUCT', kind: 'VALUE', key: 'paceTargetPct', value: 80, createdAt: new Date('2026-10-01T00:00:00Z') }),
      row({ scope: 'PRODUCT', kind: 'VALUE', key: 'paceTargetPct', value: 70, createdAt: new Date('2026-10-02T00:00:00Z') }),
    ])
    expect(s.levers.bids.effective).toBe('OBSERVE')
    expect(s.excluded.value).toBe(false)
    expect(s.values.paceTargetPct.value).toBe(70)
  })

  it('not enrolled: every lever NOT_ENROLLED, nothing owned', () => {
    const s = resolve([row({ scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO' })], 'c-1', false)
    expect(s.levers.bids).toMatchObject({ level: { value: 'AUTO' }, effective: 'NOT_ENROLLED', owned: false })
  })

  it('a stored row that no longer validates is ignored and listed (the next level applies)', () => {
    const bad = row({ scope: 'PRODUCT', kind: 'LEVEL', key: 'negatives', value: 'AUTO' })
    const worse = row({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'VALUE', key: 'paceTargetPct', value: 80 })
    const s = resolve([bad, worse])
    expect(s.levers.negatives.effective).toBe('OBSERVE')
    expect(s.values.paceTargetPct.value).toBe(90)
    expect(s.ignored.map((i) => i.overrideId)).toEqual([bad.id, worse.id])
  })
})

describe('validateOverride', () => {
  it('checks the identity and the value of each kind', () => {
    expect(validateOverride({ scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO' })).toEqual({ override: { scope: 'PRODUCT', campaignId: null, kind: 'LEVEL', key: 'bids', ref: '', value: 'AUTO' } })
    expect(validateOverride({ scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'ON' })).toEqual({ refusal: expect.stringContaining('OFF, OBSERVE, PROPOSE or AUTO') })
    expect(validateOverride({ scope: 'CAMPAIGN', kind: 'LEVEL', key: 'budgets', value: 'AUTO', campaignId: 'c-1' })).toEqual({ refusal: expect.stringContaining('AB-7') })
    expect(validateOverride({ scope: 'CAMPAIGN', kind: 'EXCLUDE', key: '*' })).toEqual({ refusal: 'a campaign override names its campaign (campaignId)' })
    expect(validateOverride({ scope: 'PRODUCT', kind: 'EXCLUDE', key: '*', campaignId: 'c-1' })).toEqual({ refusal: 'a product override names no campaign' })
    expect(validateOverride({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'EXCLUDE', key: '*', value: true })).toEqual({ refusal: 'an exclusion takes no value' })
    expect(validateOverride({ scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LOCK', key: 'budgets', value: { dailyBudgetCents: 3000 } })).toMatchObject({ override: { kind: 'LOCK', ref: '', value: { dailyBudgetCents: 3000 } } })
    expect(validateOverride({ scope: 'PRODUCT', kind: 'LOCK', key: 'negatives', ref: 'term: Rain  Jacket' })).toMatchObject({ override: { ref: 'term:rain jacket', value: null } })
    expect(validateOverride({ scope: 'PRODUCT', kind: 'VALUE', key: 'portfolioCapOn', value: false })).toMatchObject({ override: { key: 'portfolioCapOn', value: false } })
    expect(validateOverride({ scope: 'PRODUCT', kind: 'VALUE', key: 'portfolioCapPct', value: 99 })).toHaveProperty('refusal')
    expect(validateOverride({ scope: 'PRODUCT', kind: 'PAUSE' as never, key: 'x' })).toEqual({ refusal: expect.stringContaining('LEVEL, LOCK, EXCLUDE, VALUE') })
    // An end names only what it ends.
    expect(validateIdentity({ scope: 'PRODUCT', kind: 'VALUE', key: 'paceTargetPct' })).toEqual({ identity: { scope: 'PRODUCT', campaignId: null, kind: 'VALUE', key: 'paceTargetPct', ref: '' } })
  })
})
