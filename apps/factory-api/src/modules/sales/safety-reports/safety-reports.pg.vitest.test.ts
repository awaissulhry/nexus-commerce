import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedService } from '../../../../../../packages/factory-db/seed/service'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import indexer from '../../../platform/search/indexers/safety-report'
import { useSafetyReportsOutside } from './outside'

/**
 * Product-safety reports and the accident log on the local stack (B-W2b-351; SAL-414, SAL-415, SAL-423), through the real app,
 * real office sign-ins, a real portal sign-in by code and the public DoC code of a released batch: the factory-db seeds up to the
 * service wave (the serials SEED-SN-0001..0003 of batch SEED-BT-0003 made for P1, WO-0001 released as batch SEED-BT-0001, the
 * seeded reports PSR-SEED-0001..0003), company A's public privacy notice and FAKE sending address, a quality desk (the product-safety role: view, manage,
 * injury, log, the register), a sales desk (view, manage; no injury), a reader, P1's portal buyer and viewer. Every name,
 * number and word is made up (no real injury words); every date is counted from the test's own day.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/safety-reports/`.
 */

let h: Harness
const NS = 'safety-reports-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)

/** Made-up words that must never leave the injury table (and what happened, which never leaves the report). */
const INJURY = 'Made-up: a graze on the left forearm, seen at the circuit.'
const HAPPENED = 'Made-up: the rider slid out in a bend at low speed; the left sleeve seam opened.'

const browsers = {} as Record<'quality' | 'desk' | 'reader', Browser>
const portal = {} as Record<'buyer' | 'viewer', Browser>
let keyCount = 0
const key = () => `w2b351-${process.pid}-${++keyCount}-${Date.now()}`
const post = (browser: Browser, url: string, body: unknown = {}, idempotencyKey: string = key()) => browser.post(url, body, { headers: { 'idempotency-key': idempotencyKey } })
const patch = (browser: Browser, url: string, body: unknown) => browser.send('PATCH' as 'POST', url, body, { headers: { 'idempotency-key': key() } })
const anonymous = (method: 'GET' | 'POST', url: string, payload?: unknown, idempotencyKey: string | null = key()) =>
  h.app.inject({ method, url, headers: { 'user-agent': 'SeedPhone/1.0', ...(method === 'POST' && idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(browser: Browser, url: string): Promise<Json> {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}
async function done(answer: { status: number; body: any }, status = 200): Promise<Json> {
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const today = () => h.clock.now().toISOString().slice(0, 10)
const daysAgo = (days: number) => new Date(h.clock.now().getTime() - days * 86_400_000).toISOString().slice(0, 10)

/** A made-up photo without location data: JFIF, a comment, then the image. */
function photo(): Buffer {
  const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]
  const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
  return Buffer.from([0xff, 0xd8, ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]), ...segment(0xfe, ascii('made-up sleeve')), ...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd9])
}
const photoBody = () => ({ originalName: 'sleeve.jpg', contentType: 'image/jpeg', sizeBytes: photo().length, sha256: createHash('sha256').update(photo()).digest('hex') })
async function putBytes(upload: Json) {
  const put = await h.app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: photo() })
  expect(put.statusCode, put.body).toBeLessThan(300)
}

