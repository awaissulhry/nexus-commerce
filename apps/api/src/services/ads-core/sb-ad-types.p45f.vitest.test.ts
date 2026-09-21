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
 * ## 🔴 2026-09-21 (later) — the wire value WAS established, and the question was wrong
 *
 * The original slice stopped because *"Amazon's `POST /sb/v4/ads` reference renders only with
 * JavaScript"*. That was true of the **page** and not of the **document behind it**: the page
 * fetches `d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json`, plain
 * JSON, no browser needed. **"The docs need JavaScript" is a claim about the renderer, not about
 * the data — ask what the page fetches.**
 *
 * And the answer is that there is no wire value to find, because there is no such field:
 *
 * | the old vocabulary assumed | Amazon's 4.0 document |
 * |---|---|
 * | one endpoint `POST /sb/v4/ads` | **`/sb/v4/ads` is `PUT` only** (`UpdateSponsoredBrandsAds`) |
 * | a discriminator `adType` | **0 occurrences** of `adType` in the whole document |
 * | "Manual Collection" as an unconfirmable enum value | an **endpoint**: `POST /sb/v4/ads/manualCollection` |
 *
 * So the creative type chooses the **path**, each path has its **own body shape**, and the old
 * request would have failed on four counts — wrong method for that path, a field that does not
 * exist, a `campaignId` that is not part of a create-ad item, and a **missing required `name`**.
 * Nobody knew, because `/sb/v4/ads` has **0 calls ever**.
 *
 * The restraint in the original slice was still right: it refused to guess. What changed is that
 * the answer became available.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SB_AD_TYPES, SB_AD_TYPE_KEYS, SB_AD_TYPES_CURRENT, SB_AD_STATES, sbAdCreatePath, sbAdTypeSpec, sbAdTypeNotice,
} from './sb-ad-types.js'
import { sbAdCreateRequest } from '../advertising/ads-api-client.js'

const SRC = join(import.meta.dirname, '..', '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('SB ad-type vocabulary (P4.5f)', () => {
  it('names the creative types and which one Amazon deprecated', () => {
    expect(SB_AD_TYPE_KEYS.sort()).toEqual(['manualCollection', 'productCollection', 'storeSpotlight', 'video'])
    expect(SB_AD_TYPES.productCollection.deprecated?.on).toBe('2026-07-06')
    expect(SB_AD_TYPES.manualCollection.deprecated).toBeNull()
    expect(SB_AD_TYPES.storeSpotlight.deprecated).toBeNull()
    expect(SB_AD_TYPES.video.deprecated).toBeNull()
  })

  it('🔴 every type maps to its OWN creation endpoint — creation is not one path', () => {
    expect(sbAdCreatePath('productCollection')).toBe('/sb/v4/ads/productCollection')
    expect(sbAdCreatePath('manualCollection')).toBe('/sb/v4/ads/manualCollection')
    expect(sbAdCreatePath('storeSpotlight')).toBe('/sb/v4/ads/storeSpotlight')
    expect(sbAdCreatePath('video')).toBe('/sb/v4/ads/video')
    // The old code posted here. Amazon accepts only PUT on it (UpdateSponsoredBrandsAds).
    for (const k of SB_AD_TYPE_KEYS) expect(sbAdCreatePath(k)).not.toBe('/sb/v4/ads')
  })

  it("Amazon's own enums are recorded, not re-derived", () => {
    expect(SB_AD_STATES).toEqual(['ENABLED', 'PAUSED'])
  })

  it('records that Amazon announced NO shutdown date, rather than the reported one', () => {
    // P0.8: "A January 2027 shut-off is reported only by a third party; Amazon's own
    // note (2026-07-06) says 'deprecated' with no date." Storing the third-party date
    // as if it were Amazon's is how a rumour becomes a deadline.
    expect(SB_AD_TYPES.productCollection.deprecated?.shutdownDate).toBeNull()
    expect(SB_AD_TYPES.productCollection.deprecated?.source).toMatch(/no date given/)
  })

  it('the deprecated type is still reachable — Amazon deprecated it, it did not remove it', () => {
    // Its endpoint is still in the 4.0 document, and an operator matching an existing
    // campaign's format must still be able to create one.
    expect(sbAdCreatePath('productCollection')).toBe('/sb/v4/ads/productCollection')
  })

  it('REFUSES a type the vocabulary does not name', () => {
    expect(() => sbAdCreatePath('autoCollection')).toThrow(/not a Sponsored Brands creative type/)
    expect(() => sbAdCreatePath('')).toThrow(/not a Sponsored Brands creative type/)
    expect(() => sbAdTypeSpec('nonsense')).toThrow(/not a Sponsored Brands creative type/)
  })

  it('the deprecation notice names the date, the replacement and its source', () => {
    const n = sbAdTypeNotice('productCollection')!
    expect(n).toMatch(/2026-07-06/)
    expect(n).toMatch(/Manual Collection or Auto Collection/)
    expect(n).toMatch(/no shutdown date/)
    expect(sbAdTypeNotice('video')).toBeNull()
  })

  it('offers only the undeprecated types for a NEW creative', () => {
    expect(SB_AD_TYPES_CURRENT).toEqual(['manualCollection', 'storeSpotlight', 'video'])
    expect(SB_AD_TYPES_CURRENT).not.toContain('productCollection')
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

  it('the client builds its request from the one vocabulary', () => {
    expect(read('services/advertising/ads-api-client.ts')).toContain('sbAdCreateRequest(input)')
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
