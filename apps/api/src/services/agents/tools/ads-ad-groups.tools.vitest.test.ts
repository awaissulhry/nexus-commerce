/**
 * ADS AUTONOMY W4-6 — ad-groups, create-ad-group, add-product-ads and set-ad-group, run for real through the door, the
 * approval gate, the Approvals page's coded approve and a change plan (PGlite, production schema; the job queue a stub;
 * the ads write gate the real one, sandbox: every create gets a sandbox id). Made-up names, ids and amounts.
 *
 * Proven: the read lists a campaign's ad groups with their product ads, counts, floors and money (stripped without the
 * money permission); a new ad group is ONE request — born at the 2-cent floor with every planned bid remembered and a
 * floor of its own held by the person who asked (inside a campaign a person stopped: that campaign's floor), every row
 * created through the screen's own creates with the approval as its change set, undone by archive-ads; startLive and
 * product ads need the approver's authenticator code (a plain approve does not run them; the Approvals page asks for the
 * code; a change plan carries it); the Owner's rule 3 — the same product twice in one campaign refused, another product
 * listed, the same product in another campaign warned and then never by rule by default; only a product Amazon sells in
 * the market; set-ad-group moves a default bid like set-target-bid (stepped, never raising a floored bid), renames, stops
 * with low bids and gives a floor back, each undone through itself; the default limits let nothing that adds spend run
 * alone.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// W4-6 review — a create that stops after Amazon made the ad group: the born-at-the-floor marks throw once asked to.
const breakOn = vi.hoisted(() => ({ markFloor: false }))
vi.mock('../../advertising/ads-bid-suppression.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../advertising/ads-bid-suppression.service.js')>()
  return {
    ...real,
    markAdGroupBornAtFloor: async (...a: Parameters<typeof real.markAdGroupBornAtFloor>) => {
      if (breakOn.markFloor) throw new Error('a test failure after the ad group was made')
      return real.markAdGroupBornAtFloor(...a)
    },
  }
})

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'
import { ruleFrom } from '../claude-trust.service.js'
import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { queuePlan, runPlan } from '../change-plan.service.js'
import { STEP_UP_NEEDS } from '../step-up-approval.js'
import { __stepUpTest } from '../../../lib/auth/step-up.js'
import { generateSecret, generateSync } from 'otplib'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person = (userId: string, via: 'claude' | 'app', permissions: Set<string> = EVERYTHING): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business, permissions: { isOwner: false, permissions },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')

type Row = Record<string, any>
const db = () => database.client
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw as Row
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
/** As the Approvals page records a decision taken with the approver's authenticator code. */
const withCode = (approvalId: string) => inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { decisionVia: 'nexus-step-up' } }))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await db().$queryRawUnsafe(text, ...params)) as T[])
const judge = (tool: string, p: unknown, limits: Record<string, unknown> = {}) => getTool(tool)!.withinLimits!(p, getTool(tool)!.limits!.parse(limits) as Record<string, unknown>)
/**
 * Limit facts that pass every common check of the kit (a market strategy with room today, no engine, nothing protected):
 * what is left to refuse is the tool's own check and the gate as the rule's write.
 */
const insideFacts = (tool: string, action: string, items: number) => ({
  ruleGate: null,
  limitFacts: {
    v: 1, tool, action,
    markets: { IT: { strategy: { version: 'test-v1' }, currency: 'EUR', maxActionsPerRun: null, maxChangesPerDay: 500, maxRaisesPerDay: 500, maxBudgetIncreasePerDayCents: 0, sources: {} } },
    scopes: { 'IT|adGroup:g1': { market: 'IT', label: 'ad group "Test" (IT)', limits: {}, sources: {} } },
    entityScopes: { 'adGroup:g1': 'IT|adGroup:g1' }, labels: { 'adGroup:g1': 'ad group "Test"' },
    this: {
      markets: ['IT'], items, writes: items, raises: items, cuts: 0, largestRaisePct: 0, largestCutPct: 0, largestRaisePoints: 0, largestCutPoints: 0,
      highestNewBidCents: null, budgetIncreaseCents: 0, byMarket: { IT: { changes: items, writes: items, raises: items, budgetIncreaseCents: 0, addedDailyCents: 0 } },
      entities: ['adGroup:g1'], rowsOutsideStrategy: 0, firstOutside: null,
    },
    today: { IT: { changes: 0, writes: 0, raises: 0, budgetIncreaseCents: 0 } }, perEntityToday: { maxChangesByRule: 0, entity: null },
    unplaced: [], engineOwned: [], protectedHit: [],
  },
})
const commitNow = async (approvalId: string) => {
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

/** Real people (a row, a role, a membership, an authenticator) for the Approvals page's coded approve and its commit. */
type RealPerson = { id: string; secret: string; principal: UserPrincipal }
async function realPerson(label: string, permissions: Set<string>): Promise<RealPerson> {
  const client = db()
  const secret = generateSecret()
  const role = await client.role.create({ data: { key: `W46_${randomUUID().slice(0, 8)}`, name: label, description: 'test', isSystem: false, permissions: [...permissions] } })
  const user = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label, twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })
  await client.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: user.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return { id: user.id, secret, principal: person(user.id, 'app', permissions) }
}
const codeOf = (p: RealPerson) => { __stepUpTest.reset(); return generateSync({ secret: p.secret }) }
let owner: RealPerson

