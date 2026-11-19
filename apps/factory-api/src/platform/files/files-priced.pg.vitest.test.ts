import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { PRICED_WORDS } from '@nexus/factory-domain/files/priced'
import { linkGrants } from '@nexus/factory-domain/links/purposes'
// The factory-db seeds and fixtures are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedParties } from '../../../../../packages/factory-db/seed/parties'
import { seed as seedProduct } from '../../../../../packages/factory-db/seed/product'
import { seed as seedSales } from '../../../../../packages/factory-db/seed/sales'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { seedSecondBrand, type SecondBrand } from '../../../../../packages/factory-db/src/testing/second-brand'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { systemContext } from '../outbox/system'
import { prepareFileCopy, recordGeneratedFile } from './files'
import { processFiles } from './service'

/**
 * B-CP-014 (customer page plan, the money wall: design 11 D6, L1, L6; review B1) — the priced-file lock core. Owner rule
 * (plan O1–O3): our prices are seen only by the Owner and the people he names. A file that shows prices (StoredFile.priced) opens
 * only for someone who sees prices; for everyone else it is as unknown as a wrong id (the file, its download, preview, versions,
 * history and every change by id), a record's list shows it LOCKED (`locked: PRICED`, counted, no name, no checksum), a copy's
 * origin loses its name. The tick at upload files it priced (never for a floor); anyone who reaches the record marks it, only
 * someone who sees prices takes the mark off; the mark reaches every version; Use on, a new version and a module's copy (the
 * archive and SDI copies, the price list mailed to a customer) stay priced. A portal or link session opens one through its own
 * capped price grain (the brand's Buyer, a DOCUMENT_VIEW link); the brand wall stays first: Brand Beta never learns that an Alpha
 * file exists.
 *
 * As Sales worker: the Sales template's permissions WITHOUT its grains (Owner pick O1, B-CP-011: Sales sees no prices), as
 * Production manager and Planner: their templates (no money). Two brands of one tenant: P1 (the seeds' customer, its order
 * SEED-SO-0001: Brand Alpha) and the second brand (SEED-SO-B001: Brand Beta). Every name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/files/files-priced`.
 */

let h: Harness
let app: FastifyInstance
let second: SecondBrand
const NS = 'files-priced'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const siteA = seedUuid(NS, 'site:A1')
const P1 = seedUuid(NS, 'party:P1')
const SO1 = seedUuid(NS, 'sales:SO1')
const Q1 = seedUuid(NS, 'link:P1:record')
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const FILES: Permission[] = ['files.read', 'files.upload', 'files.manage', 'files.delete', 'threads.read', 'threads.post']
const office = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions: [...permissions], companies: 'all', sites: 'all', parties }] })
const template = (key: string): readonly Permission[] => templateOf(key)!.permissions
const partner = (partyId: () => string, permissions: Permission[]): SessionContext => ({ audience: 'partner', tenantId: T, actorId: newId(), partyId: partyId(), grants: [{ permissions, companies: 'all', sites: 'all', parties: 'all' }] })
const link = (purpose: 'DOCUMENT_VIEW' | 'RECORD_INVITE'): SessionContext => ({ audience: 'link', tenantId: T, linkId: newId(), partyId: P1, record: { type: 'SalesOrder', id: SO1 }, grants: linkGrants(purpose, { companyId: companyA, partyId: P1 }) })
const SESSIONS: Record<string, () => SessionContext> = {
  // The Owner (and the people he names): every file right and the price grain.
  owner: () => office([...FILES, 'money.price']),
  // Sales after O1: its template's permissions, no grain. The production manager and the planner as their templates make them.
  salesWorker: () => office(template('sales')),
  productionManager: () => office(template('production_manager')),
  planner: () => office(template('planner')),
  // Every file right and the price grain, but only for Brand Beta (RoleAssignment.partyIds).
  betaOnly: () => office([...FILES, 'money.price'], [second.partyId]),
  // Brand Alpha's portal: its Buyer (the partner price grain) and its Designer (none); Brand Beta's Buyer.
  alphaBuyer: () => partner(() => P1, ['files.read', 'money.price']),
  alphaDesigner: () => partner(() => P1, ['files.read']),
  betaBuyer: () => partner(() => second.partyId, ['files.read', 'money.price']),
  // A link of Brand Alpha's order: DOCUMENT_VIEW holds the price grain (the party's own documents), RECORD_INVITE none.
  documentLink: () => link('DOCUMENT_VIEW'),
  inviteLink: () => link('RECORD_INVITE'),
}