/** Nothing written outside the injury table may hold its words (nor what happened, outside the report). */
async function nowhereElse(words: string) {
  const like = `%${words.slice(10, 40)}%`
  for (const [table, column] of [['AuditLog', 'after'], ['AuditLog', 'before'], ['OutboxEvent', 'payload'], ['IdempotencyReceipt', 'response'], ['ServiceCase', 'problem'], ['PpeRegisterEntry', 'description'], ['SearchEntry', 'searchText']] as const) {
    const rows = await admin(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1 AND "${column}"::text LIKE $2`, [T, like])
    expect(rows[0]!.n, `${table}.${column}`).toBe(0)
  }
}

// files.read too: the report's photos must stay out of the generic files routes even for a role that reads files.
const QUALITY: Permission[] = ['home.view', 'sales.safety.view', 'sales.safety.manage', 'sales.safety.injury', 'sales.safety.log', 'sales.service.view', 'sales.service.manage', 'compliance.register.view', 'compliance.register.manage', 'threads.read', 'files.read']
const DESK: Permission[] = ['home.view', 'sales.safety.view', 'sales.safety.manage', 'sales.service.view', 'sales.service.manage', 'threads.read']
const READER: Permission[] = ['home.view', 'sales.safety.view']

async function partnerPerson(email: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId: P1, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [P1], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

beforeAll(async () => {
  h = await startHarness('safety_reports')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  useSafetyReportsOutside(false)
  await seedCore({ db: h.database, namespace: NS })
  await seedService({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedPrivacy({ db: h.database, namespace: NS })
  // Company A's FAKE sending address: the portal's sign-in code goes by mail.
  await seedEmail({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  for (const [name, permissions] of Object.entries({ quality: QUALITY, desk: DESK, reader: READER })) {
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, $3, $4, $5, false)`, [newId(), T, `safety-${name}-351`, `Safety ${name} (test)`, [...permissions].sort()])
    await addUser(h, tenant, { email: `${name}.safety.351@example.com`, role: `safety-${name}-351` })
    browsers[name as keyof typeof browsers] = new Browser(h.app)
    expect((await browsers[name as keyof typeof browsers].signIn(NS, `${name}.safety.351@example.com`, 'quiet-harbour-lantern-58')).status).toBe(200)
  }
  // The portal: its terms, P1's buyer (who may ask and upload) and a viewer (who may only read).
  await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson('bruno.buyer@seed-racing.example', ['customer-buyer', 'partner-upload'])
  await partnerPerson('vera.viewer@seed-racing.example', ['customer-viewer'])
  portal.buyer = await signedIn('bruno.buyer@seed-racing.example')
  portal.viewer = await signedIn('vera.viewer@seed-racing.example')
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useSafetyReportsOutside(undefined)
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

let mailed: Json

describe('a report the office types from a mail: the SAFETY case, the injury apart, the accident log (SAL-414, SAL-415, SAL-423)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const body = () => ({
    companyId: companyA,
    source: 'MAIL',
    partyId: P1,
    serial: 'SEED-SN-0002',
    whatHappened: HAPPENED,
    wornAsIntended: true,
    accident: true,
    occurredOn: daysAgo(3),
    place: 'Made-up: a track day, turn 4',
    injured: true,
    injuryConsent: true,
    injuryWords: INJURY,
    reporter: { name: 'Made-up Rider', email: 'rider.351@example.com', phone: '+39 000 000 0000' },
  })

  it('refuses in words: the reader, words without the consent tick, an accident without its place', async () => {
    expect((await post(browsers.reader, '/sales/safety-reports', body())).status).toBe(403)
    expect((await done(await post(browsers.desk, '/sales/safety-reports', { ...body(), injuryConsent: false }), 400)).error.issues).toContainEqual({
      path: 'body/injuryConsent',
      message: 'Tick the consent first: the injury words are health data (GDPR art. 9), kept only with an explicit consent.',
    })
    expect((await done(await post(browsers.desk, '/sales/safety-reports', { ...body(), place: null }), 400)).error.issues).toEqual([{ path: 'body/place', message: 'Say where it happened (one line): an accident goes in the accident log.' }])
    expect((await admin('SELECT id FROM "ProductSafetyReport" WHERE "tenantId" = $1 AND source = $2', [T, 'MAIL'])).length).toBe(1)
  })

  it('records it NEW with its number, its SAFETY case HIGH that never repeats the reporter, the injury and revision 1 apart', async () => {
    const answer = await done(await post(browsers.desk, '/sales/safety-reports', body()), 201)
    mailed = answer.report
    expect(mailed.number).toMatch(/^PSR-\d{4}-0001$/)
    expect(mailed).toMatchObject({ status: 'NEW', source: 'MAIL', seen: false, garmentSerial: 'SEED-SN-0002', garmentBatch: 'SEED-BT-0003', party: { id: P1 }, whatHappened: HAPPENED, wornAsIntended: true, filed: false })
    expect(mailed.reporter).toEqual({ name: 'Made-up Rider', email: 'rider.351@example.com', phone: '+39 000 000 0000' })
    // Whether someone was hurt is in no answer: the desk only learns that the report says.
    expect(mailed.injury).toEqual({ recorded: true, mayOpen: false })
    expect(JSON.stringify(answer)).not.toContain('graze')
    expect(mailed.accidentLog.newest).toMatchObject({ revision: 1, occurredOn: daysAgo(3), place: 'Made-up: a track day, turn 4', serial: 'SEED-SN-0002', batchNumber: 'SEED-BT-0003', outcome: 'NOT_KNOWN', authority: null })
    const serviceCase = await one('SELECT kind, channel, status, priority, "partyId", problem FROM "ServiceCase" WHERE id = $1', [answer.serviceCase.id])
    expect(serviceCase).toMatchObject({ kind: 'SAFETY', channel: 'MAIL', status: 'NEW', priority: 'HIGH', partyId: P1 })
    expect(serviceCase.problem).toBe(`Product-safety report ${mailed.number}, from a mail: what happened is on the report, and whether someone was hurt only for the product-safety role.`)
    expect(mailed.case).toMatchObject({ id: answer.serviceCase.id, number: answer.serviceCase.number })
    const injury = await one('SELECT key, injured, "consentAt", "injuryWords" FROM "ProductSafetyInjury" WHERE "reportId" = $1', [mailed.id])
    expect(injury).toMatchObject({ key: `injury:${mailed.id}`, injured: true, injuryWords: INJURY })
    expect(injury.consentAt).not.toBeNull()
    const [received] = (await events('safety_report.received')).filter((payload) => payload.reportId === mailed.id)
    expect(received).toEqual({ reportId: mailed.id, number: mailed.number, source: 'MAIL', partyId: P1, serviceCaseId: answer.serviceCase.id, garmentSerial: 'SEED-SN-0002', garmentBatch: 'SEED-BT-0003', accidentLogged: true })
    await nowhereElse(INJURY)
    await nowhereElse(HAPPENED)
  })

  it('lists it without the reporter, what happened or the injury; the tiles count it', async () => {
    const list = await ok(browsers.reader, '/sales/safety-reports')
    const row = list.reports.find((entry: Json) => entry.id === mailed.id)
    expect(row).toMatchObject({ number: mailed.number, status: 'NEW', seen: false, accident: { outcome: 'NOT_KNOWN', told: false, mustTell: false } })
    expect(JSON.stringify(list)).not.toMatch(/graze|slid out|Made-up Rider/)
    const read = await ok(browsers.reader, `/sales/safety-reports/${mailed.id}`)
    expect(read.report).toMatchObject({ reporter: null, reporterHidden: true, injury: { recorded: true, mayOpen: false } })
    expect((await ok(browsers.quality, '/sales/safety-reports/counts')).tiles).toMatchObject({ notSeen: 2, assessing: 1 })
  })

  it('opens the injury for the product-safety role only, each opening recorded before the words are read', async () => {
    expect((await post(browsers.desk, `/sales/safety-reports/${mailed.id}/injury/open`)).status).toBe(403)
    const opened = await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/injury/open`))
    expect(opened.injury).toMatchObject({ reportId: mailed.id, injured: true, words: INJURY, erased: null })
    const views = await admin(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordId" = $2 AND action = 'safetyReports.injuryOpened'`, [T, mailed.id])
    expect(views).toEqual([{ after: { what: 'OPEN' } }])
    await nowhereElse(INJURY)
  })
})

