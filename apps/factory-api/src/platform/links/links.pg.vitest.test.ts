import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { amountMinor, defineContract, id, input, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { newId } from '@nexus/factory-domain/core/ids'
import { EMAIL_CHECKS } from '@nexus/factory-domain/links/evidence'
import { LINK_ACTIONS } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { looksLikeMoney, asMoney, money } from '@nexus/factory-domain/money/marked'
import { buildApp } from '../../core/app'
import { idempotencyKeyFrom, type VersionedModel } from '../../core/command'
import { requireContext, type LinkContext } from '../../core/context'
import { defineManifest, defineRoutes } from '../../core/manifest'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { addTenant, addUser, Browser, START, startHarness, WEB_ORIGIN, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { LINK_HEADER, LINK_UNAVAILABLE } from './authenticator'
import { registerLinkRecordSource } from './records'
import { linkCommand, useLink } from './use'

/**
 * One-off links on the local stack (plan A1 §3.10 "Links", §2.2, §2.6; PLAN §4.7 06a-accept and 08-buy; features
 * SAL-099, PLT-007, PLT-035), with the app's real routes, the real office sign-in and the real link authenticator, and
 * a made-up module (records kept in memory) that offers quotes, purchase orders and documents and serves them on its
 * own link routes, as the W1 modules will:
 *   - the office makes a link (URL shown once, only its hash stored), lists and revokes it, within its grants;
 *   - a link opens its one record only, with the grants of its purpose: the party's own prices for a quote, none for a
 *     purchase order; command() refuses any other record; the partner role's wall hides other parties and tenants;
 *   - garbage, unknown, wrong-secret, forged-party, other-tenant, expired, revoked, used-up and suspended-tenant links
 *     all get the same 404; the use limit is counted, also under a race; every open and answer leaves evidence.
 */

let h: Harness
let app: FastifyInstance
let tenantA: TestTenant
let tenantB: TestTenant
const P1 = newId()
const P2 = newId()
const withdraw: (() => void)[] = []

interface MadeUpRecord {
  readonly tenantId: string
  readonly companyId: string
  readonly partyId: string
  readonly email: string | null
  readonly lines: readonly { readonly sku: string; readonly unitPrice: string }[]
  readonly totalMinor: number
}
/** The made-up module's records, by id. */
const RECORDS = new Map<string, MadeUpRecord>()

const record = (tenant: TestTenant, partyId: string, email: string | null, unitPrice: string, totalMinor: number): string => {
  const recordId = newId()
  RECORDS.set(recordId, { tenantId: tenant.id, companyId: tenant.companies[0]!.id, partyId, email, lines: [{ sku: 'JKT-1', unitPrice }], totalMinor })
  return recordId
}

const recordContract = defineContract({
  response: {
    200: output({
      recordId: id(),
      partyId: id(),
      lines: z.array(output({ sku: z.string(), unitPrice: money.price(unitPrice()) })),
      totalMinor: money.price(amountMinor()),
    }),
  },
})
const answerContract = defineContract({
  body: input({ typedName: z.string().max(400).optional(), email: z.string().max(400).optional() }),
  response: {
    200: output({
      use: output({
        action: z.enum(LINK_ACTIONS),
        counted: z.boolean(),
        useNumber: z.number().int().nullable(),
        usesLeft: z.number().int(),
        typedName: z.string().nullable(),
        emailCheck: z.enum(EMAIL_CHECKS),
      }),
    }),
  },
})
const touchContract = defineContract({
  body: input({ recordType: z.string(), recordId: id() }),
  response: { 200: output({ version: z.number().int() }) },
})

/** The made-up module's link routes: its record with the party's prices, and its answers through useLink. */
const moduleRoutes = defineRoutes(
  'links-module-test',
  defineManifest({
    'GET /test-links/record': { audiences: ['link'], permission: 'links.open', scope: 'record' },
    'POST /test-links/accept': { audiences: ['link'], permission: 'links.accept', scope: 'record' },
    'POST /test-links/decline': { audiences: ['link'], permission: 'links.decline', scope: 'record' },
    'POST /test-links/confirm': { audiences: ['link'], permission: 'links.confirm', scope: 'record' },
    'POST /test-links/touch': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  }),
  async (routes) => {
    routes.get('/test-links/record', { schema: recordContract }, async (request) => {
      const context = requireContext(request) as LinkContext
      // The module reads the link's ONE record (the context names it), never one from the request.
      const found = RECORDS.get(context.record.id)
      if (!found || found.partyId !== context.partyId) throw new Error('the made-up module lost its record')
      return {
        recordId: context.record.id,
        partyId: found.partyId,
        lines: found.lines.map((line) => ({ sku: line.sku, unitPrice: asMoney('price', line.unitPrice) })),
        totalMinor: asMoney('price', found.totalMinor),
      }
    })
    for (const action of ['accept', 'decline', 'confirm'] as const) {
      routes.post(`/test-links/${action}`, { schema: answerContract }, async (request) => {
        const { result } = await linkCommand(request, { name: `links.${action}`, idempotencyKey: idempotencyKeyFrom(request), input: request.body }, async (tools) => {
          const use = await useLink(tools, request, { action, typedName: request.body.typedName, email: request.body.email })
          return { use: { action: use.action, counted: use.counted, useNumber: use.useNumber, usesLeft: use.usesLeft, typedName: use.typedName, emailCheck: use.emailCheck } }
        })
        return result
      })
    }
    routes.post('/test-links/touch', { schema: touchContract }, async (request) => {
      const { result } = await linkCommand(
        request,
        { name: 'links.touch', idempotencyKey: idempotencyKeyFrom(request), input: request.body, record: { type: request.body.recordType as VersionedModel, id: request.body.recordId } },
        async ({ audit, record: guarded }) => {
          audit({ recordType: 'OneOffLink', recordId: request.body.recordId })
          return { version: guarded!.version }
        },
      )
      return result
    })
  },
)

/** The made-up source: reads in the caller's tenant (the scope of the command's client). */
const source = (recordType: string) =>
  registerLinkRecordSource(recordType, {
    async read(client, recordId) {
      const [scope] = await client.$queryRaw<{ tenant: string }[]>`SELECT current_setting('factory.tenant_id', true) AS tenant`
      const found = RECORDS.get(recordId)
      return found && found.tenantId === scope?.tenant ? { companyId: found.companyId, partyId: found.partyId, email: found.email } : null
    },
  })

let sales: Browser
let planner: Browser
let salesP2: Browser
let salesB: Browser
let counter = 0
const key = (label = 'k'): string => `test-${label}-${++counter}-${newId()}`

interface Answer {
  readonly status: number
  readonly body: any
  readonly response: LightMyRequestResponse
}
const answer = (response: LightMyRequestResponse): Answer => {
  let body: unknown
  try {
    body = response.json()
  } catch {
    body = response.body
  }
  return { status: response.statusCode, body, response }
}

/** A request of a link session: the token in its header, an Idempotency-Key on writes. */
async function viaLink(token: string | undefined, method: 'GET' | 'POST', url: string, body?: object, options: { key?: string | null; target?: FastifyInstance } = {}): Promise<Answer> {
  const headers: Record<string, string> = { 'user-agent': 'Example Browser/1.0' }
  if (token !== undefined) headers[LINK_HEADER] = token
  const idempotency = options.key === undefined ? (method === 'POST' ? key() : null) : options.key
  if (idempotency) headers['idempotency-key'] = idempotency
  return answer(await (options.target ?? app).inject({ method, url, headers, ...(method === 'POST' ? { payload: body ?? {} } : {}) }))
}
const open = (token: string | undefined, options?: { key?: string | null; target?: FastifyInstance }) => viaLink(token, 'POST', '/link/open', {}, options)

const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1]!)

