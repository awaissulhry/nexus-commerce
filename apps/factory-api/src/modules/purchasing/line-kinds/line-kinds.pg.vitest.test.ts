import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Purchase lines by kind (B-W2b-328; SCM-076 fabric and trims by rolls, SCM-077 a protector's certificate, SCM-186 colour
 * and size variants of one material) on the local stack: a throwaway PostgreSQL 17 database from the migrations
 * (row-level security and the …_buying_depth_w2b_guards triggers are real), the real app with the real office sign-in (a
 * buyer with two-factor, who also keeps the materials), and a second app with test sessions (a warehouse manager who posts
 * receipts, a planner who only reads orders, a reader of materials without the styles). The factory-db seeds up to
 * production, the numbering and the PPE register (SEED-CERT-0002 covers the seeded protector from any supplier). Every
 * name, number and price is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/line-kinds`.
 */

let h: Harness
let walls: FastifyInstance
let buyer: Browser

const NS = 'line-kinds'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const leather = seedId('product:item:leather')
const protector = seedId('product:item:protector')
const lining = seedId('product:item:lining')
const liningGRY = seedId('product:item-colour:lining:GRY')
const protectorCertificate = seedId('compliance:certificate:PRO-300')
const jacketCertificate = seedId('compliance:certificate:JKT-01')
const FAKE_VAT = '12345670009'
const today = () => businessDate(new Date())

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
let counter = 0
const key = (label = 'k'): string => `linekinds-${label}-${++counter}-${newId()}`

async function as(method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await buyer.send(method as 'POST', url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  manager: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['inventory.receive', 'inventory.stock.view', 'money.cost', 'files.read', 'files.upload'])] }),
  planner: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view'])] }),
  materials: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.materials.view'])] }),
}
const wall = async (session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> => {
  const answer = await walls.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': key('wall') }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json()
}

const orderUrl = (id: string) => `/purchasing/orders/${id}`
const kinds = async (orderId: string): Promise<Json> => (await as('GET', `${orderUrl(orderId)}/line-kinds`)).kinds
const lineOf = (view: Json, itemId: string): Json => view.lines.find((line: Json) => line.itemId === itemId)
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)

beforeAll(async () => {
  h = await startHarness('line_kinds')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const buyerUser = await addUser(h, seedTenant, { email: 'bianca.buyer@seed-a.example.com', role: 'buyer' })
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

const G: Json = {}

describe('colour and size variants of one material (SCM-186)', () => {
  it('adds the protector in three sizes and the lining in its grey: codes by default, one per colour and size', async () => {
    const added = await as('POST', `/product/materials/${protector}/variants`, { variants: [{ size: 'S' }, { size: ' M ', supplierCode: 'ART-300-M' }, { size: 'L' }] }, 201)
    expect(added.material).toMatchObject({ code: 'SEED-PRO-300', tracking: 'LOT', keepsVariantsApart: true })
    expect(added.variants.map((variant: Json) => [variant.code, variant.size, variant.supplierCode, variant.status])).toEqual([
      ['SEED-PRO-300-L', 'L', null, 'ACTIVE'],
      ['SEED-PRO-300-M', 'M', 'ART-300-M', 'ACTIVE'],
      ['SEED-PRO-300-S', 'S', null, 'ACTIVE'],
    ])
    G.small = added.variants.find((variant: Json) => variant.size === 'S')
    const again = await as('POST', `/product/materials/${protector}/variants`, { variants: [{ size: 'm', code: 'PRO-M-2' }] }, 409)
    expect(again.error.message).toBe('SEED-PRO-300 has an active variant of this colour and size already.')
    const empty = await as('POST', `/product/materials/${protector}/variants`, { variants: [{ supplierCode: 'X' }] }, 400)
    expect(empty.error.issues[0]).toMatchObject({ path: 'body/variants/0/size' })
    const grey = await as('POST', `/product/materials/${lining}/variants`, { variants: [{ itemColourId: liningGRY }] }, 201)
    expect(grey.variants).toMatchObject([{ code: 'SEED-LIN-200-GRY', colour: { code: 'GRY' }, size: null }])
    const changed = await as('PATCH', `/product/materials/${protector}/variants/${G.small.id}`, { version: G.small.version, supplierCode: 'ART-300-S' })
    expect(changed.variants.find((variant: Json) => variant.code === 'SEED-PRO-300-S')).toMatchObject({ supplierCode: 'ART-300-S', version: G.small.version + 1 })
    G.small = changed.variants.find((variant: Json) => variant.code === 'SEED-PRO-300-S')
    expect(await eventsOf(protector)).toContain('material.updated')
    const rows = await admin(`SELECT "recordType", action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [protector])
    expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining(['product.materials.addVariants', 'product.materials.updateVariant']))
  })

  it('a BOM size line uses the variant of its size: the seeded jacket’s leather by size', async () => {
    await as('POST', `/product/materials/${leather}/variants`, { variants: [{ size: '50' }] }, 201)
    const answer = await as('GET', `/product/materials/${leather}/variants/bom-sizes`)
    const line = answer.lines.find((entry: Json) => entry.sizes.some((size: Json) => size.size === '50'))
    expect(line.sizes.find((size: Json) => size.size === '50')).toMatchObject({ match: 'ONE', variantCodes: ['SEED-LEA-100-50'] })
    expect(line.sizes.filter((size: Json) => size.size !== '50').every((size: Json) => size.match === 'NONE')).toBe(true)
    // Without product.styles.view the BOM is not read.
    await wall('materials', 'GET', `/product/materials/${leather}/variants/bom-sizes`, undefined, 403)
    expect((await wall('materials', 'GET', `/product/materials/${protector}/variants?status=ACTIVE`)).variants).toHaveLength(3)
  })
})

