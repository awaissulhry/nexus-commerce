/**
 * P4.5f — nothing creates a deprecated Sponsored Brands entity by accident.
 *
 * ## What was measured, and the line this slice would not cross
 *
 * **The defect:** `createSbAdLocal` read
 * `const creativeType = input.creativeType ?? 'productCollection'`
 * (`ads-create.service.ts:940`). Its one caller,
 * `POST /advertising/sb-creatives/create`, passes the request body straight through as
 * `never`, so an operator who simply did not mention a creative type got the entity
 * Amazon deprecated on **2026-07-06**, with nothing said.
 *
 * **The path has never run.** `/sb/v4/ads` has **0 rows** in `OutboundApiCallLog`
 * (only `/sb/v4/ads/list`, 285). `AdProductAd` holds **0** rows with `adType: BRAND_AD`.
 * So the default has never actually produced a deprecated ad — which is what makes this
 * cheap to fix and impossible to verify against a real Amazon answer.
 *
 * 🔴 **What this slice deliberately did NOT do: rename the wire value.**
 *
 * The plan row says *"default to Manual Collection"*. The wire value for Manual /
 * Auto Collection could not be established: Amazon's `POST /sb/v4/ads` reference
 * renders only with JavaScript (P0.8 hit the same wall on the deprecations page), two
 * web checks on 2026-09-21 returned only third-party write-ups, and with 0 stored calls
 * there is no Amazon answer to derive it from either.
 *
 * Swapping a value Amazon still accepts — it deprecated the entity, it did not remove
 * it, and Amazon's own note carries **no shutdown date** — for a guessed one, on a path
 * that has never run, is the worse trade. `predict BEFORE you write` cuts both ways: a
 * change whose correct value cannot be stated in advance is not a fix.
 *
 * The same restraint applies to the casing. Every other enum this client sends on SB v4
 * is upper-cased, and `adType: 'productCollection'` is not. That is a smell recorded in
 * `sb-ad-types.ts`, not a finding, because nothing here can tell the difference between
 * "wrong case" and "this endpoint's convention".
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SB_AD_TYPES, SB_AD_TYPE_KEYS, SB_AD_TYPES_CURRENT, sbAdTypeWire, sbAdTypeNotice,
} from './sb-ad-types.js'

const SRC = join(import.meta.dirname, '..', '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('SB ad-type vocabulary (P4.5f)', () => {
  it('names the three creative types and which one Amazon deprecated', () => {
    expect(SB_AD_TYPE_KEYS.sort()).toEqual(['productCollection', 'storeSpotlight', 'video'])
    expect(SB_AD_TYPES.productCollection.deprecated?.on).toBe('2026-07-06')
    expect(SB_AD_TYPES.storeSpotlight.deprecated).toBeNull()
    expect(SB_AD_TYPES.video.deprecated).toBeNull()
  })

  it('records that Amazon announced NO shutdown date, rather than the reported one', () => {
    // P0.8: "A January 2027 shut-off is reported only by a third party; Amazon's own
    // note (2026-07-06) says 'deprecated' with no date." Storing the third-party date
    // as if it were Amazon's is how a rumour becomes a deadline.
    expect(SB_AD_TYPES.productCollection.deprecated?.shutdownDate).toBeNull()
    expect(SB_AD_TYPES.productCollection.deprecated?.source).toMatch(/no date given/)
  })

  it('the wire value for the deprecated type is UNCHANGED', () => {
    // Deprecated is not removed, and the replacement's wire value could not be
    // established. Changing it here would be a guess on a path that has never run.
    expect(sbAdTypeWire('productCollection')).toBe('productCollection')
  })

  it('REFUSES a type the vocabulary does not name', () => {
    expect(() => sbAdTypeWire('manualCollection')).toThrow(/not a Sponsored Brands creative type/)
    expect(() => sbAdTypeWire('')).toThrow(/not a Sponsored Brands creative type/)
  })

  it('the deprecation notice names the date, the replacement and its source', () => {
    const n = sbAdTypeNotice('productCollection')!
    expect(n).toMatch(/2026-07-06/)
    expect(n).toMatch(/Manual Collection or Auto Collection/)
    expect(n).toMatch(/no shutdown date/)
    expect(sbAdTypeNotice('video')).toBeNull()
  })

  it('offers only the undeprecated types for a NEW creative', () => {
    expect(SB_AD_TYPES_CURRENT).toEqual(['storeSpotlight', 'video'])
  })
})

describe('createSbAdLocal (P4.5f — no silent default)', () => {
  const svc = read('services/advertising/ads-create.service.ts')

  it('the deprecated default is gone', () => {
    expect(svc).not.toContain("input.creativeType ?? 'productCollection'")
  })

  it('an omitted creativeType is REFUSED, with a sentence naming the choice', () => {
    expect(svc).toContain('if (!input.creativeType) {')
    expect(svc).toContain('an SB creative needs an explicit creativeType.')
    expect(svc).toContain('SB_AD_TYPE_KEYS.join')
  })

  it('an explicitly deprecated type is sent, and logged', () => {
    // Refusing would break an operator deliberately matching an existing campaign's
    // format — for an entity Amazon has not removed and set no date for.
    expect(svc).toContain('const deprecation = sbAdTypeNotice(creativeType)')
    expect(svc).toContain("logger.warn('[AX2.9] creating a DEPRECATED Sponsored Brands creative'")
  })

  it('the client takes its wire value from the one vocabulary', () => {
    expect(read('services/advertising/ads-api-client.ts')).toContain('adType: sbAdTypeWire(input.creativeType)')
  })
})

describe('blast radius (P4.5f — what this must NOT have touched)', () => {
  it("Sponsored DISPLAY's creativeType is a different field on a different API", () => {
    // `createSdAdGroup` sends `creativeType: 'IMAGE'` on /sd/adGroups. Same word,
    // unrelated vocabulary — the two-vocabularies trap in its "one word, two meanings"
    // form. A test pins that it still does.
    const client = read('services/advertising/ads-api-client.ts')
    expect(client).toContain("creativeType?: 'IMAGE' | 'VIDEO'")
    expect(client).toContain("creativeType: input.creativeType ?? 'IMAGE',")
  })

  it('the SB path still has no live caller to regress (positive control)', () => {
    // If `createSbAdLocal` grows an internal caller that omits creativeType, it now
    // throws at run time. Today the only caller is the HTTP route, which passes the
    // operator's own body.
    const callers = read('routes/advertising.routes.ts').split('\n').filter((l) => l.includes('createSbAdLocal'))
    expect(callers.length).toBe(2) // the dynamic import, and the call
  })
})