/** Makes a link through the office route; returns the link and its token. */
async function make(browser: Browser, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ link: any; token: string }> {
  const made = await browser.post('/links', body, { headers })
  if (made.status !== 201) throw new Error(`make link: ${made.status} ${JSON.stringify(made.body)}`)
  return { link: made.body.link, token: tokenOf(made.body.url) }
}

/**
 * A link written straight into the database (states the office routes cannot make: expired, a record type no purpose
 * opens). Its token is minted here; only the hash is stored.
 */
async function plant(tenant: TestTenant, partyId: string, values: { purpose?: string; recordType?: string; recordId?: string; createdAt?: string; expiresAt?: string; maxUses?: number; id?: string } = {}) {
  const linkId = values.id ?? newId()
  const token = mintLinkToken({ tenantId: tenant.id, partyId, linkId })
  await h.db.admin.query(
    `INSERT INTO "OneOffLink" (id, "tenantId", "companyId", "partyId", purpose, "recordType", "recordId", "tokenHash", "expiresAt", "maxUses", "createdAt", "updatedAt", "createdById")
     VALUES ($1, $2, $3, $4, $5::"LinkPurpose", $6, $7, $8, $9, $10, $11, $11, $12)`,
    [
      linkId,
      tenant.id,
      tenant.companies[0]!.id,
      partyId,
      values.purpose ?? 'QUOTE_ACCEPT',
      values.recordType ?? 'Quote',
      values.recordId ?? newId(),
      linkTokenHash(token.value),
      values.expiresAt ?? '2026-12-31T00:00:00.000Z',
      values.maxUses ?? 1,
      values.createdAt ?? START,
      newId(),
    ],
  )
  return { linkId, token: token.value }
}

