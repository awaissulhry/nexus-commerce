/**
 * S2 (2026-09-26) — the structural reconcile closes drift rows on evidence, inside one business profile, on a real
 * PostgreSQL with the production policies and the restricted runtime login. Only Amazon's reads are stubbed: the
 * reconcile, the launch verifier, the drift writes and row-level security are the real ones.
 *
 * Measured on production: all 452 open rows belonged to one profile and were child entities, and no child row had
 * ever closed — the resolve pass selected only CAMPAIGN rows. It also closed CAMPAIGN rows for fields it never
 * compares. The pass now closes a row only when its entity and field were compared in a clean run and agree; and a
 * row belonging to another profile, with the identical key, must never be touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const amazon = vi.hoisted(() => ({ keywords: [] as unknown[], campaigns: [] as unknown[], adGroups: [] as unknown[], targetsFail: false }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('./ads-api-client.js', () => ({
  ALL_STATES: ['ENABLED', 'PAUSED', 'ARCHIVED'],
  listCampaignsV3: vi.fn(async () => amazon.campaigns),
  listAdGroupsV3: vi.fn(async () => amazon.adGroups),
  listKeywords: vi.fn(async () => amazon.keywords),
  listTargets: vi.fn(async () => { if (amazon.targetsFail) throw new Error('503 from Amazon'); return [] }),
  listProductAds: vi.fn(async () => []),
}))
vi.mock('./ads-create.service.js', () => ({ verifyCampaignPortfolios: vi.fn(async () => ({ repaired: 0, repairFailed: 0 })) }))
const { runStructuralReconcileOnce } = await import('./ads-structural-reconcile.service.js')

const PROFILE_A = randomUUID()
const PROFILE_B = randomUUID()
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const drift = (entityType: string, entityId: string, field: string) =>
  database.client.adDrift.create({ data: { entityType, entityId, field, ourValue: 'archived', amazonValue: 'enabled', classification: 'EXTERNAL_CHANGE' } })
type Row = { workspaceId: string; entityType: string; entityId: string; field: string; closed: boolean; occurrences: number }
const byKey = (rows: Row[]) => [...rows].sort((x, y) => {
  const kx = [x.workspaceId, x.entityType, x.entityId, x.field].join('|'), ky = [y.workspaceId, y.entityType, y.entityId, y.field].join('|')
  return kx < ky ? -1 : kx > ky ? 1 : 0
})
/** Every AdDrift row in the database, read as the owner (row security bypassed) so both profiles are visible. */
const allRows = async () => byKey((await database.pool.query(
  `SELECT "workspaceId", "entityType", "entityId", field, "resolvedAt" IS NOT NULL AS closed, occurrences FROM "AdDrift"`,
)).rows)

describe.skipIf(!concurrentDatabaseUrl())('structural reconcile closes drift on evidence, per profile, in real PostgreSQL', () => {
  const ids = { campaign: '', group: '', agrees: '', differs: '', unreported: '' }

  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase({ maxConnections: 4 })
    for (const id of [PROFILE_A, PROFILE_B]) {
      await database.pool.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, now())`, [id])
    }
    await inProfile(PROFILE_B, async () => {
      const db = database.client
      await db.amazonAdsConnection.create({ data: { profileId: 'profile-b', marketplace: 'IT', region: 'EU', isActive: true } })
      ids.campaign = (await db.campaign.create({ data: {
        name: 'Boots', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'C-EXT',
        status: 'ENABLED', dailyBudget: 10, startDate: new Date('2026-01-01'),
      } })).id
      const group = await db.adGroup.create({ data: { campaignId: ids.campaign, externalAdGroupId: 'G-EXT', name: 'Group', status: 'ENABLED', defaultBidCents: 50 } })
      ids.group = group.id
      const keyword = (text: string, externalTargetId: string) => db.adTarget.create({ data: {
        adGroupId: group.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, externalTargetId, status: 'ENABLED', bidCents: 50,
      } }).then((t) => t.id)
      ids.agrees = await keyword('boots', 'K1-EXT')
      ids.differs = await keyword('shoes', 'K2-EXT')
      ids.unreported = await keyword('socks', 'K3-EXT')
      await drift('AD_TARGET', ids.agrees, 'state') // agrees again → closes
      await drift('AD_TARGET', ids.differs, 'state') // still differs → stays open
      await drift('AD_TARGET', ids.unreported, 'state') // Amazon did not report state → stays open
      await drift('CAMPAIGN', ids.campaign, 'status') // the settings sync's field; the reconcile compares `state` → stays open
      await drift('CAMPAIGN', ids.campaign, 'name') // compared and agrees → closes
    })
    // Profile A holds a row with the identical key. Profile B's run must not see it, let alone close it.
    await inProfile(PROFILE_A, () => drift('AD_TARGET', ids.agrees, 'state'))

    amazon.campaigns = [{ campaignId: 'C-EXT', name: 'Boots', state: 'ENABLED', budget: { budget: 10 } }]
    amazon.adGroups = [{ adGroupId: 'G-EXT', name: 'Group', state: 'ENABLED', defaultBid: 0.5 }]
    amazon.keywords = [
      { keywordId: 'K1-EXT', keywordText: 'boots', matchType: 'EXACT', state: 'ENABLED', bid: 0.5 },
      { keywordId: 'K2-EXT', keywordText: 'shoes', matchType: 'EXACT', state: 'PAUSED', bid: 0.5 },
      { keywordId: 'K3-EXT', keywordText: 'socks', matchType: 'EXACT', bid: 0.5 },
    ]
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('closes the rows its clean run compared and found agreeing, in its own profile only; an unclean run closes none', async () => {
    const r = await inProfile(PROFILE_B, () => runStructuralReconcileOnce())
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.driftRowsResolved).toBe(2)
    expect(r.driftRowsOpened).toBe(0)
    const b = (entityType: string, entityId: string, field: string, closed: boolean, occurrences = 1): Row => ({ workspaceId: PROFILE_B, entityType, entityId, field, closed, occurrences })
    expect(await allRows()).toEqual(byKey([
      { workspaceId: PROFILE_A, entityType: 'AD_TARGET', entityId: ids.agrees, field: 'state', closed: false, occurrences: 1 },
      b('AD_TARGET', ids.agrees, 'state', true),
      b('AD_TARGET', ids.differs, 'state', false, 2),
      b('AD_TARGET', ids.unreported, 'state', false),
      b('CAMPAIGN', ids.campaign, 'name', true),
      b('CAMPAIGN', ids.campaign, 'status', false),
    ]))

    // A run that could not read everything knows nothing for certain: a row that agrees stays open.
    await inProfile(PROFILE_B, () => drift('AD_GROUP', ids.group, 'name'))
    amazon.targetsFail = true
    const unclean = await inProfile(PROFILE_B, () => runStructuralReconcileOnce())
    expect(unclean.ok).toBe(false)
    expect(unclean.driftRowsResolved).toBe(0)
    expect((await allRows()).filter((x) => x.entityType === 'AD_GROUP')).toEqual([b('AD_GROUP', ids.group, 'name', false)])
  })
})