/** A product Amazon sells in IT (an ACTIVE listing) unless `listing` says otherwise; its ASIN is made up. */
async function product(sku: string, asin: string, listing: string | null = 'ACTIVE') {
  const p = await db().product.create({ data: { sku, name: `Test ${sku}`, basePrice: '49.00', amazonAsin: asin } })
  if (listing) await db().channelListing.create({ data: { productId: p.id, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', listingStatus: listing } })
  return p
}

/** The listing statuses that sell nothing (identity-fix.tools.ts reads a live Amazon listing as ACTIVE only). */
const LISTING_STATUSES_NOT_SOLD = ['NOT_LISTED', 'ERROR', 'INACTIVE', 'REMOVED', 'FAILED', 'DRAFT', 'ENDED'] as const

/** A Claude request on record that changed this (as the gate records an executed change). */
async function recordChange(toolName: string, after: Row) {
  const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
  const approval = await db().agentApproval.create({ data: { agentRunId: run.id, toolName, riskTier: 'high', args: {}, status: 'executed' } })
  await db().agentChange.create({ data: { approvalId: approval.id, toolName, via: 'claude', reversibility: 'full', before: {}, after } })
}

/** An SP campaign in IT with one ad group (EXT ids: at Amazon), enabled and allowlisted unless said otherwise. */
async function campaign(id: string, extra: Record<string, unknown> = {}) {
  await db().campaign.create({ data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, targetingType: 'MANUAL', ...extra } })
  await db().adGroup.create({ data: { id: `g-${id}`, campaignId: id, name: `group ${id}`, externalAdGroupId: `EXT-g-${id}`, defaultBidCents: 30 } })
}

beforeAll(async () => {
  database = await formulaDatabase()
  owner = await realPerson('Test owner', EVERYTHING)
  await inside(async () => {
    await seedAdsFixture(db())
    await product('TEST-AG-1', 'B0TESTAG01')
    const second = await product('TEST-AG-2', 'B0TESTAG02')
    const third = await product('TEST-AG-3', 'B0TESTAG03')
    await product('TEST-AG-4', 'B0TESTAG04')
    await product('TEST-AG-5', 'B0TESTAG05')
    await product('TEST-AG-6', 'B0TESTAG06')
    await product('TEST-AG-7', 'B0TESTAG07')
    const other = await product('TEST-OTHER-1', 'B0TESTOTH1')
    await product('TEST-UNLISTED-1', 'B0TESTUNL1', null)
    await product('TEST-DRAFT-1', 'B0TESTDRF1', 'DRAFT')
    // c-it advertises another product (allowed: only listed) and TEST-AG-2 (the same product twice: refused).
    await db().adProductAd.create({ data: { adGroupId: 'g-c-it', sku: 'TEST-OTHER-1', asin: 'B0TESTOTH1', productId: other.id, externalAdId: 'EXT-pa-other' } })
    await db().adProductAd.create({ data: { adGroupId: 'g-c-it', sku: 'TEST-AG-2', asin: 'B0TESTAG02', productId: second.id, externalAdId: 'EXT-pa-ag2' } })
    // TEST-AG-3 already runs in another enabled campaign of IT: the same product elsewhere (warned).
    await db().adProductAd.create({ data: { adGroupId: 'g-c-pin', sku: 'TEST-AG-3', asin: 'B0TESTAG03', productId: third.id, externalAdId: 'EXT-pa-ag3' } })
    // An Auto campaign; a campaign a person stopped with low bids; one an engine stopped; one with a 20 % max change.
    await campaign('c-auto', { targetingType: 'AUTO' })
    await campaign('c-person-floor', { bidsSuppressedAt: new Date('2026-10-01T00:00:00Z'), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'user:u-person' })
    await campaign('c-step', { dynamicBidding: { maxBidChangePct: 20 } })
    await campaign('c-edit')
    await db().adGroup.create({ data: { id: 'g-c-edit-2', campaignId: 'c-edit', name: 'second group', externalAdGroupId: 'EXT-g-c-edit-2', defaultBidCents: 30 } })
    await campaign('c-engine-floor')
    await db().adGroup.update({ where: { id: 'g-c-engine-floor' }, data: { bidsSuppressedAt: new Date('2026-10-01T00:00:00Z'), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'automation:budget-manager', suppressedFromBidCents: 30, defaultBidCents: 2 } })
    await campaign('c-stop')
    await db().adTarget.create({ data: { id: 't-c-stop', adGroupId: 'g-c-stop', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'stop me', bidCents: 55, externalTargetId: 'EXT-t-c-stop' } })
    await db().adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'testbrand', matchType: 'CONTAINS', marketplace: 'IT' } as never })
    // A campaign an ads playbook built (a slot, origin built): its structure and floors are the playbook's.
    await campaign('c-playbook')
    const playbook = await db().adsPlaybook.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: 'p-test', label: 'Test playbook (IT)', enrolled: true, updatedBy: 'user:u-person' } as never })
    await db().adsPlaybookLink.create({ data: { playbookId: playbook.id, kind: 'slot', key: 'exact', refId: 'c-playbook', origin: 'built', compiledVersion: 1, updatedBy: 'user:u-person' } })
    // W4-6 review — a listing in every status that sells nothing; two SKUs of one ASIN.
    for (const status of LISTING_STATUSES_NOT_SOLD) await product(`TEST-ST-${status}`, `B0TST${status.slice(0, 5).padEnd(5, 'X')}`, status)
    await product('TEST-TWIN-A', 'B0TESTTWN1')
    await product('TEST-TWIN-B', 'B0TESTTWN1')
    // An ad group a stock lowering floored (its request on record), and one a person floored with no such request.
    const floored = { bidsSuppressedAt: new Date(Date.now() - 60_000), bidsSuppressedFloorCents: 2, suppressedFromBidCents: 30, defaultBidCents: 2 }
    await campaign('c-stock-floor')
    await db().adGroup.update({ where: { id: 'g-c-stock-floor' }, data: { ...floored, bidsSuppressedBy: 'user:u-person' } })
    await recordChange('lower-ad-bids-for-stock', { adGroups: [{ adGroupId: 'g-c-stock-floor', floored: true, by: 'user:u-person' }], steps: [] })
    await campaign('c-other-floor')
    await db().adGroup.update({ where: { id: 'g-c-other-floor' }, data: { ...floored, bidsSuppressedBy: 'user:u-someone' } })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

const group = (extra: Record<string, unknown> = {}) => ({
  campaignId: 'c-it', name: 'Test new group', defaultBidCents: 40, skus: ['TEST-AG-1'],
  keywords: [{ text: 'winter jacket', matchType: 'EXACT', bidCents: 55 }, { text: 'thermal jacket', matchType: 'PHRASE' }],
  negativeKeywords: [{ text: 'cheap', matchType: 'EXACT' }],
  ...extra,
})

