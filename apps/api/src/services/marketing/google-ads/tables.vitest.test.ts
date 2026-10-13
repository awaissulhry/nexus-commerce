/**
 * Google Ads — the step 1a tables (GoogleAccountLink, GoogleAdsCustomer, GoogleAdsCampaign, GoogleAdsDailyMetric,
 * GoogleAdsChangeEvent) and the step 1b tables (GoogleAdsReadState, GoogleAdsAdGroup, GoogleAdsAssetGroup,
 * GoogleAdsKeyword, GoogleAdsNegativeList, GoogleAdsPolicyIssue, GoogleAdsRecommendation, GoogleAdsAutoApply, and the
 * new GoogleAdsCampaign settings columns) on a real PostgreSQL with the production schema and every business policy
 * (PGlite), business profiles ON: the business comes from the context, each named key finds the business's own row,
 * one business never sees or writes another's rows (Prisma AND raw SQL), the mappers' data is accepted as is, and a
 * link goes with its Google connection. Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'
import { mapCampaign, mapCampaignDay, mapChangeEvent } from './mappers.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
const A = 'gads_tables_alpha'
const B = 'gads_tables_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const TABLES_1B = ['GoogleAdsAdGroup', 'GoogleAdsAssetGroup', 'GoogleAdsAutoApply', 'GoogleAdsKeyword', 'GoogleAdsNegativeList',
  'GoogleAdsPolicyIssue', 'GoogleAdsReadState', 'GoogleAdsRecommendation']
const MODELS_1B = ['googleAdsAdGroup', 'googleAdsAssetGroup', 'googleAdsAutoApply', 'googleAdsKeyword', 'googleAdsNegativeList',
  'googleAdsPolicyIssue', 'googleAdsReadState', 'googleAdsRecommendation'] as const
const TABLES = ['GoogleAccountLink', 'GoogleAdsCampaign', 'GoogleAdsChangeEvent', 'GoogleAdsCustomer', 'GoogleAdsDailyMetric', ...TABLES_1B].sort()
const ACCOUNT = { customerId: '1234567890', currencyCode: 'EUR' }
const countOf = (model: (typeof MODELS_1B)[number]) => (db()[model] as unknown as { count(): Promise<number> }).count()
const NOW = new Date('2026-10-13T06:25:00Z')

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(
      `INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`,
      [id],
    )
  }
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('Google Ads step 1a tables', () => {
  it('the account link: one per product per business, and it goes with its Google connection', async () => {
    const connection = await inA(() => db().channelConnection.create({ data: { channelType: 'GOOGLE', isActive: true, externalAccountId: 'test-google-login-a' } }))
    const link = await inA(() => db().googleAccountLink.create({
      data: { connectionId: connection.id, product: 'ADS', externalId: '1234567890', loginCustomerId: '9876543210', label: 'Test advertiser', selectedByUserId: 'user:test' },
    }))
    expect(link.workspaceId).toBe(A)
    await expect(inA(() => db().googleAccountLink.create({
      data: { connectionId: connection.id, product: 'ADS', externalId: '1112223334', label: 'Another', selectedByUserId: 'user:test' },
    }))).rejects.toMatchObject({ code: 'P2002' })
    expect(await inA(() => db().googleAccountLink.findUnique({ where: { google_link_product: { product: 'ADS' } } }))).toMatchObject({ id: link.id })
    // Another business can neither see the link nor point a link at A's connection.
    await inB(async () => {
      expect(await db().googleAccountLink.findUnique({ where: { google_link_product: { product: 'ADS' } } })).toBeNull()
      expect(await db().$queryRaw`SELECT id FROM "GoogleAccountLink"`).toEqual([])
      await expect(db().googleAccountLink.create({
        data: { connectionId: connection.id, product: 'ADS', externalId: '1234567890', label: 'Wrong business', selectedByUserId: 'user:test' },
      })).rejects.toThrow()
    })
    await inA(() => db().channelConnection.delete({ where: { id: connection.id } }))
    expect(await inA(() => db().googleAccountLink.count())).toBe(0)
  })

  it('the account, a campaign, a day of numbers and a change, written from the mappers\' data', async () => {
    await inA(() => db().googleAdsCustomer.create({
      data: { connectionId: 'conn-test', customerId: '1234567890', currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED',
        metricsReadFrom: new Date('2025-09-08T00:00:00Z'), metricsReadThrough: new Date('2026-10-12T00:00:00Z') },
    }))
    const campaign = mapCampaign({
      campaign: { id: '22222222222', name: 'Test performance max campaign', status: 'PAUSED', advertisingChannelType: 'PERFORMANCE_MAX',
        maximizeConversionValue: { targetRoas: 4.5 }, startDateTime: '2026-03-01 00:00:00', shoppingSetting: { merchantId: '5555555555' } },
      campaignBudget: { id: '23333333333', amountMicros: '40000000', explicitlyShared: true },
    }, ACCOUNT)
    await inA(() => db().googleAdsCampaign.create({ data: { ...campaign, lastSeenAt: NOW } }))
    const day = mapCampaignDay({
      campaign: { id: '22222222222', name: 'Test performance max campaign' }, segments: { date: '2026-10-12' },
      metrics: { impressions: '310', clicks: '9', costMicros: '7250000', conversions: 1.5, conversionsValue: 12.34 },
    }, ACCOUNT)
    await inA(() => db().googleAdsDailyMetric.createMany({ data: [{ ...day, pulledAt: NOW }] }))
    const change = mapChangeEvent({
      changeEvent: { resourceName: 'customers/1234567890/changeEvents/1760266800000000~0~0', changeDateTime: '2026-10-12 13:00:00.123456',
        changeResourceType: 'CAMPAIGN', changeResourceName: 'customers/1234567890/campaigns/22222222222', resourceChangeOperation: 'UPDATE',
        changedFields: 'status', clientType: 'GOOGLE_ADS_WEB_CLIENT', userEmail: 'test.person@example.com', campaign: 'customers/1234567890/campaigns/22222222222',
        newResource: { campaign: { status: 'PAUSED' } } },
    }, { customerId: '1234567890', timeZone: 'Europe/Rome' })
    await inA(() => db().googleAdsChangeEvent.createMany({ data: [change], skipDuplicates: true }))
    // Stored once by its resource name, however often it is read.
    expect((await inA(() => db().googleAdsChangeEvent.createMany({ data: [change], skipDuplicates: true }))).count).toBe(0)

    const stored = await inA(() => db().googleAdsCampaign.findUnique({ where: { google_ads_campaign: { customerId: '1234567890', campaignId: '22222222222' } } }))
    expect(stored).toMatchObject({ workspaceId: A, status: 'PAUSED', budgetAmountMicros: 40_000_000n, budgetShared: true, merchantId: '5555555555' })
    expect(stored?.targetRoas?.toString()).toBe('4.5')
    expect(stored?.startDate?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
    const metric = await inA(() => db().googleAdsDailyMetric.findUnique({
      where: { google_ads_daily_metric: { customerId: '1234567890', entityType: 'CAMPAIGN', entityId: '22222222222', date: new Date('2026-10-12T00:00:00Z') } },
    }))
    expect(metric).toMatchObject({ impressions: 310, clicks: 9, costMicros: 7_250_000n, conversionsValueMicros: 12_340_000n, label: 'Test performance max campaign' })
    expect(metric?.conversions.toString()).toBe('1.5')
    expect(await inA(() => db().googleAdsChangeEvent.findUnique({ where: { google_ads_change_event: { resourceName: change.resourceName } } })))
      .toMatchObject({ changedAt: new Date('2026-10-12T11:00:00.123Z'), changedFields: ['status'], campaignId: '22222222222', oldResource: null })
    expect(await inA(() => db().googleAdsCustomer.findUnique({ where: { google_ads_customer: { customerId: '1234567890' } } })))
      .toMatchObject({ metricsReadThrough: new Date('2026-10-12T00:00:00Z'), manager: false, lastSyncStatus: null })
  })

  it('one business never reads, changes or writes into another\'s Google Ads rows', async () => {
    await inB(async () => {
      for (const model of ['googleAdsCustomer', 'googleAdsCampaign', 'googleAdsDailyMetric', 'googleAdsChangeEvent'] as const) {
        expect(await (db()[model] as unknown as { count(): Promise<number> }).count(), model).toBe(0)
      }
      expect(await db().$queryRaw`SELECT id FROM "GoogleAdsDailyMetric"`).toEqual([])
      expect(await db().$executeRaw`UPDATE "GoogleAdsCampaign" SET name = 'Changed' WHERE "customerId" = '1234567890'`).toBe(0)
      expect(await db().$executeRaw`DELETE FROM "GoogleAdsChangeEvent"`).toBe(0)
      await expect(db().googleAdsCustomer.create({
        data: { workspaceId: A, connectionId: 'conn-test', customerId: '5550001112', currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED' },
      })).rejects.toMatchObject({ code: 'workspace_mismatch' })
      // The same Google account in another business is that business's own row.
      const own = await db().googleAdsCustomer.create({
        data: { connectionId: 'conn-test-b', customerId: '1234567890', currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED' },
      })
      expect(own.workspaceId).toBe(B)
    })
    expect((await inA(() => db().googleAdsCampaign.findFirstOrThrow())).name).toBe('Test performance max campaign')
  })

  it('with business profiles on, a call without a business is refused', async () => {
    await expect(db().googleAdsCampaign.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    await expect(db().googleAccountLink.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    for (const model of MODELS_1B) {
      await expect((db()[model] as unknown as { findMany(): Promise<unknown[]> }).findMany(), model).rejects.toMatchObject({ code: 'workspace_required' })
    }
  })

  it('every Google Ads table forces row-level security and carries the business policy and the reference guard', async () => {
    expect(TABLES).toHaveLength(13)
    const tables = await database.db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY relname`, [TABLES],
    )
    expect(tables.rows).toEqual(TABLES.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })))
    const policies = await database.db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE policyname = 'nexus_workspace_isolation' AND tablename = ANY($1) ORDER BY tablename`, [TABLES],
    )
    expect(policies.rows.map((row) => row.tablename)).toEqual(TABLES)
    const triggers = await database.db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'nexus_workspace_references' AND c.relname = ANY($1) ORDER BY c.relname`, [TABLES],
    )
    expect(triggers.rows.map((row) => row.relname)).toEqual(TABLES)
  })
})

describe('Google Ads step 1b tables', () => {
  const CUSTOMER = '1234567890'
  const CAMPAIGN = '22222222222'
  const AD_GROUP = '33333333333'
  const LIST = '66666666666'

  it('the campaign\'s new settings columns: null until read (never "off"), then stored as Google sent them', async () => {
    const campaign = mapCampaign({
      campaign: { id: '22222222229', name: 'Test search campaign', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
      campaignBudget: { id: '23333333339', amountMicros: '15000000' },
    }, ACCOUNT)
    await inA(() => db().googleAdsCampaign.create({ data: { ...campaign, lastSeenAt: NOW } }))
    const key = { google_ads_campaign: { customerId: CUSTOMER, campaignId: '22222222229' } }
    expect(await inA(() => db().googleAdsCampaign.findUnique({ where: key }))).toMatchObject({
      flagsReadAt: null, aiMaxEnabled: null, keywordMatchType: null, broadMatchMigratedAt: null, targetGoogleSearch: null,
      targetSearchNetwork: null, targetContentNetwork: null, targetPartnerSearchNetwork: null, assetAutomation: null, dsaDomain: null,
    })
    const assetAutomation = [{ assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' }]
    await inA(() => db().googleAdsCampaign.update({
      where: key,
      data: { flagsReadAt: NOW, aiMaxEnabled: true, keywordMatchType: 'BROAD', broadMatchMigratedAt: new Date('2026-10-01T10:00:00Z'),
        targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false,
        assetAutomation, dsaDomain: 'shop.example.com' },
    }))
    expect(await inA(() => db().googleAdsCampaign.findUnique({ where: key }))).toMatchObject({
      flagsReadAt: NOW, aiMaxEnabled: true, keywordMatchType: 'BROAD', broadMatchMigratedAt: new Date('2026-10-01T10:00:00Z'),
      targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false,
      assetAutomation, dsaDomain: 'shop.example.com',
    })
    // Another business can neither read nor change them.
    await inB(async () => {
      expect(await db().googleAdsCampaign.findUnique({ where: key })).toBeNull()
      expect(await db().$executeRaw`UPDATE "GoogleAdsCampaign" SET "aiMaxEnabled" = false WHERE "campaignId" = '22222222229'`).toBe(0)
    })
    expect((await inA(() => db().googleAdsCampaign.findUnique({ where: key })))?.aiMaxEnabled).toBe(true)
  })

  it('each new table takes the sync\'s rows in the business from the context, and its named key finds them', async () => {
    await inA(async () => {
      const state = await db().googleAdsReadState.create({
        data: { customerId: CUSTOMER, resource: 'KEYWORD_DAYS', readFrom: new Date('2026-07-15T00:00:00Z'), readThrough: new Date('2026-10-12T00:00:00Z'),
          readAt: NOW, lastAttemptAt: NOW, lastStatus: 'SUCCESS', rows: 42 },
      })
      expect(state.workspaceId).toBe(A)
      await db().googleAdsReadState.create({ data: { customerId: CUSTOMER, resource: 'AUTO_APPLY', lastAttemptAt: NOW, lastStatus: 'SKIPPED_BUDGET',
        lastError: 'The daily read budget ran out before this step.' } })
      await expect(db().googleAdsReadState.create({ data: { customerId: CUSTOMER, resource: 'KEYWORD_DAYS' } })).rejects.toMatchObject({ code: 'P2002' })
      expect(await db().googleAdsReadState.findUnique({ where: { google_ads_read_state: { customerId: CUSTOMER, resource: 'KEYWORD_DAYS' } } }))
        .toMatchObject({ readFrom: new Date('2026-07-15T00:00:00Z'), readThrough: new Date('2026-10-12T00:00:00Z'), readAt: NOW, rows: 42, lastError: null })
      expect(await db().googleAdsReadState.findUnique({ where: { google_ads_read_state: { customerId: CUSTOMER, resource: 'AUTO_APPLY' } } }))
        .toMatchObject({ readAt: null, readFrom: null, lastStatus: 'SKIPPED_BUDGET' })

      await db().googleAdsAdGroup.create({
        data: { customerId: CUSTOMER, campaignId: CAMPAIGN, adGroupId: AD_GROUP, name: 'Test ad group', status: 'ENABLED', type: 'SEARCH_STANDARD',
          primaryStatus: 'ELIGIBLE', cpcBidMicros: 450_000n, targetRoas: '3.25', searchTermMatchingDisabled: true, lastSeenAt: NOW },
      })
      const adGroup = await db().googleAdsAdGroup.findUnique({ where: { google_ads_ad_group: { customerId: CUSTOMER, adGroupId: AD_GROUP } } })
      expect(adGroup).toMatchObject({ workspaceId: A, campaignId: CAMPAIGN, primaryStatusReasons: [], cpcBidMicros: 450_000n, targetCpaMicros: null,
        searchTermMatchingDisabled: true, removedAt: null })
      expect(adGroup?.targetRoas?.toString()).toBe('3.25')

      await db().googleAdsAssetGroup.create({
        data: { customerId: CUSTOMER, campaignId: CAMPAIGN, assetGroupId: '44444444444', name: 'Test asset group', status: 'ENABLED',
          primaryStatusReasons: ['ASSET_GROUP_UNDER_REVIEW'], adStrength: 'GOOD', finalUrls: ['https://shop.example.com/helmets'], lastSeenAt: NOW },
      })
      expect(await db().googleAdsAssetGroup.findUnique({ where: { google_ads_asset_group: { customerId: CUSTOMER, assetGroupId: '44444444444' } } }))
        .toMatchObject({ primaryStatusReasons: ['ASSET_GROUP_UNDER_REVIEW'], adStrength: 'GOOD', finalUrls: ['https://shop.example.com/helmets'] })

      // One criterion id under three parents is three rows: Google's criterion ids are unique only within their parent.
      await db().googleAdsKeyword.createMany({
        data: [
          { customerId: CUSTOMER, level: 'AD_GROUP', parentKey: `ag:${AD_GROUP}`, criterionId: '555555', campaignId: CAMPAIGN, adGroupId: AD_GROUP,
            negative: false, criterionType: 'KEYWORD', text: 'test helmet', matchType: 'PHRASE', status: 'ENABLED', cpcBidMicros: 600_000n,
            effectiveCpcBidMicros: 600_000n, qualityScore: 7, systemServingStatus: 'ELIGIBLE', approvalStatus: 'APPROVED', primaryStatus: 'ELIGIBLE', lastSeenAt: NOW },
          { customerId: CUSTOMER, level: 'CAMPAIGN', parentKey: `c:${CAMPAIGN}`, criterionId: '555555', campaignId: CAMPAIGN, negative: true,
            criterionType: 'BRAND_LIST', status: 'ENABLED', lastSeenAt: NOW },
          { customerId: CUSTOMER, level: 'LIST', parentKey: `l:${LIST}`, criterionId: '555555', sharedSetId: LIST, negative: true,
            criterionType: 'KEYWORD', text: 'free', matchType: 'BROAD', lastSeenAt: NOW },
        ],
      })
      await expect(db().googleAdsKeyword.create({
        data: { customerId: CUSTOMER, level: 'LIST', parentKey: `l:${LIST}`, criterionId: '555555', negative: true, criterionType: 'KEYWORD', lastSeenAt: NOW },
      })).rejects.toMatchObject({ code: 'P2002' })
      expect(await db().googleAdsKeyword.findUnique({ where: { google_ads_keyword: { customerId: CUSTOMER, parentKey: `ag:${AD_GROUP}`, criterionId: '555555' } } }))
        .toMatchObject({ negative: false, matchType: 'PHRASE', qualityScore: 7, cpcBidMicros: 600_000n, effectiveCpcBidMicros: 600_000n })
      expect(await db().googleAdsKeyword.findUnique({ where: { google_ads_keyword: { customerId: CUSTOMER, parentKey: `l:${LIST}`, criterionId: '555555' } } }))
        .toMatchObject({ level: 'LIST', sharedSetId: LIST, status: null, campaignId: null, text: 'free' })
      expect(await db().googleAdsKeyword.count({ where: { customerId: CUSTOMER, campaignId: CAMPAIGN } })).toBe(2)

      await db().googleAdsNegativeList.create({
        data: { customerId: CUSTOMER, sharedSetId: LIST, name: 'Test negatives', status: 'ENABLED', memberCount: 1, campaignIds: [CAMPAIGN], lastSeenAt: NOW },
      })
      expect(await db().googleAdsNegativeList.findUnique({ where: { google_ads_negative_list: { customerId: CUSTOMER, sharedSetId: LIST } } }))
        .toMatchObject({ memberCount: 1, campaignIds: [CAMPAIGN], removedAt: null })

      const productIssues = [{ errorCode: 'missing_gtin', adsSeverity: 'NOT_ELIGIBLE', attributeName: 'gtin', description: 'Missing value', affectedRegions: ['IT'] }]
      await db().googleAdsPolicyIssue.createMany({
        data: [
          { customerId: CUSTOMER, kind: 'AD', entityKey: `${AD_GROUP}~77777777777`, campaignId: CAMPAIGN, adGroupId: AD_GROUP, adId: '77777777777',
            adType: 'RESPONSIVE_SEARCH_AD', status: 'DISAPPROVED', reviewStatus: 'REVIEWED', reasons: ['DESTINATION_NOT_WORKING'], lastSeenAt: NOW },
          { customerId: CUSTOMER, kind: 'PRODUCT', entityKey: '5555555555~ONLINE~it~IT~test-sku-1', itemId: 'test-sku-1', label: 'Test helmet',
            status: 'NOT_ELIGIBLE', issues: productIssues, lastSeenAt: NOW },
        ],
      })
      expect(await db().googleAdsPolicyIssue.findUnique({ where: { google_ads_policy_issue: { customerId: CUSTOMER, kind: 'AD', entityKey: `${AD_GROUP}~77777777777` } } }))
        .toMatchObject({ adType: 'RESPONSIVE_SEARCH_AD', status: 'DISAPPROVED', reasons: ['DESTINATION_NOT_WORKING'], issues: null, resolvedAt: null })
      expect(await db().googleAdsPolicyIssue.findUnique({ where: { google_ads_policy_issue: { customerId: CUSTOMER, kind: 'PRODUCT', entityKey: '5555555555~ONLINE~it~IT~test-sku-1' } } }))
        .toMatchObject({ itemId: 'test-sku-1', label: 'Test helmet', reasons: [], issues: productIssues })
      expect(await db().googleAdsPolicyIssue.count({ where: { customerId: CUSTOMER, kind: 'PRODUCT', resolvedAt: null } })).toBe(1)

      const impact = { base: { impressions: '100', clicks: '4', costMicros: '2000000' }, potential: { impressions: '180', clicks: '7', costMicros: '3500000' } }
      await db().googleAdsRecommendation.create({
        data: { customerId: CUSTOMER, resourceName: `customers/${CUSTOMER}/recommendations/test-1`, type: 'KEYWORD', campaignId: CAMPAIGN, dismissed: false, impact, readAt: NOW },
      })
      expect(await db().googleAdsRecommendation.findUnique({ where: { google_ads_recommendation: { customerId: CUSTOMER, resourceName: `customers/${CUSTOMER}/recommendations/test-1` } } }))
        .toMatchObject({ type: 'KEYWORD', dismissed: false, impact, adGroupId: null, readAt: NOW })

      await db().googleAdsAutoApply.create({
        data: { customerId: CUSTOMER, type: 'KEYWORD', status: 'ENABLED', createdAtGoogle: new Date('2026-09-01T08:00:00Z'), lastSeenAt: NOW },
      })
      expect(await db().googleAdsAutoApply.findUnique({ where: { google_ads_auto_apply: { customerId: CUSTOMER, type: 'KEYWORD' } } }))
        .toMatchObject({ status: 'ENABLED', createdAtGoogle: new Date('2026-09-01T08:00:00Z'), modifiedAtGoogle: null, removedAt: null })
    })
  })

  it('one business never reads, changes or writes into another\'s step 1b rows (Prisma and raw SQL)', async () => {
    const before = await inA(async () => Promise.all(MODELS_1B.map((model) => countOf(model))))
    expect(before.every((count) => count > 0)).toBe(true)
    await inB(async () => {
      for (const model of MODELS_1B) expect(await countOf(model), model).toBe(0)
      for (const table of TABLES_1B) {
        expect(await db().$queryRawUnsafe(`SELECT id FROM "${table}"`), table).toEqual([])
        expect(await db().$executeRawUnsafe(`UPDATE "${table}" SET "customerId" = '5550001112'`), table).toBe(0)
        expect(await db().$executeRawUnsafe(`DELETE FROM "${table}"`), table).toBe(0)
      }
      expect(await db().googleAdsKeyword.findUnique({ where: { google_ads_keyword: { customerId: CUSTOMER, parentKey: `ag:${AD_GROUP}`, criterionId: '555555' } } })).toBeNull()
      // Prisma refuses a row named for another business; raw SQL is stopped by the policy.
      await expect(db().googleAdsAdGroup.create({
        data: { workspaceId: A, customerId: CUSTOMER, campaignId: CAMPAIGN, adGroupId: '33333333339', name: 'Wrong business', status: 'ENABLED', lastSeenAt: NOW },
      })).rejects.toMatchObject({ code: 'workspace_mismatch' })
      await expect(db().$executeRaw`INSERT INTO "GoogleAdsKeyword" ("workspaceId", id, "customerId", level, "parentKey", "criterionId", negative, "criterionType", "lastSeenAt", "updatedAt")
        VALUES (${A}, 'gads-raw-wrong', ${CUSTOMER}, 'LIST', 'l:1', '1', true, 'KEYWORD', now(), now())`).rejects.toThrow(/row-level security/)
      // The same Google ids in another business are that business's own rows.
      const own = await db().googleAdsAdGroup.create({
        data: { customerId: CUSTOMER, campaignId: CAMPAIGN, adGroupId: AD_GROUP, name: 'Test ad group in another business', status: 'PAUSED', lastSeenAt: NOW },
      })
      expect(own.workspaceId).toBe(B)
      expect(await db().$executeRaw`INSERT INTO "GoogleAdsReadState" (id, "customerId", resource, "updatedAt") VALUES ('gads-raw-own', ${CUSTOMER}, 'KEYWORD_DAYS', now())`).toBe(1)
      expect(await db().googleAdsReadState.findUnique({ where: { google_ads_read_state: { customerId: CUSTOMER, resource: 'KEYWORD_DAYS' } } }))
        .toMatchObject({ id: 'gads-raw-own', workspaceId: B, readAt: null })
    })
    expect(await inA(async () => Promise.all(MODELS_1B.map((model) => countOf(model))))).toEqual(before)
    expect((await inA(() => db().googleAdsAdGroup.findUniqueOrThrow({ where: { google_ads_ad_group: { customerId: CUSTOMER, adGroupId: AD_GROUP } } }))).name).toBe('Test ad group')
  })
})
