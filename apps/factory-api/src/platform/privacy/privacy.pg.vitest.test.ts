import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrivacyDpiaStatus, PrivacyNoticeKind, PrivacyNoticeStatus, ProcessingActivityStatus } from '@nexus/factory-db'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { NOTICE_KINDS, NOTICE_STATUSES } from '@nexus/factory-domain/privacy/notices'
import { DPIA_STATUSES, PROCESSING_ACTIVITY_STATUSES } from '@nexus/factory-domain/privacy/records'
import { NO_DPIA_NOTE, NO_WORKER_NOTICE_NOTE } from '@nexus/factory-domain/privacy/readiness'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedProduction, type ProductionSeed } from '../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { floorRecordSubjectFor } from '../../modules/production/settings/subject'
import { applySystemRoleChanges, systemRoleChanges } from '../auth/roles/system-roles'
import { addRole, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { floorPrivacyReady, floorReadinessFor } from './read'

/**
 * The privacy pack (B-W1-36; A2 SCR-025, SCR-086; GDPR arts. 13, 30, 35; Statuto dei Lavoratori, L. 300/1970, art. 4
 * c.3; PLT-208, GAP-004, GAP-005, GAP-009; Q15, Q16) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security, column grants and the …_privacy_guards and …_production_guards
 * triggers are real), the factory-db seeds of two tenants (plant A1 of company A names workers, an agreement on record;
 * WO-0001 in progress; A1's operator acknowledged a notice recorded before any was published here, its team leader
 * nothing), the real office sign-in with two-factor and step-up for publishing and storing, a real floor sign-in, and
 * test sessions for the walls. Every text is a made-up sample. Run with `node scripts/factory/run-pg-tests.mjs privacy`.
 */

let h: Harness
let app: FastifyInstance
let seedA: ProductionSeed

const ns = { a: 'privacy-api-a', b: 'privacy-api-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  brand: idOf(ns.a, 'party:P1'),
  operator: idOf(ns.a, 'worker:A1:operator'),
  lead: idOf(ns.a, 'worker:A1:lead'),
  device: idOf(ns.a, 'device:A1:cutting'),
  operatorB1: idOf(ns.a, 'worker:B1:operator'),
  qcStation: idOf(ns.a, 'site:A1:station:QC-01'),
}
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A') }

const BOTH: Permission[] = ['privacy.view', 'privacy.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], extra: Partial<SessionContext> = {}): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants, ...extra }) as SessionContext
const floor = (siteId: string, companyId: string, actorId: string): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId,
  deviceId: A.device,
  grants: [grant(['floor.work'], [companyId], [siteId])],
})
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(BOTH)]),
  viewer: office([grant(['privacy.view'])]),
  companyB: office([grant(BOTH, [A.companyB])]),
  otherTenant: { audience: 'office', tenantId: B.tenant, actorId: newId(), grants: [grant(BOTH)] },
  partner: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brand, grants: [grant(BOTH)] },
  noGrants: office([], { companyId: A.companyA }),
  floorOperator: floor(A.siteA1, A.companyA, A.operator),
  floorLead: floor(A.siteA1, A.companyA, A.lead),
  floorB1: floor(A.siteB1, A.companyB, A.operatorB1),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
let keys = 0
const key = () => `privacy-test-${++keys}-${newId()}`
const call = (session: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(session ? { 'x-test-session': session } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers?: Record<string, string>): Promise<Json> {
  const response = await call(session, method, url, payload, headers)
  expect(response.statusCode, response.body).toBeLessThan(300)
  return response.json()
}

/** The privacy administrator: a real person with the admin role and two-factor (publishing and storing step up). */
let privacyAdmin: { browser: Browser; secret: string; userId: string }
const asAdmin = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) =>
  privacyAdmin.browser.send(method as never, url, body, { headers: { 'x-factory-company': A.companyA, ...headers } })
const stepped = () => stepUp(h, privacyAdmin.browser, privacyAdmin.secret)

/** A notice version of company A written and published through the API (the admin, with a fresh code). */
async function published(kind: string, texts: Record<string, string>, label?: string): Promise<Json> {
  const made = await asAdmin('POST', '/privacy/notices', { companyId: A.companyA, kind, copyTexts: false, ...(label ? { label } : {}) })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  let notice = made.body.notice
  for (const [locale, body] of Object.entries(texts)) {
    const put = await privacyAdmin.browser.send('PUT' as never, `/privacy/notices/${notice.id}/texts/${locale}`, { body, version: notice.version })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    notice = put.body.notice
  }
  await stepped()
  const done = await asAdmin('POST', `/privacy/notices/${notice.id}/publish`, { version: notice.version })
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body
}