describe('the tools as the contract holds them', () => {
  it('create-ad-group and add-product-ads: alwaysAsk, strategy-bound, ceiling auto, undone in part; nothing runs alone by default', () => {
    for (const name of ['create-ad-group', 'add-product-ads']) {
      const tool = getTool(name)!
      expect(tool, name).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'partial', openWorld: true, requires: ['ads.campaigns.manage', 'financials.adspend.view'] })
      expect(ruleFrom(tool, null).level, name).toBe('ask')
      expect(tool.limits!.parse({}), name).toMatchObject({ maxItems: 0, allowSelfCompetition: false })
    }
    expect(getTool('create-ad-group')!.limits!.parse({})).toMatchObject({ maxBidCents: 0, allowStartLive: false, markets: [], campaignIds: [] })
    expect(getTool('set-ad-group')).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'full' })
    expect(getTool('set-ad-group')!.limits!.parse({})).toMatchObject({ maxItems: 1, maxRaisePct: 0, allowRename: false })
    // An op start never runs by rule: no limit lets it.
    expect(getTool('set-ad-group')!.limits!.parse({})).not.toHaveProperty('maxRestoredBidCents')
    expect(getTool('ad-groups')).toMatchObject({ readOnly: true, requires: ['ads.view'] })
  })
})

describe('ad-groups', () => {
  it('a campaign\'s ad groups: product ads, counts, floors and money (stripped for a person without it)', async () => {
    const data = (await preview('ad-groups', { campaignId: 'c-it' })).data
    expect(data.campaign).toMatchObject({ campaignId: 'c-it', market: 'IT', currency: 'EUR', liveWrites: true, floor: null })
    const g = data.items.find((i: Row) => i.adGroupId === 'g-c-it')
    expect(g).toMatchObject({
      name: 'group c-it', status: 'ENABLED', atAmazon: true, defaultBidCents: 50, floor: null,
      targets: { keywords: 3, negatives: 1, heldAtFloor: 1 },
      productAds: expect.arrayContaining([expect.objectContaining({ sku: 'TEST-AG-2', asin: 'B0TESTAG02', atAmazon: true })]),
    })
    const engine = (await preview('ad-groups', { adGroupId: 'g-c-engine-floor' })).data.items[0]
    expect(engine.floor).toMatchObject({ by: 'automation:budget-manager', plannedDefaultBidCents: 30, givenBackBy: 'the engine that set it' })
    const noMoney = await inside(() => callTool(person('u-nomoney', 'claude', new Set(Object.values(FEATURES))), 'ad-groups', { campaignId: 'c-it' }))
    const text = JSON.stringify(noMoney.visible)
    expect(text).not.toMatch(/defaultBidCents|spendCents|plannedDefaultBidCents/)
    expect(text).toContain('group c-it')
    expect((await preview('ad-groups', {})).error).toMatch(/^Name the campaign/)
    expect((await preview('ad-groups', { campaignId: 'nope' })).error).toBe('Campaign not found')
  })
})

