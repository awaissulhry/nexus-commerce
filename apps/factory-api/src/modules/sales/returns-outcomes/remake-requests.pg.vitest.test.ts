import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * A remake asked with photos from outside (B-W2b-346; SAL-298; follow-ups RX2:01 the claim link offers Remake, RX2:02 the
 * portal's new return offers Remake) on the local stack, through the real app, the real portal sign-in by code and a real
 * claim link token: the factory-db seeds up to shipping (SH-0001 SHIPPED), the customer's portal switched on, its buyer
 * (with the upload right) and viewer, an office person of returns. Every name, number and address is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/returns-outcomes/`.
 */

let h: Harness
const NS = 'returns-remake-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)

const people = { buyer: 'bruna.buyer@remake-racing.example', viewer: 'vera.viewer@remake-racing.example' }
const browsers = {} as Record<keyof typeof people, Browser>
const userIds = {} as Record<keyof typeof people, string>
let office: Browser

let keyCount = 0
const key = () => `w2b346-${process.pid}-${++keyCount}-${Date.now()}`
const post = (browser: Browser, url: string, body: unknown = {}) => browser.post(url, body, { headers: { 'idempotency-key': key() } })
const linkCall = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown, idempotencyKey = key()) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0', ...(method === 'POST' ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')

const OFFICE: Permission[] = ['sales.returns.view', 'sales.returns.manage', 'files.read', 'files.manage', 'files.upload']

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
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

async function ok(browser: Browser, url: string): Promise<Json> {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}

/** A made-up photo without location data: JFIF, a comment, then the image. */
function photo(label: string): Buffer {
  const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]
  const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
  return Buffer.from([0xff, 0xd8, ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]), ...segment(0xfe, ascii(`made-up ${label}`)), ...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd9])
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function sendPhoto(announce: () => Promise<{ status: number; body: Json }>, complete: (fileId: string) => Promise<{ status: number; body: Json }>, bytes: Buffer): Promise<string> {
  const announced = await announce()
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  const put = await h.app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: bytes })
  expect(put.statusCode, put.body).toBeLessThan(300)
  const done = await complete(announced.body.file.id)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return announced.body.file.id as string
}

const FIT = 'Made-up: the back is 4 cm too short when I lean forward on the bike.'

beforeAll(async () => {
  h = await startHarness('returns_remake')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  await portalWorld(h, tenant)
  freshGuard(h)
  userIds.buyer = await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-comment', 'partner-upload'])
  userIds.viewer = await partnerPerson(people.viewer, P1, ['customer-viewer'])
  for (const name of Object.keys(people) as (keyof typeof people)[]) browsers[name] = await signedIn(people[name])
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, 'remake-desk-346', 'Remake desk (test)', $3, false)`, [newId(), T, ['home.view', ...OFFICE]])
  await addUser(h, tenant, { email: 'rita.returns.346@example.com', role: 'remake-desk-346' })
  office = new Browser(h.app)
  const signed = await office.signIn(NS, 'rita.returns.346@example.com', 'quiet-harbour-lantern-58')
  expect(signed.status, JSON.stringify(signed.body)).toBe(200)
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('the portal’s new return offers Remake (SAL-298, RX2:02)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('makes a REQUESTED RMA of one item with the fit in words; the front and back photos go onto its line', async () => {
    const offer = await ok(browsers.buyer, '/portal/returns/returnable')
    const item = offer.items.find((entry: Json) => entry.canReturn >= 1)
    expect(item).toBeDefined()
    const line = { invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, quantity: 1, serial: null }
    // REFUSED: no words about the fit; two items; the viewer may not ask.
    const noFit = await post(browsers.buyer, '/portal/returns/remake', { lines: [line], fit: '  ' })
    expect(noFit.status, JSON.stringify(noFit.body)).toBe(400)
    expect(noFit.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/fit'])
    expect((await post(browsers.buyer, '/portal/returns/remake', { lines: [line, line], fit: FIT })).status).toBe(400)
    expect((await post(browsers.viewer, '/portal/returns/remake', { lines: [line], fit: FIT })).status).toBe(403)
    const sent = await post(browsers.buyer, '/portal/returns/remake', { lines: [line], fit: FIT, customerRef: 'CL-REMAKE-1' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const record = sent.body.return
    expect(record).toMatchObject({ status: 'REQUESTED', yourRef: 'CL-REMAKE-1', request: { via: 'PORTAL', note: FIT } })
    expect(sent.body.sent.words.en).toMatch(new RegExp(`^Remake request ${record.number} opened\\.`))
    expect(sent.body.sent.words.it).toMatch(new RegExp(`^Richiesta di rifacimento ${record.number} aperta\\.`))
    expect(await one('SELECT status::text, channel::text, "outcomeWanted"::text AS "outcomeWanted", "customerNote", "createdById" FROM "ReturnAuthorisation" WHERE id = $1', [record.id])).toEqual({ status: 'REQUESTED', channel: 'PORTAL', outcomeWanted: null, customerNote: FIT, createdById: userIds.buyer })
    const lineId = record.request.lines[0].id
    expect(await one('SELECT "reasonCode", "reasonNote", quantity FROM "ReturnLine" WHERE id = $1', [lineId])).toEqual({ reasonCode: 'WRONG_SIZE', reasonNote: FIT, quantity: 1 })
    expect(await one('SELECT "actorId", after FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 AND action = $3', ['ReturnAuthorisation', record.id, 'returnsOutcomes.remakeAsked'])).toEqual({ actorId: userIds.buyer, after: { lineIds: [lineId], via: 'PORTAL', fit: FIT } })
    expect((await events('return.remake_asked')).find((payload) => payload.returnId === record.id)).toEqual({ returnId: record.id, number: record.number, lineIds: [lineId], via: 'PORTAL' })
    for (const view of ['front', 'back']) {
      const bytes = photo(view)
      await sendPhoto(
        () => post(browsers.buyer, `/portal/returns/${record.id}/photos`, { lineId, originalName: `${record.number}-${view}.jpg`, contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) }),
        (id) => post(browsers.buyer, `/portal/returns/${record.id}/photos/${id}/complete`),
        bytes,
      )
    }
    // The office reads the remake asked, with the line's two photos.
    const outcomes = await office.get(`/sales/returns/${record.id}/outcomes`)
    expect(outcomes.status, JSON.stringify(outcomes.body)).toBe(200)
    expect(outcomes.body.return.remake).toMatchObject({ asked: true, via: 'PORTAL', lineIds: [lineId], fit: FIT, photos: [{ lineId, count: 2, needed: 2 }] })
    // The customer withdraws it (B-W2b-192's cancel): the piece may come back again.
    const version = (await one<{ version: number }>('SELECT version FROM "ReturnAuthorisation" WHERE id = $1', [record.id])).version
    expect((await post(browsers.buyer, `/portal/returns/${record.id}/cancel`, { version })).status).toBe(200)
  })
})

