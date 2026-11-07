import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Proofs signed with the quote (B-W2b-165; SAL-199; design links.quote "Proofs you accept with it") on the local stack: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime logins: row-level security, the column grants, the
 * files and sales triggers are real), the real office sign-in and the real one-off link authenticator (the customer's
 * browser carries only the link's token), the local file store, the FAKE SES mailbox (the only place a token exists),
 * and a second app with test sessions for the walls. The seeds' customer P1 and its jacket in BLK; every name, price and
 * file made up (a few bytes of "PDF", a phone photo built byte by byte with a made-up position in its EXIF).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/quote-proofs`.
 */

let h: Harness
let walls: FastifyInstance
let sales: Browser

const NS = 'quote-proofs'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const P1 = seedId('party:P1')
const jacket = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')
const BUYER = 'buyer.p1@example.com'
const FAKE_VAT = '12345670009'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `qp-${label}-${++counter}-${newId()}`
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up proof: ${text}`)

// A made-up phone photo: JFIF, EXIF with the orientation and a GPS block, XMP with a position, a comment, then the image.
const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]
function phonePhoto(): Buffer {
  const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x02, 0x00]
  tiff.push(0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00)
  tiff.push(0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...ascii('GPS 45.4642N 9.1900E'))
  return Buffer.from([
    0xff, 0xd8,
    ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xe1, [...ascii('Exif\0\0'), ...tiff]),
    ...segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/\0'), ...ascii('<exif:GPSLatitude>45,27.85N</exif:GPSLatitude>')]),
    ...segment(0xfe, ascii('made-up phone 12')),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    0x11, 0x22, 0xff, 0x00, 0x33,
    0xff, 0xd9,
  ])
}

async function as(browser: Browser, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key(method) } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

/** A request of the customer's browser: only the link's token. */
async function link(token: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = await h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'Mozilla/5.0 (Customer test browser)', ...(method === 'POST' ? { 'idempotency-key': key('link') } : {}) }, ...(body === undefined ? {} : { payload: body as object }) })
  const type = String(response.headers['content-type'] ?? '')
  return { status: response.statusCode, body: type.startsWith('application/json') ? (response.json() as Json) : null, raw: response.rawPayload, type }
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  viewer: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['quotes.view', 'money.price'])] }),
  companyB: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['quotes.view', 'quotes.manage', 'files.upload', 'orders.view'], [companyB])] }),
  noFiles: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['quotes.view', 'quotes.manage'])] }),
  planner: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['workorders.view', 'workorders.manage', 'orders.view', 'files.read'])] }),
  partner: () => ({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: P1, grants: [{ permissions: ['quotes.view', 'quotes.manage', 'money.price'], companies: 'all', sites: 'all', parties: [P1] }] }),
}
const wall = async (session: string, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) => {
  const response = await walls.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': key('wall') }, ...(method === 'GET' || body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}

const quoteUrl = (id: string) => `/sales/quotes/${id}`

/** A quote for P1 with one size-grid line. */
async function newQuote(): Promise<Json> {
  let quote = (await as(sales, 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: 'RFQ-PROOF' }, 201)).quote
  quote = (await as(sales, 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, styleId: jacket, colourwayId: BLK, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }], unitPrice: '450' }, 201)).quote
  return quote
}

/** Announce, send to the local store (and, unless told not to, confirm): the list after the confirmation. */
async function addProof(quoteId: string, name: string, body: Buffer, contentType: string, options: { readonly confirm?: boolean; readonly of?: string } = {}): Promise<{ file: Json; list: Json | null }> {
  const url = options.of ? `${quoteUrl(quoteId)}/proofs/${options.of}/versions` : `${quoteUrl(quoteId)}/proofs`
  const { file, upload } = await as(sales, 'POST', url, { originalName: name, contentType, sizeBytes: body.length, sha256: sha256(body) }, 201)
  const sent = await h.app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  if (options.confirm === false) return { file, list: null }
  return { file, list: await as(sales, 'POST', `${quoteUrl(quoteId)}/proofs/${file.id}/complete`) }
}

async function send(quote: Json): Promise<{ answer: Json; token: string }> {
  const fresh = (await as(sales, 'GET', quoteUrl(quote.id))).quote
  const before = h.ses.mails.length
  const answer = await as(sales, 'POST', `${quoteUrl(quote.id)}/send`, { version: fresh.version })
  const mail = h.ses.mails.slice(before).find((entry) => entry.outboundId === answer.sent?.emailId)
  return { answer, token: mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : '' }
}

