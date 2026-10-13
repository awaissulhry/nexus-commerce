/**
 * Google Ads steps 1a and 1b — what a read keeps (store.ts), on a real PostgreSQL with the production schema and every
 * business policy (PGlite), business profiles ON: idempotent upserts; a campaign a full read no longer returns gets `removedAt`
 * (and loses it when it comes back), unless the read returned none while more than 5 were active; a window of days
 * replaces exactly that window, with the range of days read moving in the same transaction (a failed write moves
 * nothing); a grain below the campaign moves its own read state and sums rows on one key (step 1b); changes are stored
 * once; one business never touches another's rows. Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))

import { mapCampaign, mapCampaignDay, mapChangeEvent } from './mappers.js'
import {
  connectionSyncOf, ensureGoogleAdsCustomer, getGoogleAdsCustomer, markUnseenCampaignsRemoved, mergeReadRange, recordSyncOutcome, replaceDailyMetrics,
  saveCustomerDetails, storeChangeEvents, upsertCampaigns,
} from './store.js'
import type { GoogleAdsDailyMetricData } from './types.js'

const A = 'gads_store_alpha'
const B = 'gads_store_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const CID = '1234567890'
const ACCOUNT = { customerId: CID, currencyCode: 'EUR' }
const TARGET = { connectionId: 'conn-test', customerId: CID, loginCustomerId: null }
const T1 = new Date('2026-10-12T06:25:00Z')
const T2 = new Date('2026-10-13T06:25:00Z')

const campaign = (id: string, status = 'ENABLED') => mapCampaign({ campaign: { id, name: `Test campaign ${id}`, status, advertisingChannelType: 'SEARCH' } }, ACCOUNT)!
const day = (campaignId: string, date: string, impressions: number) =>
  mapCampaignDay({ campaign: { id: campaignId, name: `Test campaign ${campaignId}` }, segments: { date }, metrics: { impressions: String(impressions), costMicros: '1000000' } }, ACCOUNT)!
const storedDays = () => db().googleAdsDailyMetric.findMany({ where: { customerId: CID }, orderBy: [{ date: 'asc' }, { entityId: 'asc' }] })
  .then((rows) => rows.map((r) => `${r.date.toISOString().slice(0, 10)}:${r.entityId}:${r.impressions}`))
const range = async () => {
  const row = await getGoogleAdsCustomer(CID)
  return row?.metricsReadFrom ? `${row.metricsReadFrom.toISOString().slice(0, 10)}..${row.metricsReadThrough!.toISOString().slice(0, 10)}` : null
}

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

describe('mergeReadRange', () => {
  it('extends a touching or overlapping range, replaces it with a newer one across a gap, keeps it for an older one', () => {
    expect(mergeReadRange(null, { from: '2026-10-01', to: '2026-10-12' })).toEqual({ from: '2026-10-01', to: '2026-10-12' })
    expect(mergeReadRange({ from: '2026-09-01', to: '2026-10-11' }, { from: '2026-09-29', to: '2026-10-12' })).toEqual({ from: '2026-09-01', to: '2026-10-12' })
    expect(mergeReadRange({ from: '2026-09-01', to: '2026-09-28' }, { from: '2026-09-29', to: '2026-10-12' })).toEqual({ from: '2026-09-01', to: '2026-10-12' })
    expect(mergeReadRange({ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-09-29', to: '2026-10-12' })).toEqual({ from: '2026-09-29', to: '2026-10-12' })
    expect(mergeReadRange({ from: '2026-09-01', to: '2026-10-12' }, { from: '2026-01-01', to: '2026-01-31' })).toEqual({ from: '2026-09-01', to: '2026-10-12' })
  })
})

describe('Google Ads store (PGlite, business profiles on)', () => {
  it('the account row: created by the choice with an empty read state, then filled by the read, idempotently', async () => {
    await inA(async () => {
      const seed = { connectionId: 'conn-test', customerId: CID, loginCustomerId: null, descriptiveName: 'Test advertiser', currencyCode: null, timeZone: null, testAccount: false }
      const first = await ensureGoogleAdsCustomer(seed)
      const again = await ensureGoogleAdsCustomer(seed)
      expect(again.id).toBe(first.id)
      expect(first).toMatchObject({ workspaceId: A, status: 'UNKNOWN', currencyCode: '', timeZone: '', backfillCompletedAt: null, metricsReadFrom: null })
      await saveCustomerDetails(TARGET, { customerId: CID, descriptiveName: 'Test advertiser', currencyCode: 'EUR', timeZone: 'Europe/Rome', manager: false, testAccount: false, status: 'ENABLED' })
      // A later choice without details keeps what the read found.
      await ensureGoogleAdsCustomer({ ...seed, descriptiveName: null, loginCustomerId: '9876543210' })
      expect(await getGoogleAdsCustomer(CID)).toMatchObject({ currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED', descriptiveName: 'Test advertiser', loginCustomerId: '9876543210' })
      expect(await db().googleAdsCustomer.count()).toBe(1)
    })
  })

  it('campaigns: upserted idempotently; unseen ones get removedAt and lose it when they come back', async () => {
    await inA(async () => {
      expect(await upsertCampaigns([campaign('111'), campaign('222'), campaign('333', 'PAUSED')], T1)).toBe(3)
      expect(await upsertCampaigns([campaign('111'), campaign('222'), campaign('333', 'PAUSED')], T1)).toBe(3)
      expect(await db().googleAdsCampaign.count()).toBe(3)
      expect(await markUnseenCampaignsRemoved(CID, T1, 3)).toEqual({ removed: 0, breaker: false })

      // The next read no longer returns 333: it is marked removed, its last status kept.
      await upsertCampaigns([campaign('111'), campaign('222')], T2)
      expect(await markUnseenCampaignsRemoved(CID, T2, 2)).toEqual({ removed: 1, breaker: false })
      const gone = await db().googleAdsCampaign.findFirstOrThrow({ where: { campaignId: '333' } })
      expect(gone).toMatchObject({ status: 'PAUSED', removedAt: T2, lastSeenAt: T1 })
      expect(gone.firstSeenAt).toEqual(T1)

      // It comes back.
      const T3 = new Date('2026-10-14T06:25:00Z')
      await upsertCampaigns([campaign('111'), campaign('222'), campaign('333', 'ENABLED')], T3)
      expect(await markUnseenCampaignsRemoved(CID, T3, 3)).toEqual({ removed: 0, breaker: false })
      expect(await db().googleAdsCampaign.findFirstOrThrow({ where: { campaignId: '333' } })).toMatchObject({ status: 'ENABLED', removedAt: null, lastSeenAt: T3, firstSeenAt: T1 })
    })
  })

  it('the circuit breaker: an empty answer while more than 5 are active removes nothing; with 5 or fewer it is believed', async () => {
    await inA(async () => {
      const at = new Date('2026-10-15T06:25:00Z')
      await upsertCampaigns(['401', '402', '403'].map((id) => campaign(id)), at)
      // 6 active now (111, 222, 333, 401, 402, 403): an empty read is not believed.
      const later = new Date('2026-10-16T06:25:00Z')
      expect(await markUnseenCampaignsRemoved(CID, later, 0)).toEqual({ removed: 0, breaker: true })
      expect(await db().googleAdsCampaign.count({ where: { removedAt: null } })).toBe(6)
      // A read that returns some marks the rest.
      await upsertCampaigns([campaign('111')], later)
      expect(await markUnseenCampaignsRemoved(CID, later, 1)).toEqual({ removed: 5, breaker: false })
      // One active left: an empty read now is believed.
      const last = new Date('2026-10-17T06:25:00Z')
      expect(await markUnseenCampaignsRemoved(CID, last, 0)).toEqual({ removed: 1, breaker: false })
    })
  })

  it('daily numbers: a window replaces exactly its days, the range of days read moves with it, idempotently', async () => {
    await inA(async () => {
      const first = await replaceDailyMetrics(CID, 'CAMPAIGN', { from: '2026-10-01', to: '2026-10-05' }, [
        day('111', '2026-10-01', 10), day('111', '2026-10-03', 30), day('222', '2026-10-05', 50),
      ], T1)
      expect(first).toEqual({ rows: 3, range: { from: '2026-10-01', to: '2026-10-05' } })
      // The next read covers 10-04 … 10-07: 10-05 restated, 10-04 and 10-06 zero days, 10-01 … 10-03 kept.
      const second = await replaceDailyMetrics(CID, 'CAMPAIGN', { from: '2026-10-04', to: '2026-10-07' }, [
        day('222', '2026-10-05', 55), day('111', '2026-10-07', 70),
        // Outside the window and a repeat: never stored twice, never outside the window.
        day('111', '2026-10-09', 90), day('111', '2026-10-07', 71),
      ], T2)
      expect(second).toEqual({ rows: 2, range: { from: '2026-10-01', to: '2026-10-07' } })
      expect(await storedDays()).toEqual(['2026-10-01:111:10', '2026-10-03:111:30', '2026-10-05:222:55', '2026-10-07:111:71'])
      // Again: the same rows.
      await replaceDailyMetrics(CID, 'CAMPAIGN', { from: '2026-10-04', to: '2026-10-07' }, [day('222', '2026-10-05', 55), day('111', '2026-10-07', 71)], T2)
      expect(await storedDays()).toEqual(['2026-10-01:111:10', '2026-10-03:111:30', '2026-10-05:222:55', '2026-10-07:111:71'])
      expect(await range()).toBe('2026-10-01..2026-10-07')
    })
  })

  it('a write that fails moves nothing: the stored days and the range stay as they were', async () => {
    await inA(async () => {
      const broken = { ...day('111', '2026-10-06', 1), clicks: Number.NaN } as GoogleAdsDailyMetricData
      await expect(replaceDailyMetrics(CID, 'CAMPAIGN', { from: '2026-10-04', to: '2026-10-08' }, [broken], T2)).rejects.toThrow()
      expect(await storedDays()).toEqual(['2026-10-01:111:10', '2026-10-03:111:30', '2026-10-05:222:55', '2026-10-07:111:71'])
      expect(await range()).toBe('2026-10-01..2026-10-07')
    })
  })

  it('a grain below the campaign moves its OWN range of days read (never the account\'s campaign range); its rows on one key are summed', async () => {
    await inA(async () => {
      const campaignRange = await range()
      const keyword = (date: string, impressions: number, conversions: number): GoogleAdsDailyMetricData =>
        ({ ...day('111', date, impressions), entityType: 'KEYWORD', entityId: '71~91', adGroupId: '71', label: 'test helmet', conversions: conversions.toFixed(4) })
      const first = await replaceDailyMetrics(CID, 'KEYWORD', { from: '2026-09-01', to: '2026-09-30' }, [
        keyword('2026-09-10', 5, 1.25), keyword('2026-09-10', 7, 0.5), keyword('2026-09-11', 3, 0),
        // Another grain's row and a campaign row are not this grain's: never stored here.
        { ...keyword('2026-09-12', 9, 0), entityType: 'AD_GROUP' }, day('111', '2026-09-12', 9),
      ], T2)
      expect(first).toEqual({ rows: 2, range: { from: '2026-09-01', to: '2026-09-30' } })
      const stored = await db().googleAdsDailyMetric.findMany({ where: { customerId: CID, entityType: 'KEYWORD' }, orderBy: { date: 'asc' } })
      expect(stored.map((r) => [r.date.toISOString().slice(0, 10), r.impressions, r.costMicros, r.conversions.toString()]))
        .toEqual([['2026-09-10', 12, 2_000_000n, '1.75'], ['2026-09-11', 3, 1_000_000n, '0']])
      // The account's campaign range did not move (the 1a bug: every grain moved it).
      expect(await range()).toBe(campaignRange)
      const state = () => db().googleAdsReadState.findUnique({ where: { google_ads_read_state: { customerId: CID, resource: 'KEYWORD_DAYS' } } })
      expect(await state()).toMatchObject({ workspaceId: A, readFrom: new Date('2026-09-01T00:00:00Z'), readThrough: new Date('2026-09-30T00:00:00Z'), readAt: null })
      await replaceDailyMetrics(CID, 'KEYWORD', { from: '2026-09-25', to: '2026-10-08' }, [], T2)
      expect(await state()).toMatchObject({ readFrom: new Date('2026-09-01T00:00:00Z'), readThrough: new Date('2026-10-08T00:00:00Z') })
      expect(await db().googleAdsReadState.count({ where: { resource: 'AD_GROUP_DAYS' } })).toBe(0)
      expect(await range()).toBe(campaignRange)
      await db().googleAdsDailyMetric.deleteMany({ where: { customerId: CID, entityType: 'KEYWORD' } })
    })
  })

  it('changes: stored once by resource name; the read state records each run', async () => {
    await inA(async () => {
      const change = mapChangeEvent({
        changeEvent: {
          resourceName: `customers/${CID}/changeEvents/1760266800000000~0~0`, changeDateTime: '2026-10-12 13:00:00', changeResourceType: 'CAMPAIGN',
          changeResourceName: `customers/${CID}/campaigns/111`, resourceChangeOperation: 'UPDATE', changedFields: 'status', clientType: 'GOOGLE_ADS_WEB_CLIENT',
          userEmail: 'test.person@example.com', campaign: `customers/${CID}/campaigns/111`,
        },
      }, { customerId: CID, timeZone: 'Europe/Rome' })!
      expect(await storeChangeEvents([change])).toBe(1)
      expect(await storeChangeEvents([change])).toBe(0)
      await recordSyncOutcome(CID, { status: 'SUCCESS', error: null, ops: 4, at: T2, changesSyncedThrough: T2, structureSyncedAt: T2, backfillCompletedAt: T2 })
      await recordSyncOutcome(CID, { status: 'SKIPPED_BUDGET', error: 'No allowance.', ops: 0, at: new Date('2026-10-13T07:00:00Z') })
      // No call was made: not a read. The last read's time stays (it is what "Nexus read this account at …" names).
      expect(await getGoogleAdsCustomer(CID)).toMatchObject({
        lastSyncStatus: 'SKIPPED_BUDGET', lastSyncError: 'No allowance.', lastSyncAt: T2, lastSuccessAt: T2, backfillCompletedAt: T2, changesSyncedThrough: T2, opsUsedLastRun: 0,
      })
      // Refused before anything was sent (no operation spent): not a read either.
      await recordSyncOutcome(CID, { status: 'FAILED', error: 'Nexus paused this account.', ops: 0, at: new Date('2026-10-13T08:00:00Z') })
      expect(await getGoogleAdsCustomer(CID)).toMatchObject({ lastSyncStatus: 'FAILED', lastSyncAt: T2 })
      // A run that called Google is a read, whatever its end.
      const failedAt = new Date('2026-10-13T09:00:00Z')
      await recordSyncOutcome(CID, { status: 'FAILED', error: 'Google did not answer.', ops: 1, at: failedAt })
      expect(await getGoogleAdsCustomer(CID)).toMatchObject({ lastSyncStatus: 'FAILED', lastSyncAt: failedAt, lastSuccessAt: T2 })
    })
  })

  it('the Google sign-in gets the read\'s end as its "Last sync"; a run that never reached Google leaves it', async () => {
    const connection = () => db().channelConnection.findUnique({ where: { id: 'conn-test' }, select: { lastSyncAt: true, lastSyncStatus: true, lastSyncError: true } })
    await database.db.query(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "managedBy", "externalAccountId", "isActive", "authStatus", "updatedAt") VALUES ('conn-test', $1, 'GOOGLE', 'oauth', 'google-sub-test', true, 'connected', now())`, [A])
    await inA(async () => {
      expect(await connection()).toEqual({ lastSyncAt: null, lastSyncStatus: null, lastSyncError: null })
      await recordSyncOutcome(CID, { status: 'SUCCESS', error: null, ops: 4, at: T2 })
      expect(await connection()).toEqual({ lastSyncAt: T2, lastSyncStatus: 'SUCCESS', lastSyncError: null })
      await recordSyncOutcome(CID, { status: 'SKIPPED_BUDGET', error: 'No allowance.', ops: 0, at: new Date('2026-10-13T07:00:00Z') })
      expect(await connection()).toEqual({ lastSyncAt: T2, lastSyncStatus: 'SUCCESS', lastSyncError: null })
      const failedAt = new Date('2026-10-14T06:25:00Z')
      await recordSyncOutcome(CID, { status: 'AUTH_LOST', error: 'Reconnect Google.', ops: 1, at: failedAt })
      expect(await connection()).toEqual({ lastSyncAt: failedAt, lastSyncStatus: 'FAILED', lastSyncError: 'Reconnect Google.' })
    })
  })

  it('connectionSyncOf: the read\'s status in the connection\'s words', () => {
    const at = T1
    expect(connectionSyncOf({ status: 'SUCCESS', error: null, at })).toEqual({ lastSyncAt: at, lastSyncStatus: 'SUCCESS', lastSyncError: null })
    expect(connectionSyncOf({ status: 'PARTIAL', error: 'Some steps failed.', at })).toEqual({ lastSyncAt: at, lastSyncStatus: 'PARTIAL', lastSyncError: 'Some steps failed.' })
    for (const status of ['FAILED', 'AUTH_LOST', 'MANAGER'] as const) expect(connectionSyncOf({ status, error: 'x', at })?.lastSyncStatus).toBe('FAILED')
    expect(connectionSyncOf({ status: 'SKIPPED_BUDGET', error: 'No allowance.', at })).toBeNull()
    expect(connectionSyncOf({ status: 'FAILED', error: 'e'.repeat(900), at })?.lastSyncError).toHaveLength(500)
  })

  it('one business never touches another\'s rows, even for the same Google Ads account', async () => {
    await inB(async () => {
      expect(await getGoogleAdsCustomer(CID)).toBeNull()
      expect(await db().googleAdsDailyMetric.count()).toBe(0)
      await ensureGoogleAdsCustomer({ connectionId: 'conn-b', customerId: CID, loginCustomerId: null, descriptiveName: null, currencyCode: 'EUR', timeZone: 'Europe/Rome', testAccount: false })
      // B's read of the same window deletes nothing of A's.
      await replaceDailyMetrics(CID, 'CAMPAIGN', { from: '2026-10-01', to: '2026-10-07' }, [day('111', '2026-10-02', 5)], T2)
      expect(await storedDays()).toEqual(['2026-10-02:111:5'])
      // B marks its own campaigns only.
      await upsertCampaigns([campaign('111')], T2)
      expect(await markUnseenCampaignsRemoved(CID, new Date('2026-10-20T00:00:00Z'), 0)).toEqual({ removed: 1, breaker: false })
      expect(await range()).toBe('2026-10-01..2026-10-07')
    })
    await inA(async () => {
      expect(await storedDays()).toEqual(['2026-10-01:111:10', '2026-10-03:111:30', '2026-10-05:222:55', '2026-10-07:111:71'])
      // A's last mark (2026-10-17) stands; B's mark (2026-10-20) never reached it.
      expect(await db().googleAdsCampaign.findFirstOrThrow({ where: { campaignId: '111' } })).toMatchObject({ workspaceId: A, removedAt: new Date('2026-10-17T06:25:00Z') })
      expect(await db().googleAdsCustomer.count()).toBe(1)
    })
  })
})
