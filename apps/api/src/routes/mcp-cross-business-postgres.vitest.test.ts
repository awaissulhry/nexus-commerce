/**
 * MCP.8 — Claude's connection for one business never reaches another, proven on a REAL PostgreSQL: the throwaway
 * PostgreSQL 17 of scripts/run-real-postgres-tests.mjs with the production schema and row-level policies, the app
 * connected as the restricted runtime login (NOBYPASSRLS), so the database holds the line as it does in production.
 * The /mcp route runs in a Fastify app with the API's own global hooks, next to the Approvals, Connected apps and
 * Team & Access routes; tokens come from the real OAuth server functions; Claude's side is the MCP SDK client.
 *
 * Two businesses, A and B. One person belongs to BOTH (the hard case: their membership in B is real, only the
 * token says A); another belongs to B only. Every B row a tool can read carries a canary string.
 *
 *   1. every tool A's token is offered, handed B's ids: not found, empty or refused — and the same arguments run
 *      inside B DO reach B's rows, so the refusal is the business boundary and not a bad argument; approving what
 *      A queued changes nothing in B
 *   2. naming B by header or query: 400, and nothing ran
 *   3. the person removed from A: the very next call is 401
 *   4. the person's role in A loses products.price.edit: set-price leaves the next tools/list and is refused
 *   5. a revoked connection: 401 on the next call; B's admin can neither see nor end A's connection
 *   6. no B canary in any answer given outside B, in any log line, or in any AgentRun / AgentApproval row
 *      written outside B; every run is filed under its connection's business
 *   7. an approval queued in A is "not found" to a B-only connection and to a B session in the Approvals routes
 *
 * Business profiles are ON for the whole file, as production runs: with them off there is one business and
 * nothing to keep apart. The runner leaves NEXUS_WORKSPACES_ENABLED unset (vitest.setup.ts then sets 0), so the
 * file pins it, like the other real-PostgreSQL suites. The tests run in order: 4 and 3 take the person's access
 * away, and 6 reads what every test before it wrote.
 *
 * A tool added tomorrow is covered on the day: the loop takes the tools from tools/list and builds each one's
 * arguments from its own input schema. A tool it cannot build, or whose arguments reach nothing even inside B,
 * fails by name until it gets an entry in B_VALUES or EXTRA.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import compress from '@fastify/compress'
import cookie from '@fastify/cookie'
import { generateSecret, generateSync } from 'otplib'
import { z } from 'zod'
import { ALL_PERMISSIONS, FEATURES } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { csrfCookieName, sessionCookieName } from '../lib/auth/cookies.js'
import { financialFilterHook } from '../lib/auth/field-filter.js'
import { rbacHook } from '../lib/auth/rbac-hook.js'
import { createSession } from '../lib/auth/session.js'
import { __stepUpTest } from '../lib/auth/step-up.js'
import { generateToken } from '../lib/auth/tokens.js'
import { workspaceHook } from '../lib/workspace-hook.js'
import { offeredOn } from '../services/agents/call-tool.js'
import { listTools } from '../services/agents/tool-registry.js'
import type { AgentTool } from '../services/agents/tool-types.js'
import { __toolRateTest } from '../services/agents/tool-rate.js'
import { __mcpRateTest } from '../services/mcp/mcp-rate.js'
import { registerClient } from '../services/oauth/oauth-clients.js'
import { consent, exchangeCode } from '../services/oauth/oauth-server.js'
import { logger } from '../utils/logger.js'
import agentFleetApprovalRoutes from './agent-fleet-approvals.routes.js'
import agentFleetRoutes from './agent-fleet.routes.js'
import agentRoutes from './agents.routes.js'
import mcpRoutes from './mcp.routes.js'
import oauthGrantsRoutes from './oauth-grants.routes.js'
import workspacesRoutes from './workspaces.routes.js'

const RUN = randomBytes(6).toString('hex')
const A = `mcp8_alpha_${RUN}`
const B = `mcp8_bravo_${RUN}`
/** In every B row a tool could return. Upper case: the scans compare upper-cased text (emails are lower case). */
const B_CANARY = `CANARY-B-${RUN.toUpperCase()}`
const A_CANARY = `CANARY-A-${RUN.toUpperCase()}`
const API = 'https://api.example.test'
const WEB = 'https://web.example.test'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const CSRF = 'mcp8-csrf'
const FAILED = 'could not run this tool'

// ── Two businesses, seeded alike ──────────────────────────────────────────────────────────────────────

interface Seeded {
  sku: string
  market: string
  productId: string
  orderId: string
  listingId: string
  approvalId: string
  /** B only: an approval the B session may reject, the control of test 7. */
  spareApprovalId: string
  targetId: string
  campaignId: string
  adGroupId: string
  externalCampaignId: string
  externalAdGroupId: string
  /** Every value that names one of the business's rows. None may reach the other business. */
  keys: string[]
  /** The AgentRun and AgentApproval rows written before the suite. */
  agentRows: string[]
}
const seeded = {} as Record<'a' | 'b', Seeded>
const inside = <T>(workspaceId: string, work: () => Promise<T>) =>
  withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)

