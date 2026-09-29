/**
 * MCP.7 — the /mcp endpoint, end to end: the real route inside a Fastify app with the API's own
 * global hooks (workspace, RBAC in enforce mode, money filter, compression), on a real PostgreSQL
 * with the production schema and business policies (PGlite). Tokens come from the real OAuth
 * server functions; Claude's side is the MCP SDK's own client over Streamable HTTP.
 *
 * The promises: nothing answers while the switch is off; only a valid token gets in, and the
 * business comes from it alone; Claude is offered the person's tools minus the AI drafts, each
 * described in full; a read-only connection cannot ask for a change; a change is only ever
 * queued for a person, and every call leaves a run that says it came from Claude.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import compress from '@fastify/compress'
import cookie from '@fastify/cookie'
import { generateSecret, generateSync } from 'otplib'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { Client, InsufficientScopeError, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client'
import { __stepUpTest } from '../lib/auth/step-up.js'
import { generateToken } from '../lib/auth/tokens.js'
import { financialFilterHook } from '../lib/auth/field-filter.js'
import { rbacHook } from '../lib/auth/rbac-hook.js'
import { workspaceHook } from '../lib/workspace-hook.js'
import { registerClient } from '../services/oauth/oauth-clients.js'
import { consent, exchangeCode, revokeGrant } from '../services/oauth/oauth-server.js'
import { inputJsonSchema } from '../services/agents/tool-loop.service.js'
import { listTools } from '../services/agents/tool-registry.js'
import { __toolRateTest } from '../services/agents/tool-rate.js'
import mcpRoutes from './mcp.routes.js'

const A = LEGACY_WORKSPACE_ID
const B = 'mcp_endpoint_business_bravo'
const API = 'https://api.example.test'
const WEB = 'https://web.example.test'
const METADATA_URL = `${API}/.well-known/oauth-protected-resource/mcp`
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const AI_DRAFTS = ['draft-alt-text', 'draft-listing-content', 'draft-seo', 'translate-content', 'draft-customer-message']

let app: FastifyInstance
let url: string
let secret: string
let operatorId: string
let readerId: string
const clients: Record<string, string> = {}
const ids = { productA: '', productB: '', approvalB: '' }

/** Tokens per connection; each is a separate grant (one per person, business and app). */
const tokens: Record<'full' | 'readOnly' | 'reader' | 'bare' | 'revoked', { access: string; grantId: string }> = {} as never

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const challengeOf = (value: string) => createHash('sha256').update(value).digest('base64url')

/** Approve in the browser and swap the code, as Claude would. */
async function connect(userId: string, app: string, scopes: string[]) {
  const pkce = generateToken(32)
  const { redirectTo } = await consent({
    userId,
    params: {
      response_type: 'code',
      client_id: clients[app],
      redirect_uri: CALLBACK,
      code_challenge: challengeOf(pkce),
      code_challenge_method: 'S256',
      state: 's',
      scope: 'nexus.read nexus.write',
      resource: `${API}/mcp`,
    },
    decision: 'approve',
    workspaceId: A,
    scopes,
    code: generateSync({ secret }),
  })
  __stepUpTest.reset() // the next consent in the same 30 s window may reuse the code
  const issued = await exchangeCode({
    grant_type: 'authorization_code',
    code: new URL(redirectTo).searchParams.get('code') ?? undefined,
    code_verifier: pkce,
    client_id: clients[app],
    redirect_uri: CALLBACK,
  })
  const grant = await database.client.oAuthGrant.findFirst({ where: { userId, client: { clientId: clients[app] } } })
  return { access: issued.access_token, grantId: grant!.id }
}

/** Claude's side: the SDK's client. `modern` negotiates the 2026-07-28 protocol, else 2025. */
async function claude(token: string, options: { modern?: boolean } = {}) {
  const client = new Client(
    { name: 'nexus-endpoint-test', version: '1.0.0' },
    options.modern ? { versionNegotiation: { mode: 'auto' } } : {},
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token }, onInsufficientScope: 'throw' }),
  )
  return client
}

async function withClaude<T>(token: string, work: (client: Client) => Promise<T>, options: { modern?: boolean } = {}) {
  const client = await claude(token, options)
  try {
    return await work(client)
  } finally {
    await client.close()
  }
}

type CallResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
const textOf = (result: unknown) => (result as CallResult).content.map((block) => block.text ?? '').join('')
const jsonOf = (result: unknown) => JSON.parse(textOf(result))

