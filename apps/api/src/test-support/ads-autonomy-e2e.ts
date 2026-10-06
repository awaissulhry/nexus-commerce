/**
 * ADS AUTONOMY final test — the door the end-to-end suites drive (ads-playbook/e2e-autonomy-*.vitest.test.ts): Claude's
 * MCP door (runToolForClaude, exactly as /mcp calls a tool), the Approvals page's own route (POST
 * /agent/fleet/approvals/:id/decide, with a real authenticator code where a change needs one) and the commit that runs an
 * approved change after its undo window — for TWO businesses, each with its own Claude connection. Business profiles
 * are ON (NEXUS_WORKSPACES_ENABLED=1), as in production, so every row read or written goes through row-level security.
 *
 *   A   the legacy business (the one production started with); its Owner asks Claude and approves in Nexus
 *   B   a second business of the same Owner, with its own Claude connection
 *
 * The suites declare their vi.mock lines themselves (the database, the job queue, Amazon's ads client, the e-mail
 * transport); this module only wires people, businesses and the door. Values are made up (public repo).
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { __stepUpTest } from '../lib/auth/step-up.js'
import { commitScheduledApproval } from '../services/agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../services/mcp/mcp-auth.js'
import { runToolForClaude } from '../services/mcp/mcp-tool-call.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { setClaudeRule } from '../services/agents/claude-trust.service.js'
import { getTool } from '../services/agents/tool-registry.js'
import type { UserPrincipal } from '../services/agents/call-tool.js'
import agentFleetRoutes from '../routes/agent-fleet.routes.js'

export const A = LEGACY_WORKSPACE_ID
export const B = 'e2e_ads_bravo'
export type Biz = typeof A | typeof B
export type Who = 'owner' | 'manager'
type Json = Record<string, any>
type Database = { client: any }

export const EVERYTHING = [...Object.values(F), ...Object.values(FIELDS)] as string[]
export const scopeOf = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] as string[] })

export interface Door {
  people: Record<Who, { id: string; secret: string; label: string }>
  names: Record<Biz, string>
  /** Run work inside one business (row-level security on). */
  inside<T>(work: () => Promise<T>, biz?: Biz): Promise<T>
  /** Claude's connection for one business, as the Owner (or the manager) signed it in. */
  claude(biz?: Biz, who?: Who): McpPrincipal
  /** A person in Nexus (the app), for services that take a principal. */
  person(biz?: Biz, who?: Who): UserPrincipal
  /** One tool call through Claude's MCP door, the business named as the door requires. */
  call(tool: string, args: Record<string, unknown>, opts?: { biz?: Biz; who?: Who; business?: string }): Promise<{ isError: boolean; answer: Json }>
  /** The Approvals page's decide route, signed in as a person of that business; `code: true` types their fresh code. */
  decide(approvalId: string, opts?: { biz?: Biz; who?: Who; code?: boolean | string; decision?: 'approve' | 'reject' }): Promise<{ status: number; body: Json }>
  /** One request to the Approvals page's routes, signed in as a person of that business. */
  post(url: string, payload?: Record<string, unknown>, opts?: { biz?: Biz; who?: Who }): Promise<{ status: number; body: Json }>
  /** A person stops a change that runs by rule inside its window (the Approvals page's Stop: undo, then reject). */
  stop(approvalId: string, opts?: { biz?: Biz; who?: Who }): Promise<{ status: number; body: Json }>
  /** Runs a scheduled approval now (its undo window passed), as the sweep does. */
  commit(approvalId: string, biz?: Biz): Promise<{ ok: boolean; status?: string; error?: string }>
  /** decide (approve) + commit. Throws when the decide is refused. */
  approve(approvalId: string, opts?: { biz?: Biz; who?: Who; code?: boolean }): Promise<{ ok: boolean; status?: string; error?: string }>
  /** The business's rule for one Claude tool (level, limits), set by the Owner with his code. */
  rule(tool: string, patch: { level?: string; limits?: Record<string, unknown> | null }, biz?: Biz): Promise<Json>
  codeOf(who?: Who): string
  close(): Promise<void>
}