const current = (list: Json): Json => list.versions.find((version: Json) => version.current)

beforeAll(async () => {
  h = await startHarness('quote_proofs')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS }) // the product and parties seeds come with it
  await seedCosting({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS }) // QUOTE, SALES_ORDER and WORK_ORDER series
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'sales@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const salesUser = await addUser(h, seedTenant, { email: 'sara.sales@seed-a.example.com', role: 'sales' })
  sales = new Browser(h.app)
  expect((await sales.signIn(NS, salesUser.email, salesUser.password)).status).toBe(200)
  await enrolTotp(h, sales)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

let quote: Json
let artwork: Json
let artworkV2: Json
let photo: Json
let token: string
const ARTWORK_V1 = pdf('artwork proof, logo on the chest, first try')
const ARTWORK_V2 = pdf('artwork proof, logo on the chest, smaller')
const PHOTO = phonePhoto()

describe('the office attaches proofs to the unsent version (SAL-199)', () => {
  it('lists none at first, and the sales role may add them', async () => {
    quote = await newQuote()
    const list = await as(sales, 'GET', `${quoteUrl(quote.id)}/proofs`)
    expect(list).toMatchObject({ quoteId: quote.id, may: { change: true, held: null }, carry: null, limits: { max: 12, contentTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] } })
    expect(list.versions).toEqual([expect.objectContaining({ revision: 1, status: 'DRAFT', current: true, frozen: null, proofs: [], accepted: null })])
  })

  it('adds a PDF and a phone photo: the office’s files of the version (category PROOF), ready, not shared yet; quote.proofs_changed', async () => {
    const first = await addProof(quote.id, 'Artwork proof.pdf', ARTWORK_V1, 'application/pdf')
    artwork = first.file
    const second = await addProof(quote.id, 'Size chart.jpg', PHOTO, 'image/jpeg')
    photo = second.file
    const proofs = current(second.list!).proofs
    expect(proofs.map((proof: Json) => [proof.name, proof.shape, proof.state, proof.versionNo, proof.sharedWithCustomer])).toEqual([
      ['Artwork proof.pdf', 'PDF', 'READY', 1, false],
      ['Size chart.jpg', 'PICTURE', 'READY', 1, false],
    ])
    expect(proofs[0].addedBy).toEqual(expect.any(String))
    const rows = await admin('SELECT kind, category, "recordType", "recordId", visibility::text[] AS visibility, "partyId", "retainUntil" FROM "StoredFile" WHERE id = ANY($1::uuid[]) ORDER BY "createdAt"', [[artwork.id, photo.id]])
    expect(rows).toEqual([
      { kind: 'DOCUMENT', category: 'PROOF', recordType: 'QuoteVersion', recordId: quote.current.id, visibility: ['OFFICE'], partyId: null, retainUntil: null },
      { kind: 'PHOTO', category: 'PROOF', recordType: 'QuoteVersion', recordId: quote.current.id, visibility: ['OFFICE'], partyId: null, retainUntil: null },
    ])
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'quote.proofs_changed' AND subject = $1 ORDER BY "occurredAt", id`, [quote.id])
    expect(events.map((event) => [event.payload.change, event.payload.fileIds])).toEqual([['added', [artwork.id]], ['added', [photo.id]]])
  })

  it('gives the artwork a new version (B-W2b-160 series): version 2 current, version 1 superseded', async () => {
    const next = await addProof(quote.id, 'Artwork proof v2.pdf', ARTWORK_V2, 'application/pdf', { of: artwork.id })
    artworkV2 = next.file
    const proofs = current(next.list!).proofs
    expect(proofs.map((proof: Json) => [proof.name, proof.versionNo, proof.seriesId, proof.currentFileId])).toEqual([
      ['Artwork proof v2.pdf', 2, artwork.id, artworkV2.id],
      ['Size chart.jpg', 1, photo.id, photo.id],
    ])
    expect((await one('SELECT "supersededAt" IS NOT NULL AS superseded FROM "StoredFile" WHERE id = $1', [artwork.id])).superseded).toBe(true)
  })

  it('refuses what is not a proof, a picture as the next version of a PDF, and the generic files routes (owned by the module)', async () => {
    const heic = Buffer.from('made-up heic')
    const refused = await sales.send('POST', `${quoteUrl(quote.id)}/proofs`, { originalName: 'phone.heic', contentType: 'image/heic', sizeBytes: heic.length, sha256: sha256(heic) }, { headers: { 'idempotency-key': key() } })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(refused.body)).toContain('A proof is a PDF or a picture')
    const picture = await sales.send('POST', `${quoteUrl(quote.id)}/proofs/${artworkV2.id}/versions`, { originalName: 'chest.jpg', contentType: 'image/jpeg', sizeBytes: PHOTO.length, sha256: sha256(PHOTO) }, { headers: { 'idempotency-key': key() } })
    expect(picture.status).toBe(400)
    const generic = await sales.send('POST', '/files', { companyId: companyA, recordType: 'QuoteVersion', recordId: quote.current.id, kind: 'DOCUMENT', originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 5, sha256: sha256(Buffer.from('%PDF-')) }, { headers: { 'idempotency-key': key() } })
    expect(generic.status).toBe(409)
    expect(JSON.stringify(generic.body)).toContain('/sales/quotes/:quoteId/proofs')
  })

  it('walls: a reader sees them with the reason it may not change them; another company or a partner does not see the quote', async () => {
    const viewer = await wall('viewer', 'GET', `${quoteUrl(quote.id)}/proofs`)
    expect(viewer.status).toBe(200)
    expect(viewer.body.may).toEqual({ change: false, held: 'Changing proofs needs quotes.manage for this customer.' })
    expect((await wall('viewer', 'DELETE', `${quoteUrl(quote.id)}/proofs/${photo.id}`)).status).toBe(403)
    const noFiles = await wall('noFiles', 'POST', `${quoteUrl(quote.id)}/proofs`, { originalName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 5, sha256: sha256(Buffer.from('%PDF-')) })
    expect(noFiles.status).toBe(403)
    expect((await wall('companyB', 'GET', `${quoteUrl(quote.id)}/proofs`)).status).toBe(404)
    expect((await wall('partner', 'GET', `${quoteUrl(quote.id)}/proofs`)).status).toBe(403)
  })
})

describe('the send freezes the proofs with the version', () => {
  it('a proof still uploading blocks the send (PROOF_NOT_READY, in words); removing it clears the check', async () => {
    const pending = await addProof(quote.id, 'Measurement sheet.pdf', pdf('measurement sheet'), 'application/pdf', { confirm: false })
    const check = await as(sales, 'GET', `${quoteUrl(quote.id)}/send-check`)
    expect(check.ready).toBe(false)
    expect(check.checks).toContainEqual(expect.objectContaining({ code: 'PROOF_NOT_READY', severity: 'BLOCKS', path: `proofs/${pending.file.id}`, message: 'The proof "Measurement sheet.pdf" is still uploading: finish it or remove it.' }))
    const fresh = (await as(sales, 'GET', quoteUrl(quote.id))).quote
    const refused = await sales.send('POST', `${quoteUrl(quote.id)}/send`, { version: fresh.version }, { headers: { 'idempotency-key': key() } })
    expect(refused.status).toBe(409)
    const list = await as(sales, 'DELETE', `${quoteUrl(quote.id)}/proofs/${pending.file.id}`)
    expect(current(list).proofs).toHaveLength(2)
    expect((await one('SELECT status FROM "StoredFile" WHERE id = $1', [pending.file.id])).status).toBe('DELETED')
    expect((await as(sales, 'GET', `${quoteUrl(quote.id)}/send-check`)).ready).toBe(true)
  })

  it('the send shares each current proof with the customer (portal and link of P1) and keeps it ten years; the earlier version stays the office’s', async () => {
    const sent = await send(quote)
    token = sent.token
    expect(token).not.toBe('')
    const rows = await admin<Json>('SELECT id, visibility::text[] AS visibility, "partyId", "retainUntil" FROM "StoredFile" WHERE id = ANY($1::uuid[])', [[artwork.id, artworkV2.id, photo.id]])
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (const id of [artworkV2.id, photo.id]) {
      expect(byId.get(id)).toMatchObject({ visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: P1 })
      expect(new Date(byId.get(id)!.retainUntil).getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 9)
    }
    expect(byId.get(artwork.id)).toMatchObject({ visibility: ['OFFICE'], partyId: null, retainUntil: null })
    const frozen = await one(`SELECT after FROM "AuditLog" WHERE action = 'quotes.freezeProofs' AND "recordId" = $1`, [quote.current.id])
    expect(frozen.after.proofs.map((proof: Json) => [proof.name, proof.versionNo, proof.sha256])).toEqual([
      ['Artwork proof v2.pdf', 2, sha256(ARTWORK_V2)],
      ['Size chart.jpg', 1, sha256(PHOTO)],
    ])
    const list = await as(sales, 'GET', `${quoteUrl(quote.id)}/proofs`)
    expect(current(list)).toMatchObject({ status: 'SENT', frozen: 'Version 1 was sent: its proofs went with it and are frozen. Make a new version to change them.' })
    expect(current(list).proofs.every((proof: Json) => proof.sharedWithCustomer)).toBe(true)
    expect(list.may).toEqual({ change: false, held: 'Version 1 was sent: its proofs went with it and are frozen. Make a new version to change them.' })
  })

  it('nothing changes them after the send: no new proof, no new version, no removal, no delete (kept)', async () => {
    const body = { originalName: 'late.pdf', contentType: 'application/pdf', sizeBytes: 9, sha256: sha256(Buffer.from('%PDF-late')) }
    expect((await sales.send('POST', `${quoteUrl(quote.id)}/proofs`, body, { headers: { 'idempotency-key': key() } })).status).toBe(409)
    expect((await sales.send('POST', `${quoteUrl(quote.id)}/proofs/${photo.id}/versions`, { ...body, contentType: 'image/jpeg', originalName: 'late.jpg' }, { headers: { 'idempotency-key': key() } })).status).toBe(409)
    expect((await sales.send('DELETE' as 'POST', `${quoteUrl(quote.id)}/proofs/${photo.id}`, undefined, { headers: { 'idempotency-key': key() } })).status).toBe(409)
    const generic = await walls.inject({ method: 'DELETE', url: `/files/${photo.id}`, headers: { 'x-test-session': 'viewer', 'idempotency-key': key() } })
    expect(generic.statusCode).not.toBe(200)
    expect((await one('SELECT status FROM "StoredFile" WHERE id = $1', [photo.id])).status).toBe('AVAILABLE')
  })
})

describe('the accept link lists the proofs; the acceptance names each one (SAL-199)', () => {
  it('lists the frozen proofs in order, with their SHA-256 and version; opening uses nothing up', async () => {
    expect((await link(token, 'POST', '/link/open', {})).status).toBe(200)
    const view = await link(token, 'GET', '/link/quote')
    expect(view.status).toBe(200)
    expect(view.body!.quote.proofs).toEqual([
      { fileId: artworkV2.id, name: 'Artwork proof v2.pdf', contentType: 'application/pdf', shape: 'PDF', sizeBytes: ARTWORK_V2.length, sha256: sha256(ARTWORK_V2), versionNo: 2 },
      { fileId: photo.id, name: 'Size chart.jpg', contentType: 'image/jpeg', shape: 'PICTURE', sizeBytes: PHOTO.length, sha256: sha256(PHOTO), versionNo: 1 },
    ])
  })

  it('serves a PDF proof as stored and a picture without its camera and position data; nothing else', async () => {
    const document = await link(token, 'GET', `/link/quote/proofs/${artworkV2.id}`)
    expect(document.status).toBe(200)
    expect(document.type).toContain('application/pdf')
    expect(Buffer.compare(document.raw, ARTWORK_V2)).toBe(0)
    const picture = await link(token, 'GET', `/link/quote/proofs/${photo.id}`)
    expect(picture.status).toBe(200)
    expect(picture.type).toContain('image/jpeg')
    const text = picture.raw.toString('latin1')
    expect(text).not.toContain('GPS 45.4642N')
    expect(text).not.toContain('GPSLatitude')
    expect(text).not.toContain('made-up phone')
    // The superseded version 1, a file of no proof, any made-up id: not found, the same answer.
    for (const id of [artwork.id, quote.id, newId()]) expect((await link(token, 'GET', `/link/quote/proofs/${id}`)).status).toBe(404)
  })

  it('refuses an acceptance of proofs the page did not show; accepts the ones it showed and keeps them in the evidence', async () => {
    const versionId = quote.current.id
    const stale = await link(token, 'POST', '/link/quote/accept', { versionId, typedName: 'Anna Finta', email: BUYER, proofFileIds: [artworkV2.id] })
    expect(stale.status).toBe(409)
    expect(stale.body!.error.message).toBe('The proofs of this quote changed while you were reading it: read them again before you accept.')
    expect((await one('SELECT status FROM "QuoteVersion" WHERE id = $1', [versionId])).status).toBe('SENT')
    const accepted = await link(token, 'POST', '/link/quote/accept', { versionId, typedName: 'Anna Finta', email: BUYER, proofFileIds: [photo.id, artworkV2.id] })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body).toMatchObject({ state: 'ACCEPTED', quote: { proofs: [{ fileId: artworkV2.id }, { fileId: photo.id }] } })
    const evidence = await one(`SELECT after, "partyId", audience FROM "AuditLog" WHERE action = 'quotes.acceptProofs' AND "recordId" = $1`, [versionId])
    expect(evidence).toMatchObject({ partyId: P1, audience: 'LINK' })
    expect(evidence.after.proofs.map((proof: Json) => [proof.fileId, proof.sha256, proof.versionNo])).toEqual([
      [artworkV2.id, sha256(ARTWORK_V2), 2],
      [photo.id, sha256(PHOTO), 1],
    ])
    const list = await as(sales, 'GET', `${quoteUrl(quote.id)}/proofs`)
    expect(current(list).accepted).toMatchObject({ signerName: 'Anna Finta', proofs: [{ name: 'Artwork proof v2.pdf', sha256: sha256(ARTWORK_V2), versionNo: 2 }, { name: 'Size chart.jpg', sha256: sha256(PHOTO), versionNo: 1 }] })
  })
})

describe('the accepted proofs go with the order to its work orders', () => {
  it('the order made from the accepted version reads them; so does a work order made from its line', async () => {
    const order = await one('SELECT id, number FROM "SalesOrder" WHERE "quoteVersionId" = $1', [quote.current.id])
    const read = await as(sales, 'GET', `/sales/orders/${order.id}/proofs`)
    expect(read).toMatchObject({ orderId: order.id, number: order.number, quoteId: quote.id, quoteNumber: quote.number, revision: 1, accepted: { signerName: 'Anna Finta' } })
    expect(read.accepted.proofs.map((proof: Json) => proof.fileId)).toEqual([artworkV2.id, photo.id])
    expect((await wall('companyB', 'GET', `/sales/orders/${order.id}/proofs`)).status).toBe(404)
    const line = await one('SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1', [order.id])
    const made = await wall('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: line.id }] })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const workOrderId = made.body.workOrder.id
    const proofs = await wall('planner', 'GET', `/production/work-orders/${workOrderId}/proofs`)
    expect(proofs.status, JSON.stringify(proofs.body)).toBe(200)
    expect(proofs.body).toMatchObject({ workOrderId, orders: [{ orderId: order.id, accepted: { proofs: [{ fileId: artworkV2.id }, { fileId: photo.id }] } }] })
    // The planner opens a proof through the files routes (files.read): the office gets the file itself.
    expect((await wall('planner', 'GET', `/files/${photo.id}/preview`)).status).toBe(200)
  })
})

describe('a new version starts without proofs: carry them over', () => {
  it('copies the earlier version’s current proofs onto the new draft (each names its source), not twice', async () => {
    const second = await newQuote()
    await addProof(second.id, 'Artwork.pdf', pdf('artwork for the revision test'), 'application/pdf')
    const { answer } = await send(second)
    expect(answer.quote.status).toBe('SENT')
    const fresh = (await as(sales, 'GET', quoteUrl(second.id))).quote
    await as(sales, 'POST', `${quoteUrl(second.id)}/revise`, { version: fresh.version, changeNote: 'Smaller logo' })
    const list = await as(sales, 'GET', `${quoteUrl(second.id)}/proofs`)
    const v1 = list.versions.find((version: Json) => version.revision === 1)
    expect(current(list)).toMatchObject({ revision: 2, status: 'DRAFT', proofs: [] })
    expect(list.carry).toEqual({ fromVersionId: v1.versionId, revision: 1, count: 1 })
    const carried = await as(sales, 'POST', `${quoteUrl(second.id)}/proofs/carry`, { fromVersionId: v1.versionId })
    const proof = current(carried).proofs[0]
    expect(proof).toMatchObject({ name: 'Artwork.pdf', state: 'READY', versionNo: 1, sourceFileId: v1.proofs[0].fileId, sharedWithCustomer: false })
    expect(carried.carry).toBeNull()
    expect((await one('SELECT category, visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1', [proof.fileId]))).toEqual({ category: 'PROOF', visibility: ['OFFICE'] })
    const again = await sales.send('POST', `${quoteUrl(second.id)}/proofs/carry`, { fromVersionId: v1.versionId }, { headers: { 'idempotency-key': key() } })
    expect(again.status).toBe(409)
  })
})