/** A scan by `workerId` of a fresh bundle of WO-0001 at final inspection, inserted by A1's floor as B-W1-42 will: the triggers judge its subject. */
async function scanBy(workerId: string) {
  return h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: workerId, siteId: A.siteA1 }, async (client) => {
    const bundleId = newId()
    await client.bundle.create({
      data: { id: bundleId, siteId: A.siteA1, workOrderId: seedA.workOrderId, workOrderSizeId: seedA.cellIds['RED-50'], code: `T-BN-${newId().slice(-8)}`, quantity: 1, deviceId: A.device },
      select: { id: true },
    })
    return client.operationScan.create({
      data: {
        id: newId(),
        siteId: A.siteA1,
        workOrderId: seedA.workOrderId,
        workOrderOperationId: seedA.operationIds.qc,
        bundleId,
        kind: 'REPORT',
        goodQuantity: 1,
        workerId,
        stationId: A.qcStation,
        deviceId: A.device,
        clientScanId: `privacy-${newId()}`,
        deviceTime: new Date(),
        createdById: workerId,
      },
      select: { id: true },
    })
  })
}
const floorRules = async (session: string) => (await ok(session, 'GET', '/production/floor-rules')).workerAcknowledged as boolean
const floorNotice = async (session: string, query = '') => ok(session, 'GET', `/privacy/floor/notice${query}`)
const acknowledge = (session: string, body: Json, idempotencyKey: string | null = key()) =>
  call(session, 'POST', '/privacy/floor/notice/acknowledge', body, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})

const SAMPLE = {
  workerEn: 'SAMPLE - made-up notice for tests.\n\nThe tablet records which bundle you scanned, when and where.',
  workerIt2: 'ESEMPIO - versione 2 inventata per i test.\n\nAggiunge per quanto tempo si conservano i dati.',
  staffIt: 'ESEMPIO - informativa per il personale, inventata.',
  staffIt2: 'ESEMPIO - informativa per il personale, versione 2.',
  publicIt: 'ESEMPIO - informativa pubblica inventata.',
  publicEn: 'SAMPLE - made-up public notice.',
}

let v1: Json
let v2: Json

beforeAll(async () => {
  h = await startHarness('privacy')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  seedA = await seedProduction({ db: h.database, namespace: ns.a })
  await seedProduction({ db: h.database, namespace: ns.b })
  await seedFiles({ db: h.database, namespace: ns.a })
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  const tenantA: TestTenant = { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }
  const user = await addUser(h, tenantA, { email: 'privacy.admin@example.com' })
  await addRole(h, tenantA, user.id, 'admin')
  const browser = new Browser(h.app)
  const answer = await browser.signIn(tenantA.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  privacyAdmin = { browser, secret: await enrolTotp(h, browser), userId: user.id }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database: h.database,
      clock: h.clock,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...NOTICE_KINDS].sort()).toEqual(Object.values(PrivacyNoticeKind).sort())
    expect([...NOTICE_STATUSES].sort()).toEqual(Object.values(PrivacyNoticeStatus).sort())
    expect([...DPIA_STATUSES].sort()).toEqual(Object.values(PrivacyDpiaStatus).sort())
    expect([...PROCESSING_ACTIVITY_STATUSES].sort()).toEqual(Object.values(ProcessingActivityStatus).sort())
  }, 60_000)
})

describe('the floor gate without a DPIA (GDPR art. 35; L. 300/1970 art. 4 c.3)', () => {
  it('keeps the floor shut without a stored DPIA, and without a published worker notice, in words', async () => {
    const overview = await ok('manager', 'GET', '/privacy/overview')
    const byCompany = new Map(overview.companies.map((entry: Json) => [entry.company.id, entry]))
    // Company A: the seed's worker notice 2026-10 is in force (the production seed's floor day needs it); no DPIA.
    const companyA = byCompany.get(A.companyA) as Json
    expect(companyA.duties.filter((duty: Json) => duty.done).map((duty: Json) => duty.key)).toEqual(['workerNotice'])
    expect(companyA.duties.find((duty: Json) => duty.key === 'dpia').words).toMatch(/No signed DPIA is stored \(GDPR art\. 35\)/)
    const a1 = companyA.sites.find((site: Json) => site.id === A.siteA1)
    expect(a1).toMatchObject({ readyForFloor: false })
    expect(a1.notes[0]).toBe(NO_DPIA_NOTE)
    expect(a1.notes).not.toContain(NO_WORKER_NOTICE_NOTE)
    // Company B: nothing at all.
    const b1 = (byCompany.get(A.companyB) as Json).sites.find((site: Json) => site.id === A.siteB1)
    expect(b1.notes).toEqual(expect.arrayContaining([NO_DPIA_NOTE, NO_WORKER_NOTICE_NOTE]))
    const status = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => floorPrivacyReady(client, A.companyA, new Date()))
    expect(status).toMatchObject({ ready: false, dpiaStored: false, workerNoticePublished: true })
  }, 60_000)
})

