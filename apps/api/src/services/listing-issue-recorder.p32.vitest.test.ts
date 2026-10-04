/**
 * P3.2 — a rejected change shows on its listing, in the channel's words.
 *
 * The plan row's done-when, on a real PostgreSQL with the generated schema and the real
 * profile policies. The Amazon fixture is **REAL**: the per-SKU results below are copied
 * verbatim from `AmazonFlatFileFeedJob.perSkuResults` in the development database — the
 * five 90220 rejections Amazon returned for GALE-JACKET-BLACK-MEN-XXS-REAL and the three
 * 99022 variants it returned for the bottoms, in Amazon's own Italian.
 *
 * That matters. P2.2's order fixture was written by hand, put the fields where the
 * broken parser read them, and stayed green about behaviour production never had. Here
 * the fixture is the payload.
 *
 * The eBay and Shopify fixtures are **SHAPE** — neither channel has a stored rejection
 * against a listing, so their envelopes come from the vendors' documented forms.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { PerSkuResult } from './feed-report-types.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const LEGACY = 'nexus_legacy_workspace'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inLegacy = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY, actorUserId: null, membershipId: null, roleKeys: [] }, work)

/** REAL — verbatim from the stored feed job for this SKU. */
const REAL_JACKET: PerSkuResult = {
  sku: 'GALE-JACKET-BLACK-MEN-XXS-REAL',
  status: 'error',
  issues: [
    { code: '90220', severity: 'error', message: '“outer” è obbligatorio ma mancante.', attributeNames: [] },
    { code: '90220', severity: 'error', message: '“externally_assigned_product_identifier” è obbligatorio ma mancante.', attributeNames: [] },
    { code: '90220', severity: 'error', message: '“merchant_suggested_asin” è obbligatorio ma mancante.', attributeNames: [] },
    { code: '90220', severity: 'error', message: '“inner” è obbligatorio ma mancante.', attributeNames: [] },
    { code: '90220', severity: 'error', message: '“closure” è obbligatorio ma mancante.', attributeNames: [] },
  ],
}

/** REAL — the three 99022 variants, which differ only in the field inside bottoms_size. */
const REAL_BOTTOMS: PerSkuResult = {
  sku: 'AIREON-PANT-CREMA-E-VINO-MEN-4XL',
  status: 'error',
  issues: [
    { code: '99022', severity: 'error', attributeNames: [], message: 'In base ai dati in “[bottoms_size#?.size_system, bottoms_size#?.size_class]”, il campo “"size"” per l’attributo “bottoms_size” non contiene abbastanza valori. Sono richiesti almeno “1” valori. Fornisci un valore valido.' },
    { code: '99022', severity: 'error', attributeNames: [], message: 'In base ai dati in “[bottoms_size#?.size_system, age_range_description.value, bottoms_size#?.size_class]”, il campo “"height_type"” per l’attributo “bottoms_size” non contiene abbastanza valori. Sono richiesti almeno “1” valori. Fornisci un valore valido.' },
    { code: '99022', severity: 'error', attributeNames: [], message: 'In base ai dati in “[bottoms_size#?.size_system, age_range_description.value, bottoms_size#?.size_class]”, il campo “"body_type"” per l’attributo “bottoms_size” non contiene abbastanza valori. Sono richiesti almeno “1” valori. Fornisci un valore valido.' },
  ],
}

/** A SKU Amazon accepted — it must leave no issue behind. */
const REAL_CLEAN: PerSkuResult = { sku: 'CLEAN-SKU-OK', status: 'success', issues: [] }