describe('create-ad-group — the preview and what refuses it', () => {
  it('born at the floor: every planned bid kept, a floor of its own held by the person who asked; no code', async () => {
    const r = await preview('create-ad-group', group())
    expect(r.ok, r.error).toBe(true)
    const p = r.preview
    expect(p).toMatchObject({
      action: 'create-ad-group',
      campaign: { id: 'c-it', marketplace: 'IT' },
      currency: 'EUR',
      plan: {
        start: 'own', floorCents: 2, defaultBid: { plannedCents: 40, startCents: 2 },
        products: [{ sku: 'TEST-AG-1', asin: 'B0TESTAG01', adSku: 'TEST-AG-1' }],
        keywords: [{ text: 'winter jacket', plannedCents: 55, startCents: 2 }, { text: 'thermal jacket', plannedCents: 40, startCents: 2 }],
        negativeKeywords: [{ text: 'cheap', matchType: 'EXACT' }],
      },
      totals: { productAds: 1, keywords: 2, negatives: 1, rememberedBids: 3 },
      highestPlannedBidCents: 55,
      startsAt: { how: 'its own floor', floorCents: 2 },
      raises: [],
      noCode: expect.stringMatching(/^Born at the floor/),
      liveWrites: true,
      reach: { reach: 'sandbox' },
      limitFacts: { tool: 'create-ad-group', action: 'create', this: { items: 5 } },
      otherProducts: { skus: expect.arrayContaining(['TEST-OTHER-1']) },
      nextSteps: [expect.stringMatching(/^set-ad-group \(op start/)],
    })
    expect(p.stepUp).toBeUndefined()
    expect(p.effect).toMatch(/born with every bid at the 2-cent floor .* until set-ad-group op start gives them back/)
    // By default nothing runs alone: the kit's 0 items, and the highest planned bid above the tool's 0.
    expect(judge('create-ad-group', p)).toMatch(/there is no ads strategy for IT|more than the 0/)
    expect(judge('create-ad-group', { ...p, limitFacts: undefined })).toMatch(/no limit facts/)
  })

  it('refused, and not queued: Auto, archived, not at Amazon, Sponsored Brands, both or no targeting, a taken name, twice', async () => {
    expect((await preview('create-ad-group', group({ campaignId: 'c-auto' }))).error).toMatch(/is an Auto campaign/)
    expect((await preview('create-ad-group', group({ campaignId: 'c-sb' }))).error).toMatch(/not a Sponsored Products campaign/)
    expect((await preview('create-ad-group', group({ campaignId: 'nope' }))).error).toMatch(/^Campaign nope not found/)
    expect((await preview('create-ad-group', group({ productTargets: [{ asin: 'B0TARGET01' }] }))).error).toMatch(/^Give either keywords or productTargets/)
    expect((await preview('create-ad-group', group({ keywords: [] }))).error).toMatch(/^Give either keywords or productTargets/)
    expect((await preview('create-ad-group', group({ name: 'GROUP C-IT' }))).error).toMatch(/already has an ad group named "group c-it"/)
    expect((await preview('create-ad-group', group({ keywords: [{ text: 'a', matchType: 'EXACT' }, { text: 'A', matchType: 'EXACT' }] }))).error).toMatch(/^Listed twice in keywords/)
    expect((await preview('create-ad-group', group({ negativeKeywords: [{ text: 'winter jacket', matchType: 'PHRASE' }] }))).error).toMatch(/Both a keyword and a negative/)
    expect((await preview('create-ad-group', group({ negativeKeywords: [{ text: 'testbrand helmets', matchType: 'PHRASE' }] }))).error).toMatch(/^Not queued: .*protected/i)
    expect((await preview('create-ad-group', group({ defaultBidCents: 2500 }))).error).toMatch(/above campaign "Italy exact"'s daily budget/)
    // A playbook's campaign: its structure and its floors move through the playbook.
    expect((await preview('create-ad-group', group({ campaignId: 'c-playbook' }))).error).toMatch(/was built by an ads playbook, so its ad groups are added through the playbook: .*apply-ads-playbook op sync/)
    expect((await preview('add-product-ads', { adGroupId: 'g-c-playbook', skus: ['TEST-AG-5'] })).error).toMatch(/was built by an ads playbook, so its product ads are added through the playbook/)
    expect((await preview('set-ad-group', { adGroupId: 'g-c-playbook', op: 'stop' })).error).toMatch(/was built by an ads playbook, so its ad groups' bids move through the playbook/)
  })

  it('only what Amazon sells in the market: a SKU not found, not listed there, or only a draft listing is refused', async () => {
    expect((await preview('create-ad-group', group({ skus: ['NO-SUCH-SKU'] }))).error).toBe('SKU not found in this business: NO-SUCH-SKU.')
    expect((await preview('create-ad-group', group({ skus: ['TEST-UNLISTED-1'] }))).error).toMatch(/^Not sold on Amazon IT: TEST-UNLISTED-1/)
    expect((await preview('create-ad-group', group({ skus: ['TEST-DRAFT-1'] }))).error).toMatch(/^Not sold on Amazon IT: TEST-DRAFT-1/)
    // W4-6 review — only an ACTIVE listing sells: every other status is refused, for a new ad group and for product ads.
    for (const status of LISTING_STATUSES_NOT_SOLD) {
      expect((await preview('create-ad-group', group({ skus: [`TEST-ST-${status}`] }))).error, status).toMatch(new RegExp(`^Not sold on Amazon IT: TEST-ST-${status} — no active Amazon listing there`))
      expect((await preview('add-product-ads', { adGroupId: 'g-c-it', skus: [`TEST-ST-${status}`] })).error, status).toMatch(/^Not sold on Amazon IT/)
    }
    // Two SKUs of one ASIN are the same product.
    expect((await preview('create-ad-group', group({ skus: ['TEST-TWIN-A', 'TEST-TWIN-B'] }))).error).toBe('The same product twice: TEST-TWIN-A and TEST-TWIN-B are both ASIN B0TESTTWN1. An ad group advertises a product once: name one of them.')
    expect((await preview('add-product-ads', { adGroupId: 'g-c-it', skus: ['TEST-TWIN-A', 'TEST-TWIN-B'] })).error).toMatch(/^The same product twice/)
  })

  it('the Owner\'s rule 3: the same product twice in a campaign refused; elsewhere warned and then never by rule by default', async () => {
    expect((await preview('create-ad-group', group({ skus: ['TEST-AG-2'] }))).error)
      .toMatch(/^Not queued: the same product twice in one campaign would bid against itself .*TEST-AG-2 is already advertised in ad group "group c-it"/)
    const p = (await preview('create-ad-group', group({ skus: ['TEST-AG-3'] }))).preview
    expect(p.selfCompetition).toMatchObject({ campaigns: [{ campaignId: 'c-pin', asins: ['B0TESTAG03'] }], note: expect.stringMatching(/allowSelfCompetition/) })
    // Past the common checks, the tool's own: the same product elsewhere waits for a person unless the limits allow it.
    const inside5 = { ...p, ...insideFacts('create-ad-group', 'create', 5) }
    expect(judge('create-ad-group', inside5, { maxItems: 10, maxBidCents: 100 })).toMatch(/same product already runs in another enabled campaign .*allowSelfCompetition is off/)
    expect(judge('create-ad-group', inside5, { maxItems: 10, maxBidCents: 100, allowSelfCompetition: true })).toBeNull()
    expect(judge('create-ad-group', inside5, { maxItems: 10, maxBidCents: 50, allowSelfCompetition: true })).toMatch(/highest planned bid EUR 0\.55 is above the EUR 0\.50/)
    expect(judge('create-ad-group', inside5, { maxItems: 10, maxBidCents: 100, allowSelfCompetition: true, markets: ['DE'] })).toMatch(/only in DE/)
    expect(judge('create-ad-group', inside5, { maxItems: 4, maxBidCents: 100, allowSelfCompetition: true })).toMatch(/more than the 4/)
  })

  it('startLive: as planned, in raises, with the approver\'s code; refused inside a stopped campaign', async () => {
    const p = (await preview('create-ad-group', group({ startLive: true, name: 'Test live preview' }))).preview
    expect(p).toMatchObject({
      plan: { start: 'live', defaultBid: { plannedCents: 40, startCents: 40 } },
      raises: [expect.stringMatching(/at their planned bids/)],
      stepUp: { raises: ['Product ads', 'Bids', 'Spend'], needs: STEP_UP_NEEDS },
    })
    expect(judge('create-ad-group', { ...p, ...insideFacts('create-ad-group', 'create', 5) }, { maxItems: 10, maxBidCents: 100 })).toMatch(/allowStartLive is off/)
    expect(judge('create-ad-group', { ...p, ...insideFacts('create-ad-group', 'create', 5) }, { maxItems: 10, maxBidCents: 100, allowStartLive: true })).toBeNull()
    expect((await preview('create-ad-group', group({ campaignId: 'c-person-floor', startLive: true }))).error).toMatch(/is stopped with low bids .* ask without startLive/)
  })
})

describe('create-ad-group — approved', () => {
  it('created as ONE request: at the floor, planned bids remembered, its own floor, every row in the change set; undo archives it', async () => {
    const asked = await ask('create-ad-group', group({ name: 'Test born at floor' }))
    expect(asked.approvalId).toBeTruthy()
    const done = await approve(asked.approvalId!)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed', result: { created: { productAds: 1, targets: 2, negatives: 1 }, startsAt: 'own' } })
    const id = done.result.adGroupId as string
    const [g] = await sql(`SELECT "defaultBidCents" AS bid, "suppressedFromBidCents" AS kept, "bidsSuppressedBy" AS by, "externalAdGroupId" AS ext FROM "AdGroup" WHERE id = $1`, [id])
    expect(g).toMatchObject({ bid: 2, kept: 40, by: 'user:u-asker' })
    expect(g.ext).toMatch(/^sb-/)
    const kws = await sql(`SELECT "expressionValue" AS text, "bidCents" AS bid, "suppressedFromBidCents" AS kept FROM "AdTarget" WHERE "adGroupId" = $1 AND NOT "isNegative" ORDER BY "expressionValue"`, [id])
    expect(kws).toEqual([{ text: 'thermal jacket', bid: 2, kept: 40 }, { text: 'winter jacket', bid: 2, kept: 55 }])
    const [ad] = await sql(`SELECT sku, asin FROM "AdProductAd" WHERE "adGroupId" = $1`, [id])
    expect(ad).toEqual({ sku: 'TEST-AG-1', asin: 'B0TESTAG01' })
    // Every created row's audit row names the approval (changeSetId): the ad group, the product ad, both keywords, the negative.
    const logs = await sql<{ type: string }>(`SELECT "actionType" AS type FROM "AdvertisingActionLog" WHERE "executionId" = $1 ORDER BY "actionType"`, [asked.approvalId])
    expect(logs.map((l) => l.type)).toEqual(expect.arrayContaining(['create_ad_group', 'create_keyword', 'create_product_ad']))
    expect(logs.length).toBeGreaterThanOrEqual(5)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'archive-ads', args: { adGroupIds: [id] } } })
    // approval-status counts what it created (the ad group, its product ad, keywords and negative); sandbox: none at Amazon.
    const s = (await inside(() => callTool(claude, 'approval-status', { approvalId: asked.approvalId! }))).visible.data as Row
    expect(s).toMatchObject({ status: 'executed', ads: { reach: 'sandbox', created: { total: 5, atAmazon: 0 } }, change: { reversibility: 'partial' } })
    // The read shows it, held at its own floor, given back by set-ad-group op start.
    const read = (await preview('ad-groups', { adGroupId: id })).data.items[0]
    expect(read).toMatchObject({ floor: { by: 'user:u-asker', plannedDefaultBidCents: 40, givenBackBy: 'set-ad-group op start' }, targets: { keywords: 2, negatives: 1, heldAtFloor: 2 } })

    // set-ad-group op start gives the planned bids back: the approver's code, never by rule (lead decision, W4-6 review).
    const start = (await preview('set-ad-group', { adGroupId: id, op: 'start' })).preview
    expect(start).toMatchObject({
      op: 'start', totals: { bids: 3 }, highestRestoredBidCents: 55, limitFacts: { action: 'restore' },
      floorMadeBy: { tool: 'create-ad-group', approvalId: asked.approvalId },
      stepUp: { raises: ['Bids', 'Spend'], needs: STEP_UP_NEEDS, how: expect.stringMatching(/Never by rule\.$/) },
    })
    expect(start.effect).toMatch(/the planned bids create-ad-group made it with, the highest EUR 0\.55\. It starts spending\. Approving it needs the approver's authenticator code; it never runs by rule\.$/)
    expect(start.noCode).toBeUndefined()
    // Never by rule, whatever the limits.
    expect(judge('set-ad-group', { ...start, ...insideFacts('set-ad-group', 'restore', 1) }, { maxItems: 10, maxRaisePct: 100 })).toMatch(/never runs by rule/)
    const started = await ask('set-ad-group', { adGroupId: id, op: 'start' })
    const plain = await approve(started.approvalId!)
    expect(plain).toMatchObject({ ok: false, status: 'pending' })
    expect(plain.error).toMatch(/^Not run: it raises, and a raise runs only when a person with settings\.security\.manage approved it with their authenticator code/)
    await withCode(started.approvalId!)
    expect(await approve(started.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { restored: 3 } })
    const [after] = await sql(`SELECT "defaultBidCents" AS bid, "bidsSuppressedAt" AS at FROM "AdGroup" WHERE id = $1`, [id])
    expect(after).toEqual({ bid: 40, at: null })
    expect((await sql(`SELECT "bidCents" AS bid FROM "AdTarget" WHERE "adGroupId" = $1 AND NOT "isNegative" ORDER BY "bidCents"`, [id])).map((r) => r.bid)).toEqual([40, 55])
    expect(await inside(() => undoRequestFor({ approvalId: started.approvalId! }))).toMatchObject({ request: { tool: 'set-ad-group', args: { adGroupId: id, op: 'stop' } } })
  })

  it('inside a campaign a person stopped: still a floor of its own (the asker\'s) — restore-campaign leaves it, naming op start', async () => {
    const before = (await preview('restore-campaign', { campaignId: 'c-person-floor' })).preview.restores
    const asked = await ask('create-ad-group', group({ campaignId: 'c-person-floor', name: 'Test own floor inside' }))
    const p = (await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId! } }))).preview as Row
    expect(p.effect).toMatch(/Its campaign is stopped with low bids now .*: restore-campaign leaves this ad group at its own floor\.$/)
    expect((await approve(asked.approvalId!))).toMatchObject({ ok: true, result: { startsAt: 'own', nextSteps: [expect.stringMatching(/^set-ad-group /)] } })
    const [g] = await sql(`SELECT id, "defaultBidCents" AS bid, "suppressedFromBidCents" AS kept, "bidsSuppressedBy" AS by FROM "AdGroup" WHERE "campaignId" = 'c-person-floor' AND name = 'Test own floor inside'`)
    expect(g).toMatchObject({ bid: 2, kept: 40, by: 'user:u-asker' })
    // restore-campaign gives back nothing of it, and says what lifts its floor.
    const restore = (await preview('restore-campaign', { campaignId: 'c-person-floor' })).preview
    expect(restore.restores).toEqual(before)
    expect(restore.staysFloored).toMatchObject({ adGroups: 1, floors: [{ adGroupId: g.id, until: expect.stringMatching(/^until set-ad-group op start gives its planned bids back \(create-ad-group made it at the floor/) }] })
    expect(restore.effect).toMatch(/1 ad group stays at its own floor: "Test own floor inside" until set-ad-group op start/)
    // op start waits for the campaign's own floor to lift first.
    expect((await preview('set-ad-group', { adGroupId: g.id, op: 'start' })).error).toMatch(/is stopped with low bids/)
  })

  it('a create that stops after Amazon made the ad group answers ok, part-way: the change is recorded and undo archives it', async () => {
    breakOn.markFloor = true
    try {
      const asked = await ask('create-ad-group', group({ campaignId: 'c-edit', name: 'Test stops part-way', skus: ['TEST-AG-7'] }))
      const done = await approve(asked.approvalId!)
      expect(done).toMatchObject({ ok: true, status: 'executed', result: { partial: true, problem: 'a test failure after the ad group was made' } })
      expect(done.result.note).toMatch(/^Created part-way: stopped part-way \(a test failure after the ad group was made\)\. .*Undo archives it \(archive-ads\)\.$/)
      expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'archive-ads', args: { adGroupIds: [done.result.adGroupId] } } })
    } finally { breakOn.markFloor = false }
  })

  it('startLive: a plain approve does not run it; the Approvals page asks for the code, and with it the bids start as planned', async () => {
    const plain = await ask('create-ad-group', group({ name: 'Test live plain', startLive: true, skus: ['TEST-AG-7'] }))
    const refused = await approve(plain.approvalId!)
    expect(refused).toMatchObject({ ok: false, status: 'pending' })
    expect(refused.error).toMatch(/^Not run: it raises, and a raise runs only when a person with settings\.security\.manage approved it with their authenticator code/)
    expect(await sql(`SELECT id FROM "AdGroup" WHERE name = 'Test live plain'`)).toEqual([])

    const asked = await ask('create-ad-group', group({ name: 'Test live coded', startLive: true, skus: ['TEST-AG-7'] }))
    const decide = (code?: string) => inside(() => decideFleetApproval({ id: asked.approvalId!, decision: 'approve', actor: owner.principal, ...(code ? { code } : {}) }))
    expect(await decide()).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await decide(codeOf(owner))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(asked.approvalId!)).toMatchObject({ ok: true })
    const [g] = await sql(`SELECT "defaultBidCents" AS bid, "suppressedFromBidCents" AS kept, "bidsSuppressedAt" AS at FROM "AdGroup" WHERE name = 'Test live coded'`)
    expect(g).toEqual({ bid: 40, kept: null, at: null })
    // By rule a live start waits for a person, whatever else its limits allow, until allowStartLive is on.
    const p = (await preview('create-ad-group', group({ campaignId: 'c-step', name: 'Test live judge', startLive: true, skus: ['TEST-AG-7'] }))).preview
    expect(p.plan.start).toBe('live')
    expect(judge('create-ad-group', { ...p, limitFacts: undefined })).toMatch(/no limit facts/)
  })

  it('a change plan step: born at the floor, it needs no code and runs as a step', async () => {
    const queued = await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
      return queuePlan({ title: 'Test new ad group', steps: [{ tool: 'create-ad-group', args: group({ campaignId: 'c-edit', name: 'Test plan group', skus: ['TEST-AG-4'] }) }] }, claude, run.id)
    })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    expect(queued.preview?.stepUp).toBeUndefined()
    expect(await inside(() => decideFleetApproval({ id: queued.approvalId!, decision: 'approve', actor: owner.principal }))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(queued.approvalId!)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(queued.approvalId!))).toMatchObject({ finished: true, counts: { done: 1 } })
    const [g] = await sql(`SELECT "bidsSuppressedBy" AS by FROM "AdGroup" WHERE name = 'Test plan group'`)
    expect(g).toEqual({ by: 'user:u-asker' })
  })
})

