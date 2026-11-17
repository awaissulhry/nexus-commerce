import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { usePortalOptions } from '../../platform/auth/portal/service'
import { freshGuard } from '../../platform/auth/portal/testing/portal'
import { outsideUploadsRefusal } from '../../platform/files/multipart/outside'
import { fakeScanner } from '../../platform/files/scan/fake'
import { useScanner } from '../../platform/files/scan/service'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { everyHandler, searchIndexers, settler } from '../daily/testing/day'
import { addressesOf, asBrand, BRAND_ALPHA, BRAND_BETA, findMarkers, mailText, markersOf, setUpBrand, type BrandInWorld, type Seen } from '../portal/testing/two-brands'
import { admin, ok, pdf, person, putBytes, QUIET, sha256, startWorld, type Person, type World } from '../testing/world'
import { DATABASE_FUTURE_MS, oneClock } from '../testing/world'

/**
 * B-TH-087 — GOLDEN FLOW TH-7: CUSTOMERS SEND FILES (threads plan TH-7, B-TH-083 / 084 / 085; §0 the brand wall; Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be able
 * to see it all. And manage it all as well."). On the golden world (every base seed, the real app and sign-in, every outside provider
 * FAKE: the virus scanner too) with the worker's handlers run in-process, through the HTTP routes:
 *
 *   S    the sales office makes P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal buyer, who
 *        may write in its threads and upload (the comment and upload capabilities).
 *   F1   customer A sends a request (New order), then gives it two photos and a PDF ticked "This is a measurement sheet": each
 *        announced, its bytes put, completed and scanned by the fake scanner; ONE message of A carries them into the request's
 *        conversation. Each file is on the request, shared with A only (OFFICE + PARTNER), the sheet filed MEASUREMENTS, and the
 *        person of A who sent it is recorded.
 *   T9   the office files view of the request: the production manager (his template holds sales.measurements.view) reads the sheet,
 *        downloads and previews it — each opening recorded (who, how); finance (no sales.measurements.view) reads the photos but
 *        never the sheet: 404 on it, its download and preview, locked and unnamed in the list and on the message, no opening recorded.
 *   T25 / T37  customer B announces, completes, attaches, lists and opens none of A's files, by any door; A's file ids are not B's
 *        files on B's own request either.
 *   G1   uploads close when the virus scanner is off (staging with no scanner, as production before ClamAV): the portal says so
 *        before a file is dropped, the upload is refused in the same words (503), and nothing is stored.
 *   T00  the name scan: nothing B got (answers and mail) holds a name, code, number, file name, message or id of A.
 *   Z    no route answered 500 during the flow.
 *
 * SQL only reads ids and asserts: no step is made by SQL. Every name, address, file and figure is made up. Run with
 * `node scripts/factory/golden-flow.mjs threads`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
const P = {} as Record<'owner' | 'sales' | 'manager' | 'finance', Person>
let alpha: BrandInWorld
let beta: BrandInWorld
const seen: Seen[] = []
const unexpected: ErrorReport[] = []
const G = {} as Record<string, any>
/** Each brand's portal person is its buyer (sends requests) who may write in its threads and upload files (B-TH-085). */
const BUYER = { roleKey: 'customer-buyer', capabilities: ['comment', 'upload'] } as const
const PHOTO_FRONT = 'made-up-alpha-jacket-front.png'
const PHOTO_BACK = 'made-up-alpha-jacket-back.png'
const SHEET = 'made-up-alpha-rider-sizes.pdf'
/** The sentence that closes uploads from outside on staging and production while no ClamAV runs (platform/files/multipart/outside). */
const CLOSED_WORDS = outsideUploadsRefusal('staging', null)!
const id = (key: string) => w.id(key)
const companyA = () => id('company:A')
const P1 = () => id('party:P1')
const P3 = () => id('party:P3')
const today = () => businessDate(new Date())
const A = (method: 'GET' | 'POST', url: string, body?: unknown, status: number | null = 200) => asBrand(alpha, seen, method, url, body, status)
const B = (method: 'GET' | 'POST', url: string, body?: unknown, status: number | null = 200) => asBrand(beta, seen, method, url, body, status)
/** The office's own number of a request (INQ-…): the office reads it, a customer never (§0.5). */
const officeNumber = async (inquiryId: string) => (await admin<{ number: string }>(w, 'SELECT number FROM "Inquiry" WHERE id = $1', [inquiryId]))[0]!.number
/** A made-up picture: the PNG signature, then words (the local store keeps bytes; the fake scanner reads them). */
const png = (text: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`made-up picture of the golden flow: ${text}`)])
const meta = (name: string, contentType: string, bytes: Buffer, measurementSheet?: boolean) => ({ originalName: name, contentType, sizeBytes: bytes.length, sha256: sha256(bytes), ...(measurementSheet === undefined ? {} : { measurementSheet }) })
/** Each opening of a measurement sheet (B-TH-083): who, from where, how. */
const openings = (fileId: string) =>
  admin<{ actorId: string; audience: string; how: string }>(
    w,
    `SELECT "actorId", audience::text AS audience, after->>'how' AS how FROM "AuditLog" WHERE "recordType" = 'StoredFile' AND "recordId" = $1 AND action = 'files.measurementSheetOpened' ORDER BY at, id`,
    [fileId],
  )
