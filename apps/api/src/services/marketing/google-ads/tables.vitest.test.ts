/**
 * Google Ads step 1a — the five tables (GoogleAccountLink, GoogleAdsCustomer, GoogleAdsCampaign, GoogleAdsDailyMetric,
 * GoogleAdsChangeEvent) on a real PostgreSQL with the production schema and every business policy (PGlite), business
 * profiles ON: the business comes from the context, each named key finds the business's own row, one business never
 * sees or writes another's rows (Prisma AND raw SQL), the mappers' data is accepted as is, and a link goes with its
 * Google connection. Values are made up (public repo).
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
const TABLES = ['GoogleAccountLink', 'GoogleAdsCampaign', 'GoogleAdsChangeEvent', 'GoogleAdsCustomer', 'GoogleAdsDailyMetric']
const ACCOUNT = { customerId: '1234567890', currencyCode: 'EUR' }
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
  })

  it('all five force row-level security and carry the business policy and the reference guard', async () => {
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
