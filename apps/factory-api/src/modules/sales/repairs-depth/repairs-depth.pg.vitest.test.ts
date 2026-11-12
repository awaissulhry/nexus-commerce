import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedReturns } from '../../../../../../packages/factory-db/seed/returns'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Repairs and alterations in depth on the local stack (B-W2b-342; SAL-384, SAL-385, SAL-387, SAL-391, SAL-393; RR1:01,
 * RR1:02), through the real app, the real portal sign-in by code, real office sign-ins and a real claim link token: the
 * factory-db seeds up to the returns wave (SEED-REP-0001 RECEIVED from SEED-RMA-0002's line, a protective jacket; SH-0001
 * shipped to P1; the serials SEED-SN-0001..0003), P1's portal switched on, its buyer (prices, upload) and viewer, another
 * customer's buyer, an office desk with prices and costs and one without. Every name, number and address is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/repairs-depth`.
 */

let h: Harness
const NS = 'repairs-depth-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)

const people = { buyer: 'bruna.buyer@seed-racing.example', viewer: 'vera.viewer@seed-racing.example', other: 'oscar.buyer@brand-alpha.example' }
const browsers = {} as Record<keyof typeof people, Browser>
let desk: Browser
let blind: Browser

let keyCount = 0
const key = () => `w2b342-${process.pid}-${++keyCount}-${Date.now()}`
const send = (browser: Browser, method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => browser.send(method as 'POST', url, body ?? (method === 'DELETE' ? undefined : {}), { headers: { 'idempotency-key': key() } })
const post = (browser: Browser, url: string, body: unknown = {}) => send(browser, 'POST', url, body)
const linkCall = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown, idempotencyKey = key()) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0', ...(method === 'POST' ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')

async function ok(browser: Browser, url: string): Promise<Json> {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}
async function done(answer: { status: number; body: any }, status = 200): Promise<Json> {
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

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

/** A made-up photo without location data: JFIF, a comment, then the image. */
function photo(): Buffer {
  const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]
  const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
  return Buffer.from([0xff, 0xd8, ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]), ...segment(0xfe, ascii('made-up tear')), ...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd9])
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const photoBody = (name: string) => {
  const bytes = photo()
  return { originalName: name, contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) }
}

async function sendPhoto(announce: () => Promise<{ status: number; body: Json }>, complete: (fileId: string) => Promise<{ status: number; body: Json }>): Promise<string> {
  const announced = await announce()
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  const put = await h.app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: photo() })
  expect(put.statusCode, put.body).toBeLessThan(300)
  const confirmed = await complete(announced.body.file.id)
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
  expect(confirmed.body.file.status).toBe('AVAILABLE')
  return announced.body.file.id as string
}

const REPAIRS: Permission[] = ['home.view', 'sales.repairs.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.returns.view', 'sales.returns.manage', 'quality.complaints.view', 'files.read', 'files.upload', 'files.manage']

beforeAll(async () => {
  h = await startHarness('repairs_depth')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedReturns({ db: h.database, namespace: NS })
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
  // The seeded FAKE file store allows a burst of 10 calls: this file stores and serves more in a minute.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  const world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-upload'])
  await partnerPerson(people.viewer, P1, ['customer-viewer'])
  await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  for (const name of Object.keys(people) as (keyof typeof people)[]) browsers[name] = await signedIn(people[name])
  // The office: a repairs desk with prices and costs, and one without prices (both without two-factor).
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains, "requireMfa") VALUES ($1, $2, 'repairs-desk-342', 'Repairs desk (test)', $3, $4, false)`, [newId(), T, [...REPAIRS].sort(), ['cost', 'price']])
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, 'repairs-blind-342', 'Repairs without prices (test)', $3, false)`, [newId(), T, [...REPAIRS].sort()])
  await addUser(h, tenant, { email: 'rita.repairs.342@example.com', role: 'repairs-desk-342' })
  await addUser(h, tenant, { email: 'bruno.blind.342@example.com', role: 'repairs-blind-342' })
  desk = new Browser(h.app)
  expect((await desk.signIn(NS, 'rita.repairs.342@example.com', 'quiet-harbour-lantern-58')).status).toBe(200)
  blind = new Browser(h.app)
  expect((await blind.signIn(NS, 'bruno.blind.342@example.com', 'quiet-harbour-lantern-58')).status).toBe(200)
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

