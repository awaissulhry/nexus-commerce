import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { approvingTimesheet } from '../../people/timesheets/approval-guard'
import { decidingQuote } from './approval-guard'

/**
 * Nobody approves their own request (B-W2b-377; follow-up XF5:01; Owner answer Q3 of W2b-5 = A, the Owner included) on the
 * two domain approvals that missed it — the quote's and the timesheet's: the routes answer in words before B-W2b-363's
 * database rules (QuoteApproval_not_own, TimesheetApproval_not_own), and a write that reaches those rules answers 409 in the
 * same words, never a 500 — and the change order's approver picker never offers the person naming the approvers. The real
 * app over a throwaway PostgreSQL 17 database with every seed; sessions made by the test (the seed's Owner is E1's own office
 * account). Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/quotes/approval-guard`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'guards-377'
const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = { tenant: id('tenant'), companyA: id('company:A'), siteA1: id('site:A1'), owner: id('actor'), operator: id('worker:A1:operator') }

let h: Harness
let app: FastifyInstance
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
function grantsOf(role: string): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, SessionContext> = {}
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `g377-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function answer(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const paths = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => String(issue.path))
const scoped = <T>(actorId: string, work: (client: Parameters<Parameters<FactoryDatabase['withScope']>[1]>[0]) => Promise<T>) => h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId }, work)

beforeAll(async () => {
  h = await startHarness('guards_w2b377')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  SESSIONS.seedOwner = { audience: 'office', tenantId: A.tenant, actorId: A.owner, grants: grantsOf('owner') }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('a quote approval is never decided by who asked for it (XF5:01)', () => {
  it('the route says it (403, refusal/OWN_REQUEST); the database’s rule reached past it answers 409 in the same words', async () => {
    const draft = await one<{ quoteId: string; versionId: string; partyId: string }>(
      `SELECT q.id AS "quoteId", v.id AS "versionId", q."partyId" FROM "Quote" q JOIN "QuoteVersion" v ON v."quoteId" = q.id WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0002' ORDER BY v.revision DESC LIMIT 1`,
      [A.tenant],
    )
    // SEED-Q-0002 made to wait for a margin approval the seed Owner asked (test data past the guards).
    await force(`UPDATE "QuoteVersion" SET status = 'PENDING_APPROVAL' WHERE id = $1`, [draft.versionId])
    await force(`UPDATE "Quote" SET status = 'PENDING_APPROVAL' WHERE id = $1`, [draft.quoteId])
    const approvalId = newId()
    await force(
      `INSERT INTO "QuoteApproval" (id, "tenantId", "versionId", "partyId", reasons, details, "requestNote", status, "createdAt", "updatedAt", "createdById")
       VALUES ($1, $2, $3, $4, ARRAY['MARGIN_FLOOR']::"QuoteApprovalReason"[], '{}'::jsonb, 'Asked by the Owner (made-up).', 'PENDING', now(), now(), $5)`,
      [approvalId, A.tenant, draft.versionId, draft.partyId, A.owner],
    )
    const version = (await one<{ version: number }>(`SELECT version FROM "Quote" WHERE id = $1`, [draft.quoteId])).version
    const own = await answer('seedOwner', 'POST', `/sales/quotes/${draft.quoteId}/approval/approve`, { version }, 403)
    expect(own.error.message).toBe('You asked for this approval: another approver decides.')
    expect(paths(own)).toEqual(['refusal/OWN_REQUEST'])
    expect(paths(await answer('seedOwner', 'POST', `/sales/quotes/${draft.quoteId}/approval/reject`, { version, reason: 'x' }, 403))).toEqual(['refusal/OWN_REQUEST'])
    // The write itself, by the asker (as a later path would), reaches the database's rule: a conflict in words, not a 500.
    const refused = await scoped(A.owner, (client) => decidingQuote(() => client.quoteApproval.update({ where: { id: approvalId }, data: { status: 'APPROVED', decidedAt: new Date(), decidedById: A.owner, version: { increment: 1 } }, select: { id: true } }))).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(DomainError)
    expect(refused).toMatchObject({ code: 'conflict', message: 'You asked for this approval: another approver decides.', issues: [{ path: 'refusal/OWN_REQUEST' }] })
    // Withdrawn by the asker (a reopen) passes both.
    await scoped(A.owner, (client) => decidingQuote(() => client.quoteApproval.update({ where: { id: approvalId }, data: { status: 'WITHDRAWN', decidedAt: new Date(), decidedById: A.owner, version: { increment: 1 } }, select: { id: true } })))
    expect((await one<{ status: string }>(`SELECT status::text AS status FROM "QuoteApproval" WHERE id = $1`, [approvalId])).status).toBe('WITHDRAWN')
  })
})

describe('a timesheet is never approved by its own person, even linked only through their floor worker (XF5:01)', () => {
  it('refuses the lead’s and HR’s yes in words (409 holds/OWN_TIMESHEET); the database’s rule answers in the same words', async () => {
    // E1's October timesheet, the site's attendance switched on (the people seed keeps it off).
    const notice = await one<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED' LIMIT 1`, [A.tenant, A.companyA])
    const dpia = await one<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED' LIMIT 1`, [A.tenant, A.companyA])
    await admin(
      `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ATTENDANCE', 'NOT_REQUIRED', 'SAMPLE - made-up counsel opinion (art. 4 c.2)', $5, $6, now() - interval '400 days', $7, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, notice.id, dpia.id, A.owner],
    )
    const sheetId = firstId('time:timesheet:A1:operator:2026-10')
    const sheet = await one<{ version: number; employeeId: string }>(`SELECT version, "employeeId" FROM "TimesheetApproval" WHERE id = $1`, [sheetId])
    // The person's office account is named only by their floor worker now (the employee record names none: allowed).
    await force(`UPDATE "Employee" SET "userId" = NULL WHERE id = $1`, [sheet.employeeId])
    await force(`UPDATE "Worker" SET "userId" = $2 WHERE "employeeId" = $1`, [sheet.employeeId, A.owner])
    expect((await admin(`SELECT 1 FROM "Worker" WHERE "employeeId" = $1 AND "userId" = $2`, [sheet.employeeId, A.owner])).length).toBeGreaterThan(0)
    const lead = await answer('seedOwner', 'POST', `/people/timesheets/${sheetId}/lead-approve`, { version: sheet.version }, 409)
    expect(paths(lead)).toContain('holds/OWN_TIMESHEET')
    expect(paths(await answer('seedOwner', 'POST', `/people/timesheets/${sheetId}/hr-approve`, { version: sheet.version }, 409))).toContain('holds/OWN_TIMESHEET')
    // The record's buttons say it before the click.
    const record = await answer('seedOwner', 'GET', `/people/timesheets/${sheetId}`, undefined, 200)
    expect(JSON.stringify(record)).toContain('OWN_TIMESHEET')
    // The write itself reaches TimesheetApproval_not_own: a 409 in words.
    const refused = await scoped(A.owner, (client) => approvingTimesheet(() => client.timesheetApproval.update({ where: { id: sheetId }, data: { status: 'LEAD_APPROVED', leadApprovedAt: new Date(), leadApprovedById: A.owner, version: { increment: 1 } }, select: { id: true } }))).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(DomainError)
    expect(refused).toMatchObject({ code: 'conflict', issues: expect.arrayContaining([expect.objectContaining({ path: 'holds/OWN_TIMESHEET' })]) })
  })
})

describe('a change order’s approvers (XF5:01)', () => {
  it('never offers the person naming them (naming oneself is refused SELF_NAMED)', async () => {
    const order = await one<{ id: string; companyId: string }>(`SELECT id, "companyId" FROM "ChangeOrder" WHERE id = $1`, [firstId('changes:order:JKT-02:1')])
    // A co-manager, a real person holding the production manager's template.
    const manager = newId()
    const roleId = (await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'production_manager'`, [A.tenant])).id
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up Co-manager', 'ACTIVE')`, [manager, A.tenant, `w2b377-manager-${run}@example.com`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), A.tenant, manager, roleId])
    SESSIONS.manager = { audience: 'office', tenantId: A.tenant, actorId: manager, grants: grantsOf('production_manager') }
    const asManager = await answer('manager', 'GET', `/product/change-orders/${order.id}/approver-options`, undefined, 200)
    expect(asManager.people.map((person: Json) => person.id)).not.toContain(manager)
    const asOwner = await answer('seedOwner', 'GET', `/product/change-orders/${order.id}/approver-options`, undefined, 200)
    expect(asOwner.people.map((person: Json) => person.id)).toContain(manager)
  })
})
