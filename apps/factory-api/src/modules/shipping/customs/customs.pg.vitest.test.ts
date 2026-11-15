import { createHash } from 'node:crypto'
import PDFDocument from 'pdfkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReturns } from '../../../../../../packages/factory-db/seed/returns'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { callerFor } from '../../../core/command'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { systemContext } from '../../../platform/outbox/system'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { pdfPages } from '../shipment-pack/pdf-merge'
import { exitProofFindings } from './alerts'

/**
 * Export and customs (B-W2b-409; LOG-086, LOG-087, LOG-088, LOG-089, LOG-095, LOG-097) on the local stack: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants, B-W2b-372's
 * …_delivery_customs_w2b_guards real), the factory-db seeds of one tenant up to returns (SH-0001 that left with DDT 144, its
 * TD01 sample invoice and TD24 draft), real office sign-in with two-factor for the step-up, the real link authenticator, FAKE
 * SES and the local file store. SH-0001 is sent to a made-up workshop in Switzerland (its ship-to moved there). Every name and
 * number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/shipping/customs`.
 *
 *   tab         the Export tab says only an export needs papers ("not needed" in Italy), and why a paper is held
 *   EORI        each company's own, normalised; refused when it is not one
 *   papers      the commercial invoice (HS code, origin, values, EORI, the export notice) and the CN 23 of a heavy parcel; a
 *               CN 22 refused over its limit; one version per contents; their PDFs behind the price grain
 *   declaration opened with its broker once; removed while its pack is merely sent (its links revoked)
 *   pack        the parts in words, one merged PDF, a link only while the site's switch is ON (a step-up), mailed to the
 *               broker; the broker downloads a paper and types the MRN back once: FILED
 *   exit        the alert past the declaration's days; the invoice named once; the exit with its proof: EXITED, the alert cleared
 */

