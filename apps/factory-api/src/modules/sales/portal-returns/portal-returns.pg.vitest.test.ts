import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seed as seedCapa } from '../../../../../../packages/factory-db/seed/capa'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { makeReport } from '../../quality/capa/report'
import { publishAnswer, shareEightD } from '../../quality/complaints/portal/publish'
import { authoriseReturn, rejectReturn } from './office'

/**
 * Returns and complaints from outside on the local stack (B-W2b-192; SAL-334, SAL-424; CO5:01, CO5:02), through the real
 * app, the real portal sign-in by code and real link tokens: the factory-db seeds up to the CAPA wave (SEED-RMA-0001
 * AUTHORISED, SEED-RMA-0002 INSPECTED, SEED-CMP-0001 a SAFETY complaint of the brand SEED-C1 with SEED-8D-0001 at D3 and a
 * letter written, SH-0001 SHIPPED), its portal switched on, the customer's buyer (with the upload right), quality and
 * viewer, another customer's buyer, an office person of sales. Every name, number and address is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/portal-returns`.
 */

let h: Harness
const NS = 'portal-returns-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const CMP1 = seedUuid(NS, 'returns:CMP-0001')
const EIGHT_D = seedUuid(NS, 'capa:capa:8D-0001')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)

const people = { buyer: 'bianca.buyer@seed-racing.example', quality: 'quinto.quality@seed-racing.example', viewer: 'vito.viewer@seed-racing.example', other: 'otto.buyer@brand-alpha.example' }
const browsers = {} as Record<keyof typeof people, Browser>
const userIds = {} as Record<keyof typeof people, string>
let officeId = ''
let office: Browser

let keyCount = 0
const key = () => `w2b192-${process.pid}-${++keyCount}-${Date.now()}`
const post = (browser: Browser, url: string, body: unknown = {}) => browser.post(url, body, { headers: { 'idempotency-key': key() } })
const linkCall = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown, idempotencyKey = key()) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0', ...(method === 'POST' ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')

const OFFICE: Permission[] = ['sales.returns.view', 'sales.returns.manage', 'quality.complaints.view', 'quality.complaints.manage', 'quality.capa.view', 'quality.capa.manage', 'files.read', 'files.manage', 'files.upload']
const officeCaller = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId: newId(), grants: [{ permissions: OFFICE, companies: 'all', sites: 'all', parties: 'all' }] })

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
function photo(): Buffer {
  const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]
  const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
  return Buffer.from([0xff, 0xd8, ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]), ...segment(0xfe, ascii('made-up seam')), ...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd9])
}

async function sendPhoto(announce: () => Promise<{ status: number; body: Json }>, complete: (fileId: string) => Promise<{ status: number; body: Json }>): Promise<string> {
  const announced = await announce()
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  const put = await h.app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: photo() })
  expect(put.statusCode, put.body).toBeLessThan(300)
  const done = await complete(announced.body.file.id)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  expect(done.body.file.status).toBe('AVAILABLE')
  return announced.body.file.id as string
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

