import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { PRICED_WORDS } from '@nexus/factory-domain/files/priced'
// The factory-db seeds and fixtures are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedParties } from '../../../../../packages/factory-db/seed/parties'
import { seed as seedProduct } from '../../../../../packages/factory-db/seed/product'
import { seed as seedSales } from '../../../../../packages/factory-db/seed/sales'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { systemContext } from '../outbox/system'
import { indexEvent, rebuildIndex } from '../search/indexing'
import { loadIndexers } from '../search/registry'
import type { SearchIndexer } from '../search/indexer'

/**
 * B-CP-023 (customer page plan, the money wall L1, L2; review B1, D1) — the PRICED lock on every other read, attach, link and
 * search path. Owner rule (plan O1–O3): our prices are seen only by the Owner and the people he names. A priced document of
 * Brand Alpha's order (StoredFile.priced, ticked at upload by the Owner):
 *
 *   - on a message (a thread's file card, the customer feed, a draft): locked for a reader who does not see prices — counted,
 *     "Priced document — you cannot open it", never named;
 *   - attached by someone who does not see prices — to a mail to the customer (email-out asks the threads' check), an office note
 *     (a portal reply asks the same check): "File not found.", the words of an unknown id; nothing is queued;
 *   - by link: refused for a Planner (409 refusal/PRICED_BY_LINK in words, the file never named), made by the Owner;
 *   - the order's Files tab, its open route and its previews (sales/orders/order-files.ts readOfficeOrderFiles): left out,
 *     counted as pricedLeftOut, never named, never opened;
 *   - search: a priced file's name is never in the message index; a mark reads the messages again (file.priced_changed).
 *
 * The work order's "Order files" (Production manager, Floor supervisor) are modules/production/order-files' own test. As Sales
 * worker: the Sales template's permissions WITHOUT its grains (Owner pick O1, B-CP-011). Every name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/files/priced-paths`.
 */

let h: Harness
let app: FastifyInstance
let indexers: readonly SearchIndexer[]
const NS = 'files-priced-paths'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const SO1 = seedUuid(NS, 'sales:SO1')
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const FILES: Permission[] = ['files.read', 'files.upload', 'files.manage', 'threads.read', 'threads.post', 'email.send', 'links.view', 'links.manage', 'orders.view']
const office = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions: [...permissions], companies: 'all', sites: 'all', parties }] })
const template = (key: string): readonly Permission[] => templateOf(key)!.permissions
const SESSIONS: Record<string, () => SessionContext> = {
  owner: () => office([...FILES, 'money.price']),
  salesWorker: () => office(template('sales')),
  productionManager: () => office(template('production_manager')),
  // A Planner who may send share links (links.manage), without prices.
  planner: () => office([...template('planner'), 'links.view', 'links.manage']),
}

