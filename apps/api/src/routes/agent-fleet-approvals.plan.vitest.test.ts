/**
 * MCP full control C6 — a change plan on the Approvals page: the routes its card reads and writes.
 *
 *   list     the "outside the fleet" list carries a plan as one row: it can run (canExecute), its Nexus-written
 *            summary, hash and kinds of consequence, and — before anyone clicks — why THIS viewer may not approve it
 *            (a step's tool they lack the permissions of), in the approve's own words
 *   steps    GET …/:id/plan: every step's fate and preview, through the reader's money filter
 *   untick   POST …/:id/plan-amend { keep }: a smaller plan, re-checked as the person; the original superseded
 *
 * The real routes in a Fastify app, on a real PostgreSQL (PGlite); the signed-in person resolved as the workspace hook
 * resolves them.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FEATURES as F } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))

import { resolvePermissions } from '../lib/auth/rbac.js'
import { __test as cryptoTest } from '../lib/crypto.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { queueDetail } from '../services/agent-fleet/approval-queue.service.js'
import { runOrQueueTool } from '../services/agents/approval-gate.service.js'
import type { UserPrincipal } from '../services/agents/call-tool.js'
import { getTool } from '../services/agents/tool-registry.js'
import { sealSecretArgs } from '../services/agents/secret-args.js'
import agentFleetApprovalRoutes from './agent-fleet-approvals.routes.js'
import agentFleetRoutes from './agent-fleet.routes.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const PRICES = ['ai.run', 'ai.view', F.productsView, F.productsPriceEdit]
const EVERYTHING = [...PRICES, F.productsEdit]

let database_ready = false
let app: FastifyInstance
let signedIn = ''
const people: Record<'all' | 'prices', { id: string; principal: UserPrincipal }> = {} as never
const ids = { p1: '', p2: '', plan: '' }

async function person(label: string, permissions: string[]) {
  const db = database.client
  const role = await db.role.create({ data: { key: `PLAN_${randomUUID().slice(0, 8)}`, name: label, description: 'test', permissions, isSystem: false } })
  const user = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label } })
  await db.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return {
    id: user.id,
    principal: { kind: 'user', userId: user.id, label, permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: business, via: 'app' } as UserPrincipal,
  }
}

const get = (who: 'all' | 'prices', url: string) => {
  signedIn = people[who].id
  return app.inject({ method: 'GET', url })
}
const post = (who: 'all' | 'prices', url: string, payload: unknown) => {
  signedIn = people[who].id
  return app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> })
}

beforeAll(async () => {
  database = await formulaDatabase()
  database_ready = true
  // Item 7 — a made-up key for this run only (never a real one); KMS stays unset, so secret arguments use the env key.
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
  vi.stubEnv('NEXUS_KMS_KEY_ID', undefined)
  cryptoTest.resetKeyCache()
  const db = database.client
  people.all = await person('Ana Plan', EVERYTHING)
  people.prices = await person('Pat Prices', PRICES)
  await inside(async () => {
    ids.p1 = (await db.product.create({ data: { sku: 'TEST-CARD-1', name: 'Card jacket', basePrice: '50.00', costPrice: '20.00' } })).id
    ids.p2 = (await db.product.create({ data: { sku: 'TEST-CARD-2', name: 'Card jacket two', basePrice: '60.00' } })).id
    const run = await db.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', via: 'claude', oauthGrantId: 'grant-card' } })
    const queued = await runOrQueueTool('submit-change-plan', {
      title: 'Card plan',
      steps: [
        { tool: 'set-price', args: { productId: ids.p1, price: 52 } },
        { tool: 'apply-content', args: { productId: ids.p2, title: 'Card jacket two, new' } },
        { tool: 'set-price', args: { productId: ids.p2, price: 61 } },
      ],
    }, people.all.principal, run.id, { forceAsk: true })
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    ids.plan = queued.approvalId!
  })

  const workspaces = createWorkspaceService(db as never)
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    void (async () => {
      const user = await db.userProfile.findUniqueOrThrow({
        where: { id: signedIn },
        select: { id: true, email: true, displayName: true, status: true, permissionsVersion: true, roleAssignments: { select: { role: { select: { key: true } } } } },
      })
      const authUser = { ...user, roleKeys: user.roleAssignments.map((a) => a.role.key) }
      const r = request as unknown as Record<string, unknown>
      r.__sessionLoaded = true
      r.authUser = authUser
      if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
        const access = await workspaces.membership(user.id, A)
        r.__rbacResolved = { isOwner: access.isOwner, permissions: access.permissions }
        r.workspace = access.context
      } else {
        r.__rbacResolved = await resolvePermissions(authUser as never)
      }
      withWorkspace(business, done)
    })().catch(done)
  })
  await app.register(agentFleetApprovalRoutes)
  await app.register(agentFleetRoutes)
  await app.ready()
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  cryptoTest.resetKeyCache()
  await app?.close()
  if (database_ready) await database.close()
}, 30_000)

describe('C6 — a change plan on the Approvals page', { timeout: 30_000 }, () => {
  type Row = { id: string; toolName: string; canExecute: boolean; cannotApprove: string | null; plan?: { summary: string; planHash: string; steps: number; kinds: Array<{ tool: string; count: number; outbound: boolean }> } }
  const rowOf = async (who: 'all' | 'prices') =>
    ((await get(who, '/agent/fleet/approvals/outside')).json() as { approvals: Row[] }).approvals.find((a) => a.id === ids.plan)!

  it('one row: it can run, its summary, hash and kinds; whether THIS viewer may approve it, before anyone clicks', async () => {
    const row = await rowOf('all')
    expect(row).toMatchObject({
      toolName: 'submit-change-plan',
      canExecute: true,
      cannotApprove: null,
      plan: { summary: expect.stringContaining('3 changes'), planHash: expect.stringMatching(/^[0-9a-f]{64}$/), steps: 3 },
    })
    expect(row.plan!.kinds).toEqual([
      expect.objectContaining({ tool: 'set-price', count: 2, outbound: true }),
      expect.objectContaining({ tool: 'apply-content', count: 1, outbound: false }),
    ])
    expect((await rowOf('prices')).cannotApprove).toBe('Approving this plan needs what each of its steps needs: apply-content needs the products.edit permission.')
  })

  it('its steps, each through the reader’s own money filter', async () => {
    const all = (await get('all', `/agent/fleet/approvals/${ids.plan}/plan`)).json() as { title: string; steps: number; list: Array<Record<string, unknown>> }
    expect(all).toMatchObject({ title: 'Card plan', steps: 3, byStatus: { pending: 3 } })
    expect(all.list.map((s) => [s.step, s.tool, s.status, s.outbound])).toEqual([[1, 'set-price', 'pending', true], [2, 'apply-content', 'pending', false], [3, 'set-price', 'pending', true]])
    expect(all.list[0].preview).toMatchObject({ action: 'set-price', changes: { 'base price': { from: 50, to: 52 } } })
    // Approvals grid: each step also carries its change in the grid's own words (the master currency), not 50 → 52.
    expect(all.list[0]).toMatchObject({ changes: [{ label: 'Base price', from: '€50.00', to: '€52.00' }], changeCount: 1 })
    const prices = (await get('prices', `/agent/fleet/approvals/${ids.plan}/plan`)).json() as { list: Array<Record<string, unknown>> }
    expect(prices.list[1]).toMatchObject({ preview: null, previewHidden: expect.stringContaining('apply-content') })
    expect(prices.list[1].changes).toBeUndefined() // a hidden step's words stay hidden
    expect(prices.list[0].preview).toMatchObject({ action: 'set-price' })
    expect((await get('all', '/agent/fleet/approvals/no-such-plan/plan')).statusCode).toBe(404)
  })

  it('unticking steps makes a smaller plan, re-checked as the person; the original is superseded', async () => {
    const refused = await post('all', `/agent/fleet/approvals/${ids.plan}/plan-amend`, { keep: [1, 2, 3] })
    expect(refused.statusCode).toBe(400)
    const amended = await post('all', `/agent/fleet/approvals/${ids.plan}/plan-amend`, { keep: [1, 3] })
    expect(amended.statusCode, amended.body).toBe(200)
    const out = amended.json() as { approvalId: string; supersededId: string }
    expect(out.supersededId).toBe(ids.plan)
    const smaller = (await get('all', `/agent/fleet/approvals/${out.approvalId}/plan`)).json() as { steps: number; list: Array<{ tool: string }> }
    expect(smaller.steps).toBe(2)
    expect(smaller.list.map((s) => s.tool)).toEqual(['set-price', 'set-price'])
    const old = await inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: ids.plan } }))
    expect(old).toMatchObject({ status: 'superseded', decidedBy: 'Ana Plan' })
    // A person who may not ask for every step they keep is refused by the re-check.
    const next = (await get('all', '/agent/fleet/approvals/outside')).json() as { approvals: Row[] }
    expect(next.approvals.some((a) => a.id === ids.plan)).toBe(false)
  })
})

/*
 * Owner item 7 — a secret argument (create-meta-boost's creator ad code) on the Approvals page. set-price stands in for
 * create-meta-boost (Meta is not reachable here): for these tests only, its price is declared a secret argument.
 */