let asked: Json

describe('a repair request from the portal with damage photos (SAL-384, SAL-385, RR1:02)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('makes a repair AWAITING_GOODS, channel PORTAL, from an item we delivered and the serial on its label; a viewer may not ask', async () => {
    const offer = await ok(browsers.buyer, '/portal/returns/returnable')
    const item = offer.items.find((entry: Json) => entry.salesOrderLineId)
    expect(item).toBeDefined()
    const body = { kind: 'REPAIR', salesOrderLineId: item.salesOrderLineId, size: item.size, serial: 'SEED-SN-0001', problem: 'The left shoulder seam opened after a slide.', workWanted: 'Re-sew the seam and check the shoulder protector.' }
    // REFUSED: a repair without words, and a viewer who may only read.
    expect((await done(await post(browsers.buyer, '/portal/repairs', { kind: 'REPAIR', salesOrderLineId: item.salesOrderLineId }), 400)).error.issues).toEqual([{ path: 'body/problem', message: 'Say what is wrong with the garment.' }])
    expect((await post(browsers.viewer, '/portal/repairs', body)).status).toBe(403)
    const sent = await done(await post(browsers.buyer, '/portal/repairs', body), 201)
    asked = sent.repair
    expect(asked).toMatchObject({ kind: 'REPAIR', stage: 'AWAITING_GOODS', channel: 'PORTAL', workWanted: body.workWanted, next: { code: 'SEND_GARMENT', forYou: true }, estimate: null, actions: { addPhotos: null, answer: 'NOT_ASKED' } })
    expect(asked.sendTo).toMatchObject({ name: expect.any(String) })
    expect(sent.sent).toMatchObject({ type: 'REPAIR', number: asked.number })
    const row = await one('SELECT channel::text, "garmentSerial", serial, "workWanted", "createdById" IS NOT NULL AS by, "ownerId", "safetyCheckRequired" FROM "RepairOrder" WHERE id = $1', [asked.id])
    expect(row).toMatchObject({ channel: 'PORTAL', garmentSerial: 'SEED-SN-0001', serial: 'SEED-SN-0001', workWanted: body.workWanted, by: true, ownerId: null })
    expect((await events('repair_request.sent')).find((payload) => payload.repairId === asked.id)).toMatchObject({ via: 'PORTAL', kind: 'REPAIR', partyId: P1, garmentSerial: 'SEED-SN-0001' })
    expect((await events('repair.created')).some((payload) => payload.repairId === asked.id)).toBe(true)
    expect(await one('SELECT after FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 AND action = $3', ['RepairOrder', asked.id, 'repairsDepth.request'])).toMatchObject({ after: { channel: 'PORTAL', byPartner: true } })
    // The list, and another customer who finds nothing.
    expect((await ok(browsers.buyer, '/portal/repairs')).items.map((entry: Json) => entry.number)).toContain(asked.number)
    expect((await ok(browsers.other, '/portal/repairs')).items).toEqual([])
    expect((await browsers.other.get(`/portal/repairs/${asked.id}`)).status).toBe(404)
  })

  it('refuses a second repair of the same garment while one is open, in words', async () => {
    const again = await post(browsers.buyer, '/portal/repairs', { kind: 'ALTERATION', serial: 'SEED-SN-0001', workWanted: 'Shorten the sleeves by 2 cm.' })
    expect(again.status, JSON.stringify(again.body)).toBe(409)
    expect(again.body.error.message).toBe(`Repair ${asked.number} is open for this garment already: follow it there.`)
  })

  it('takes the damage photos (DAMAGE_PHOTO, shared with the party), shows them to the customer and the office', async () => {
    for (const name of ['seam-1.jpg', 'seam-2.jpg']) {
      await sendPhoto(
        () => post(browsers.buyer, `/portal/repairs/${asked.id}/photos`, photoBody(name)),
        (fileId) => post(browsers.buyer, `/portal/repairs/${asked.id}/photos/${fileId}/complete`),
      )
    }
    const record = (await ok(browsers.buyer, `/portal/repairs/${asked.id}`)).repair
    expect(record.photos.map((entry: Json) => entry.name)).toEqual(['seam-1.jpg', 'seam-2.jpg'])
    expect(await admin('SELECT category::text, visibility::text[] AS visibility, "partyId" FROM "StoredFile" WHERE "recordType" = $1 AND "recordId" = $2 ORDER BY "createdAt"', ['RepairOrder', asked.id])).toEqual([
      { category: 'DAMAGE_PHOTO', visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: P1 },
      { category: 'DAMAGE_PHOTO', visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: P1 },
    ])
    expect((await done(await post(browsers.viewer, `/portal/repairs/files/${record.photos[0].id}/open`, { mode: 'preview' }))).download.url).toBeTruthy()
    // REFUSED: the viewer has no upload right.
    expect((await post(browsers.viewer, `/portal/repairs/${asked.id}/photos`, photoBody('x.jpg'))).status).toBe(403)
    // The office's intake: how it came, the work wanted, the garment of ours, the photos from the customer, the safety rule.
    const intake = (await ok(desk, `/sales/repairs/${asked.id}/intake`)).intake
    expect(intake).toMatchObject({ repair: { channel: 'PORTAL', stage: 'AWAITING_GOODS' }, workWanted: 'Re-sew the seam and check the shoulder protector.', garment: { garmentSerial: 'SEED-SN-0001' }, photosNeeded: 2, photosHeld: null })
    expect(intake.garment.ours).toMatchObject({ madeOn: expect.any(String), size: expect.any(String) })
    expect(intake.photos.map((entry: Json) => entry.fromCustomer)).toEqual([true, true])
    expect(intake.cover.words).toEqual(expect.any(String))
    // The office adds its own damage photo (office only).
    await sendPhoto(
      () => post(desk, `/sales/repairs/${asked.id}/photos`, photoBody('desk.jpg')),
      (fileId) => post(desk, `/sales/repairs/${asked.id}/photos/${fileId}/complete`),
    )
    expect((await ok(desk, `/sales/repairs/${asked.id}/intake`)).intake.photos.map((entry: Json) => entry.fromCustomer)).toEqual([true, true, false])
    expect((await ok(browsers.buyer, `/portal/repairs/${asked.id}`)).repair.photos).toHaveLength(2)
  })
})