const rows = async (sql: string, values: unknown[] = []) => (await h.db.admin.query(sql, values)).rows as Record<string, any>[]
const linkRow = async (linkId: string) => (await rows('SELECT * FROM "OneOffLink" WHERE id = $1', [linkId]))[0]!
const evidenceOf = (linkId: string) => rows('SELECT * FROM "LinkEvidence" WHERE "linkId" = $1 ORDER BY at, id', [linkId])

/**
 * Gives a person a custom role that makes and lists links and sees prices, over every company and the given parties
 * (none: every party). The W0 templates give links.* only to the owner (and links.view to read-only); the W1 steps that
 * make quotes and purchase orders linkable give them to sales and buyer.
 */
async function giveLinkRole(tenant: TestTenant, userId: string, partyIds: string[] = []): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: userId }, async (client) => {
    const where = { tenantId_key: { tenantId: tenant.id, key: 'custom.link_sender' } }
    const role =
      (await client.role.findUnique({ where, select: { id: true } })) ??
      (await client.role.create({
        data: { id: newId(), key: 'custom.link_sender', name: 'Link sender', permissions: ['links.view', 'links.manage'], grains: ['price'] },
        select: { id: true },
      }))
    await client.roleAssignment.create({ data: { id: newId(), userId, roleId: role.id, allCompanies: true, partyIds, validFrom: new Date(START) } })
  })
}

beforeAll(async () => {
  h = await startHarness('links')
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: WEB_ORIGIN, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database: h.database, officeAuth: h.auth, clock: h.clock, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), routes: [moduleRoutes] },
  )
  withdraw.push(source('Quote'), source('PurchaseOrder'), source('StoredFile'))
  tenantA = await addTenant(h, 'links-a')
  tenantB = await addTenant(h, 'links-b')
  const salesUser = await addUser(h, tenantA, { email: 'sales@example.com', role: 'sales' })
  const plannerUser = await addUser(h, tenantA, { email: 'planner@example.com', role: 'planner' })
  const salesP2User = await addUser(h, tenantA, { email: 'sales.p2@example.com' })
  const salesBUser = await addUser(h, tenantB, { email: 'sales.b@example.com', role: 'sales' })
  await giveLinkRole(tenantA, salesUser.id)
  // A sales person limited to the customer P2 (a role assignment with a party scope).
  await giveLinkRole(tenantA, salesP2User.id, [P2])
  await giveLinkRole(tenantB, salesBUser.id)
  sales = new Browser(app)
  planner = new Browser(app)
  salesP2 = new Browser(app)
  salesB = new Browser(app)
  for (const [browser, tenant, user] of [
    [sales, tenantA, salesUser],
    [planner, tenantA, plannerUser],
    [salesP2, tenantA, salesP2User],
    [salesB, tenantB, salesBUser],
  ] as const) {
    const signed = await browser.signIn(tenant.slug, user.email, user.password)
    if (signed.status !== 200) throw new Error(`sign-in ${user.email}: ${signed.status} ${JSON.stringify(signed.body)}`)
  }
}, 120_000)

afterAll(async () => {
  for (const undo of withdraw) undo()
  await app?.close()
  await h?.close()
}, 60_000)