export async function e2eDoor(database: Database): Promise<Door> {
  const c = database.client
  const people = {} as Door['people']
  const workspaceCreator = await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test creator' } })
  await c.workspace.create({ data: { id: B, name: 'Bravo test business', createdByUserId: workspaceCreator.id, creationKey: randomUUID() } })
  const names = {
    [A]: (await c.workspace.findUniqueOrThrow({ where: { id: A } })).name,
    [B]: (await c.workspace.findUniqueOrThrow({ where: { id: B } })).name,
  } as Record<Biz, string>

  async function person(who: Who, label: string, permissions: string[], businesses: Biz[]) {
    const role = await c.role.create({ data: { key: `E2E_${randomUUID().slice(0, 8)}`, name: label, description: 'test', isSystem: false, permissions } })
    const secret = generateSecret()
    const user = await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label, twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })
    await c.userRole.create({ data: { userId: user.id, roleId: role.id } })
    for (const workspaceId of businesses) {
      const membership = await c.workspaceMembership.create({ data: { workspaceId, userId: user.id, status: 'active' } })
      await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
    }
    people[who] = { id: user.id, secret, label }
  }
  await person('owner', 'Olga Owner', EVERYTHING, [A, B])
  await person('manager', 'Max Manager', EVERYTHING.filter((p) => p !== F.settingsSecurityManage), [A])

  const inside = <T>(work: () => Promise<T>, biz: Biz = A) => withWorkspace(scopeOf(biz), work)
  const codeOf = (who: Who = 'owner') => generateSync({ secret: people[who].secret })
  const claude = (biz: Biz = A, who: Who = 'owner'): McpPrincipal => ({
    kind: 'user', userId: people[who].id, label: people[who].label, permissions: { isOwner: false, permissions: new Set(EVERYTHING) },
    workspace: scopeOf(biz), business: { id: biz, name: names[biz] }, via: 'claude', oauthGrantId: `grant-${who}-${biz}`, scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as unknown as McpPrincipal)
  const personOf = (biz: Biz = A, who: Who = 'owner'): UserPrincipal => ({
    kind: 'user', userId: people[who].id, label: people[who].label, permissions: { isOwner: false, permissions: new Set(EVERYTHING) }, workspace: scopeOf(biz), via: 'app',
  } as UserPrincipal)

  // The Approvals page: the signed-in person and the business their session is in.
  let signed = { userId: '', workspaceId: A as string }
  const workspaces = createWorkspaceService(c as never)
  const app: FastifyInstance = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    void (async () => {
      const user = await c.userProfile.findUniqueOrThrow({
        where: { id: signed.userId },
        select: { id: true, email: true, displayName: true, status: true, permissionsVersion: true, roleAssignments: { select: { role: { select: { key: true } } } } },
      })
      const authUser = { ...user, roleKeys: user.roleAssignments.map((x: { role: { key: string } }) => x.role.key) }
      const r = request as unknown as Record<string, unknown>
      r.__sessionLoaded = true
      r.authUser = authUser
      const access = await workspaces.membership(user.id, signed.workspaceId)
      r.__rbacResolved = { isOwner: access.isOwner, permissions: access.permissions }
      r.workspace = access.context
      withWorkspace(scopeOf(signed.workspaceId), done)
    })().catch(done)
  })
  await app.register(agentFleetRoutes)
  await app.ready()

  const door: Door = {
    people, names, inside, codeOf, claude, person: personOf,
    async call(tool, args, opts = {}) {
      const biz = opts.biz ?? A
      const t = getTool(tool)
      if (!t) throw new Error(`no tool ${tool}`)
      const result = await runToolForClaude(claude(biz, opts.who ?? 'owner'), t, { ...args, business: opts.business ?? names[biz] })
      const text = (result.content as Array<{ text: string }>).map((b) => b.text).join('')
      let answer: Json
      try { answer = JSON.parse(text) } catch { answer = { text } }
      return { isError: !!result.isError, answer }
    },
    async decide(approvalId, opts = {}) {
      signed = { userId: people[opts.who ?? 'owner'].id, workspaceId: opts.biz ?? A }
      // One code per decision, as a person types it (the verifier refuses a replayed code within its window).
      __stepUpTest.reset()
      const code = opts.code === true ? codeOf(opts.who ?? 'owner') : typeof opts.code === 'string' ? opts.code : undefined
      const out = await app.inject({ method: 'POST', url: `/agent/fleet/approvals/${approvalId}/decide`, payload: { decision: opts.decision ?? 'approve', ...(code ? { code } : {}) } })
      let body: Json
      try { body = out.json() } catch { body = { text: out.body } }
      return { status: out.statusCode, body }
    },
    async post(url, payload = {}, opts = {}) {
      signed = { userId: people[opts.who ?? 'owner'].id, workspaceId: opts.biz ?? A }
      const out = await app.inject({ method: 'POST', url, payload })
      let body: Json
      try { body = out.json() } catch { body = { text: out.body } }
      return { status: out.statusCode, body }
    },
    async stop(approvalId, opts = {}) {
      const undone = await door.post(`/agent/fleet/approvals/${approvalId}/undo`, {}, opts)
      if (undone.status !== 200) return undone
      return door.decide(approvalId, { ...opts, decision: 'reject' })
    },
    async commit(approvalId, biz = A) {
      await inside(() => c.agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }), biz)
      return inside(() => commitScheduledApproval(approvalId), biz)
    },
    async approve(approvalId, opts = {}) {
      const decided = await door.decide(approvalId, opts)
      if (decided.status !== 200) throw new Error(`decide ${approvalId}: ${decided.status} ${JSON.stringify(decided.body)}`)
      return door.commit(approvalId, opts.biz ?? A)
    },
    async rule(tool, patch, biz = A) {
      __stepUpTest.reset()
      const out = await inside(() => setClaudeRule({ userId: people.owner.id, label: people.owner.label, canManage: true }, tool, { ...patch, code: codeOf() } as never), biz)
      return out as Json
    },
    async close() { await app.close() },
  }
  return door
}