describe('worker notice versions and the scan gate (PLT-208, SCR-025)', () => {
  it('v1 in force: the operator who acknowledged it scans; the team leader reads it on the tablet, acknowledges, then scans', async () => {
    const listed = await ok('manager', 'GET', `/privacy/notices?companyId=${A.companyA}&kind=WORKER_FLOOR`)
    expect(listed.notices.map((notice: Json) => [notice.label, notice.status])).toEqual([['2026-10', 'PUBLISHED']])
    v1 = (await ok('manager', 'GET', `/privacy/notices/${listed.notices[0].id}`)).notice
    for (const language of v1.languages) expect(language.sha256).toBe(sha(language.body))
    expect(await floorRules('floorOperator')).toBe(true)
    expect(await scanBy(A.operator)).toMatchObject({ id: expect.any(String) })

    expect(await floorRules('floorLead')).toBe(false)
    await expect(scanBy(A.lead)).rejects.toThrow(/has not acknowledged the information notice in force \(version 2026-10\)/)
    const shown = await floorNotice('floorLead', '?locale=en')
    const english = v1.languages.find((language: Json) => language.locale === 'en')
    expect(shown.notice).toMatchObject({ id: v1.id, label: '2026-10', locale: 'en', body: english.body, sha256: sha(english.body), languages: ['en', 'it'], languageReady: true })
    expect(shown.gate).toEqual({ noticeId: v1.id, label: '2026-10', acknowledged: false, due: true, blocksScans: true })
    expect(shown.means).toMatch(/does not sign anything else/)
    expect((await floorNotice('floorLead', '?locale=ro')).notice).toMatchObject({ locale: 'it', languageReady: false })
    // B-W1-40/42 ask first, in words (409), before the triggers.
    await expect(h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.lead, siteId: A.siteA1 }, (client) => floorRecordSubjectFor(client, { siteId: A.siteA1, workerId: A.lead, stationId: null }))).rejects.toThrow(
      InvalidStateError,
    )

    expect((await acknowledge('floorLead', { noticeId: v1.id, locale: 'en', sha256: shown.notice.sha256 }, null)).statusCode).toBe(400)
    expect((await acknowledge('floorLead', { noticeId: v1.id, locale: 'en', sha256: sha('another text') })).statusCode).toBe(409)
    const done = await acknowledge('floorLead', { noticeId: v1.id, locale: 'en', sha256: shown.notice.sha256, deviceTime: '2026-11-17T07:29:58.000Z' })
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toEqual({ acknowledged: true, changed: true, gate: { noticeId: v1.id, label: '2026-10', acknowledged: true, due: false, blocksScans: false } })
    expect((await acknowledge('floorLead', { noticeId: v1.id, locale: 'en', sha256: shown.notice.sha256 })).json()).toMatchObject({ changed: false })
    const rows = await admin('SELECT "noticeId", "noticeVersion", locale, "noticeSha256", channel::text, "deviceId", "deviceTime" FROM "WorkerNoticeAck" WHERE "workerId" = $1', [A.lead])
    expect(rows).toEqual([{ noticeId: v1.id, noticeVersion: '2026-10', locale: 'en', noticeSha256: sha(english.body), channel: 'DEVICE', deviceId: A.device, deviceTime: new Date('2026-11-17T07:29:58.000Z') }])
    expect(await floorRules('floorLead')).toBe(true)
    expect(await scanBy(A.lead)).toMatchObject({ id: expect.any(String) })
    expect(await admin('SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = \'privacy.notice_acknowledged\' AND payload->>\'channel\' = \'DEVICE\'')).toEqual([{ n: 1 }])
  }, 60_000)

  it('a draft stores each language with the SHA-256 of the exact text; publishing v2 needs Italian and English and a fresh code; every worker acknowledges again', async () => {
    const made = await asAdmin('POST', '/privacy/notices', { companyId: A.companyA, kind: 'WORKER_FLOOR', label: '2026-11', copyTexts: false })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.notice).toMatchObject({ kind: 'WORKER_FLOOR', versionNo: 2, label: '2026-11', status: 'DRAFT', languages: [] })
    expect((await asAdmin('POST', '/privacy/notices', { companyId: A.companyA, kind: 'WORKER_FLOOR' })).status).toBe(409)
    // Line ends and trailing blanks are normalised; the fingerprint is of the text as stored and shown.
    const put = await privacyAdmin.browser.send('PUT' as never, `/privacy/notices/${made.body.notice.id}/texts/it`, { body: `${SAMPLE.workerIt2.replace(/\n/g, '\r\n')}  \r\n`, version: 1 })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.notice.languages).toEqual([{ locale: 'it', body: SAMPLE.workerIt2, hasText: true, fileId: null, sha256: sha(SAMPLE.workerIt2) }])
    const [stored] = await admin<{ body: string; sha256: string }>('SELECT body, sha256 FROM "PrivacyNoticeText" WHERE "noticeId" = $1 AND locale = \'it\'', [made.body.notice.id])
    expect(stored).toEqual({ body: SAMPLE.workerIt2, sha256: sha(SAMPLE.workerIt2) })
    expect((await privacyAdmin.browser.send('PUT' as never, `/privacy/notices/${made.body.notice.id}/texts/en`, { body: SAMPLE.workerEn, version: 1 })).status).toBe(409)
    // Without English: refused in words, before any code is asked.
    const missing = await asAdmin('POST', `/privacy/notices/${made.body.notice.id}/publish`, { version: 2 })
    expect(missing.status).toBe(409)
    expect(missing.body.error).toMatchObject({ code: 'invalid_state', issues: [{ path: 'texts/en' }] })
    expect((await privacyAdmin.browser.send('PUT' as never, `/privacy/notices/${made.body.notice.id}/texts/en`, { body: SAMPLE.workerEn, version: 2 })).status).toBe(200)
    h.clock.advance(6 * 60_000)
    const noCode = await asAdmin('POST', `/privacy/notices/${made.body.notice.id}/publish`, { version: 3 })
    expect(noCode.status).toBe(403)
    expect(noCode.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepped()
    const done = await asAdmin('POST', `/privacy/notices/${made.body.notice.id}/publish`, { version: 3 })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body).toMatchObject({ notice: { status: 'PUBLISHED', label: '2026-11', publishedById: privacyAdmin.userId }, superseded: { id: v1.id, label: '2026-10' } })
    expect(done.body.words[0]).toMatch(/Every worker reads and acknowledges it on the tablet/)
    v2 = done.body.notice
    expect(await admin('SELECT payload FROM "OutboxEvent" WHERE type = \'privacy.notice_published\' AND subject = $1', [v2.id])).toEqual([
      { payload: { noticeId: v2.id, companyId: A.companyA, kind: 'WORKER_FLOOR', versionNo: 2, label: '2026-11', supersededId: v1.id } },
    ])
    expect((await admin('SELECT status::text FROM "PrivacyNotice" WHERE id = $1', [v1.id]))[0]).toEqual({ status: 'SUPERSEDED' })
    // Frozen once published.
    expect((await privacyAdmin.browser.send('PUT' as never, `/privacy/notices/${v2.id}/texts/it`, { body: 'changed', version: v2.version })).status).toBe(409)

    // v1's acknowledgements no longer count, for anybody.
    expect(await floorRules('floorOperator')).toBe(false)
    expect((await floorNotice('floorOperator')).gate).toEqual({ noticeId: v2.id, label: '2026-11', acknowledged: false, due: true, blocksScans: true })
    await expect(scanBy(A.operator)).rejects.toThrow(/has not acknowledged the information notice in force \(version 2026-11\)/)
    await expect(scanBy(A.lead)).rejects.toThrow(/has not acknowledged the information notice in force \(version 2026-11\)/)
    const old = await acknowledge('floorOperator', { noticeId: v1.id, locale: 'en', sha256: sha(v1.languages.find((language: Json) => language.locale === 'en').body) })
    expect(old.statusCode).toBe(409)
    expect(old.json().error.message).toMatch(/A newer version \(2026-11\) is in force: read it first/)
    expect((await acknowledge('floorOperator', { noticeId: v2.id, locale: 'it', sha256: sha(SAMPLE.workerIt2) })).statusCode).toBe(200)
    expect(await scanBy(A.operator)).toMatchObject({ id: expect.any(String) })
    // The floor rules' words (B-W1-37) count the version in force: the team leader has not acknowledged v2.
    const rules = await privacyAdmin.browser.get(`/production/settings/${A.siteA1}`)
    expect(rules.status, JSON.stringify(rules.body)).toBe(200)
    expect(rules.body.affected).toMatchObject({ workersActive: 2, workersNotAcknowledged: 1 })
  }, 60_000)

  it("records a worker's signed paper copy of the version in force; the counts follow", async () => {
    const paper = await asAdmin('POST', `/privacy/notices/${v2.id}/paper-acknowledgements`, { workerId: A.lead, locale: 'en' })
    expect(paper.status, JSON.stringify(paper.body)).toBe(200)
    expect(paper.body.changed).toBe(true)
    expect((await asAdmin('POST', `/privacy/notices/${v2.id}/paper-acknowledgements`, { workerId: A.lead, locale: 'en' })).body.changed).toBe(false)
    expect((await admin('SELECT channel::text, "deviceId", "noticeSha256" FROM "WorkerNoticeAck" WHERE id = $1', [paper.body.acknowledgementId]))[0]).toEqual({ channel: 'PAPER', deviceId: null, noticeSha256: sha(SAMPLE.workerEn) })
    expect(await scanBy(A.lead)).toMatchObject({ id: expect.any(String) })
    expect((await asAdmin('POST', `/privacy/notices/${v1.id}/paper-acknowledgements`, { workerId: A.lead, locale: 'it' })).status).toBe(409)
    expect((await asAdmin('POST', `/privacy/notices/${v2.id}/paper-acknowledgements`, { workerId: A.operatorB1, locale: 'it' })).status).toBe(404)
    // Counts for privacy.view; names only with privacy.manage, sorted by name.
    const asViewer = await ok('viewer', 'GET', `/privacy/notices/${v2.id}/acknowledgements`)
    expect(asViewer.counts).toEqual({ active: 2, acknowledged: 2, notAcknowledged: 0 })
    expect(asViewer.people).toBeNull()
    const asManager = await ok('manager', 'GET', `/privacy/notices/${v2.id}/acknowledgements`)
    expect(asManager.people.map((person: Json) => person.channel).sort()).toEqual(['DEVICE', 'PAPER'])
    const names = asManager.people.map((person: Json) => person.displayName)
    expect(names).toEqual([...names].sort())
    // The floor rules' counts (B-W1-37) follow the version in force too.
    const settings = await privacyAdmin.browser.get(`/production/settings/${A.siteA1}/notice-acks`)
    expect(settings.status, JSON.stringify(settings.body)).toBe(200)
    expect(settings.body.workers).toEqual({ active: 2, acknowledged: 2, notAcknowledged: 0 })
    // A worker notice in force, every worker acknowledged, and still no DPIA: the floor stays shut (GDPR art. 35).
    const status = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => floorPrivacyReady(client, A.companyA, new Date()))
    expect(status).toMatchObject({ ready: false, dpiaStored: false, workerNoticePublished: true })
    expect(status.notes[0]).toBe(NO_DPIA_NOTE)
    expect((await ok('manager', 'GET', `/privacy/overview?companyId=${A.companyA}`)).companies[0].sites.find((site: Json) => site.id === A.siteA1)).toMatchObject({ readyForFloor: false })
  }, 60_000)
})