async function call(session: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `priced-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  const json = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body: json, raw: response.body }
}
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up document of the priced-file test: ${text}`)
const sha = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const announce = (session: string, body: Buffer, input: Json) => call(session, 'POST', '/files', { companyId: companyA, kind: 'DOCUMENT', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body), ...input })
async function uploaded(session: string, name: string, input: Json): Promise<Json> {
  const body = pdf(name)
  const announced = await announce(session, body, { originalName: name, ...input })
  expect(announced.status, announced.raw).toBe(201)
  expect((await app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: body })).statusCode).toBe(200)
  const done = await call(session, 'POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, done.raw).toBe(200)
  return done.body.file
}
const pricedOf = async (fileId: string): Promise<boolean> => (await admin<{ priced: boolean }>('SELECT priced FROM "StoredFile" WHERE id = $1', [fileId]))[0]!.priced
const versionOf = async (fileId: string): Promise<number> => (await admin<{ version: number }>('SELECT version FROM "StoredFile" WHERE id = $1', [fileId]))[0]!.version
const listOf = async (session: string, recordType: string, recordId: string): Promise<Json[]> => {
  const answer = await call(session, 'GET', `/files?recordType=${recordType}&recordId=${recordId}`)
  expect(answer.status, answer.raw).toBe(200)
  return answer.body.files as Json[]
}

const CONFIRMATION = 'Brand Alpha order confirmation SO-A1 v1.pdf'
const ARTWORK = 'Brand Alpha logo artwork AX-1.pdf'
const BETA_PO = 'Brand Beta purchase order PO-B7.pdf'
let confirmation: Json
let artwork: Json
let betaPo: Json
const NO_PRICES = ['salesWorker', 'productionManager', 'planner'] as const

beforeAll(async () => {
  h = await startHarness('files_cp014_priced')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedNumbering, seedParties, seedFiles, seedProduct, seedSales]) await seed({ db: h.database, namespace: NS })
  second = await seedSecondBrand({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  // A priced document of Brand Alpha's order, shared with its portal and its links (the record's own party: B-TH-003), ticked at
  // upload by the Owner; a plain artwork beside it; Brand Beta's own priced PO on its order.
  confirmation = await uploaded('owner', CONFIRMATION, { recordType: 'SalesOrder', recordId: SO1, visibility: ['PARTNER', 'LINK'], priced: true })
  artwork = await uploaded('owner', ARTWORK, { recordType: 'SalesOrder', recordId: SO1, visibility: ['PARTNER'] })
  betaPo = await uploaded('owner', BETA_PO, { recordType: 'SalesOrder', recordId: second.salesOrderId, visibility: ['PARTNER'], priced: true })
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-CP-014: the tick files a priced document', () => {
  it('an upload with the tick is priced (the Owner sees the flag); a plain one is not', async () => {
    expect(confirmation).toMatchObject({ originalName: CONFIRMATION, priced: true, status: 'AVAILABLE', visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: P1 })
    expect(confirmation.locked).toBeUndefined()
    expect(await pricedOf(confirmation.id)).toBe(true)
    expect(artwork.priced).toBe(false)
    expect(await pricedOf(artwork.id)).toBe(false)
  })

  it('refused in words for a floor: a priced document is never shared with a floor', async () => {
    const refused = await announce('owner', pdf('floor'), { originalName: 'Priced for the floor.pdf', recordType: 'SalesOrder', recordId: SO1, visibility: ['FLOOR'], floorSiteId: siteA, priced: true })
    expect(refused.status, refused.raw).toBe(400)
    expect(refused.body.error.issues).toContainEqual({ path: 'body/priced', message: PRICED_WORDS.floor.en })
  })
})