beforeAll(async () => {
  h = await startHarness('portal_returns')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedCapa({ db: h.database, namespace: NS })
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
  // The seeded FAKE file store allows a burst of 10 calls: this file stores, copies and serves more in a minute.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  // The letterhead the 8D report, the letter and the instructions need (c.c. art. 2250), made up.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  const world = await portalWorld(h, tenant)
  freshGuard(h)
  userIds.buyer = await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-comment', 'partner-upload'])
  userIds.quality = await partnerPerson(people.quality, P1, ['customer-quality'])
  userIds.viewer = await partnerPerson(people.viewer, P1, ['customer-viewer'])
  userIds.other = await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  for (const name of Object.keys(people) as (keyof typeof people)[]) browsers[name] = await signedIn(people[name])
  // The office person: a role of the returns' and complaints' permissions without two-factor (the system roles ask it).
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, 'claims-desk-192', 'Claims desk (test)', $3, false)`, [newId(), T, ['home.view', ...OFFICE]])
  officeId = (await addUser(h, tenant, { email: 'sara.sales.192@example.com', role: 'claims-desk-192' })).id
  office = new Browser(h.app)
  const signed = await office.signIn(NS, 'sara.sales.192@example.com', 'quiet-harbour-lantern-58')
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

let requested: Json

describe('the cases and a return request from the portal (SAL-334)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists the customer cases with the next step in its words; another customer sees none of them', async () => {
    const list = await ok(browsers.buyer, '/portal/returns?chip=ALL')
    const numbers = list.items.map((item: Json) => item.number)
    expect(numbers).toEqual(expect.arrayContaining(['SEED-RMA-0001', 'SEED-RMA-0002', 'SEED-CMP-0001']))
    const waiting = list.items.find((item: Json) => item.number === 'SEED-RMA-0001')
    expect(waiting).toMatchObject({ type: 'RETURN', state: 'SEND_IT_BACK', next: { forYou: true, code: 'SEND_IT_BACK' }, chips: ['OPEN', 'WAITING'] })
    expect(list.items.find((item: Json) => item.number === 'SEED-CMP-0001')).toMatchObject({ type: 'COMPLAINT', state: 'INVESTIGATING', next: { forYou: false } })
    expect(list).toMatchObject({ mayRequest: true, readsComplaints: false })
    expect((await ok(browsers.viewer, '/portal/returns')).mayRequest).toBe(false)
    expect((await ok(browsers.other, '/portal/returns?chip=ALL')).items).toEqual([])
  })

  it('offers what may come back without a price for a role without prices, then makes an RMA REQUESTED from the request', async () => {
    const offer = await ok(browsers.buyer, '/portal/returns/returnable')
    const item = offer.items.find((entry: Json) => entry.canReturn >= 1)
    expect(item).toBeDefined()
    expect(offer.reasons.length).toBeGreaterThan(0)
    expect(offer.outcomes.map((entry: Json) => entry.code)).toEqual(['REPLACE', 'REPAIR', 'CREDIT'])
    const viewerOffer = await ok(browsers.viewer, '/portal/returns/returnable')
    expect(viewerOffer.items.every((entry: Json) => entry.unitPrice === undefined)).toBe(true)
    const reason = offer.reasons.find((entry: Json) => !entry.needsNote) ?? offer.reasons[0]
    const body = { lines: [{ invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, quantity: 1, reasonCode: reason.code, reasonNote: 'The seam opened after two rides.' }], outcomeWanted: 'REPAIR', customerRef: 'CL-RET-1', note: 'Please collect it with the next delivery.' }
    // REFUSED: more than may come back (409 in words, at the line's quantity).
    const above = await post(browsers.buyer, '/portal/returns', { ...body, lines: [{ ...body.lines[0], quantity: 999 }] })
    expect(above.status, JSON.stringify(above.body)).toBe(409)
    expect(above.body.error.issues[0].path).toBe('body/lines/0/quantity')
    // REFUSED: the viewer may not ask.
    expect((await post(browsers.viewer, '/portal/returns', body)).status).toBe(403)
    const sent = await post(browsers.buyer, '/portal/returns', body)
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    requested = sent.body.return
    expect(requested).toMatchObject({ status: 'REQUESTED', state: 'REQUESTED', yourRef: 'CL-RET-1', next: { forYou: false, code: 'WE_DECIDE' } })
    expect(requested.request).toMatchObject({ via: 'PORTAL', outcomeWanted: { code: 'REPAIR' }, note: 'Please collect it with the next delivery.' })
    expect(requested.request.lines).toHaveLength(1)
    expect(sent.body.sent.words.en).toMatch(new RegExp(`^Return request ${requested.number} opened\\.`))
    const row = await one('SELECT status::text, "createdById", "authorisedAt", "goodsDueBy" FROM "ReturnAuthorisation" WHERE id = $1', [requested.id])
    expect(row).toEqual({ status: 'REQUESTED', createdById: userIds.buyer, authorisedAt: null, goodsDueBy: null })
    expect((await events('return_request.sent')).find((payload) => payload.returnId === requested.id)).toMatchObject({ via: 'PORTAL', pieces: 1, partyId: P1 })
    const audit = await one('SELECT "actorId", after FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 AND action = $3', ['ReturnAuthorisation', requested.id, 'portalReturns.request'])
    expect(audit).toMatchObject({ actorId: userIds.buyer, after: { via: 'PORTAL', byPartner: true, outcomeWanted: 'REPAIR' } })
  })

  it('takes photos of a line while undecided, served back without location data', async () => {
    const line = requested.request.lines[0]
    const bytes = photo()
    const fileId = await sendPhoto(
      () => post(browsers.buyer, `/portal/returns/${requested.id}/photos`, { lineId: line.id, originalName: 'seam.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) }),
      (id) => post(browsers.buyer, `/portal/returns/${requested.id}/photos/${id}/complete`),
    )
    const record = (await ok(browsers.buyer, `/portal/returns/${requested.id}`)).return
    expect(record.request.lines[0].photos.map((file: Json) => file.id)).toEqual([fileId])
    expect(await one('SELECT visibility::text[] AS visibility, "partyId", "recordType" FROM "StoredFile" WHERE id = $1', [fileId])).toEqual({ visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: P1, recordType: 'ReturnLine' })
    const opened = await post(browsers.viewer, `/portal/returns/files/${fileId}/open`, { mode: 'preview' })
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body.download.url).toBeTruthy()
    // REFUSED: the viewer has no upload right; another customer does not find the return.
    expect((await post(browsers.viewer, `/portal/returns/${requested.id}/photos`, { originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) })).status).toBe(403)
    expect((await browsers.other.get(`/portal/returns/${requested.id}`)).status).toBe(404)
  })

  it('the office authorises it in Returns: the customer reads "send it back by" and prints the instructions', async () => {
    const before = await one<{ version: number }>('SELECT version FROM "ReturnAuthorisation" WHERE id = $1', [requested.id])
    const answer = await authoriseReturn(officeCaller(), requested.id, { version: before.version })
    expect(answer.return).toMatchObject({ status: 'AUTHORISED' })
    expect((await events('return.authorised')).some((payload) => payload.returnId === requested.id)).toBe(true)
    const record = (await ok(browsers.buyer, `/portal/returns/${requested.id}`)).return
    expect(record).toMatchObject({ state: 'SEND_IT_BACK', next: { forYou: true, code: 'SEND_IT_BACK' }, progress: { instructions: true } })
    expect(record.progress.decision.en).toMatch(/^Approved: send it back/)
    expect(record.progress.milestones.map((step: Json) => step.state)).toEqual(['DONE', 'DONE', 'CURRENT', 'TODO', 'TODO'])
    const pdf = await browsers.buyer.get(`/portal/returns/${requested.id}/instructions?language=en`)
    expect(pdf.status).toBe(200)
    expect(pdf.response.headers['content-type']).toBe('application/pdf')
    expect(pdf.response.rawPayload.subarray(0, 4).toString()).toBe('%PDF')
    // REFUSED: authorised twice (409 in words).
    await expect(authoriseReturn(officeCaller(), requested.id, { version: answer.return.version })).rejects.toThrow(/authorised only while it is requested/)
  })

  it('cancels a request before the goods leave; refuses one whose goods are back; the office rejects another in words', async () => {
    const offer = await ok(browsers.buyer, '/portal/returns/returnable')
    const item = offer.items.find((entry: Json) => entry.canReturn >= 1)
    const body = { lines: [{ invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, quantity: 1, reasonCode: offer.reasons[0].code, reasonNote: 'Wrong size.' }] }
    const second = (await post(browsers.buyer, '/portal/returns', body)).body.return
    const cancelled = await post(browsers.buyer, `/portal/returns/${second.id}/cancel`, { version: second.version, reason: 'Found the right size after all.' })
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    expect(cancelled.body.return).toMatchObject({ status: 'CANCELLED', state: 'CANCELLED' })
    const inspected = (await ok(browsers.buyer, '/portal/returns?chip=ALL')).items.find((entry: Json) => entry.number === 'SEED-RMA-0002')
    const refused = await post(browsers.buyer, `/portal/returns/${inspected.id}/cancel`, { version: 1 })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/with us already/)
    const third = (await post(browsers.buyer, '/portal/returns', body)).body.return
    await rejectReturn(officeCaller(), third.id, { version: 1, reason: 'Outside the return window agreed.' })
    const rejected = (await ok(browsers.buyer, `/portal/returns/${third.id}`)).return
    expect(rejected).toMatchObject({ state: 'NOT_ACCEPTED', next: { words: { en: 'Not accepted: Outside the return window agreed.' } } })
    expect((await ok(browsers.buyer, '/portal/returns?chip=CLOSED')).items.map((entry: Json) => entry.id)).toEqual(expect.arrayContaining([second.id, third.id]))
  })
})

describe('complaints from the portal and their status (SAL-424), the 8D shared (CO5:01) and the answer published (CO5:02)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let complaint: Json

  it('a quality complaint arrives NEW, channel PORTAL; the buyer sees its status, not the investigation', async () => {
    const order = await one<{ id: string }>(`SELECT l.id FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0002' ORDER BY l.seq LIMIT 1`, [T])
    const sent = await post(browsers.buyer, '/portal/complaints', { description: 'The knee protector pocket tore on the first ride.', salesOrderLineId: order.id, size: '50', customerRef: 'CL-CMP-9' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    complaint = sent.body.complaint
    expect(complaint).toMatchObject({ status: 'NEW', state: 'RECEIVED', request: { via: 'PORTAL', item: { size: '50' } }, investigation: null })
    expect(await one('SELECT channel::text, status::text, "createdById" FROM "Complaint" WHERE id = $1', [complaint.id])).toEqual({ channel: 'PORTAL', status: 'NEW', createdById: userIds.buyer })
    expect((await events('complaint.received')).some((payload) => payload.complaintId === complaint.id && payload.channel === 'PORTAL')).toBe(true)
    // REFUSED: an item of another customer's order (400 at the field).
    const foreign = await one<{ id: string }>(`SELECT l.id FROM "SalesOrderLine" l WHERE l."tenantId" = $1 AND l."partyId" <> $2 LIMIT 1`, [T, P1])
    if (foreign) expect((await post(browsers.buyer, '/portal/complaints', { description: 'x', salesOrderLineId: foreign.id })).body.error.issues[0].path).toBe('body/salesOrderLineId')
    // REFUSED: the Quality list is not the buyer's (403).
    expect((await browsers.buyer.get('/portal/complaints')).status).toBe(403)
  })

  it("the Quality role follows the seeded complaint's 8D steps; the 8D shared is a copy on the complaint", async () => {
    const list = await ok(browsers.quality, '/portal/complaints')
    expect(list.items.find((item: Json) => item.number === 'SEED-CMP-0001')).toMatchObject({ stepReached: { en: 'D3 Containment' } })
    const before = (await ok(browsers.quality, `/portal/complaints/${CMP1}`)).complaint
    expect(before.investigation.steps.slice(0, 4).map((step: Json) => step.state)).toEqual(['DONE', 'DONE', 'CURRENT', 'TODO'])
    expect(before.investigation.documents).toEqual([])
    // A version of the 8D kept on the CAPA (B-W2b-108's Report tab); the newest is the one shared.
    await makeReport(h.files, officeCaller(), EIGHT_D, { language: 'en' })
    const shared = await shareEightD(h.files, officeCaller(), CMP1, {})
    expect(shared.shared).toMatchObject({ capaNumber: 'SEED-8D-0001', made: true })
    expect(await one('SELECT visibility::text[] AS visibility, "partyId", "sourceFileId" FROM "StoredFile" WHERE id = $1', [shared.shared.fileId])).toEqual({ visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: P1, sourceFileId: shared.shared.sourceFileId })
    expect((await one<{ visibility: string[] }>('SELECT visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1', [shared.shared.sourceFileId])).visibility).toEqual(['OFFICE'])
    expect((await shareEightD(h.files, officeCaller(), CMP1, {})).shared.made).toBe(false)
    const after = (await ok(browsers.quality, `/portal/complaints/${CMP1}`)).complaint
    expect(after.investigation.documents).toEqual([expect.objectContaining({ id: shared.shared.fileId, role: 'EIGHT_D' })])
    expect((await post(browsers.quality, `/portal/returns/files/${shared.shared.fileId}/open`, { mode: 'download' })).status).toBe(200)
    // REFUSED: the buyer sees the complaint's status, not our reports (403 in words).
    expect((await post(browsers.buyer, `/portal/returns/files/${shared.shared.fileId}/open`, { mode: 'download' })).status).toBe(403)
    expect((await events('complaint_document.shared')).some((payload) => payload.fileId === shared.shared.fileId)).toBe(true)
  })

  it('publishes the written answer to the portal: ANSWERED via PORTAL, the letter for the Quality role', async () => {
    // REFUSED: a new complaint is not triaged yet.
    await expect(publishAnswer(h.files, officeCaller(), complaint.id, { version: 1 })).rejects.toThrow(/triage it first/)
    const version = (await one<{ version: number }>('SELECT version FROM "Complaint" WHERE id = $1', [CMP1])).version
    const published = await publishAnswer(h.files, officeCaller(), CMP1, { version })
    expect(published.complaint).toMatchObject({ status: 'ANSWERED' })
    expect(await one('SELECT status::text, "answeredVia"::text AS via, "answerDocumentId" IS NOT NULL AS letter FROM "Complaint" WHERE id = $1', [CMP1])).toEqual({ status: 'ANSWERED', via: 'PORTAL', letter: true })
    expect(await admin('SELECT id FROM "EmailOutbound" WHERE "recordType" = $1 AND "recordId" = $2', ['Complaint', CMP1])).toEqual([])
    const record = (await ok(browsers.quality, `/portal/complaints/${CMP1}`)).complaint
    expect(record).toMatchObject({ state: 'ANSWERED', next: { forYou: true, code: 'READ_ANSWER' }, investigation: { answeredVia: 'PORTAL' } })
    expect(record.investigation.documents.map((doc: Json) => doc.role).sort()).toEqual(['ANSWER_LETTER', 'EIGHT_D'])
    expect((await ok(browsers.buyer, `/portal/complaints/${CMP1}`)).complaint).toMatchObject({ next: { forYou: false, code: 'ANSWERED' }, investigation: null })
    expect((await events('complaint_answer.published')).map((payload) => payload.complaintId)).toContain(CMP1)
  })

  it("counts the customer's cases on Home", async () => {
    const count = (home: Json, name: string) => home.counts.find((entry: Json) => entry.key === name)?.value
    const home = await ok(browsers.quality, '/portal/home')
    expect(count(home, 'returns.open')).toBeGreaterThanOrEqual(3)
    expect(count(home, 'returns.complaints_open')).toBeGreaterThanOrEqual(1)
    expect(count(home, 'returns.waiting_for_you')).toBeGreaterThanOrEqual(1)
    expect(count(await ok(browsers.buyer, '/portal/home'), 'returns.complaints_open')).toBeNull()
  })
})