const filesOn = async (recordId: string) => (await admin<{ n: number }>(w, 'SELECT count(*)::int AS n FROM "StoredFile" WHERE "tenantId" = $1 AND "recordId" = $2', [w.tenant.id, recordId]))[0]!.n

/** Customer A uploads one file to a portal base (the request, or a record's conversation): announce, put the bytes, complete. */
async function upload(base: string, name: string, contentType: string, bytes: Buffer, measurementSheet?: boolean): Promise<Json> {
  const announced = await A('POST', `${base}/files`, meta(name, contentType, bytes, measurementSheet), 201)
  expect(announced.file).toMatchObject({ originalName: name, status: 'PENDING_UPLOAD', measurementSheet: measurementSheet === true })
  await putBytes(w, announced, bytes)
  // The fake scanner scans the file as it is completed: clean, so it is AVAILABLE at once.
  const done = await A('POST', `${base}/files/${announced.file.id}/complete`)
  expect(done.file).toMatchObject({ id: announced.file.id, status: 'AVAILABLE' })
  return announced.file
}

/** Staging with no virus scanner (production before ClamAV): FACTORY_ENV is read per call and put back, and the fake scanner too. */
async function scannerOff<R>(work: () => Promise<R>): Promise<R> {
  const before = process.env.FACTORY_ENV
  useScanner(null)
  process.env.FACTORY_ENV = 'staging'
  try {
    return await work()
  } finally {
    if (before === undefined) delete process.env.FACTORY_ENV
    else process.env.FACTORY_ENV = before
    useScanner(fakeScanner())
  }
}

// th3b follow-up 6: ONE clock; the database's own "not in the future" checks (5 minutes) still read its clock.
function clockWithinDatabase(): void {
  const ahead = w.h.clock.now().getTime() - Date.now()
  expect(ahead, `the harness clock runs ${Math.round(ahead / 1000)} s ahead of the database's`).toBeLessThan(DATABASE_FUTURE_MS)
}

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  w.h.clock.set(new Date())
  oneClock(w)
  freshGuard(w.h)
  usePortalOptions({ answerFloorMs: 0 })
  useScanner(fakeScanner())
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  P.owner = await person(w, 'owner', 'owner')
  P.sales = await person(w, 'sales', 'sales')
  P.manager = await person(w, 'manager', 'production_manager')
  P.finance = await person(w, 'finance', 'finance')
}, 1_200_000)