describe('POST /links (office)', () => {
  it('makes a QUOTE_ACCEPT link for the record\'s party with the purpose\'s terms; the URL is shown once, only its hash kept', async () => {
    const quote = record(tenantA, P1, 'Buyer.One@Example.com', '120.000000', 24_000)
    const made = await sales.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quote, note: 'Sent after the call' })
    expect(made.status).toBe(201)
    expect(made.body.link).toMatchObject({
      companyId: tenantA.companies[0]!.id,
      partyId: P1,
      purpose: 'QUOTE_ACCEPT',
      recordType: 'Quote',
      recordId: quote,
      email: 'buyer.one@example.com',
      note: 'Sent after the call',
      state: 'LIVE',
      expiresAt: '2026-11-27T09:00:00.000Z',
      maxUses: 1,
      uses: 0,
      lastUsedAt: null,
      revokedAt: null,
      version: 1,
      evidence: [],
    })
    expect(made.body.url).toMatch(new RegExp(`^${WEB_ORIGIN}/l#token=`))
    const token = tokenOf(made.body.url)
    expect(token.startsWith(`${tenantA.id}.${P1}.${made.body.link.id}.`)).toBe(true)

    const row = await linkRow(made.body.link.id)
    expect(row.tokenHash).toBe(linkTokenHash(token))
    // The token is in no row of the database: not the link, not the audit, not a receipt.
    const secret = token.split('.')[3]!
    for (const table of ['OneOffLink', 'AuditLog', 'IdempotencyReceipt', 'OutboxEvent']) {
      const [{ n }] = (await rows(`SELECT count(*)::int AS n FROM "${table}" t WHERE to_jsonb(t)::text LIKE $1`, [`%${secret}%`])) as [{ n: number }]
      expect(n, table).toBe(0)
    }
    const [audit] = await rows(`SELECT * FROM "AuditLog" WHERE "recordId" = $1 AND action = 'links.create'`, [made.body.link.id])
    expect(audit).toMatchObject({ audience: 'OFFICE', recordType: 'OneOffLink', companyId: tenantA.companies[0]!.id })
    expect(audit!.after).toMatchObject({ purpose: 'QUOTE_ACCEPT', partyId: P1, email: 'buyer.one@example.com', maxUses: 1 })
  })

  it('answers a repeated Idempotency-Key with the same link and no URL (the receipt holds no token)', async () => {
    const quote = record(tenantA, P1, null, '10.000000', 1_000)
    const body = { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quote }
    const repeat = key('make')
    const first = await sales.post('/links', body, { headers: { 'idempotency-key': repeat } })
    const second = await sales.post('/links', body, { headers: { 'idempotency-key': repeat } })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body.link.id).toBe(first.body.link.id)
    expect(first.body.url).toMatch(/#token=/)
    expect(second.body.url).toBeNull()
    expect((await rows('SELECT count(*)::int AS n FROM "OneOffLink" WHERE "recordId" = $1', [quote]))[0]!.n).toBe(1)
    const [receipt] = await rows(`SELECT response::text AS response FROM "IdempotencyReceipt" WHERE key = $1`, [repeat])
    expect(receipt!.response).not.toContain(tokenOf(first.body.url).split('.')[3])
  })

  it('takes terms within the purpose and refuses others, a record type the purpose does not open or no module offers', async () => {
    const view = record(tenantA, P1, null, '1.000000', 100)
    const doc = await sales.post('/links', { purpose: 'DOCUMENT_VIEW', recordType: 'StoredFile', recordId: view, expiresInDays: 7, maxUses: 3 })
    expect(doc.status).toBe(201)
    expect(doc.body.link).toMatchObject({ maxUses: 3, expiresAt: '2026-11-04T09:00:00.000Z' })

    const tooMany = await sales.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: view, maxUses: 2 })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.error.issues).toEqual([expect.objectContaining({ path: 'maxUses' })])
    const wrongType = await sales.post('/links', { purpose: 'PO_CONFIRM', recordType: 'Quote', recordId: view })
    expect(wrongType.status).toBe(400)
    expect(wrongType.body.error.issues).toEqual([{ path: 'recordType', message: 'A PO_CONFIRM link opens a PurchaseOrder.' }])
    const notOffered = await sales.post('/links', { purpose: 'DEPOSIT_INFO', recordType: 'DepositRequest', recordId: view })
    expect(notOffered.status).toBe(409)
    expect(notOffered.body.error.code).toBe('invalid_state')
    expect((await sales.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: newId() })).status).toBe(404)
    expect((await sales.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: view, email: 'not an address' })).status).toBe(400)
  })

  it('needs links.manage over the record\'s company and party; another tenant\'s record is not found', async () => {
    const quoteP1 = record(tenantA, P1, null, '1.000000', 100)
    const quoteP2 = record(tenantA, P2, null, '1.000000', 100)
    expect((await planner.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quoteP1 })).status).toBe(403)
    expect((await salesP2.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quoteP1 })).status).toBe(403)
    expect((await salesP2.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quoteP2 })).status).toBe(201)
    expect((await salesB.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quoteP1 })).status).toBe(404)
  })
})