/** A raw JSON-RPC POST, for the answers the SDK client turns into exceptions. */
function post(body: unknown, init: { token?: string; headers?: Record<string, string>; query?: string } = {}) {
  return fetch(`${url}${init.query ?? ''}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: JSON.stringify(body),
  })
}
const listRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const callRequest = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name, arguments: args },
})

async function runsOf(grantId: string) {
  return withWorkspace(business(A), () =>
    database.client.agentRun.findMany({ where: { oauthGrantId: grantId }, orderBy: { createdAt: 'asc' } }),
  )
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_MCP_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', WEB)
  vi.stubEnv('NEXUS_OAUTH_API_ORIGIN', API)
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const db = database.client
  secret = generateSecret()

  const role = (name: string, permissions: string[]) =>
    db.role.create({ data: { key: `MCP_${name}_${randomUUID().slice(0, 8)}`, name, description: 'test', permissions, isSystem: false } })
  const operatorRole = await role('OPS', [
    'ai.run', 'ai.view', 'products.view', 'products.edit', 'products.price.edit', 'orders.view', 'orders.edit',
    'inventory.view', 'pricing.view', 'listings.view', 'listings.publish', 'analytics.view', 'insights.view',
  ])
  const readerRole = await role('READ', ['ai.run', 'ai.view', 'products.view'])
  const bareRole = await role('BARE', ['ai.run'])
  const person = (displayName: string) =>
    db.userProfile.create({
      data: { email: `${randomUUID()}@example.test`, status: 'active', displayName, twoFactorEnabledAt: new Date(), twoFactorSecret: secret },
    })
  const operator = await person('Operator')
  const reader = await person('Reader')
  const bare = await person('Bare')
  operatorId = operator.id
  readerId = reader.id
  await db.workspace.create({ data: { id: B, name: 'Bravo business', createdByUserId: operator.id, creationKey: randomUUID() } })
  // The operator belongs to BOTH businesses; the token must keep them in A.
  for (const [workspaceId, userId, roleId] of [
    [A, operatorId, operatorRole.id],
    [B, operatorId, operatorRole.id],
    [A, readerId, readerRole.id],
    [A, bare.id, bareRole.id],
  ] as const) {
    const member = await db.workspaceMembership.create({ data: { workspaceId, userId, status: 'active' } })
    await db.workspaceMemberRole.create({ data: { membershipId: member.id, roleId } })
  }

  for (const [workspaceId, mark] of [[A, 'ALPHA'], [B, 'BRAVO']] as const) {
    await withWorkspace(business(workspaceId), async () => {
      const product = await db.product.create({
        data: { sku: `${mark}-MCP-SKU`, name: `${mark} MCP jacket`, basePrice: '19.90', totalStock: 4 },
      })
      if (workspaceId === A) ids.productA = product.id
      else {
        ids.productB = product.id
        const run = await db.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } })
        const approval = await db.agentApproval.create({
          data: { agentRunId: run.id, toolName: 'apply-content', riskTier: 'medium', args: {}, preview: { note: 'BRAVO preview' } },
        })
        ids.approvalB = approval.id
      }
    })
  }

  for (const name of ['Claude', 'Claude Code', 'Claude Desktop']) {
    clients[name] = String((await registerClient({ client_name: name, redirect_uris: [CALLBACK] })).client_id)
  }
  tokens.full = await connect(operatorId, 'Claude', ['nexus.read', 'nexus.write'])
  tokens.readOnly = await connect(operatorId, 'Claude Code', ['nexus.read'])
  tokens.reader = await connect(readerId, 'Claude', ['nexus.read', 'nexus.write'])
  tokens.bare = await connect(bare.id, 'Claude', ['nexus.read', 'nexus.write'])
  tokens.revoked = await connect(operatorId, 'Claude Desktop', ['nexus.read', 'nexus.write'])
  await revokeGrant(tokens.revoked.grantId, 'test')

  // The API's own global plumbing, so the test proves each hook steps aside for /mcp.
  app = Fastify()
  await app.register(compress, { global: true, threshold: 1024, encodings: ['gzip', 'deflate'] })
  await app.register(cookie)
  app.addHook('preHandler', workspaceHook)
  app.addHook('preHandler', rbacHook)
  app.addHook('preSerialization', financialFilterHook)
  await app.register(mcpRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`
}, 120_000)

beforeEach(() => {
  __toolRateTest.reset()
})

