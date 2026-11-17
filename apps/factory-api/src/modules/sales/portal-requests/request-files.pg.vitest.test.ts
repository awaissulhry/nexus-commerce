import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { PORTAL_UPLOAD_WORDS } from '@nexus/factory-domain/threads/partner/uploads'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { PAGE_TYPE_WORDS } from '../../../platform/files/rules'
import { useScanner } from '../../../platform/files/scan/service'
import { declineInquiry } from '../inquiries/inquiries'

/**
 * B-TH-085 (threads plan TH-7, the rest of G1; P-CUS-NEW.files, T6-F01…F08, X-P-CUS-REQ.thread; walls W25 / T25 and W37 / T37; Owner
 * rule 2026-11-16: "One brand must not be able to see anything related to any other brand") on the local stack, through the real
 * app and the real portal sign-in by code, every factory-db seed: customer A = SEED-C1 (P1, its orders and the INQUIRY series of
 * company A), customer B = SEED-C2 (P3), each with its portal and a buyer who may upload; A also has a buyer without the upload
 * capability.
 *
 *   - after Send, A's request takes a photo and a ticked measurement sheet (shared with A only, the sheet filed MEASUREMENTS), and one
 *     message of A carries them into the request's thread; the composer of A's order takes a file the same way;
 *   - T25 / T37: B never announces, completes, attaches, lists or opens a file of A's request or order — by any route: not found;
 *   - refused in words: no upload capability (403 refusal/NO_UPLOAD), an SVG (400, "send a PDF or PNG"), a request the office already
 *     decided (409 refusal/REQUEST_CLOSED);
 *   - uploads stay closed on staging without the virus scanner (ClamAV): the announce answers the sentence (503), and the portal says
 *     it before a file is dropped (GET /portal/inquiries/open `files`, the thread composer's `uploads`).
 * Every name, address and figure is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-requests/request-files`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'request-files-th085'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const partyA = seedUuid(NS, 'party:P1')
const partyB = seedUuid(NS, 'party:P3')
const CLOSED_WORDS = 'Uploads from outside are closed for now: the virus scanner is not running here yet. Please send the file to your contact by e-mail.'

let h: Harness
const people = { aBuyer: 'anna.buyer.th085@brand-alpha.example', aViewer: 'aldo.viewer.th085@brand-alpha.example', bBuyer: 'bruna.buyer.th085@brand-beta.example' }
const ids = {} as Record<keyof typeof people, string>
const browsers = {} as Record<keyof typeof people, Browser>
const ADA = newId()
const sales = templateOf('sales')!
const office = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: ADA, requestId: newId(), grants: [{ permissions: [...sales.permissions, ...sales.grains.map((grain) => `money.${grain}`)] as Permission[], companies: 'all', sites: 'all', parties: 'all' }] })
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let serial = 0
const call = (who: keyof typeof people, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Answer> =>
  browsers[who].send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), method === 'GET' ? {} : { headers: { 'idempotency-key': `th085-${++serial}` } })
async function ok(who: keyof typeof people, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(who, method, url, body)
  expect(answer.status, `${who} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
const issuesOf = (answer: Answer): Json[] => answer.body?.error?.issues ?? []
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.4\n% made-up file of the TH-7 test: ${text}\n%%EOF\n`)
const png = (text: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`made-up picture: ${text}`)])
const meta = (name: string, contentType: string, bytes: Buffer, measurementSheet?: boolean) => ({ originalName: name, contentType, sizeBytes: bytes.length, sha256: sha(bytes), ...(measurementSheet === undefined ? {} : { measurementSheet }) })

/** Announce, PUT the bytes to the local store's presigned URL, confirm: the file's id. */
async function upload(who: keyof typeof people, base: string, name: string, contentType: string, bytes: Buffer, measurementSheet?: boolean): Promise<Json> {
  const announced = await ok(who, 'POST', `${base}/files`, meta(name, contentType, bytes, measurementSheet), 201)
  expect(announced.file).toMatchObject({ originalName: name, status: 'PENDING_UPLOAD', measurementSheet: measurementSheet === true })
  const put = await h.app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })
  expect(put.statusCode, put.body).toBeLessThan(300)
  const done = await ok(who, 'POST', `${base}/files/${announced.file.id}/complete`)
  expect(done.file).toMatchObject({ id: announced.file.id, status: 'AVAILABLE' })
  return announced.file
}

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
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

