/**
 * ADS AUTONOMY W1-8 — where each ad change Claude asks for lands, and the strategy's level for its kind there
 * (claude.ts), on PGlite with the production schema and business policies, business profiles ON. Values are made up
 * (public repo). The door that takes the lower of this and the business's level is proven in
 * agents/claude-strategy.vitest.test.ts.
 *
 *   places     each tool from its arguments (before the dry run) and its preview (after): a target or a negative →
 *              its ad group's products; a campaign → its ad groups' products; a new campaign → its SKUs in its market;
 *              a suggestion → what it applies to; an ad undo → every entity it puts back; a rule → its scope
 *   fail closed a whole market, or a place chosen only when it runs → the strictest row of the market; nothing found →
 *              the strictest row of the business
 *   never      a brake, a tool that is no ad action, an eBay or marketing request, a kind no row speaks to
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { strategyLevelFor } from './claude.js'

const A = 'w18_place_alpha'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const db = () => database.client
const ids = { p1: '', p2: '', s1: '', s2: '', s3: '' }
const ASK_ALL = { bid: 'ask', negative: 'ask', harvest: 'ask', suggestion: 'ask', create: 'ask', rule: 'ask', undo: 'ask', target: 'ask' }
const CONFIRM_ALL = Object.fromEntries(Object.keys(ASK_ALL).map((k) => [k, 'confirm']))

const level = (tool: string, args: Record<string, unknown>, preview?: unknown) => inA(() => strategyLevelFor(tool, args, preview))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await inA(async () => {
    const c = db()
    await seedAdsFixture(c)
    // c-it's ad group advertises P1 (its own row: ask for everything); c-off's advertises P2 (no row: the market's confirm).
    ids.p1 = (await c.product.create({ data: { sku: 'TEST-W18-P1', name: 'Test helmet', basePrice: '10.00' } })).id
    ids.p2 = (await c.product.create({ data: { sku: 'TEST-W18-P2', name: 'Test gloves', basePrice: '10.00' } })).id
    await c.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: ids.p1, asin: 'B0TESTW181' } })
    await c.adProductAd.create({ data: { adGroupId: 'g-c-off', productId: ids.p2, asin: 'B0TESTW182' } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', claudeAutonomy: CONFIRM_ALL, updatedBy: 'user:test' } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: ids.p1, label: 'TEST-W18-P1 (IT)', claudeAutonomy: ASK_ALL, updatedBy: 'user:test' } })

    const suggestion = (entityType: string, entityId: string) =>
      c.adsRuleSuggestion.create({ data: { ruleId: 'rule-test', entityType, entityId, marketplace: 'IT', proposedAction: { type: 'bid_apply' }, proposedKey: `${entityType}:${entityId}` } })
    ids.s1 = (await suggestion('AD_TARGET', 't-it')).id
    ids.s2 = (await suggestion('CAMPAIGN', 'c-off')).id
    ids.s3 = (await suggestion('SEARCH_TERM', 'EXT-c-it:race jacket')).id
    const log = (executionId: string, entityType: string, entityId: string) =>
      c.advertisingActionLog.create({ data: { executionId, actionType: 'bid_down', entityType, entityId, payloadBefore: {}, payloadAfter: {} } })
    await log('set-it', 'AD_TARGET', 't-it')
    await log('set-off', 'CAMPAIGN', 'c-off')
    await log('set-uk', 'AD_TARGET', 't-uk')
  })
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

const product = { scope: 'product', label: 'TEST-W18-P1 (IT)' }
const market = { scope: 'market', label: 'Test market (IT)' }

describe('W1-8 — where each ad change lands', () => {
  it('a negative: its ad group, from the Amazon ids before the dry run and from the preview after', async () => {
    expect(await level('create-negative-keyword', { externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it' })).toMatchObject({ action: 'negative', level: 'ask', basis: 'scope', row: product })
    expect(await level('create-negative-keyword', { externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it' }, { adGroup: { id: 'g-c-off' } })).toMatchObject({ level: 'confirm', row: market })
    // An ad group not found in its campaign: the campaign.
    expect(await level('create-negative-keyword', { externalCampaignId: 'EXT-c-off', externalAdGroupId: 'EXT-nope' })).toMatchObject({ level: 'confirm', basis: 'scope' })
  })

  it('a harvested keyword: the destination ad group; with none named, the strictest row of the source\'s market', async () => {
    expect(await level('graduate-keyword', { sourceExternalCampaignId: 'EXT-c-off' }, { destinationAdGroup: { id: 'g-c-it' } })).toMatchObject({ level: 'ask', row: product })
    expect(await level('graduate-keyword', { sourceExternalCampaignId: 'EXT-c-it', destExternalCampaignId: 'EXT-c-off' })).toMatchObject({ level: 'confirm', basis: 'scope' })
    expect(await level('graduate-keyword', { sourceExternalCampaignId: 'EXT-c-off' })).toMatchObject({
      level: 'ask', basis: 'market', unplaced: 'the ad group it lands in is chosen when it runs', row: product,
    })
  })

  it('a bid: its target\'s ad group; a list of bids, every ad group; a campaign, its ad groups', async () => {
    expect(await level('set-target-bid', { targetId: 't-it' })).toMatchObject({ action: 'bid', level: 'ask', row: product })
    expect(await level('set-target-bid', { targetId: 't-off' })).toMatchObject({ level: 'confirm', row: market })
    expect(await level('bulk-ad-bid-change', { bids: [{ targetId: 't-off', bidCents: 31 }, { targetId: 't-it', bidCents: 46 }] })).toMatchObject({ level: 'ask', row: product })
    expect(await level('bulk-ad-bid-change', { campaignId: 'c-off', percent: 5 })).toMatchObject({ level: 'confirm' })
    expect(await level('bulk-ad-bid-change', { adGroupId: 'g-c-it', percent: 5 })).toMatchObject({ level: 'ask' })
    // A UK target: no strategy row speaks for the UK.
    expect(await level('set-target-bid', { targetId: 't-uk' })).toBeNull()
  })

  it('target ACoS: the campaigns named, or each one of a list; a market, its strictest row', async () => {
    expect(await level('set-campaign-target-acos', { targets: [{ campaignId: 'c-off', targetAcosPct: 20 }] })).toMatchObject({ action: 'target', level: 'confirm' })
    expect(await level('set-campaign-target-acos', { campaignIds: ['c-off', 'c-it'], targetAcosPct: 20 })).toMatchObject({ level: 'ask', basis: 'scope' })
    expect(await level('set-campaign-target-acos', { market: 'it', targetAcosPct: 20 })).toMatchObject({ level: 'ask', basis: 'market' })
  })

  it('rule suggestions: what each applies to (a target, a campaign, a search term\'s campaign); eBay proposals are not the Amazon strategy\'s', async () => {
    expect(await level('decide-automation-suggestions', { kind: 'amazon-ads', decisions: [{ suggestionId: ids.s2, decide: 'apply' }] })).toMatchObject({ action: 'suggestion', level: 'confirm' })
    expect(await level('decide-automation-suggestions', { kind: 'amazon-ads', decisions: [{ suggestionId: ids.s1, decide: 'dismiss' }] })).toMatchObject({ level: 'ask', row: product })
    expect(await level('decide-automation-suggestions', { kind: 'amazon-ads', decisions: [{ suggestionId: ids.s3, decide: 'apply' }] })).toMatchObject({ level: 'ask' })
    expect(await level('decide-automation-suggestions', { kind: 'ebay-ads', decisions: [{ suggestionId: 'any', decide: 'apply' }] })).toBeNull()
  })

  it('a new campaign: its SKUs in its market', async () => {
    expect(await level('create-ad-campaign', { market: 'IT', skus: ['TEST-W18-P1'] })).toMatchObject({ action: 'create', level: 'ask', row: product })
    expect(await level('create-ad-campaign', { market: 'IT', skus: ['TEST-W18-P2'] })).toMatchObject({ level: 'confirm', row: market })
    expect(await level('create-ad-campaign', { market: 'UK', skus: ['TEST-W18-P1'] })).toBeNull()
  })

  it('PB-5a — a playbook build: its product in its market (by id or SKU), a create; an adopt is not narrowed', async () => {
    expect(await level('apply-ads-playbook', { op: 'build', market: 'IT', productId: ids.p1 })).toMatchObject({ action: 'create', level: 'ask', row: product })
    expect(await level('apply-ads-playbook', { op: 'build', market: 'IT', sku: 'TEST-W18-P2' })).toMatchObject({ action: 'create', level: 'confirm', row: market })
    expect(await level('apply-ads-playbook', { op: 'adopt', market: 'IT', productId: ids.p1 })).toBeNull()
  })

  it('an ads rule: its scope; a whole account, or an edit keeping its scope, the strictest row of the business', async () => {
    expect(await level('save-ad-rule', { kind: 'amazon-ads', scope: { campaignId: 'c-off' } })).toMatchObject({ action: 'rule', level: 'confirm' })
    expect(await level('save-ad-rule', { kind: 'amazon-ads', scope: { marketplace: 'IT', productId: ids.p1 } })).toMatchObject({ level: 'ask', basis: 'scope' })
    expect(await level('save-ad-rule', { kind: 'amazon-ads', scope: { productId: ids.p1 } })).toMatchObject({ level: 'ask', basis: 'scope' })
    expect(await level('save-ad-rule', { kind: 'amazon-ads', scope: { marketplace: 'IT' } })).toMatchObject({ level: 'ask', basis: 'market', unplaced: 'a rule for the whole market' })
    expect(await level('save-ad-rule', { kind: 'amazon-ads', scope: { wholeAccount: true } })).toMatchObject({ level: 'ask', basis: 'business' })
    expect(await level('save-ad-rule', { kind: 'amazon-ads', ruleId: 'r-1' })).toMatchObject({ level: 'ask', basis: 'business', unplaced: "an edit that keeps the rule's own scope" })
    expect(await level('save-ad-rule', { kind: 'marketing', scope: { wholeAccount: true } })).toBeNull()
  })

  it('an ad undo: every entity its change set puts back', async () => {
    expect(await level('undo-ad-change', { changeSetId: 'set-off' })).toMatchObject({ action: 'undo', level: 'confirm' })
    expect(await level('undo-ad-change', { changeSetId: 'set-it' })).toMatchObject({ level: 'ask', row: product })
    expect(await level('undo-ad-change', { changeSetId: 'set-uk' })).toBeNull()
    expect(await level('undo-ad-change', { changeSetId: 'no-such-set' })).toMatchObject({ level: 'ask', basis: 'business', unplaced: 'the change set it names was not found' })
  })

  it('a budget, a placement, a stop, a restore: the campaign', async () => {
    await inA(() => db().adsStrategy.updateMany({ where: { level: 'MARKET' }, data: { claudeAutonomy: { ...CONFIRM_ALL, budget: 'ask', placement: 'off', stop: 'ask', restore: 'confirm' } } }))
    expect(await level('set-campaign-budget', { campaignId: 'c-off', dailyBudgetCents: 900 })).toMatchObject({ action: 'budget', level: 'ask' })
    expect(await level('set-placement-multipliers', { campaignId: 'c-off', topOfSearchPct: 10 })).toMatchObject({ action: 'placement', level: 'off' })
    expect(await level('suppress-campaign', { campaignId: 'c-off' })).toMatchObject({ action: 'stop', level: 'ask' })
    expect(await level('restore-campaign', { campaignId: 'c-off' })).toMatchObject({ action: 'restore', level: 'confirm' })
    // An unknown campaign: the strictest row of the business.
    expect(await level('set-placement-multipliers', { campaignId: 'nope' })).toMatchObject({ level: 'off', basis: 'business', unplaced: 'a campaign it names was not found' })
  })
})

describe('W1-8 — never narrowed', () => {
  it('a brake, a tool that is no ad action, a kind no row speaks to', async () => {
    for (const tool of ['stop-automation', 'turn-down-automation', 'set-ad-guardrail', 'set-price']) expect(await level(tool, { campaignId: 'c-it' }), tool).toBeNull()
    await inA(() => db().adsStrategy.updateMany({ data: { claudeAutonomy: { bid: 'ask' } } }))
    expect(await level('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 900 })).toBeNull()
  })
})