describe('the claim link offers Remake with its questions and photos (SAL-298, RX2:01)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a refusal uses nothing; the remake is a counted use, the case on the link’s page, its photos by the link', async () => {
    const shipmentId = (await one<{ id: string }>(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = 'SEED-SH-0001'`, [T])).id
    const made = await office.post('/sales/claim-links', { recordType: 'Shipment', recordId: shipmentId, email: 'claims@remake-racing.example', send: false }, { headers: { 'idempotency-key': key() } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const token = tokenOf(made.body.url)
    const page = (await linkCall(token, 'GET', '/link/claim?language=en')).json() as Json
    const item = page.items.find((entry: Json) => entry.canReturn >= 1)
    expect(item).toBeDefined()
    const line = { invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, quantity: 1 }
    const uses = async () => (await one<{ uses: number }>('SELECT uses FROM "OneOffLink" WHERE id = $1', [made.body.link.id])).uses
    const refusedAnswer = await linkCall(token, 'POST', '/link/claim/remake?language=en', { lines: [line], fit: '' })
    expect(refusedAnswer.statusCode, refusedAnswer.body).toBe(400)
    expect(await uses()).toBe(0)
    const sent = await linkCall(token, 'POST', '/link/claim/remake?language=en', { lines: [line], fit: FIT, typedName: 'Carlo Claims' })
    expect(sent.statusCode, sent.body).toBe(201)
    const answer = sent.json() as Json
    expect(answer.sent).toMatchObject({ type: 'RETURN', words: { en: expect.stringMatching(/^Remake request /) } })
    expect(answer.cases.map((entry: Json) => entry.id)).toEqual([answer.sent.id])
    expect(answer.link.usesLeft).toBe(4)
    expect(await uses()).toBe(1)
    expect(await one('SELECT status::text, channel::text, "createdById", "customerNote" FROM "ReturnAuthorisation" WHERE id = $1', [answer.sent.id])).toEqual({ status: 'REQUESTED', channel: 'LINK', createdById: null, customerNote: FIT })
    const linkCase = await one('SELECT after FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 AND action = $3', ['OneOffLink', made.body.link.id, 'portalReturns.linkCase'])
    expect(linkCase.after).toMatchObject({ caseType: 'ReturnAuthorisation', caseId: answer.sent.id, remake: true })
    const lines = (await linkCall(token, 'GET', `/link/claim/cases/RETURN/${answer.sent.id}`)).json() as Json
    const lineId = lines.return.request.lines[0].id
    const bytes = photo('front')
    await sendPhoto(
      async () => {
        const response = await linkCall(token, 'POST', '/link/claim/photos', { caseType: 'RETURN', caseId: answer.sent.id, lineId, originalName: `${answer.sent.number}-front.jpg`, contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) })
        return { status: response.statusCode, body: response.json() as Json }
      },
      async (id) => {
        const response = await linkCall(token, 'POST', `/link/claim/photos/${id}/complete`)
        return { status: response.statusCode, body: response.json() as Json }
      },
      bytes,
    )
    expect((await events('return.remake_asked')).find((payload) => payload.returnId === answer.sent.id)).toMatchObject({ via: 'LINK', lineIds: [lineId] })
    const outcomes = await office.get(`/sales/returns/${answer.sent.id}/outcomes`)
    expect(outcomes.body.return.remake).toMatchObject({ asked: true, via: 'LINK', photos: [{ lineId, count: 1, needed: 2 }] })
  })
})