describe('the estimate from parts and labour, accepted before work starts (SAL-387)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let view: Json

  it('drafts an estimate with a part and a labour line (prices by grain), sends it and estimates the repair', async () => {
    const repair = (await ok(desk, `/sales/repairs/${asked.id}`)).repair
    await done(await post(desk, `/sales/repairs/${asked.id}/receive`, { version: repair.version, inboundDdtNumber: 'CL-DDT-342' }))
    view = await done(await post(desk, `/sales/repairs/${asked.id}/estimates`, { validUntil: null, customerNote: 'Prices include the return transport.' }), 201)
    const draft = view.estimates[0]
    expect(draft).toMatchObject({ revision: 1, status: 'DRAFT', currency: 'EUR', lines: [], summary: { amount: 0, lines: 0 } })
    // REFUSED: a second draft while one is live; a role without prices writes none.
    expect((await post(desk, `/sales/repairs/${asked.id}/estimates`, {})).status).toBe(409)
    expect((await done(await post(blind, `/sales/repairs/${asked.id}/estimates`, {}), 403)).error.message).toBe('An estimate is prices: your role does not see selling prices, so it cannot write one.')
    view = await done(await post(desk, `/sales/repairs/estimates/${draft.id}/lines`, { version: draft.version, kind: 'PART', description: 'Shoulder protector, level 2', quantity: '1', unitPrice: '18.50', unitCost: '9.00' }), 201)
    view = await done(await post(desk, `/sales/repairs/estimates/${draft.id}/lines`, { version: view.estimates[0].version, kind: 'LABOUR', description: 'Re-sew the left shoulder seam', quantity: '1', minutes: 40, unitPrice: '35.00', unitCost: '12.00' }), 201)
    expect(view.estimates[0].summary).toEqual({ amount: 5350, partsAmount: 1850, labourAmount: 3500, costAmount: 2100, labourMinutes: 40, lines: 2 })
    expect(view.estimates[0].lines.map((line: Json) => [line.seq, line.kind, line.amount, line.costAmount])).toEqual([[10, 'PART', 1850, 900], [20, 'LABOUR', 3500, 1200]])
    // The blind desk reads the estimate without a price or a cost.
    const blindView = await ok(blind, `/sales/repairs/${asked.id}/estimates`)
    expect(blindView.estimates[0].lines[0].unitPrice).toBeUndefined()
    expect(blindView.estimates[0].summary.amount).toBeUndefined()
    expect(blindView.estimates[0].lines[0].costAmount).toBeUndefined()
    // A line changed and one removed while a draft.
    const labour = view.estimates[0].lines[1]
    view = await done(await send(desk, 'PATCH', `/sales/repairs/estimates/${draft.id}/lines/${labour.id}`, { version: view.estimates[0].version, minutes: 45 }))
    expect(view.estimates[0].summary.labourMinutes).toBe(45)
    view = await done(await post(desk, `/sales/repairs/estimates/${draft.id}/lines`, { version: view.estimates[0].version, kind: 'PART', description: 'A line removed again', quantity: '1', unitPrice: '1' }), 201)
    const extra = view.estimates[0].lines[2]
    view = await done(await send(desk, 'DELETE', `/sales/repairs/estimates/${draft.id}/lines/${extra.id}?version=${view.estimates[0].version}`))
    expect(view.estimates[0].lines).toHaveLength(2)
    view = await done(await post(desk, `/sales/repairs/estimates/${draft.id}/send`, { version: view.estimates[0].version }))
    expect(view.estimates[0]).toMatchObject({ status: 'SENT', sentAt: expect.any(String) })
    expect(view.repair.stage).toBe('ESTIMATED')
    expect(view.workHeld.approve).toBe(`Estimate 1 of repair ${asked.number} waits for the customer's answer: record it (Estimate › Record the answer) before the repair is approved.`)
    expect((await events('repair_estimate.sent')).find((payload) => payload.repairId === asked.id)).toMatchObject({ revision: 1, partyId: P1 })
  })

  it('freezes what the customer saw; W2a\'s stage route waits for the answer (409 in words)', async () => {
    const sent = view.estimates[0]
    const late = await post(desk, `/sales/repairs/estimates/${sent.id}/lines`, { version: sent.version, kind: 'PART', description: 'Too late', quantity: '1', unitPrice: '1' })
    expect(late.status).toBe(409)
    expect(late.body.error.message).toBe(`Estimate 1 of repair ${asked.number} is sent: it changes no more (make a new revision to change it).`)
    const repair = (await ok(desk, `/sales/repairs/${asked.id}`)).repair
    const approve = await post(desk, `/sales/repairs/${asked.id}/stage`, { version: repair.version, to: 'APPROVED', note: 'Approved by phone.' })
    expect(approve.status).toBe(409)
    expect(approve.body.error.message).toBe(view.workHeld.approve)
  })

  it('the customer reads the estimate in the portal (prices only with the grain) and accepts it: the repair is approved', async () => {
    const record = (await ok(browsers.buyer, `/portal/repairs/${asked.id}`)).repair
    expect(record).toMatchObject({ stage: 'ESTIMATED', next: { code: 'ANSWER_ESTIMATE', forYou: true }, estimate: { revision: 1, status: 'SENT', amount: 5350, customerNote: 'Prices include the return transport.' }, actions: { answer: null } })
    expect(record.estimate.lines.map((line: Json) => Object.keys(line).sort())).toEqual([
      ['amount', 'description', 'kind', 'minutes', 'quantity', 'seq', 'unitPrice'],
      ['amount', 'description', 'kind', 'minutes', 'quantity', 'seq', 'unitPrice'],
    ])
    const viewer = (await ok(browsers.viewer, `/portal/repairs/${asked.id}`)).repair
    expect(viewer.estimate.amount).toBeUndefined()
    expect(viewer.actions.answer).toBe('NO_REQUEST')
    expect((await post(browsers.viewer, `/portal/repairs/${asked.id}/estimate/answer`, { estimateId: record.estimate.id, version: record.estimate.version, answer: 'ACCEPTED' })).status).toBe(403)
    const accepted = await done(await post(browsers.buyer, `/portal/repairs/${asked.id}/estimate/answer`, { estimateId: record.estimate.id, version: record.estimate.version, answer: 'ACCEPTED' }))
    expect(accepted.repair).toMatchObject({ stage: 'APPROVED', next: { code: 'WE_REPAIR' }, estimate: { status: 'ACCEPTED', answeredVia: 'PORTAL' } })
    expect(await one('SELECT "answeredVia"::text AS via, "answeredByName" AS name, "recordedById" FROM "RepairEstimate" WHERE id = $1', [record.estimate.id])).toEqual({ via: 'PORTAL', name: 'bruna.buyer', recordedById: null })
    expect((await events('repair_estimate.answered')).find((payload) => payload.estimateId === record.estimate.id)).toMatchObject({ answer: 'ACCEPTED', via: 'PORTAL' })
    const stages = (await ok(desk, `/sales/repairs/${asked.id}`)).repair.stages.map((entry: Json) => entry.to)
    expect(stages.slice(-3)).toEqual(['RECEIVED', 'ESTIMATED', 'APPROVED'])
    // REFUSED: answered twice; a new estimate once approved.
    expect((await post(browsers.buyer, `/portal/repairs/${asked.id}/estimate/answer`, { estimateId: record.estimate.id, version: record.estimate.version + 1, answer: 'DECLINED', declineReason: 'x' })).status).toBe(409)
    expect((await done(await post(desk, `/sales/repairs/${asked.id}/estimates`, {}), 409)).error.message).toBe(`Repair ${asked.number} is approved by the customer: the estimate is made before the work starts.`)
  })

  it('a declined estimate refuses approval; a new revision replaces a sent one; the office records the yes by phone', async () => {
    const seeded = await one<{ id: string }>(`SELECT id FROM "RepairOrder" WHERE "tenantId" = $1 AND number = 'SEED-REP-0001'`, [T])
    let estimates = await done(await post(desk, `/sales/repairs/${seeded.id}/estimates`, {}), 201)
    let draft = estimates.estimates[0]
    estimates = await done(await post(desk, `/sales/repairs/estimates/${draft.id}/lines`, { version: draft.version, kind: 'LABOUR', description: 'Re-sew the seam', quantity: '1', minutes: 30, unitPrice: '30' }), 201)
    estimates = await done(await post(desk, `/sales/repairs/estimates/${draft.id}/send`, { version: estimates.estimates[0].version }))
    // The office replaces the sent estimate with a cheaper one: the sent one is withdrawn, its lines copied.
    estimates = await done(await post(desk, `/sales/repairs/${seeded.id}/estimates`, { replaces: draft.id }), 201)
    expect(estimates.estimates.map((row: Json) => [row.revision, row.status])).toEqual([[2, 'DRAFT'], [1, 'WITHDRAWN']])
    draft = estimates.estimates[0]
    expect(draft.lines).toHaveLength(1)
    estimates = await done(await send(desk, 'PATCH', `/sales/repairs/estimates/${draft.id}/lines/${draft.lines[0].id}`, { version: draft.version, unitPrice: '25' }))
    estimates = await done(await post(desk, `/sales/repairs/estimates/${draft.id}/send`, { version: estimates.estimates[0].version }))
    // REFUSED: a decline without the customer's words; then the decline, and the approval it refuses.
    const sent = estimates.estimates[0]
    expect((await post(desk, `/sales/repairs/estimates/${sent.id}/answer`, { version: sent.version, answer: 'DECLINED', how: 'By phone' })).status).toBe(400)
    estimates = await done(await post(desk, `/sales/repairs/estimates/${sent.id}/answer`, { version: sent.version, answer: 'DECLINED', how: 'By phone with the rider', declineReason: 'Too expensive for an old jacket.' }))
    expect(estimates.estimates[0]).toMatchObject({ status: 'DECLINED', answeredVia: 'OFFICE', declineReason: 'Too expensive for an old jacket.' })
    expect(estimates.workHeld.approve).toBe('The customer declined estimate 2 of repair SEED-REP-0001: make a new estimate, or send the garment back unrepaired.')
    const repair = (await ok(desk, `/sales/repairs/${seeded.id}`)).repair
    expect((await post(desk, `/sales/repairs/${seeded.id}/stage`, { version: repair.version, to: 'APPROVED', note: 'Approved by phone.' })).status).toBe(409)
    // A third revision, the lines copied, sent and accepted by phone: the repair is approved in the same command.
    estimates = await done(await post(desk, `/sales/repairs/${seeded.id}/estimates`, { copyLines: true }), 201)
    draft = estimates.estimates[0]
    estimates = await done(await post(desk, `/sales/repairs/estimates/${draft.id}/send`, { version: draft.version }))
    estimates = await done(await post(desk, `/sales/repairs/estimates/${draft.id}/answer`, { version: estimates.estimates[0].version, answer: 'ACCEPTED', how: 'By phone, 12 November', answeredByName: 'The rider' }))
    expect(estimates.repair.stage).toBe('APPROVED')
    expect(estimates.estimates[0]).toMatchObject({ revision: 3, status: 'ACCEPTED', answeredVia: 'OFFICE', recordedById: expect.any(String) })
    const after = (await ok(desk, `/sales/repairs/${seeded.id}`)).repair
    expect(after.stages.at(-1)).toMatchObject({ to: 'APPROVED', note: 'Estimate 3 accepted by the customer (recorded by the office: By phone, 12 November).' })
    expect((await events('repair_estimate.withdrawn')).some((payload) => payload.estimateId === sent.id || payload.revision === 1)).toBe(true)
  })
})