afterAll(async () => {
  useScanner(undefined)
  usePortalOptions({})
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

describe('B-TH-087 golden flow TH-7: customers send files — photos and a measurement sheet — behind the brand wall', { timeout: 300_000 }, () => {
  it('S00 the world: the seeds drain; the search index is built', async () => {
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  it('S01 Brand Alpha (P1) and Brand Beta (P3) with their portals, each with its buyer who may write and upload', async () => {
    alpha = await setUpBrand(w, P.sales, BRAND_ALPHA, P1(), companyA(), BUYER)
    beta = await setUpBrand(w, P.sales, BRAND_BETA, P3(), companyA(), BUYER)
    await settle()
    clockWithinDatabase()
    // Who opens a measurement sheet is a role's permission: the production manager's template holds it on purpose, finance's not.
    expect(templateOf('production_manager')!.permissions).toContain('sales.measurements.view')
    expect(templateOf('finance')!.permissions).not.toContain('sales.measurements.view')
  }, 900_000)

  it('F1 customer A sends a request, then two photos and a ticked measurement sheet; one message of A carries them', async () => {
    // The portal says before a drop whether files go: open here (the fake scanner runs).
    expect((await A('GET', '/portal/inquiries/open')).files).toEqual({ open: true, words: null })
    const sent = await A('POST', '/portal/inquiries', { subject: 'Made-up: eight made-to-measure jackets', message: `${BRAND_ALPHA.message}\nEight jackets, the riders' sizes attached.`, customerRef: BRAND_ALPHA.customerRef, wantedDate: addDays(today(), 45) }, 201)
    G.request = sent.request.id
    await settle()
    const base = `/portal/inquiries/${G.request}`
    const front = await upload(base, PHOTO_FRONT, 'image/png', png('alpha jacket front'))
    const back = await upload(base, PHOTO_BACK, 'image/png', png('alpha jacket back'))
    const sheet = await upload(base, SHEET, 'application/pdf', pdf('alpha rider sizes'), true)
    expect(front.kind).toBe('PHOTO')
    expect(back.kind).toBe('PHOTO')
    expect(sheet).toMatchObject({ kind: 'ATTACHMENT', measurementSheet: true })
    G.front = front.id
    G.back = back.id
    G.sheet = sheet.id
    // On the request, shared with A only, the sheet filed MEASUREMENTS, scanned clean by the fake scanner.
    const rows = await admin<Json>(
      w,
      'SELECT id, "recordType", "recordId", "partyId", visibility::text[] AS visibility, category::text AS category, "createdById", status::text AS status, "scanStatus"::text AS "scanStatus" FROM "StoredFile" WHERE id = ANY($1::uuid[]) ORDER BY "originalName"',
      [[G.front, G.back, G.sheet]],
    )
    const shared = { recordType: 'Inquiry', recordId: G.request, partyId: P1(), visibility: ['OFFICE', 'PARTNER'], createdById: null, status: 'AVAILABLE', scanStatus: 'CLEAN' }
    expect(rows).toEqual([
      { id: G.back, ...shared, category: null },
      { id: G.front, ...shared, category: null },
      { id: G.sheet, ...shared, category: 'MEASUREMENTS' },
    ])
    // Who of the customer sent each file: the person's own audit row.
    const audits = await admin<{ actorId: string }>(w, `SELECT "actorId" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'portal.attachFile' AND "recordId" = ANY($2::uuid[])`, [w.tenant.id, [G.front, G.back, G.sheet]])
    expect(audits.map((row) => row.actorId)).toEqual([alpha.userId, alpha.userId, alpha.userId])
    // One message of A carries them into the request's conversation.
    const attached = await A('POST', `${base}/files/attach`, { fileIds: [G.front, G.back, G.sheet], body: 'Made-up: the jacket from both sides, and the riders’ sizes.' }, 201)
    expect(attached.message).toMatchObject({ side: 'PARTNER', channel: 'PORTAL', author: { mine: true } })
    expect((attached.message.attachments as Json[]).map((file) => file.originalName)).toEqual([PHOTO_FRONT, PHOTO_BACK, SHEET])
    G.message = attached.message.id
    // A reads its own files on its own request.
    const listed = (await A('GET', `/files?recordType=Inquiry&recordId=${G.request}`)).files as Json[]
    expect(listed.map((file) => file.originalName).sort()).toEqual([PHOTO_BACK, PHOTO_FRONT, SHEET].sort())
    await settle()
  })

  it('T9 the production manager reads the sheet, downloads and previews it; each opening is recorded', async () => {
    expect((await ok(P.manager, 'GET', `/files/${G.sheet}`)).file).toMatchObject({ id: G.sheet, originalName: SHEET, category: 'MEASUREMENTS' })
    const listed = (await ok(P.manager, 'GET', `/files?recordType=Inquiry&recordId=${G.request}`)).files as Json[]
    expect(listed.map((file) => file.originalName).sort()).toEqual([PHOTO_BACK, PHOTO_FRONT, SHEET].sort())
    expect(listed.find((file) => file.id === G.sheet)?.locked).toBeUndefined()
    const before = (await openings(G.sheet)).length
    expect(Object.keys(await ok(P.manager, 'GET', `/files/${G.sheet}/download`))).toContain('download')
    expect(Object.keys(await ok(P.manager, 'GET', `/files/${G.sheet}/preview`))).toContain('preview')
    expect((await openings(G.sheet)).slice(before)).toEqual([
      { actorId: P.manager.id, audience: 'OFFICE', how: 'download' },
      { actorId: P.manager.id, audience: 'OFFICE', how: 'preview' },
    ])
    // On the request's conversation the sheet is named for him.
    const message = ((await ok(P.manager, 'GET', `/threads/Inquiry/${G.request}`)).messages as Json[]).find((entry) => entry.id === G.message)
    expect((message?.attachments as Json[]).find((file) => file.id === G.sheet)).toMatchObject({ originalName: SHEET })
  })

  it('T9 finance reads the photos but never the sheet: 404 on it, locked and unnamed in the list and on the message; no opening recorded', async () => {
    const before = (await openings(G.sheet)).length
    for (const url of [`/files/${G.sheet}`, `/files/${G.sheet}/download`, `/files/${G.sheet}/preview`, `/files/${G.sheet}/versions`, `/files/${G.sheet}/history`]) {
      const answer = await ok(P.finance, 'GET', url, undefined, 404)
      expect(JSON.stringify(answer), url).not.toContain(SHEET)
    }
    expect((await ok(P.finance, 'GET', `/files/${G.front}`)).file).toMatchObject({ id: G.front, originalName: PHOTO_FRONT })
    const list = await ok(P.finance, 'GET', `/files?recordType=Inquiry&recordId=${G.request}`)
    expect(JSON.stringify(list)).not.toContain(SHEET)
    expect((list.files as Json[]).find((file) => file.id === G.sheet)).toMatchObject({ locked: 'MEASUREMENTS', category: 'MEASUREMENTS', originalName: '', sha256: '' })
    expect((list.files as Json[]).find((file) => file.id === G.back)).toMatchObject({ originalName: PHOTO_BACK })
    const message = ((await ok(P.finance, 'GET', `/threads/Inquiry/${G.request}`)).messages as Json[]).find((entry) => entry.id === G.message)
    expect((message?.attachments as Json[]).find((file) => file.id === G.sheet)).toMatchObject({ originalName: '', locked: 'MEASUREMENTS' })
    expect((await openings(G.sheet)).length).toBe(before)
  })

  it('T25 / T37 customer B announces, completes, attaches, lists and opens none of A’s files — by any door: not found', async () => {
    const files = [G.front, G.back, G.sheet] as string[]
    const bytes = pdf('beta')
    for (const base of [`/portal/inquiries/${G.request}`, `/portal/threads/Inquiry/${G.request}`]) {
      await B('POST', `${base}/files`, meta('made-up-beta.pdf', 'application/pdf', bytes), 404)
      for (const fileId of files) await B('POST', `${base}/files/${fileId}/complete`, undefined, 404)
    }
    await B('POST', `/portal/inquiries/${G.request}/files/attach`, { fileIds: [G.front] }, 404)
    for (const fileId of files) for (const url of [`/files/${fileId}`, `/files/${fileId}/download`, `/files/${fileId}/preview`]) await B('GET', url, undefined, 404)
    expect((await B('GET', `/files?recordType=Inquiry&recordId=${G.request}`)).files).toEqual([])
    await B('GET', `/portal/inquiries/${G.request}`, undefined, 404)
    await B('GET', `/portal/threads/Inquiry/${G.request}`, undefined, 404)
    // B's own request: A's file ids are not B's files (on B's own route and in B's own message).
    const own = await B('POST', '/portal/inquiries', { subject: 'Made-up: three team vests', message: BRAND_BETA.message, customerRef: BRAND_BETA.customerRef }, 201)
    G.betaRequest = own.request.id
    await B('POST', `/portal/inquiries/${G.betaRequest}/files/${G.front}/complete`, undefined, 404)
    const stolen = await B('POST', `/portal/inquiries/${G.betaRequest}/files/attach`, { fileIds: [G.sheet] }, 400)
    expect(stolen.error?.issues).toEqual([expect.objectContaining({ path: 'body/attachments/0', message: 'File not found.' })])
    expect((await B('GET', `/files?recordType=Inquiry&recordId=${G.betaRequest}`)).files).toEqual([])
    for (const q of [PHOTO_FRONT, SHEET, await officeNumber(G.request), BRAND_ALPHA.customerRef]) await B('GET', `/portal/search?q=${encodeURIComponent(q)}`)
    await B('GET', '/portal/inquiries?state=ALL')
    await B('GET', '/portal/threads')
    await B('GET', '/portal/notifications')
    expect(await admin(w, 'SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "partyId" = $2 AND "recordId" = $3', [w.tenant.id, P3(), G.request])).toEqual([])
    await settle()
  })

  it('G1 uploads close when the virus scanner is off: said before a drop, refused in the same words (503), nothing stored', async () => {
    const before = await filesOn(G.request)
    await scannerOff(async () => {
      expect((await A('GET', '/portal/inquiries/open')).files).toEqual({ open: false, words: CLOSED_WORDS })
      expect((await A('GET', `/portal/threads/Inquiry/${G.request}`)).composer.uploads).toEqual({ open: false, words: CLOSED_WORDS })
      const refused = await A('POST', `/portal/inquiries/${G.request}/files`, meta('made-up-alpha-late.png', 'image/png', png('late')), 503)
      expect(refused.error.message).toBe(CLOSED_WORDS)
      const composer = await A('POST', `/portal/threads/Inquiry/${G.request}/files`, meta('made-up-alpha-late.pdf', 'application/pdf', pdf('late'), true), 503)
      expect(composer.error.message).toBe(CLOSED_WORDS)
    })
    expect(await filesOn(G.request)).toBe(before)
    // The scanner back: the portal says files go again.
    expect((await A('GET', '/portal/inquiries/open')).files).toEqual({ open: true, words: null })
  })

  it('T00 the name scan: nothing B got (answers and mail) holds a name, number, file name, message or id of A', async () => {
    const markers = [
      // Made after the uploads: A's stored files (names and ids) are among its record markers.
      ...(await markersOf(w, BRAND_ALPHA, P1())),
      { label: 'request number', text: await officeNumber(G.request) },
      { label: 'request id', text: G.request as string },
      { label: 'front photo', text: PHOTO_FRONT },
      { label: 'back photo', text: PHOTO_BACK },
      { label: 'measurement sheet', text: SHEET },
      { label: 'front photo id', text: G.front as string },
      { label: 'back photo id', text: G.back as string },
      { label: 'sheet id', text: G.sheet as string },
      { label: 'A’s message', text: 'the riders’ sizes' },
    ]
    // A search answer repeats what was typed (Beta typed A's file names and numbers on purpose): its echo is left out of the scan.
    const bodyOf = (entry: Seen) => (entry.url.startsWith('/portal/search') && entry.body && typeof entry.body === 'object' ? { ...(entry.body as Json), query: null, words: null } : entry.body)
    const leaks = seen.filter((entry) => entry.who.startsWith('beta')).flatMap((entry) => findMarkers(bodyOf(entry), markers).map((found) => `${entry.method} ${entry.url} (${entry.status}): ${found}`))
    expect(leaks).toEqual([])
    const addresses = new Set(await addressesOf(w, beta))
    const mails = w.h.ses.mails.filter((mail) => [...mail.to, ...mail.cc, ...mail.bcc].some((address) => addresses.has(address.toLowerCase())))
    expect(mails.flatMap((mail) => findMarkers(mailText(mail.raw), markers).map((found) => `${mail.templateKey}: ${found}`))).toEqual([])
    expect(seen.filter((entry) => entry.who.startsWith('beta')).length).toBeGreaterThan(10)
  })

  it('Z no route answered 500 during the flow', async () => {
    await settle()
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
