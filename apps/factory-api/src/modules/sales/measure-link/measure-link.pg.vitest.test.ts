import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPortalSales, type PortalSalesSeed } from '../../../../../../packages/factory-db/seed/portal-sales'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { runPhotoRetention } from './retention'
import { revisionIdFor } from './store'

/**
 * Measurements by link on the local stack (B-W2b-171; SAL-096, SAL-286), through the real app and real link tokens: the
 * factory-db seeds up to the customer portal schema (P1's team rider, JACKET revision 1 typed by the office and revision 2
 * sent through a seeded MEASUREMENTS link with three photos; company A's public notice in force, company B without one;
 * the JACKET template's chest, waist and sleeve), an office person of sales, a viewer without the measurement rights.
 * Every name, number and address is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/measure-link`.
 */

let h: Harness
const NS = 'measure-link-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const companyB = seedUuid(NS, 'company:B')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
let seeded: PortalSalesSeed

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)

let keyCount = 0
const key = () => `w2b171-${process.pid}-${++keyCount}-${Date.now()}`
const linkCall = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, idempotencyKey = key()) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0', ...(method !== 'GET' ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')
const issues = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => issue.path)

const SALES: Permission[] = ['sales.measurements.view', 'sales.measurements.manage', 'files.read']
let office: Browser
let viewer: Browser
const post = (browser: Browser, url: string, body: unknown = {}) => browser.post(url, body, { headers: { 'idempotency-key': key() } })

/** A made-up photo without location data: JFIF, then the image. */
function photo(seed: string): Buffer {
  const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]
  const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
  return Buffer.from([0xff, 0xd8, ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]), ...segment(0xfe, ascii(`made-up ${seed}`)), ...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd9])
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function sendPhoto(token: string, view: 'FRONT' | 'SIDE' | 'BACK', seed: string = view): Promise<string> {
  const bytes = photo(seed)
  const announced = await linkCall(token, 'POST', '/link/measure/photos', { view, originalName: 'IMG_0001.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) })
  expect(announced.statusCode, announced.body).toBe(201)
  const answer = announced.json() as Json
  const put = await h.app.inject({ method: 'PUT', url: answer.upload.url, headers: answer.upload.headers, payload: bytes })
  expect(put.statusCode, put.body).toBeLessThan(300)
  const done = await linkCall(token, 'POST', `/link/measure/photos/${answer.file.id}/complete`)
  expect(done.statusCode, done.body).toBe(200)
  expect((done.json() as Json).file).toMatchObject({ status: 'AVAILABLE', view })
  return answer.file.id as string
}

const form = (photos: Json, noticeId: string) => ({
  units: 'cm',
  basics: { height: '178', weight: '74', age: '34' },
  values: { chest: '140', waist: '86', sleeve: '64,5' },
  fit: { fit: 'SNUG', posture: 'Racing crouch, long reach.', asymmetry: '' },
  photos,
  noticeId,
  typedName: 'Seed Team Rider',
})

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

beforeAll(async () => {
  h = await startHarness('measure_link')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  seeded = await seedPortalSales({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
  })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, 'mtm-desk-171', 'MTM desk (test)', $3, false)`, [newId(), T, ['home.view', ...SALES]])
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, 'mtm-viewer-171', 'Orders viewer (test)', $3, false)`, [newId(), T, ['home.view', 'orders.view']])
  await addUser(h, tenant, { email: 'mara.mtm.171@example.com', role: 'mtm-desk-171' })
  await addUser(h, tenant, { email: 'vera.viewer.171@example.com', role: 'mtm-viewer-171' })
  office = new Browser(h.app)
  expect((await office.signIn(NS, 'mara.mtm.171@example.com', 'quiet-harbour-lantern-58')).status).toBe(200)
  viewer = new Browser(h.app)
  expect((await viewer.signIn(NS, 'vera.viewer.171@example.com', 'quiet-harbour-lantern-58')).status).toBe(200)
}, 300_000)

afterAll(async () => {
  await h?.close()
})

let token = ''
let linkId = ''
let noticeId = ''
let front = ''
let retake = ''
let side = ''
let back = ''

