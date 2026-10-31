import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { sortMail } from '@nexus/factory-domain/email-in/rules'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../platform/auth/sessions/testing/harness'
import { complaintOfMail } from '../../platform/email-in/matchers/complaint'
import { sortFactsOf } from '../../platform/email-in/match'

/**
 * B-W2b-17 quality follow-ups on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (row-level security and every guard real), tenant A from EVERY seed. Test sessions for most calls; two
 * people signed in through the real sign-in with two-factor for the e-signatures (a hold's release, letting the placer
 * release). Every name and number is made up.
 *   Z5:01 every new hold numbered (HLD-…), found by number; who releases a hold as a setting (the placer may, by the
 *         company's rule: the looser rule asks why and a fresh code);
 *   Z5:02 the containment time as a setting (the NCR's due time follows it), a cancelled action keeps its reason;
 *   Z5:03 an inspection's due time (one command for many, refusals in words, the overdue filter, the bench list);
 *   Z5:04 / Z5:05 an NCR from picked defect lines, the title in parts;
 *   Z5:06 one owner for many NCRs in one command (every one or none);
 *   Z5:07 NCR decisions waiting for an approval in Home › Approvals (never the decider's);
 *   Z5:09 a complaint's Link… / Unlink, and a customer's mail naming a complaint joins its thread.
 * (Z5:08 the bench's numbers: final.pg; Z5:10 renewals as rows: compliance/renewals.) Run with
 * `node scripts/factory/run-pg-tests.mjs modules/quality/followups-w2b`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'quality-w2b17'
const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), companyA: id('company:A'), companyB: id('company:B'), siteA1: id('site:A1') }
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

let h: Harness
let app: FastifyInstance
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (permissions: readonly Permission[], scope: Partial<Grant> = {}): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(permissions, scope)] })
const QUALITY: Permission[] = [
  'home.view',
  'quality.holds.view',
  'quality.holds.place',
  'quality.ncr.view',
  'quality.ncr.raise',
  'quality.ncr.manage',
  'quality.ncr.approve',
  'quality.inspections.view',
  'quality.inspections.record',
  'quality.complaints.view',
  'quality.complaints.log',
  'quality.complaints.manage',
  'quality.settings.manage',
]
const SESSIONS: Record<string, SessionContext> = {
  quality: office(QUALITY),
  decider: office(['home.view', 'quality.ncr.view', 'quality.ncr.raise', 'quality.ncr.manage', 'quality.ncr.approve']),
  approver: office(['home.view', 'quality.ncr.view', 'quality.ncr.approve']),
  viewer: office(['home.view', 'quality.holds.view', 'quality.ncr.view', 'quality.inspections.view', 'quality.complaints.view']),
  companyB: office(QUALITY, { companies: [A.companyB] }),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `w2b17-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)

interface Person {
  readonly id: string
  readonly browser: Browser
  readonly secret: string
}
const signedIn = async (email: string, role: string): Promise<Person> => {
  const user = await addUser(h, TENANT, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return { id: user.id, browser, secret: await enrolTotp(h, browser) }
}
async function as(person: Person, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await person.browser.send(method as 'POST', url, body, { headers: { 'idempotency-key': freshKey() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

let qa: Person
let owner: Person
let lot: { id: string; code: string }

beforeAll(async () => {
  h = await startHarness('quality_w2b17')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  qa = await signedIn('qa.w2b17@example.com', 'quality_inspector')
  owner = await signedIn('owner.w2b17@example.com', 'owner')
  lot = (
    await admin<{ id: string; code: string }>(
      `SELECT l.id::text, l.code FROM "Lot" l JOIN "Item" i ON i.id = l."itemId" JOIN "StockMove" m ON m."lotId" = l.id
        WHERE l."tenantId" = $1 AND l."siteId" = $2 AND l."qualityStatus" = 'RELEASED' AND i.tracking = 'LOT' AND m."toLocationId" IS NOT NULL ORDER BY l.code LIMIT 1`,
      [A.tenant, A.siteA1],
    )
  )[0]!
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

// ---- Z5:01 ----------------------------------------------------------------------------------------------------------------

describe('hold numbers and who releases a hold (Z5:01)', () => {
  let hold: Json

  it('numbers every new hold from its company\'s HOLD series and finds it by number; an older hold has none', async () => {
    hold = (await as(qa, 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [lot.id], reasonCode: 'SUPPLIER_CHECK', reasonNote: 'A supplier warned of a dye batch' }, 201)).hold
    expect(hold.number).toMatch(/^HLD-\d{4}-\d{4}$/)
    expect(await admin('SELECT "recordType", kind::text AS kind FROM "NumberAllocation" WHERE "recordId" = $1', [hold.id])).toEqual([{ recordType: 'QualityHold', kind: 'HOLD' }])
    const found = await ok('viewer', 'GET', `/quality/holds?q=${encodeURIComponent(hold.number.slice(-4))}`)
    expect(found.holds.map((row: Json) => row.id)).toEqual([hold.id])
    expect((await ok('viewer', 'GET', '/quality/holds?q=NO-SUCH-HOLD')).holds).toEqual([])
    const all = await ok('viewer', 'GET', '/quality/holds?status=ALL')
    expect(all.holds.filter((row: Json) => row.number === null).length).toBeGreaterThan(0)
  })

  it('the person who placed it is refused the release until the company\'s rule lets the placer release', async () => {
    await stepUp(h, qa.browser, qa.secret)
    const before = await as(qa, 'GET', `/quality/holds/${hold.id}`)
    expect(before.release).toMatchObject({ placerMayRelease: false, releasable: false })
    const refusal = await as(qa, 'POST', `/quality/holds/${hold.id}/release`, { version: before.hold.version }, 409)
    expect(refusal.error.issues.map((issue: Json) => issue.path)).toEqual(['release/NOT_PLACER'])

    // The rule: read by whoever sees holds, changed by quality.settings.manage (the owner).
    const read = await ok('viewer', 'GET', `/quality/holds/settings?companyId=${A.companyA}`)
    expect(read).toEqual({ settings: { companyId: A.companyA, inForce: { placerMayRelease: false, source: 'DEFAULT' }, own: null, version: 0 }, mayChange: false })
    expect((await as(qa, 'PUT', '/quality/holds/settings', { companyId: A.companyA, placerMayRelease: true, version: 0, reason: 'We are two people only' }, 403)).error.code).toBe('forbidden')
    // The looser rule asks why, then a fresh code.
    expect((await as(owner, 'PUT', '/quality/holds/settings', { companyId: A.companyA, placerMayRelease: true, version: 0 }, 400)).error.issues.map((issue: Json) => issue.path)).toEqual(['body/reason'])
    await stepUp(h, owner.browser, owner.secret)
    const saved = await as(owner, 'PUT', '/quality/holds/settings', { companyId: A.companyA, placerMayRelease: true, version: 0, reason: 'Two quality people only on the night shift' })
    expect(saved).toMatchObject({ loosened: true, settings: { inForce: { placerMayRelease: true, source: 'COMPANY' }, own: { placerMayRelease: true }, version: 1 } })
    expect((await events('quality.hold_rule_changed')).at(-1)).toEqual({ companyId: A.companyA, placerMayRelease: true, previous: null, loosened: true })
    // A stale version is refused.
    await as(owner, 'PUT', '/quality/holds/settings', { companyId: A.companyA, placerMayRelease: false, version: 0 }, 409)

    const now = await as(qa, 'GET', `/quality/holds/${hold.id}`)
    expect(now.release.placerMayRelease).toBe(true)
    expect(now.release.checks.find((check: Json) => check.key === 'NOT_PLACER')).toMatchObject({ ok: true, words: expect.stringMatching(/rule lets the person who placed it release/) })
    await stepUp(h, qa.browser, qa.secret)
    const released = await as(qa, 'POST', `/quality/holds/${hold.id}/release`, { version: now.hold.version, note: 'Dye batch checked: not ours' })
    expect(released.hold).toMatchObject({ status: 'RELEASED', number: hold.number })

    // The stricter rule asks neither a reason nor a code; the tenant-wide row is changed only over every company.
    const back = await as(owner, 'PUT', '/quality/holds/settings', { companyId: A.companyA, placerMayRelease: null, version: 1 })
    expect(back).toMatchObject({ loosened: false, settings: { inForce: { placerMayRelease: false, source: 'DEFAULT' }, own: { placerMayRelease: null }, version: 2 } })
    expect((await refused('companyB', 'PUT', '/quality/holds/settings', { companyId: null, placerMayRelease: false, version: 0 }, 403)).code).toBe('forbidden')
  })
})

// ---- Z5:02, Z5:04, Z5:05, Z5:06 ----------------------------------------------------------------------------------------

describe('NCRs: the containment time, cancel reasons, picked defects, titles in parts, one owner for many', () => {
  let ncr: Json

  it('the company\'s containment time sets a new NCR\'s due time (1 to 720 hours; else the tenant\'s, else 24)', async () => {
    // (The company's QualitySettings row exists already: the hold rule above made it, without a containment time.)
    const read = (await ok('viewer', 'GET', `/quality/ncr/settings?companyId=${A.companyA}`)).settings
    expect(read).toMatchObject({ companyId: A.companyA, inForce: { hours: 24, source: 'DEFAULT' }, own: { defaultContainmentHours: null } })
    expect(paths(await refused('quality', 'PUT', '/quality/ncr/settings', { companyId: A.companyA, defaultContainmentHours: 721, version: read.version }, 400))).toEqual(['body/defaultContainmentHours'])
    await refused('viewer', 'PUT', '/quality/ncr/settings', { companyId: A.companyA, defaultContainmentHours: 4, version: read.version }, 403)
    await refused('quality', 'PUT', '/quality/ncr/settings', { companyId: A.companyA, defaultContainmentHours: 4, version: read.version + 3 }, 409)
    const saved = await ok('quality', 'PUT', '/quality/ncr/settings', { companyId: A.companyA, defaultContainmentHours: 4, version: read.version })
    expect(saved.settings).toMatchObject({ inForce: { hours: 4, source: 'COMPANY' }, own: { defaultContainmentHours: 4 }, version: read.version + 1 })
    expect((await events('ncr.settings_changed')).at(-1)).toEqual({ companyId: A.companyA, defaultContainmentHours: 4, previous: null })
    const foundOn = new Date(Date.now() - 3_600_000).toISOString()
    ncr = (await ok('quality', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'Loose seams on two jackets', severity: 'MAJOR', quantityAffected: '2', uom: 'PCS', foundOn }, 201)).record.ncr
    expect(new Date(ncr.containmentDueAt).getTime() - new Date(foundOn).getTime()).toBe(4 * 3_600_000)
    expect((await ok('quality', 'GET', `/quality/ncr/prefill?recordType=Lot&recordId=${lot.id}`)).prefill).toMatchObject({ containmentHours: 4, titleParts: { key: 'LOT', values: { lot: lot.code } }, defectIds: [] })
  })

  it('a cancelled containment action keeps its reason in its own column', async () => {
    const added = (await ok('quality', 'POST', `/quality/ncr/${ncr.id}/containment`, { version: ncr.version, kind: 'OTHER', description: 'Check the other colour' }, 201)).record
    const action = added.containment.at(-1)
    const cancelled = (await ok('quality', 'POST', `/quality/ncr/${ncr.id}/containment/${action.id}/cancel`, { version: action.version, reason: 'The other colour was never cut' })).record
    expect(cancelled.containment.at(-1)).toMatchObject({ status: 'CANCELLED', cancelReason: 'The other colour was never cut', evidenceNote: null })
    expect(await admin('SELECT "cancelReason", "evidenceNote" FROM "NcrContainmentAction" WHERE id = $1', [action.id])).toEqual([{ cancelReason: 'The other colour was never cut', evidenceNote: null }])
    ncr = cancelled.ncr
  })

  it('raises an NCR from the defect lines picked on an inspection, its title in parts', async () => {
    const inspection = (await admin<{ id: string; number: string; workOrderId: string; siteId: string; tenantId: string }>('SELECT id::text, number, "workOrderId"::text AS "workOrderId", "siteId"::text AS "siteId", "tenantId"::text AS "tenantId" FROM "Inspection" WHERE "tenantId" = $1 AND status = \'OPEN\' ORDER BY number LIMIT 1', [A.tenant]))[0]!
    const lines = [newId(), newId()]
    for (const [index, lineId] of lines.entries()) {
      await admin(
        `INSERT INTO "InspectionDefect" (id, "tenantId", "siteId", "workOrderId", "inspectionId", "defectClass", code, description, quantity, zone, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())`,
        [lineId, inspection.tenantId, inspection.siteId, inspection.workOrderId, inspection.id, index === 0 ? 'MAJOR' : 'MINOR', index === 0 ? 'SEAM-OPEN' : 'STITCH-SKIP', null, index + 2, 'CUFF'],
      )
    }
    const both = (await ok('quality', 'GET', `/quality/ncr/prefill?recordType=Inspection&recordId=${inspection.id}&defectIds=${lines.join(',')}`)).prefill
    expect(both).toMatchObject({ titleParts: { key: 'INSPECTION_DEFECTS', values: { count: '2', inspection: inspection.number } }, quantityAffected: '5.0000', severity: 'MAJOR', zone: 'CUFF', defectIds: [...lines].sort() })
    expect(both.description).toMatch(/SEAM-OPEN × 2 \(CUFF\); STITCH-SKIP × 3 \(CUFF\)|STITCH-SKIP × 3 \(CUFF\); SEAM-OPEN × 2 \(CUFF\)/)
    const one = (await ok('quality', 'GET', `/quality/ncr/prefill?recordType=Inspection&recordId=${inspection.id}&defectIds=${lines[1]}`)).prefill
    expect(one).toMatchObject({ titleParts: { key: 'INSPECTION_DEFECT', values: { defect: 'STITCH-SKIP', inspection: inspection.number } }, quantityAffected: '3.0000', severity: 'MINOR' })
    await refused('quality', 'GET', `/quality/ncr/prefill?recordType=Inspection&recordId=${inspection.id}&defectIds=${newId()}`, undefined, 404)
    expect(paths(await refused('quality', 'GET', `/quality/ncr/prefill?recordType=Lot&recordId=${lot.id}&defectIds=${lines[0]}`, undefined, 400))).toEqual(['defectIds'])
    const raised = (await ok('quality', 'POST', '/quality/ncr', { from: { recordType: 'Inspection', recordId: inspection.id, defectIds: [lines[0]] } }, 201)).record.ncr
    expect(raised).toMatchObject({ severity: 'MAJOR', zone: 'CUFF' })
    expect(Number(raised.quantityAffected)).toBe(2)
    expect((await ok('quality', 'GET', `/quality/ncr/prefill?recordType=Bundle&recordId=${(await admin<{ id: string }>('SELECT id::text FROM "Bundle" WHERE "tenantId" = $1 LIMIT 1', [A.tenant]))[0]!.id}`)).prefill.titleParts).toMatchObject({ key: 'BUNDLE_REJECTED' })
  })

  it('gives many NCRs one owner in one command — every one or none', async () => {
    const seeded = (await ok('quality', 'GET', '/quality/ncr?open=true')).items as Json[]
    const two = [ncr, seeded.find((row) => row.id !== ncr.id && row.siteId === A.siteA1)!].map((row) => ({ id: row.id, version: row.version }))
    const stale = await refused('quality', 'POST', '/quality/ncr/assign', { ncrs: [two[0], { ...two[1]!, version: two[1]!.version + 5 }], ownerId: qa.id }, 409)
    expect(paths(stale)).toEqual(['ncrs/1/STALE'])
    expect(await admin('SELECT "ownerId"::text AS owner FROM "Nonconformance" WHERE id = $1', [two[0]!.id])).toEqual([{ owner: ncr.ownerId ?? null }])
    await refused('viewer', 'POST', '/quality/ncr/assign', { ncrs: two, ownerId: qa.id }, 403)
    expect(paths(await refused('quality', 'POST', '/quality/ncr/assign', { ncrs: [two[0], two[0]], ownerId: qa.id }, 400))).toEqual(['body/ncrs'])
    const before = (await events('ncr.changed')).length
    const done = await ok('quality', 'POST', '/quality/ncr/assign', { ncrs: two, ownerId: qa.id })
    expect(done.changed.sort()).toEqual(two.map((row) => row.id).sort())
    expect(done.ncrs.map((row: Json) => row.ownerId)).toEqual([qa.id, qa.id])
    expect((await events('ncr.changed')).slice(before).map((payload) => payload.fields)).toEqual([['ownerId'], ['ownerId']])
    // The same owner again changes nothing (each version read now).
    const again = await ok('quality', 'POST', '/quality/ncr/assign', { ncrs: done.ncrs.map((row: Json) => ({ id: row.id, version: row.version })), ownerId: qa.id })
    expect(again.changed).toEqual([])
  })
})

// ---- Z5:03 ----------------------------------------------------------------------------------------------------------------

describe('inspection due times (Z5:03)', () => {
  it('sets by when open inspections are due in one command; the list and the bench say it; refusals in words', async () => {
    const [open, passed] = [
      (await admin<{ id: string; version: number; workOrderId: string }>('SELECT id::text, version, "workOrderId"::text AS "workOrderId" FROM "Inspection" WHERE "tenantId" = $1 AND status = \'OPEN\' ORDER BY number LIMIT 1', [A.tenant]))[0]!,
      (await admin<{ id: string; version: number }>('SELECT id::text, version FROM "Inspection" WHERE "tenantId" = $1 AND status = \'PASSED\' ORDER BY number LIMIT 1', [A.tenant]))[0]!,
    ]
    const dueAt = new Date(Date.now() + 2 * 86_400_000).toISOString()
    expect(paths(await refused('quality', 'POST', '/quality/inspections/due', { inspections: [{ id: open.id, version: open.version }], dueAt: new Date(Date.now() - 60_000).toISOString() }, 400))).toEqual(['body/dueAt'])
    expect(paths(await refused('quality', 'POST', '/quality/inspections/due', { inspections: [{ id: open.id, version: open.version }, { id: passed.id, version: passed.version }], dueAt }, 409))).toEqual(['inspections/1'])
    await refused('viewer', 'POST', '/quality/inspections/due', { inspections: [{ id: open.id, version: open.version }], dueAt }, 403)
    const set = await ok('quality', 'POST', '/quality/inspections/due', { inspections: [{ id: open.id, version: open.version }], dueAt })
    expect(set.inspections).toEqual([{ id: open.id, version: open.version + 1, dueAt, overdue: false }])
    expect((await ok('viewer', 'GET', `/quality/inspections/${open.id}`)).inspection).toMatchObject({ dueAt, overdue: false })
    // Past its time (the clock moved on): overdue in the list's filter and on the bench.
    await admin('UPDATE "Inspection" SET "dueAt" = now() - interval \'1 hour\' WHERE id = $1', [open.id])
    const overdue = await ok('viewer', 'GET', '/quality/inspections?overdue=true')
    expect(overdue.inspections.map((row: Json) => [row.id, row.overdue])).toEqual([[open.id, true]])
    const bench = await ok('quality', 'GET', `/quality/final/work-orders?limit=50`)
    const row = bench.workOrders.find((entry: Json) => entry.openInspectionId === open.id)
    if (row) expect(row.openInspection).toMatchObject({ id: open.id, overdue: true, assigned: null })
  })
})

// ---- Z5:07 ----------------------------------------------------------------------------------------------------------------

describe('NCR decisions waiting for an approval in Home › Approvals (Z5:07)', () => {
  it('is the approver\'s, never the decider\'s, and leaves once approved', async () => {
    const raised = (await ok('decider', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'Cracked protector shells', severity: 'CRITICAL', quantityAffected: '5', uom: 'PCS' }, 201)).record
    const scrap = (await admin<{ id: string }>('SELECT id::text FROM "DispositionCode" WHERE "tenantId" = $1 AND code = \'SCRAP\'', [A.tenant]))[0]!.id
    const decided = (await ok('decider', 'POST', `/quality/ncr/${raised.ncr.id}/decisions`, { version: raised.ncr.version, dispositionCodeId: scrap, quantity: '2' }, 201)).record
    const decision = decided.decisions.at(-1)
    expect(decision.approvalRequired).toBe(true)
    const rowOf = async (session: string) => ((await ok(session, 'GET', '/home/today?limit=200')).items as Json[]).find((item) => item.kind === 'NCR_DECISION' && item.record.id === raised.ncr.id)
    const mine = await rowOf('approver')
    expect(mine).toMatchObject({ kind: 'NCR_DECISION', category: 'APPROVAL', record: { type: 'Nonconformance', label: raised.ncr.number } })
    expect(await rowOf('decider')).toBeUndefined()
    await ok('approver', 'POST', `/quality/ncr/${raised.ncr.id}/decisions/${decision.id}/approve`, { version: decision.version })
    expect(await rowOf('approver')).toBeUndefined()
  })
})

// ---- Z5:09 ----------------------------------------------------------------------------------------------------------------

describe('a complaint\'s links and mail (Z5:09)', () => {
  let complaint: Json
  let ncr: Json

  it('links and unlinks an NCR (one command on both records); the NCR raised from it stays linked', async () => {
    const seeded = (await admin<{ id: string }>('SELECT id::text FROM "Complaint" WHERE "tenantId" = $1 ORDER BY number LIMIT 1', [A.tenant]))[0]!
    complaint = (await ok('quality', 'GET', `/quality/complaints/${seeded.id}`)).complaint
    ncr = (await ok('quality', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'Zip pull breaks', severity: 'MINOR', quantityAffected: '1', uom: 'PCS' }, 201)).record.ncr
    const linked = (await ok('quality', 'POST', `/quality/complaints/${complaint.id}/links`, { version: complaint.version, recordType: 'Nonconformance', recordId: ncr.id })).complaint
    expect(linked.version).toBe(complaint.version + 1)
    expect(linked.ncrs.map((row: Json) => row.id)).toContain(ncr.id)
    expect(await admin('SELECT "recordType" FROM "NcrLink" WHERE "ncrId" = $1 AND "recordId" = $2', [ncr.id, complaint.id])).toEqual([{ recordType: 'Complaint' }])
    await refused('quality', 'POST', `/quality/complaints/${complaint.id}/links`, { version: linked.version, recordType: 'Nonconformance', recordId: ncr.id }, 409)
    await refused('viewer', 'POST', `/quality/complaints/${complaint.id}/links`, { version: linked.version, recordType: 'Nonconformance', recordId: ncr.id }, 403)
    const unlinked = (await ok('quality', 'DELETE', `/quality/complaints/${complaint.id}/links/Nonconformance/${ncr.id}?version=${linked.version}`)).complaint
    expect(unlinked.ncrs.map((row: Json) => row.id)).not.toContain(ncr.id)
    // An NCR raised from the complaint is its source: it stays linked.
    const fromIt = (await ok('quality', 'POST', '/quality/ncr', { from: { recordType: 'Complaint', recordId: complaint.id }, siteId: A.siteA1, severity: 'MINOR' }, 201)).record.ncr
    const fresh = (await ok('quality', 'GET', `/quality/complaints/${complaint.id}`)).complaint
    expect((await refused('quality', 'DELETE', `/quality/complaints/${complaint.id}/links/Nonconformance/${fromIt.id}?version=${fresh.version}`, undefined, 409)).message).toMatch(/raised from this complaint: it stays linked/)
    complaint = fresh
  })

  it('links its own facts: one shipment at a time, unlinked first', async () => {
    const shipmentId: string | undefined = complaint.shipment?.id
    const other = (await admin<{ id: string }>('SELECT id::text FROM "Shipment" WHERE "tenantId" = $1 AND "companyId" = $2 AND id <> $3 ORDER BY number LIMIT 1', [A.tenant, complaint.companyId, shipmentId ?? newId()]))[0]
    expect(shipmentId).toBeTruthy()
    if (other) await refused('quality', 'POST', `/quality/complaints/${complaint.id}/links`, { version: complaint.version, recordType: 'Shipment', recordId: other.id }, 409)
    const cleared = (await ok('quality', 'DELETE', `/quality/complaints/${complaint.id}/links/Shipment/${shipmentId}?version=${complaint.version}`)).complaint
    expect(cleared.shipment).toBeNull()
    const back = (await ok('quality', 'POST', `/quality/complaints/${complaint.id}/links`, { version: cleared.version, recordType: 'Shipment', recordId: shipmentId })).complaint
    expect(back.shipment?.id).toBe(shipmentId)
    complaint = back
    await refused('quality', 'DELETE', `/quality/complaints/${complaint.id}/links/ReturnAuthorisation/${newId()}?version=${complaint.version}`, undefined, 404)
  })

  it('a customer\'s mail naming the complaint\'s number joins the complaint\'s thread (DMARC pass, a contact of the customer)', async () => {
    const contact = (await admin<{ email: string }>('SELECT email FROM "PartyContact" WHERE "partyId" = $1 AND status = \'ACTIVE\' AND email IS NOT NULL ORDER BY email LIMIT 1', [complaint.party.id]))[0]!
    const facts = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) =>
      client.$transaction(async (tx) => {
        const named = await complaintOfMail(tx, { subject: `Re: ${complaint.number} – the jacket`, partyId: complaint.party.id })
        const otherParty = await complaintOfMail(tx, { subject: `Re: ${complaint.number}`, partyId: newId() })
        const noNumber = await complaintOfMail(tx, { subject: 'Hello', partyId: complaint.party.id })
        const mail = {
          id: newId(),
          status: 'FETCHED' as const,
          companyId: complaint.companyId,
          envelopeTo: [],
          to: [],
          cc: [],
          fromAddress: contact.email,
          emailMessageId: `<${newId()}@example.com>`,
          inReplyTo: null,
          referenceIds: [],
          spfVerdict: 'PASS' as const,
          dkimVerdict: 'PASS' as const,
          dmarcVerdict: 'PASS' as const,
          spamVerdict: 'PASS' as const,
          virusVerdict: 'PASS' as const,
          subject: `Re: ${complaint.number} – the jacket`,
        }
        return { named, otherParty, noNumber, sort: await sortFactsOf(tx, mail as never) }
      }),
    )
    expect(facts.named).toMatchObject({ record: { type: 'Complaint', id: complaint.id }, number: complaint.number })
    expect(facts.otherParty).toBeNull()
    expect(facts.noNumber).toBeNull()
    // Only when the sender is a contact of exactly one party: then the complaint's record takes the mail.
    const parties = await admin<{ n: number }>('SELECT count(DISTINCT "partyId")::int AS n FROM "PartyContact" WHERE email = $1 AND status = \'ACTIVE\'', [contact.email])
    if (parties[0]!.n === 1) {
      expect(facts.sort.record).toEqual({ type: 'Complaint', id: complaint.id })
      expect(sortMail(facts.sort.facts)).toMatchObject({ status: 'MATCHED', by: 'SENDER' })
    }
  })
})