describe('add-product-ads', () => {
  it('the preview: each product and the seller SKU, in raises, with the approver\'s code; rule 3 and the market hold', async () => {
    const p = (await preview('add-product-ads', { adGroupId: 'g-c-it', skus: ['TEST-AG-5'] })).preview
    expect(p).toMatchObject({
      action: 'add-product-ads', adGroup: { id: 'g-c-it' }, totals: { productAds: 1 },
      products: [{ sku: 'TEST-AG-5', asin: 'B0TESTAG05', adSku: 'TEST-AG-5' }],
      raises: [expect.stringMatching(/the ad of TEST-AG-5/)],
      stepUp: { raises: ['Product ads', 'Spend'], needs: STEP_UP_NEEDS },
      otherProducts: { skus: expect.arrayContaining(['TEST-OTHER-1', 'TEST-AG-2']) },
      limitFacts: { tool: 'add-product-ads', action: 'create', this: { items: 1, raises: 1 } },
    })
    expect((await preview('add-product-ads', { adGroupId: 'g-c-it', skus: ['TEST-AG-2'] })).error).toMatch(/the same product twice in one campaign/)
    expect((await preview('add-product-ads', { adGroupId: 'g-c-it', skus: ['TEST-UNLISTED-1'] })).error).toMatch(/^Not sold on Amazon IT/)
    expect((await preview('add-product-ads', { adGroupId: 'nope', skus: ['TEST-AG-5'] })).error).toMatch(/^Ad group nope not found/)
    expect((await preview('add-product-ads', { adGroupId: 'g-c-sb', skus: ['TEST-AG-5'] })).error).toMatch(/not a Sponsored Products campaign/)
    const elsewhere = (await preview('add-product-ads', { adGroupId: 'g-c-it', skus: ['TEST-AG-3'] })).preview
    expect(elsewhere.selfCompetition).toMatchObject({ campaigns: [{ campaignId: 'c-pin' }] })
    // By rule: nothing by default (maxItems 0); the same product elsewhere waits for a person unless the limits allow it.
    expect(judge('add-product-ads', { ...p, ...insideFacts('add-product-ads', 'create', 1) })).toMatch(/more than the 0/)
    expect(judge('add-product-ads', { ...p, ...insideFacts('add-product-ads', 'create', 1) }, { maxItems: 5 })).toBeNull()
    expect(judge('add-product-ads', { ...elsewhere, ...insideFacts('add-product-ads', 'create', 1) }, { maxItems: 5 })).toMatch(/allowSelfCompetition is off/)
  })

  it('a plain approve does not run it; with the code it runs as the approver in the change set; undo pauses them', async () => {
    const asked = await ask('add-product-ads', { adGroupId: 'g-c-it', skus: ['TEST-AG-5'] })
    expect((await approve(asked.approvalId!))).toMatchObject({ ok: false, status: 'pending' })
    expect(await sql(`SELECT id FROM "AdProductAd" WHERE sku = 'TEST-AG-5'`)).toEqual([])
    await withCode(asked.approvalId!)
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { created: 1 } })
    const [log] = await sql(`SELECT "userId" AS who FROM "AdvertisingActionLog" WHERE "executionId" = $1 AND "actionType" = 'create_product_ad'`, [asked.approvalId])
    expect(log).toEqual({ who: 'user:u-approver' })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'pause-ads', args: { productAds: [{ adGroupId: 'g-c-it', product: 'TEST-AG-5' }] } } })
  })

  it('a change plan carries the step\'s code: no code → mfa_required; with it the step runs', async () => {
    const queued = await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
      return queuePlan({ title: 'Test product ads', steps: [{ tool: 'add-product-ads', args: { adGroupId: 'g-c-edit', skus: ['TEST-AG-6'] } }] }, claude, run.id)
    })
    expect(queued).toMatchObject({ ok: true, mode: 'queued', preview: { stepUp: { raises: ['Product ads', 'Spend'], steps: [1] } } })
    const decide = (code?: string) => inside(() => decideFleetApproval({ id: queued.approvalId!, decision: 'approve', actor: owner.principal, ...(code ? { code } : {}) }))
    expect(await decide()).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await decide(codeOf(owner))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(queued.approvalId!)).toMatchObject({ ok: true })
    expect(await inside(() => runPlan(queued.approvalId!))).toMatchObject({ finished: true, counts: { done: 1 } })
    expect(await sql(`SELECT "adGroupId" AS g FROM "AdProductAd" WHERE sku = 'TEST-AG-6'`)).toEqual([{ g: 'g-c-edit' }])
  })
})