describe('quality follows it up: seen, assessed, filed in the register, the authority told, erased on request, closed', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('marks it seen once, then assesses it', async () => {
    const seen = await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/seen`, { version: mailed.version }))
    expect(seen.report).toMatchObject({ seen: true, status: 'NEW' })
    expect((await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/seen`, { version: seen.report.version }), 409)).error.issues[0].path).toBe('held/SEEN')
    const assessing = await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/status`, { version: seen.report.version, to: 'ASSESSING' }))
    mailed = assessing.report
    expect(mailed.status).toBe('ASSESSING')
  })

  it('files it in the PPE register: a COMPLAINT entry opened for it, its source the report, never the reporter’s words', async () => {
    const filed = await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/register-entry`, { version: mailed.version }))
    mailed = filed.report
    expect(filed.registerEntry.opened).toBe(true)
    expect(mailed.registerEntry).toMatchObject({ id: filed.registerEntry.id, status: 'OPEN' })
    const entry = await ok(browsers.quality, `/compliance/register/${filed.registerEntry.id}`)
    expect(entry.entry).toMatchObject({ kind: 'COMPLAINT', source: { type: 'ProductSafetyReport', id: mailed.id } })
    expect((await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/register-entry`, { version: mailed.version }), 409)).error.issues[0].path).toBe('held/FILED')
    await nowhereElse(HAPPENED)
  })

  it('keeps the accident log append-only: a revision says why; the authority told by the person; a rewrite refused by the database', async () => {
    expect((await post(browsers.desk, `/sales/safety-reports/${mailed.id}/accident-log`, { version: mailed.version, outcome: 'MINOR_HARM', note: 'x' })).status).toBe(403)
    expect((await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/accident-log`, { version: mailed.version, outcome: 'MINOR_HARM' }), 400)).error.issues).toEqual([
      { path: 'body/note', message: 'Say why this revision corrects or completes the accident log.' },
    ])
    const graded = await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/accident-log`, { version: mailed.version, outcome: 'SERIOUS_HARM', note: 'Made-up: graded after the call with the rider.' }), 201)
    expect(graded.entry).toMatchObject({ revision: 2, outcome: 'SERIOUS_HARM', place: 'Made-up: a track day, turn 4', authority: null })
    expect(graded.report.accidentLog.state).toMatchObject({ told: false, mustTell: true })
    expect((await ok(browsers.quality, '/sales/safety-reports/counts')).tiles.accidentsToTell).toBe(1)
    // The office's commands run on the server's clock (the harness clock moved ahead with the portal sign-ins): told a while ago.
    const toldAt = new Date(Date.now() - 10 * 60_000).toISOString()
    const told = await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/accident-log`, { version: graded.report.version, authorityToldAt: toldAt, authorityReference: 'MADE-UP-SBG-0001', note: 'Made-up: told through the Safety Business Gateway.' }), 201)
    mailed = told.report
    expect(told.entry).toMatchObject({ revision: 3, outcome: 'SERIOUS_HARM', authority: { reference: 'MADE-UP-SBG-0001', noticeId: null } })
    const log = await ok(browsers.reader, '/sales/safety-reports/accident-log?told=yes')
    expect(log.entries.find((entry: Json) => entry.reportId === mailed.id)).toMatchObject({ revision: 3, revisions: 3, number: mailed.number, mustTell: false })
    expect((await ok(browsers.reader, `/sales/safety-reports/${mailed.id}/accident-log`)).revisions.map((entry: Json) => entry.revision)).toEqual([3, 2, 1])
    await expect(admin(`UPDATE "AccidentLogEntry" SET place = 'rewritten' WHERE "reportId" = $1`, [mailed.id])).rejects.toThrow(/accident log is never changed/)
  })

  it('erases the injury words and, after the close, the reporter’s data, each on request with its reason', async () => {
    expect((await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/injury/erase`, { version: mailed.version, reason: '' }), 400)).error.issues[0].path).toBe('body/reason')
    const erased = await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/injury/erase`, { version: mailed.version, reason: "Made-up: the rider's request by mail" }))
    expect((await one('SELECT "injuryWords", "erasedAt" FROM "ProductSafetyInjury" WHERE "reportId" = $1', [mailed.id])).injuryWords).toBeNull()
    expect((await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/injury/open`))).injury).toMatchObject({ injured: true, words: null, erased: { at: expect.any(String) } })
    expect((await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/injury/erase`, { version: erased.report.version, reason: 'again' }), 409)).error.issues[0].path).toBe('held/ERASED')
    expect((await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/status`, { version: erased.report.version, to: 'CLOSED' }), 400)).error.issues[0].path).toBe('body/note')
    const closed = await done(await post(browsers.quality, `/sales/safety-reports/${mailed.id}/status`, { version: erased.report.version, to: 'CLOSED', note: 'Made-up: the seam held to the certified test; the slide was beyond it.' }))
    expect(closed.report).toMatchObject({ status: 'CLOSED', closed: { note: 'Made-up: the seam held to the certified test; the slide was beyond it.' } })
    expect((await patch(browsers.desk, `/sales/safety-reports/${mailed.id}`, { version: closed.report.version, size: '54' })).status).toBe(409)
    const gone = await done(await post(browsers.desk, `/sales/safety-reports/${mailed.id}/reporter/erase`, { version: closed.report.version, reason: "Made-up: the rider's request by mail" }))
    expect(gone.report.reporter).toEqual({ name: null, email: null, phone: null })
    expect((await events('safety_report.erased')).filter((payload) => payload.reportId === mailed.id).map((payload) => payload.what)).toEqual(['INJURY_WORDS', 'REPORTER'])
  })
})

describe('the doors from outside: OFF until the privacy notice is published (GATE-PRIVACY)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let code = ''
  beforeAll(async () => {
    const order = await one<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND "batchNumber" = 'SEED-BT-0001' AND "releasedAt" IS NOT NULL`, [T])
    code = publicDocCodeOf(order.id)
  })
  const publicBody = (over: Json = {}) => ({ code, whatHappened: 'Made-up: the collar zip opened while riding.', injured: false, reporter: { email: 'reader.351@example.com' }, ...over })

  it('says so, and refuses both doors while the switch is off', async () => {
    useSafetyReportsOutside(false)
    expect((await anonymous('GET', '/public/safety-reports/status')).json()).toMatchObject({ open: false })
    const refused = await anonymous('POST', '/public/safety-reports', publicBody())
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.issues[0].path).toBe('held/OFF')
    expect((await ok(portal.buyer, '/portal/safety-reports/status')).open).toBe(false)
    expect((await post(portal.buyer, '/portal/safety-reports', { serial: 'SEED-SN-0001', whatHappened: 'Made-up.', injured: false })).status).toBe(409)
  })

  it('takes a report from the public DoC page once on: the batch from the QR, a SAFETY case with no customer, a repeat answers the same, photos with the ticket', async () => {
    useSafetyReportsOutside(true)
    expect((await anonymous('POST', '/public/safety-reports', publicBody(), null)).statusCode).toBe(400)
    expect((await anonymous('POST', '/public/safety-reports', publicBody({ code: 'ZZZZ-ZZZY' }))).statusCode).toBe(404)
    expect((await anonymous('POST', '/public/safety-reports', publicBody({ injured: true, injuryWords: 'Made-up words.', occurredOn: today(), place: 'a road' }))).json().error.issues).toContainEqual(
      expect.objectContaining({ path: 'body/injuryConsent' }),
    )
    const idempotencyKey = key()
    const sent = await anonymous('POST', '/public/safety-reports', publicBody(), idempotencyKey)
    expect(sent.statusCode, sent.body).toBe(201)
    const answer = sent.json()
    expect(answer.sent.words).toBe(`Safety report ${answer.sent.number} received: our quality team reads it today. Thank you for telling us.`)
    const again = await anonymous('POST', '/public/safety-reports', publicBody(), idempotencyKey)
    expect(again.json().sent.number).toBe(answer.sent.number)
    const report = await one('SELECT id, source, "partyId", "garmentBatch", "styleId", "serviceCaseId", "createdById" FROM "ProductSafetyReport" WHERE "tenantId" = $1 AND number = $2', [T, answer.sent.number])
    expect(report).toMatchObject({ source: 'PUBLIC_LINK', partyId: null, garmentBatch: 'SEED-BT-0001', createdById: null })
    expect(await one('SELECT kind, channel, "ownerId", "partyId" FROM "ServiceCase" WHERE id = $1', [report.serviceCaseId])).toEqual({ kind: 'SAFETY', channel: 'LINK', ownerId: null, partyId: null })
    expect(await one('SELECT injured, "consentAt", "injuryWords" FROM "ProductSafetyInjury" WHERE "reportId" = $1', [report.id])).toEqual({ injured: false, consentAt: null, injuryWords: null })
    expect((await admin('SELECT id FROM "AccidentLogEntry" WHERE "reportId" = $1', [report.id])).length).toBe(0)
    // Photos after the send, with the ticket; a changed ticket opens nothing; files.read never reaches them.
    expect((await anonymous('POST', '/public/safety-reports/photos', { ticket: `${answer.photos.ticket.slice(0, -2)}xx`, ...photoBody() })).statusCode).toBe(404)
    const announced = await anonymous('POST', '/public/safety-reports/photos', { ticket: answer.photos.ticket, ...photoBody() })
    expect(announced.statusCode, announced.body).toBe(201)
    await putBytes(announced.json().upload)
    const completed = await anonymous('POST', `/public/safety-reports/photos/${announced.json().file.id}/complete`, { ticket: answer.photos.ticket })
    expect(completed.statusCode, completed.body).toBe(200)
    expect(completed.json().file.status).toBe('AVAILABLE')
    const record = await ok(browsers.quality, `/sales/safety-reports/${report.id}`)
    expect(record.report.photos.map((entry: Json) => entry.id)).toEqual([announced.json().file.id])
    expect((await browsers.quality.get(`/files/${announced.json().file.id}`)).status).toBe(404)
    const opened = await done(await post(browsers.reader, `/sales/safety-reports/${report.id}/photos/${announced.json().file.id}/open`))
    expect(opened.download.url).toEqual(expect.any(String))
  })

  it('takes a report from the portal as the person; the viewer may not send one', async () => {
    useSafetyReportsOutside(true)
    expect((await ok(portal.buyer, '/portal/safety-reports/status')).open).toBe(true)
    expect((await post(portal.viewer, '/portal/safety-reports', { serial: 'SEED-SN-0001', whatHappened: 'Made-up.', injured: false })).status).toBe(403)
    expect((await done(await post(portal.buyer, '/portal/safety-reports', { whatHappened: 'Made-up.', injured: false }), 400)).error.issues[0].path).toBe('body/serial')
    const sent = await done(await post(portal.buyer, '/portal/safety-reports', { serial: 'SEED-SN-0001', whatHappened: 'Made-up: the shoulder pocket tore off in a fall.', injured: false, accident: true, occurredOn: daysAgo(1), place: 'Made-up: a road' }), 201)
    const report = await one('SELECT id, source, "partyId", "garmentSerial", "serviceCaseId" FROM "ProductSafetyReport" WHERE id = $1', [sent.report.id])
    expect(report).toMatchObject({ source: 'PORTAL', partyId: P1, garmentSerial: 'SEED-SN-0001' })
    expect(await one('SELECT channel, "partyId" FROM "ServiceCase" WHERE id = $1', [report.serviceCaseId])).toEqual({ channel: 'PORTAL', partyId: P1 })
    expect(await one('SELECT revision, outcome FROM "AccidentLogEntry" WHERE "reportId" = $1', [report.id])).toEqual({ revision: 1, outcome: 'NO_HARM' })
    const announced = await done(await post(portal.buyer, `/portal/safety-reports/${report.id}/photos`, photoBody()), 201)
    await putBytes(announced.upload)
    expect((await done(await post(portal.buyer, `/portal/safety-reports/${report.id}/photos/${announced.file.id}/complete`))).file.status).toBe('AVAILABLE')
    expect((await post(portal.viewer, `/portal/safety-reports/${report.id}/photos`, photoBody())).status).toBe(403)
  })

  it('the search index names a report by its number and garment, never what happened', async () => {
    const report = await one<{ id: string }>('SELECT id FROM "ProductSafetyReport" WHERE "tenantId" = $1 AND source = $2', [T, 'PORTAL'])
    const read = await callerFor(h.database, systemContext(T, newId())).withClient((client) => indexer.read(client as never, { ids: [report.id] } as never, 5))
    expect(read[0]).toMatchObject({ recordId: report.id, subtitle: 'SEED-SN-0001' })
    // B-W2b-383 (B-W2b-382's gap): the result opens under Compliance, where the report's page is.
    expect(indexer.area).toBe('compliance')
    expect(JSON.stringify(read)).not.toContain('pocket')
  })
})
