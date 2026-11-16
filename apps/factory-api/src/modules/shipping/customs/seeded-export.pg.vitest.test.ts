import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { seedUuid, type SeedContext } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { pdfPages } from '../shipment-pack/pdf-merge'

/**
 * The export to Switzerland of a fresh seed (B-W2b-F59): EVERY seed file run in name order, as the seed CLI runs them, on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the …_delivery_customs
 * guards are real), the real office sign-in (the export desk steps up to switch the pack on), FAKE SES. With nothing typed
 * into the database by hand, the seed's SEED-SH-0003 (SEED-SO-0002's RED 50 to the team's base in CH) needs export papers;
 * the desk opens its declaration with the seed's broker, prints the packing list and the commercial invoice (company A's
 * seeded EORI, the style's seeded HS code and origin, the order's prices), the pack shows its parts READY and downloads as one
 * PDF, and once plant A1's switch is on, its link is mailed to the broker's seeded contact. Every company, party and number is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs customs/seeded-export`.
 */

let h: Harness
let desk: Browser
let deskSecret: string

const NS = 'w2bf59-export'
const id = (name: string): string => seedUuid(NS, name)
const lateId = (name: string): string => `ffffffff${id(name).slice(8)}`
const T = { tenant: id('tenant'), companyA: id('company:A'), siteA1: id('site:A1'), shipment: lateId('customs-export:shipment:SH-0003'), broker: lateId('customs:party:broker') }
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed/', import.meta.url))

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let keys = 0
const key = () => `w2bf59-${process.pid}-${++keys}-${Date.now()}`
const post = (url: string, body: unknown = {}) => desk.post(url, body, { headers: { 'idempotency-key': key() } })
const cookieOf = (browser: Browser) => [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
const send = (method: 'PUT' | 'GET', url: string, body?: unknown) =>
  h.app.inject({ method, url, headers: { cookie: cookieOf(desk), 'x-csrf-token': desk.csrfToken ?? '', ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(body === undefined ? {} : { payload: body as object }) })

beforeAll(async () => {
  h = await startHarness('w2bf59_export')
  h.clock.set(new Date())
  const context: SeedContext = { db: h.database, namespace: NS }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [T.tenant])
  await admin(
    `INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains, "requireMfa") VALUES ($1, $2, 'desk-f59', 'Export desk (test)', $3, '{price}', false)`,
    [newId(), T.tenant, ['home.view', 'shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.customs.manage', 'shipping.settings.view', 'shipping.settings.manage', 'files.read', 'files.upload']],
  )
  const companies = await admin<{ id: string; code: string }>(`SELECT id, code FROM "Company" WHERE "tenantId" = $1 ORDER BY code`, [T.tenant])
  const tenant: TestTenant = { id: T.tenant, slug: NS, companies }
  const user = await addUser(h, tenant, { email: 'erica.export.f59@example.com', role: 'desk-f59' })
  desk = new Browser(h.app)
  const signed = await desk.signIn(NS, user.email, user.password)
  expect(signed.status, JSON.stringify(signed.body)).toBe(200)
  deskSecret = await enrolTotp(h, desk)
}, 600_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('the seeded export to Switzerland (B-W2b-F59)', () => {
  it('needs export papers, and nothing in the seed holds them: EORI, destination, the broker to choose', async () => {
    const tab = await desk.get(`/shipping/shipments/${T.shipment}/export`)
    expect(tab.status, JSON.stringify(tab.body)).toBe(200)
    expect(tab.body).toMatchObject({ needed: true, destination: { country: 'CH', class: 'EXPORT' }, eori: 'IT00000003038', declaration: null, declarationHeld: null, mayManage: true, seesValues: true })
    expect(tab.body.papers.held).toBeNull()
  }, SLOW_TEST_TIMEOUT_MS)

  it('opens the declaration with the seed’s broker, prints the packing list and the commercial invoice from the seed’s facts', async () => {
    const opened = await post(`/shipping/shipments/${T.shipment}/export/declaration`, { brokerPartyId: T.broker })
    expect(opened.status, JSON.stringify(opened.body)).toBe(201)
    const list = await post(`/shipping/shipments/${T.shipment}/packing-list`, {})
    expect([200, 201], JSON.stringify(list.body)).toContain(list.status)
    const made = await post(`/shipping/shipments/${T.shipment}/export/commercial-invoice`, { language: 'en' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.document).toMatchObject({ kind: 'COMMERCIAL_INVOICE', number: 'SEED-SH-0003', language: 'en', made: true })
    const pdf = await send('GET', `/shipping/shipments/${T.shipment}/export/documents/${made.body.document.documentId}/pdf`)
    expect(pdf.statusCode).toBe(200)
    const text = pdfFlatText(pdf.rawPayload)
    for (const words of ['Commercial invoice (for customs)', 'IT00000003038', 'HS 42031000', 'Origin IT', 'Switzerland', 'SEED-SH-0003']) expect(text).toContain(words)
  }, SLOW_TEST_TIMEOUT_MS)

  it('builds the broker’s pack: its parts READY, one PDF; the link waits for the switch, then goes to the broker’s contact', async () => {
    const pack = await desk.get(`/shipping/shipments/${T.shipment}/export/pack`)
    expect(pack.status, JSON.stringify(pack.body)).toBe(200)
    const state = (part: string) => (pack.body.parts as Json[]).find((entry) => entry.part === part)?.state
    expect([state('COMMERCIAL_INVOICE'), state('PACKING_LIST')]).toEqual(['READY', 'READY'])
    expect(pack.body).toMatchObject({ linkHeld: 'SWITCH_OFF', downloadHeld: null, brokerPackOn: false })
    const merged = await send('GET', `/shipping/shipments/${T.shipment}/export/pack/pdf`)
    expect(merged.statusCode, merged.body).toBe(200)
    expect(merged.headers['content-type']).toBe('application/pdf')
    expect(pdfPages(merged.rawPayload)).toBeGreaterThanOrEqual(2)

    const version = (await desk.get(`/shipping/companies/${T.companyA}/customs`)).body.sites.find((site: Json) => site.siteId === T.siteA1).version
    await stepUp(h, desk, deskSecret)
    const on = await send('PUT', `/shipping/sites/${T.siteA1}/broker-pack`, { on: true, version })
    expect(on.statusCode, on.body).toBe(200)
    const mailed = await post(`/shipping/shipments/${T.shipment}/export/pack/link`, {})
    expect(mailed.status, JSON.stringify(mailed.body)).toBe(201)
    const mail = h.ses.mails.find((entry) => entry.templateKey === 'shipping.broker_pack_link' && entry.to.includes('customs-desk@seed-broker.example.com'))
    expect(mail).toBeDefined()
    expect(textOf(mail!.raw)).toContain('SEED-SH-0003')
  }, SLOW_TEST_TIMEOUT_MS)
})