async function seedBusiness(workspaceId: string, mark: 'ALPHA' | 'BRAVO', canary: string): Promise<Seeded> {
  const db = database.client
  const sku = `${mark}-${RUN.toUpperCase()}`
  // Not a real marketplace code: a value only this business's rows carry, so a market in an answer is traceable.
  const market = `Z${mark[0]}${RUN.slice(0, 6).toUpperCase()}`
  return inside(workspaceId, async () => {
    const product = await db.product.create({
      data: {
        sku,
        name: `${canary}-PRODUCT`,
        brand: `${canary}-BRAND`,
        description: `${canary}-DESCRIPTION`,
        bulletPoints: [`${canary}-BULLET`],
        keywords: [`${canary}-KEYWORD`],
        basePrice: '19.90',
        costPrice: '4.20',
        totalStock: 7,
      },
    })
    const order = await db.order.create({
      data: {
        channel: 'EBAY',
        channelOrderId: `${mark}-ORDER-${RUN}`,
        marketplace: market,
        currencyCode: 'EUR',
        totalPrice: '20.00',
        customerName: `${canary}-BUYER`,
        customerEmail: `${canary.toLowerCase()}-buyer@example.test`,
        shippingAddress: { city: `${canary}-CITY` },
        purchaseDate: new Date(),
        items: { create: [{ sku, productId: product.id, quantity: 2, price: '10.00' }] },
      },
    })
    const listing = await db.channelListing.create({
      data: {
        productId: product.id,
        channelMarket: 'EBAY_IT',
        channel: 'EBAY',
        region: 'IT',
        marketplace: market,
        title: `${canary}-LISTING-TITLE`,
        price: '21.50',
        quantity: 5,
        listingStatus: 'ACTIVE',
        isPublished: true,
        externalListingId: `${mark}-ITEM-${RUN}`,
      },
    })
    await db.listingIssue.create({
      data: {
        listingId: listing.id,
        code: 'CODE-1',
        severity: 'ERROR',
        message: `${canary}-ISSUE-MESSAGE`,
        attributeNames: ['brand'],
        categories: [],
        fingerprint: 'CODE-1::brand',
      },
    })
    const checkedAt = new Date().toISOString()
    await db.channelDrift.create({
      data: {
        channelListingId: listing.id,
        channel: 'EBAY',
        marketplace: market,
        driftCount: 2,
        driftedFields: [
          { field: 'quantity', ours: 5, theirs: 4, source: 'ebay-trading-getitem', checkedAt },
          { field: 'title', ours: `${canary}-DRIFT-OURS`, theirs: `${canary}-DRIFT-THEIRS`, source: 'ebay-trading-getitem', checkedAt },
        ],
        lastCheckedAt: new Date(checkedAt),
        checkedBySource: { 'ebay-trading-getitem': { at: checkedAt, outcome: 'compared', differing: 2 } },
      },
    })
    await db.channelStockEvent.create({
      data: { channel: 'EBAY', channelEventId: `${mark}-EVT-${RUN}`, sku, productId: product.id, channelReportedQty: 4, localQtyAtObservation: 7, drift: -3 },
    })
    await db.replenishmentRecommendation.create({
      data: {
        productId: product.id,
        sku,
        velocity: '0.5',
        velocitySource: 'test',
        leadTimeDays: 10,
        leadTimeSource: 'test',
        safetyDays: 3,
        totalAvailable: 7,
        inboundWithinLeadTime: 0,
        effectiveStock: 7,
        reorderPoint: 9,
        reorderQuantity: 20,
        urgency: 'HIGH',
        needsReorder: true,
      },
    })
    const rule = await db.alertRule.create({
      data: { name: `${canary}-ALERT-RULE`, metric: 'queueDepth', operator: 'gt', threshold: 100, notificationChannels: [] },
    })
    await db.alertEvent.create({ data: { ruleId: rule.id, value: 250 } })
    const campaign = await db.campaign.create({
      data: { name: `${canary}-CAMPAIGN`, type: 'SP', dailyBudget: '10.00', startDate: new Date(), marketplace: 'IT', externalCampaignId: `${mark}-CMP-${RUN}` },
    })
    const adGroup = await db.adGroup.create({
      data: { campaignId: campaign.id, name: `${canary}-ADGROUP`, externalAdGroupId: `${mark}-AG-${RUN}` },
    })
    const target = await db.adTarget.create({
      data: { adGroupId: adGroup.id, kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: `${canary}-TARGET`, isNegative: false, bidCents: 40 },
    })
    const run = await db.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done', input: { note: `${canary}-RUN` } } })
    const approval = (note: string) =>
      db.agentApproval.create({
        data: {
          agentRunId: run.id,
          toolName: 'apply-content',
          riskTier: 'medium',
          args: { productId: product.id, title: `${canary}-${note}-TITLE` },
          preview: { action: 'apply-content', changes: { title: { from: product.name, to: `${canary}-${note}-TITLE` } } },
          reason: `${canary}-${note}-NOTE`,
          status: 'pending',
        },
      })
    const first = await approval('APPROVAL')
    const spare = await approval('SPARE')
    return {
      sku,
      market,
      productId: product.id,
      orderId: order.id,
      listingId: listing.id,
      approvalId: first.id,
      spareApprovalId: spare.id,
      targetId: target.id,
      campaignId: campaign.id,
      adGroupId: adGroup.id,
      externalCampaignId: campaign.externalCampaignId!,
      externalAdGroupId: adGroup.externalAdGroupId!,
      keys: [
        sku, market, product.id, order.id, order.channelOrderId, listing.id, listing.externalListingId!, first.id, spare.id,
        run.id, rule.id, campaign.id, campaign.externalCampaignId!, adGroup.id, adGroup.externalAdGroupId!, target.id,
      ],
      agentRows: [run.id, first.id, spare.id],
    }
  })
}

// ── Arguments for any tool, from its own input schema ─────────────────────────────────────────────────

/**
 * What an argument of this name means in business B. Ids first; then where B's rows are (channel, market, a
 * search), because a filter on them must not reach B either. A plural name gets a one-item list.
 */
