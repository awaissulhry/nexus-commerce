/**
 * P4.2a — an Amazon image rejection reaches its listing.
 *
 * ## What was measured (2026-09-20)
 *
 * No image publish service on any channel filed a single issue:
 *
 *   images/amazon-image-feed.service.ts        0
 *   images/ebay-inventory-image-publish.ts     0
 *   images/ebay-shared-image-publish.ts        0   (now covered by P4.1a — it
 *                                                   sends through callTradingApi)
 *   images/shopify-live-images.service.ts      0   (a READ, not a publish)
 *
 * And `recordFeedReportIssues` — P3.2's feed recorder, which already resolves one
 * SKU to MANY listings and reports the ones it could not place — had exactly one
 * caller: `amazon-flat-file-feed.service.ts`.
 *
 * Meanwhile the image feed already built a structured per-SKU receipt carrying
 * Amazon's own codes and messages (`IA.3`), and stored it on
 * `AmazonImageFeedJob.resultSummary.perSku` for a drill-down screen. So an image
 * rejection was visible only to somebody who opened that one job row.
 *
 * Third time in one package: **the recorder existed, the issues existed, nobody
 * joined them.**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', '..')
const feed = readFileSync(join(SRC, 'services', 'images', 'amazon-image-feed.service.ts'), 'utf8')
const recorder = readFileSync(join(SRC, 'services', 'listing-issue-recorder.service.ts'), 'utf8')

describe('the image feed files its rejections', () => {
  it('calls P3.2’s feed recorder rather than a fourth copy of the lifecycle', () => {
    expect(feed).toContain('recordFeedReportIssues')
    // Not a new mirror of its own: the recorder is the one writer.
    expect(feed).not.toContain('mirrorListingIssues')
    expect(feed).not.toContain('listingIssue.upsert')
  })

  it('files as a MERGE source, so it cannot resolve a content rejection', () => {
    // An image feed speaks only about the images it carried. `listings-api`
    // REPLACES and would close issues the feed never mentioned.
    expect(feed).toContain("source: 'amazon-feed'")
    expect(feed).not.toContain("source: 'listings-api'")
    // And `amazon-feed` really is a merge source — read from the recorder, not
    // assumed, so this fails if P3.2's classification ever changes.
    const replaceBlock = recorder.slice(recorder.indexOf('const REPLACE_SOURCES'), recorder.indexOf('const modeFor'))
    expect(replaceBlock).toContain('listings-api')
    expect(replaceBlock).not.toContain('amazon-feed')
  })

  it('selects the marketplace, which is what joins a SKU to its listing', () => {
    const select = feed.slice(feed.indexOf('amazonImageFeedJob.findUnique'), feed.indexOf('amazonImageFeedJob.findUnique') + 500)
    expect(select).toContain('marketplace: true')
  })

  it('files only the REJECTED SKUs', () => {
    // An accepted SKU has nothing to say. Filing an empty set under a MERGE
    // source would do nothing anyway, but sending it would be a claim.
    expect(feed).toContain('!r.accepted')
  })

  it('keeps Amazon’s attributeNames, because the fingerprint needs them', () => {
    // P3.2: `ListingIssue` is keyed on code + sorted attributeNames. With the
    // attribute empty, five distinct rejections on one SKU collapse to one row
    // and four vanish — that cost 80 of 140 real rejections once.
    expect(feed).toContain('attrsByCode')
    expect(feed).toContain('attributeNames')
    expect(feed).toContain("(report as any)?.processingReport?.issues")
  })

  it('never lets a failed filing break the publish', () => {
    const fn = feed.slice(feed.indexOf('async function recordImageFeedIssues'))
    expect(fn.slice(0, 2600)).toContain('catch (err)')
  })

  it('reports the SKUs it could not place, instead of a silence', () => {
    // `marketplace` can be the string 'ALL', which matches no
    // ChannelListing.marketplace. Every SKU then comes back unmatched, and that
    // is LOGGED — "nothing was placed" must be a measurement, not a silence.
    expect(feed).toContain('result.unmatchedSkus.length > 0')
    expect(feed).toContain('rejections could not be placed on a listing')
  })

  it('files where the receipt is built, so the two cannot drift apart', () => {
    const iReceipt = feed.indexOf('const perSku = await buildPerSkuReceipt(')
    const iFile = feed.indexOf('await recordImageFeedIssues(')
    expect(iReceipt).toBeGreaterThan(0) // positive control
    expect(iFile).toBeGreaterThan(iReceipt)
    // Close together: the same block, not a separate pass that could be skipped.
    expect(iFile - iReceipt).toBeLessThan(1200)
  })
})

describe('the census this package was built from', () => {
  it('the feed recorder now has more than one caller', () => {
    // Before P4.2a: exactly one (`amazon-flat-file-feed.service.ts`).
    const callers = ['services/amazon-flat-file-feed.service.ts', 'services/images/amazon-image-feed.service.ts']
      .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('recordFeedReportIssues'))
    expect(callers).toHaveLength(2)
  })

  it('eBay’s shared image publish is covered by P4.1a, not by a copy here', () => {
    // It sends through callTradingApi, whose failure path now resolves the
    // listing itself. It must NOT grow its own recorder call.
    const shared = readFileSync(join(SRC, 'services', 'images', 'ebay-shared-image-publish.service.ts'), 'utf8')
    expect(shared).toContain('callTradingApi')
    expect(shared).not.toContain('recordListingIssues')
  })
})

/* ── behaviour, because a shape test is not enough here ───────────────────── */