describe('a purchase order by kind (SCM-076, SCM-077, SCM-186)', () => {
  let orderId = ''

  it('a protector line names the register’s certificate by default; a lining line is bought by rolls in its variant’s colour', async () => {
    let order = (await as('POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 }, 201)).order
    orderId = order.id
    order = (await as('POST', `${orderUrl(orderId)}/lines`, { version: order.version, itemId: lining, quantity: '2', uom: 'ROLL', needDate: addDays(today(), 30), unitPrice: '150.000000' }, 201)).order
    order = (await as('POST', `${orderUrl(orderId)}/lines`, { version: order.version, itemId: protector, quantity: '24', uom: 'PCS', needDate: addDays(today(), 30), unitPrice: '6.500000' }, 201)).order
    let view = await kinds(orderId)
    expect(view).toMatchObject({ status: 'DRAFT', kind: 'STANDARD', mayChange: true })
    expect(lineOf(view, protector)).toMatchObject({
      buysAs: 'PROTECTOR',
      ppe: true,
      certificate: { id: protectorCertificate, number: 'SEED-CERT-0002', state: 'HOLDS', endsBeforeNeed: false },
      certificateChoices: [{ id: protectorCertificate, coverage: 'ANY_SUPPLIER' }],
      variantChoices: [{ code: 'SEED-PRO-300-L' }, { code: 'SEED-PRO-300-M' }, { code: 'SEED-PRO-300-S' }],
    })
    expect(lineOf(view, lining)).toMatchObject({ buysAs: 'FABRIC', rolls: null, certificate: null, variantChoices: [{ code: 'SEED-LIN-200-GRY' }] })

    // 3 rolls × 50 m × 150 cm: the ROLL line becomes 3 rolls, its amount and the order's total follow.
    const liningLine = lineOf(view, lining)
    view = (await as('PUT', `${orderUrl(orderId)}/lines/${liningLine.id}/kind`, { version: view.version, rolls: { count: 3, lengthM: '50', widthCm: '150' } })).kinds
    expect(lineOf(view, lining)).toMatchObject({ quantity: '3.0000', uom: 'ROLL', rolls: { count: 3, lengthM: '50', widthCm: '150', words: '3 rolls × 50 m × 150 cm', makes: '3.0000', matches: true } })
    const record = (await as('GET', orderUrl(orderId))).order
    expect(record.lines.find((line: Json) => line.itemId === lining)).toMatchObject({ quantity: '3.0000', netAmount: 45_000 })
    expect(record.netAmount).toBe(45_000 + 15_600)
    // The variant gives the line its colour.
    view = (await as('PUT', `${orderUrl(orderId)}/lines/${liningLine.id}/kind`, { version: view.version, variantCode: 'SEED-LIN-200-GRY' })).kinds
    expect(lineOf(view, lining)).toMatchObject({ itemColourId: liningGRY, variant: { code: 'SEED-LIN-200-GRY', colourCode: 'GRY', problem: null } })
    view = (await as('PUT', `${orderUrl(orderId)}/lines/${lineOf(view, protector).id}/kind`, { version: view.version, variantCode: 'SEED-PRO-300-M' })).kinds
    expect(lineOf(view, protector).variant).toMatchObject({ code: 'SEED-PRO-300-M', size: 'M', supplierCode: 'ART-300-M' })
    expect(await eventsOf(orderId)).toContain('purchase_order.lines_changed')
    const audit = await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.lines.kind'`, [orderId])
    expect(audit).toHaveLength(3)
  })

  it('refuses in words: a quantity the rolls make, a certificate on a lining, one that does not cover the protector, a stale version', async () => {
    let view = await kinds(orderId)
    const liningLine = lineOf(view, lining)
    const protectorLine = lineOf(view, protector)
    const record = (await as('GET', orderUrl(orderId))).order
    const edit = await as('PATCH', `${orderUrl(orderId)}/lines/${liningLine.id}`, { version: record.version, quantity: '4' }, 409)
    expect(edit.error.message).toMatch(/^Line 10 is bought by rolls \(3 rolls × 50 m × 150 cm\): change its rolls, or clear them first/)
    const notPpe = await as('PUT', `${orderUrl(orderId)}/lines/${liningLine.id}/kind`, { version: view.version, certificateId: protectorCertificate }, 400)
    expect(notPpe.error.message).toBe("SEED-LIN-200 is no PPE component: only a protector's line names a certificate.")
    const other = await as('PUT', `${orderUrl(orderId)}/lines/${protectorLine.id}/kind`, { version: view.version, certificateId: jacketCertificate }, 409)
    expect(other.error.message).toMatch(/^Certificate SEED-CERT-0001 \(EN 17092-3:2020\) does not cover SEED-PRO-300/)
    const badRolls = await as('PUT', `${orderUrl(orderId)}/lines/${protectorLine.id}/kind`, { version: view.version, rolls: { count: 2 } }, 400)
    expect(badRolls.error.message).toMatch(/SEED-PRO-300 is protector: only fabrics/)
    await as('PUT', `${orderUrl(orderId)}/lines/${protectorLine.id}/kind`, { version: view.version - 1, variantCode: 'SEED-PRO-300-L' }, 409)
    await as('PUT', `${orderUrl(orderId)}/lines/${protectorLine.id}/kind`, { version: view.version, variantCode: 'NOPE' }, 400)
    // Without the certificate the send is held (the register has one that covers it); with it, it is ready.
    view = (await as('PUT', `${orderUrl(orderId)}/lines/${protectorLine.id}/kind`, { version: view.version, certificateId: null })).kinds
    expect(view.checks).toMatchObject([{ code: 'PPE_NO_CERTIFICATE', severity: 'BLOCKS', path: 'lines/20/certificateId' }])
    const check = await as('GET', `${orderUrl(orderId)}/send-check`)
    expect(check.ready).toBe(false)
    view = (await as('PUT', `${orderUrl(orderId)}/lines/${protectorLine.id}/kind`, { version: view.version, certificateId: protectorCertificate })).kinds
    expect(view.checks).toEqual([])
    // A reader of orders sees the kinds, and changes none.
    expect((await wall('planner', 'GET', `${orderUrl(orderId)}/line-kinds`)).kinds.mayChange).toBe(false)
    await wall('planner', 'PUT', `${orderUrl(orderId)}/lines/${protectorLine.id}/kind`, { version: view.version, variantCode: null }, 403)
    // A variant on an open line stays active.
    const variants = (await as('GET', `/product/materials/${protector}/variants`)).variants
    const medium = variants.find((variant: Json) => variant.code === 'SEED-PRO-300-M')
    expect(medium.openOrderLines).toBe(1)
    const archive = await as('PATCH', `/product/materials/${protector}/variants/${medium.id}`, { version: medium.version, status: 'ARCHIVED' }, 409)
    expect(archive.error.message).toMatch(/^Variant SEED-PRO-300-M is bought on open purchase orders \(.* line 20\)/)
  })

  it('sends it; a receipt gives the lots their variant, and checks the certificate again on the day the goods come', async () => {
    const order = (await as('GET', orderUrl(orderId))).order
    const sent = await as('POST', `${orderUrl(orderId)}/send`, { version: order.version })
    expect(sent.order.status).toBe('SENT')
    const view = await kinds(orderId)
    expect(view.mayChange).toBe(false)
    await as('PUT', `${orderUrl(orderId)}/lines/${lineOf(view, protector).id}/kind`, { version: view.version, variantCode: null }, 409)
    const [liningLine, protectorLine] = [lineOf(view, lining), lineOf(view, protector)]

    const first = (await wall('manager', 'POST', '/inventory/receipts', { purchaseOrderId: orderId, supplierDdtNumber: 'DDT-LK-1', supplierDdtDate: today(), lines: [{ purchaseOrderLineId: liningLine.id, lots: [{ quantity: '3', baseQuantity: '150' }] }, { purchaseOrderLineId: protectorLine.id, lots: [{ supplierLotRef: 'PRO-LK-1', quantity: '12' }] }] }, 201)).receipt
    const lots = await admin<{ code: string; variantCode: string; qualityStatus: string; qualityNote: string | null }>(
      `SELECT l.code, l."variantCode", l."qualityStatus", l."qualityNote" FROM "Lot" l JOIN "GoodsReceiptLine" r ON r.id = l."receiptLineId" WHERE r."receiptId" = $1 ORDER BY r.seq`,
      [first.id],
    )
    expect(lots.map((lot) => [lot.variantCode, lot.qualityStatus])).toEqual([
      ['SEED-LIN-200-GRY', 'RELEASED'],
      ['SEED-PRO-300-M', 'QUARANTINE'],
    ])
    expect(lots[1]!.qualityNote).toBeNull()

    // The notified body suspends the certificate: the next protectors wait in quarantine with the reason in words.
    await admin(`UPDATE "Certificate" SET status = 'SUSPENDED', "statusReason" = 'Made-up suspension for the test', "statusChangedAt" = now() WHERE id = $1`, [protectorCertificate])
    const second = await wall('manager', 'POST', '/inventory/receipts', { purchaseOrderId: orderId, supplierDdtNumber: 'DDT-LK-2', supplierDdtDate: today(), lines: [{ purchaseOrderLineId: protectorLine.id, lots: [{ supplierLotRef: 'PRO-LK-2', quantity: '12' }] }] }, 201)
    const held = await admin<{ variantCode: string; qualityStatus: string; qualityNote: string }>(
      `SELECT l."variantCode", l."qualityStatus", l."qualityNote" FROM "Lot" l JOIN "GoodsReceiptLine" r ON r.id = l."receiptLineId" WHERE r."receiptId" = $1`,
      [second.receipt.id],
    )
    expect(held).toEqual([{ variantCode: 'SEED-PRO-300-M', qualityStatus: 'QUARANTINE', qualityNote: 'Certificate SEED-CERT-0002 (EN 1621-1:2012) is suspended by the notified body. The order named it for these protectors: check them against a certificate that holds before they are released.' }])
    expect(second.notes).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'QUARANTINE', message: expect.stringMatching(/held at receipt: Certificate SEED-CERT-0002 .* is suspended by the notified body/) })]))
    expect(second.receipt.purchaseOrder.status).toBe('RECEIVED')

    // Received in full, the order is no longer open: the variant may be archived now.
    const medium = (await as('GET', `/product/materials/${protector}/variants`)).variants.find((variant: Json) => variant.code === 'SEED-PRO-300-M')
    expect(medium).toMatchObject({ openOrderLines: 0, lots: 2 })
    const archived = (await as('PATCH', `/product/materials/${protector}/variants/${medium.id}`, { version: medium.version, status: 'ARCHIVED' })).variants
    expect(archived.find((variant: Json) => variant.code === 'SEED-PRO-300-M').status).toBe('ARCHIVED')
  })
})