const B_VALUES: Record<string, () => unknown> = {
  productId: () => seeded.b.productId,
  orderId: () => seeded.b.orderId,
  listingId: () => seeded.b.listingId,
  channelListingId: () => seeded.b.listingId,
  approvalId: () => seeded.b.approvalId,
  targetId: () => seeded.b.targetId,
  campaignId: () => seeded.b.campaignId,
  adGroupId: () => seeded.b.adGroupId,
  externalCampaignId: () => seeded.b.externalCampaignId,
  sourceExternalCampaignId: () => seeded.b.externalCampaignId,
  destExternalCampaignId: () => seeded.b.externalCampaignId,
  externalAdGroupId: () => seeded.b.externalAdGroupId,
  sourceExternalAdGroupId: () => seeded.b.externalAdGroupId,
  sku: () => seeded.b.sku,
  channel: () => 'EBAY',
  market: () => seeded.b.market,
  marketplace: () => seeded.b.market,
  query: () => seeded.b.sku,
}

/** What a schema cannot say: without it the tool does nothing, even in B (apply-content needs a change to show). */
const EXTRA: Record<string, Record<string, unknown>> = {
  'apply-content': { title: 'MCP.8 probe title' },
}

/** An argument named like an id. One with no B_VALUES entry fails the build: the loop would probe nothing. */
const ID_NAME = /(^id$|Id$|Ids$|^skus?$)/
const OMIT = Symbol('omit')

interface ZodNode {
  _zod: { def: { type: string; [key: string]: any }; bag: Record<string, unknown> }
  safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}

/** The schema that decides the value: through optional, default and the like; a preprocess by what it yields. */
function unwrap(node: ZodNode): ZodNode {
  let current = node
  for (;;) {
    const def = current._zod.def
    if (['optional', 'default', 'prefault', 'nullable', 'nonoptional', 'readonly', 'catch'].includes(def.type)) current = def.innerType
    else if (def.type === 'pipe') current = def.out._zod.def.type === 'transform' ? def.in : def.out
    else return current
  }
}

function bValue(name: string): unknown {
  if (B_VALUES[name]) return B_VALUES[name]()
  if (name.endsWith('s') && B_VALUES[name.slice(0, -1)]) return [B_VALUES[name.slice(0, -1)]()]
  return undefined
}

/** One argument: B's value by its name; otherwise left out when optional, else a plain valid value. */
function argument(node: ZodNode, name: string, path: string, gaps: string[]): unknown {
  const known = bValue(name)
  if (known !== undefined) {
    const list = unwrap(node)._zod.def.type === 'array'
    return list === Array.isArray(known) ? known : list ? [known] : (known as unknown[])[0]
  }
  if (ID_NAME.test(name)) {
    gaps.push(`${path}: an id with no business-B value — seed the row and name it in B_VALUES`)
    return OMIT
  }
  if (node.safeParse(undefined).success) return OMIT
  return plainValue(node, path, gaps)
}

function plainValue(node: ZodNode, path: string, gaps: string[]): unknown {
  const inner = unwrap(node)
  const def = inner._zod.def
  const bag = inner._zod.bag as { minimum?: number; maximum?: number; exclusiveMinimum?: number }
  switch (def.type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(def.shape as Record<string, ZodNode>)) {
        const value = argument(child, name, `${path}.${name}`, gaps)
        if (value !== OMIT) out[name] = value
      }
      return out
    }
    case 'array': {
      const item = plainValue(def.element, `${path}[]`, gaps)
      return item === OMIT ? OMIT : [item]
    }
    case 'string':
      return 'mcp8 probe'.padEnd(bag.minimum ?? 0, 'x').slice(0, bag.maximum ?? undefined)
    case 'number': {
      const low = bag.minimum ?? (bag.exclusiveMinimum != null ? bag.exclusiveMinimum + 1 : 0)
      return Math.min(Math.max(100, low), bag.maximum ?? Number.MAX_SAFE_INTEGER)
    }
    case 'boolean':
      return false
    case 'enum':
      return Object.values(def.entries as Record<string, unknown>)[0]
    case 'literal':
      return (def.values as unknown[])[0]
    case 'union':
      for (const option of def.options as ZodNode[]) {
        const value = plainValue(option, path, [])
        if (value !== OMIT && option.safeParse(value).success) return value
      }
  }
  gaps.push(`${path}: no plain value for a ${def.type} — give the tool an entry in EXTRA`)
  return OMIT
}

/** A tool's arguments aimed at business B, or why they cannot be built. */
function probeArgs(tool: AgentTool): { args: Record<string, unknown> } | { gaps: string[] } {
  const gaps: string[] = []
  const input = tool.input as unknown as ZodNode
  const built = plainValue(input, tool.name, gaps)
  if (gaps.length) return { gaps }
  const args = { ...(built as Record<string, unknown>), ...EXTRA[tool.name] }
  const parsed = input.safeParse(args)
  if (!parsed.success) {
    return { gaps: [`${tool.name}: its built arguments do not parse (${parsed.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}) — give it an entry in EXTRA`] }
  }
  return { args }
}

/** Every string the caller itself sent: an answer may repeat those. */
function sentStrings(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') into.add(value)
  else if (Array.isArray(value)) value.forEach((item) => sentStrings(item, into))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => sentStrings(item, into))
  return into
}

/** What of a business an answer shows: its canary, or a key of its rows the caller did not send. */
function traces(text: string, of: Seeded, canary: string, args: unknown = {}): string[] {
  const sent = sentStrings(args)
  const found = of.keys.filter((key) => !sent.has(key) && text.includes(key))
  return text.toUpperCase().includes(canary) ? [canary, ...found] : found
}

// ── Claude's side, and a record of every answer ───────────────────────────────────────────────────────

/**
 * Who got an answer. 'B-control' answers are B reading its own rows (the controls), the only ones that may show
 * B's canary. 'B-only' is the person who belongs to B alone. 'A' is everything given to business A.
 */
type Tag = 'A' | 'B-control' | 'B-only'
const answers: Array<{ tag: Tag; text: Promise<string> }> = []
const logLines: string[] = []