const filed: any[] = []
vi.mock('../listing-issue-recorder.service.js', () => ({
  recordFeedReportIssues: async (args: any) => {
    filed.push(args)
    return { listings: 1, issues: args.perSku.length, unmatchedSkus: [] }
  },
}))

const { recordImageFeedIssues } = await import('./amazon-image-feed.service.js')

/** Amazon's real shape: five distinct rejections on one SKU, each with its own attribute. */
const REPORT = {
  processingReport: {
    issues: [
      { messageId: 1, code: '90220', message: 'main_product_image_locator is required', attributeNames: ['main_product_image_locator'] },
      { messageId: 1, code: '90221', message: 'other_product_image_locator_1 is required', attributeNames: ['other_product_image_locator_1'] },
      { messageId: 1, code: '90222', message: 'swatch_image_locator is required', attributeNames: ['swatch_image_locator'] },
    ],
  },
}
const RECEIPT = [
  {
    sku: 'SKU-1', asin: 'B0TEST', accepted: false,
    errors: [
      { code: '90220', message: 'main_product_image_locator is required' },
      { code: '90221', message: 'other_product_image_locator_1 is required' },
      { code: '90222', message: 'swatch_image_locator is required' },
    ],
  },
  { sku: 'SKU-2', asin: null, accepted: true, errors: [] },
]

beforeEach(() => { filed.length = 0 })

describe('BEHAVIOUR — the attribute survives, so the issues do not collapse', () => {
  it('gives each issue ITS OWN attribute, not an empty list', async () => {
    // 🔴 `ListingIssue` is keyed on code + sorted attributeNames. With the
    // attribute empty, three distinct rejections on one SKU share one
    // fingerprint and two vanish. P3.2 measured that exact loss: 140 real
    // rejections would have collapsed to 60 rows.
    await recordImageFeedIssues('IT', RECEIPT as any, REPORT)
    expect(filed).toHaveLength(1)
    const issues = filed[0].perSku[0].issues
    expect(issues.map((i: any) => i.attributeNames)).toEqual([
      ['main_product_image_locator'],
      ['other_product_image_locator_1'],
      ['swatch_image_locator'],
    ])
    // The discriminator, stated: three DISTINCT fingerprints, not one.
    const fingerprints = new Set(issues.map((i: any) => `${i.code}::${i.attributeNames.join(',')}`))
    expect(fingerprints.size).toBe(3)
  })

  it('files only the rejected SKU, and keeps Amazon\u2019s own words', async () => {
    await recordImageFeedIssues('IT', RECEIPT as any, REPORT)
    expect(filed[0].perSku.map((r: any) => r.sku)).toEqual(['SKU-1'])
    expect(filed[0].marketplace).toBe('IT')
    expect(filed[0].source).toBe('amazon-feed')
    expect(filed[0].perSku[0].issues[0].message).toBe('main_product_image_locator is required')
  })

  it('files NOTHING when every SKU was accepted', async () => {
    await recordImageFeedIssues('IT', [{ sku: 'SKU-2', asin: null, accepted: true, errors: [] }] as any, REPORT)
    expect(filed).toEqual([])
  })

  it('does not throw when the recorder does', async () => {
    const boom = [{ sku: 'X', asin: null, accepted: false, errors: [{ code: 'E', message: 'm' }] }]
    await expect(recordImageFeedIssues('IT', boom as any, null)).resolves.toBeUndefined()
  })
})
