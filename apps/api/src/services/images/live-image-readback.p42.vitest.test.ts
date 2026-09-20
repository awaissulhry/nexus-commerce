/**
 * P4.2c — image read-back for the other two channels.
 *
 * ## What was measured (2026-09-20)
 *
 * The P4.2 row asks for "read-back for every channel". All three channels have a
 * read-back FUNCTION; only eBay's ever runs on its own.
 *
 *   eBay     refreshEbayLiveImages + readbackAllEbayLiveImages   scheduled
 *   Amazon   refreshAmazonLiveImages                             route + adopt only
 *   Shopify  refreshShopifyLiveImages                            route only
 *
 * **A read-back that only runs when somebody opens a screen cannot detect
 * drift.** It confirms what the person is already looking at. Drift is exactly
 * the case where nobody is looking.
 *
 * The census row of P4.2 was also checked and is a COUNTERWEIGHT: every image
 * publisher already goes through the gateway and a publish gate — proven by the
 * gateway ratchet standing at `{"EBAY":0,"AMAZON_SP":0,…}`, not by a grep of
 * mine. My first grep DID report `amazon-media-publish.service.ts` as ungated;
 * it was wrong, because that file reaches the gateway through
 * `amazon-media-client.ts` and my pattern list did not name it. A census with a
 * hand-written pattern list is a set claim, and that one was false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', '..')

const listings: Array<{ productId: string; marketplace: string | null }> = []
vi.mock('../../db.js', () => ({
  default: { channelListing: { findMany: async () => listings } },
}))

const amazonConfigured = { value: true }
vi.mock('../../lib/amazon-sp-client.js', () => ({
  amazonCredsConfigured: async () => amazonConfigured.value,
}))

const amazonCalls: Array<{ productId: string; marketplaceCode: string }> = []
const amazonResult = { rowsUpserted: 1 }
vi.mock('./amazon-live-images.service.js', () => ({
  refreshAmazonLiveImages: async (o: any) => {
    amazonCalls.push(o)
    // A named product that fails, so the "one failure does not stop the rest"
    // arm exercises the real catch rather than a spy override.
    if (o.productId === 'bad') throw new Error('SP-API 500')
    return amazonResult
  },
}))

const shopifyCalls: string[] = []
const shopifyResult: any = { rowsUpserted: 1 }
vi.mock('./shopify-live-images.service.js', () => ({
  refreshShopifyLiveImages: async (o: any) => { shopifyCalls.push(o.productId); return shopifyResult },
}))

const {
  readbackAllAmazonLiveImages, readbackAllShopifyLiveImages,
  runImageReadbackSweep, imageReadbackSweepEnabled, readbackCap,
} = await import('./live-image-readback.service.js')

beforeEach(() => {
  listings.length = 0
  amazonCalls.length = 0
  shopifyCalls.length = 0
  amazonConfigured.value = true
  amazonResult.rowsUpserted = 1
  shopifyResult.rowsUpserted = 1
  delete shopifyResult.skipped
  delete shopifyResult.error
  vi.unstubAllEnvs()
})
afterEach(() => vi.unstubAllEnvs())

/* ── 1. the switch ────────────────────────────────────────────────────────── */

describe('1. off unless explicitly enabled', () => {
  it('needs the exact string "true"', () => {
    for (const v of ['1', 'TRUE', 'yes', 'false', '']) {
      vi.stubEnv('NEXUS_ENABLE_IMAGE_READBACK_SWEEP', v)
      expect(imageReadbackSweepEnabled(), `flag=${JSON.stringify(v)}`).toBe(false)
    }
    vi.stubEnv('NEXUS_ENABLE_IMAGE_READBACK_SWEEP', 'true')
    expect(imageReadbackSweepEnabled()).toBe(true) // positive control
  })

  it('the sweep does nothing at all while off', async () => {
    listings.push({ productId: 'p1', marketplace: 'IT' })
    vi.stubEnv('NEXUS_ENABLE_IMAGE_READBACK_SWEEP', 'false')
    expect(await runImageReadbackSweep()).toEqual([])
    expect(amazonCalls).toEqual([])
    expect(shopifyCalls).toEqual([])
  })

  it('and DOES run when on', async () => {
    listings.push({ productId: 'p1', marketplace: 'IT' })
    vi.stubEnv('NEXUS_ENABLE_IMAGE_READBACK_SWEEP', 'true')
    const runs = await runImageReadbackSweep()
    expect(runs.map((r) => r.channel)).toEqual(['AMAZON', 'SHOPIFY'])
  })
})

/* ── 2. Amazon reads only the markets a product is listed in ──────────────── */

describe('2. Amazon: per SKU per MARKETPLACE, and only the real ones', () => {
  it('asks for each marketplace the product actually has', async () => {
    listings.push(
      { productId: 'p1', marketplace: 'IT' },
      { productId: 'p1', marketplace: 'DE' },
      { productId: 'p2', marketplace: 'IT' },
    )
    const s = await readbackAllAmazonLiveImages()
    expect(amazonCalls).toEqual([
      { productId: 'p1', marketplaceCode: 'IT' },
      { productId: 'p1', marketplaceCode: 'DE' },
      { productId: 'p2', marketplaceCode: 'IT' },
    ])
    expect(s.eligible).toBe(2)
    expect(s.scanned).toBe(3) // 3 reads, 2 products — the multiplier, stated
    expect(s.refreshed).toBe(3)
  })

  it('never invents a marketplace the product is not listed in', async () => {
    listings.push({ productId: 'p1', marketplace: 'IT' })
    await readbackAllAmazonLiveImages()
    expect(amazonCalls.map((c) => c.marketplaceCode)).toEqual(['IT'])
    for (const m of ['DE', 'FR', 'ES', 'UK']) {
      expect(amazonCalls.some((c) => c.marketplaceCode === m), `must not read ${m}`).toBe(false)
    }
  })

  it('de-duplicates a product that has several listing rows in one market', async () => {
    listings.push({ productId: 'p1', marketplace: 'IT' }, { productId: 'p1', marketplace: 'IT' })
    await readbackAllAmazonLiveImages()
    expect(amazonCalls).toHaveLength(1)
  })
})