describe('the history of a garment and an alteration that keeps its safety check (SAL-391, SAL-393)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists every repair of a serial with its estimate (price by grain); a role without prices sees no amount', async () => {
    const history = await ok(desk, '/sales/repairs/history?serial=SEED-SN-0001')
    expect(history.garment).toMatchObject({ serial: 'SEED-SN-0001', madeOn: expect.any(String) })
    expect(history.repairs.map((row: Json) => [row.number, row.channel, row.estimate?.status])).toEqual([[asked.number, 'PORTAL', 'ACCEPTED']])
    expect(history.repairs[0].estimate.amount).toBe(5350)
    expect((await ok(blind, '/sales/repairs/history?serial=SEED-SN-0001')).repairs[0].estimate.amount).toBeUndefined()
    expect((await ok(desk, '/sales/repairs/history?serial=NO-SUCH-SERIAL')).repairs).toEqual([])
  })

  it("an office alteration of a protective garment keeps the check and names the rule; the work wanted is its own column", async () => {
    const made = await done(await post(desk, '/sales/repairs', { companyId: companyA, partyId: P1, kind: 'ALTERATION', serial: 'SEED-SN-0002', problem: 'Sleeves too long for the rider.', workWanted: 'Shorten both sleeves by 2 cm.' }), 201)
    expect(made.repair).toMatchObject({ kind: 'ALTERATION', stage: 'AWAITING_GOODS', safety: { required: true } })
    const intake = (await ok(desk, `/sales/repairs/${made.repair.id}/intake`)).intake
    expect(intake).toMatchObject({ repair: { channel: 'OFFICE', kind: 'ALTERATION' }, workWanted: 'Shorten both sleeves by 2 cm.', garment: { garmentSerial: 'SEED-SN-0002' }, photosNeeded: 0, cover: { required: true } })
    expect(intake.cover.words).toMatch(/^An alteration of a protective garment keeps its safety check/)
    const changed = await done(await send(desk, 'PATCH', `/sales/repairs/${made.repair.id}`, { version: made.repair.version, workWanted: 'Shorten both sleeves by 3 cm.' }))
    expect(changed.repair.version).toBe(made.repair.version + 1)
    expect((await ok(desk, `/sales/repairs/${made.repair.id}/intake`)).intake.workWanted).toBe('Shorten both sleeves by 3 cm.')
  })
})

