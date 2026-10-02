/**
 * MCP full control part 06, fix (found in R4) — an eBay rule's version row stores the name the rule stores: trimmed.
 *
 * The edit trimmed the name on the rule but snapshotted the untrimmed one, so the history showed "  Name  " for a
 * rule called "Name", and a save that only added spaces was compared untrimmed and became a new version.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { createEbayAdsRule, updateEbayAdsRule } from './ebay-ads-rule-crud.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

beforeAll(async () => { database = await formulaDatabase() }, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('eBay rule versions store the trimmed name', () => {
  it('a renamed rule: the rule and its version say the same name; spaces alone make no new version', async () => {
    const created = await inside(() => createEbayAdsRule({
      name: 'TEST fee creep', trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 14, op: 'gte', threshold: 30 }] },
      action: { type: 'adjust_ad_rate', deltaPct: -10, minRatePct: 2 }, cooldownHours: 72,
    }, 'test-person'))
    if (!created.ok) throw new Error('create refused')
    const id = created.value.id
    const renamed = await inside(() => updateEbayAdsRule(id, { name: '  TEST fee creep (v2)  ' }, 'test-person'))
    expect(renamed.ok && renamed.value.name).toBe('TEST fee creep (v2)')
    const versions = await inside(() => database.client.ebayAdsRuleVersion.findMany({ where: { ruleId: id }, orderBy: { version: 'asc' } }))
    expect(versions.map((v) => [v.version, v.name])).toEqual([[1, 'TEST fee creep'], [2, 'TEST fee creep (v2)']])
    // Only spaces around the same name: no config change, no third version.
    await inside(() => updateEbayAdsRule(id, { name: ' TEST fee creep (v2) ' }, 'test-person'))
    expect(await inside(() => database.client.ebayAdsRuleVersion.count({ where: { ruleId: id } }))).toBe(2)
  })
})