describe('POST /link/open (link session)', () => {
  it('opens the link, says what it allows, and records the open (not counted for a quote) with its evidence, audit and event', async () => {
    const quote = record(tenantA, P1, 'buyer@example.com', '50.000000', 5_000)
    const { link, token } = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quote })
    const opened = await open(token)
    expect(opened.status).toBe(200)
    expect(opened.body).toEqual({
      link: {
        purpose: 'QUOTE_ACCEPT',
        record: { type: 'Quote', id: quote },
        expiresAt: '2026-11-27T09:00:00.000Z',
        usesLeft: 1,
        answers: [
          { action: 'accept', typedName: 'required', email: true },
          { action: 'decline', typedName: 'optional', email: false },
        ],
      },
    })
    // The address is never shown to the link's holder.
    expect(JSON.stringify(opened.body)).not.toContain('buyer@example.com')

    const [evidence, ...more] = await evidenceOf(link.id)
    expect(more).toEqual([])
    expect(evidence).toMatchObject({ partyId: P1, action: 'OPENED', useNumber: null, typedName: null, emailCheck: 'NOT_ASKED', userAgent: 'Example Browser/1.0' })
    expect(evidence!.ipHash).toMatch(/^[0-9a-f]{64}$/)
    expect(evidence!.ipHash).not.toContain('127.0.0')
    const row = await linkRow(link.id)
    expect(row.uses).toBe(0)
    expect(row.lastUsedAt).toEqual(new Date(START))

    const [audit] = await rows(`SELECT * FROM "AuditLog" WHERE "recordId" = $1 AND action = 'links.open'`, [link.id])
    expect(audit).toMatchObject({ audience: 'LINK', actorId: link.id, partyId: P1, companyId: tenantA.companies[0]!.id })
    const [event] = await rows(`SELECT * FROM "OutboxEvent" WHERE type = 'link.used' AND subject = $1`, [link.id])
    expect(event).toMatchObject({ partyId: P1, companyId: tenantA.companies[0]!.id })
    expect(event!.payload).toEqual({ linkId: link.id, purpose: 'QUOTE_ACCEPT', action: 'open', recordType: 'Quote', recordId: quote, counted: false })
  })

  it('needs an Idempotency-Key, and a repeat answers without a second evidence row', async () => {
    const { link, token } = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, null, '1.000000', 100) })
    const without = await open(token, { key: null })
    expect(without.status).toBe(400)
    expect(without.body.error.issues).toEqual([{ path: 'headers/idempotency-key', message: 'Required.' }])
    const repeat = key('open')
    expect((await open(token, { key: repeat })).status).toBe(200)
    expect((await open(token, { key: repeat })).status).toBe(200)
    expect(await evidenceOf(link.id)).toHaveLength(1)
  })

  it('counts every open of a view purpose against its use limit', async () => {
    const { link, token } = await make(sales, { purpose: 'DOCUMENT_VIEW', recordType: 'StoredFile', recordId: record(tenantA, P1, null, '1.000000', 100), maxUses: 2 })
    expect((await open(token)).body.link.usesLeft).toBe(1)
    expect((await open(token)).body.link.usesLeft).toBe(0)
    expect((await open(token)).status).toBe(404)
    expect((await evidenceOf(link.id)).map((entry) => entry.useNumber)).toEqual([1, 2])
    expect((await linkRow(link.id)).uses).toBe(2)
  })

  it('is rate limited per client address', async () => {
    const limited = await h.app2({ linkUse: { max: 2, timeWindowMs: 60_000 } })
    const { token } = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, null, '1.000000', 100) })
    expect((await open(token, { target: limited })).status).toBe(200)
    expect((await open(token, { target: limited })).status).toBe(200)
    const third = await open(token, { target: limited })
    expect(third.status).toBe(429)
    expect(third.body.error.code).toBe('rate_limited')
  })
})