describe('a real floor sign-in tells the tablet what to do about the notice', () => {
  it('due after sign-in, scan tiles held, both lifted once acknowledged on the tablet', async () => {
    const stationId = idOf(ns.a, 'site:A1:station:CUT-01')
    await stepped()
    const made = await asAdmin('POST', '/auth/floor/devices', { siteId: A.siteA1, stationId, name: 'Privacy test tablet' })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const tablet = new Browser(h.app)
    await tablet.get('/auth/csrf')
    const enrolled = await tablet.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200)
    const [operatorRole] = await admin<{ id: string }>('SELECT id::text FROM "Role" WHERE "tenantId" = $1::uuid AND key = \'operator\'', [A.tenant])
    await stepped()
    const worker = await asAdmin('POST', '/auth/floor/workers', { siteId: A.siteA1, displayName: 'Sample New Worker', locale: 'en', roleIds: [operatorRole!.id] })
    expect(worker.status, JSON.stringify(worker.body)).toBe(200)
    const badge = await asAdmin('POST', `/auth/floor/workers/${worker.body.id}/badges`)
    expect(badge.status, JSON.stringify(badge.body)).toBe(200)
    await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1::uuid', [worker.body.id, await hashPin('482913', h.auth.pins, { logN: 12, r: 8, p: 1 })])

    const signedIn = await tablet.post('/floor/sign-in', { badgeCode: badge.body.code, pin: '482913' })
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
    expect(signedIn.body.notice).toEqual({ noticeId: v2.id, label: '2026-11', acknowledged: false, due: true, blocksScans: true })
    expect((await tablet.get('/floor/me')).body.notice).toMatchObject({ due: true, blocksScans: true })
    const shown = await tablet.get('/privacy/floor/notice')
    expect(shown.body.notice).toMatchObject({ id: v2.id, locale: 'en' })
    const ack = await tablet.post('/privacy/floor/notice/acknowledge', { noticeId: v2.id, locale: 'en', sha256: shown.body.notice.sha256 }, { headers: { 'idempotency-key': key() } })
    expect(ack.status, JSON.stringify(ack.body)).toBe(200)
    expect((await tablet.get('/floor/me')).body.notice).toEqual({ noticeId: v2.id, label: '2026-11', acknowledged: true, due: false, blocksScans: false })
  }, 60_000)
})

