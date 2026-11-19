import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { DOCUMENT_TYPES, pricedDocument } from '@nexus/factory-domain/documents/model'
import { sampleDocument } from '@nexus/factory-domain/documents/sample'
import { PRICED_WORDS } from '@nexus/factory-domain/files/priced'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { seedUuid, type SeedContext } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { companyLegalOf, storeDocumentPdf } from '../../../platform/documents/documents'
import { systemContext } from '../../../platform/outbox/system'
import { processFiles } from '../../../platform/files/service'
import { makeInvoiceFiles } from '../../invoicing/invoice-files'
import { prepareCorrectedFiles } from '../../invoicing/sdi/files'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * B-CP-015 (customer page plan, the money wall D6; review B1 "mark by DocumentType") — every priced document is born priced, and
 * the lead's addition (Owner pick O1, "Sales cannot send priced PDFs"): without the price grain a priced PDF is not made, mailed
 * or opened — 403 in words (files/priced PRICED_WORDS, the web's orders.json pricedPdf.held as the model), nothing made, nothing
 * mailed, nothing audited as sent, never a hint of the amount. The Owner passes.
 *
 * EVERY seed file in name order, as the seed CLI runs them (the export to Switzerland SEED-SH-0003 of the seeded customs, the
 * orders, quotes and issued invoices), on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security and every guard real); the real office sign-in for the Owner (a quote's mail carries its accept link; the export
 * desk's routes read the office clock), FAKE SES and the FAKE file store; a second app with test sessions: the Owner (every
 * permission and grain of the owner template), the Sales worker (the Sales template's permissions WITHOUT its grains: B-CP-011)
 * and the Production manager (its template; no money). Every company, party, name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/priced-documents`.
 */

let h: Harness
let app: FastifyInstance
let owner: Browser

const NS = 'cp015-priced-documents'
const id = (name: string): string => seedUuid(NS, name)
const lateId = (name: string): string => `ffffffff${id(name).slice(8)}`
const T = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  P1: id('party:P1'),
  jacket: id('product:style:JKT-01'),
  BLK: id('product:colourway:JKT-01:BLK'),
  RED: id('product:colourway:JKT-01:RED'),
  exportShipment: lateId('customs-export:shipment:SH-0003'),
  broker: lateId('customs:party:broker'),
}
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed/', import.meta.url))

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
let keys = 0
const key = (): string => `cp015-${process.pid}-${++keys}-${Date.now()}`
const pricedOf = async (fileId: string): Promise<boolean> => (await one<{ priced: boolean }>('SELECT priced FROM "StoredFile" WHERE id = $1', [fileId])).priced
const system = () => callerFor(h.database, systemContext(T.tenant, `cp015-${newId()}`))

const withGrains = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)]
}
// B-CP-015 (end-check fix): the Owner's test session is the Owner this file signs in (addUser below): a mail's sender is read from
// its User row (confirmation.ts "Your user was not found."), so a made-up actor id never reached the send.
let ownerId = ''
const office = (permissions: readonly Permission[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T.tenant, actorId, grants: [{ permissions: [...permissions], companies: 'all', sites: 'all', parties: 'all' } satisfies Grant] })
const SESSIONS: Record<string, () => SessionContext> = {
  owner: () => office(withGrains('owner'), ownerId),
  salesWorker: () => office(templateOf('sales')!.permissions),
  productionManager: () => office(templateOf('production_manager')!.permissions),
}
async function call(session: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: Json; raw: string; type: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(body === undefined ? {} : { payload: body as object }) })
  const type = response.headers['content-type']?.toString() ?? ''
  return { status: response.statusCode, body: type.startsWith('application/json') ? (response.json() as Json) : {}, raw: response.body, type }
}
const asOwner = async (method: 'GET' | 'POST', url: string, body?: unknown): Promise<Json> => {
  const answer = method === 'GET' ? await owner.get(url) : await owner.post(url, body ?? {}, { headers: { 'idempotency-key': key() } })
  expect([200, 201], `${method} ${url}: ${JSON.stringify(answer.body)}`).toContain(answer.status)
  return answer.body as Json
}
/** A 403 in words: the held refusal, no PDF, no amount. */
function expectHeld(answer: { status: number; body: Json; raw: string; type: string }, what: 'make' | 'send' | 'open'): void {
  expect(answer.status, answer.raw).toBe(403)
  expect(answer.type).toMatch(/^application\/json/)
  expect(answer.body.error.message).toBe(PRICED_WORDS[what].en)
  expect(answer.body.error.issues).toEqual([{ path: 'refusal/PRICED_DOCUMENT', message: PRICED_WORDS[what].en }])
  expect(answer.raw).not.toMatch(/\d+[.,]\d{2}\b|€/)
}

let orderId = ''
let quote: Json

beforeAll(async () => {
  h = await startHarness('cp015_priced_docs')
  h.clock.set(new Date())
  const context: SeedContext = { db: h.database, namespace: NS }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [T.tenant])
  const companies = await admin<{ id: string; code: string }>(`SELECT id, code FROM "Company" WHERE "tenantId" = $1 ORDER BY code`, [T.tenant])
  const tenant: TestTenant = { id: T.tenant, slug: NS, companies }
  const user = await addUser(h, tenant, { email: 'olga.owner.cp015@example.com', role: 'owner' })
  ownerId = user.id // B-CP-015 (end-check fix)
  owner = new Browser(h.app)
  const signed = await owner.signIn(NS, user.email, user.password)
  expect(signed.status, JSON.stringify(signed.body)).toBe(200)
  await enrolTotp(h, owner)
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  orderId = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0002'`, [T.tenant])).id
  // The Owner's quote for Brand Alpha (P1), two size-grid lines, still a draft (8 × 450 + 6 × 440, made up).
  const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))
  quote = (await asOwner('POST', '/sales/quotes', { companyId: T.companyA, partyId: T.P1, customerRef: 'RFQ-CP015', promiseDate: addDays(businessDate(new Date()), 60) })).quote
  quote = (await asOwner('POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: T.jacket, colourwayId: T.BLK, sizes: grid([['50', 2], ['52', 4], ['54', 2]]), unitPrice: '450' })).quote
  quote = (await asOwner('POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: T.jacket, colourwayId: T.RED, sizes: grid([['50', 1], ['52', 3], ['54', 2]]), unitPrice: '440' })).quote
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-CP-015: one rule, pricedDocument(type), at the generic store', () => {
  it('of every document type the priced ones are born priced; a DDT, a packing list and a purchase order are not', async () => {
    const caller = system()
    const company = await companyLegalOf(caller, T.companyA)
    for (const type of DOCUMENT_TYPES) {
      const { company: _company, sample: _sample, ...document } = sampleDocument(type, 'it', company, businessDate(new Date()))
      const { file } = await storeDocumentPdf(processFiles(), caller, { companyId: T.companyA, recordType: 'Company', recordId: T.companyA, document })
      expect([type, await pricedOf(file.id)]).toEqual([type, pricedDocument(type)])
      expect(file.priced, type).toBe(pricedDocument(type))
    }
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('the order confirmation: born priced; made and mailed only by someone who sees prices', () => {
  it('as Sales worker: making it and mailing it are 403 in words — nothing made, nothing mailed, nothing audited as sent', async () => {
    const before = {
      versions: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "GeneratedDocument" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND kind = 'ORDER_CONFIRMATION'`, [orderId])).n,
      mails: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "tenantId" = $1`, [T.tenant])).n,
      sent: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'orders.sendConfirmation'`, [T.tenant])).n,
      files: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1`, [orderId])).n,
    }
    expect(templateOf('sales')!.permissions).toContain('orders.manage')
    expectHeld(await call('salesWorker', 'POST', `/sales/orders/${orderId}/confirmation`, {}), 'make')
    expectHeld(await call('salesWorker', 'POST', `/sales/orders/${orderId}/confirmation/send`, { to: ['buyer.p1@example.com'] }), 'send')
    expect({
      versions: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "GeneratedDocument" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND kind = 'ORDER_CONFIRMATION'`, [orderId])).n,
      mails: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "tenantId" = $1`, [T.tenant])).n,
      sent: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'orders.sendConfirmation'`, [T.tenant])).n,
      files: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1`, [orderId])).n,
    }).toEqual(before)
  })

  it('the Owner makes it and mails it: its PDF is born priced; the Production manager gets 404 on it', async () => {
    const made = await call('owner', 'POST', `/sales/orders/${orderId}/confirmation`, {})
    expect(made.status, made.raw).toBe(201)
    expect(await pricedOf(made.body.fileId)).toBe(true)
    expect((await call('productionManager', 'GET', `/files/${made.body.fileId}`)).status).toBe(404)
    expect((await call('owner', 'GET', `/files/${made.body.fileId}`)).body.file).toMatchObject({ id: made.body.fileId, priced: true })
    const sent = await call('owner', 'POST', `/sales/orders/${orderId}/confirmation/send`, { to: ['buyer.p1@example.com'] })
    expect(sent.status, sent.raw).toBe(201)
    expect(await one(`SELECT 1 AS sent FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'orders.sendConfirmation' AND "recordId" = $2`, [T.tenant, orderId])).toEqual({ sent: 1 })
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('the quote: its PDF opened, sent and mailed again only by someone who sees prices; born priced', () => {
  it('as Sales worker: the preview, the send and a new link are 403 in words; the quote is unchanged', async () => {
    expect(templateOf('sales')!.permissions).toEqual(expect.arrayContaining(['quotes.view', 'quotes.send']))
    expectHeld(await call('salesWorker', 'GET', `/sales/quotes/${quote.id}/preview`), 'open')
    expectHeld(await call('salesWorker', 'POST', `/sales/quotes/${quote.id}/send`, { version: quote.version }), 'send')
    expectHeld(await call('salesWorker', 'POST', `/sales/quotes/${quote.id}/send-link`, { version: quote.version }), 'send')
    expect(await one(`SELECT status::text AS status, version FROM "Quote" WHERE id = $1`, [quote.id])).toEqual({ status: 'DRAFT', version: quote.version })
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordType" = 'Quote' AND "recordId" = $1`, [quote.id])).n).toBe(0)
  })

  it('the Owner previews it, sends it: the quote PDF is born priced, and the accept link still opens its own quote', async () => {
    const preview = await call('owner', 'GET', `/sales/quotes/${quote.id}/preview`)
    expect(preview.status, preview.raw.slice(0, 300)).toBe(200)
    expect(preview.type).toMatch(/^application\/pdf/)
    const before = h.ses.mails.length
    const sent = await owner.post(`/sales/quotes/${quote.id}/send`, { version: quote.version }, { headers: { 'idempotency-key': key() } })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    const [pdf] = await admin<{ id: string; priced: boolean }>(`SELECT id, priced FROM "StoredFile" WHERE "recordType" = 'Quote' AND "recordId" = $1 AND kind = 'FISCAL_ARCHIVE'`, [quote.id])
    expect(pdf).toMatchObject({ priced: true })
    expect((await call('salesWorker', 'GET', `/files/${pdf!.id}`)).status).toBe(404)
    // The customer's accept link opens its own quote's PDF (QUOTE_ACCEPT holds the price grain; its route reads its own file).
    const mail = h.ses.mails.slice(before).find((entry) => entry.outboundId === (sent.body as Json).sent?.emailId)
    expect(mail, 'the quote mail').toBeDefined()
    const token = decodeURIComponent(/#token=(\S+)/.exec(textOf(mail!.raw))?.[1] ?? '')
    const opened = await h.app.inject({ method: 'GET', url: '/link/quote/document', headers: { 'x-factory-link': token, 'user-agent': 'Mozilla/5.0 (Customer test browser)' } })
    expect(opened.statusCode, opened.body.slice(0, 300)).toBe(200)
    expect(opened.headers['content-type']).toMatch(/^application\/pdf/)
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('the invoice copy, its FatturaPA XML and the SDI copies are born priced', () => {
  it('the files of an issued invoice (made again here) and the corrected files of a send are priced', async () => {
    const [invoice] = await admin<{ id: string }>(`SELECT id FROM "Invoice" WHERE "tenantId" = $1 AND status::text <> 'DRAFT' AND number IS NOT NULL AND seller IS NOT NULL ORDER BY "issuedAt", id LIMIT 1`, [T.tenant])
    expect(invoice, 'an issued invoice of the seeds').toBeDefined()
    // Its files made again by the issue's own step (the seed wrote its rows by hand).
    await force(`UPDATE "Invoice" SET "xmlFileId" = NULL, "pdfFileId" = NULL WHERE id = $1`, [invoice!.id])
    const made = await makeInvoiceFiles(processFiles(), system(), invoice!.id)
    expect([await pricedOf(made.xmlFileId), await pricedOf(made.pdfFileId)]).toEqual([true, true])
    expect((await call('salesWorker', 'GET', `/files/${made.pdfFileId}`)).status).toBe(404)
    // A rejected invoice's corrected XML and copy (sdi/files.ts), before the send names them.
    const corrected = await prepareCorrectedFiles(processFiles(), system(), invoice!.id, '00099')
    expect([corrected.xml.priced, corrected.pdf.priced]).toEqual([true, true])
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('the export papers: the proforma, the commercial invoice and a pack with a priced part are born priced; the packing list is not', () => {
  it('made by the Owner for the seeded export to Switzerland (SEED-SH-0003)', async () => {
    await asOwner('POST', `/shipping/shipments/${T.exportShipment}/export/declaration`, { brokerPartyId: T.broker })
    await asOwner('POST', `/shipping/shipments/${T.exportShipment}/packing-list`, {})
    await asOwner('POST', `/shipping/shipments/${T.exportShipment}/export/commercial-invoice`, { language: 'en' })
    await asOwner('POST', '/shipping/proformas', { recordType: 'Shipment', recordId: T.exportShipment, language: 'en' })
    await asOwner('POST', `/shipping/shipments/${T.exportShipment}/pack`, { print: false })
    const kinds = await admin<{ kind: string; priced: boolean }>(
      `SELECT g.kind::text AS kind, bool_and(f.priced) AS priced FROM "GeneratedDocument" g JOIN "StoredFile" f ON f.id = g."fileId"
        WHERE g."recordType" = 'Shipment' AND g."recordId" = $1 GROUP BY g.kind ORDER BY g.kind`,
      [T.exportShipment],
    )
    const byKind = Object.fromEntries(kinds.map((row) => [row.kind, row.priced]))
    expect(byKind).toMatchObject({ COMMERCIAL_INVOICE: true, PROFORMA: true, SHIPMENT_PACK: true, PACKING_LIST: false })
    // The Production manager opens none of the priced ones.
    const priced = await admin<{ fileId: string }>(`SELECT g."fileId" FROM "GeneratedDocument" g WHERE g."recordType" = 'Shipment' AND g."recordId" = $1 AND g.kind::text IN ('COMMERCIAL_INVOICE', 'PROFORMA', 'SHIPMENT_PACK')`, [T.exportShipment])
    for (const row of priced) expect((await call('productionManager', 'GET', `/files/${row.fileId}`)).status, row.fileId).toBe(404)
  }, SLOW_TEST_TIMEOUT_MS)
})