afterAll(async () => {
  await app?.close()
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('MCP.7 — off until switched on', () => {
  it('answers 404 everywhere while NEXUS_MCP_ENABLED is not 1', async () => {
    vi.stubEnv('NEXUS_MCP_ENABLED', '0')
    try {
      expect((await post(listRequest, { token: tokens.full.access })).status).toBe(404)
      expect((await fetch(url.replace('/mcp', '/.well-known/oauth-protected-resource/mcp'))).status).toBe(404)
      expect((await fetch(url)).status).toBe(404)
    } finally {
      vi.stubEnv('NEXUS_MCP_ENABLED', '1')
    }
  })
})

describe('MCP.7 — where Claude signs in', () => {
  it('serves the RFC 9728 document at the path derived from the MCP URL, and at the root', async () => {
    const expected = {
      resource: `${API}/mcp`,
      authorization_servers: [WEB],
      scopes_supported: ['nexus.read', 'nexus.write'],
      bearer_methods_supported: ['header'],
    }
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const response = await fetch(url.replace('/mcp', path))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(expected)
    }
    expect(new URL(METADATA_URL).pathname).toBe('/.well-known/oauth-protected-resource/mcp')
    expect((await fetch(url.replace('/mcp', '/.well-known/oauth-protected-resource/other'))).status).toBe(404)
  })

  it('no token: 401 with the challenge that names that document, and no error code', async () => {
    const response = await post(listRequest)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${METADATA_URL}"`)
  })

  it('a bad, an unknown or a revoked token: 401 invalid_token', async () => {
    for (const token of ['not-ours', 'nxm_at_unknown', tokens.revoked.access, tokens.full.access.replace('nxm_at_', 'nxm_rt_')]) {
      const response = await post(listRequest, { token })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer error="invalid_token", error_description="The access token is not valid. Sign in to Nexus again.", resource_metadata="${METADATA_URL}"`,
      )
    }
  })

  it('the SDK client is refused without a working token', async () => {
    await expect(claude(tokens.revoked.access)).rejects.toThrow()
  })
})

describe('MCP.7 — the business comes from the token alone', () => {
  it('a request that names a business, by header or by query, is refused', async () => {
    const byHeader = await post(listRequest, { token: tokens.full.access, headers: { 'x-nexus-workspace-id': B } })
    expect(byHeader.status).toBe(400)
    const byQuery = await post(listRequest, { token: tokens.full.access, query: `?workspaceId=${B}` })
    expect(byQuery.status).toBe(400)
    // Even naming the token's own business: the request does not get to choose.
    expect((await post(listRequest, { token: tokens.full.access, headers: { 'x-nexus-workspace-id': A } })).status).toBe(400)
  })

  it('a read returns rows of the token’s business, never the other one the person belongs to', async () => {
    await withClaude(tokens.full.access, async (client) => {
      const search = jsonOf(await client.callTool({ name: 'product-search', arguments: { query: 'MCP' } }))
      expect(search.products.map((p: { sku: string }) => p.sku)).toEqual(['ALPHA-MCP-SKU'])
      const other = await client.callTool({ name: 'product-snapshot', arguments: { productId: ids.productB } })
      expect(other.isError).toBe(true)
      expect(textOf(other)).toBe('Product not found')
    })
  })

  it('other requests from a browser page elsewhere are refused (Origin)', async () => {
    const response = await post(listRequest, { token: tokens.full.access, headers: { origin: 'https://evil.example' } })
    expect(response.status).toBe(403)
    const ours = await post(listRequest, { token: tokens.full.access, headers: { origin: WEB } })
    expect(ours.status).toBe(200)
    // A 2025-era answer streams through the API's reply as it is written: SSE, never compressed.
    expect(ours.headers.get('content-type')).toContain('text/event-stream')
    expect(ours.headers.get('content-encoding')).toBeNull()
    expect(await ours.text()).toContain('"product-search"')
  })
})

describe('MCP.7 — stateless: POST only', () => {
  it('GET and DELETE answer 405 and name POST', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(url, { method, headers: { authorization: `Bearer ${tokens.full.access}` } })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
    }
  })
})

describe('MCP.7 — what Claude is offered', () => {
  it('the person’s tools, minus the AI drafts, each with a title, annotations and its own schema', async () => {
    for (const modern of [false, true]) {
      const { tools } = await withClaude(tokens.full.access, (client) => client.listTools(), { modern })
      const names = tools.map((tool) => tool.name)
      for (const draft of AI_DRAFTS) expect(names).not.toContain(draft)
      // No ads permission, so no ads tool; the rest of what the role allows is there.
      expect(names).not.toContain('set-target-bid')
      for (const name of ['product-search', 'order-detail', 'set-price', 'publish-listing', 'approval-status']) {
        expect(names).toContain(name)
      }
      for (const tool of tools as Tool[]) {
        const own = listTools().find((t) => t.name === tool.name)!
        expect(tool.title, tool.name).toBe(own.title)
        expect(tool.annotations?.title).toBe(own.title)
        expect(tool.inputSchema).toEqual(inputJsonSchema(own))
        expect(tool.annotations?.readOnlyHint).toBe(own.readOnly)
        expect(typeof tool.annotations?.destructiveHint).toBe('boolean')
        expect(typeof tool.annotations?.openWorldHint).toBe('boolean')
      }
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
      expect(byName['product-search']!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
      expect(byName['set-price']!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
      expect(byName['apply-content']!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false })
    }
  })

  it('a person with fewer permissions is offered fewer tools', async () => {
    const { tools } = await withClaude(tokens.reader.access, (client) => client.listTools())
    expect(tools.map((tool) => tool.name).sort()).toEqual(['approval-status', 'product-search', 'product-snapshot'])
  })

  it('a person whose role allows no tool is told there are none', async () => {
    await withClaude(tokens.bare.access, async (client) => {
      expect(client.getServerCapabilities()?.tools).toBeUndefined()
    })
  })

  it('a draft tool cannot be called by name either', async () => {
    await withClaude(tokens.full.access, async (client) => {
      const result = await client.callTool({ name: 'draft-seo', arguments: { productId: ids.productA } }).catch((error) => error)
      expect(String((result as Error).message ?? textOf(result))).toContain('draft-seo')
    })
    const runs = await runsOf(tokens.full.grantId)
    expect(runs.some((run) => (run.input as { tool?: string })?.tool === 'draft-seo')).toBe(false)
  })
})

describe('MCP.7 — scopes are a ceiling', () => {
  it('a read-only connection may read', async () => {
    await withClaude(tokens.readOnly.access, async (client) => {
      const result = await client.callTool({ name: 'product-snapshot', arguments: { productId: ids.productA } })
      expect(jsonOf(result)).toMatchObject({ sku: 'ALPHA-MCP-SKU' })
    })
  })

  it('a read-only connection asking for a change gets 403 insufficient_scope (step-up), and nothing is queued', async () => {
    const response = await post(callRequest('set-price', { productId: ids.productA, price: 25 }), { token: tokens.readOnly.access })
    expect(response.status).toBe(403)
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer error="insufficient_scope", error_description="This tool needs the nexus.write scope", scope="nexus.write", resource_metadata="${METADATA_URL}"`,
    )
    // Claude's own client reads it as a step-up request.
    await withClaude(tokens.readOnly.access, async (client) => {
      const error = await client.callTool({ name: 'set-price', arguments: { productId: ids.productA, price: 25 } }).catch((e) => e)
      expect(error).toBeInstanceOf(InsufficientScopeError)
      expect((error as InsufficientScopeError).requiredScope).toBe('nexus.write')
    })
    expect(await runsOf(tokens.readOnly.grantId)).toSatisfy((runs: Array<{ input: unknown }>) =>
      runs.every((run) => (run.input as { tool?: string }).tool !== 'set-price'),
    )
  })
})

describe('MCP.7 — a change is only ever queued for a person', () => {
  it('set-price returns the preview, the approval, its expiry and where to approve; nothing changes', async () => {
    const result = await withClaude(tokens.full.access, (client) =>
      client.callTool({ name: 'set-price', arguments: { productId: ids.productA, price: 25 } }),
    )
    expect(result.isError).toBeFalsy()
    const out = jsonOf(result)
    expect(out).toMatchObject({
      status: 'waiting_for_approval',
      approvalId: expect.any(String),
      preview: { action: 'set-price', sku: 'ALPHA-MCP-SKU', changes: { 'base price': { from: 19.9, to: 25 } } },
    })
    const approveAt = process.env.NEXUS_WORKSPACES_ENABLED === '1' ? `${WEB}/w/${A}/fleet/approvals` : `${WEB}/fleet/approvals`
    expect(out.approveAt).toBe(approveAt)
    expect(out.next).toContain('you cannot approve it')

    const approval = await withWorkspace(business(A), () => database.client.agentApproval.findUnique({ where: { id: out.approvalId } }))
    expect(approval).toMatchObject({ status: 'pending', toolName: 'set-price', args: { productId: ids.productA, price: 25 } })
    expect(new Date(out.expiresAt).getTime()).toBe(approval!.expiresAt!.getTime())
    expect(approval!.expiresAt!.getTime() - approval!.requestedAt.getTime()).toBeCloseTo(24 * 3600_000, -3)
    const product = await withWorkspace(business(A), () => database.client.product.findUnique({ where: { id: ids.productA } }))
    expect(Number(product!.basePrice)).toBe(19.9)

    // One run per call: from Claude, over this connection; the approval hangs off it.
    const run = await withWorkspace(business(A), () => database.client.agentRun.findUnique({ where: { id: approval!.agentRunId } }))
    expect(run).toMatchObject({
      agentKey: 'claude',
      via: 'claude',
      oauthGrantId: tokens.full.grantId,
      userId: operatorId,
      status: 'awaiting_approval',
      ok: true,
      input: { tool: 'set-price', args: { productId: ids.productA, price: 25 } },
    })
  })

  it('a read leaves a run too', async () => {
    const before = (await runsOf(tokens.readOnly.grantId)).length
    await withClaude(tokens.readOnly.access, (client) => client.callTool({ name: 'product-search', arguments: {} }))
    const runs = await runsOf(tokens.readOnly.grantId)
    expect(runs).toHaveLength(before + 1)
    expect(runs.at(-1)).toMatchObject({ via: 'claude', agentKey: 'claude', status: 'done', ok: true, input: { tool: 'product-search' } })
  })

  it('a refusal comes back as a plain tool error, never a stack', async () => {
    await withClaude(tokens.full.access, async (client) => {
      const result = await client.callTool({ name: 'set-price', arguments: { productId: ids.productA, price: 'lots' } })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toMatch(/^set-price was called wrongly — price: /)
      expect(textOf(result)).not.toMatch(/\bat \w+ \(|node_modules|\.ts:\d+/)
    })
  })
})

describe('MCP.7 — the AI kill switch', () => {
  it('refuses every call; no tool runs and nothing is queued', async () => {
    vi.stubEnv('NEXUS_AI_KILL_SWITCH', '1')
    try {
      const pending = () =>
        withWorkspace(business(A), () => database.client.agentApproval.count({ where: { toolName: 'set-price', status: 'pending' } }))
      const before = await pending()
      await withClaude(tokens.full.access, async (client) => {
        for (const [name, args] of [['set-price', { productId: ids.productA, price: 30 }], ['product-search', {}]] as const) {
          const result = await client.callTool({ name, arguments: args })
          expect(result.isError).toBe(true)
          expect(textOf(result)).toContain('kill switch')
        }
      })
      expect(await pending()).toBe(before)
      expect((await runsOf(tokens.full.grantId)).at(-1)).toMatchObject({ status: 'failed', ok: false })
    } finally {
      vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
    }
  })
})

describe('MCP.7 — approval-status', () => {
  it('follows a queued change in the token’s business, and cannot see the other business', async () => {
    await withClaude(tokens.full.access, async (client) => {
      const queued = jsonOf(await client.callTool({ name: 'set-price', arguments: { productId: ids.productA, price: 26 } }))
      const status = jsonOf(await client.callTool({ name: 'approval-status', arguments: { approvalId: queued.approvalId } }))
      expect(status).toMatchObject({
        approvalId: queued.approvalId,
        tool: 'set-price',
        status: 'pending',
        meaning: expect.stringContaining('Nothing has changed yet'),
        preview: { action: 'set-price', changes: { 'base price': { to: 26 } } },
      })
      const other = await client.callTool({ name: 'approval-status', arguments: { approvalId: ids.approvalB } })
      expect(other.isError).toBe(true)
      expect(textOf(other)).toBe('Approval not found')
      expect(textOf(other)).not.toContain('BRAVO')
    })
  })

  it('hides the preview from a person who may not use the tool that made it', async () => {
    const queued = await withClaude(tokens.full.access, async (client) =>
      jsonOf(await client.callTool({ name: 'set-price', arguments: { productId: ids.productA, price: 27 } })),
    )
    const seen = await withClaude(tokens.reader.access, async (client) =>
      jsonOf(await client.callTool({ name: 'approval-status', arguments: { approvalId: queued.approvalId } })),
    )
    expect(seen).toMatchObject({ status: 'pending', preview: null, previewHidden: expect.stringContaining('set-price') })
  })
})
