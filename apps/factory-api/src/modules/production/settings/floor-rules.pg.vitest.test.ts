import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BundleCodeMode, FloorRuleMode } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { BUNDLE_CODE_MODES, FLOOR_RULE_MODES } from '@nexus/factory-domain/production/settings/floor-rules'
import { FLOOR_REASON_LISTS, FULL_FLOOR_REASONS } from '@nexus/factory-domain/production/settings/reason-lists'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { floorChecksFor, scrapLimitHistory } from './floor-rules'

/**
 * Floor rules per site (B-W2b-53; MES-294; design production.settings "Floor rules per site") and the floor's full reason
 * lists (MES-293; "Reason codes": W1 a short platform list, W2b full lists) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime and floor logins: row-level security, the column grants and the
 * "ProductionSettings_floor_checks" trigger are real), on the factory-db seeds up to production (plants A1 and B1 with
 * their floor rules on the schema's defaults; the tablets' settings of A1: 10 idle minutes and three shift ends) and the
 * standard reason lists. Sessions come from the test authenticator. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/settings`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b53-floor-rules'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const operator = idOf('worker:A1:operator')
const device = idOf('device:A1:cutting')

const MANAGE: Permission[] = ['production.settings.view', 'production.settings.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant([...MANAGE, 'reasons.view', 'reasons.manage'])]),
  viewer: office([grant(['production.settings.view', 'reasons.view'])]),
  companyB: office([grant(MANAGE, [companyB])]),
  reasonsOneCompany: office([grant(['reasons.view', 'reasons.manage'], [companyA])]),
  otherTenant: { audience: 'office', tenantId: newId(), actorId: newId(), grants: [grant(MANAGE)] },
  floorA1: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: device, grants: [grant(['floor.work'], [companyA], [siteA1])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const key = () => `t-${run}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const audits = (siteId: string) => admin('SELECT action, before, after, reason FROM "AuditLog" WHERE "recordType" = \'ProductionSettings\' AND "recordId" = $1 AND action = \'production.changeFloorRules\' ORDER BY at, id', [siteId])
const events = (siteId: string) => admin('SELECT payload FROM "OutboxEvent" WHERE type = \'production.floor_rules_changed\' AND subject = $1 ORDER BY "occurredAt", id', [siteId])

beforeAll(async () => {
  h = await startHarness('w2b53_floor_rules')
  await seedCore({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...FLOOR_RULE_MODES].sort()).toEqual(Object.values(FloorRuleMode).sort())
    expect([...BUNDLE_CODE_MODES].sort()).toEqual(Object.values(BundleCodeMode).sort())
  })
})

describe('floor rules per site (MES-294)', () => {
  it('one site: its checks in words, the rules that are the same everywhere, idle sign-out as the tablets keep it', async () => {
    const view = await ok('viewer', 'GET', `/production/settings/${siteA1}/floor-rules`)
    expect(view).toMatchObject({
      site: { id: siteA1 },
      checks: { quantityGuard: 'STRICT', skippedOperationRule: 'WARN', scrapApprovalLimit: null, bundleCodeMode: 'ONE_CODE', stuckBundleHours: 4 },
      isDefault: false,
      fixed: { undoWindowSeconds: 120, clockOffSeconds: 300, clockFlagSeconds: 86_400, offlineMaxHours: null, offlineMaxActions: null },
      idleSignOut: { idleMinutes: 10, shiftEnds: ['06:00', '14:00', '22:00'], isDefault: false },
      version: 1,
      canManage: false,
    })
    expect(view.words[2]).toBe('Scrap needs no approval, whatever the count.')
    expect(view.fixed.words).toHaveLength(3)
    expect((await ok('manager', 'GET', `/production/settings/${siteA1}/floor-rules`)).canManage).toBe(true)
  })

  it('changes the sequence and the scrap limit in ONE command at the version read: audited with the reason, an event, words', async () => {
    const changed = await ok('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { skippedOperationRule: 'STRICT', scrapApprovalLimit: 5, reason: 'Leather is dear: the lead sees big scrap.', version: 1 })
    expect(changed).toMatchObject({ changed: true, changedFields: ['skippedOperationRule', 'scrapApprovalLimit'], checks: { quantityGuard: 'STRICT', skippedOperationRule: 'STRICT', scrapApprovalLimit: 5 }, version: 2 })
    expect(changed.changeWords).toEqual([
      "From now on: Strict sequence: a scan that skips a required operation waits for a team leader's override with their PIN and a reason.",
      "From now on: Scrap above 5 pieces in one scan waits for the team leader's approval before it posts (the replacement, the scrap of stock and the cost wait for it).",
      'Scans already taken keep what they recorded.',
    ])
    expect(await admin('SELECT "skippedOperationRule"::text AS rule, "scrapApprovalLimit" AS limit, version FROM "ProductionSettings" WHERE id = $1', [siteA1])).toEqual([{ rule: 'STRICT', limit: 5, version: 2 }])
    expect(await audits(siteA1)).toEqual([
      {
        action: 'production.changeFloorRules',
        before: { quantityGuard: 'STRICT', skippedOperationRule: 'WARN', scrapApprovalLimit: null },
        after: { quantityGuard: 'STRICT', skippedOperationRule: 'STRICT', scrapApprovalLimit: 5 },
        reason: 'Leather is dear: the lead sees big scrap.',
      },
    ])
    expect((await events(siteA1)).map((row) => row.payload)).toEqual([{ siteId: siteA1, fields: ['skippedOperationRule', 'scrapApprovalLimit'], quantityGuard: 'STRICT', skippedOperationRule: 'STRICT', scrapApprovalLimit: 5 }])
  })

  it('the same values again change nothing (no audit, no event); a stale version is refused; none takes the limit away', async () => {
    const same = await ok('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { scrapApprovalLimit: 5, version: 2 })
    expect(same).toMatchObject({ changed: false, changedFields: [], changeWords: [], version: 2 })
    expect(await audits(siteA1)).toHaveLength(1)
    expect((await no('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { quantityGuard: 'WARN', version: 1 }, 409)).issues[0].path).toBe('version')
    const off = await ok('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { scrapApprovalLimit: null, quantityGuard: 'WARN', version: 2 })
    expect(off).toMatchObject({ changed: true, changedFields: ['quantityGuard', 'scrapApprovalLimit'], checks: { quantityGuard: 'WARN', scrapApprovalLimit: null } })
    // Back on for the history below.
    await ok('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { scrapApprovalLimit: 3, version: 3 })
  })

  it('refuses what is not a rule, in words; names at least one; walls by permission, company and tenant', async () => {
    expect((await no('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { scrapApprovalLimit: 0 }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/scrapApprovalLimit'])
    expect((await no('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { scrapApprovalLimit: 501 }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/scrapApprovalLimit'])
    expect(await no('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { reason: 'Nothing named.' }, 400)).toMatchObject({ message: 'Name at least one rule to change.' })
    await no('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { quantityGuard: 'LOOSE' }, 400)
    await no('viewer', 'POST', `/production/settings/${siteA1}/floor-rules`, { quantityGuard: 'FREE' }, 403)
    await no('companyB', 'GET', `/production/settings/${siteA1}/floor-rules`, undefined, 404)
    await no('otherTenant', 'GET', `/production/settings/${siteA1}/floor-rules`, undefined, 404)
    // Company B's own site is theirs.
    const b1 = await ok('companyB', 'POST', `/production/settings/${siteB1}/floor-rules`, { quantityGuard: 'FREE' })
    expect(b1).toMatchObject({ changed: true, checks: { quantityGuard: 'FREE' } })
  })

  it("the tablet reads its own site's checks and the undo window, never the legal basis", async () => {
    const floor = await ok('floorA1', 'GET', '/production/floor-rules')
    expect(floor).toMatchObject({ siteId: siteA1, checks: { quantityGuard: 'WARN', skippedOperationRule: 'STRICT', scrapApprovalLimit: 3, bundleCodeMode: 'ONE_CODE' }, undoWindowSeconds: 120 })
    expect(JSON.stringify(floor)).not.toContain('SEED-RSU')
    await no('floorA1', 'GET', `/production/settings/${siteA1}/floor-rules`, undefined, 403)
  })

  it('the readers: the checks in the floor scope, the scrap limit history from the audit rows', async () => {
    const checks = await h.database.withScope({ audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1 }, (client) => floorChecksFor(client, siteA1))
    expect(checks).toMatchObject({ quantityGuard: 'WARN', skippedOperationRule: 'STRICT', scrapApprovalLimit: 3 })
    const history = await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, (client) => scrapLimitHistory(client, [siteA1, siteB1]))
    expect(history.get(siteA1)?.map((change) => [change.before, change.after])).toEqual([
      [null, 5],
      [5, null],
      [null, 3],
    ])
    // B1's change named no limit: no history.
    expect(history.get(siteB1)).toBeUndefined()
  })
})

describe("the floor's full reason lists (MES-293)", () => {
  const expectedMissing = async (): Promise<Record<(typeof FLOOR_REASON_LISTS)[number], string[]>> => {
    const have = await admin<{ list: string; code: string }>('SELECT list::text AS list, code FROM "ReasonCode" WHERE "tenantId" = $1 UNION ALL SELECT kind::text, code FROM "ScrapReason" WHERE "tenantId" = $1', [T])
    return Object.fromEntries(FLOOR_REASON_LISTS.map((list) => [list, FULL_FLOOR_REASONS[list].map((reason) => reason.code).filter((code) => !have.some((row) => row.list === list && row.code === code))])) as Record<(typeof FLOOR_REASON_LISTS)[number], string[]>
  }

  it('each floor list: its counts and the full list codes it lacks; "add the full list" only for who keeps the lists', async () => {
    const view = await ok('viewer', 'GET', '/production/settings/reasons')
    expect(view.canManage).toBe(false)
    expect(view.lists.map((row: Json) => row.list)).toEqual([...FLOOR_REASON_LISTS])
    const missing = await expectedMissing()
    for (const row of view.lists) expect(row.fullMissing, row.list).toEqual(missing[row.list as (typeof FLOOR_REASON_LISTS)[number]])
    expect(view.lists.find((row: Json) => row.list === 'PAUSE').fullMissing).toContain('QUALITY_CHECK')
    expect((await ok('manager', 'GET', '/production/settings/reasons')).canManage).toBe(true)
  })

  it('adds the missing codes in ONE command (an audit row each, one event per list); again: nothing written', async () => {
    const missing = await expectedMissing()
    await no('viewer', 'POST', '/production/settings/reasons/full', {}, 403)
    expect((await no('reasonsOneCompany', 'POST', '/production/settings/reasons/full', {}, 403)).message).toMatch(/every company and site/)
    const added = await ok('manager', 'POST', '/production/settings/reasons/full', { lists: ['PAUSE', 'SCRAP'] })
    expect(added.added).toEqual([
      { list: 'PAUSE', codes: missing.PAUSE },
      { list: 'SCRAP', codes: missing.SCRAP },
    ])
    expect(added.lists.find((row: Json) => row.list === 'PAUSE').fullMissing).toEqual([])
    expect(added.lists.find((row: Json) => row.list === 'DOWNTIME').fullMissing).toEqual(missing.DOWNTIME)
    const burn = (await admin('SELECT icon, colour, "labelIt", active FROM "ScrapReason" WHERE "tenantId" = $1 AND kind = \'SCRAP\' AND code = \'BURN\'', [T]))[0]
    expect(burn).toEqual({ icon: 'flame', colour: '#e5484d', labelIt: 'Bruciatura', active: true })
    const rows = await admin('SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action = \'production.addFullReasons\'', [T])
    expect(rows[0]!.n).toBe(missing.PAUSE.length + missing.SCRAP.length)
    const changes = await admin('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = \'reason.changed\' ORDER BY "occurredAt", id', [T])
    expect(changes.map((row) => row.payload)).toEqual([
      { list: 'PAUSE', change: 'STANDARD_ADDED', codes: missing.PAUSE },
      { list: 'SCRAP', change: 'STANDARD_ADDED', codes: missing.SCRAP },
    ])
    // Every floor list now; then nothing is missing and nothing is written.
    await ok('manager', 'POST', '/production/settings/reasons/full', {})
    const again = await ok('manager', 'POST', '/production/settings/reasons/full', {})
    expect(again.added).toEqual([])
    expect(again.lists.every((row: Json) => row.fullMissing.length === 0)).toBe(true)
  })
})