describe('a repair by the claim link, with its photos (RR1:01)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let token = ''
  let repairId = ''

  it('offers the repair on the claim link; a request that cannot go uses nothing; one that can is a repair channel LINK', async () => {
    const shipmentId = (await one<{ id: string }>(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = 'SEED-SH-0001'`, [T])).id
    const made = await done(await post(desk, '/sales/claim-links', { recordType: 'Shipment', recordId: shipmentId, email: 'claims@seed-racing.example', send: false }), 201)
    token = tokenOf(made.url)
    const page = (await linkCall(token, 'GET', '/link/claim/repair')).json() as Json
    expect(page).toMatchObject({ offered: true, kinds: ['REPAIR', 'ALTERATION'], repairs: [], photos: { max: 10, damage: 2 } })
    const claim = (await linkCall(token, 'GET', '/link/claim?language=en')).json() as Json
    const item = claim.items.find((entry: Json) => entry.salesOrderLineId)
    const before = await one<{ uses: number }>('SELECT uses FROM "OneOffLink" WHERE id = $1', [made.link.id])
    // REFUSED: an alteration without the work wanted (400), and nothing used.
    const refused = await linkCall(token, 'POST', '/link/claim/repair', { kind: 'ALTERATION', salesOrderLineId: item.salesOrderLineId })
    expect(refused.statusCode, refused.body).toBe(400)
    expect((await one<{ uses: number }>('SELECT uses FROM "OneOffLink" WHERE id = $1', [made.link.id])).uses).toBe(before.uses)
    const sent = await linkCall(token, 'POST', '/link/claim/repair', { kind: 'ALTERATION', salesOrderLineId: item.salesOrderLineId, size: item.size, workWanted: 'Add 2 cm to the sleeves.', typedName: 'Carla Claims' })
    expect(sent.statusCode, sent.body).toBe(201)
    const answer = sent.json() as Json
    repairId = answer.sent.id
    expect(answer.repairs.map((row: Json) => [row.id, row.kind, row.channel, row.next.code])).toEqual([[repairId, 'ALTERATION', 'LINK', 'SEND_GARMENT']])
    expect(answer.link.usesLeft).toBeGreaterThanOrEqual(0)
    expect((await one<{ uses: number }>('SELECT uses FROM "OneOffLink" WHERE id = $1', [made.link.id])).uses).toBe(before.uses + 1)
    expect(await one('SELECT channel::text, "createdById", "workWanted", problem FROM "RepairOrder" WHERE id = $1', [repairId])).toEqual({ channel: 'LINK', createdById: null, workWanted: 'Add 2 cm to the sleeves.', problem: 'Add 2 cm to the sleeves.' })
    expect((await events('repair_request.sent')).find((payload) => payload.repairId === repairId)).toMatchObject({ via: 'LINK', kind: 'ALTERATION' })
  })

  it('takes a photo of the repair it opened; its record by link has no price; another repair is not found by this link', async () => {
    await sendPhoto(
      () => linkCall(token, 'POST', '/link/claim/repair/photos', { repairId, ...photoBody('fit.jpg') }).then((answer) => ({ status: answer.statusCode, body: answer.json() as Json })),
      (fileId) => linkCall(token, 'POST', `/link/claim/repair/photos/${fileId}/complete`).then((answer) => ({ status: answer.statusCode, body: answer.json() as Json })),
    )
    const record = (await linkCall(token, 'GET', `/link/claim/repair/${repairId}`)).json() as Json
    expect(record.repair).toMatchObject({ kind: 'ALTERATION', photos: [{ name: 'fit.jpg' }], estimate: null })
    expect((await linkCall(token, 'GET', `/link/claim/repair/${asked.id}`)).statusCode).toBe(404)
    // The portal reads the same repair (one customer, two doors).
    expect((await ok(browsers.buyer, '/portal/repairs')).items.map((row: Json) => row.id)).toEqual(expect.arrayContaining([repairId, asked.id]))
  })
})
