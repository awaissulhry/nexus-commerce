/**
 * D2 (Owner 2026-10-10) — a harvest rule on Auto runs inside its caps (harvest/rule-caps.ts), the database a stub: the
 * day's keywords, only the product's own campaigns, never from a paused source; a person's path is never capped. Values
 * are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ used: 0, paused: new Set<string>(), owners: new Map<string, string | null>(), record: null as Record<string, any> | null }))
vi.mock('../../../db.js', () => ({
  default: {
    advertisingActionLog: { count: vi.fn(async () => h.used) },
    adsHarvestSourcePause: { findFirst: vi.fn(async (a: { where: { adGroupId: string } }) => (h.paused.has(a.where.adGroupId) ? { id: 'p' } : null)) },
    adGroup: { findUnique: vi.fn(async (a: { where: { id: string } }) => ({ campaignId: `c-${a.where.id}`, campaign: { marketplace: 'IT' } })) },
    adsBrainHarvest: {
      findUnique: vi.fn(async () => (h.record ? { id: 'r1', status: h.record.status, actorKind: h.record.actorKind, sources: h.record.sources } : null)),
      create: vi.fn(async (a: { data: Record<string, any> }) => { h.record = { ...a.data }; return { id: 'r1' } }),
      update: vi.fn(async (a: { data: Record<string, any> }) => { h.record = { ...h.record, ...a.data }; return { id: 'r1' } }),
    },
  },
}))
vi.mock('../brain/ownership.js', () => ({
  resolveCampaignOwnership: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { owner: h.owners.get(id) ? { kind: 'product', productId: h.owners.get(id) } : { kind: 'shared', productIds: [] } }]))),
}))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { ruleHarvestGuard } = await import('./rule-caps.js')
const { HARVEST_RULE_CAPS } = await import('../ads-graduation.js')

beforeEach(() => { h.record = null; h.used = 0; h.paused = new Set(); h.owners = new Map([['c-src', 'jacket'], ['c-dest', 'jacket'], ['c-shared', null], ['c-glove', 'glove']]) })

describe('D2 — a rule on Auto inside its caps', () => {
  it('into the product\'s own campaign: allowed; a shared or another product\'s campaign: refused, named', async () => {
    const g = await ruleHarvestGuard('automation:r1')
    expect(await g.refusal({ sourceAdGroupId: 'src', destAdGroupId: 'dest' })).toBeNull()
    expect(await g.refusal({ sourceAdGroupId: 'src', destAdGroupId: 'shared' })).toMatchObject({ deniedAt: 'harvest_rule_own_campaigns' })
    expect(await g.refusal({ sourceAdGroupId: 'src', destAdGroupId: 'glove' })).toMatchObject({ deniedAt: 'harvest_rule_own_campaigns' })
  })

  it('the day\'s keywords: the cap counts what it created today and what it creates now', async () => {
    h.used = HARVEST_RULE_CAPS.keywordsPerDay - 1
    const g = await ruleHarvestGuard('automation:r1')
    expect(await g.refusal({ sourceAdGroupId: 'src', destAdGroupId: 'dest' })).toBeNull()
    g.created()
    expect(await g.refusal({ sourceAdGroupId: 'src', destAdGroupId: 'dest' })).toMatchObject({ deniedAt: 'harvest_rule_cap', why: expect.stringMatching(/for today/) })
  })

  it('never from a paused source; a person\'s path is never capped', async () => {
    h.paused.add('src')
    expect(await (await ruleHarvestGuard('automation:r1')).refusal({ sourceAdGroupId: 'src', destAdGroupId: 'dest' })).toMatchObject({ deniedAt: 'harvest_source_paused' })
    h.used = 1000
    expect(await (await ruleHarvestGuard('user:owner')).refusal({ sourceAdGroupId: 'src', destAdGroupId: 'shared' })).toBeNull()
    expect(await (await ruleHarvestGuard(undefined)).refusal({ sourceAdGroupId: 'src', destAdGroupId: 'shared' })).toBeNull()
  })
})

describe('M1 — a rule\'s (or an accepted card\'s) harvest record lists the source negatives that landed, so its Undo lifts them', () => {
  it('at the landing, and at a later handover (the source negated once the home proved itself)', async () => {
    const g = await ruleHarvestGuard('automation:r1', { caps: false })
    await g.record({ query: 'Touring Jacket', matchType: 'EXACT', sourceAdGroupId: 'src', destAdGroupId: 'dest', keywordTargetId: 'k1', bidCents: 40, negatives: [{ adTargetId: 'n1', matchType: 'EXACT' }] })
    expect(h.record).toMatchObject({ term: 'touring jacket', actorKind: 'RULE', actorId: 'r1', keywordTargetId: 'k1', sources: [expect.objectContaining({ adGroupId: 'src', action: 'negate', result: 'landed', negativeTargetId: 'n1' })] })
    // Kept at the landing (proven handover later): "kept", then the handover's negative joins the record.
    h.record = null
    await g.record({ query: 'touring jacket', matchType: 'EXACT', sourceAdGroupId: 'src', destAdGroupId: 'dest', keywordTargetId: 'k1', bidCents: 40, negatives: [] })
    expect(h.record!.sources).toEqual([expect.objectContaining({ action: 'kept' })])
    await g.recordHandover({ query: 'touring jacket', sourceAdGroupId: 'src', negatives: [{ adTargetId: 'n2', matchType: 'EXACT' }] })
    expect(h.record!.sources).toEqual([expect.objectContaining({ adGroupId: 'src', action: 'negate', negativeTargetId: 'n2', result: 'landed' })])
  })
})
