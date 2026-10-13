/**
 * Google Ads step 1b — what the reads below the campaign keep (store-detail.ts), on a real PostgreSQL with the production
 * schema and every business policy (PGlite), business profiles ON: each step's read state (a failure or a skip keeps
 * when it was last read); structure upserted idempotently, what a full read no longer returns marked removed (per
 * keyword level) unless it returned none while more than 5 were active; a negative list keeps details a read did not
 * get; campaign settings with "not read" as NULL; policy issues resolved when no longer returned and started again
 * when back; recommendations replaced whole; the retention prune moving the grain's range in the same transaction;
 * one business never touches another's rows. Values are made up (public repo).
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

import { mapCampaign, mapCampaignDay, mapGrainDay } from './mappers.js'
import { ensureGoogleAdsCustomer, replaceDailyMetrics, upsertCampaigns } from './store.js'
import {
  activeNegativeListIds, pruneDailyMetrics, readStatesOf, recordReadState, recordReadStates, replaceRecommendations, saveAdGroups, saveAutoApply,
  saveCampaignFlags, saveKeywords, saveNegativeLists, savePolicyIssues,
} from './store-detail.js'
import type { GoogleAdsAdGroupData, GoogleAdsKeywordData, GoogleAdsPolicyIssueData } from './types.js'

const A = 'gads_detail_alpha'
const B = 'gads_detail_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const CID = '1234567890'
const T1 = new Date('2026-10-12T06:25:00Z')
const T2 = new Date('2026-10-13T06:25:00Z')
const T3 = new Date('2026-10-14T06:25:00Z')

const adGroup = (id: string, status = 'ENABLED'): GoogleAdsAdGroupData => ({
  customerId: CID, campaignId: '111', adGroupId: id, name: `Test ad group ${id}`, status, type: 'SEARCH_STANDARD', primaryStatus: null,
  primaryStatusReasons: [], cpcBidMicros: 500_000n, targetCpaMicros: null, targetRoas: null, searchTermMatchingDisabled: false,
})
const keyword = (level: 'AD_GROUP' | 'CAMPAIGN' | 'LIST', id: string, parent = '71'): GoogleAdsKeywordData => ({
  customerId: CID, level, parentKey: `${level === 'AD_GROUP' ? 'ag' : level === 'CAMPAIGN' ? 'c' : 'l'}:${parent}`, criterionId: id,
  campaignId: level === 'LIST' ? null : '111', adGroupId: level === 'AD_GROUP' ? parent : null, sharedSetId: level === 'LIST' ? parent : null,
  negative: level !== 'AD_GROUP', criterionType: 'KEYWORD', text: `test term ${id}`, matchType: 'PHRASE', status: level === 'LIST' ? null : 'ENABLED',
  cpcBidMicros: null, effectiveCpcBidMicros: null, qualityScore: null, systemServingStatus: null, approvalStatus: null, primaryStatus: null,
})
const adIssue = (adId: string, status = 'DISAPPROVED'): GoogleAdsPolicyIssueData => ({
  customerId: CID, kind: 'AD', entityKey: `71~${adId}`, campaignId: '111', adGroupId: '71', adId, adType: 'RESPONSIVE_SEARCH_AD', itemId: null, label: null,
  status, reviewStatus: 'REVIEWED', reasons: ['DESTINATION_NOT_WORKING'],
})
const ACCOUNT = { customerId: CID, currencyCode: 'EUR' }
const termDay = (date: string, term: string) =>
  mapGrainDay('SEARCH_TERM', { campaign: { id: '111' }, campaignSearchTermView: { searchTerm: term }, segments: { date }, metrics: { clicks: '1' } }, ACCOUNT)!

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

describe('Google Ads step 1b store (PGlite, business profiles on)', () => {
  it('read state: a success moves readAt; a failure or a skip records the attempt and keeps when it was last read', async () => {
    await inA(async () => {
      await recordReadState(CID, 'KEYWORDS', { status: 'SUCCESS', at: T1, readAt: new Date('2026-10-12T06:24:00Z'), rows: 3 })
      await recordReadState(CID, 'KEYWORDS', { status: 'FAILED', at: T2, error: 'Google Ads refused the request.' })
      expect((await readStatesOf(CID)).get('KEYWORDS')).toMatchObject({
        workspaceId: A, readAt: new Date('2026-10-12T06:24:00Z'), rows: 3, lastAttemptAt: T2, lastStatus: 'FAILED', lastError: 'Google Ads refused the request.',
      })
      await recordReadStates(CID, ['KEYWORDS', 'RECOMMENDATIONS'], { status: 'SKIPPED_BUDGET', at: T3, error: 'x'.repeat(900) })
      const states = await readStatesOf(CID)
      expect(states.get('KEYWORDS')).toMatchObject({ readAt: new Date('2026-10-12T06:24:00Z'), rows: 3, lastStatus: 'SKIPPED_BUDGET' })
      expect(states.get('KEYWORDS')?.lastError).toHaveLength(500)
      expect(states.get('RECOMMENDATIONS')).toMatchObject({ readAt: null, readFrom: null, lastStatus: 'SKIPPED_BUDGET', lastAttemptAt: T3 })
      await recordReadState(CID, 'KEYWORDS', { status: 'SUCCESS', at: T3, rows: 0 })
      expect((await readStatesOf(CID)).get('KEYWORDS')).toMatchObject({ readAt: T3, rows: 0, lastStatus: 'SUCCESS', lastError: null })
    })
  })

  it('ad groups: upserted idempotently, unseen ones removed and back again; an empty answer with more than 5 active removes nothing', async () => {
    await inA(async () => {
      expect(await saveAdGroups(CID, ['71', '72', '73'].map((id) => adGroup(id)), T1)).toEqual({ upserted: 3, removed: 0, breaker: false })
      expect(await saveAdGroups(CID, ['71', '72', '73'].map((id) => adGroup(id)), T1)).toEqual({ upserted: 3, removed: 0, breaker: false })
      expect(await db().googleAdsAdGroup.count()).toBe(3)
      expect(await saveAdGroups(CID, [adGroup('71'), adGroup('72', 'PAUSED')], T2)).toEqual({ upserted: 2, removed: 1, breaker: false })
      expect(await db().googleAdsAdGroup.findFirstOrThrow({ where: { adGroupId: '73' } })).toMatchObject({ removedAt: T2, lastSeenAt: T1, firstSeenAt: T1 })
      expect(await db().googleAdsAdGroup.findFirstOrThrow({ where: { adGroupId: '72' } })).toMatchObject({ status: 'PAUSED', removedAt: null })
      await saveAdGroups(CID, ['71', '72', '73', '74', '75', '76'].map((id) => adGroup(id)), T3)
      expect(await db().googleAdsAdGroup.findFirstOrThrow({ where: { adGroupId: '73' } })).toMatchObject({ removedAt: null, firstSeenAt: T1 })
      expect(await saveAdGroups(CID, [], new Date('2026-10-15T06:25:00Z'))).toEqual({ upserted: 0, removed: 0, breaker: true })
      expect(await db().googleAdsAdGroup.count({ where: { removedAt: null } })).toBe(6)
    })
  })

  it('keywords: each level is marked on its own (an ad-group read never removes a campaign negative or a list keyword)', async () => {
    await inA(async () => {
      await saveKeywords(CID, 'AD_GROUP', [keyword('AD_GROUP', '91'), keyword('AD_GROUP', '92')], T1)
      await saveKeywords(CID, 'CAMPAIGN', [keyword('CAMPAIGN', '91', '111')], T1)
      // A row of another level handed in by mistake is not this level's.
      expect(await saveKeywords(CID, 'AD_GROUP', [keyword('AD_GROUP', '91'), keyword('LIST', '93', '66')], T2)).toEqual({ upserted: 1, removed: 1, breaker: false })
      const rows = await db().googleAdsKeyword.findMany({ orderBy: [{ level: 'asc' }, { criterionId: 'asc' }] })
      expect(rows.map((r) => [r.level, r.parentKey, r.criterionId, r.negative, r.removedAt])).toEqual([
        ['AD_GROUP', 'ag:71', '91', false, null], ['AD_GROUP', 'ag:71', '92', false, T2], ['CAMPAIGN', 'c:111', '91', true, null],
      ])
    })
  })

  it('negative keyword lists: details a read did not get are kept; attachments as sent; unseen lists and keywords removed', async () => {
    await inA(async () => {
      const list = { customerId: CID, sharedSetId: '66', name: 'Test negatives', status: 'ENABLED', memberCount: 2, campaignIds: ['333', '111', '111'] }
      const saved = await saveNegativeLists(CID, [list, { ...list, sharedSetId: '67', name: 'Test second list', campaignIds: [] }],
        [keyword('LIST', '93', '66'), keyword('LIST', '94', '66')], T1)
      expect(saved).toEqual({ lists: { upserted: 2, removed: 0, breaker: false }, keywords: { upserted: 2, removed: 0, breaker: false } })
      expect(await db().googleAdsNegativeList.findFirstOrThrow({ where: { sharedSetId: '66' } })).toMatchObject({ name: 'Test negatives', memberCount: 2, campaignIds: ['111', '333'] })
      // The next read without the lists' details (the twin queries): names and counts stay, attachments are this read's.
      await saveNegativeLists(CID, [{ ...list, name: null, status: null, memberCount: null, campaignIds: ['111'] }], [keyword('LIST', '93', '66')], T2)
      expect(await db().googleAdsNegativeList.findFirstOrThrow({ where: { sharedSetId: '66' } })).toMatchObject({ name: 'Test negatives', status: 'ENABLED', memberCount: 2, campaignIds: ['111'], removedAt: null })
      expect(await db().googleAdsNegativeList.findFirstOrThrow({ where: { sharedSetId: '67' } })).toMatchObject({ removedAt: T2 })
      expect(await db().googleAdsKeyword.findFirstOrThrow({ where: { level: 'LIST', criterionId: '94' } })).toMatchObject({ removedAt: T2 })
      expect([...await activeNegativeListIds(CID)]).toEqual(['66'])
      // A list first seen without details: no name yet ("" = not read).
      await saveNegativeLists(CID, [{ ...list, sharedSetId: '68', name: null, status: null, memberCount: null, campaignIds: [] }, { ...list, campaignIds: [] }], [], T3)
      expect(await db().googleAdsNegativeList.findFirstOrThrow({ where: { sharedSetId: '68' } })).toMatchObject({ name: '', status: 'UNKNOWN', memberCount: null })
    })
  })

  it('auto-apply: upserted by type; a type no longer returned is removed', async () => {
    await inA(async () => {
      const sub = (type: string, status = 'ENABLED') => ({ customerId: CID, type, status, createdAtGoogle: T1, modifiedAtGoogle: null })
      await saveAutoApply(CID, [sub('KEYWORD'), sub('CAMPAIGN_BUDGET', 'PAUSED')], T1)
      expect(await saveAutoApply(CID, [sub('KEYWORD')], T2)).toEqual({ upserted: 1, removed: 1, breaker: false })
      // None any more: believed (only 1 was active).
      expect(await saveAutoApply(CID, [], T3)).toEqual({ upserted: 0, removed: 1, breaker: false })
      expect(await db().googleAdsAutoApply.count({ where: { removedAt: null } })).toBe(0)
    })
  })

  it('campaign settings: stamped with flagsReadAt, "not read" stored as NULL, a campaign Nexus has no row for is left out', async () => {
    await inA(async () => {
      await upsertCampaigns([mapCampaign({ campaign: { id: '111', name: 'Test search campaign', status: 'ENABLED', advertisingChannelType: 'SEARCH' } }, ACCOUNT)!], T1)
      const flags = {
        campaignId: '111', aiMaxEnabled: true, keywordMatchType: 'BROAD', broadMatchMigratedAt: T1, targetGoogleSearch: true, targetSearchNetwork: false,
        targetContentNetwork: false, targetPartnerSearchNetwork: false, dsaDomain: null,
        assetAutomation: [{ assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' }],
      }
      expect(await saveCampaignFlags(CID, [flags, { ...flags, campaignId: '999' }], T2)).toBe(1)
      expect(await db().googleAdsCampaign.findFirstOrThrow({ where: { campaignId: '111' } })).toMatchObject({
        flagsReadAt: T2, aiMaxEnabled: true, keywordMatchType: 'BROAD', assetAutomation: flags.assetAutomation, targetSearchNetwork: false,
      })
      await saveCampaignFlags(CID, [{ ...flags, assetAutomation: null }], T3)
      expect(await db().googleAdsCampaign.findFirstOrThrow({ where: { campaignId: '111' } })).toMatchObject({ flagsReadAt: T3, assetAutomation: null })
      // A later campaign read (step 1a) keeps the settings.
      await upsertCampaigns([mapCampaign({ campaign: { id: '111', name: 'Test search campaign', status: 'PAUSED', advertisingChannelType: 'SEARCH' } }, ACCOUNT)!], T3)
      expect(await db().googleAdsCampaign.findFirstOrThrow({ where: { campaignId: '111' } })).toMatchObject({ status: 'PAUSED', aiMaxEnabled: true, flagsReadAt: T3 })
    })
  })

  it('policy issues: resolved when no longer returned; back again or another status starts again; an empty answer with more than 5 open resolves nothing', async () => {
    await inA(async () => {
      expect(await savePolicyIssues(CID, 'AD', [adIssue('81'), adIssue('82', 'APPROVED_LIMITED')], T1, 40)).toEqual({ open: 2, resolved: 0, breaker: false })
      expect(await savePolicyIssues(CID, 'AD', [adIssue('81')], T2, 40)).toEqual({ open: 1, resolved: 1, breaker: false })
      expect(await db().googleAdsPolicyIssue.findFirstOrThrow({ where: { adId: '82' } })).toMatchObject({ resolvedAt: T2, firstSeenAt: T1 })
      expect(await db().googleAdsPolicyIssue.findFirstOrThrow({ where: { adId: '81' } })).toMatchObject({ resolvedAt: null, firstSeenAt: T1, lastSeenAt: T2 })
      // 82 is back, 81 changed from disapproved to limited: both start again.
      await savePolicyIssues(CID, 'AD', [adIssue('81', 'APPROVED_LIMITED'), adIssue('82', 'APPROVED_LIMITED')], T3, 40)
      expect(await db().googleAdsPolicyIssue.findMany({ where: { kind: 'AD' }, orderBy: { adId: 'asc' }, select: { adId: true, status: true, firstSeenAt: true, resolvedAt: true } }))
        .toEqual([{ adId: '81', status: 'APPROVED_LIMITED', firstSeenAt: T3, resolvedAt: null }, { adId: '82', status: 'APPROVED_LIMITED', firstSeenAt: T3, resolvedAt: null }])
      // A product issue is another kind: an ad read never resolves it.
      const product = { ...adIssue('x'), kind: 'PRODUCT' as const, entityKey: '555~ONLINE~it~IT~test-sku-1', adId: null, adType: null, itemId: 'test-sku-1', label: 'Test helmet',
        status: 'NOT_ELIGIBLE', reviewStatus: null, reasons: [], issues: [{ errorCode: 'missing_gtin', affectedRegions: ['IT'] }] }
      await savePolicyIssues(CID, 'PRODUCT', [product], T3, 3)
      const later = new Date('2026-10-15T06:25:00Z')
      await savePolicyIssues(CID, 'AD', ['83', '84', '85', '86'].map((id) => adIssue(id)), later, 40)
      expect(await db().googleAdsPolicyIssue.count({ where: { kind: 'AD', resolvedAt: null } })).toBe(4)
      expect(await db().googleAdsPolicyIssue.findFirstOrThrow({ where: { kind: 'PRODUCT' } })).toMatchObject({ resolvedAt: null, issues: product.issues })
      await savePolicyIssues(CID, 'AD', ['83', '84', '85', '86', '87', '88'].map((id) => adIssue(id)), later, 40)
      // Google sent no ad at all while 6 issues are open: not believed.
      expect(await savePolicyIssues(CID, 'AD', [], new Date('2026-10-16T06:25:00Z'), 0)).toEqual({ open: 0, resolved: 0, breaker: true })
      // Ads were returned, all approved now: every issue is resolved.
      expect(await savePolicyIssues(CID, 'AD', [], new Date('2026-10-16T06:25:00Z'), 40)).toEqual({ open: 0, resolved: 6, breaker: false })
    })
  })

  it('recommendations: replaced whole by each read', async () => {
    await inA(async () => {
      const rec = (id: string, dismissed = false) => ({ customerId: CID, resourceName: `customers/${CID}/recommendations/${id}`, type: 'KEYWORD', campaignId: '111', adGroupId: null, dismissed })
      expect(await replaceRecommendations(CID, [rec('r1'), { ...rec('r2', true), impact: { base: { impressions: 10 }, potential: { impressions: 15 } } }, rec('r1')], T1)).toBe(2)
      expect(await replaceRecommendations(CID, [rec('r3')], T2)).toBe(1)
      expect(await db().googleAdsRecommendation.findMany({ select: { resourceName: true, readAt: true, dismissed: true, impact: true } }))
        .toEqual([{ resourceName: `customers/${CID}/recommendations/r3`, readAt: T2, dismissed: false, impact: null }])
    })
  })

  it('retention: older days deleted and the grain\'s range moved in the same transaction; a range all older is emptied; campaign days are not touched', async () => {
    await inA(async () => {
      await ensureGoogleAdsCustomer({ connectionId: 'conn-test', customerId: CID, loginCustomerId: null, descriptiveName: null, currencyCode: 'EUR', timeZone: 'Europe/Rome', testAccount: false })
      await replaceDailyMetrics(CID, 'SEARCH_TERM', { from: '2026-03-01', to: '2026-10-12' }, [termDay('2026-03-05', 'test old'), termDay('2026-10-10', 'test new')], T2)
      await replaceDailyMetrics(CID, 'CAMPAIGN', { from: '2025-01-01', to: '2025-01-31' }, [
        mapCampaignDay({ campaign: { id: '111' }, segments: { date: '2025-01-10' }, metrics: { impressions: '1' } }, ACCOUNT)!,
      ], T2)
      expect(await pruneDailyMetrics(CID, 'SEARCH_TERM', '2026-04-16')).toEqual({ deleted: 1, readFrom: '2026-04-16' })
      expect((await readStatesOf(CID)).get('SEARCH_TERM_DAYS')).toMatchObject({ readFrom: new Date('2026-04-16T00:00:00Z'), readThrough: new Date('2026-10-12T00:00:00Z') })
      expect(await db().googleAdsDailyMetric.findMany({ where: { entityType: 'SEARCH_TERM' }, select: { label: true } })).toEqual([{ label: 'test new' }])
      // Nothing older: nothing moves.
      expect(await pruneDailyMetrics(CID, 'SEARCH_TERM', '2026-04-16')).toEqual({ deleted: 0, readFrom: '2026-04-16' })
      // Every day read is older than what is kept: the range is emptied (the next read is a first read).
      await replaceDailyMetrics(CID, 'PRODUCT', { from: '2024-01-01', to: '2024-02-01' }, [], T2)
      expect(await pruneDailyMetrics(CID, 'PRODUCT', '2025-09-08')).toEqual({ deleted: 0, readFrom: null })
      expect((await readStatesOf(CID)).get('PRODUCT_DAYS')).toMatchObject({ readFrom: null, readThrough: null })
      // Never read: nothing to move.
      expect(await pruneDailyMetrics(CID, 'ASSET_GROUP', '2025-09-08')).toEqual({ deleted: 0, readFrom: null })
      expect(await db().googleAdsDailyMetric.count({ where: { entityType: 'CAMPAIGN' } })).toBe(1)
    })
  })

  it('one business never touches another\'s rows, even for the same Google Ads account', async () => {
    const before = await inA(async () => ({
      groups: await db().googleAdsAdGroup.count({ where: { removedAt: null } }),
      recs: await db().googleAdsRecommendation.count(),
      states: (await readStatesOf(CID)).size,
    }))
    await inB(async () => {
      expect((await readStatesOf(CID)).size).toBe(0)
      expect(await saveAdGroups(CID, [adGroup('71')], T3)).toEqual({ upserted: 1, removed: 0, breaker: false })
      expect(await replaceRecommendations(CID, [], T3)).toBe(0)
      expect(await savePolicyIssues(CID, 'AD', [], T3, 40)).toEqual({ open: 0, resolved: 0, breaker: false })
      expect(await pruneDailyMetrics(CID, 'SEARCH_TERM', '2026-10-12')).toEqual({ deleted: 0, readFrom: null })
      expect(await db().googleAdsAdGroup.findFirstOrThrow()).toMatchObject({ workspaceId: B })
    })
    await inA(async () => {
      expect(await db().googleAdsAdGroup.count({ where: { removedAt: null } })).toBe(before.groups)
      expect(await db().googleAdsRecommendation.count()).toBe(before.recs)
      expect((await readStatesOf(CID)).size).toBe(before.states)
      expect(await db().googleAdsDailyMetric.count({ where: { entityType: 'SEARCH_TERM' } })).toBe(1)
    })
  })
})
