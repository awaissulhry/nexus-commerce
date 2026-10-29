import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Connections & API on the local stack (B-W0-28, SCR-087), with the app's real routes: the accounts the caller's grant
 * reaches, never a secret (only whether one is saved), the calls of the last 24 h, the ledger and the webhooks; the
 * kill switch audited from → to, refused on a stale version and on a state it is in already; a tenant-wide account
 * paused only by someone whose grant reaches every company.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const tenantA = newId()
const tenantB = newId()
const companyOne = newId()
const companyTwo = newId()
const companyB = newId()
const user = newId()
const ses = newId()
const sdiOne = newId()
const sdiTwo = newId()
const otherTenant = newId()
const secret = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['integrations.view', 'integrations.manage'])] },
  'admin-one': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['integrations.view', 'integrations.manage'], [companyOne])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['integrations.view'])] },
  nobody: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['audit.read'])] },
}

const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
type Account = { id: string; code: string; status: string; mode: string; version: number; credentials: { saved: boolean }; calls24h: { total: number; failed: number }; inboundWaiting: number; inboundPath: string | null }

beforeAll(async () => {
  db = await migratedDatabase('admin_connections')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  for (const [tenantId, slug, companies] of [
    [tenantA, 'cn-a', [companyOne, companyTwo]],
    [tenantB, 'cn-b', [companyB]],
  ] as const) {
    await db.admin.query('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) {
      await db.admin.query('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-${index}`])
    }
  }
  await db.admin.query(
    `INSERT INTO "SecretValue" (id, "tenantId", purpose, "keyId", algorithm, "wrappedKey", iv, ciphertext, "authTag") VALUES ($1, $2, 'integration.credentials', 'local:test', 'AES-256-GCM', '\\x00', '\\x00', '\\x00', '\\x00')`,
    [secret, tenantA],
  )
  const account = (id: string, tenantId: string, companyId: string | null, provider: string, code: string, extra = '') =>
    db.admin.query(
      `INSERT INTO "IntegrationAccount" (id, "tenantId", "companyId", provider, code, label, mode, settings${extra ? ', "credentialsSecretId"' : ''}) VALUES ($1, $2, $3, $4, $5, $5, 'FAKE', '{"region":"eu-south-1","nested":{"x":1}}'${extra ? ', $6' : ''})`,
      extra ? [id, tenantId, companyId, provider, code, extra] : [id, tenantId, companyId, provider, code],
    )
  await account(ses, tenantA, null, 'SES', 'ses')
  await account(sdiOne, tenantA, companyOne, 'SDI', 'sdi-one', secret)
  await account(sdiTwo, tenantA, companyTwo, 'SDI', 'sdi-two')
  await account(otherTenant, tenantB, companyB, 'SDI', 'sdi-b')
  const now = Date.now()
  for (const [index, status] of ['SUCCEEDED', 'SUCCEEDED', 'FAILED', 'REFUSED'].entries()) {
    const startedAt = new Date(now - (index + 1) * 60_000)
    await db.admin.query(
      `INSERT INTO "IntegrationCall" (id, "tenantId", "companyId", "accountId", provider, mode, operation, "requestId", "startedAt", "finishedAt", "durationMs", attempts, status, "requestSummary")
       VALUES ($1, $2, $3, $4, 'SDI', 'FAKE', 'sdi.send_invoice', $5, $6, $6, 12, 1, $7, '{"to":"buyer@example.com"}')`,
      [newId(), tenantA, companyOne, sdiOne, `req-${index}`, startedAt, status],
    )
  }
  // A call older than a day: in the ledger, not in the 24 h counts.
  await db.admin.query(
    `INSERT INTO "IntegrationCall" (id, "tenantId", "companyId", "accountId", provider, mode, operation, "requestId", "startedAt", "finishedAt", "durationMs", attempts, status)
     VALUES ($1, $2, $3, $4, 'SDI', 'FAKE', 'sdi.get_status', 'req-old', $5, $5, 8, 1, 'SUCCEEDED')`,
    [newId(), tenantA, companyOne, sdiOne, new Date(now - 3 * 24 * 3_600_000)],
  )
  for (const status of ['RECEIVED', 'PROCESSED', 'FAILED']) {
    const id = newId()
    await db.admin.query(
      `INSERT INTO "InboundWebhook" (id, "tenantId", "companyId", "accountId", provider, verified, "dedupeKey", "eventType", "bodySha256", "bodyBytes", body, "receivedAt", "requestId", status)
       VALUES ($1, $2, $3, $4, 'SDI', true, $5, 'RC', 'abc', 120, '{"secret":"never shown"}', now(), 'req-in', 'RECEIVED')`,
      [id, tenantA, companyOne, sdiOne, `key-${status}`],
    )
    if (status === 'PROCESSED') await db.admin.query(`UPDATE "InboundWebhook" SET status = 'PROCESSED', attempts = 1, "processedAt" = now() WHERE id = $1`, [id])
    if (status === 'FAILED') await db.admin.query(`UPDATE "InboundWebhook" SET status = 'FAILED', attempts = 1, "lastError" = 'Unknown invoice' WHERE id = $1`, [id])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('GET /integrations/accounts', () => {
  it('lists the tenant\'s accounts with their state and counts, never a secret', async () => {
    const response = await call('admin', 'GET', '/integrations/accounts')
    expect(response.statusCode).toBe(200)
    const accounts = (response.json() as { accounts: Account[] }).accounts
    expect(accounts.map((account) => account.code)).toEqual(['ses', 'sdi-one', 'sdi-two'])
    const one = accounts.find((account) => account.code === 'sdi-one')!
    expect(one).toMatchObject({ mode: 'FAKE', status: 'ACTIVE', credentials: { saved: true }, calls24h: { total: 4, failed: 2 }, inboundWaiting: 2, inboundPath: `/inbound/sdi/${tenantA}/${sdiOne}` })
    expect(one).toMatchObject({ settings: { region: 'eu-south-1' } })
    expect(JSON.stringify(response.json())).not.toMatch(/nested|never shown|ciphertext|wrappedKey/)
  })

  it('keeps to the companies a grant reaches (a tenant-wide account to anyone holding the right); another tenant never', async () => {
    const response = await call('admin-one', 'GET', '/integrations/accounts')
    expect((response.json() as { accounts: Account[] }).accounts.map((account) => account.code)).toEqual(['ses', 'sdi-one'])
    expect((await call('admin-one', 'GET', `/integrations/accounts/${sdiTwo}`)).statusCode).toBe(404)
    expect((await call('admin', 'GET', `/integrations/accounts/${otherTenant}`)).statusCode).toBe(404)
    expect((await call('nobody', 'GET', '/integrations/accounts')).statusCode).toBe(403)
  })
})

describe('the ledgers', () => {
  it('lists the calls newest first, pages, and filters the failures; no request or response summary', async () => {
    const first = await call('viewer', 'GET', `/integrations/accounts/${sdiOne}/calls?limit=2`)
    expect(first.statusCode).toBe(200)
    const page = first.json() as { calls: Array<{ id: string; status: string; requestId: string }>; nextBefore: string | null }
    expect(page.calls.map((item) => item.requestId)).toEqual(['req-0', 'req-1'])
    expect(page.nextBefore).toBe(page.calls[1]!.id)
    const rest = (await call('viewer', 'GET', `/integrations/accounts/${sdiOne}/calls?limit=10&before=${page.nextBefore}`)).json() as { calls: Array<{ requestId: string }> }
    expect(rest.calls.map((item) => item.requestId)).toEqual(['req-2', 'req-3', 'req-old'])
    const failed = (await call('viewer', 'GET', `/integrations/accounts/${sdiOne}/calls?failed=true`)).json() as { calls: Array<{ status: string }> }
    expect(failed.calls.map((item) => item.status)).toEqual(['FAILED', 'REFUSED'])
    expect(JSON.stringify(first.json())).not.toContain('buyer@example.com')
  })

  it('lists the received webhooks without their bodies, by state', async () => {
    const response = await call('viewer', 'GET', `/integrations/accounts/${sdiOne}/inbound?status=FAILED`)
    expect(response.statusCode).toBe(200)
    expect((response.json() as { inbound: Array<{ status: string; eventType: string }> }).inbound).toEqual([expect.objectContaining({ status: 'FAILED', eventType: 'RC', verified: true })])
    expect(JSON.stringify((await call('viewer', 'GET', `/integrations/accounts/${sdiOne}/inbound`)).json())).not.toContain('never shown')
  })
})

describe('pause and resume', () => {
  it('pauses and resumes a company\'s account with a version, audited from → to; a stale screen or a repeat is refused', async () => {
    const paused = await call('admin-one', 'POST', `/integrations/accounts/${sdiOne}/pause`, { version: 1, reason: 'Provider maintenance tonight' })
    expect(paused.statusCode).toBe(200)
    expect((paused.json() as { account: Account }).account).toMatchObject({ status: 'PAUSED', version: 2 })
    expect((await call('admin-one', 'POST', `/integrations/accounts/${sdiOne}/pause`, { version: 2 })).statusCode).toBe(409)
    expect((await call('admin-one', 'POST', `/integrations/accounts/${sdiOne}/resume`, { version: 1 })).statusCode).toBe(409)
    const resumed = await call('admin-one', 'POST', `/integrations/accounts/${sdiOne}/resume`, { version: 2 })
    expect((resumed.json() as { account: Account }).account).toMatchObject({ status: 'ACTIVE', version: 3 })
    const { rows } = await db.admin.query(`SELECT action, before, after, reason FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at`, [sdiOne])
    expect(rows).toEqual([
      { action: 'integration.pauseAccount', before: { status: 'ACTIVE', mode: 'FAKE' }, after: { status: 'PAUSED', mode: 'FAKE' }, reason: 'Provider maintenance tonight' },
      { action: 'integration.resumeAccount', before: { status: 'PAUSED', mode: 'FAKE' }, after: { status: 'ACTIVE', mode: 'FAKE' }, reason: null },
    ])
  })

  it('a tenant-wide account needs a grant over every company; reading alone never pauses', async () => {
    expect((await call('admin-one', 'POST', `/integrations/accounts/${ses}/pause`, { version: 1 })).statusCode).toBe(403)
    expect((await call('viewer', 'POST', `/integrations/accounts/${sdiTwo}/pause`, { version: 1 })).statusCode).toBe(403)
    const paused = await call('admin', 'POST', `/integrations/accounts/${ses}/pause`, { version: 1 })
    expect(paused.statusCode).toBe(200)
    expect((paused.json() as { account: Account }).account.status).toBe('PAUSED')
  })
})