describe('the staff notice: shown once per version at sign-in (soft gate)', () => {
  it('is acknowledged once per version, and asked again for the next one', async () => {
    const staff = await published('OFFICE_STAFF', { it: SAMPLE.staffIt })
    expect((await asAdmin('GET', '/auth/office/me')).body.staffNotice).toEqual({ noticeId: staff.notice.id, label: 'v1', acknowledged: false })
    // Without a company on the screen (the tenant has two), nothing is shown.
    expect((await privacyAdmin.browser.get('/privacy/staff-notice')).body).toMatchObject({ companyId: null, notice: null })
    const shown = await asAdmin('GET', '/privacy/staff-notice')
    expect(shown.body).toMatchObject({ companyId: A.companyA, acknowledged: false, notice: { id: staff.notice.id, locale: 'it', body: SAMPLE.staffIt, sha256: sha(SAMPLE.staffIt) } })
    const ack = await asAdmin('POST', '/privacy/staff-notice/acknowledge', { noticeId: staff.notice.id, locale: 'it', sha256: sha(SAMPLE.staffIt) })
    expect(ack.status, JSON.stringify(ack.body)).toBe(200)
    expect(ack.body).toEqual({ acknowledged: true, changed: true })
    expect((await asAdmin('POST', '/privacy/staff-notice/acknowledge', { noticeId: staff.notice.id, locale: 'it', sha256: sha(SAMPLE.staffIt) })).body.changed).toBe(false)
    expect((await asAdmin('GET', '/auth/office/me')).body.staffNotice).toMatchObject({ acknowledged: true })
    const second = await published('OFFICE_STAFF', { it: SAMPLE.staffIt2 })
    expect((await asAdmin('GET', '/auth/office/me')).body.staffNotice).toEqual({ noticeId: second.notice.id, label: 'v2', acknowledged: false })
    expect((await asAdmin('POST', '/privacy/staff-notice/acknowledge', { noticeId: staff.notice.id, locale: 'it', sha256: sha(SAMPLE.staffIt) })).status).toBe(409)
    expect((await asAdmin('POST', '/privacy/staff-notice/acknowledge', { noticeId: second.notice.id, locale: 'it', sha256: sha(SAMPLE.staffIt2) })).body.changed).toBe(true)
    const rows = await admin('SELECT "noticeVersion", "sessionId" IS NOT NULL AS "inSession" FROM "StaffNoticeAck" WHERE "userId" = $1 ORDER BY "serverTime"', [privacyAdmin.userId])
    expect(rows).toEqual([
      { noticeVersion: 'v1', inSession: true },
      { noticeVersion: 'v2', inSession: true },
    ])
    expect(await admin('SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = \'privacy.notice_acknowledged\' AND payload->>\'channel\' = \'OFFICE\'')).toEqual([{ n: 2 }])
    // Any signed-in person may read it: no permission needed.
    expect((await ok('noGrants', 'GET', '/privacy/staff-notice')).notice).toMatchObject({ id: second.notice.id })
  }, 60_000)
})