describe('set-ad-group', () => {
  it('op edit: a default bid stepped like set-target-bid (no code); approved it is queued as the approver; undo sets it back', async () => {
    const p = (await preview('set-ad-group', { adGroupId: 'g-c-step', defaultBidCents: 60 })).preview
    expect(p).toMatchObject({
      op: 'edit', currentBidCents: 30, proposedBidCents: 60, effectiveBidCents: 36, clampedBy: "the campaign's max-change guardrail",
      raises: [expect.stringMatching(/EUR 0\.30 → EUR 0\.36/)], limitFacts: { action: 'bid' },
    })
    expect(p.stepUp).toBeUndefined()
    // By default a raise never runs by rule (maxRaisePct 0), as set-target-bid.
    expect(judge('set-ad-group', p)).toBeTypeOf('string')
    const asked = await ask('set-ad-group', { adGroupId: 'g-c-step', defaultBidCents: 60 })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { defaultBidCents: 36 } })
    const [queued] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = 'g-c-step' ORDER BY "createdAt" DESC LIMIT 1`)
    expect(queued.payload).toMatchObject({ actor: 'user:u-approver', fieldChanges: [{ field: 'defaultBid', oldValue: '30', newValue: '36' }] })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-ad-group', args: { adGroupId: 'g-c-step', op: 'edit', defaultBidCents: 30 } } })
  })

  it('op edit: a rename (new in its campaign; never by rule by default); refusals: a taken name, a floored bid raised, nothing to change', async () => {
    expect((await preview('set-ad-group', { adGroupId: 'g-c-edit', name: 'SECOND GROUP' })).error).toMatch(/already has an ad group named "second group"/)
    const p = (await preview('set-ad-group', { adGroupId: 'g-c-edit', name: 'Test renamed group' })).preview
    expect(p).toMatchObject({ name: { from: 'group c-edit', to: 'Test renamed group' }, raises: [] })
    expect(judge('set-ad-group', { ...p, ...insideFacts('set-ad-group', 'bid', 1) })).toMatch(/allowRename is off/)
    expect(judge('set-ad-group', { ...p, ...insideFacts('set-ad-group', 'bid', 1) }, { allowRename: true })).toBeNull()
    expect((await preview('set-ad-group', { adGroupId: 'g-c-engine-floor', defaultBidCents: 40 })).error).toMatch(/is held at a floor \(by automation:budget-manager\): its default bid is not raised here/)
    expect((await preview('set-ad-group', { adGroupId: 'g-c-edit', defaultBidCents: 30 })).error).toMatch(/^Nothing would change/)
    expect((await preview('set-ad-group', { adGroupId: 'g-c-edit' })).error).toMatch(/^Name what changes/)
    expect((await preview('set-ad-group', { adGroupId: 'g-c-edit', op: 'stop', name: 'x' })).error).toMatch(/changes the ad group's bids as a whole/)
  })

  it('op stop: low bids, each remembered (never a pause); undo starts it again; an engine\'s floor is not given back here', async () => {
    const p = (await preview('set-ad-group', { adGroupId: 'g-c-stop', op: 'stop' })).preview
    expect(p).toMatchObject({ op: 'stop', stopBidCents: 2, totals: { bids: 2 }, raises: [], limitFacts: { action: 'stop' } })
    const asked = await ask('set-ad-group', { adGroupId: 'g-c-stop', op: 'stop' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { lowered: 2 } })
    const [g] = await sql(`SELECT "defaultBidCents" AS bid, "suppressedFromBidCents" AS kept, "bidsSuppressedBy" AS by, status::text AS status FROM "AdGroup" WHERE id = 'g-c-stop'`)
    expect(g).toEqual({ bid: 2, kept: 30, by: 'user:u-approver', status: 'ENABLED' })
    expect(await sql(`SELECT "bidCents" AS bid, "suppressedFromBidCents" AS kept FROM "AdTarget" WHERE id = 't-c-stop'`)).toEqual([{ bid: 2, kept: 55 }])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-ad-group', args: { adGroupId: 'g-c-stop', op: 'start' } } })
    // No back door: undo-ad-change does not raise what the stop floored (only op start does, with the code).
    expect((await preview('undo-ad-change', { changeSetId: asked.approvalId! })).error)
      .toMatch(/^Not undone: it would raise bids of ad group "group c-stop", which is held at its own floor until set-ad-group op start gives its bids back \(set-ad-group op stop lowered them/)
    // A stop on an ad group already at a floor of its own is refused (its undo would give back more than it lowered).
    expect((await preview('set-ad-group', { adGroupId: 'g-c-stop', op: 'stop' })).error).toMatch(/is already held at a floor of its own \(by a person \(user:u-approver\)/)
    // op start lifts only a floor create-ad-group or op stop made.
    expect((await preview('set-ad-group', { adGroupId: 'g-c-stop', op: 'start' })).preview).toMatchObject({ floorMadeBy: { tool: 'set-ad-group op stop', approvalId: asked.approvalId } })
    expect((await preview('set-ad-group', { adGroupId: 'g-c-stock-floor', op: 'start' })).error)
      .toMatch(/is held at a stock floor \(lower-ad-bids-for-stock\): it stays until restore-ad-bids-after-stock gives its bids back once its stock is back/)
    expect((await preview('set-ad-group', { adGroupId: 'g-c-other-floor', op: 'start' })).error)
      .toMatch(/is held at a floor a person \(user:u-someone\) set, which no create-ad-group or set-ad-group op stop on record made: it stays until the person who set it \(user:u-someone\) gives it back/)
    expect((await preview('set-ad-group', { adGroupId: 'g-c-engine-floor', op: 'start' })).error).toMatch(/a floor an engine set \(automation:budget-manager\): it stays until the 1st or until that cap is raised/)
    expect((await preview('set-ad-group', { adGroupId: 'g-c-person-floor', op: 'start' })).error).toMatch(/is stopped with low bids .* restore-campaign gives them back/)
    expect((await preview('set-ad-group', { adGroupId: 'g-c-edit-2', op: 'start' })).error).toMatch(/^Nothing would change: .* not held at a floor of its own/)
  })

  it('op start: the Approvals page asks for the code; by rule it never runs; a change plan carries the code', async () => {
    // Floor two ad groups with an approved stop, then ask to start them.
    const stopOf = async (adGroupId: string) => {
      const stopped = await ask('set-ad-group', { adGroupId, op: 'stop' })
      expect(await approve(stopped.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    }
    await stopOf('g-c-edit-2')
    const asked = await ask('set-ad-group', { adGroupId: 'g-c-edit-2', op: 'start' })
    const decide = (code?: string) => inside(() => decideFleetApproval({ id: asked.approvalId!, decision: 'approve', actor: owner.principal, ...(code ? { code } : {}) }))
    expect(await decide()).toMatchObject({ ok: false, code: 'mfa_required', raises: ['Bids', 'Spend'] })
    // Decided by the business's rule (as if a limit had let it): execute refuses it all the same.
    await inside(() => db().agentApproval.update({ where: { id: asked.approvalId! }, data: { decisionVia: 'auto' } }))
    const byRule = await approve(asked.approvalId!)
    expect(byRule).toMatchObject({ ok: false, status: 'pending' })
    expect(byRule.error).toMatch(/never runs by rule/)
    await inside(() => db().agentApproval.update({ where: { id: asked.approvalId! }, data: { decisionVia: null } }))
    expect(await decide(codeOf(owner))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(asked.approvalId!)).toMatchObject({ ok: true })
    expect(await sql(`SELECT "defaultBidCents" AS bid, "bidsSuppressedAt" AS at FROM "AdGroup" WHERE id = 'g-c-edit-2'`)).toEqual([{ bid: 30, at: null }])

    await stopOf('g-c-edit-2')
    const queued = await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
      return queuePlan({ title: 'Test start an ad group', steps: [{ tool: 'set-ad-group', args: { adGroupId: 'g-c-edit-2', op: 'start' } }] }, claude, run.id)
    })
    expect(queued).toMatchObject({ ok: true, mode: 'queued', preview: { stepUp: { raises: ['Bids', 'Spend'], steps: [1] } } })
    const decidePlan = (code?: string) => inside(() => decideFleetApproval({ id: queued.approvalId!, decision: 'approve', actor: owner.principal, ...(code ? { code } : {}) }))
    expect(await decidePlan()).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await decidePlan(codeOf(owner))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(queued.approvalId!)).toMatchObject({ ok: true })
    expect(await inside(() => runPlan(queued.approvalId!))).toMatchObject({ finished: true, counts: { done: 1 } })
    expect(await sql(`SELECT "bidsSuppressedAt" AS at FROM "AdGroup" WHERE id = 'g-c-edit-2'`)).toEqual([{ at: null }])
  })
})
