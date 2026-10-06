/**
 * CC-12 — Sponsored Display targets in SD's own dialect, not the Sponsored Products v3 one.
 *
 * Every expected shape is copied from Amazon's Sponsored Display 3.0 document (`POST /sd/targets`,
 * `CreateTargetingClause`, `TargetingPredicateNested`, `TargetingPredicateBase`), read 2026-10-05. No SD target create
 * has ever run, so the first real one still needs a live confirmation; these pin that Nexus sends the documented shape.
 */
import { describe, expect, it } from 'vitest'
import { SdTargetRefused, sdExpressionValue, sdTargetExpression } from './sd-target-expression.js'
import { createSdTarget, sdCreateResult, sdTargetCreateBody } from './ads-api-client.js'

const CTX = { profileId: 'test-profile', region: 'EU' as const }

describe('sdTargetExpression — SD predicate types, never the SP v3 ones', () => {
  it('a product target is asinSameAs (camelCase), not ASIN_SAME_AS', () => {
    expect(sdTargetExpression({ kind: 'PRODUCT', value: 'b0test0001' })).toEqual([{ type: 'asinSameAs', value: 'B0TEST0001' }])
  })

  it('a category target is asinCategorySameAs', () => {
    expect(sdTargetExpression({ kind: 'CATEGORY', value: '12345' })).toEqual([{ type: 'asinCategorySameAs', value: '12345' }])
  })

  it('views remarketing is NESTED: the advertised products plus a required lookback', () => {
    expect(sdTargetExpression({ kind: 'AUDIENCE', audienceType: 'VIEWS_REMARKETING', value: 'exactProduct', lookbackDays: 14 }))
      .toEqual([{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '14' }] }])
  })

  it('the lookback defaults to 30 days, and a stored "scope lookback=N" round-trips', () => {
    const fresh = sdTargetExpression({ kind: 'AUDIENCE', audienceType: 'VIEWS_REMARKETING', value: 'exactProduct' })
    expect(fresh).toEqual([{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }])
    expect(sdExpressionValue(fresh)).toBe('exactProduct lookback=30')
    expect(sdTargetExpression({ kind: 'AUDIENCE', audienceType: 'VIEWS_REMARKETING', value: 'exactProduct lookback=60' }))
      .toEqual([{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '60' }] }])
  })

  it('purchases may use relatedProduct and a 365-day window; a category scope is asinCategorySameAs', () => {
    expect(sdTargetExpression({ kind: 'AUDIENCE', audienceType: 'PURCHASES_REMARKETING', value: 'relatedProduct', lookbackDays: 365 }))
      .toEqual([{ type: 'purchases', value: [{ type: 'relatedProduct' }, { type: 'lookback', value: '365' }] }])
    const cat = sdTargetExpression({ kind: 'AUDIENCE', audienceType: 'VIEWS_REMARKETING', value: '12345', lookbackDays: 90 })
    expect(cat).toEqual([{ type: 'views', value: [{ type: 'asinCategorySameAs', value: '12345' }, { type: 'lookback', value: '90' }] }])
    expect(sdExpressionValue(cat)).toBe('12345 lookback=90')
  })

  it('an Amazon audience is audience → audienceSameAs', () => {
    expect(sdTargetExpression({ kind: 'AUDIENCE', audienceType: 'AUDIENCE', value: '424242' }))
      .toEqual([{ type: 'audience', value: [{ type: 'audienceSameAs', value: '424242' }] }])
  })
})

describe('sdTargetExpression — what Amazon would refuse is refused first, with the reason', () => {
  it('views of ONE named ASIN (the old builder sent a bare ASIN)', () => {
    expect(() => sdTargetExpression({ kind: 'AUDIENCE', audienceType: 'VIEWS_REMARKETING', value: 'B0TEST0001' }))
      .toThrow(/cannot target the views of one ASIN \(B0TEST0001\)\. Use "exactProduct"/)
  })
  it('a lookback Amazon does not list for that event', () => {
    expect(() => sdTargetExpression({ kind: 'AUDIENCE', audienceType: 'VIEWS_REMARKETING', value: 'exactProduct', lookbackDays: 180 }))
      .toThrow(/views window of 7, 14, 30, 60, 90 days, not 180/)
  })
  it('a SKU sent as a product target', () => {
    expect(() => sdTargetExpression({ kind: 'PRODUCT', value: 'TEST-SKU-JACKET-XL' })).toThrow(SdTargetRefused)
  })
  it('an auto clause (SD has none)', () => {
    expect(() => sdTargetExpression({ kind: 'AUTO', value: 'CLOSE_MATCH' })).toThrow(/product, a category or an audience/)
  })
})

describe('the /sd/targets create body and answer', () => {
  it('a bare array: numeric adGroupId, expressionType manual, lowercase state — no campaignId, no SP casing', () => {
    const body = sdTargetCreateBody({ externalCampaignId: '111', externalAdGroupId: '123456789012345', expression: [{ type: 'asinSameAs', value: 'B0TEST0001' }], bid: 0.45 })
    expect(body).toEqual([{ adGroupId: 123456789012345, expressionType: 'manual', expression: [{ type: 'asinSameAs', value: 'B0TEST0001' }], bid: 0.45, state: 'enabled' }])
    expect(JSON.stringify(body)).not.toMatch(/ENABLED|ASIN_SAME_AS|campaignId/)
  })

  it('a dry run returns that body and calls nothing', async () => {
    const r = await createSdTarget(CTX, { externalAdGroupId: '42', expression: [{ type: 'asinSameAs', value: 'B0TEST0001' }], bid: 0.3, state: 'paused', dryRun: true })
    expect(r.mode).toBe('dry-run')
    expect(r.rawResponse).toEqual({ wouldSend: { method: 'POST', path: '/sd/targets', body: [{ adGroupId: 42, expressionType: 'manual', expression: [{ type: 'asinSameAs', value: 'B0TEST0001' }], bid: 0.3, state: 'paused' }] } })
  })

  it('reads SD\'s bare-array answer: the id when made, Amazon\'s words when refused — never `.success`', () => {
    expect(sdCreateResult([{ code: 'SUCCESS', targetId: 98765 }], 'targetId')).toEqual({ externalId: '98765', error: null })
    expect(sdCreateResult([{ code: 'INVALID_ARGUMENT', description: 'audience size is too small' }], 'targetId'))
      .toEqual({ externalId: null, error: 'Amazon refused it: INVALID_ARGUMENT — audience size is too small' })
    // The SP-shaped answer the old code read is not an SD create.
    expect(sdCreateResult({ success: [{ targetId: '1' }] }, 'targetId').externalId).toBeNull()
  })

  it('sdExpressionValue reads what Amazon gives back the same way Nexus stored it', () => {
    expect(sdExpressionValue([{ type: 'asinSameAs', value: 'B0TEST0001' }])).toBe('B0TEST0001')
    expect(sdExpressionValue([{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }])).toBe('exactProduct lookback=30')
    expect(sdExpressionValue(undefined)).toBeUndefined()
  })
})