describe('a link that opens nothing', () => {
  it('gets one answer, whatever is wrong with it; no token at all is no session', async () => {
    const quote = record(tenantA, P1, null, '1.000000', 100)
    const { link, token } = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quote })
    const [tenantId, partyId, linkId, secret] = token.split('.') as [string, string, string, string]
    const otherSecret = mintLinkToken({ tenantId, partyId, linkId }).value
    const expired = await plant(tenantA, P1, { createdAt: '2026-10-20T09:00:00.000Z', expiresAt: '2026-10-27T09:00:00.000Z' })
    const revoked = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, null, '1.000000', 100) })
    expect((await sales.post(`/links/${revoked.link.id}/revoke`, {})).status).toBe(200)
    const usedUp = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, null, '1.000000', 100) })
    expect((await viaLink(usedUp.token, 'POST', '/test-links/decline', {})).status).toBe(200)

    const cases: Record<string, string> = {
      garbage: 'not-a-token',
      truncated: token.slice(0, -1),
      'unknown link': mintLinkToken({ tenantId, partyId, linkId: newId() }).value,
      'wrong secret': otherSecret,
      'forged party': `${tenantId}.${P2}.${linkId}.${secret}`,
      'other tenant': `${tenantB.id}.${partyId}.${linkId}.${secret}`,
      expired: expired.token,
      revoked: revoked.token,
      'used up': usedUp.token,
    }
    const shape = (got: Answer) => ({ status: got.status, code: got.body?.error?.code, message: got.body?.error?.message, keys: Object.keys(got.body?.error ?? {}).sort() })
    const expected = { status: 404, code: 'not_found', message: LINK_UNAVAILABLE, keys: ['code', 'message', 'requestId'] }
    for (const [label, value] of Object.entries(cases)) {
      expect(shape(await open(value)), label).toEqual(expected)
      expect(shape(await viaLink(value, 'GET', '/test-links/record')), label).toEqual(expected)
    }
    expect(await evidenceOf(link.id)).toEqual([])

    await rows(`UPDATE "Tenant" SET status = 'SUSPENDED' WHERE id = $1`, [tenantA.id])
    try {
      expect(shape(await open(token)), 'suspended tenant').toEqual(expected)
    } finally {
      await rows(`UPDATE "Tenant" SET status = 'ACTIVE' WHERE id = $1`, [tenantA.id])
    }
    expect((await open(token)).status).toBe(200)

    const none = await open(undefined)
    expect(none.status).toBe(401)
  })
})

describe('answers through the link (a module\'s route calling useLink)', () => {
  it('accepts a quote once, with the typed name and the address checked; then the link is used up', async () => {
    const { link, token } = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, 'buyer@example.com', '1.000000', 100) })
    const accepted = await viaLink(token, 'POST', '/test-links/accept', { typedName: '  Ada   Example ', email: 'Buyer@Example.com' })
    expect(accepted.status).toBe(200)
    expect(accepted.body.use).toEqual({ action: 'accept', counted: true, useNumber: 1, usesLeft: 0, typedName: 'Ada Example', emailCheck: 'MATCHED' })
    const [evidence] = await evidenceOf(link.id)
    expect(evidence).toMatchObject({ action: 'ACCEPTED', useNumber: 1, typedName: 'Ada Example', emailCheck: 'MATCHED', partyId: P1 })
    expect(evidence!.ipHash).toMatch(/^[0-9a-f]{64}$/)
    const [audit] = await rows(`SELECT * FROM "AuditLog" WHERE "recordId" = $1 AND action = 'links.accept'`, [link.id])
    expect(audit).toMatchObject({ audience: 'LINK', actorId: link.id, partyId: P1 })
    expect(audit!.after).toMatchObject({ typedName: 'Ada Example', emailCheck: 'MATCHED', counted: true, useNumber: 1 })

    expect((await viaLink(token, 'POST', '/test-links/accept', { typedName: 'Ada Example', email: 'buyer@example.com' })).status).toBe(404)
    expect((await open(token)).status).toBe(404)
    const listed = await sales.get(`/links?recordType=Quote&recordId=${link.recordId}`)
    expect(listed.body.links[0]).toMatchObject({ state: 'USED_UP', uses: 1, evidence: [expect.objectContaining({ action: 'ACCEPTED', typedName: 'Ada Example', emailCheck: 'MATCHED' })] })
  })

  it('refuses an accept without a name or with another address, and counts nothing', async () => {
    const { link, token } = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, 'buyer@example.com', '1.000000', 100) })
    const bare = await viaLink(token, 'POST', '/test-links/accept', {})
    expect(bare.status).toBe(400)
    expect(bare.body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(['typedName', 'email'])
    const other = await viaLink(token, 'POST', '/test-links/accept', { typedName: 'Ada Example', email: 'someone@example.com' })
    expect(other.status).toBe(400)
    expect(other.body.error.issues).toEqual([{ path: 'email', message: 'This is not the address this link was sent to.' }])
    expect(JSON.stringify(other.body)).not.toContain('buyer@example.com')
    expect(await evidenceOf(link.id)).toEqual([])
    expect((await linkRow(link.id)).uses).toBe(0)
  })

  it('records NOT_KNOWN when the link was made without an address', async () => {
    const { token } = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, 'buyer@example.com', '1.000000', 100), email: null })
    const accepted = await viaLink(token, 'POST', '/test-links/accept', { typedName: 'Ada Example' })
    expect(accepted.body.use.emailCheck).toBe('NOT_KNOWN')
  })

  it('uses a one-use link once when two answers race', async () => {
    const { link, token } = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, null, '1.000000', 100) })
    const answers = await Promise.all([
      viaLink(token, 'POST', '/test-links/accept', { typedName: 'Ada Example' }),
      viaLink(token, 'POST', '/test-links/accept', { typedName: 'Bo Example' }),
      viaLink(token, 'POST', '/test-links/decline', {}),
    ])
    expect(answers.map((entry) => entry.status).sort()).toEqual([200, 404, 404])
    expect((await linkRow(link.id)).uses).toBe(1)
    expect((await evidenceOf(link.id)).filter((entry) => entry.useNumber !== null)).toHaveLength(1)
  })

  it('lets a link do only what its purpose allows', async () => {
    const quote = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, null, '1.000000', 100) })
    const po = await make(sales, { purpose: 'PO_CONFIRM', recordType: 'PurchaseOrder', recordId: record(tenantA, P1, null, '1.000000', 100) })
    expect((await viaLink(quote.token, 'POST', '/test-links/confirm', {})).status).toBe(403)
    expect((await viaLink(po.token, 'POST', '/test-links/accept', { typedName: 'Bo Example' })).status).toBe(403)
    const confirmed = await viaLink(po.token, 'POST', '/test-links/confirm', { typedName: 'Bo Example' })
    expect(confirmed.body.use).toMatchObject({ action: 'confirm', counted: true, typedName: 'Bo Example', emailCheck: 'NOT_ASKED' })
    // A link session is not an office session.
    expect((await viaLink(quote.token, 'GET', `/links?recordType=Quote&recordId=${quote.link.recordId}`)).status).toBe(403)
  })
})