async function call(session: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `priced-paths-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  const json = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body: json, raw: response.body }
}
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up document of the priced-paths test: ${text}`)
async function uploaded(name: string, input: Json): Promise<Json> {
  const body = pdf(name)
  const announced = await call('owner', 'POST', '/files', { companyId: companyA, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), ...input })
  expect(announced.status, announced.raw).toBe(201)
  expect((await app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: body })).statusCode).toBe(200)
  const done = await call('owner', 'POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, done.raw).toBe(200)
  return done.body.file
}
const system = () => callerFor(h.database, systemContext(T, `priced-paths-${newId()}`))
const outboundCount = async (): Promise<number> => (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "tenantId" = $1`, [T]))[0]!.n
const messageOf = (thread: Json, messageId: string): Json => (thread.messages as Json[]).find((message) => message.id === messageId) ?? {}
const searchFor = async (q: string): Promise<string[]> => {
  const answer = await call('owner', 'GET', `/search?q=${encodeURIComponent(q)}&type=Message`)
  expect(answer.status, answer.raw).toBe(200)
  return (answer.body.results as Json[]).map((result) => result.recordId)
}

// Made-up words only these files carry (search finds a file's name through the message it came with).
const CONFIRMATION = 'Brand Alpha order confirmation ZQXCONFIRM v1.pdf'
const ARTWORK = 'Brand Alpha logo artwork ZQXARTWORK.pdf'
let confirmation: Json
let artwork: Json
let noteId = ''

beforeAll(async () => {
  h = await startHarness('files_cp023_priced_paths')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedNumbering, seedParties, seedFiles, seedEmail, seedProduct, seedSales]) await seed({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [T])
  const routesRoot = fileURLToPath(new URL('../..', import.meta.url))
  // The office sign-in's own services (a link's address, the office clock) with test sessions.
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, officeAuth: h.auth, clock: h.clock, routesRoot, authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  indexers = await loadIndexers(routesRoot)
  // Brand Alpha's priced document and a plain artwork, both shared with its portal and its links.
  confirmation = await uploaded(CONFIRMATION, { recordType: 'SalesOrder', recordId: SO1, visibility: ['PARTNER', 'LINK'], priced: true })
  artwork = await uploaded(ARTWORK, { recordType: 'SalesOrder', recordId: SO1, visibility: ['PARTNER', 'LINK'] })
  // The Owner's office note carries both (a holder may attach a priced file).
  const note = await call('owner', 'POST', `/threads/SalesOrder/${SO1}/notes`, { body: 'For the order file: the paper the customer signed and the logo.', attachments: [confirmation.id, artwork.id] })
  expect(note.status, note.raw).toBe(201)
  noteId = note.body.message.id
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('on a message: the priced file is locked for a reader who does not see prices', () => {
  it('the Sales worker and the Production manager see it counted and locked, never named; the plain file stays named; the Owner sees both', async () => {
    for (const session of ['salesWorker', 'productionManager']) {
      const thread = await call(session, 'GET', `/threads/SalesOrder/${SO1}`)
      expect(thread.status, `${session}: ${thread.raw}`).toBe(200)
      expect(thread.raw, session).not.toContain(CONFIRMATION)
      const message = messageOf(thread.body, noteId)
      expect(message.attachments, session).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: confirmation.id, originalName: '', locked: 'PRICED' }), expect.objectContaining({ id: artwork.id, originalName: ARTWORK })]),
      )
      expect(message.hiddenAttachments, session).toBeUndefined()
    }
    const asOwner = messageOf((await call('owner', 'GET', `/threads/SalesOrder/${SO1}`)).body, noteId)
    expect(asOwner.attachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: confirmation.id, originalName: CONFIRMATION })]))
    expect((asOwner.attachments as Json[]).find((file) => file.id === confirmation.id).locked).toBeUndefined()
  })
})

describe('as Sales worker: attaching the priced document anywhere is "File not found."', () => {
  const NOT_FOUND = { path: 'body/attachments/0', message: 'File not found.' }

  it('to a mail (email-out asks the threads’ check): refused, nothing queued; the Owner’s mail carries it', async () => {
    expect(template('sales')).toEqual(expect.arrayContaining(['email.send', 'threads.post']))
    const before = await outboundCount()
    const mail = await call('salesWorker', 'POST', `/threads/SalesOrder/${SO1}/emails`, { to: ['buyer.alpha@example.com'], subject: 'Your order', body: 'Here is the paper, with a copy to me.', cc: ['sales.copy@example.com'], attachments: [confirmation.id], sendOutside: true })
    expect(mail.status, mail.raw).toBe(400)
    expect(mail.body.error.issues).toContainEqual(NOT_FOUND)
    expect(mail.raw).not.toContain(CONFIRMATION)
    expect(await outboundCount()).toBe(before)
    const owners = await call('owner', 'POST', `/threads/SalesOrder/${SO1}/emails`, { to: ['buyer.alpha@example.com'], subject: 'Your order', body: 'Here is the paper.', attachments: [confirmation.id], sendOutside: true })
    expect(owners.status, owners.raw).toBe(201)
    expect(await outboundCount()).toBe(before + 1)
  })

  it('to an office note: refused in the same words (a portal reply to the customer asks the same check, attachmentProblems PARTNER)', async () => {
    const note = await call('salesWorker', 'POST', `/threads/SalesOrder/${SO1}/notes`, { body: 'Forwarding the paper.', attachments: [confirmation.id] })
    expect(note.status, note.raw).toBe(400)
    expect(note.body.error.issues).toEqual([NOT_FOUND])
    // The Production manager's note too; the plain artwork goes.
    expect((await call('productionManager', 'POST', `/threads/SalesOrder/${SO1}/notes`, { body: 'For the pattern room.', attachments: [confirmation.id] })).body.error?.issues).toEqual([NOT_FOUND])
    expect((await call('salesWorker', 'POST', `/threads/SalesOrder/${SO1}/notes`, { body: 'The logo, for the pattern room.', attachments: [artwork.id] })).status).toBe(201)
  })
})

describe('by link: a priced file is not sent by link by someone who does not see prices', () => {
  it('refused for a Planner (409 in words, the file never named), made by the Owner', async () => {
    const base = { purpose: 'DOCUMENT_VIEW', companyId: companyA, partyId: P1, email: 'buyer.alpha@example.com', send: false }
    const refused = await call('planner', 'POST', '/links/files', { ...base, fileIds: [artwork.id, confirmation.id] })
    expect(refused.status, refused.raw).toBe(409)
    expect(refused.body.error.issues).toEqual([
      { path: 'refusal/PRICED_BY_LINK', message: PRICED_WORDS.byLink.en },
      { path: 'body/fileIds/1', message: PRICED_WORDS.byLink.en },
    ])
    expect(refused.raw).not.toContain(CONFIRMATION)
    expect((await admin(`SELECT 1 FROM "LinkFile" WHERE "fileId" = $1`, [confirmation.id])).length).toBe(0)
    // The plain artwork alone goes by the Planner's link; the Owner sends the priced one.
    expect((await call('planner', 'POST', '/links/files', { ...base, fileIds: [artwork.id] })).status).toBe(201)
    const made = await call('owner', 'POST', '/links/files', { ...base, fileIds: [confirmation.id] })
    expect(made.status, made.raw).toBe(201)
    expect((await admin(`SELECT 1 FROM "LinkFile" WHERE "fileId" = $1`, [confirmation.id])).length).toBe(1)
  })
})

describe("the order's Files tab, its open route and its previews (readOfficeOrderFiles)", () => {
  it('as Sales worker: left out, counted as pricedLeftOut, never named; open is the unknown 404; no preview', async () => {
    const files = await call('salesWorker', 'GET', `/sales/orders/${SO1}/files`)
    expect(files.status, files.raw).toBe(200)
    expect(files.raw).not.toContain(CONFIRMATION)
    expect(files.raw).not.toContain(confirmation.id)
    const order = (files.body.groups as Json[]).find((group) => group.key === 'ORDER')!
    expect(order.pricedLeftOut).toBe(1)
    expect((order.files as Json[]).map((file) => file.id)).toContain(artwork.id)
    const open = await call('salesWorker', 'POST', `/sales/orders/${SO1}/files/${confirmation.id}/open`, {})
    expect([open.status, open.body.error?.message]).toEqual([404, 'File not found.'])
    const previews = await call('salesWorker', 'POST', `/sales/orders/${SO1}/files/previews`, { fileIds: [confirmation.id, artwork.id] })
    expect(previews.status, previews.raw).toBe(200)
    expect((previews.body.previews as Json[]).map((preview) => preview.fileId)).toEqual([artwork.id])
  })

  it('the Owner sees it named, opens it, gets its preview', async () => {
    const order = ((await call('owner', 'GET', `/sales/orders/${SO1}/files`)).body.groups as Json[]).find((group) => group.key === 'ORDER')!
    expect(order.pricedLeftOut).toBe(0)
    expect((order.files as Json[]).find((file) => file.id === confirmation.id)).toMatchObject({ name: CONFIRMATION })
    expect((await call('owner', 'POST', `/sales/orders/${SO1}/files/${confirmation.id}/open`, {})).status).toBe(200)
    expect(((await call('owner', 'POST', `/sales/orders/${SO1}/files/previews`, { fileIds: [confirmation.id] })).body.previews as Json[]).map((preview) => preview.fileId)).toEqual([confirmation.id])
  })
})

describe('search: a priced file’s name finds nothing', () => {
  it('the message index leaves the priced name out (for everyone); the plain name finds its message', async () => {
    await rebuildIndex(system(), indexers, { recordTypes: ['Message'], key: `priced-paths-${newId()}` })
    expect(await searchFor('ZQXCONFIRM')).toEqual([])
    expect(await searchFor('ZQXARTWORK')).toContain(noteId)
  })

  it('a mark reads the messages that carry the file again: the newly priced name is gone', async () => {
    const marked = await call('productionManager', 'POST', `/files/${artwork.id}/priced`, { priced: true, version: (await admin<{ version: number }>('SELECT version FROM "StoredFile" WHERE id = $1', [artwork.id]))[0]!.version })
    expect(marked.status, marked.raw).toBe(200)
    const [row] = await admin<{ id: string; payload: Json; companyId: string | null }>(`SELECT id, payload, "companyId" FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'file.priced_changed' AND subject = $2 ORDER BY "occurredAt" DESC LIMIT 1`, [T, artwork.id])
    expect(row).toBeDefined()
    // As the worker's search.index handler runs it.
    await indexEvent(system(), indexers, { eventId: row!.id, type: 'file.priced_changed', version: 1, tenantId: T, companyId: row!.companyId, siteId: null, subject: artwork.id, payload: row!.payload } as never)
    expect(await searchFor('ZQXARTWORK')).toEqual([])
  })
})