let h: Harness
const NS = 'customs-409'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const siteA1 = seedUuid(NS, 'site:A1')
const partyP1 = seedUuid(NS, 'party:P1')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
const BROKER = newId()
const BROKER_MAIL = 'dogana@broker.example.com'

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const asReplica = async (work: () => Promise<unknown>) => {
  await admin('SET session_replication_role = replica')
  try {
    await work()
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const outbox = async (type: string, subject: string) => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = $1 AND subject = $2`, [type, subject])).n

let keys = 0
const key = () => `w2b409-${process.pid}-${++keys}-${Date.now()}`
const linkCall = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'DemoPhone/1.0', ...(method === 'POST' ? { 'idempotency-key': key() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')

let desk: Browser
let dock: Browser
let viewer: Browser
let deskSecret: string
const cookieOf = (browser: Browser) => [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
const post = (browser: Browser, url: string, body: unknown = {}) => browser.post(url, body, { headers: { 'idempotency-key': key() } })
async function send(browser: Browser, method: 'PUT' | 'DELETE' | 'GET', url: string, body?: unknown) {
  const response = await h.app.inject({ method, url, headers: { cookie: cookieOf(browser), 'x-csrf-token': browser.csrfToken ?? '', ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return response
}

async function officeBrowser(email: string, role: string): Promise<Browser> {
  await addUser(h, tenant, { email, role })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(NS, email, 'quiet-harbour-lantern-58')
  expect(signed.status, JSON.stringify(signed.body)).toBe(200)
  return browser
}

/** A real one-page PDF with made-up words (the merged pack reads its pages). */
async function realPdf(text: string): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', compress: false, info: { CreationDate: new Date(0) } })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve) => pdf.on('end', () => resolve()))
  pdf.text(text)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

/** A file uploaded through the generic files routes (announced, sent, completed): its id. */
async function upload(browser: Browser, recordType: string, recordId: string, name: string, body: Buffer): Promise<string> {
  const announced = await post(browser, '/files', { companyId: companyA, recordType, recordId, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  const put = await h.app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: body })
  expect(put.statusCode, put.body).toBe(200)
  const done = await post(browser, `/files/${announced.body.file.id}/complete`)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return announced.body.file.id as string
}

let SH1: string
let SH2: string
let styleId: string
let sampleInvoice: string
let draftInvoice: string

beforeAll(async () => {
  h = await startHarness('customs_409')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  const seeded = await seedReturns({ db: h.database, namespace: NS })
  SH1 = seeded.money.shipping.shipmentId
  SH2 = seeded.money.shipping.draftShipmentId
  sampleInvoice = seeded.money.sampleInvoiceId
  draftInvoice = seeded.money.draftInvoiceId
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const sesId = newId()
    await client.integrationAccount.create({ data: { id: sesId, provider: 'SES', code: 'ses-409', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    for (const kind of ['NOTIFICATION', 'CONVERSATION'] as const) {
      await client.emailIdentity.create({
        data: { id: newId(), companyId: companyA, kind, domain, fromAddress: `${kind.toLowerCase()}@${domain}`, displayName: 'Demo A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId: sesId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
      })
    }
  })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  // Company A's complete letterhead (made up) and no EORI yet.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001', eori = NULL WHERE id = $1`, [companyA])
  // SH-0001 goes to a made-up workshop in Switzerland and left three days ago; its parcels weigh 1.5 and 2.5 kg.
  await asReplica(async () => {
    await admin(`UPDATE "Shipment" SET "shipTo" = jsonb_build_object('name', 'Demo Moto Werkstatt', 'line1', 'Teststrasse 1', 'postalCode', '8001', 'city', 'Zürich', 'country', 'CH'), "packedAt" = now() - interval '4 days', "shippedAt" = now() - interval '3 days' WHERE id = $1`, [SH1])
    const parcels = await admin<{ id: string }>(`SELECT id FROM "Parcel" WHERE "shipmentId" = $1 ORDER BY seq`, [SH1])
    for (const [index, parcel] of parcels.entries()) await admin(`UPDATE "Parcel" SET "grossWeightKg" = $1 WHERE id = $2`, [index === 0 ? '1.5' : '2.5', parcel.id])
    // Every garment of SH-0001 in a parcel (the CN forms say what each holds).
    await admin(`UPDATE "ShipmentLine" l SET "parcelId" = (SELECT p.id FROM "Parcel" p WHERE p."shipmentId" = l."shipmentId" ORDER BY p.seq LIMIT 1) WHERE l."shipmentId" = $1 AND l."parcelId" IS NULL`, [SH1])
  })
  styleId = (await one<{ id: string }>(`SELECT w."styleId" AS id FROM "ShipmentLine" l JOIN "WorkOrder" w ON w.id = l."workOrderId" WHERE l."shipmentId" = $1 LIMIT 1`, [SH1])).id
  await admin(`UPDATE "Style" SET "hsCode" = NULL, "originCountry" = NULL, "netMassKg" = NULL WHERE id = $1`, [styleId])
  // A made-up customs broker (a carrier party of the company) with its contact.
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency, language) VALUES ($1, $2, $3, 'BRK-409', 'ORGANISATION', 'Demo Dogana S.r.l.', '{CARRIER}', 'ACTIVE', 'IT', 'EUR', 'it')`, [BROKER, T, companyA])
  await admin(`INSERT INTO "PartyContact" (id, "tenantId", "partyId", name, email, roles, status) VALUES ($1, $2, $3, 'Demo Doganalista', $4, '{}', 'ACTIVE')`, [newId(), T, BROKER, BROKER_MAIL])
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains, "requireMfa") VALUES ($1, $2, 'desk-409', 'Export desk (test)', $3, '{price}', false), ($4, $2, 'dock-409', 'Dock (test)', $5, '{}', false), ($6, $2, 'viewer-409', 'Viewer (test)', $7, '{}', false)`, [
    newId(),
    T,
    ['home.view', 'shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.customs.manage', 'shipping.settings.view', 'shipping.settings.manage', 'files.read', 'files.upload'],
    newId(),
    ['home.view', 'shipping.view', 'shipping.customs.manage', 'files.read', 'files.upload'],
    newId(),
    ['home.view', 'shipping.view', 'shipping.settings.view'],
  ])
  desk = await officeBrowser('erica.export.409@example.com', 'desk-409')
  dock = await officeBrowser('dario.dock.409@example.com', 'dock-409')
  viewer = await officeBrowser('vera.viewer.409@example.com', 'viewer-409')
  deskSecret = await enrolTotp(h, desk)
}, 300_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('the Export tab (design warehouse.shipments › Export)', () => {
  it('needs papers only for goods leaving the EU; says why a paper is held now', async () => {
    const tab = await viewer.get(`/shipping/shipments/${SH1}/export`)
    expect(tab.status, JSON.stringify(tab.body)).toBe(200)
    expect(tab.body).toMatchObject({ needed: true, destination: { country: 'CH', class: 'EXPORT' }, eori: null, declaration: null, declarationHeld: 'NO_EORI', mayManage: false, seesValues: false })
    expect(tab.body.papers).toMatchObject({ held: 'NO_EORI', commercialInvoice: [], postalForm: { versions: [] } })
    const domestic = await desk.get(`/shipping/shipments/${SH2}/export`)
    expect(domestic.body).toMatchObject({ needed: false, destination: { class: 'DOMESTIC' }, papers: { held: 'NOT_EXPORT' } })
    const refused = await post(desk, `/shipping/shipments/${SH2}/export/commercial-invoice`)
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('refusal/NOT_EXPORT')
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('EORI per company (LOG-095)', () => {
  it("keeps each company's EORI, normalised; refuses one that is not; a reader cannot write it", async () => {
    const read = await desk.get(`/shipping/companies/${companyA}/customs`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.company).toMatchObject({ eori: null, mayManage: true })
    expect(read.body.sites.find((site: Json) => site.siteId === siteA1)).toMatchObject({ brokerPackOn: false, hasSettings: true })
    const version = read.body.company.version
    expect((await send(desk, 'PUT', `/shipping/companies/${companyA}/eori`, { eori: 'X1!', version })).statusCode).toBe(400)
    expect((await send(viewer, 'PUT', `/shipping/companies/${companyA}/eori`, { eori: 'IT00000003038', version })).statusCode).toBe(403)
    const set = await send(desk, 'PUT', `/shipping/companies/${companyA}/eori`, { eori: ' it 0000.0003038 ', version })
    expect(set.statusCode, set.body).toBe(200)
    expect(set.json()).toMatchObject({ changed: true, settings: { company: { eori: 'IT00000003038' } } })
    expect(await outbox('customs.settings_changed', companyA)).toBe(1)
    const audit = await one<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'Company' AND "recordId" = $1 AND action = 'shipping.setEori'`, [companyA])
    expect(audit).toEqual({ before: { eori: null }, after: { eori: 'IT00000003038' } })
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('the commercial invoice (LOG-086)', () => {
  it('is refused while a style has no HS code or origin, in words naming it', async () => {
    const refused = await post(desk, `/shipping/shipments/${SH1}/export/commercial-invoice`)
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('refusal/CUSTOMS_DATA')
    expect(refused.body.error.message).toMatch(/no HS code and no country of origin/)
    await admin(`UPDATE "Style" SET "hsCode" = '420310', "originCountry" = 'IT', "netMassKg" = 1.2 WHERE id = $1`, [styleId])
  }, SLOW_TEST_TIMEOUT_MS)

  it('needs the price grain; made once per contents, with its EORI, HS code, origin and the export notice', async () => {
    expect((await post(dock, `/shipping/shipments/${SH1}/export/commercial-invoice`)).status).toBe(403)
    const made = await post(desk, `/shipping/shipments/${SH1}/export/commercial-invoice`, { language: 'en' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.document).toMatchObject({ kind: 'COMMERCIAL_INVOICE', version: 1, number: 'SEED-SH-0001', language: 'en', made: true, current: true })
    const again = await post(desk, `/shipping/shipments/${SH1}/export/commercial-invoice`, { language: 'en' })
    expect(again.status).toBe(200)
    expect(again.body.document).toMatchObject({ documentId: made.body.document.documentId, made: false })
    const pdf = await send(desk, 'GET', `/shipping/shipments/${SH1}/export/documents/${made.body.document.documentId}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    const text = pdfFlatText(pdf.rawPayload)
    for (const words of ['Commercial invoice (for customs)', 'IT00000003038', 'HS 420310', 'Origin IT', 'Non-taxable for VAT', 'Switzerland']) expect(text).toContain(words)
    expect((await send(dock, 'GET', `/shipping/shipments/${SH1}/export/documents/${made.body.document.documentId}/pdf`)).statusCode).toBe(403)
    expect(await outbox('customs.document_made', SH1)).toBe(1)
    const row = await one<{ kind: string; layout: string; visibility: string[] }>(`SELECT g.kind::text AS kind, g.layout, f.visibility::text[] AS visibility FROM "GeneratedDocument" g JOIN "StoredFile" f ON f.id = g."fileId" WHERE g.id = $1`, [made.body.document.documentId])
    expect(row).toEqual({ kind: 'COMMERCIAL_INVOICE', layout: 'COMMERCIAL_INVOICE/1', visibility: ['OFFICE'] })
    // B-W2b-391's one PDF per shipment picks it up as a priced part.
    const pack = await desk.get(`/shipping/shipments/${SH1}/pack`)
    expect(pack.body.parts.find((part: Json) => part.kind === 'COMMERCIAL_INVOICE')).toMatchObject({ state: 'READY', number: 'SEED-SH-0001' })
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('CN 22 and CN 23 (LOG-087)', () => {
  it('asks a CN 23 for a parcel over 2 kg; refuses a CN 22 then; one page per parcel', async () => {
    const tab = await desk.get(`/shipping/shipments/${SH1}/export`)
    expect(tab.body.papers.postalForm).toMatchObject({ suggested: 'CN23', held: null })
    expect(tab.body.papers.postalForm.because).toContain('HEAVY')
    const cn22 = await post(desk, `/shipping/shipments/${SH1}/export/postal-form`, { form: 'CN22' })
    expect(cn22.status).toBe(409)
    expect(cn22.body.error.issues[0].path).toBe('refusal/CN22_LIMIT')
    expect(cn22.body.error.message).toMatch(/more than 2 kg/)
    const made = await post(desk, `/shipping/shipments/${SH1}/export/postal-form`, { comments: 'Made-up test parcel' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.document).toMatchObject({ kind: 'CN23', version: 1, made: true })
    const pdf = await send(desk, 'GET', `/shipping/shipments/${SH1}/export/documents/${made.body.document.documentId}/pdf`)
    const parcels = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Parcel" WHERE "shipmentId" = $1`, [SH1])).n
    expect(pdfPages(pdf.rawPayload)).toBe(parcels)
    expect(pdfFlatText(pdf.rawPayload)).toContain('CN 23')
    expect(pdfFlatText(pdf.rawPayload)).toContain('IT00000003038')
  }, SLOW_TEST_TIMEOUT_MS)
})

let declarationId: string
let packLinkToken: string

describe('the export declaration through a broker (LOG-088)', () => {
  it('opens with an active carrier or supplier as broker, once; a customer is no broker; a reader cannot open it', async () => {
    const asCustomer = await post(desk, `/shipping/shipments/${SH1}/export/declaration`, { brokerPartyId: partyP1 })
    expect(asCustomer.status).toBe(409)
    expect(asCustomer.body.error.issues[0].path).toBe('refusal/BROKER')
    expect((await post(viewer, `/shipping/shipments/${SH1}/export/declaration`, { brokerPartyId: BROKER })).status).toBe(403)
    const opened = await post(desk, `/shipping/shipments/${SH1}/export/declaration`, { brokerPartyId: BROKER })
    expect(opened.status, JSON.stringify(opened.body)).toBe(201)
    declarationId = opened.body.declarationId
    const twice = await post(desk, `/shipping/shipments/${SH1}/export/declaration`, { brokerPartyId: null })
    expect(twice.status).toBe(409)
    expect(twice.body.error.issues[0].path).toBe('refusal/DECLARED')
    const tab = await desk.get(`/shipping/shipments/${SH1}/export`)
    expect(tab.body.declaration).toMatchObject({ id: declarationId, status: 'PACK_SENT', filedBy: 'BROKER', broker: { id: BROKER, name: 'Demo Dogana S.r.l.' }, mrn: null, alertAfterDays: 30, overdue: false })
    expect(tab.body.declaration.daysLeft).toBeGreaterThanOrEqual(26)
    expect(tab.body.declarationHeld).toBe('DECLARED')
  }, SLOW_TEST_TIMEOUT_MS)

  it('removes a pack sent by mistake while it is merely sent, its links revoked', async () => {
    const removed = await send(desk, 'DELETE', `/shipping/shipments/${SH1}/export/declaration`)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(removed.json()).toEqual({ removed: true, linksRevoked: 0 })
    expect((await admin(`SELECT 1 FROM "CustomsDeclaration" WHERE id = $1`, [declarationId])).length).toBe(0)
    // Opened again: this time the proof's alert after two days (the goods left three days ago).
    const opened = await post(desk, `/shipping/shipments/${SH1}/export/declaration`, { brokerPartyId: BROKER, alertAfterDays: 2 })
    expect(opened.status).toBe(201)
    declarationId = opened.body.declarationId
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('the document pack for the broker (LOG-097)', () => {
  let originFile: string

  it('says its parts in words; a paper of origin is a file of the shipment; the link waits for the switch', async () => {
    const stranger = await post(desk, `/shipping/shipments/${SH1}/export/pack/link`, { originFileIds: [newId()], send: false })
    expect(stranger.status).toBe(409)
    expect(stranger.body.error.issues[0].path).toBe('refusal/ORIGIN_FILE')
    originFile = await upload(desk, 'Shipment', SH1, 'Certificate of origin (made up).pdf', await realPdf('Made-up certificate of origin for SEED-SH-0001'))
    const pack = await desk.get(`/shipping/shipments/${SH1}/export/pack?originFileIds=${originFile}`)
    expect(pack.status, JSON.stringify(pack.body)).toBe(200)
    expect(pack.body.parts.map((part: Json) => part.part)).toEqual(['COMMERCIAL_INVOICE', 'PACKING_LIST', 'POSTAL_FORM', 'CONFORMITY', 'ORIGIN'])
    expect(pack.body.parts.find((part: Json) => part.part === 'COMMERCIAL_INVOICE').state).toBe('READY')
    expect(pack.body.parts.find((part: Json) => part.part === 'POSTAL_FORM').state).toBe('READY')
    expect(pack.body.parts.find((part: Json) => part.part === 'ORIGIN')).toMatchObject({ state: 'READY', files: [{ fileId: originFile }] })
    expect(pack.body.originCandidates.map((file: Json) => file.fileId)).toContain(originFile)
    expect(pack.body).toMatchObject({ linkHeld: 'SWITCH_OFF', downloadHeld: null, brokerPackOn: false })
    const off = await post(desk, `/shipping/shipments/${SH1}/export/pack/link`, { originFileIds: [originFile], send: false })
    expect(off.status).toBe(409)
    expect(off.body.error.issues[0].path).toBe('refusal/SWITCH_OFF')
  }, SLOW_TEST_TIMEOUT_MS)

  it('downloads as one PDF for one who sees values', async () => {
    const pdf = await send(desk, 'GET', `/shipping/shipments/${SH1}/export/pack/pdf?originFileIds=${originFile}`)
    expect(pdf.statusCode, pdf.body).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdfFlatText(pdf.rawPayload)).toContain('Made-up certificate of origin')
    expect((await send(dock, 'GET', `/shipping/shipments/${SH1}/export/pack/pdf`)).statusCode).toBe(403)
  }, SLOW_TEST_TIMEOUT_MS)

  it("switches the site's pack link on only after a fresh step-up", async () => {
    const version = (await desk.get(`/shipping/companies/${companyA}/customs`)).body.sites.find((site: Json) => site.siteId === siteA1).version
    expect((await send(desk, 'PUT', `/shipping/sites/${siteA1}/broker-pack`, { on: true, version })).statusCode).toBe(403)
    await stepUp(h, desk, deskSecret)
    const on = await send(desk, 'PUT', `/shipping/sites/${siteA1}/broker-pack`, { on: true, version })
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json().changed).toBe(true)
    expect(await outbox('customs.settings_changed', siteA1)).toBe(1)
  }, SLOW_TEST_TIMEOUT_MS)

  it("mails the broker the link (FAKE SES) with its papers, or gives one to pass on; refused without the price grain", async () => {
    expect((await post(dock, `/shipping/shipments/${SH1}/export/pack/link`, { send: false })).status).toBe(409)
    const mailed = await post(desk, `/shipping/shipments/${SH1}/export/pack/link`, { originFileIds: [originFile] })
    expect(mailed.status, JSON.stringify(mailed.body)).toBe(201)
    expect(mailed.body.url).toBeNull()
    const mail = h.ses.mails.find((entry) => entry.templateKey === 'shipping.broker_pack_link' && entry.to.includes(BROKER_MAIL))!
    expect(mail).toBeDefined()
    expect(textOf(mail.raw)).toContain('SEED-SH-0001')
    const files = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "LinkFile" WHERE "linkId" = $1`, [mailed.body.linkId])
    expect(files[0]!.n).toBeGreaterThanOrEqual(3)
    const passed = await post(desk, `/shipping/shipments/${SH1}/export/pack/link`, { originFileIds: [originFile], send: false })
    expect(passed.status).toBe(201)
    packLinkToken = tokenOf(passed.body.url)
    expect(packLinkToken).not.toBe('')
    expect(await outbox('customs.declaration_changed', SH1)).toBeGreaterThanOrEqual(4)
  }, SLOW_TEST_TIMEOUT_MS)

  it('the broker opens its papers, downloads one, types the MRN back once: FILED', async () => {
    const page = await linkCall(packLinkToken, 'GET', '/link/broker-pack')
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json()).toMatchObject({ shipment: { number: 'SEED-SH-0001', country: 'CH' }, declaration: { status: 'PACK_SENT', mrn: null } })
    const papers = page.json().papers as Json[]
    expect(papers.some((paper) => paper.fileId === originFile)).toBe(true)
    const download = await linkCall(packLinkToken, 'POST', `/link/broker-pack/files/${papers[0]!.fileId}/download`, {})
    expect(download.statusCode, download.body).toBe(200)
    expect(download.json().download.url).toBeTruthy()
    expect((await linkCall(packLinkToken, 'POST', `/link/broker-pack/files/${newId()}/download`, {})).statusCode).toBe(404)
    expect((await linkCall(packLinkToken, 'POST', '/link/broker-pack/mrn', { mrn: '26CH12' })).statusCode).toBe(400)
    const filed = await linkCall(packLinkToken, 'POST', '/link/broker-pack/mrn', { mrn: '26ch 0000 0000 0000 42' })
    expect(filed.statusCode, filed.body).toBe(200)
    expect(filed.json().declaration).toEqual({ status: 'FILED', mrn: '26CH00000000000042' })
    const evidence = await admin<{ action: string }>(`SELECT action::text AS action FROM "LinkEvidence" WHERE "linkId" = (SELECT id FROM "OneOffLink" WHERE "recordId" = $1 AND email IS NULL ORDER BY "createdAt" DESC LIMIT 1) ORDER BY at`, [declarationId])
    expect(evidence.map((row) => row.action)).toEqual(expect.arrayContaining(['DOWNLOADED', 'SUBMITTED']))
    // The office cannot record another MRN; the same one changes nothing.
    const other = await post(desk, `/shipping/shipments/${SH1}/export/declaration/mrn`, { mrn: '26CH00000000000043' })
    expect(other.status).toBe(409)
    expect(other.body.error.issues[0].path).toBe('refusal/MRN_KEPT')
    expect((await post(desk, `/shipping/shipments/${SH1}/export/declaration/mrn`, { mrn: '26CH00000000000042' })).body).toMatchObject({ changed: false })
    // Switched off, the broker's links open nothing (fail closed).
    const version = (await desk.get(`/shipping/companies/${companyA}/customs`)).body.sites.find((site: Json) => site.siteId === siteA1).version
    expect((await send(desk, 'PUT', `/shipping/sites/${siteA1}/broker-pack`, { on: false, version })).statusCode).toBe(200)
    const mailedToken = tokenOf(textOf(h.ses.mails.find((entry) => entry.templateKey === 'shipping.broker_pack_link')!.raw).match(/https?:\/\/\S+#token=\S+/)?.[0] ?? '')
    expect((await linkCall(mailedToken, 'GET', '/link/broker-pack')).statusCode).toBe(404)
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('the proof of exit (LOG-089; art. 8 DPR 633/1972)', () => {
  const findings = () => callerFor(h.database, systemContext(T, newId())).withClient((db) => exitProofFindings(db, { companyId: null, siteId: null, threshold: {} }, h.clock.now()))

  it('raises its alert once the declaration\'s days passed without the proof', async () => {
    const tab = await desk.get(`/shipping/shipments/${SH1}/export`)
    expect(tab.body.declaration).toMatchObject({ status: 'FILED', mrn: '26CH00000000000042', alertAfterDays: 2, overdue: true })
    expect(tab.body.declaration.daysLeft).toBeLessThan(0)
    expect(tab.body.invoices.map((invoice: Json) => invoice.id)).toContain(sampleInvoice)
    const found = await findings()
    expect(found).toEqual([expect.objectContaining({ recordType: 'Shipment', recordId: SH1, label: 'SEED-SH-0001', facts: expect.objectContaining({ declarationId, days: 2, status: 'FILED' }) })])
  }, SLOW_TEST_TIMEOUT_MS)

  it('is confirmed only against the issued invoice, after the goods left, with a file of the declaration: EXITED, the alert cleared', async () => {
    const proofAt = new Date(h.clock.now().getTime() - 60_000).toISOString()
    const early = await post(desk, `/shipping/shipments/${SH1}/export/declaration/exit`, { exitConfirmedAt: proofAt, fileId: newId() })
    expect(early.body.error.issues[0].path).toBe('refusal/NO_INVOICE')
    const draft = await post(desk, `/shipping/shipments/${SH1}/export/declaration/invoice`, { invoiceId: draftInvoice })
    expect(draft.status).toBe(409)
    expect(draft.body.error.issues[0].path).toBe('refusal/INVOICE')
    expect((await post(desk, `/shipping/shipments/${SH1}/export/declaration/invoice`, { invoiceId: sampleInvoice })).status).toBe(200)
    const another = await post(desk, `/shipping/shipments/${SH1}/export/declaration/invoice`, { invoiceId: draftInvoice })
    expect(another.body.error.issues[0].path).toBe('refusal/INVOICE_KEPT')
    const notTheDeclarations = await post(desk, `/shipping/shipments/${SH1}/export/declaration/exit`, { exitConfirmedAt: proofAt, fileId: (await admin<{ id: string }>(`SELECT id FROM "StoredFile" WHERE "recordType" = 'Shipment' AND "recordId" = $1 LIMIT 1`, [SH1]))[0]!.id })
    expect(notTheDeclarations.body.error.issues[0].path).toBe('refusal/PROOF_FILE')
    const proof = await upload(dock, 'CustomsDeclaration', declarationId, 'Exit confirmation (made up).pdf', await realPdf('Made-up exit notification for MRN 26CH00000000000042'))
    const before = await post(dock, `/shipping/shipments/${SH1}/export/declaration/exit`, { exitConfirmedAt: new Date(h.clock.now().getTime() - 10 * 86_400_000).toISOString(), fileId: proof })
    expect(before.body.error.issues[0].path).toBe('refusal/EXIT_TIME')
    const exited = await post(dock, `/shipping/shipments/${SH1}/export/declaration/exit`, { exitConfirmedAt: proofAt, fileId: proof })
    expect(exited.status, JSON.stringify(exited.body)).toBe(200)
    const tab = await desk.get(`/shipping/shipments/${SH1}/export`)
    expect(tab.body.declaration).toMatchObject({ status: 'EXITED', invoice: { id: sampleInvoice }, exitFile: { id: proof }, overdue: false, daysLeft: null })
    expect(await findings()).toEqual([])
    const removed = await send(desk, 'DELETE', `/shipping/shipments/${SH1}/export/declaration`)
    expect(removed.statusCode).toBe(409)
    expect(removed.json().error.issues[0].path).toBe('refusal/EXITED')
  }, SLOW_TEST_TIMEOUT_MS)
})