describe('Item 7 — a secret argument on the Approvals page: the mask in the list and the edit form; an edit and an untick keep it sealed', { timeout: 30_000 }, () => {
  const SEALED = { __enc: expect.stringMatching(/^v1:/) }
  async function withSecretPrice<T>(work: () => Promise<T>): Promise<T> {
    const tool = getTool('set-price')!
    const before = tool.secretArgs
    tool.secretArgs = ['price']
    try {
      return await work()
    } finally {
      tool.secretArgs = before
    }
  }
  const queue = (tool: string, args: Record<string, unknown>) => inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', via: 'claude', oauthGrantId: 'grant-card' } })
    const queued = await runOrQueueTool(tool, args, people.all.principal, run.id, { forceAsk: true })
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    return queued.approvalId!
  })
  const approval = (id: string) => inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id } }))

  it('one request: the list and the edit form show the mask; an edit stores it sealed, and its audit keeps the mask', async () => {
    await withSecretPrice(async () => {
      const id = await queue('set-price', { productId: ids.p1, price: 55 })
      expect((await approval(id)).args).toEqual({ productId: ids.p1, price: SEALED })
      const rows = ((await get('all', '/agent/fleet/approvals/outside')).json() as { approvals: Array<{ id: string; args: unknown }> }).approvals
      expect(rows.find((a) => a.id === id)!.args).toEqual({ productId: ids.p1, price: '[redacted]' })
      expect((await inside(() => queueDetail(id, people.all.principal)))!.editArgs).toEqual({ productId: ids.p1, price: '[redacted]' })

      // An edit that brings the secret in plain text: checked by the tool's own dry run, stored sealed.
      const edited = await post('all', `/agent/fleet/approvals/${id}/amend`, { args: { price: 56 } })
      expect(edited.statusCode, edited.body).toBe(200)
      const first = await approval((edited.json() as { approvalId: string }).approvalId)
      expect(first).toMatchObject({ args: { productId: ids.p1, price: SEALED }, preview: { changes: { 'base price': { from: 50, to: 56 } } } })
      const audit = await inside(() => database.client.agentControlAudit.findFirstOrThrow({ where: { charterKey: 'operator-edit', action: 'amend_action' }, orderBy: { createdAt: 'desc' } }))
      expect(audit).toMatchObject({ fromValue: { approvalId: id, args: { price: '[redacted]' } }, toValue: { approvalId: first.id, args: { price: '[redacted]' } } })

      // An edit that leaves the secret alone: its dry run opened the sealed value (the preview shows it), which stays as it was.
      const moved = await post('all', `/agent/fleet/approvals/${first.id}/amend`, { args: { productId: ids.p2 } })
      expect(moved.statusCode, moved.body).toBe(200)
      const second = await approval((moved.json() as { approvalId: string }).approvalId)
      expect(second.args).toEqual({ productId: ids.p2, price: (first.args as { price: unknown }).price })
      expect(second.preview).toMatchObject({ changes: { 'base price': { from: 60, to: 56 } } })
    })
  })

  it('unticking steps of a plan: the smaller plan keeps each kept step\'s sealed value as it was, its dry run opened it', async () => {
    await withSecretPrice(async () => {
      const id = await queue('submit-change-plan', {
        title: 'Secret card plan',
        steps: [{ tool: 'set-price', args: { productId: ids.p1, price: 57 } }, { tool: 'set-price', args: { productId: ids.p2, price: 58 } }],
      })
      const stepsOf = (approvalId: string) => inside(() => database.client.agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' } }))
      const before = await stepsOf(id)
      expect(before.map((step) => step.args)).toEqual([{ productId: ids.p1, price: SEALED }, { productId: ids.p2, price: SEALED }])
      const amended = await post('all', `/agent/fleet/approvals/${id}/plan-amend`, { keep: [2] })
      expect(amended.statusCode, amended.body).toBe(200)
      const after = await stepsOf((amended.json() as { approvalId: string }).approvalId)
      expect(after.map((step) => step.args)).toEqual([before[1]!.args])
      expect(after[0]!.preview).toMatchObject({ changes: { 'base price': { from: 60, to: 58 } } })
    })
  })

  it('the fleet inbox (GET /agent/fleet/approvals, decided and expired list every tool): a creator ad code as the mask, sealed or plain', async () => {
    const boost = getTool('create-meta-boost')!
    const rows = await inside(async () => {
      const db = database.client
      const run = await db.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', via: 'claude' } })
      const row = (args: Record<string, unknown>, status: string) => db.agentApproval.create({
        data: { agentRunId: run.id, toolName: 'create-meta-boost', riskTier: 'high', args: args as never, preview: {}, status, decidedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
      })
      const sealed = await sealSecretArgs(boost, { source: 'creator-instagram-code', adCode: 'CODE_NEW_SEALED', name: 'Creator boost' }, A)
      return {
        sealed: await row(sealed, 'rejected'),
        plain: await row({ source: 'creator-instagram-code', adCode: 'CODE_OLD_PLAIN', name: 'Creator boost' }, 'executed'),
        expired: await row({ source: 'creator-instagram-code', adCode: 'CODE_OLD_EXPIRED' }, 'expired'),
      }
    })
    expect((rows.sealed.args as { adCode: unknown }).adCode).toEqual(SEALED)
    const decided = await get('all', '/agent/fleet/approvals?view=decided')
    expect(decided.statusCode, decided.body).toBe(200)
    const listed = (decided.json() as { approvals: Array<{ id: string; args: unknown }> }).approvals
    expect(listed.find((a) => a.id === rows.sealed.id)!.args).toEqual({ source: 'creator-instagram-code', adCode: '[redacted]', name: 'Creator boost' })
    expect(listed.find((a) => a.id === rows.plain.id)!.args).toEqual({ source: 'creator-instagram-code', adCode: '[redacted]', name: 'Creator boost' })
    const expired = await get('all', '/agent/fleet/approvals?view=expired')
    expect((expired.json() as { approvals: Array<{ id: string; args: unknown }> }).approvals.find((a) => a.id === rows.expired.id)!.args)
      .toEqual({ source: 'creator-instagram-code', adCode: '[redacted]' })
    for (const body of [decided.body, expired.body]) expect(body).not.toMatch(/CODE_NEW_SEALED|CODE_OLD_PLAIN|CODE_OLD_EXPIRED/)
    expect(JSON.stringify(listed.filter((a) => a.id === rows.sealed.id))).not.toContain('__enc')
  })

  it('a sealed value copied from another business: the edit and the untick answer 409 in words, nothing is stored or superseded', async () => {
    await withSecretPrice(async () => {
      const fromB = await sealSecretArgs(getTool('set-price')!, { price: 59 }, 'business-b-test')
      const words = /set-price: its secret argument price does not belong to this request \(it was sealed for another tool, argument or business profile\)\. Nothing was run\./
      // An edit that brings it in.
      const one = await queue('set-price', { productId: ids.p1, price: 54 })
      const edited = await post('all', `/agent/fleet/approvals/${one}/amend`, { args: { price: fromB.price } })
      expect(edited.statusCode, edited.body).toBe(409)
      expect((edited.json() as { error: string }).error).toMatch(words)
      expect((await approval(one)).status).toBe('pending')
      // A plan whose kept step carries it (as a row copied in): the smaller plan is refused, the plan still waits.
      const id = await queue('submit-change-plan', {
        title: 'Secret plan, copied',
        steps: [{ tool: 'set-price', args: { productId: ids.p1, price: 57 } }, { tool: 'set-price', args: { productId: ids.p2, price: 58 } }],
      })
      await inside(() => database.client.agentPlanStep.updateMany({ where: { approvalId: id, position: 2 }, data: { args: { productId: ids.p2, price: fromB.price } as never } }))
      const amended = await post('all', `/agent/fleet/approvals/${id}/plan-amend`, { keep: [2] })
      expect(amended.statusCode, amended.body).toBe(409)
      expect(amended.json()).toMatchObject({ refusals: [{ step: 1, tool: 'set-price', status: 409, error: expect.stringMatching(words) }] })
      expect((await approval(id)).status).toBe('pending')
      // One that does not decrypt at all: the same 409, in words, never a 500.
      await inside(() => database.client.agentPlanStep.updateMany({ where: { approvalId: id, position: 2 }, data: { args: { productId: ids.p2, price: { __enc: 'v1:AAAA.BBBB.CCCC' } } as never } }))
      const broken = await post('all', `/agent/fleet/approvals/${id}/plan-amend`, { keep: [2] })
      expect(broken.statusCode, broken.body).toBe(409)
      expect((broken.json() as { error: string }).error).toMatch(/set-price: its secret argument price could not be decrypted \(bad_format\)\. Nothing was run\./)
    })
  })

  it('a run\'s steps (GET /agent/fleet/runs/:id/steps), an in-app run written before item 7: a step\'s plain creator ad code as the mask', async () => {
    const steps = [
      { type: 'tool', name: 'create-meta-boost', args: { source: 'creator-instagram-code', adCode: 'CODE_LEGACY_STEP', name: 'Creator boost' }, result: { ok: true }, ms: 1 },
      { type: 'tool', name: 'set-price', args: { productId: ids.p1, price: 52 }, result: { ok: true }, ms: 1 },
    ]
    const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'copilot', trigger: 'manual', status: 'done', steps } }))
    expect(run.mode).toBeNull() // the legacy shape: the steps Json, not AgentStep rows
    const answer = await get('all', `/agent/fleet/runs/${run.id}/steps`)
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json()).toEqual({
      shape: 'legacy-json',
      steps: [{ ...steps[0], args: { source: 'creator-instagram-code', adCode: '[redacted]', name: 'Creator boost' } }, steps[1]],
    })
    expect(answer.body).not.toContain('CODE_LEGACY_STEP')
  })

  it('editing a request stored before item 7 (its secret plain) while no encryption key is set up: 503 in words, nothing stored, no value named', async () => {
    await withSecretPrice(async () => {
      const id = await inside(async () => {
        const db = database.client
        const run = await db.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', via: 'claude' } })
        // As a request was stored before item 7: the secret argument in plain text.
        return (await db.agentApproval.create({
          data: { agentRunId: run.id, toolName: 'set-price', riskTier: 'high', args: { productId: ids.p1, price: 53.17 }, preview: {}, status: 'pending', expiresAt: new Date(Date.now() + 3_600_000) },
        })).id
      })
      const rows = () => inside(() => database.client.agentApproval.count())
      const before = await rows()
      const key = process.env.NEXUS_CREDENTIAL_ENC_KEY // this run's made-up key (beforeAll), put back below
      vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', undefined)
      cryptoTest.resetKeyCache()
      try {
        const edited = await post('all', `/agent/fleet/approvals/${id}/amend`, { args: { price: 54.29 } })
        expect(edited.statusCode, edited.body).toBe(503)
        expect(edited.json()).toEqual({ error: 'set-price: Nexus could not encrypt its secret argument price (no encryption key is set up), so the request was not stored.' })
        expect(edited.body).not.toMatch(/53\.17|54\.29/)
      } finally {
        vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', key)
        cryptoTest.resetKeyCache()
      }
      // Nothing stored: no new request (plain or sealed), and the one edited still waits as it was.
      expect(await rows()).toBe(before)
      expect(await approval(id)).toMatchObject({ status: 'pending', args: { productId: ids.p1, price: 53.17 } })
    })
  })
})