/** The sentence and the 503 on staging with no scanner, for one call; FACTORY_ENV is read per call and put back. */
async function onStaging<R>(work: () => Promise<R>): Promise<R> {
  const before = process.env.FACTORY_ENV
  useScanner(null)
  process.env.FACTORY_ENV = 'staging'
  try {
    return await work()
  } finally {
    if (before === undefined) delete process.env.FACTORY_ENV
    else process.env.FACTORY_ENV = before
    useScanner(undefined)
  }
}

const G = {} as Record<string, any>

beforeAll(async () => {
  h = await startHarness('request_files_th085')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    for (const party of [partyA, partyB]) await client.portalSettings.upsert({ where: { id: party }, create: { id: party, partyId: party, portalOn: true }, update: { portalOn: true }, select: { id: true } })
    const salesRole = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'sales' } }, select: { id: true } })
    await client.user.create({ data: { id: ADA, email: 'ada.sales.th085@example.com', displayName: 'Made-up Ada', locale: 'en', status: 'ACTIVE' }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: ADA, roleId: salesRole.id, allCompanies: true, validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  freshGuard(h)
  ids.aBuyer = await partnerPerson(people.aBuyer, partyA, ['customer-buyer', 'partner-comment', 'partner-upload'])
  ids.aViewer = await partnerPerson(people.aViewer, partyA, ['customer-buyer', 'partner-comment'])
  ids.bBuyer = await partnerPerson(people.bBuyer, partyB, ['customer-buyer', 'partner-comment', 'partner-upload'])
  for (const who of Object.keys(people) as (keyof typeof people)[]) browsers[who] = await signedIn(people[who])
  G.order = (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 ORDER BY number LIMIT 1', [T, partyA, companyA]))[0]!.id
  h.clock.set(new Date(Date.now() - 2_000))
}, 900_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useScanner(undefined)
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('B-TH-085 customers attach files after Send', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('after Send A’s request takes a photo and a ticked measurement sheet, shared with A only; one message of A carries them', async () => {
    expect((await ok('aBuyer', 'GET', '/portal/inquiries/open')).files).toEqual({ open: true, words: null })
    const sent = await ok('aBuyer', 'POST', '/portal/inquiries', { subject: 'Made-up: twelve team jackets', message: 'Made-up: as the sketch, sizes attached.' }, 201)
    G.request = sent.request.id
    const base = `/portal/inquiries/${G.request}`
    const photo = await upload('aBuyer', base, 'made-up-alpha-sketch.png', 'image/png', png('alpha sketch'))
    expect(photo.kind).toBe('PHOTO')
    const sheet = await upload('aBuyer', base, 'made-up-alpha-sizes.pdf', 'application/pdf', pdf('alpha sizes'), true)
    expect(sheet).toMatchObject({ kind: 'ATTACHMENT', measurementSheet: true })
    G.photo = photo.id
    G.sheet = sheet.id
    const rows = await admin<Json>('SELECT id, "recordType", "recordId", "partyId", visibility::text[] AS visibility, category::text AS category, "createdById" FROM "StoredFile" WHERE id = ANY($1::uuid[]) ORDER BY "originalName"', [[photo.id, sheet.id]])
    expect(rows).toEqual([
      { id: photo.id, recordType: 'Inquiry', recordId: G.request, partyId: partyA, visibility: ['OFFICE', 'PARTNER'], category: null, createdById: null },
      { id: sheet.id, recordType: 'Inquiry', recordId: G.request, partyId: partyA, visibility: ['OFFICE', 'PARTNER'], category: 'MEASUREMENTS', createdById: null },
    ])
    // Who of the customer sent each: the person's own audit row.
    const audits = await admin<{ recordId: string; actorId: string }>(`SELECT "recordId", "actorId" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'portal.attachFile' AND "recordId" = ANY($2::uuid[])`, [T, [photo.id, sheet.id]])
    expect(audits.map((row) => row.actorId)).toEqual([ids.aBuyer, ids.aBuyer])
    // One message of A carries them into the request's thread, after its first words.
    const attached = await ok('aBuyer', 'POST', `${base}/files/attach`, { fileIds: [photo.id, sheet.id], body: 'Made-up: our sketch and the sizes.' }, 201)
    expect(attached.message).toMatchObject({ side: 'PARTNER', channel: 'PORTAL', author: { mine: true } })
    expect(attached.message.attachments.map((file: Json) => file.originalName)).toEqual(['made-up-alpha-sketch.png', 'made-up-alpha-sizes.pdf'])
    const listed = (await ok('aBuyer', 'GET', `/files?recordType=Inquiry&recordId=${G.request}`)).files as Json[]
    expect(listed.map((file) => file.originalName).sort()).toEqual(['made-up-alpha-sizes.pdf', 'made-up-alpha-sketch.png'])
  })

  it('the composer of A’s order takes a file the same way, and A posts it', async () => {
    const thread = await ok('aBuyer', 'GET', `/portal/threads/SalesOrder/${G.order}`)
    expect(thread.composer.uploads).toEqual({ open: true, words: null })
    const file = await upload('aBuyer', `/portal/threads/SalesOrder/${G.order}`, 'made-up-alpha-logo.pdf', 'application/pdf', pdf('alpha logo'))
    G.orderFile = file.id
    const posted = await ok('aBuyer', 'POST', `/portal/threads/SalesOrder/${G.order}/messages`, { body: 'Made-up: the logo for the back.', attachments: [file.id] }, 201)
    expect(posted.message.attachments.map((entry: Json) => entry.originalName)).toEqual(['made-up-alpha-logo.pdf'])
  })

  it('T25 / T37: customer B announces, completes, attaches, lists and opens nothing of A’s request or order — by any route: not found', async () => {
    const files = [G.photo, G.sheet, G.orderFile] as string[]
    const bytes = pdf('beta')
    for (const base of [`/portal/inquiries/${G.request}`, `/portal/threads/Inquiry/${G.request}`, `/portal/threads/SalesOrder/${G.order}`]) {
      expect((await call('bBuyer', 'POST', `${base}/files`, meta('made-up-beta.pdf', 'application/pdf', bytes))).status, base).toBe(404)
      for (const fileId of files) expect((await call('bBuyer', 'POST', `${base}/files/${fileId}/complete`)).status, `${base} ${fileId}`).toBe(404)
    }
    expect((await call('bBuyer', 'POST', `/portal/inquiries/${G.request}/files/attach`, { fileIds: [G.photo] })).status).toBe(404)
    for (const fileId of files) expect((await call('bBuyer', 'GET', `/files/${fileId}`)).status, fileId).toBe(404)
    for (const url of [`/files?recordType=Inquiry&recordId=${G.request}`, `/files?recordType=SalesOrder&recordId=${G.order}`]) {
      const answer = await call('bBuyer', 'GET', url)
      expect(JSON.stringify(answer.body)).not.toMatch(/made-up-alpha/)
    }
    // B's own request: A's file ids are not B's files (on B's own route and in B's own message).
    const own = await ok('bBuyer', 'POST', '/portal/inquiries', { message: 'Made-up: three team vests.' }, 201)
    expect((await call('bBuyer', 'POST', `/portal/inquiries/${own.request.id}/files/${G.photo}/complete`)).status).toBe(404)
    const stolen = await call('bBuyer', 'POST', `/portal/inquiries/${own.request.id}/files/attach`, { fileIds: [G.photo] })
    expect(stolen.status).toBe(400)
    expect(issuesOf(stolen)).toEqual([expect.objectContaining({ path: 'body/attachments/0', message: 'File not found.' })])
    expect(JSON.stringify(stolen.body)).not.toMatch(/made-up-alpha/)
    expect(await admin('SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "partyId" = $2 AND "recordId" = ANY($3::uuid[])', [T, partyB, [G.request, G.order]])).toEqual([])
  })

  it('refused in words: no upload capability, an SVG, a request the office already decided', async () => {
    const base = `/portal/inquiries/${G.request}`
    const viewer = await call('aViewer', 'POST', `${base}/files`, meta('made-up.pdf', 'application/pdf', pdf('viewer')))
    expect(viewer.status).toBe(403)
    expect(issuesOf(viewer)).toEqual([expect.objectContaining({ path: 'refusal/NO_UPLOAD', message: PORTAL_UPLOAD_WORDS.NO_UPLOAD.en })])
    expect((await ok('aViewer', 'GET', '/portal/inquiries/open')).files).toEqual({ open: false, words: PORTAL_UPLOAD_WORDS.NO_UPLOAD.en })
    const svg = await call('aBuyer', 'POST', `${base}/files`, meta('made-up.svg', 'image/svg+xml', Buffer.from('<svg/>')))
    expect(svg.status).toBe(400)
    expect(issuesOf(svg).map((issue) => issue.message)).toContain(PAGE_TYPE_WORDS)
    // The office declines it: the request takes no more files (its messages still do).
    const sent = await ok('aBuyer', 'POST', '/portal/inquiries', { message: 'Made-up: a request we decline.' }, 201)
    const version = (await admin<{ version: number }>('SELECT version FROM "Inquiry" WHERE id = $1', [sent.request.id]))[0]!.version
    await declineInquiry(office(), sent.request.id, { version, reason: 'CAPACITY' }, `th085-decline-${newId()}`)
    const closed = await call('aBuyer', 'POST', `/portal/inquiries/${sent.request.id}/files`, meta('made-up-late.pdf', 'application/pdf', pdf('late')))
    expect(closed.status).toBe(409)
    expect(issuesOf(closed)).toEqual([expect.objectContaining({ path: 'refusal/REQUEST_CLOSED', message: PORTAL_UPLOAD_WORDS.REQUEST_CLOSED.en })])
  })

  it('uploads stay closed on staging without the virus scanner: the sentence (503), said before a file is dropped', async () => {
    const before = await admin<{ n: number }>('SELECT count(*)::int AS n FROM "StoredFile" WHERE "tenantId" = $1 AND "recordId" = $2', [T, G.request])
    await onStaging(async () => {
      const refused = await call('aBuyer', 'POST', `/portal/inquiries/${G.request}/files`, meta('made-up-staging.pdf', 'application/pdf', pdf('staging')))
      expect(refused.status).toBe(503)
      expect(refused.body.error.message).toBe(CLOSED_WORDS)
      const order = await call('aBuyer', 'POST', `/portal/threads/SalesOrder/${G.order}/files`, meta('made-up-staging.pdf', 'application/pdf', pdf('staging')))
      expect(order.status).toBe(503)
      expect((await ok('aBuyer', 'GET', '/portal/inquiries/open')).files).toEqual({ open: false, words: CLOSED_WORDS })
      expect((await ok('aBuyer', 'GET', `/portal/threads/SalesOrder/${G.order}`)).composer.uploads).toEqual({ open: false, words: CLOSED_WORDS })
    })
    expect(await admin<{ n: number }>('SELECT count(*)::int AS n FROM "StoredFile" WHERE "tenantId" = $1 AND "recordId" = $2', [T, G.request])).toEqual(before)
  })
})