describe('as Sales worker / as Production manager / as Planner: 404 like a wrong id, a counted PRICED lock only', () => {
  it('the file, its download, preview, versions and history answer 404 and never its name; the Owner opens them', async () => {
    for (const session of NO_PRICES) {
      for (const url of [`/files/${confirmation.id}`, `/files/${confirmation.id}/download`, `/files/${confirmation.id}/preview`, `/files/${confirmation.id}/versions`, `/files/${confirmation.id}/history`]) {
        const answer = await call(session, 'GET', url)
        expect([answer.status, answer.body.error?.message], `${session} ${url}`).toEqual([404, 'File not found.'])
        expect(answer.raw).not.toContain(CONFIRMATION)
      }
      // A made-up id answers the same.
      expect((await call(session, 'GET', `/files/${newId()}`)).body.error?.message).toBe('File not found.')
    }
    expect((await call('owner', 'GET', `/files/${confirmation.id}`)).body.file).toMatchObject({ id: confirmation.id, originalName: CONFIRMATION, priced: true })
    for (const url of [`/files/${confirmation.id}/download`, `/files/${confirmation.id}/preview`, `/files/${confirmation.id}/versions`, `/files/${confirmation.id}/history`]) {
      expect((await call('owner', 'GET', url)).status, url).toBe(200)
    }
  })

  it('the record list shows "1 priced document": counted, locked, no name and no checksum; the plain file stays named', async () => {
    for (const session of NO_PRICES) {
      const files = await listOf(session, 'SalesOrder', SO1)
      expect(JSON.stringify(files), session).not.toContain(CONFIRMATION)
      expect(JSON.stringify(files), session).not.toContain(confirmation.sha256)
      const locked = files.filter((file) => file.locked === 'PRICED')
      expect(locked, session).toEqual([expect.objectContaining({ id: confirmation.id, originalName: '', sha256: '', priced: true, kind: 'DOCUMENT' })])
      expect(files.find((file) => file.id === artwork.id), session).toMatchObject({ originalName: ARTWORK })
    }
    const asOwner = (await listOf('owner', 'SalesOrder', SO1)).find((file) => file.id === confirmation.id)
    expect(asOwner).toMatchObject({ originalName: CONFIRMATION, sha256: confirmation.sha256, priced: true })
    expect(asOwner!.locked).toBeUndefined()
  })

  it('every change by id is as unknown: a tag, a carry, a new version (the Sales worker holds files.upload)', async () => {
    expect(template('sales')).toContain('files.upload')
    const asked = [
      await call('salesWorker', 'PUT', `/files/${confirmation.id}/document`, { category: 'OTHER', version: confirmation.version }),
      await call('salesWorker', 'POST', `/files/${confirmation.id}/use-on`, { recordType: 'Quote', recordId: Q1 }),
      await call('salesWorker', 'POST', `/files/${confirmation.id}/versions`, { originalName: 'v2.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: sha(pdf('v2')) }),
      await call('salesWorker', 'GET', `/files/${confirmation.id}/use-on/targets?q=SEED`),
    ]
    for (const answer of asked) {
      expect([answer.status, answer.body.error?.message]).toEqual([404, 'File not found.'])
      expect(answer.raw).not.toContain(CONFIRMATION)
    }
    // The record's documents never offer it to them (the list shows the lock instead).
    const documents = await call('salesWorker', 'GET', `/files/documents?recordType=SalesOrder&recordId=${SO1}`)
    expect(documents.status, documents.raw).toBe(200)
    expect((documents.body.documents as Json[]).map((document) => document.fileId)).not.toContain(confirmation.id)
    expect(documents.raw).not.toContain(CONFIRMATION)
  })
})

describe('portal and link sessions: their own capped price grain; the brand wall first', () => {
  it("Brand Alpha's Buyer opens its priced document; its Designer gets 404 and a counted lock", async () => {
    expect((await call('alphaBuyer', 'GET', `/files/${confirmation.id}`)).body.file).toMatchObject({ id: confirmation.id, originalName: CONFIRMATION })
    expect((await call('alphaBuyer', 'GET', `/files/${confirmation.id}/download`)).status).toBe(200)
    for (const url of [`/files/${confirmation.id}`, `/files/${confirmation.id}/download`, `/files/${confirmation.id}/preview`, `/files/${confirmation.id}/versions`]) {
      const answer = await call('alphaDesigner', 'GET', url)
      expect([answer.status, answer.body.error?.message], url).toEqual([404, 'File not found.'])
    }
    const files = await listOf('alphaDesigner', 'SalesOrder', SO1)
    expect(JSON.stringify(files)).not.toContain(CONFIRMATION)
    expect(files.find((file) => file.id === confirmation.id)).toMatchObject({ locked: 'PRICED', originalName: '', sha256: '' })
  })

  it('a DOCUMENT_VIEW link (the price grain) opens the order’s priced document; a RECORD_INVITE link (none) gets 404', async () => {
    expect((await call('documentLink', 'GET', `/files/${confirmation.id}`)).body.file).toMatchObject({ originalName: CONFIRMATION })
    expect((await call('inviteLink', 'GET', `/files/${confirmation.id}`)).status).toBe(404)
  })

  it('Brand Beta never learns that an Alpha file exists: 404 as a wrong id, nothing in its lists (a portal and an office person of Beta)', async () => {
    for (const session of ['betaBuyer', 'betaOnly']) {
      for (const url of [`/files/${confirmation.id}`, `/files/${confirmation.id}/download`, `/files/${artwork.id}`]) {
        const answer = await call(session, 'GET', url)
        expect([answer.status, answer.body.error?.message], `${session} ${url}`).toEqual([404, 'File not found.'])
      }
      const listed = await call(session, 'GET', `/files?recordType=SalesOrder&recordId=${SO1}`)
      expect(listed.raw, session).not.toContain(confirmation.id)
      expect(listed.raw, session).not.toContain(CONFIRMATION)
    }
    // Beta's own priced PO: its Buyer and Beta's office person open it.
    expect((await call('betaBuyer', 'GET', `/files/${betaPo.id}`)).body.file).toMatchObject({ originalName: BETA_PO })
    expect((await call('betaOnly', 'GET', `/files/${betaPo.id}`)).body.file).toMatchObject({ originalName: BETA_PO })
  })
})

describe('the mark: anyone who reaches the record marks; only someone who sees prices takes it off', () => {
  it('a Planner marks the artwork (the answer is the lock), cannot take the mark off (403 in words); the Owner takes it off', async () => {
    const marked = await call('planner', 'POST', `/files/${artwork.id}/priced`, { priced: true, version: artwork.version })
    expect(marked.status, marked.raw).toBe(200)
    expect(marked.body.file).toMatchObject({ id: artwork.id, locked: 'PRICED', originalName: '', sha256: '', priced: true })
    expect(marked.raw).not.toContain(ARTWORK)
    expect(await pricedOf(artwork.id)).toBe(true)
    // The record's file panels hear of it (no name, no amount).
    const [event] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'file.priced_changed' AND subject = $2 ORDER BY "occurredAt" DESC LIMIT 1`, [T, artwork.id])
    expect(event!.payload).toMatchObject({ fileId: artwork.id, recordType: 'SalesOrder', recordId: SO1, priced: true, fileIds: [artwork.id], partyId: P1 })
    expect(JSON.stringify(event!.payload)).not.toContain(ARTWORK)
    // Now the planner reads it as every priced file: 404, locked in the list.
    expect((await call('planner', 'GET', `/files/${artwork.id}`)).status).toBe(404)

    const unmark = await call('planner', 'POST', `/files/${artwork.id}/priced`, { priced: false, version: await versionOf(artwork.id) })
    expect(unmark.status, unmark.raw).toBe(403)
    expect(unmark.body.error.issues).toEqual([{ path: 'refusal/PRICED_UNMARK', message: PRICED_WORDS.unmark.en }])
    expect(await pricedOf(artwork.id)).toBe(true)

    const off = await call('owner', 'POST', `/files/${artwork.id}/priced`, { priced: false, version: await versionOf(artwork.id) })
    expect(off.status, off.raw).toBe(200)
    expect(off.body.file).toMatchObject({ originalName: ARTWORK, priced: false })
    expect(await pricedOf(artwork.id)).toBe(false)
    expect((await call('planner', 'GET', `/files/${artwork.id}`)).body.file).toMatchObject({ originalName: ARTWORK })
    // Both moves are audited on the file.
    expect((await admin(`SELECT 1 FROM "AuditLog" WHERE "recordType" = 'StoredFile' AND "recordId" = $1 AND action = 'files.setPriced'`, [artwork.id])).length).toBe(2)
  })

  it('a stale version is refused; a file of another brand is as unknown to a person who does not reach it', async () => {
    const stale = await call('owner', 'POST', `/files/${artwork.id}/priced`, { priced: true, version: 1 })
    expect(stale.status).toBe(409)
    expect(await pricedOf(artwork.id)).toBe(false)
    const alphaOnly = await call('betaOnly', 'POST', `/files/${artwork.id}/priced`, { priced: true, version: await versionOf(artwork.id) })
    expect([alphaOnly.status, alphaOnly.body.error?.message]).toEqual([404, 'File not found.'])
  })
})

describe('the flag is carried: Use on, a new version, a module’s copy, and the mark reaches every version', () => {
  it('Use on carries the flag (onto the customer’s quote and an internal record); the copy is locked for the Sales worker', async () => {
    const onQuote = await call('owner', 'POST', `/files/${confirmation.id}/use-on`, { recordType: 'Quote', recordId: Q1, visibility: ['PARTNER'] })
    expect(onQuote.status, onQuote.raw).toBe(201)
    expect(onQuote.body.file).toMatchObject({ recordType: 'Quote', recordId: Q1, sourceFileId: confirmation.id, priced: true })
    expect(await pricedOf(onQuote.body.file.id)).toBe(true)
    const internal = await call('owner', 'POST', `/files/${confirmation.id}/use-on`, { recordType: 'Company', recordId: companyA })
    expect(internal.status, internal.raw).toBe(201)
    expect(await pricedOf(internal.body.file.id)).toBe(true)
    expect((await call('salesWorker', 'GET', `/files/${onQuote.body.file.id}`)).status).toBe(404)
    const quoteFiles = await listOf('salesWorker', 'Quote', Q1)
    const copy = quoteFiles.find((file) => file.id === onQuote.body.file.id)
    expect(copy).toMatchObject({ locked: 'PRICED', originalName: '' })
    // Its origin names no priced source either.
    if (copy?.origin) expect(copy.origin.originalName).toBe('')
    expect(JSON.stringify(quoteFiles)).not.toContain(CONFIRMATION)
  })

  it('a new version of a priced document is born priced', async () => {
    const body = pdf('confirmation v2')
    const asked = await call('owner', 'POST', `/files/${confirmation.id}/versions`, { originalName: 'Brand Alpha order confirmation SO-A1 v2.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) })
    expect(asked.status, asked.raw).toBe(201)
    expect(asked.body.file).toMatchObject({ versionNo: 2, seriesId: confirmation.id, priced: true })
    expect((await app.inject({ method: 'PUT', url: asked.body.upload.url, headers: asked.body.upload.headers, payload: body })).statusCode).toBe(200)
    expect((await call('owner', 'POST', `/files/${asked.body.file.id}/complete`)).status).toBe(200)
    expect(await pricedOf(asked.body.file.id)).toBe(true)
    expect((await call('productionManager', 'GET', `/files/${asked.body.file.id}`)).status).toBe(404)
  })

  it('a module’s copy (prepareFileCopy: the archive and SDI copies, a price list mailed to a customer) stays priced', async () => {
    const system = callerFor(h.database, systemContext(T, `files-priced-${newId()}`))
    const prepared = await prepareFileCopy(processFiles(), system, confirmation.id, { companyId: companyA, recordType: 'Company', recordId: companyA, kind: 'DOCUMENT' })
    expect(prepared.priced).toBe(true)
    const { result } = await command(system, { name: 'files.storeGenerated', input: { copyOf: confirmation.id } }, (tools) => recordGeneratedFile(tools, prepared))
    expect(result).toMatchObject({ sourceFileId: confirmation.id, priced: true })
    expect(await pricedOf(result.id)).toBe(true)
  })

  it('a mark reaches every version of the series and the copies made of them; taking it off reaches the series only', async () => {
    // A plain document with a second version and a carried copy.
    const plain = await uploaded('owner', 'Brand Alpha delivery note draft.pdf', { recordType: 'SalesOrder', recordId: SO1 })
    const body = pdf('delivery note draft v2')
    const asked = await call('owner', 'POST', `/files/${plain.id}/versions`, { originalName: 'Brand Alpha delivery note draft v2.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) })
    expect(asked.status, asked.raw).toBe(201)
    expect((await app.inject({ method: 'PUT', url: asked.body.upload.url, headers: asked.body.upload.headers, payload: body })).statusCode).toBe(200)
    expect((await call('owner', 'POST', `/files/${asked.body.file.id}/complete`)).status).toBe(200)
    const carried = await call('owner', 'POST', `/files/${asked.body.file.id}/use-on`, { recordType: 'Company', recordId: companyA })
    expect(carried.status, carried.raw).toBe(201)
    expect(await pricedOf(carried.body.file.id)).toBe(false)

    // The planner marks the FIRST version (now superseded): the series and the copy are priced.
    const marked = await call('planner', 'POST', `/files/${plain.id}/priced`, { priced: true, version: await versionOf(plain.id) })
    expect(marked.status, marked.raw).toBe(200)
    for (const fileId of [plain.id, asked.body.file.id, carried.body.file.id]) expect(await pricedOf(fileId), fileId).toBe(true)
    const [event] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'file.priced_changed' AND subject = $2`, [T, plain.id])
    expect([...event!.payload.fileIds].sort()).toEqual([plain.id, asked.body.file.id, carried.body.file.id].sort())

    // The Owner takes it off the current version: its series opens again, the copy on the other record keeps its lock.
    const off = await call('owner', 'POST', `/files/${asked.body.file.id}/priced`, { priced: false, version: await versionOf(asked.body.file.id) })
    expect(off.status, off.raw).toBe(200)
    expect([await pricedOf(plain.id), await pricedOf(asked.body.file.id), await pricedOf(carried.body.file.id)]).toEqual([false, false, true])
  })
})