describe('"Report a problem" by a claim link', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let token = ''
  let shipmentId = ''

  it('the office makes a claim link for a shipment that left; the holder sees its items without a price', async () => {
    shipmentId = (await one<{ id: string }>(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = 'SEED-SH-0001'`, [T])).id
    const made = await office.post('/sales/claim-links', { recordType: 'Shipment', recordId: shipmentId, email: 'claims@seed-racing.example', send: false }, { headers: { 'idempotency-key': key() } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.url).toContain('#token=')
    token = tokenOf(made.body.url)
    expect(await one('SELECT purpose::text, "recordType", "partyId", "tokenHash" <> $2 AS hashed FROM "OneOffLink" WHERE id = $1', [made.body.link.id, token])).toEqual({ purpose: 'CLAIM', recordType: 'Shipment', partyId: P1, hashed: true })
    // REFUSED: a shipment still a DRAFT has no claim link.
    const draft = await admin<{ id: string }>(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND status = 'DRAFT' LIMIT 1`, [T])
    if (draft[0]) expect((await office.post('/sales/claim-links', { recordType: 'Shipment', recordId: draft[0].id, send: false }, { headers: { 'idempotency-key': key() } })).status).toBe(404)
    const page = await linkCall(token, 'GET', '/link/claim?language=en')
    expect(page.statusCode, page.body).toBe(200)
    const body = page.json() as Json
    expect(body).toMatchObject({ record: { type: 'Shipment', id: shipmentId }, types: ['RETURN', 'COMPLAINT'], cases: [], link: { usesLeft: 5 } })
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.every((item: Json) => item.unitPrice === undefined)).toBe(true)
  })

  it('sends a return and a complaint: each a counted use, the draft dropped, the cases on the page; a refused one uses nothing', async () => {
    const page = (await linkCall(token, 'GET', '/link/claim')).json() as Json
    const item = page.items.find((entry: Json) => entry.canReturn >= 1)
    const reason = page.reasons[0]
    const line = { invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, reasonCode: reason.code, reasonNote: 'Stitching undone.' }
    // REFUSED before any use: more than may come back.
    const above = await linkCall(token, 'POST', '/link/claim', { type: 'RETURN', lines: [{ ...line, quantity: 999 }] })
    expect(above.statusCode, above.body).toBe(409)
    expect(await one('SELECT uses FROM "OneOffLink" WHERE "tokenHash" IS NOT NULL AND purpose = $1 AND "recordId" = $2 ORDER BY "createdAt" DESC LIMIT 1', ['CLAIM', shipmentId])).toEqual({ uses: 0 })
    // A draft kept with us (B-W2b-163), dropped by the send.
    const draft = await h.app.inject({ method: 'PUT', url: '/link/draft', headers: { 'x-factory-link': token, 'idempotency-key': key() }, payload: { data: { step: 'item', type: 'RETURN' } } })
    expect(draft.statusCode, draft.body).toBe(200)
    const sent = await linkCall(token, 'POST', '/link/claim', { type: 'RETURN', lines: [{ ...line, quantity: 1 }], outcomeWanted: 'CREDIT', typedName: 'Carla Claims' })
    expect(sent.statusCode, sent.body).toBe(201)
    const answer = sent.json() as Json
    expect(answer.sent).toMatchObject({ type: 'RETURN' })
    expect(answer.cases.map((entry: Json) => entry.number)).toEqual([answer.sent.number])
    expect(await one('SELECT count(*)::int AS n FROM "LinkDraft" WHERE "tenantId" = $1', [T])).toEqual({ n: 0 })
    expect(await one('SELECT status::text, "createdById" FROM "ReturnAuthorisation" WHERE id = $1', [answer.sent.id])).toEqual({ status: 'REQUESTED', createdById: null })
    const complaintSent = await linkCall(token, 'POST', '/link/claim', { type: 'COMPLAINT', description: 'The zip broke on the second day.', salesOrderLineId: item.salesOrderLineId, size: item.size })
    expect(complaintSent.statusCode, complaintSent.body).toBe(201)
    const afterComplaint = complaintSent.json() as Json
    expect(afterComplaint.cases.map((entry: Json) => entry.type).sort()).toEqual(['COMPLAINT', 'RETURN'])
    expect(await one('SELECT channel::text FROM "Complaint" WHERE id = $1', [afterComplaint.sent.id])).toEqual({ channel: 'LINK' })
    const evidence = await admin<{ action: string }>('SELECT action::text FROM "LinkEvidence" WHERE "linkId" = (SELECT id FROM "OneOffLink" WHERE purpose = $1 AND "recordId" = $2 ORDER BY "createdAt" DESC LIMIT 1)', ['CLAIM', shipmentId])
    expect(evidence.filter((row) => row.action === 'SUBMITTED')).toHaveLength(2)
    expect(afterComplaint.link.usesLeft).toBe(3)
    // The portal sees the cases the link opened, as the customer's.
    expect((await ok(browsers.buyer, '/portal/returns?chip=ALL')).items.map((entry: Json) => entry.id)).toEqual(expect.arrayContaining([answer.sent.id, afterComplaint.sent.id]))
    // A photo of the return by the link.
    const bytes = photo()
    await sendPhoto(
      async () => {
        const response = await linkCall(token, 'POST', '/link/claim/photos', { caseType: 'RETURN', caseId: answer.sent.id, originalName: 'stitch.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) })
        return { status: response.statusCode, body: response.json() as Json }
      },
      async (id) => {
        const response = await linkCall(token, 'POST', `/link/claim/photos/${id}/complete`)
        return { status: response.statusCode, body: response.json() as Json }
      },
    )
    // REFUSED: a case this link did not open (404), a garbage token (404).
    expect((await linkCall(token, 'GET', `/link/claim/cases/RETURN/${requested.id}`)).statusCode).toBe(404)
    expect((await linkCall('garbage', 'GET', '/link/claim')).statusCode).toBe(404)
  })
})
