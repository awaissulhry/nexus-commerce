/**
 * MCP full control C6 — a change plan of 200 steps on a REAL PostgreSQL: the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs with the production schema and row-level policies, the app connected as the
 * restricted runtime login, several connections at once (PGlite has one, so it cannot show a race).
 *
 *   1. Claude submits 200 price changes as one plan: every step dry-run as the person, ONE approval, 200 step rows.
 *   2. A person approves it; after the window the commit hands it over. One product's price is moved meanwhile. A worker
 *      runs 120 steps and stops; two workers then resume AT ONCE. Every step runs exactly once (one change each, each
 *      product at its target), the moved one is skipped with its reason, and the plan ends executed.
 *
 * Business profiles are ON for the whole file, as production runs.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ALL_PERMISSIONS } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))

import { commitScheduledApproval, decideFleetApproval } from '../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../mcp/mcp-auth.js'
import { runToolForClaude } from '../mcp/mcp-tool-call.js'
import type { UserPrincipal } from './call-tool.js'
import { runPlan } from './change-plan.service.js'
import { getTool } from './tool-registry.js'

const RUN = randomBytes(5).toString('hex')
const A = `c6_plan_${RUN}`
const NAME = 'Plan load business'
const STEPS = 200
const STALE = 49 // the 50th product
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const rowsOf = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]

const products: string[] = []
let personId = ''
let approvalId = ''
const permissions = { isOwner: false, permissions: new Set<string>(ALL_PERMISSIONS) }

describe.skipIf(!concurrentDatabaseUrl())('C6 — a 200-step change plan on real PostgreSQL', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
    vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
    vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
    database = await concurrentDatabase()
    const db = database.client
    const person = await db.userProfile.create({ data: { email: `c6-${RUN}@example.test`, status: 'active', displayName: 'Lou Load' } })
    personId = person.id
    await db.workspace.create({ data: { id: A, name: NAME, createdByUserId: personId, creationKey: randomUUID() } })
    const role = await db.role.create({ data: { workspaceId: A, key: `business_${randomUUID()}`, name: 'C6 everything', description: 'test', permissions: ALL_PERMISSIONS } })
    await db.workspaceMembership.create({ data: { workspaceId: A, userId: personId, status: 'active', roles: { create: [{ roleId: role.id }] } } })
    await inside(async () => {
      for (let i = 0; i < STEPS; i++) {
        products.push((await db.product.create({ data: { sku: `TEST-LOAD-${RUN}-${i}`, name: `Load jacket ${i}`, basePrice: '100.00' } })).id)
      }
    })
  }, 300_000)

  afterAll(async () => {
    await database?.close()
    vi.unstubAllEnvs()
  }, 120_000)

  const claude = (): McpPrincipal => ({
    kind: 'user', userId: personId, label: 'Lou Load', permissions, workspace: business, business: { id: A, name: NAME },
    via: 'claude', oauthGrantId: `grant-${RUN}`, scopes: ['nexus.read', 'nexus.write'],
  }) as McpPrincipal
  const person = (): UserPrincipal => ({ kind: 'user', userId: personId, label: 'Lou Load', permissions, workspace: business, via: 'app' })

  it(`Claude submits ${STEPS} price changes as ONE plan: one approval, ${STEPS} steps, nothing changed yet`, async () => {
    const steps = products.map((productId) => ({ tool: 'set-price', args: { productId, price: 101 } }))
    const result = await runToolForClaude(claude(), getTool('submit-change-plan')!, { title: 'Load plan', steps, business: NAME })
    const answer = JSON.parse((result.content as Array<{ text: string }>).map((block) => block.text).join(''))
    expect(result.isError, JSON.stringify(answer).slice(0, 300)).toBeFalsy()
    expect(answer).toMatchObject({ status: 'waiting_for_approval', plan: { steps: STEPS, summary: expect.stringContaining(`${STEPS} changes`) } })
    expect(answer.preview.steps).toHaveLength(20)
    expect(answer.preview.moreSteps).toBe(STEPS - 20)
    approvalId = answer.approvalId
    const [counts] = await rowsOf<{ steps: number; approvals: number }>(
      `SELECT (SELECT count(*)::int FROM "AgentPlanStep" WHERE "approvalId" = $1 AND "workspaceId" = $2) AS steps,
              (SELECT count(*)::int FROM "AgentApproval" WHERE "toolName" = 'submit-change-plan' AND "workspaceId" = $2) AS approvals`,
      [approvalId, A],
    )
    expect(counts).toEqual({ steps: STEPS, approvals: 1 })
    const [unchanged] = await rowsOf<{ n: number }>(`SELECT count(*)::int AS n FROM "Product" WHERE "workspaceId" = $1 AND "basePrice" = 100`, [A])
    expect(unchanged.n).toBe(STEPS)
  })

  it('approved once; a stopped worker resumes, two workers at once run every step exactly once, and the moved one is skipped', async () => {
    expect(await inside(() => decideFleetApproval({ id: approvalId, decision: 'approve', actor: person() }))).toMatchObject({ ok: true, status: 'scheduled' })
    await rowsOf(`UPDATE "AgentApproval" SET "executeAfter" = now() - interval '1 second' WHERE id = $1`, [approvalId])
    expect(await inside(() => commitScheduledApproval(approvalId))).toMatchObject({ ok: true, status: 'executing' })
    // Someone moves one product while the plan waits to run.
    await rowsOf(`UPDATE "Product" SET "basePrice" = 150 WHERE id = $1`, [products[STALE]])

    const first = await inside(() => runPlan(approvalId, { maxSteps: 120 }))
    expect(first).toMatchObject({ ran: 120, finished: false })
    // The worker restarts — twice over, as two workers would.
    const [x, y] = await Promise.all([inside(() => runPlan(approvalId)), inside(() => runPlan(approvalId))])
    expect(x.ran + y.ran).toBe(STEPS - 120)
    expect(x.finished || y.finished).toBe(true)

    const steps = await rowsOf<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM "AgentPlanStep" WHERE "approvalId" = $1 GROUP BY status ORDER BY status`,
      [approvalId],
    )
    expect(steps).toEqual([{ status: 'done', n: STEPS - 1 }, { status: 'skipped', n: 1 }])
    const [skipped] = await rowsOf<{ position: number; reason: string }>(`SELECT position, reason FROM "AgentPlanStep" WHERE "approvalId" = $1 AND status = 'skipped'`, [approvalId])
    expect(skipped).toMatchObject({ position: STALE + 1, reason: expect.stringMatching(/^not run — /) })
    // Exactly one change per step that ran, and every product at its target (the moved one left as it was).
    const [changes] = await rowsOf<{ n: number; steps: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT "planStepId")::int AS steps FROM "AgentChange" WHERE "approvalId" = $1`,
      [approvalId],
    )
    expect(changes).toEqual({ n: STEPS - 1, steps: STEPS - 1 })
    const prices = await rowsOf<{ price: string; n: number }>(
      `SELECT "basePrice"::text AS price, count(*)::int AS n FROM "Product" WHERE "workspaceId" = $1 GROUP BY 1 ORDER BY 1`,
      [A],
    )
    expect(prices).toEqual([{ price: '101.00', n: STEPS - 1 }, { price: '150.00', n: 1 }])
    const [approval] = await rowsOf<{ status: string; reason: string }>(`SELECT status, reason FROM "AgentApproval" WHERE id = $1`, [approvalId])
    expect(approval).toMatchObject({ status: 'executed', reason: expect.stringContaining(`${STEPS - 1} of ${STEPS} changes ran; 1 skipped`) })
  })
})