describe('the office makes a measurement link', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('makes a MEASUREMENTS link for the rider’s latest revision, photos required, the address once', async () => {
    const rev1 = seedUuid(NS, 'measurement:P1:rider:JACKET:1')
    const made = await post(office, '/sales/measure-links', { profileId: rev1, companyId: companyA, send: false, photos: 'REQUIRED', email: 'rider@seed-racing.example' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.link).toMatchObject({ purpose: 'MEASUREMENTS', profileId: seeded.profileId, photos: 'REQUIRED', email: 'rider@seed-racing.example' })
    expect(made.body.url).toMatch(/\/l#token=/)
    token = tokenOf(made.body.url)
    linkId = made.body.link.id
    const row = await one(`SELECT "recordType", "recordId", "maxUses", "companyId" FROM "OneOffLink" WHERE id = $1`, [linkId])
    expect(row).toMatchObject({ recordType: 'MeasurementProfile', recordId: seeded.profileId, maxUses: 1, companyId: companyA })
    expect((await events('measure_link.sent')).at(-1)).toMatchObject({ linkId, profileId: seeded.profileId, mailed: false, photos: 'REQUIRED' })
  })

  it('REFUSES a company without a public privacy notice, a line not made to measure, and a person without the right', async () => {
    const refused = await post(office, '/sales/measure-links', { profileId: seeded.profileId, companyId: companyB, send: false })
    expect(refused.status).toBe(409)
    expect(issues(refused.body)).toContain('refusal/NO_NOTICE')
    const line = await one<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "tenantId" = $1 AND "measurementProfileId" IS NULL LIMIT 1`, [T])
    expect((await post(office, '/sales/measure-links', { salesOrderLineId: line.id, send: false })).status).toBe(409)
    expect((await post(office, '/sales/measure-links', { profileId: seeded.profileId, send: false })).status).toBe(400)
    expect((await post(viewer, '/sales/measure-links', { profileId: seeded.profileId, companyId: companyA, send: false })).status).toBe(403)
  })
})

describe('the rider sends measurements', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('opens the page: the notice in force not yet ticked, the points by zone, photos required; reading uses nothing', async () => {
    const answer = await linkCall(token, 'GET', '/link/measure?language=en')
    expect(answer.statusCode, answer.body).toBe(200)
    const page = answer.json() as Json
    expect(page).toMatchObject({ rider: { name: 'Seed Team Rider' }, garment: { code: 'JACKET' }, photos: 'REQUIRED', noticeRead: null, locale: 'en', sender: { companyId: companyA } })
    expect(page.notice.id).toBe(seeded.publicNoticeId)
    expect(page.points.map((point: Json) => [point.code, point.zone, point.required])).toEqual([
      ['chest', 'UPPER', true],
      ['waist', 'UPPER', true],
      ['sleeve', 'ARMS', true],
    ])
    expect(page.points[0]).toMatchObject({ minCm: '70.00', maxCm: '150.00' })
    noticeId = page.notice.id
    expect((await one(`SELECT uses FROM "OneOffLink" WHERE id = $1`, [linkId])).uses).toBe(0)
  })

  it('REFUSES a photo before the notice is ticked; the tick of another version; then keeps the tick with its time', async () => {
    const bytes = photo('early')
    const early = await linkCall(token, 'POST', '/link/measure/photos', { view: 'FRONT', originalName: 'a.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) })
    expect(early.statusCode).toBe(409)
    expect(issues(early.json())).toContain('refusal/NOTICE_FIRST')
    const wrong = await linkCall(token, 'POST', '/link/measure/notice', { noticeId: newId() })
    expect(issues(wrong.json())).toContain('refusal/NOTICE_CHANGED')
    const tick = await linkCall(token, 'POST', '/link/measure/notice', { noticeId })
    expect(tick.statusCode, tick.body).toBe(200)
    const again = await linkCall(token, 'POST', '/link/measure/notice', { noticeId })
    expect((again.json() as Json).noticeRead.at).toBe((tick.json() as Json).noticeRead.at)
    expect(((await linkCall(token, 'GET', '/link/measure')).json() as Json).noticeRead).toMatchObject({ noticeId })
  })

  it('keeps the draft with us and the photos on the revision to come; REFUSES a HEIC', async () => {
    const saved = await linkCall(token, 'PUT', '/link/draft', { data: { step: 'points', form: { units: 'cm', values: { chest: '101' } } } })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(((await linkCall(token, 'GET', '/link/draft')).json() as Json).draft.data).toMatchObject({ step: 'points' })
    const heic = await linkCall(token, 'POST', '/link/measure/photos', { view: 'SIDE', originalName: 'b.heic', contentType: 'image/heic', sizeBytes: 100, sha256: sha(photo('heic')) })
    expect(heic.statusCode).toBe(400)
    expect(issues(heic.json())).toContain('body/contentType')
    front = await sendPhoto(token, 'FRONT', 'front-1')
    retake = front
    front = await sendPhoto(token, 'FRONT', 'front-2')
    side = await sendPhoto(token, 'SIDE')
    back = await sendPhoto(token, 'BACK')
    const file = await one(`SELECT "recordType", "recordId", category, visibility, "partyId", "originalName" FROM "StoredFile" WHERE id = $1`, [front])
    expect(file).toMatchObject({ recordType: 'MeasurementProfile', recordId: revisionIdFor(linkId), category: 'BODY_PHOTO', partyId: seeded.partyId, originalName: 'measurements-front.jpg' })
    const preview = await linkCall(token, 'GET', `/link/measure/photos/${front}/preview`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect((preview.json() as Json).preview.method).toBe('GET')
    // The generic files routes never reach a body photo (module-read files).
    expect((await office.get(`/files/${front}`)).status).toBe(404)
  })

  it('REFUSES a send that misses a required point or photo, in words at the field; nothing is used', async () => {
    const answer = await linkCall(token, 'POST', '/link/measure', { ...form({ FRONT: front, SIDE: side }, noticeId), values: { chest: '140', waist: '' , sleeve: '64.5' } })
    expect(answer.statusCode).toBe(400)
    expect(issues(answer.json())).toEqual(['body/values/waist', 'body/photos/BACK'])
    expect((await one(`SELECT uses FROM "OneOffLink" WHERE id = $1`, [linkId])).uses).toBe(0)
    const foreign = await linkCall(token, 'POST', '/link/measure', form({ FRONT: front, SIDE: side, BACK: seeded.photoIds[2] }, noticeId))
    expect(issues(foreign.json())).toEqual(['body/photos/BACK'])
  })

  it('sends: a new revision by the link session itself, the use and its evidence, the draft gone, the retake deleted', async () => {
    const idempotencyKey = key()
    const answer = await linkCall(token, 'POST', '/link/measure', form({ FRONT: front, SIDE: side, BACK: back }, noticeId), idempotencyKey)
    expect(answer.statusCode, answer.body).toBe(201)
    const sent = (answer.json() as Json).sent
    expect(sent).toMatchObject({ profileId: revisionIdFor(linkId), revision: 3, photos: 3 })
    // A MEASUREMENTS link has one use: once sent it opens nothing, a repeat of the same send included (the uniform 404).
    const replay = await linkCall(token, 'POST', '/link/measure', form({ FRONT: front, SIDE: side, BACK: back }, noticeId), idempotencyKey)
    expect(replay.statusCode).toBe(404)
    const row = await one(`SELECT revision, "supersedesId", measurements, "fitNotes", "submittedViaLinkId", "noticeVersionId", "privacyNoticeRef", "privacyNoticeAt" <= "submittedAt" AS "noticeFirst", "photoFrontFileId", "takenBy", "createdById", "photosDeleteAfter" FROM "MeasurementProfile" WHERE id = $1`, [sent.profileId])
    expect(row).toMatchObject({ revision: 3, supersedesId: seeded.profileId, submittedViaLinkId: linkId, noticeVersionId: noticeId, privacyNoticeRef: '2026-10', noticeFirst: true, photoFrontFileId: front, takenBy: 'Seed Team Rider (by link)', createdById: null, photosDeleteAfter: null })
    expect(row.measurements).toEqual({ chest: { value: '140', unit: 'cm' }, waist: { value: '86', unit: 'cm' }, sleeve: { value: '64.5', unit: 'cm' }, height: { value: '178', unit: 'cm' }, weight: { value: '74', unit: 'kg' } })
    expect(row.fitNotes).toContain('Fit: snug.')
    expect(await one(`SELECT uses FROM "OneOffLink" WHERE id = $1`, [linkId])).toMatchObject({ uses: 1 })
    expect(await one(`SELECT action, "useNumber", "typedName" FROM "LinkEvidence" WHERE "linkId" = $1 AND action = 'SUBMITTED'`, [linkId])).toMatchObject({ useNumber: 1, typedName: 'Seed Team Rider' })
    expect((await admin(`SELECT id FROM "LinkDraft" WHERE "linkId" = $1`, [linkId])).length).toBe(0)
    expect((await events('measurements.submitted')).at(-1)).toMatchObject({ profileId: sent.profileId, supersedesId: seeded.profileId, revision: 3, photos: 3 })
    expect((await one(`SELECT status FROM "StoredFile" WHERE id = $1`, [retake])).status).toBe('DELETED')
    // The link is used: it opens nothing any more.
    expect((await linkCall(token, 'GET', '/link/measure')).statusCode).toBe(404)
  })
})

describe('the office sees who sent what, and the photos go', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists the revisions sent by link with the link, the notice and the photos; opens one, recorded', async () => {
    const sent = await office.get(`/sales/measurement-profiles/${seeded.profileId}/sent`)
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(sent.body.profile).toMatchObject({ riderName: 'Seed Team Rider', latestRevision: 3 })
    const mine = sent.body.revisions[0]
    expect(mine).toMatchObject({ revision: 3, link: { id: linkId, email: 'rider@seed-racing.example' }, notice: { id: noticeId, label: '2026-10' } })
    expect(mine.photos.map((p: Json) => [p.view, p.status])).toEqual([['FRONT', 'AVAILABLE'], ['SIDE', 'AVAILABLE'], ['BACK', 'AVAILABLE']])
    expect(sent.body.links.find((link: Json) => link.id === linkId)).toMatchObject({ uses: 1, photos: 'REQUIRED' })
    const opened = await post(office, `/sales/measurement-profiles/${mine.id}/photos/${side}/open`)
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body.file).toMatchObject({ id: side, view: 'SIDE' })
    expect((await admin(`SELECT id FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'measureLink.openPhoto' AND "recordId" = $2`, [T, side])).length).toBe(1)
    expect((await viewer.get(`/sales/measurement-profiles/${seeded.profileId}/sent`)).status).toBe(403)
  })

  it('sets the day the photos go; the hourly job deletes them when it passes and keeps the numbers', async () => {
    const profileId = revisionIdFor(linkId)
    const day = new Date(h.clock.now().getTime() + 3_600_000).toISOString()
    const set = await post(office, `/sales/measurement-profiles/${profileId}/photos-delete-after`, { deleteAfter: day, reason: 'The rider asked (made up).' })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    expect((await runPhotoRetention({ database: h.database, log: quiet, clock: h.clock })).deleted).toBe(0)
    h.clock.advance(2 * 3_600_000)
    const tick = await runPhotoRetention({ database: h.database, log: quiet, clock: h.clock })
    expect(tick.deleted).toBeGreaterThanOrEqual(3)
    const files = await admin<{ status: string }>(`SELECT status FROM "StoredFile" WHERE id = ANY($1::uuid[])`, [[front, side, back]])
    expect(files.map((file) => file.status)).toEqual(['DELETED', 'DELETED', 'DELETED'])
    const row = await one(`SELECT measurements, "photoFrontFileId" FROM "MeasurementProfile" WHERE id = $1`, [profileId])
    expect(row.photoFrontFileId).toBe(front)
    expect(row.measurements.chest).toEqual({ value: '140', unit: 'cm' })
    expect((await events('measurement_photos.deleted')).find((event) => event.profileId === profileId)).toMatchObject({ files: 3 })
  })

  it('REFUSES clearing the day (the database moves it, never clears it)', async () => {
    await expect(admin(`UPDATE "MeasurementProfile" SET "photosDeleteAfter" = NULL WHERE id = $1`, [revisionIdFor(linkId)])).rejects.toThrow(/moved, never cleared/)
  })
})