describe('P3.2 — every channel error lands on its listing', () => {
  let recorder: typeof import('./listing-issue-recorder.service.js')
  const q = (sql: string, params: unknown[] = []) => database.db.query(sql, params)

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    recorder = await import('./listing-issue-recorder.service.js')
    await q(`INSERT INTO "Product" ("workspaceId", id, sku, name, "basePrice", "updatedAt") VALUES
      ($1, 'P-JACKET', 'GALE-JACKET-BLACK-MEN-XXS-REAL', 'Jacket', 10, CURRENT_TIMESTAMP),
      ($1, 'P-BOTTOMS', 'AIREON-PANT-CREMA-E-VINO-MEN-4XL', 'Bottoms', 10, CURRENT_TIMESTAMP),
      ($1, 'P-CLEAN',  'CLEAN-SKU-OK', 'Clean', 10, CURRENT_TIMESTAMP),
      ($1, 'P-EBAY',   'EBAY-SKU-1',   'EbayOne', 10, CURRENT_TIMESTAMP),
      ($1, 'P-SHOP',   'SHOP-SKU-1',   'ShopOne', 10, CURRENT_TIMESTAMP)`, [LEGACY])
    await q(`INSERT INTO "ChannelListing" ("workspaceId", id, "productId", "channelMarket", channel, region, marketplace, "updatedAt") VALUES
      ($1, 'L-JACKET',  'P-JACKET',  'AMAZON_IT', 'AMAZON', 'IT', 'IT', CURRENT_TIMESTAMP),
      ($1, 'L-BOTTOMS', 'P-BOTTOMS', 'AMAZON_IT', 'AMAZON', 'IT', 'IT', CURRENT_TIMESTAMP),
      ($1, 'L-CLEAN',   'P-CLEAN',   'AMAZON_IT', 'AMAZON', 'IT', 'IT', CURRENT_TIMESTAMP),
      ($1, 'L-JACKET-DE','P-JACKET', 'AMAZON_DE', 'AMAZON', 'DE', 'DE', CURRENT_TIMESTAMP),
      ($1, 'L-EBAY',    'P-EBAY',    'EBAY_IT',   'EBAY',   'IT', 'IT', CURRENT_TIMESTAMP),
      ($1, 'L-SHOP',    'P-SHOP',    'SHOPIFY',   'SHOPIFY','GLOBAL', 'GLOBAL', CURRENT_TIMESTAMP)`, [LEGACY])
  }, 120_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  /**
   * Read back through the PRISMA client, not raw SQL.
   *
   * `ListingIssue.occurredAt` is `TIMESTAMP(3)` without a zone. node-pg builds a Date
   * from it as if it were LOCAL time, so on a UTC+2 machine a raw read of a correctly
   * stored 03:00 comes back as 01:00 — a 2-hour lie about a value that is right in the
   * table. Prisma reads the same column as UTC. The app reads through Prisma, so the
   * test does too; `TO_CHAR(... )` below is the independent check that the stored bytes
   * really are what we think.
   */
  const issuesOn = async (listingId: string) =>
    inLegacy(() => (database.client as any).listingIssue.findMany({
      where: { listingId },
      select: { code: true, message: true, attributeNames: true, severity: true, source: true, occurredAt: true, resolvedAt: true },
      orderBy: { fingerprint: 'asc' },
    })) as Promise<Array<{ code: string; message: string; attributeNames: string[]; severity: string; source: string; occurredAt: Date | null; resolvedAt: Date | null }>>

  /** The stored value as text, straight out of PostgreSQL — no client interpretation. */
  const occurredAtText = async (listingId: string) =>
    (await q<{ t: string | null }>(
      `SELECT TO_CHAR("occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS') AS t FROM "ListingIssue" WHERE "listingId" = $1 LIMIT 1`,
      [listingId])).rows[0]?.t ?? null

  describe('Amazon feed report — the 140 real rejections had nowhere to go', () => {
    const completedAt = new Date('2026-09-18T03:00:00.000Z')

    it('places one row per real rejection, all five, not one', async () => {
      const result = await inLegacy(() => recorder.recordFeedReportIssues({
        perSku: [REAL_JACKET, REAL_BOTTOMS, REAL_CLEAN],
        marketplace: 'IT',
        occurredAt: completedAt,
      }))
      expect(result.listings).toBe(2)
      expect(result.unmatchedSkus).toEqual([])

      const jacket = await issuesOn('L-JACKET')
      // The defect this package exists to stop: with no attribute all five share the
      // fingerprint `90220::` and four are lost.
      expect(jacket).toHaveLength(5)
      expect(jacket.map((r) => r.code)).toEqual(['90220', '90220', '90220', '90220', '90220'])
    })

    it('names the attribute Amazon complained about, read from Italian', async () => {
      const jacket = await issuesOn('L-JACKET')
      const attrs = jacket.flatMap((r) => r.attributeNames).sort()
      expect(attrs).toEqual([
        'closure', 'externally_assigned_product_identifier', 'inner',
        'merchant_suggested_asin', 'outer',
      ])
    })

    it('keeps the channel’s own words, verbatim', async () => {
      const jacket = await issuesOn('L-JACKET')
      expect(jacket.map((r) => r.message)).toContain('“closure” è obbligatorio ma mancante.')
    })

    it('records the feed’s completion time as the as-of, not the poll’s', async () => {
      const jacket = await issuesOn('L-JACKET')
      for (const row of jacket) expect(row.occurredAt?.toISOString()).toBe(completedAt.toISOString())
      // The same fact read straight from PostgreSQL as text, so the assertion above
      // cannot be passing on a client's timezone interpretation of a wrong value.
      expect(await occurredAtText('L-JACKET')).toBe('2026-09-18T03:00:00')
    })

    it('keeps the three 99022 variants apart', async () => {
      const bottoms = await issuesOn('L-BOTTOMS')
      expect(bottoms).toHaveLength(3)
      expect(new Set(bottoms.map((r) => r.attributeNames.join(',')))).toHaveProperty('size', 3)
    })

    it('leaves an accepted SKU with nothing on it', async () => {
      expect(await issuesOn('L-CLEAN')).toHaveLength(0)
    })

    it('puts nothing on the same product’s listing in another marketplace', async () => {
      // Self-contained on purpose. Written as a bare assertion it passed even with the
      // marketplace filter removed, because the earlier test had already run and there
      // was nothing on the DE listing either way — a green that proved nothing. The
      // record call is made HERE so the filter is the only thing keeping DE clean.
      await inLegacy(() => recorder.recordFeedReportIssues({
        perSku: [REAL_JACKET], marketplace: 'IT', occurredAt: completedAt,
      }))
      expect(await issuesOn('L-JACKET-DE')).toHaveLength(0)
      expect(await issuesOn('L-JACKET')).toHaveLength(5) // the control: IT did get them
    })

    it('is idempotent — the same report twice does not double the rows', async () => {
      await inLegacy(() => recorder.recordFeedReportIssues({
        perSku: [REAL_JACKET], marketplace: 'IT', occurredAt: completedAt,
      }))
      expect(await issuesOn('L-JACKET')).toHaveLength(5)
    })

    it('MERGES: a later partial feed does not resolve an issue it never mentioned', async () => {
      // A PARTIAL_UPDATE feed carrying only `closure` comes back rejecting only that.
      // The other four are not mentioned — and are not evidence of being fixed.
      await inLegacy(() => recorder.recordFeedReportIssues({
        perSku: [{
          sku: 'GALE-JACKET-BLACK-MEN-XXS-REAL', status: 'error',
          issues: [{ code: '90220', severity: 'error', message: '“closure” è obbligatorio ma mancante.', attributeNames: [] }],
        }],
        marketplace: 'IT', occurredAt: new Date('2026-09-19T03:00:00.000Z'),
      }))
      const jacket = await issuesOn('L-JACKET')
      expect(jacket).toHaveLength(5)
      expect(jacket.filter((r) => r.resolvedAt !== null)).toHaveLength(0)
    })

    it('reports a SKU it could not place rather than dropping it silently', async () => {
      const result = await inLegacy(() => recorder.recordFeedReportIssues({
        perSku: [{ sku: 'SKU-THAT-HAS-NO-LISTING', status: 'error', issues: [{ code: '90220', severity: 'error', message: '“outer” è obbligatorio ma mancante.', attributeNames: [] }] }],
        marketplace: 'IT',
      }))
      expect(result.unmatchedSkus).toEqual(['SKU-THAT-HAS-NO-LISTING'])
      expect(result.listings).toBe(0)
    })
  })

  describe('a gateway verdict — eBay and Shopify (SHAPE fixtures)', () => {
    it('files a non-retryable rejection on the listing, with the channel’s code', async () => {
      const { classifyChannelAnswer } = await import('./gateway/vocabulary.js')
      const verdict = classifyChannelAnswer('EBAY', 400, JSON.stringify({
        errors: [{ errorId: 21916584, message: 'Invalid value for the aspect Brand.', parameters: [{ name: 'aspectName', value: 'Brand' }] }],
      }))
      await inLegacy(() => recorder.recordVerdictOnListing({
        listingId: 'L-EBAY', source: 'ebay-write', verdict,
      }))
      const rows = await issuesOn('L-EBAY')
      expect(rows).toHaveLength(1)
      expect(rows[0].code).toBe('21916584')
      expect(rows[0].message).toContain('Invalid value for the aspect Brand.')
      expect(rows[0].source).toBe('ebay-write')
    })

    it('does NOT file a retryable one — a throttle is our problem, not the listing’s', async () => {
      const { classifyChannelAnswer } = await import('./gateway/vocabulary.js')
      const verdict = classifyChannelAnswer('SHOPIFY', 429, JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }))
      expect(verdict.retryable).toBe(true)
      const result = await inLegacy(() => recorder.recordVerdictOnListing({
        listingId: 'L-SHOP', source: 'shopify-write', verdict,
      }))
      expect(result).toBeNull()
      expect(await issuesOn('L-SHOP')).toHaveLength(0)
    })

    it('files a Shopify userErrors rejection with Shopify’s own field', async () => {
      await inLegacy(() => recorder.recordListingIssues({
        listingId: 'L-SHOP',
        source: 'shopify-write',
        issues: [{ code: 'TOO_LONG', message: 'Title is too long (maximum is 255 characters)', severity: 'ERROR', attributeNames: ['title'], categories: ['userErrors'] }],
      }))
      const rows = await issuesOn('L-SHOP')
      expect(rows).toHaveLength(1)
      expect(rows[0].attributeNames).toEqual(['title'])
      expect(rows[0].code).toBe('TOO_LONG')
    })
  })

  describe('suppression — a replace source, so it resolves', () => {
    it('opens an issue while suppressed and resolves it when the suppression goes', async () => {
      await q(`INSERT INTO "AmazonSuppression" ("workspaceId", id, "listingId", "reasonText", "reasonCode", severity, "updatedAt")
        VALUES ($1, 'S-1', 'L-CLEAN', 'Il campo “main_product_image_locator” è obbligatorio.', 'IMAGE_MISSING', 'ERROR', CURRENT_TIMESTAMP)`, [LEGACY])
      await inLegacy(() => recorder.recordSuppressionIssues({ listingIds: ['L-CLEAN'] }))
      const open = (await issuesOn('L-CLEAN')).filter((r) => r.source === 'amazon-suppression' && r.resolvedAt === null)
      expect(open).toHaveLength(1)
      expect(open[0].attributeNames).toEqual(['main_product_image_locator'])

      // Amazon lifts the suppression; the sweep must CLOSE the issue, not just stop
      // adding. A job that only ever adds turns into a wall of stale red.
      await q(`UPDATE "AmazonSuppression" SET "resolvedAt" = CURRENT_TIMESTAMP WHERE id = 'S-1'`)
      await inLegacy(() => recorder.recordSuppressionIssues({ listingIds: ['L-CLEAN'] }))
      const after = (await issuesOn('L-CLEAN')).filter((r) => r.source === 'amazon-suppression')
      expect(after).toHaveLength(1)
      expect(after[0].resolvedAt).not.toBeNull()
    })
  })

  describe('an Amazon issues notification (SHAPE fixture)', () => {
    it('lands on the listing the SKU + marketplace id name', async () => {
      const result = await inLegacy(() => recorder.recordNotificationIssues({
        sellerSku: 'GALE-JACKET-BLACK-MEN-XXS-REAL',
        marketplaceId: 'APJ6JRA9NG5V4', // IT, through the canonical map
        issues: [{ code: '18028', message: 'The SKU is missing a required attribute.', severity: 'ERROR', attributeNames: ['item_name'] }],
        occurredAt: new Date('2026-09-20T10:00:00.000Z'),
      }))
      expect(result).toEqual({ listings: 1, issues: 1 })
      const rows = (await issuesOn('L-JACKET')).filter((r) => r.source === 'amazon-notification')
      expect(rows).toHaveLength(1)
      expect(rows[0].attributeNames).toEqual(['item_name'])
      expect(rows[0].occurredAt?.toISOString()).toBe('2026-09-20T10:00:00.000Z')
    })

    it('says so rather than guessing when the marketplace id is unknown', async () => {
      const result = await inLegacy(() => recorder.recordNotificationIssues({
        sellerSku: 'GALE-JACKET-BLACK-MEN-XXS-REAL',
        marketplaceId: 'NOT-A-MARKETPLACE',
        issues: [{ code: '1', message: 'x', severity: 'ERROR', attributeNames: [] }],
      }))
      expect(result).toBeNull()
    })
  })
  /**
   * Sheet publish parity, step 2 — a product sheet publication files its Amazon report on the EXACT listings its journal
   * names. The product-SKU join reaches every listing of the product on the marketplace (here: the primary listing and
   * a second alias listing) and never finds an alias's own seller SKU.
   */
  describe('a publication report on the exact listings it journaled', () => {
    const completedAt = new Date('2026-10-02T09:00:00.000Z')
    const outer = { code: '90220', severity: 'error' as const, message: '“outer” è obbligatorio ma mancante.', attributeNames: [] }

    beforeAll(async () => {
      await q(`INSERT INTO "Product" ("workspaceId", id, sku, name, "basePrice", "updatedAt") VALUES
        ($1, 'P-ALIASED', 'ALIASED-PRODUCT-SKU', 'Aliased', 10, CURRENT_TIMESTAMP)`, [LEGACY])
      await q(`INSERT INTO "ChannelListing" ("workspaceId", id, "productId", "channelMarket", channel, region, marketplace, "aliasKey", "updatedAt") VALUES
        ($1, 'L-ALIASED-PRIMARY', 'P-ALIASED', 'AMAZON_IT', 'AMAZON', 'IT', 'IT', '', CURRENT_TIMESTAMP),
        ($1, 'L-ALIASED-SECOND',  'P-ALIASED', 'AMAZON_IT', 'AMAZON', 'IT', 'IT', 'second', CURRENT_TIMESTAMP)`, [LEGACY])
    })

    it('lands only on the listing the journal names, under the alias seller SKU', async () => {
      const result = await inLegacy(() => recorder.recordFeedReportIssues({
        perSku: [{ sku: 'ALIAS-SELLER-SKU', status: 'error', issues: [outer] }], marketplace: 'IT', occurredAt: completedAt,
        listingIdsBySku: new Map([['ALIAS-SELLER-SKU', ['L-ALIASED-SECOND']]]),
      }))
      expect(result).toEqual({ listings: 1, issues: 1, unmatchedSkus: [] })
      expect((await issuesOn('L-ALIASED-SECOND')).map((r) => r.attributeNames)).toEqual([['outer']])
      expect(await issuesOn('L-ALIASED-PRIMARY')).toHaveLength(0)
    })

    it('the control: without the journal the alias seller SKU finds no listing, and the product SKU hits both', async () => {
      const alias = await inLegacy(() => recorder.recordFeedReportIssues({
        perSku: [{ sku: 'ALIAS-SELLER-SKU', status: 'error', issues: [outer] }], marketplace: 'IT', occurredAt: completedAt,
      }))
      expect(alias.unmatchedSkus).toEqual(['ALIAS-SELLER-SKU'])
      const product = await inLegacy(() => recorder.recordFeedReportIssues({
        perSku: [{ sku: 'ALIASED-PRODUCT-SKU', status: 'error', issues: [{ ...outer, code: '90221' }] }], marketplace: 'IT', occurredAt: completedAt,
      }))
      expect(product.listings).toBe(2)
    })

    it('reports a SKU the journal does not name instead of guessing', async () => {
      const result = await inLegacy(() => recorder.recordFeedReportIssues({
        perSku: [{ sku: 'NOT-JOURNALED', status: 'error', issues: [outer] }], marketplace: 'IT',
        listingIdsBySku: new Map([['ALIAS-SELLER-SKU', ['L-ALIASED-SECOND']]]),
      }))
      expect(result).toEqual({ listings: 0, issues: 0, unmatchedSkus: ['NOT-JOURNALED'] })
    })

    it('an accepted publication resolves only the issues about attributes it carried', async () => {
      const { resolveCarriedListingIssues, fingerprintIssue } = await import('./listing-issues.service.js')
      await inLegacy(() => recorder.recordListingIssues({ listingId: 'L-ALIASED-SECOND', source: 'amazon-feed', issues: [
        { code: '1', message: 'closure', attributeNames: ['closure'] },
        { code: '2', message: 'closure and inner', attributeNames: ['closure', 'inner'] },
        { code: '3', message: 'about the whole listing', attributeNames: [] },
        { code: '4', message: 'item name, still reported', attributeNames: ['item_name'] },
      ] }))
      // A suppression issue about `closure` belongs to another source and stays open.
      await inLegacy(() => recorder.recordListingIssues({ listingId: 'L-ALIASED-SECOND', source: 'amazon-suppression', issues: [
        { code: '5', message: 'suppressed for closure', attributeNames: ['closure'] }] }))
      const resolved = await inLegacy(() => resolveCarriedListingIssues((database.client as any), 'L-ALIASED-SECOND', 'amazon-feed',
        ['closure', 'item_name'], [fingerprintIssue('4', ['item_name'])]))
      expect(resolved).toBe(1)
      // Only this test's own issues (codes 1–5); earlier tests left their own on this listing.
      const mine = (await issuesOn('L-ALIASED-SECOND')).filter((r) => ['1', '2', '3', '4', '5'].includes(r.code))
      expect(mine.filter((r) => r.resolvedAt === null).map((r) => r.code).sort()).toEqual(['2', '3', '4', '5'])
      expect(mine.filter((r) => r.resolvedAt !== null).map((r) => r.code)).toEqual(['1'])
    })
  })
})