describe('the grants of the purpose: prices only on the party\'s own document', () => {
  it('shows a QUOTE_ACCEPT link its own quote with its prices, each party its own', async () => {
    const quoteP1 = record(tenantA, P1, null, '120.000000', 24_000)
    const quoteP2 = record(tenantA, P2, null, '99.000000', 9_900)
    const p1 = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quoteP1 })
    const p2 = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quoteP2 })
    const seenP1 = await viaLink(p1.token, 'GET', '/test-links/record')
    expect(seenP1.body).toEqual({ recordId: quoteP1, partyId: P1, lines: [{ sku: 'JKT-1', unitPrice: '120.000000' }], totalMinor: 24_000 })
    const seenP2 = await viaLink(p2.token, 'GET', '/test-links/record')
    expect(seenP2.body).toEqual({ recordId: quoteP2, partyId: P2, lines: [{ sku: 'JKT-1', unitPrice: '99.000000' }], totalMinor: 9_900 })
  })

  it('shows a PO_CONFIRM link no price field at all, on the record or the open', async () => {
    const po = record(tenantA, P1, null, '80.000000', 8_000)
    const { token } = await make(sales, { purpose: 'PO_CONFIRM', recordType: 'PurchaseOrder', recordId: po })
    const seen = await viaLink(token, 'GET', '/test-links/record')
    expect(seen.status).toBe(200)
    expect(seen.body).toEqual({ recordId: po, partyId: P1, lines: [{ sku: 'JKT-1' }] })
    const opened = await open(token)
    const keys = (value: unknown): string[] =>
      value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, inner]) => [name, ...keys(inner)]) : []
    expect([...keys(seen.body), ...keys(opened.body)].filter(looksLikeMoney)).toEqual([])
    expect(JSON.stringify(seen.body)).not.toMatch(/80\.0|8000/)
  })
})