describe('the DPIA and the floor gate (GDPR art. 35; GAP-004)', () => {
  it('stores the signed PDF with a fresh code; the floor opens', async () => {
    const made = await asAdmin('POST', '/privacy/dpia', { companyId: A.companyA })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const dpia = made.body.dpia
    expect(dpia).toMatchObject({ versionNo: 1, status: 'DRAFT', fileId: null, scope: expect.stringMatching(/badge sign-ins/) })
    const store = { signedByName: 'Sample Signer, legal representative', signedOn: '2026-10-01', reviewDueOn: '2027-10-01' }
    const noPdf = await asAdmin('POST', `/privacy/dpia/${dpia.id}/store`, { ...store, version: dpia.version })
    expect(noPdf.status).toBe(400)
    expect(noPdf.body.error.message).toBe('Upload the signed PDF first.')
    // The generic files route may not reach it.
    const generic = await asAdmin('POST', '/files', { companyId: A.companyA, recordType: 'PrivacyDpia', recordId: dpia.id, kind: 'DOCUMENT', originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: sha('x') })
    expect(generic.status).toBe(409)
    const bytes = Buffer.from('%PDF-1.4\n% made-up signed DPIA for tests\n%%EOF\n')
    const fileSha = createHash('sha256').update(bytes).digest('hex')
    const announced = await asAdmin('POST', `/privacy/dpia/${dpia.id}/pdf`, { originalName: 'dpia-signed.pdf', contentType: 'application/pdf', sizeBytes: bytes.length, sha256: fileSha })
    expect(announced.status, JSON.stringify(announced.body)).toBe(201)
    const put = await h.app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: bytes })
    expect(put.statusCode, put.body).toBe(200)
    const completed = await asAdmin('POST', `/privacy/dpia/${dpia.id}/pdf/${announced.body.file.id}/complete`)
    expect(completed.status, JSON.stringify(completed.body)).toBe(200)
    expect(completed.body.dpia).toMatchObject({ fileId: announced.body.file.id, fileSha256: fileSha, status: 'DRAFT' })
    h.clock.advance(6 * 60_000)
    const noCode = await asAdmin('POST', `/privacy/dpia/${dpia.id}/store`, { ...store, version: completed.body.dpia.version })
    expect(noCode.status).toBe(403)
    await stepped()
    const stored = await asAdmin('POST', `/privacy/dpia/${dpia.id}/store`, { ...store, version: completed.body.dpia.version })
    expect(stored.status, JSON.stringify(stored.body)).toBe(200)
    expect(stored.body).toMatchObject({ dpia: { status: 'STORED', signedOn: '2026-10-01', reviewDueOn: '2027-10-01' }, superseded: null })
    expect((await admin('SELECT "retainUntil" IS NOT NULL AS kept FROM "StoredFile" WHERE id = $1', [announced.body.file.id]))[0]).toEqual({ kept: true })
    expect(await admin('SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = \'privacy.dpia_stored\' AND subject = $1', [dpia.id])).toEqual([{ n: 1 }])

    const a1 = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => floorReadinessFor(client, A.siteA1, new Date()))
    expect(a1).toMatchObject({ readyForFloor: true, privacy: { ready: true, dpiaStored: true, workerNoticePublished: true }, rules: { readyForFloor: true } })
    const overview = await ok('manager', 'GET', '/privacy/overview')
    const byCompany = new Map(overview.companies.map((entry: Json) => [entry.company.id, entry]))
    const companyA = byCompany.get(A.companyA) as Json
    expect(companyA.sites.find((site: Json) => site.id === A.siteA1).readyForFloor).toBe(true)
    expect(companyA.duties.filter((duty: Json) => duty.done).map((duty: Json) => duty.key).sort()).toEqual(['dpia', 'staffNotice', 'workerNotice'])
    // Company B has neither: its floor stays shut.
    expect((byCompany.get(A.companyB) as Json).sites.find((site: Json) => site.id === A.siteB1)).toMatchObject({ readyForFloor: false })
  }, 60_000)
})