let app: FastifyInstance
let url: string
let secret: string
const people = { owner: '', both: '', bOnly: '' }
const roles = { owner: '', a: '', b: '' }
const sessions = { owner: '', both: '', bOnly: '' }
const clients: Record<string, string> = {}
const tokens = {} as Record<'a' | 'aSecond' | 'bOwn' | 'bOnly', { access: string; grantId: string }>

/** fetch that keeps a copy of every answer for the scans of test 6. */
const recordingFetch = (tag: Tag) => async (input: string | URL, init?: RequestInit) => {
  const response = await fetch(input, init)
  answers.push({ tag, text: response.clone().text().catch(() => '') })
  return response
}

async function withClaude<T>(token: string, tag: Tag, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'nexus-mcp8', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token }, fetch: recordingFetch(tag) }))
  try {
    return await work(client)
  } finally {
    await client.close()
  }
}

type CallResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
const textOf = (result: unknown) => ((result as CallResult).content ?? []).map((block) => block.text ?? '').join('')

/** How a tools/call ended, as Claude reads it. */
function outcomeOf(result: unknown): 'refused' | 'queued' | 'preview' | 'answered' | 'crashed' {
  const text = textOf(result)
  if ((result as CallResult).isError) return text.includes(FAILED) ? 'crashed' : 'refused'
  try {
    const status = (JSON.parse(text) as { status?: unknown })?.status
    if (status === 'waiting_for_approval') return 'queued'
    if (status === 'preview_only') return 'preview'
  } catch {
    // plain text: an answer
  }
  return 'answered'
}

const listRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const callRequest = (name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })

/** A raw JSON-RPC POST to /mcp, for the answers the SDK client turns into exceptions. */
async function post(tag: Tag, body: unknown, init: { token: string; headers?: Record<string, string>; query?: string }) {
  const response = await fetch(`${url}${init.query ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${init.token}`, ...init.headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  answers.push({ tag, text: Promise.resolve(text) })
  return { status: response.status, header: (name: string) => response.headers.get(name), text }
}

/** The JSON-RPC message in an answer, sent as JSON or as one server-sent event. */
function rpcOf(text: string): { result?: { tools?: Array<{ name: string }> } & Partial<CallResult>; error?: { message: string } } {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const data = trimmed.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
  return JSON.parse(data.at(-1) ?? '{}')
}

/** A request from the web app: a signed-in person, their session cookie and CSRF pair, and a business when named. */
async function inApp(tag: Tag, method: 'GET' | 'POST' | 'PATCH', path: string, session: string, business?: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url: path,
    headers: {
      cookie: `${sessionCookieName()}=${session}; ${csrfCookieName()}=${CSRF}`,
      'x-nexus-csrf': CSRF,
      ...(business ? { 'x-nexus-workspace-id': business } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  })
  answers.push({ tag, text: Promise.resolve(response.body) })
  return response
}

// ── The owner's view of the database (BYPASSRLS): what really happened ───────────────────────────────

const rowsOf = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const counts = async () =>
  (await rowsOf<{ runs: number; approvals: number }>('SELECT (SELECT count(*) FROM "AgentRun")::int AS runs, (SELECT count(*) FROM "AgentApproval")::int AS approvals'))[0]

let digestSql = ''
/** Every row of one business, in every table that has a business column: a count and a hash per table. */
async function digest(workspaceId: string): Promise<Record<string, string>> {
  if (!digestSql) {
    const tables = await rowsOf<{ name: string }>(`
      SELECT c.table_name AS name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'workspaceId' AND t.table_type = 'BASE TABLE' ORDER BY 1`)
    digestSql = tables
      .map(({ name }) => `SELECT '${name}' AS t, count(*)::int AS n, md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) AS h FROM "${name}" r WHERE r."workspaceId" = $1`)
      .join(' UNION ALL ')
  }
  const rows = await rowsOf<{ t: string; n: number; h: string }>(digestSql, [workspaceId])
  return Object.fromEntries(rows.map((row) => [row.t, `${row.n}:${row.h}`]))
}

// ── Connecting Claude, as a person does ───────────────────────────────────────────────────────────────

/** Approve in the browser with a fresh 2FA code and swap the code, as Claude would. */
async function connect(userId: string, appName: string, workspaceId: string) {
  const verifier = generateToken(32)
  const { redirectTo } = await consent({
    userId,
    params: {
      response_type: 'code',
      client_id: clients[appName],
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 's',
      scope: 'nexus.read nexus.write',
      resource: `${API}/mcp`,
    },
    decision: 'approve',
    workspaceId,
    scopes: ['nexus.read', 'nexus.write'],
    code: generateSync({ secret }),
  })
  __stepUpTest.reset() // the next consent in the same 30 s window may reuse the code
  const issued = await exchangeCode({
    grant_type: 'authorization_code',
    code: new URL(redirectTo).searchParams.get('code') ?? undefined,
    code_verifier: verifier,
    client_id: clients[appName],
    redirect_uri: CALLBACK,
  })
  const grant = await database.client.oAuthGrant.findFirst({ where: { userId, workspaceId, client: { clientId: clients[appName] } } })
  return { access: issued.access_token, grantId: grant!.id }
}

/** Every log line, whatever writes it; each still reaches the terminal. */
function captureLogs() {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console)
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      logLines.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part) ?? String(part))).join(' '))
      original(...parts)
    })
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      logLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
      return write(chunk, ...rest)
    }) as never)
  }
}