describe('one record, one party, one tenant', () => {
  it('command() lets a link session change only its one record', async () => {
    // A link whose record is the link itself: the one record a W0 partner session may update (its version).
    const ownId = newId()
    const self = await plant(tenantA, P1, { id: ownId, purpose: 'DOCUMENT_VIEW', recordType: 'OneOffLink', recordId: ownId, maxUses: 5 })
    const sibling = await plant(tenantA, P1, { purpose: 'DOCUMENT_VIEW', recordType: 'OneOffLink', maxUses: 5 })
    const touched = await viaLink(self.token, 'POST', '/test-links/touch', { recordType: 'OneOffLink', recordId: ownId })
    expect(touched.status).toBe(200)
    expect(touched.body).toEqual({ version: 2 })
    expect((await linkRow(ownId)).version).toBe(2)
    for (const other of [
      { recordType: 'OneOffLink', recordId: sibling.linkId },
      { recordType: 'Quote', recordId: ownId },
      { recordType: 'Company', recordId: tenantA.companies[0]!.id },
    ]) {
      const refused = await viaLink(self.token, 'POST', '/test-links/touch', other)
      expect(refused.status, JSON.stringify(other)).toBe(403)
    }
    expect((await linkRow(sibling.linkId)).version).toBe(1)
  })

  it('the partner role reads only its party\'s links, never their hidden columns, and writes no other party\'s', async () => {
    const mine = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, null, '1.000000', 100), note: 'office only' })
    const theirs = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P2, null, '1.000000', 100) })
    const otherTenant = await make(salesB, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantB, P1, null, '1.000000', 100) })
    await h.database.withScope({ audience: 'partner', tenantId: tenantA.id, actorId: mine.link.id, partyId: P1 }, async (client) => {
      const seen = await client.oneOffLink.findMany({ select: { id: true, partyId: true } })
      expect(seen.map((entry) => entry.id)).toContain(mine.link.id)
      expect(seen.map((entry) => entry.id)).not.toContain(theirs.link.id)
      expect(seen.map((entry) => entry.id)).not.toContain(otherTenant.link.id)
      expect(new Set(seen.map((entry) => entry.partyId))).toEqual(new Set([P1]))
      await expect(client.$queryRaw`SELECT "note" FROM "OneOffLink"`).rejects.toThrow(/permission denied/)
      await expect(client.$queryRaw`SELECT "createdById" FROM "OneOffLink"`).rejects.toThrow(/permission denied/)
      await expect(client.oneOffLink.findMany()).rejects.toThrow(/permission denied/)
      await expect(client.linkEvidence.findMany({ select: { id: true } })).rejects.toThrow(/permission denied/)
      expect((await client.oneOffLink.updateMany({ where: { id: theirs.link.id }, data: { lastUsedAt: new Date(START) } })).count).toBe(0)
      await expect(client.oneOffLink.updateMany({ where: { id: mine.link.id }, data: { note: 'changed' } })).rejects.toThrow(/permission denied/)
    })
    // The same party id in another tenant is another party: tenant B's link is not reachable from tenant A's tokens.
    const [, , linkB, secretB] = otherTenant.token.split('.') as [string, string, string, string]
    expect((await open(`${tenantA.id}.${P1}.${linkB}.${secretB}`)).status).toBe(404)
    expect((await open(otherTenant.token)).status).toBe(200)
  })
})

describe('GET /links and POST /links/:linkId/revoke (office)', () => {
  it('lists a record\'s links within the caller\'s parties, newest first', async () => {
    const quote = record(tenantA, P1, null, '1.000000', 100)
    const first = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quote })
    h.clock.advance(1_000)
    const second = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quote })
    const listed = await sales.get(`/links?recordType=Quote&recordId=${quote}`)
    expect(listed.status).toBe(200)
    expect(listed.body.links.map((entry: { id: string }) => entry.id)).toEqual([second.link.id, first.link.id])
    expect((await salesP2.get(`/links?recordType=Quote&recordId=${quote}`)).body.links).toEqual([])
    expect((await planner.get(`/links?recordType=Quote&recordId=${quote}`)).status).toBe(403)
    expect((await salesB.get(`/links?recordType=Quote&recordId=${quote}`)).body.links).toEqual([])
  })

  it('revokes a link for good: it opens nothing from then on, and its evidence stays', async () => {
    const { link, token } = await make(sales, { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: record(tenantA, P1, null, '1.000000', 100) })
    expect((await open(token)).status).toBe(200)
    expect((await planner.post(`/links/${link.id}/revoke`, {})).status).toBe(403)
    expect((await salesP2.post(`/links/${link.id}/revoke`, {})).status).toBe(403)
    expect((await sales.post(`/links/${link.id}/revoke`, { version: 7 })).status).toBe(409)
    const revoked = await sales.post(`/links/${link.id}/revoke`, { version: 1, reason: 'Sent to the wrong address' })
    expect(revoked.status).toBe(200)
    expect(revoked.body.link).toMatchObject({ state: 'REVOKED', revokedAt: expect.any(String), version: 2, evidence: [expect.objectContaining({ action: 'OPENED' })] })
    expect((await open(token)).status).toBe(404)
    const again = await sales.post(`/links/${link.id}/revoke`, {})
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('invalid_state')
    const [audit] = await rows(`SELECT * FROM "AuditLog" WHERE "recordId" = $1 AND action = 'links.revoke'`, [link.id])
    expect(audit).toMatchObject({ reason: 'Sent to the wrong address', audience: 'OFFICE' })
    expect((await salesB.post(`/links/${link.id}/revoke`, {})).status).toBe(404)
  })
})