/* ── 3. unconfigured is not empty ─────────────────────────────────────────── */

describe('3. "could not run" and "ran and found nothing" are different answers', () => {
  it('Amazon with no account reports unconfigured, and reads nothing', async () => {
    listings.push({ productId: 'p1', marketplace: 'IT' })
    amazonConfigured.value = false
    const s = await readbackAllAmazonLiveImages()
    expect(s.unconfigured).toBe(1)
    expect(s.empty).toBe(0)
    expect(s.scanned).toBe(0)
    expect(amazonCalls).toEqual([]) // it did not even try
  })

  it('Shopify NO_CREDS counts as unconfigured, never as empty', async () => {
    // 🔴 P2.4 measured that production has no SHOPIFY_* variable, so this is
    // the expected outcome there — and it must not read as a clean sweep.
    listings.push({ productId: 'p1', marketplace: null })
    shopifyResult.skipped = 'NO_CREDS'
    const s = await readbackAllShopifyLiveImages()
    expect(s.unconfigured).toBe(1)
    expect(s.empty).toBe(0)
    expect(s.skipped).toBe(0)
  })

  it('a different Shopify skip is a real skip, not unconfigured', async () => {
    // The discriminator: NO_PRODUCT_ID means it ran and this product had no
    // Shopify id. That IS a measurement.
    listings.push({ productId: 'p1', marketplace: null })
    shopifyResult.skipped = 'NO_PRODUCT_ID'
    const s = await readbackAllShopifyLiveImages()
    expect(s.skipped).toBe(1)
    expect(s.unconfigured).toBe(0)
  })

  it('a real empty run is counted as empty', async () => {
    listings.push({ productId: 'p1', marketplace: null })
    shopifyResult.rowsUpserted = 0
    const s = await readbackAllShopifyLiveImages()
    expect(s.empty).toBe(1)
    expect(s.unconfigured).toBe(0)
  })
})

/* ── 4. the run is bounded ────────────────────────────────────────────────── */

describe('4. a sweep cannot run away', () => {
  it('caps the products it visits and SAYS it capped', async () => {
    for (let i = 0; i < 10; i++) listings.push({ productId: `p${i}`, marketplace: 'IT' })
    vi.stubEnv('NEXUS_IMAGE_READBACK_MAX_PER_RUN', '3')
    const s = await readbackAllAmazonLiveImages()
    expect(s.eligible).toBe(10)
    expect(amazonCalls).toHaveLength(3)
    expect(s.capped).toBe(true) // a truncated sweep must not look complete
  })

  it('does not claim capped when it was not', async () => {
    listings.push({ productId: 'p1', marketplace: 'IT' })
    vi.stubEnv('NEXUS_IMAGE_READBACK_MAX_PER_RUN', '3')
    expect((await readbackAllAmazonLiveImages()).capped).toBe(false)
  })

  it('has a hard ceiling no environment variable can raise', () => {
    // Tested as a VALUE. A behavioural arm would need 5,000 fixtures to tell
    // 5,000 from 999,999, so it could not discriminate — and a mutation proved
    // exactly that: removing the ceiling left the behavioural test green.
    vi.stubEnv('NEXUS_IMAGE_READBACK_MAX_PER_RUN', '999999')
    expect(readbackCap()).toBe(5000)
    vi.stubEnv('NEXUS_IMAGE_READBACK_MAX_PER_RUN', '250')
    expect(readbackCap()).toBe(250) // positive control: a sane value is honoured
  })

  it('falls back to a safe default for a nonsense value', () => {
    for (const v of ['', 'lots', '0', '-5']) {
      vi.stubEnv('NEXUS_IMAGE_READBACK_MAX_PER_RUN', v)
      expect(readbackCap(), `value=${JSON.stringify(v)}`).toBe(400)
    }
  })
})

/* ── 5. one failure does not end the sweep ────────────────────────────────── */

describe('5. one product failing does not stop the rest', () => {
  it('counts the error and carries on', async () => {
    listings.push({ productId: 'bad', marketplace: 'IT' }, { productId: 'good', marketplace: 'IT' })
    const s = await readbackAllAmazonLiveImages()
    expect(s.errored).toBe(1)
    expect(s.refreshed).toBe(1)
    expect(s.scanned).toBe(2)
  })
})

/* ── the registry entry ───────────────────────────────────────────────────── */

describe('the cron reports numbers, not a word', () => {
  const registry = readFileSync(join(SRC, 'jobs', 'cron-registry.ts'), 'utf8')

  it('is registered', () => {
    expect(registry).toContain("'image-readback-sweep'")
  })

  it('prints unconfigured beside empty, so a blind run cannot read as a clean one', () => {
    const entry = registry.slice(registry.indexOf("'image-readback-sweep'"), registry.indexOf("'image-readback-sweep'") + 900)
    for (const field of ['eligible', 'scanned', 'refreshed', 'empty', 'skipped', 'unconfigured', 'errored']) {
      expect(entry, `the cron line must report ${field}`).toContain(`${field} $`)
    }
    expect(entry).toContain('CAPPED')
  })

  it('says plainly when it is off', () => {
    const entry = registry.slice(registry.indexOf("'image-readback-sweep'"), registry.indexOf("'image-readback-sweep'") + 900)
    expect(entry).toContain('NEXUS_ENABLE_IMAGE_READBACK_SWEEP=true')
  })
})
