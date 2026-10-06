/**
 * ADS AUTONOMY W1-4 — the Approvals page says why a Claude ad request waits when the ads strategy holds it below the
 * business's level for its kind (W1-8 narrows each change where it lands; confirm-change refuses it then). The row used
 * to say "Confirm in Claude" for a request Claude could no longer confirm. On PGlite with the production schema and
 * business policies, business profiles ON. Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { QueueRow } from '@nexus/shared/approval-queue'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { queuePage } from './approval-queue.service.js'
import type { ToolPrincipal } from '../agents/call-tool.js'

const A = 'w14_queue_alpha'
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inA = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ids = { inIt: '', inUk: '', other: '' }
let viewer: ToolPrincipal

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await inA(async () => {
    const c = database.client
    await seedAdsFixture(c)
    const product = await c.product.create({ data: { sku: 'TEST-W14-P1', name: 'Test helmet', basePrice: '10.00' } })
    await c.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: product.id, asin: 'B0TESTW141' } })
    // The business lets Claude confirm bids in Claude; the IT market strategy lets Claude only ask.
    await c.agentTool.create({ data: { name: 'set-target-bid', riskTier: 'high', requiresApproval: true, claudeTrust: 'confirm' } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', claudeAutonomy: { bid: 'ask' }, updatedBy: 'user:test' } })
    const user = await c.userProfile.create({ data: { email: 'w14-queue@example.test', status: 'active', displayName: 'Quinn Queue' } })
    viewer = { kind: 'user', userId: user.id, label: 'Quinn Queue', permissions: { isOwner: true, permissions: new Set() }, workspace: business, via: 'app' } as unknown as ToolPrincipal
    const run = await c.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval', via: 'claude', userId: user.id } })
    const ask = (targetId: string, toolName = 'set-target-bid') => c.agentApproval.create({
      data: {
        agentRunId: run.id, toolName, status: 'pending', riskTier: 'high', expiresAt: new Date(Date.now() + 86_400_000),
        args: { targetId, proposedBidCents: 52 },
        preview: { action: toolName, target: { id: targetId, expression: 'race jacket', matchType: 'EXACT' }, currentBidCents: 45, proposedBidCents: 52, currency: 'EUR' },
      },
    })
    ids.inIt = (await ask('t-it')).id
    ids.inUk = (await ask('t-uk')).id
  })
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

const rowOf = async (id: string): Promise<QueueRow> => {
  const page = await inA(() => queuePage({ show: 'open', limit: '50' }, viewer))
  return page.rows.find((r) => r.id === id)!
}

describe('W1-4 — why a Claude ad request waits, when the ads strategy narrows it', () => {
  it('held to Ask me by the IT strategy: says so and names the row, never "Confirm in Claude"', async () => {
    const row = await rowOf(ids.inIt)
    expect(row.automation.level).toBe('confirm')
    expect(row.automation.whyWaits).toBe(
      'The ads strategy lets Claude only ask for bid changes here (IT: market "Test market (IT)", version 1; the business\'s own level is confirm in Claude): you approve it here',
    )
    expect(row.note).toBe(row.automation.whyWaits)
    expect(row.automation.whyWaits).not.toContain('Confirm in Claude —')
  })

  it('a market the strategy says nothing about: the business\'s own rule, as before', async () => {
    const row = await rowOf(ids.inUk)
    expect(row.automation.whyWaits).toBe("Your rule for Change a target's bid: Confirm in Claude — the person who asked can confirm it with their code, or you approve it here")
  })
})