// Each test makes dozens of HTTP calls and database reads; a busy machine or CI runner needs more than the default.
describe.skipIf(!concurrentDatabaseUrl())('MCP.8 — a Claude connection for one business never reaches another (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    captureLogs()
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_MCP_ENABLED', '1')
    vi.stubEnv('NEXUS_MCP_WORKSPACES', '')
    vi.stubEnv('NEXUS_MCP_RESOURCE', '')
    vi.stubEnv('NEXUS_OAUTH_ISSUER', WEB)
    vi.stubEnv('NEXUS_OAUTH_API_ORIGIN', API)
    vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
    vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
    // This file counts what ran, not how often: the per-minute limits have their own suite.
    vi.stubEnv('NEXUS_MCP_RATE_PER_GRANT', '100000')
    vi.stubEnv('NEXUS_MCP_RATE_PER_BUSINESS', '100000')
    database = await concurrentDatabase()
    const db = database.client
    secret = generateSecret()

    const person = (name: string) =>
      db.userProfile.create({
        data: { email: `mcp8-${name}-${RUN}@example.test`, status: 'active', displayName: `MCP8 ${name}`, twoFactorEnabledAt: new Date(), twoFactorSecret: secret },
      })
    people.owner = (await person('owner')).id
    people.both = (await person('both')).id
    people.bOnly = (await person('bravo')).id
    for (const [id, name] of [[A, 'Alpha business'], [B, 'Bravo business']] as const) {
      await db.workspace.create({ data: { id, name, createdByUserId: people.owner, creationKey: randomUUID() } })
    }
    roles.owner = (await db.role.create({ data: { key: 'OWNER', name: 'Owner', isSystem: true, permissions: [] } })).id
    // Custom roles holding every permission: a refusal below can only be the business, never a missing permission.
    const everything = (workspaceId: string) =>
      db.role.create({ data: { workspaceId, key: `business_${randomUUID()}`, name: 'MCP8 everything', description: 'test', permissions: ALL_PERMISSIONS } })
    roles.a = (await everything(A)).id
    roles.b = (await everything(B)).id
    for (const [workspaceId, userId, roleId] of [
      [A, people.owner, roles.owner],
      [A, people.both, roles.a],
      [B, people.both, roles.b],
      [B, people.bOnly, roles.b],
    ] as const) {
      await db.workspaceMembership.create({ data: { workspaceId, userId, status: 'active', roles: { create: [{ roleId }] } } })
    }

    seeded.a = await seedBusiness(A, 'ALPHA', A_CANARY)
    seeded.b = await seedBusiness(B, 'BRAVO', B_CANARY)

    for (const name of ['Claude', 'Claude Code']) {
      clients[name] = String((await registerClient({ client_name: name, redirect_uris: [CALLBACK] })).client_id)
    }
    tokens.a = await connect(people.both, 'Claude', A)
    tokens.aSecond = await connect(people.both, 'Claude Code', A)
    tokens.bOwn = await connect(people.both, 'Claude', B)
    tokens.bOnly = await connect(people.bOnly, 'Claude', B)
    for (const who of ['owner', 'both', 'bOnly'] as const) {
      sessions[who] = (await createSession({ userId: people[who], mfaSatisfied: true })).rawToken
    }

    // The API's own global plumbing, in index.ts order, and the routes a person answers Claude's requests in.
    app = Fastify()
    await app.register(compress, { global: true, threshold: 1024, encodings: ['gzip', 'deflate'] })
    await app.register(cookie)
    app.addHook('preHandler', workspaceHook)
    app.addHook('preHandler', rbacHook)
    app.addHook('preSerialization', financialFilterHook)
    await app.register(workspacesRoutes, { prefix: '/api' })
    await app.register(oauthGrantsRoutes, { prefix: '/api' })
    await app.register(mcpRoutes)
    await app.register(agentRoutes, { prefix: '/api' })
    await app.register(agentFleetRoutes, { prefix: '/api' })
    await app.register(agentFleetApprovalRoutes, { prefix: '/api' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`
  }, 240_000)

  beforeEach(() => {
    __toolRateTest.reset()
    __mcpRateTest.reset()
  })

  afterAll(async () => {
    await app?.close()
    await database?.close()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  }, 120_000)

  describe("1 — every tool Claude is offered, handed business B's ids", () => {
    const offered: AgentTool[] = []
    const probes = new Map<string, Record<string, unknown>>()
    const queuedInA: string[] = []

    it('the person in both businesses is offered every MCP tool, so the loop below covers the registry', async () => {
      const { tools } = await withClaude(tokens.a.access, 'A', (client) => client.listTools())
      const everyMcpTool = listTools().filter((tool) => offeredOn(tool, 'mcp'))
      expect(tools.map((tool) => tool.name).sort()).toEqual(everyMcpTool.map((tool) => tool.name).sort())
      offered.push(...everyMcpTool)
      // The token reads its own business (control): A's product, and nothing of B.
      const own = await withClaude(tokens.a.access, 'A', (client) => client.callTool({ name: 'product-search', arguments: {} }))
      expect(textOf(own)).toContain(seeded.a.sku)
      expect(traces(textOf(own), seeded.b, B_CANARY)).toEqual([])
    })

    it("each tool's arguments come from its own input schema; a tool the loop cannot aim at B fails by name", () => {
      const gaps: string[] = []
      for (const tool of offered) {
        const built = probeArgs(tool)
        if ('gaps' in built) gaps.push(...built.gaps)
        else probes.set(tool.name, built.args)
      }
      expect(gaps).toEqual([])
      expect(Object.keys(EXTRA).filter((name) => !offered.some((tool) => tool.name === name))).toEqual([])
      expect(probes.size).toBe(offered.length)
    })

    it('the builder aims the shapes a new tool may use (lists of ids, lists of rows) at B, and names what it cannot', () => {
      const future = (input: z.ZodObject) => probeArgs({ name: 'future-tool', input } as unknown as AgentTool)
      const upper = (value: unknown) => (typeof value === 'string' ? value.toUpperCase() : value)
      expect(future(z.object({ productIds: z.array(z.string().min(1)).min(1), price: z.coerce.number().positive(), note: z.string().optional() })))
        .toEqual({ args: { productIds: [seeded.b.productId], price: 100 } })
      expect(future(z.object({
        items: z.array(z.object({ sku: z.string(), quantity: z.coerce.number().int().min(0).max(50) })).min(1),
        channel: z.preprocess(upper, z.enum(['AMAZON', 'EBAY'])).optional(),
      }))).toEqual({ args: { items: [{ sku: seeded.b.sku, quantity: 50 }], channel: 'EBAY' } })
      expect(future(z.object({ warehouseId: z.string().optional() }))).toEqual({
        gaps: ['future-tool.warehouseId: an id with no business-B value — seed the row and name it in B_VALUES'],
      })
    })

    it("control: the same person, connected to B, reaches B's rows with exactly these arguments", async () => {
      const missed: string[] = []
      await withClaude(tokens.bOwn.access, 'B-control', async (client) => {
        for (const [name, args] of probes) {
          const result = await client.callTool({ name, arguments: args })
          const text = textOf(result)
          if (outcomeOf(result) === 'crashed' || traces(text, seeded.b, B_CANARY, args).length === 0) {
            missed.push(`${name} ${JSON.stringify(args)} → ${text.slice(0, 160)}`)
          }
        }
      })
      // A tool here reads nothing even inside B: "not found" from A would prove nothing. Give it B_VALUES or EXTRA.
      expect(missed).toEqual([])
    })

    it('from A: B is not found, the list is empty or the call is refused — never a row of B; approving what A queued leaves B untouched', async () => {
      const before = await digest(B)
      // The digest sees B's rows (control): the seeded product, order and approvals are in it.
      expect(before.Product).toMatch(/^1:/)
      expect(before.AgentApproval).not.toMatch(/^0:/)
      const leaks: string[] = []
      const outcomes: Record<string, string> = {}
      await withClaude(tokens.a.access, 'A', async (client) => {
        for (const [name, args] of probes) {
          const result = await client.callTool({ name, arguments: args })
          const outcome = outcomeOf(result)
          outcomes[name] = outcome
          if (outcome === 'crashed') leaks.push(`${name}: failed instead of answering`)
          const seen = traces(JSON.stringify(result), seeded.b, B_CANARY, args)
          if (seen.length) leaks.push(`${name}: ${seen.join(', ')}`)
          if (outcome === 'queued') queuedInA.push(JSON.parse(textOf(result)).approvalId)
        }
      })
      expect(leaks).toEqual([])
      expect(Object.keys(outcomes).length).toBe(probes.size)

      // A change queued with B's ids waits in A. A person in A approves it: it runs in A, where B's rows do not exist.
      for (const id of queuedInA) {
        const decided = await inApp('A', 'POST', `/api/agent/approvals/${id}/approve`, sessions.both, A, {})
        expect(decided.statusCode, decided.body).toBe(200)
        expect(traces(decided.body, seeded.b, B_CANARY, [id])).toEqual([])
      }
      expect(await digest(B)).toEqual(before)
    })
  })

  describe('2 — only the token names the business', () => {
    it('token A with B in the header, the query or both is refused with 400, and nothing runs', async () => {
      const before = await counts()
      for (const request of [listRequest, callRequest('product-snapshot', { productId: seeded.b.productId })]) {
        for (const naming of [
          { headers: { 'x-nexus-workspace-id': B } },
          { query: `?workspaceId=${B}` },
          { headers: { 'x-nexus-workspace-id': B }, query: `?workspaceId=${B}` },
        ]) {
          const answer = await post('A', request, { token: tokens.a.access, ...naming })
          expect(answer.status).toBe(400)
          expect(rpcOf(answer.text).error?.message).toBe('The business comes from your Nexus connection. Do not name one.')
        }
      }
      expect(await counts()).toEqual(before)
    })
  })

  describe('5 — ending a connection', () => {
    it("B's admin can neither see nor end A's connection, not as admin and not as a person", async () => {
      const listed = await inApp('B-only', 'GET', '/api/connected-apps', sessions.bOnly, B)
      expect(listed.statusCode).toBe(200)
      const ids = (listed.json() as { grants: Array<{ id: string }> }).grants.map((grant) => grant.id)
      expect(ids).toEqual(expect.arrayContaining([tokens.bOwn.grantId, tokens.bOnly.grantId])) // control: B's own
      expect(ids).not.toContain(tokens.a.grantId)
      expect(ids).not.toContain(tokens.aSecond.grantId)
      const asAdmin = await inApp('B-only', 'POST', `/api/connected-apps/${tokens.aSecond.grantId}/revoke`, sessions.bOnly, B, {})
      expect(asAdmin.statusCode).toBe(404)
      const asPerson = await inApp('B-only', 'POST', `/api/settings/connected-apps/${tokens.aSecond.grantId}/revoke`, sessions.bOnly, undefined, {})
      expect(asPerson.statusCode).toBe(404)
      expect((await post('A', listRequest, { token: tokens.aSecond.access })).status).toBe(200)
    })

    it('the person ends it in Connected apps: the next call is 401, and their other connection still works', async () => {
      const ended = await inApp('A', 'POST', `/api/settings/connected-apps/${tokens.aSecond.grantId}/revoke`, sessions.both, undefined, {})
      expect(ended.statusCode).toBe(200)
      const before = await counts()
      for (const request of [listRequest, callRequest('product-search', {})]) {
        const answer = await post('A', request, { token: tokens.aSecond.access })
        expect(answer.status).toBe(401)
        expect(answer.header('www-authenticate')).toContain('error="invalid_token"')
      }
      expect(await counts()).toEqual(before)
      expect((await post('A', listRequest, { token: tokens.a.access })).status).toBe(200)
    })
  })

  describe('7 — an approval queued in A stays in A', () => {
    /** Two requests from Claude in A: one waiting (set aside by A), one approved and parked in its undo window. */
    const inA = { waiting: '', parked: '' }

    it('Claude queues two changes in A; a person in A sets one aside and approves the other', async () => {
      for (const [slot, price] of [['waiting', 25], ['parked', 26]] as const) {
        const result = await withClaude(tokens.a.access, 'A', (client) =>
          client.callTool({ name: 'set-price', arguments: { productId: seeded.a.productId, price } }),
        )
        expect(outcomeOf(result)).toBe('queued')
        inA[slot] = JSON.parse(textOf(result)).approvalId
        seeded.a.keys.push(inA[slot])
      }
      // States a write from B would visibly change: a snooze to clear, a parked approve to undo or hold.
      const until = new Date(Date.now() + 3600_000).toISOString()
      expect((await inApp('A', 'POST', `/api/agent/fleet/approvals/${inA.waiting}/snooze`, sessions.both, A, { until })).statusCode).toBe(200)
      const approved = await inApp('A', 'POST', `/api/agent/fleet/approvals/${inA.parked}/decide`, sessions.both, A, { decision: 'approve' })
      expect(approved.json()).toMatchObject({ ok: true, status: 'scheduled' })
    })

    it('a B-only connection: approval-status says not found (and reads its own business’s approval: control)', async () => {
      await withClaude(tokens.bOnly.access, 'B-only', async (client) => {
        for (const approvalId of [inA.waiting, inA.parked]) {
          const other = await client.callTool({ name: 'approval-status', arguments: { approvalId } })
          expect(other.isError).toBe(true)
          expect(textOf(other)).toBe('Approval not found')
        }
      })
      const own = await withClaude(tokens.bOnly.access, 'B-control', (client) =>
        client.callTool({ name: 'approval-status', arguments: { approvalId: seeded.b.approvalId } }),
      )
      expect(JSON.parse(textOf(own))).toMatchObject({ approvalId: seeded.b.approvalId, status: 'pending' })
    })

    it('a B session cannot see, read, decide, edit, hold, undo, run or set them aside in the Approvals routes; A is unchanged', async () => {
      const before = await digest(A)
      const rowsBefore = await rowsOf('SELECT * FROM "AgentApproval" WHERE id = ANY($1::text[]) ORDER BY id', [[inA.waiting, inA.parked]])

      // The lists a person reads Claude's requests in (Settings › AI, and the Approvals page's "outside the fleet").
      for (const path of ['/api/agent/approvals?status=pending', '/api/agent/fleet/approvals/outside']) {
        const list = await inApp('B-control', 'GET', path, sessions.bOnly, B)
        expect(list.statusCode).toBe(200)
        const ids = (list.json() as { approvals: Array<{ id: string }> }).approvals.map((approval) => approval.id)
        expect(ids).toContain(seeded.b.approvalId) // control: B's own queue is there
        expect(ids).not.toContain(inA.waiting)
        expect(ids).not.toContain(inA.parked)
      }

      // Every action on one approval, and what a request nobody in B can see gets from each.
      const until = new Date(Date.now() + 1800_000).toISOString()
      const actions: Array<[string, unknown, number, Record<string, unknown>]> = [
        ['approvals/:id/approve', {}, 404, { error: 'approval not found' }],
        ['approvals/:id/reject', { reason: 'MCP.8' }, 404, { error: 'approval not found' }],
        ['fleet/approvals/:id/decide', { decision: 'approve' }, 409, { error: 'approval not found' }],
        ['fleet/approvals/:id/decide', { decision: 'reject', reason: 'MCP.8' }, 409, { error: 'approval not found' }],
        ['fleet/approvals/:id/amend', { args: { price: 1 } }, 404, { error: 'approval not found' }],
        ['fleet/approvals/:id/hold', {}, 404, { error: 'approval not found' }],
        ['fleet/approvals/:id/undo', {}, 409, { error: 'nothing to undo' }],
        ['fleet/approvals/:id/commit', {}, 409, { error: 'approval not found' }],
        ['fleet/approvals/:id/snooze', { until }, 404, { error: 'approval not found' }],
        ['fleet/approvals/:id/unsnooze', {}, 200, {}],
        ['fleet/approvals/:id/recheck', {}, 200, { stale: true, why: 'the request no longer exists' }],
      ]
      for (const id of [inA.waiting, inA.parked]) {
        for (const [action, payload, status, body] of actions) {
          const path = `/api/agent/${action.replace(':id', id)}`
          const answer = await inApp('B-only', 'POST', path, sessions.bOnly, B, payload)
          expect({ action, status: answer.statusCode, body: answer.json() }).toMatchObject({ action, status, body })
        }
        const read = await inApp('B-only', 'POST', '/api/agent/tools/approval-status/invoke', sessions.bOnly, B, { approvalId: id })
        expect(read.json()).toMatchObject({ ok: false, error: 'Approval not found' })
      }

      expect(await rowsOf('SELECT * FROM "AgentApproval" WHERE id = ANY($1::text[]) ORDER BY id', [[inA.waiting, inA.parked]])).toEqual(rowsBefore)
      expect(await digest(A)).toEqual(before)

      // Control: the same session and route decide an approval of its own business.
      const own = await inApp('B-control', 'POST', `/api/agent/approvals/${seeded.b.spareApprovalId}/reject`, sessions.bOnly, B, { reason: 'MCP.8 control' })
      expect(own.statusCode).toBe(200)
      expect(own.json()).toMatchObject({ ok: true, status: 'rejected' })
    })
  })

  describe('4 — a permission taken away holds from the next call', () => {
    it("the person's role in A loses products.price.edit: set-price leaves tools/list and is refused, nothing is queued, B is unaffected", async () => {
      const [role] = await rowsOf<{ version: number; name: string }>('SELECT version, name FROM "Role" WHERE id = $1', [roles.a])
      const saved = await inApp('A', 'PATCH', `/api/workspaces/${A}/roles/${roles.a}`, sessions.owner, undefined, {
        name: role.name,
        description: 'test',
        permissions: ALL_PERMISSIONS.filter((permission) => permission !== FEATURES.productsPriceEdit),
        version: role.version,
      })
      expect(saved.statusCode, saved.body).toBe(200)

      const before = await counts()
      const listed = rpcOf((await post('A', listRequest, { token: tokens.a.access })).text).result?.tools?.map((tool) => tool.name) ?? []
      expect(listed).toContain('product-search')
      expect(listed).not.toContain('set-price')
      const call = rpcOf((await post('A', callRequest('set-price', { productId: seeded.a.productId, price: 30 }), { token: tokens.a.access })).text)
      const refusal = call.error?.message ?? (call.result?.isError ? textOf(call.result) : '')
      expect(refusal).toContain('set-price')
      expect(await counts()).toEqual(before)

      // The same person's role in B is its own: B still offers set-price.
      const inB = rpcOf((await post('B-control', listRequest, { token: tokens.bOwn.access })).text).result?.tools?.map((tool) => tool.name)
      expect(inB).toContain('set-price')
    })
  })

  describe('3 — leaving a business ends Claude’s access to it at once', () => {
    it('an owner removes the person from A in Team & Access: the very next call is 401 and nothing runs; their B connection still works', async () => {
      expect((await post('A', listRequest, { token: tokens.a.access })).status).toBe(200)
      const [member] = await rowsOf<{ id: string; version: number }>(
        'SELECT id, version FROM "WorkspaceMembership" WHERE "workspaceId" = $1 AND "userId" = $2',
        [A, people.both],
      )
      const removed = await inApp('A', 'PATCH', `/api/workspaces/${A}/members/${member.id}`, sessions.owner, undefined, {
        roleIds: [roles.a],
        status: 'revoked',
        version: member.version,
      })
      expect(removed.statusCode, removed.body).toBe(200)

      const before = await counts()
      for (const request of [listRequest, callRequest('product-search', {})]) {
        const answer = await post('A', request, { token: tokens.a.access })
        expect(answer.status).toBe(401)
        expect(answer.header('www-authenticate')).toContain('error="invalid_token"')
      }
      expect(await counts()).toEqual(before)
      expect((await post('B-control', listRequest, { token: tokens.bOwn.access })).status).toBe(200)
    })
  })

  describe('6 — no trace of B outside B', () => {
    it('no B canary in any answer given outside B; nothing of A in any answer given to B', async () => {
      const all = await Promise.all(answers.map(async ({ tag, text }) => ({ tag, text: await text })))
      // Control: the scan finds a canary where one belongs (B reading its own rows through /mcp).
      expect(all.some(({ tag, text }) => tag === 'B-control' && text.toUpperCase().includes(B_CANARY))).toBe(true)
      expect(all.filter(({ tag }) => tag === 'A').length).toBeGreaterThan(40)
      const outsideB = all.filter(({ tag, text }) => tag !== 'B-control' && text.toUpperCase().includes(B_CANARY))
      expect(outsideB.map(({ tag, text }) => `${tag}: ${text.slice(0, 200)}`)).toEqual([])
      const toB = all.filter(({ tag, text }) => tag !== 'A' && traces(text, seeded.a, A_CANARY).length > 0)
      expect(toB.map(({ tag, text }) => `${tag}: ${traces(text, seeded.a, A_CANARY).join(', ')}`)).toEqual([])
    })

    it('no B canary in any log line written during the suite', () => {
      const marker = `MCP8-LOG-${RUN}`
      logger.warn('[mcp8] log capture check', { marker })
      expect(logLines.some((line) => line.includes(marker))).toBe(true) // control: the logger's lines are caught
      expect(logLines.filter((line) => line.toUpperCase().includes(B_CANARY))).toEqual([])
    })

    it('no B canary in any AgentRun or AgentApproval written outside B; every run is filed under its connection’s business', async () => {
      const before = [...seeded.a.agentRows, ...seeded.b.agentRows]
      const rows = await rowsOf<{ t: string; workspaceId: string | null; grantWorkspace: string | null; oauthGrantId: string | null; row: string }>(
        `SELECT 'AgentRun' AS t, r."workspaceId", r."oauthGrantId", g."workspaceId" AS "grantWorkspace", to_jsonb(r)::text AS row
           FROM "AgentRun" r LEFT JOIN "OAuthGrant" g ON g.id = r."oauthGrantId" WHERE NOT (r.id = ANY($1::text[]))
         UNION ALL
         SELECT 'AgentApproval', a."workspaceId", NULL, NULL, to_jsonb(a)::text FROM "AgentApproval" a WHERE NOT (a.id = ANY($1::text[]))`,
        [before],
      )
      const inA = rows.filter((row) => row.workspaceId === A)
      expect(inA.filter((row) => row.t === 'AgentRun').length).toBeGreaterThanOrEqual(listTools().filter((tool) => offeredOn(tool, 'mcp')).length)
      const outsideB = rows.filter((row) => row.workspaceId !== B)
      expect(outsideB.filter((row) => row.row.toUpperCase().includes(B_CANARY)).map((row) => `${row.t} ${row.row.slice(0, 200)}`)).toEqual([])
      const misfiled = rows.filter((row) => row.t === 'AgentRun' && (!row.oauthGrantId || row.grantWorkspace !== row.workspaceId))
      expect(misfiled.map((row) => row.row.slice(0, 200))).toEqual([])
    })
  })
})