describe('the record of processing activities (GDPR art. 30; GAP-009)', () => {
  const activity = {
    companyId: '',
    code: 'FLOOR-SCANS',
    name: 'SAMPLE floor scans',
    purpose: 'Production records (made up)',
    legalBasis: 'Contract (art. 6(1)(b)) (made up)',
    dataSubjects: ['floor workers', ' floor workers '],
    dataCategories: ['name', 'badge'],
    recipients: [],
    processors: ['hosting, EU (made up)'],
    transfers: 'None',
    retention: '10 years',
    security: 'Row-level security (made up)',
  }

  it('adds, changes at the version read and archives an activity; never deletes it', async () => {
    const body = { ...activity, companyId: A.companyA }
    expect((await call('manager', 'POST', '/privacy/register', { ...body, dataSubjects: [] })).statusCode).toBe(400)
    const made = await ok('manager', 'POST', '/privacy/register', body)
    expect(made.activity).toMatchObject({ code: 'FLOOR-SCANS', dataSubjects: ['floor workers'], status: 'ACTIVE', version: 1 })
    expect((await call('manager', 'POST', '/privacy/register', body)).statusCode).toBe(409)
    const changed = await ok('manager', 'PATCH', `/privacy/register/${made.activity.id}`, { version: 1, retention: '12 years' })
    expect(changed.activity).toMatchObject({ retention: '12 years', version: 2 })
    expect((await call('manager', 'PATCH', `/privacy/register/${made.activity.id}`, { version: 1, retention: '5 years' })).statusCode).toBe(409)
    const archived = await ok('manager', 'POST', `/privacy/register/${made.activity.id}/archive`, { version: 2 })
    expect(archived.activity.status).toBe('ARCHIVED')
    expect((await call('manager', 'PATCH', `/privacy/register/${made.activity.id}`, { version: 3, retention: '1 year' })).statusCode).toBe(409)
    expect((await ok('viewer', 'GET', `/privacy/register?companyId=${A.companyA}&status=ARCHIVED`)).activities.map((row: Json) => row.id)).toEqual([made.activity.id])
    expect((await call('viewer', 'POST', '/privacy/register', { ...body, code: 'OTHER' })).statusCode).toBe(403)
    const audit = await admin('SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [made.activity.id])
    expect(audit.map((row) => row.action)).toEqual(['privacy.createActivity', 'privacy.changeActivity', 'privacy.archiveActivity'])
  }, 60_000)
})

describe('the public notice (GDPR arts. 13, 14; GAP-005)', () => {
  it('is read by anyone at /privacy/<company id>; nothing else here is', async () => {
    expect((await call(null, 'GET', `/privacy/public/${A.companyA}`)).statusCode).toBe(404)
    await published('PRIVACY_PUBLIC', { it: SAMPLE.publicIt, en: SAMPLE.publicEn })
    const anyone = await call(null, 'GET', `/privacy/public/${A.companyA}`)
    expect(anyone.statusCode, anyone.body).toBe(200)
    expect(anyone.json()).toMatchObject({ company: { id: A.companyA }, notice: { kind: 'PRIVACY_PUBLIC', locale: 'it', body: SAMPLE.publicIt, sha256: sha(SAMPLE.publicIt) } })
    expect((await call(null, 'GET', `/privacy/public/${A.companyA}?locale=en`)).json().notice.body).toBe(SAMPLE.publicEn)
    expect((await call(null, 'GET', `/privacy/public/${A.companyB}`)).statusCode).toBe(404)
    expect((await call(null, 'GET', `/privacy/public/${B.companyA}`)).statusCode).toBe(404)
    expect((await call(null, 'GET', `/privacy/public/${newId()}`)).statusCode).toBe(404)
    expect((await call(null, 'GET', '/privacy/public/not-an-id')).statusCode).toBe(404)
    // A portal or link session reads that and only that: every other privacy route is closed to it.
    expect((await call('partner', 'GET', `/privacy/public/${A.companyA}`)).statusCode).toBe(200)
    for (const url of [`/privacy/notices?companyId=${A.companyA}`, `/privacy/notices/${v2.id}`, '/privacy/floor/notice', '/privacy/staff-notice', `/privacy/dpia?companyId=${A.companyA}`, `/privacy/register?companyId=${A.companyA}`]) {
      expect((await call('partner', 'GET', url)).statusCode, url).toBe(403)
    }
  }, 60_000)
})

describe('the walls', () => {
  it('keep each company, tenant and audience to its own', async () => {
    // Another company's staff do not learn that company A's records exist.
    expect((await call('companyB', 'GET', `/privacy/notices?companyId=${A.companyA}`)).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/privacy/notices/${v2.id}`)).statusCode).toBe(404)
    expect((await call('companyB', 'POST', `/privacy/notices/${v2.id}/paper-acknowledgements`, { workerId: A.lead, locale: 'it' })).statusCode).toBe(404)
    expect((await ok('companyB', 'GET', `/privacy/notices?companyId=${A.companyB}`)).notices).toEqual([])
    // Another tenant sees nothing; view-only writes nothing.
    expect((await call('otherTenant', 'GET', `/privacy/notices/${v2.id}`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/privacy/notices?companyId=${A.companyA}`)).statusCode).toBe(404)
    expect((await call('viewer', 'POST', '/privacy/notices', { companyId: A.companyA, kind: 'PRIVACY_PUBLIC' })).statusCode).toBe(403)
    expect((await call('viewer', 'DELETE', `/privacy/notices/${v2.id}?version=1`)).statusCode).toBe(403)
    // The floor of company B reads no notice of company A (it has none of its own).
    const b1 = await floorNotice('floorB1')
    expect(b1).toMatchObject({ notice: null, gate: { noticeId: null, due: false, blocksScans: false } })
    // The floor reaches only its own routes; the office never the floor's.
    expect((await call('floorOperator', 'GET', `/privacy/notices?companyId=${A.companyA}`)).statusCode).toBe(403)
    expect((await call('floorOperator', 'GET', '/privacy/staff-notice')).statusCode).toBe(403)
    expect((await call('manager', 'GET', '/privacy/floor/notice')).statusCode).toBe(403)
    // The floor database role never reads who published a notice, nor a DPIA.
    await expect(h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, (client) => client.privacyNotice.findMany())).rejects.toThrow(/permission denied/)
    await expect(h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, (client) => client.privacyDpia.count())).rejects.toThrow(/permission denied/)
  }, 60_000)
})
