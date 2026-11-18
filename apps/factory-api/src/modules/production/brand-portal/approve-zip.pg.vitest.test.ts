import { inflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { NO_UNDO_WORDS, OWN_ANSWER_WORDS } from '@nexus/factory-domain/production-brand/approve-zip'
import { forbiddenKeysIn } from '@nexus/factory-domain/production-brand/portal-read'
import { callerFor } from '../../../core/command'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { storeGeneratedFile } from '../../../platform/files/files'
import { systemContext } from '../../../platform/outbox/system'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { madeUpPdf } from '../../shipping/documents/testing/compliance'
import { findMarkers, markersOf, type Marker } from '../testing/two-brands'
import { urgencyWorld, type UrgencyWorld } from '../testing/urgency-world'

/**
 * B-PR-46b — a customer's Approve N and Download files of N on My production (production plan §1 "Bulk", §3 "Bulk 'Approve' cannot
 * be undone"; lead pick L26; review fix R-52; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any
 * other brand. But we, as the production unit, should be able to see it all. And manage it all as well.") on the local stack through
 * the real app (../testing/urgency-world.ts): brand A = the seeds' P1, brand B = the threads' second brand, both portals on; the
 * office asks each brand to approve an artwork and a sample on its orders, and a PP round its gate names; B names its Buyer its
 * production approver; files shared on B's orders (a document, the order confirmation, and an OLD copy of A's document made before
 * the content wall) and on A's order.
 *
 *   PW-12 (approve and zip part)  B's review list and Approve N with A's order and A's request among its own: A's are neither read,
 *                                 answered nor named (counted); B's zip and its index hold no file of A (nor the old copy of A's
 *                                 document on B's own order); a Production person's zip holds no order confirmation, the Buyer's
 *                                 does; nothing any of B's people got names anything of A
 *   review list                   the approvals waiting on the picked orders, each once with the orders it is about, its photo and
 *                                 whether this person may tick it: the named approver's PP waits for the Buyer, "Open it to answer"
 *                                 for a revised order; the words before Send say it cannot be undone
 *   Approve N                     each request through the approvals answer path: its own rules (the named approver: 403 words on
 *                                 its row), its own command and key (a retry answers nothing twice), one approval_request.answered
 *                                 each; nothing approved: 409; no right to approve: 403; another customer's request alone: 404
 *   the zip                       a folder per order and index.csv; the order confirmation by role; within limits; nothing to zip
 *                                 409; each file zipped logged as a download, the zip once on the customer
 *
 * Every name, address and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-portal`.
 */

let world: UrgencyWorld
const NS = 'pr46b-approve-zip'
type Json = Record<string, any>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let owner: Office
let productionB: Portal
let buyerB: Portal
let viewerB: Portal
let buyerA: Portal
const BUYER_B = 'bea.buyer'
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const O = {} as Record<'b1' | 'b2' | 'b3' | 'a1', { orderId: string; number: string }>
const R = {} as Record<'bArt' | 'bSample' | 'bPp' | 'aArt' | 'bRevised', string>
const F = {} as Record<'bDoc' | 'bConfirmation' | 'bOldCopy' | 'aDoc', string>
let blk = ''
let aMarkers: Marker[] = []
const seenByB: { url: string; body: unknown }[] = []

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const system = () => callerFor(world.h.database, systemContext(world.ids.tenantId, newId()))
const freshKey = () => `pr46b-${newId()}`
const isB = (person: Office | Portal) => person === productionB || person === buyerB || person === viewerB

async function send(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown, key = freshKey()) {
  const answer = method === 'GET' ? await person.browser.send('GET', url) : await person.browser.send('POST', url, body ?? {}, { headers: { 'idempotency-key': key } })
  if (isB(person)) seenByB.push({ url, body: answer.response.headers['content-type']?.toString().includes('zip') ? `${unzipNames(answer.response.rawPayload).join('\n')}\n${unzip(answer.response.rawPayload).get('index.csv')?.toString('utf8') ?? ''}` : answer.body })
  return answer
}
async function ok(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown, key?: string): Promise<Json> {
  const answer = await send(person, method, url, body, key)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(200)
  return answer.body as Json
}
async function refused(person: Office | Portal, method: 'GET' | 'POST', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await send(person, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return answer.body.error as Json
}
async function as(person: Office, method: 'POST', url: string, body: unknown, status = 200): Promise<Json> {
  const answer = await person.browser.send(method, url, body, { headers: { 'idempotency-key': freshKey() } })
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return answer.body as Json
}

/** The entries of a zip (the central directory), each inflated. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let end = bytes.length - 22
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) return out
  const count = bytes.readUInt16LE(end + 10)
  let at = bytes.readUInt32LE(end + 16)
  for (let n = 0; n < count; n++) {
    const method = bytes.readUInt16LE(at + 10)
    const size = bytes.readUInt32LE(at + 20)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extra = bytes.readUInt16LE(at + 30)
    const comment = bytes.readUInt16LE(at + 32)
    const local = bytes.readUInt32LE(at + 42)
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const dataAt = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const data = bytes.subarray(dataAt, dataAt + size)
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))
    at += 46 + nameLength + extra + comment
  }
  return out
}
const unzipNames = (bytes: Buffer): string[] => [...unzip(bytes).keys()]

async function zipOf(person: Portal, orderIds: readonly string[]): Promise<{ names: string[]; index: string; files: Map<string, Buffer>; disposition: string }> {
  const answer = await send(person, 'POST', '/portal/production/files/zip', { orderIds })
  expect(answer.status, `zip: ${answer.response.body.slice(0, 600)}`).toBe(200)
  expect(answer.response.headers['content-type']).toContain('application/zip')
  const files = unzip(answer.response.rawPayload)
  return { names: [...files.keys()], index: files.get('index.csv')?.toString('utf8') ?? '', files, disposition: String(answer.response.headers['content-disposition'] ?? '') }
}

/** A photo of a record (what the office sends with its question). */
async function photoOf(recordType: string, recordId: string): Promise<string> {
  return (await storeGeneratedFile(world.h.files, system(), { companyId: world.w.companyId, recordType, recordId, kind: 'PHOTO', originalName: `Made-up ${recordType} ${recordId.slice(-8)}.png` /* fix-pr-4: each record's own name (A's and B's were one marker) */, contentType: 'image/png', body: PNG })).id
}
/** The office asks the customer to approve a record (its photo with it); the request's id. */
async function ask(kind: string, recordType: string, recordId: string): Promise<string> {
  const made = await as(owner, 'POST', '/approvals-out', { kind, recordType, recordId, question: `Made-up: please approve this ${kind.toLowerCase()}.`, fileIds: [await photoOf(recordType, recordId)], send: false }, 201)
  return made.request.id as string
}
/** A PDF shared with a customer on its order (as the order's files panel shares it). */
async function sharedPdf(orderId: string, partyId: string, originalName: string): Promise<string> {
  return (await storeGeneratedFile(world.h.files, system(), { companyId: world.w.companyId, recordType: 'SalesOrder', recordId: orderId, kind: 'DOCUMENT', originalName, contentType: 'application/pdf', body: madeUpPdf(originalName), visibility: ['OFFICE', 'PARTNER'], partyId })).id
}
const requestRow = (id: string) => one<{ status: string; by: string | null; typedName: string | null }>('SELECT status::text AS status, "answeredByUserId"::text AS by, "typedName" FROM "ApprovalRequest" WHERE id = $1', [id])
const answeredEvents = (requestId: string) => admin<{ id: string }>(`SELECT id FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'approval_request.answered' AND payload->>'requestId' = $2`, [world.ids.tenantId, requestId])

beforeAll(async () => {
  world = await urgencyWorld('pr46b_approve_zip', NS)
  owner = await world.officePerson('olga.owner@pr46b-office.example.com', 'owner')
  productionB = await world.portalPerson('bruno.production@pr46b-brand-beta.example.com', world.ids.b, ['customer-production', 'partner-approve'])
  buyerB = await world.portalPerson(`${BUYER_B}@pr46b-brand-beta.example.com`, world.ids.b, ['customer-buyer', 'partner-approve'])
  viewerB = await world.portalPerson('vera.reader@pr46b-brand-beta.example.com', world.ids.b, ['customer-production'])
  buyerA = await world.portalPerson('amy.buyer@pr46b-brand-alpha.example.com', world.ids.a, ['customer-buyer', 'partner-approve'])
  for (const [name, partyId, label] of [['b1', world.ids.b, 'ZB1'], ['b2', world.ids.b, 'ZB2'], ['b3', world.ids.b, 'ZB3'], ['a1', world.ids.a, 'ZA1']] as const) {
    const made = await world.addOrder(partyId, label, '2026-10-05')
    O[name] = { orderId: made.orderId, number: made.number }
  }
  blk = (await one<{ colourwayId: string }>('SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [world.w.a.salesOrderLineId])).colourwayId

  // What the office asks: B's artwork on its first order, a sample on its second, a PP round its second order's gate names; A's artwork.
  R.bArt = await ask('ARTWORK', 'SalesOrder', O.b1.orderId)
  R.bSample = await ask('SAMPLE', 'SalesOrder', O.b2.orderId)
  const { round } = await as(owner, 'POST', '/sales/samples/rounds', { styleId: world.w.styleId, companyId: world.w.companyId, kind: 'PRE_PRODUCTION', partyId: world.ids.b, cells: [{ colourwayId: blk, size: '50', quantity: 1 }], instructions: 'Made-up PP round.' }, 201)
  const pp = (await as(owner, 'POST', `/sales/samples/rounds/${round.id}/move`, { version: round.version, to: 'UNDER_REVIEW' })).round
  await as(owner, 'POST', '/planning/milestones/gates', { salesOrderId: O.b2.orderId, kind: 'PP_SAMPLE', sampleRoundId: pp.id }, 201)
  R.bPp = await ask('SAMPLE', 'SampleRound', pp.id)
  R.aArt = await ask('ARTWORK', 'SalesOrder', O.a1.orderId)
  // B names its Buyer its production approver (the limits card's field, B-PR-29): the PP round is the Buyer's.
  await admin('UPDATE "PortalSettings" SET "productionApproverId" = $1, version = version + 1 WHERE id = $2', [buyerB.id, world.ids.b])
  // A revised order of B's (a kind Approve N never answers); the row as the re-acceptance asks it, without its amendment.
  R.bRevised = newId()
  await world.replica([
    {
      sql: `INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", status, version) VALUES ($1, $2, $3, 'SalesOrderAmendment', $4, $5, 'REVISED_ORDER', 'Made-up: please confirm the order as revised.', $6, 'OPEN', 1)`,
      values: [R.bRevised, world.ids.tenantId, world.w.companyId, newId(), world.ids.b, new Date(Date.now() + 5 * 86_400_000)],
    },
  ])

  // Files shared on the orders: B's document and its order confirmation (the sales order's GeneratedDocument), A's document, and
  // an OLD copy of A's document on B's own order (made before the content wall: its source set with the database's rules off).
  F.bDoc = await sharedPdf(O.b1.orderId, world.ids.b, 'Made-up care notes ZB1.pdf')
  F.bConfirmation = await sharedPdf(O.b2.orderId, world.ids.b, 'Made-up order confirmation ZB2.pdf')
  F.aDoc = await sharedPdf(O.a1.orderId, world.ids.a, 'Made-up care notes ZA1.pdf')
  F.bOldCopy = await sharedPdf(O.b2.orderId, world.ids.b, 'Made-up old copy ZB2.pdf')
  await world.replica([
    {
      sql: `INSERT INTO "GeneratedDocument" (id, "tenantId", "companyId", "recordType", "recordId", kind, version, fingerprint, language, "fileId") VALUES ($1, $2, $3, 'SalesOrder', $4, 'ORDER_CONFIRMATION', 1, $5, 'en', $6)`,
      values: [newId(), world.ids.tenantId, world.w.companyId, O.b2.orderId, 'made-up-fingerprint-zb2', F.bConfirmation],
    },
    { sql: 'UPDATE "StoredFile" SET "sourceFileId" = $1 WHERE id = $2', values: [F.aDoc, F.bOldCopy] },
  ])

  aMarkers = [
    ...(await markersOf(world.h.db, world.ids.a)),
    { label: "A's order", text: O.a1.orderId },
    { label: "A's order", text: O.a1.number },
    { label: "A's request", text: R.aArt },
    { label: "A's file", text: F.aDoc },
    { label: "A's file name", text: 'Made-up care notes ZA1' },
    { label: "A's work order", text: world.w.a.workOrderNumber },
  ]
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe('B-PR-46b the review list (GET /portal/production/approvals)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("PW-12: B's list of its own orders with A's order among them — the approvals waiting on each own order, once; A's neither read nor named", async () => {
    const list = await ok(productionB, 'GET', `/portal/production/approvals?orderIds=${O.b1.orderId},${O.a1.orderId},${O.b2.orderId}`)
    expect(list.notFound).toBe(1)
    expect(list.orders.map((order: Json) => order.orderId)).toEqual([O.b1.orderId, O.b2.orderId])
    expect(list.undo).toEqual(NO_UNDO_WORDS)
    const item = (requestId: string): Json | undefined => (list.items as Json[]).find((entry) => entry.requestId === requestId)
    expect(item(R.aArt)).toBeUndefined()
    expect(item(R.bArt)).toMatchObject({ kind: 'ARTWORK', version: 1, orders: [{ orderId: O.b1.orderId, number: O.b1.number }], may: { approve: true, held: null } })
    expect(item(R.bArt)!.files).toEqual([expect.objectContaining({ contentType: 'image/png' })])
    expect(item(R.bSample)).toMatchObject({ kind: 'SAMPLE', orders: [{ orderId: O.b2.orderId }], may: { approve: true, held: null } })
    // The PP round of the style both orders make (and the second order's gate names): once, about both; the Buyer approves it.
    expect(item(R.bPp)).toMatchObject({ kind: 'SAMPLE', orders: [{ orderId: O.b1.orderId }, { orderId: O.b2.orderId }], may: { approve: false } })
    expect(item(R.bPp)!.may.held).toContain(`Waiting for ${BUYER_B}`)
    // Each request is listed once; the counts are of the list.
    expect(new Set((list.items as Json[]).map((entry) => entry.requestId)).size).toBe((list.items as Json[]).length)
    const about = (orderId: string) => (list.items as Json[]).filter((entry) => (entry.orders as Json[]).some((order) => order.orderId === orderId)).length
    expect(list.orders.map((order: Json) => order.waiting)).toEqual([about(O.b1.orderId), about(O.b2.orderId)])
    expect(about(O.b1.orderId)).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(list)).not.toContain(O.a1.orderId)
    expect(JSON.stringify(list)).not.toContain(R.aArt)

    // The Buyer may tick the PP round; A's buyer never reads B's requests through its own orders.
    const buyers = await ok(buyerB, 'GET', `/portal/production/approvals?orderIds=${O.b2.orderId}`)
    expect((buyers.items as Json[]).find((entry) => entry.requestId === R.bPp)).toMatchObject({ may: { approve: true, held: null } })
    const alpha = await ok(buyerA, 'GET', `/portal/production/approvals?orderIds=${O.a1.orderId}`)
    const alphas = (alpha.items as Json[]).map((entry) => entry.requestId)
    expect(alphas).toContain(R.aArt)
    for (const requestId of [R.bArt, R.bSample, R.bPp, R.bRevised]) expect(alphas).not.toContain(requestId)
  })

  it("A's order alone is as unknown as a wrong id (404); more than 50 orders: 400", async () => {
    const alone = await refused(productionB, 'GET', `/portal/production/approvals?orderIds=${O.a1.orderId}`, undefined, 404)
    expect(alone.message).toBe('Order not found.')
    const many = Array.from({ length: 51 }, () => newId()).join(',')
    await refused(productionB, 'GET', `/portal/production/approvals?orderIds=${many}`, undefined, 400)
  })
})

describe('B-PR-46b Approve N (POST /portal/production/approvals/answer)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const key = freshKey()

  it("PW-12: B's Production person approves with A's request among its own — each through its own rules and key; A's neither answered nor named", async () => {
    const before = await requestRow(R.aArt)
    const items = [R.bArt, R.aArt, R.bPp, R.bRevised, R.bSample].map((requestId) => ({ requestId, version: 1 }))
    const answer = await ok(productionB, 'POST', '/portal/production/approvals/answer', { items, typedName: 'Bruno Production' }, key)
    expect(answer).toMatchObject({ notFound: 1, replayed: false })
    expect(answer.results.map((row: Json) => [row.requestId, row.done, row.code])).toEqual([
      [R.bArt, true, null],
      [R.bPp, false, 'NOT_YOURS'],
      [R.bRevised, false, 'OWN_ANSWER'],
      [R.bSample, true, null],
    ])
    expect(answer.results[0]).toMatchObject({ status: 'APPROVED', words: { it: 'Approvato.', en: 'Approved.' } })
    expect(answer.results[1].words.en).toContain(`Waiting for ${BUYER_B}`)
    expect(answer.results[2].words).toEqual(OWN_ANSWER_WORDS)
    expect(JSON.stringify(answer)).not.toContain(R.aArt)

    // Each one answered as its own answer, signed with the typed name by the person; the others untouched.
    expect(await requestRow(R.bArt)).toEqual({ status: 'APPROVED', by: productionB.id, typedName: 'Bruno Production' })
    expect(await requestRow(R.bSample)).toEqual({ status: 'APPROVED', by: productionB.id, typedName: 'Bruno Production' })
    expect(await requestRow(R.bPp)).toMatchObject({ status: 'OPEN', by: null })
    expect(await requestRow(R.bRevised)).toMatchObject({ status: 'OPEN', by: null })
    expect(await requestRow(R.aArt)).toEqual(before)
    expect(await answeredEvents(R.bArt)).toHaveLength(1)
    expect(await answeredEvents(R.bSample)).toHaveLength(1)
    expect(await answeredEvents(R.aArt)).toHaveLength(0)
    // Two commands of the answer path, one per request, each with its own derived key.
    const receipts = await admin<{ key: string }>(`SELECT key FROM "IdempotencyReceipt" WHERE "tenantId" = $1 AND scope = 'approvalsOut.answer' AND "actorId" = $2`, [world.ids.tenantId, productionB.id])
    expect(receipts).toHaveLength(2)
    expect(new Set(receipts.map((row) => row.key)).size).toBe(2)
    expect(receipts.every((row) => row.key.startsWith('approve-many-'))).toBe(true)
  })

  it('a retry with the same key answers nothing twice: the rows read done, replayed', async () => {
    const items = [R.bArt, R.aArt, R.bPp, R.bRevised, R.bSample].map((requestId) => ({ requestId, version: 1 }))
    const again = await ok(productionB, 'POST', '/portal/production/approvals/answer', { items, typedName: 'Bruno Production' }, key)
    expect(again).toMatchObject({ notFound: 1, replayed: true })
    expect(again.results.map((row: Json) => [row.requestId, row.done])).toEqual([
      [R.bArt, true],
      [R.bPp, false],
      [R.bRevised, false],
      [R.bSample, true],
    ])
    expect(await answeredEvents(R.bArt)).toHaveLength(1)
    expect(await answeredEvents(R.bSample)).toHaveLength(1)
  })

  it('the named approver approves the PP round from the list; nothing left to approve: 409 with each row\'s words', async () => {
    const done = await ok(buyerB, 'POST', '/portal/production/approvals/answer', { items: [{ requestId: R.bPp, version: 1 }], typedName: 'Bea Buyer' })
    expect(done.results).toEqual([expect.objectContaining({ requestId: R.bPp, done: true, status: 'APPROVED', code: null })])
    expect(await requestRow(R.bPp)).toEqual({ status: 'APPROVED', by: buyerB.id, typedName: 'Bea Buyer' })
    const nothing = await refused(productionB, 'POST', '/portal/production/approvals/answer', { items: [{ requestId: R.bArt, version: 2 }, { requestId: R.bRevised, version: 1 }], typedName: 'Bruno Production' }, 409)
    expect(nothing.issues.map((issue: Json) => issue.path)).toEqual(['body/items/0/HELD', 'body/items/1/OWN_ANSWER'])
  })

  it("no right to approve: 403; A's request alone: 404 as an unknown one; the typed name and each request once: 400", async () => {
    const reader = await refused(viewerB, 'POST', '/portal/production/approvals/answer', { items: [{ requestId: R.bRevised, version: 1 }], typedName: 'Vera Reader' }, 403)
    expect(reader.message).toContain('not answer them')
    const alpha = await refused(productionB, 'POST', '/portal/production/approvals/answer', { items: [{ requestId: R.aArt, version: 1 }], typedName: 'Bruno Production' }, 404)
    expect(alpha.message).toBe('Approval request not found.')
    expect((await requestRow(R.aArt)).status).toBe('OPEN')
    const unsigned = await refused(productionB, 'POST', '/portal/production/approvals/answer', { items: [{ requestId: R.bRevised, version: 1 }], typedName: ' ' }, 400)
    expect(unsigned.issues.map((issue: Json) => issue.path)).toEqual(['body/typedName'])
    const twice = await refused(productionB, 'POST', '/portal/production/approvals/answer', { items: [{ requestId: R.bRevised, version: 1 }, { requestId: R.bRevised, version: 1 }], typedName: 'Bruno Production' }, 400)
    expect(twice.issues.map((issue: Json) => issue.path)).toEqual(['body/items/1/requestId'])
  })
})

describe('B-PR-46b Download files of N (POST /portal/production/files/zip)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("PW-12: B's Production person's zip of its orders with A's order among them — its own shared files only: no file of A, no old copy of A's, no order confirmation", async () => {
    const zip = await zipOf(productionB, [O.b1.orderId, O.a1.orderId, O.b2.orderId])
    expect(zip.names).toEqual(['index.csv', `${O.b1.number}/Made-up care notes ZB1.pdf`])
    expect(zip.files.get(`${O.b1.number}/Made-up care notes ZB1.pdf`)!.toString('utf8')).toContain('%PDF-1.4')
    expect(zip.index).toContain(`${O.b1.number}/Made-up care notes ZB1.pdf`)
    for (const text of [O.a1.number, 'ZA1', 'old copy', 'order confirmation ZB2', F.aDoc]) expect(zip.index).not.toContain(text)
    expect(zip.disposition).toContain('files_2_orders_')
    // Logged: the file zipped as a download of the library (mode zip), the zip once on the customer.
    const downloads = await admin<{ recordId: string; mode: string }>(`SELECT "recordId"::text AS "recordId", after->>'mode' AS mode FROM "AuditLog" WHERE action = 'customerDocuments.download' AND "actorId" = $1 ORDER BY at`, [productionB.id])
    expect(downloads).toEqual([{ recordId: F.bDoc, mode: 'zip' }])
    const zipped = await one<{ recordType: string; recordId: string; files: number; included: number }>(
      `SELECT "recordType", "recordId"::text AS "recordId", (after->>'files')::int AS files, (after->>'included')::int AS included FROM "AuditLog" WHERE action = 'portal.productionZip' AND "actorId" = $1`,
      [productionB.id],
    )
    expect(zipped).toEqual({ recordType: 'Party', recordId: world.ids.b, files: 1, included: 1 })
  })

  it("R-52: the Buyer's zip holds the order confirmation (it sees prices); the library lists it only for roles with prices", async () => {
    const zip = await zipOf(buyerB, [O.b2.orderId])
    expect(zip.names).toEqual(['index.csv', `${O.b2.number}/Made-up order confirmation ZB2.pdf`])
    expect(zip.disposition).toContain(`${O.b2.number}_files.zip`)
    expect(zip.index).not.toContain('old copy')
    const kindsFor = async (person: Portal) => ((await ok(person, 'GET', `/portal/customer-documents?orderId=${O.b2.orderId}`)).items as Json[]).filter((entry) => entry.id === F.bConfirmation).map((entry) => entry.kind)
    expect(await kindsFor(buyerB)).toEqual(['ORDER_CONFIRMATION'])
    expect(await kindsFor(productionB)).toEqual([])
  })

  it("A's order alone: 404 as an unknown one; an own order with nothing shared: 409 in words; each order once: 400", async () => {
    const alone = await refused(productionB, 'POST', '/portal/production/files/zip', { orderIds: [O.a1.orderId] }, 404)
    expect(alone.message).toBe('Order not found.')
    const empty = await refused(productionB, 'POST', '/portal/production/files/zip', { orderIds: [O.b3.orderId] }, 409)
    expect(empty.issues.map((issue: Json) => issue.path)).toEqual(['problem/NOTHING_TO_ZIP'])
    expect(empty.message).toBe('There are no files to download for these orders yet.')
    await refused(productionB, 'POST', '/portal/production/files/zip', { orderIds: [O.b1.orderId, O.b1.orderId] }, 400)
    // A's own zip is A's alone (the production unit's wall is symmetric).
    const alpha = await zipOf(buyerA, [O.a1.orderId])
    expect(alpha.names).toEqual(['index.csv', `${O.a1.number}/Made-up care notes ZA1.pdf`])
  })
})

describe('B-PR-46b the scan', () => {
  it("no answer, zip or index B's people got names anything of A, nor a key of ours (a work order, a site, a person of the office)", () => {
    expect(seenByB.length).toBeGreaterThan(10)
    for (const seen of seenByB) expect(findMarkers(seen.body, aMarkers), seen.url).toEqual([])
    const keys = seenByB.flatMap((seen) => (seen.body && typeof seen.body === 'object' ? forbiddenKeysIn(seen.body).map((key) => `${seen.url}: ${key}`) : []))
    expect(keys).toEqual([])
  })
})
