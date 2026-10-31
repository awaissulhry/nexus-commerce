import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * "Request from supplier" (B-W2a-F4; Owner answer 1A, 2026-10-30): the warehouse asks the supplier for the documents a
 * receipt's lots wait for through ONE narrow route and permission (inventory.receipts.documents.request), not email.send.
 * The local stack with the app's real routes and email out on its FAKE provider (the auth harness, FAKE SES): a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the column grants are real), the
 * factory-db seeds of one tenant up to production (the black cowhide that waits for its Cr VI result, the shoulder
 * protector — a certified PPE component —, the grey lining; the supplier P2 with its order desk contact, the customer P1
 * with its buyer), the numbering seed and the e-mail identities. People hold the REAL warehouse template (which has no
 * email.send), the same without the new permission, and a reader. Purchase orders to P2 are made up here, CONFIRMED.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/receipts`.
 */

let h: Harness
let app: FastifyInstance

const ns = 'receipt-documents'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  supplier: idOf('party:P2'),
  orderDesk: idOf('party-contact:P2:orders'),
  customerBuyer: idOf('party-contact:P1:buyer'),
  leather: idOf('product:item:leather'),
  lining: idOf('product:item:lining'),
  protector: idOf('product:item:protector'),
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  liningGRY: idOf('product:item-colour:lining:GRY'),
}

const WAREHOUSE = ROLE_TEMPLATES.find((template) => template.key === 'warehouse')!
const PEOPLE: Record<string, readonly Permission[]> = {
  /** The warehouse template as it ships. */
  warehouse: WAREHOUSE.permissions,
  /** The same without the new permission (a copy made before it existed). */
  noRequest: WAREHOUSE.permissions.filter((permission) => permission !== 'inventory.receipts.documents.request'),
  /** Sees receipts only. */
  viewer: ['inventory.stock.view'],
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const grantOf = (permissions: readonly Permission[]): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, permissions]) => [key, { audience: 'office', tenantId: A.tenant, actorId: IDS[key]!, grants: [grantOf(permissions)] } satisfies SessionContext]),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let counter = 0
const freshKey = () => `rdoc-${run}-${++counter}`
const call = (session: string, method: Method, url: string, payload?: unknown, key: string = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const mailsOf = async (receiptId: string) => (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "recordType" = 'GoodsReceipt' AND "recordId" = $1`, [receiptId]))[0]!.n

// ---- made-up purchase orders and receipts ---------------------------------------------------------------------------------------

interface LineSpec {
  readonly itemId: string
  readonly colourId: string | null
  readonly quantity: string
  readonly uom: string
  readonly unitPrice: string
}
let orders = 0
/** A CONFIRMED purchase order of company A for site A1 to the supplier P2 (the leather line wants a Cr VI test). */
async function makeOrder(lines: readonly LineSpec[]): Promise<{ id: string; lines: string[] }> {
  const id = newId()
  await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", "createdById") VALUES ($1, $2, $3, $4, $5, $6, current_date, $7)`, [id, A.tenant, A.companyA, A.siteA1, `T-PO-${run}-${++orders}`, A.supplier, A.actor])
  const lineIds: string[] = []
  let total = 0
  for (const [index, line] of lines.entries()) {
    const lineId = newId()
    lineIds.push(lineId)
    const amount = Math.round(Number(line.quantity) * Number(line.unitPrice) * 100)
    total += amount
    await admin(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate", "areaTolerancePct", "requiresCrViTest")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"Uom", $9, $11, $12, current_date + 20, $13, $14)`,
      [lineId, A.tenant, id, A.supplier, A.siteA1, (index + 1) * 10, line.itemId, line.colourId, line.quantity, line.uom, line.unitPrice, amount, line.itemId === A.leather ? '5' : null, line.itemId === A.leather],
    )
  }
  await admin(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "sentById" = $2, "netAmount" = $3, version = 2 WHERE id = $1`, [id, A.actor, total])
  await admin(`UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', version = 3 WHERE id = $1`, [id])
  return { id, lines: lineIds }
}

/** The leather (Cr VI pending) and the protectors (a PPE component) received with the supplier's DDT: both lots wait. */
async function receiptWaitingForDocuments(): Promise<Json> {
  const order = await makeOrder([
    { itemId: A.leather, colourId: A.leatherBLK, quantity: '200', uom: 'FT2', unitPrice: '5.000000' },
    { itemId: A.protector, colourId: null, quantity: '20', uom: 'PCS', unitPrice: '6.500000' },
  ])
  return (
    await ok('warehouse', 'POST', '/inventory/receipts', {
      purchaseOrderId: order.id,
      supplierDdtNumber: `DDT-R-${run}-${orders}`,
      supplierDdtDate: '2026-10-29',
      lines: [
        { purchaseOrderLineId: order.lines[0], lots: [{ supplierLotRef: 'CONC-7', dyeBatch: 'DB-R', hides: [{ supplierCode: 'R-01', area: '52.3' }, { supplierCode: 'R-02', area: '48.9' }] }] },
        { purchaseOrderLineId: order.lines[1], lots: [{ supplierLotRef: 'PRO-7', quantity: '20' }] },
      ],
    }, 201)
  ).receipt
}

beforeAll(async () => {
  h = await startHarness('receipt_documents')
  await seedCore({ db: h.database, namespace: ns })
  await seedProduction({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  await seedEmail({ db: h.database, namespace: ns })
  for (const [key, permissions] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], A.tenant, `${key}-${run}@example.com`, `Test ${key}`])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, '{}')`, [roleId, A.tenant, `custom.receipt_documents_${key.toLowerCase()}`, key, [...permissions]])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "siteIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}', '{}', now() - interval '1 day')`, [newId(), A.tenant, IDS[key], roleId])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database: h.database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe("Request from supplier: the receipt's missing documents through one narrow action (B-W2a-F4)", () => {
  let receipt: Json
  let lots: Json[]
  const url = () => `/inventory/receipts/${receipt.id}/documents/request`

  beforeAll(async () => {
    receipt = await receiptWaitingForDocuments()
    lots = (await ok('warehouse', 'GET', `/inventory/receipts/${receipt.id}/lots`)).lots as Json[]
  })

  it('the warehouse template holds the new permission and still no email.send', () => {
    expect(WAREHOUSE.permissions).toContain('inventory.receipts.documents.request')
    expect(WAREHOUSE.permissions).not.toContain('email.send')
    expect(ROLE_TEMPLATES.find((template) => template.key === 'buyer')!.permissions).toContain('inventory.receipts.documents.request')
    expect(ROLE_TEMPLATES.find((template) => template.key === 'owner')!.permissions).toContain('inventory.receipts.documents.request')
  })

  it('what the request would send: the documents the lots wait for, the supplier’s contacts, the text in its language', async () => {
    const leather = lots.find((lot) => lot.supplierLotRef === 'CONC-7')!
    const protectors = lots.find((lot) => lot.supplierLotRef === 'PRO-7')!
    const check = await ok('warehouse', 'GET', url())
    expect(check).toMatchObject({
      ready: true,
      problems: [],
      receipt: { id: receipt.id, number: receipt.number, status: 'POSTED', supplierDdtDate: '2026-10-29' },
      wanted: [
        { key: `${leather.id}:CR_VI_REPORT`, ask: 'CR_VI_REPORT', lot: { id: leather.id, code: leather.code, supplierLotRef: 'CONC-7', dyeBatch: 'DB-R' } },
        { key: `${protectors.id}:PPE_CERTIFICATE`, ask: 'PPE_CERTIFICATE', lot: { id: protectors.id, code: protectors.code, supplierLotRef: 'PRO-7' } },
      ],
      recipients: [{ contactId: A.orderDesk, email: 'orders.p2@example.com', suggested: true }],
      language: 'it',
    })
    expect(check.subject).toBe(`Documenti mancanti — vostro DDT ${receipt.supplierDdtNumber}, nostro ricevimento ${receipt.number}`)
    expect(check.body).toContain('cromo esavalente')
    expect(check.body).toContain('del 29/10/2026')
    expect((await ok('warehouse', 'GET', `${url()}?language=en`)).subject).toBe(`Missing documents — your delivery note ${receipt.supplierDdtNumber}, our receipt ${receipt.number}`)
  })

  it('the warehouse (no email.send) sends it to the supplier’s contact: the mail is on the receipt’s thread, QUEUED on the FAKE provider; a repeat sends nothing more', async () => {
    const key = freshKey()
    const sent = await ok('warehouse', 'POST', url(), { contactIds: [A.orderDesk], note: 'Ci servono entro venerdì.' }, 201, key)
    expect(sent.request).toMatchObject({ to: ['orders.p2@example.com'], language: 'it', status: 'QUEUED', subject: expect.stringContaining('Documenti mancanti') })
    expect(sent.request.documents).toHaveLength(2)
    const [mail] = await admin(
      `SELECT o.status::text AS status, o."to", o.cc, o.subject, o."recordType", o."recordId", o."threadId", a.mode::text AS mode, a.provider::text AS provider
         FROM "EmailOutbound" o JOIN "EmailIdentity" i ON i.id = o."identityId" JOIN "IntegrationAccount" a ON a.id = i."accountId" WHERE o.id = $1`,
      [sent.request.emailId],
    )
    expect(mail).toEqual({ status: 'QUEUED', to: ['orders.p2@example.com'], cc: [], subject: sent.request.subject, recordType: 'GoodsReceipt', recordId: receipt.id, threadId: sent.request.threadId, mode: 'FAKE', provider: 'SES' })
    const [message] = await admin(`SELECT direction::text AS direction, audience::text AS audience, "bodyText", "attachmentFileIds" AS attachments, "authorId" FROM "Message" WHERE id = $1`, [sent.request.messageId])
    expect(message).toMatchObject({ direction: 'OUTBOUND', audience: 'PARTNER', attachments: [], authorId: IDS.warehouse })
    expect(message!.bodyText).toContain('il rapporto di prova del cromo esavalente (Cr VI) — lotto vostro CONC-7, bagno DB-R')
    expect(message!.bodyText).toContain('il certificato del componente DPI — lotto vostro PRO-7')
    expect(message!.bodyText).toContain('Ci servono entro venerdì.')
    expect(message!.bodyText).not.toMatch(/€|EUR|prezz|5,00|6,50/i)
    // The thread's mail as the record's Activity reads it (threads.read), the audit rows and the event the worker takes.
    const emails = (await ok('warehouse', 'GET', `/threads/GoodsReceipt/${receipt.id}/emails`)).emails as Json[]
    expect(emails.map((email) => email.id)).toEqual([sent.request.emailId])
    expect(await admin(`SELECT after->'documents' AS documents, after->>'recipients' AS recipients FROM "AuditLog" WHERE action = 'inventory.receiptDocumentsRequested' AND "recordId" = $1`, [receipt.id])).toEqual([{ documents: sent.request.documents, recipients: '1' }])
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'email.queued' AND subject = $1`, [sent.request.emailId])).toEqual([{ n: 1 }])
    // The same Idempotency-Key answers the first send: no second mail.
    expect((await ok('warehouse', 'POST', url(), { contactIds: [A.orderDesk], note: 'Ci servono entro venerdì.' }, 201, key)).request.emailId).toBe(sent.request.emailId)
    expect(await mailsOf(receipt.id)).toBe(1)
    // The generic mail route stays closed to the warehouse.
    await refused('warehouse', 'POST', `/threads/GoodsReceipt/${receipt.id}/emails`, { to: ['someone@example.com'], subject: 'x', body: 'y' }, 403)
  })

  it('asks for a part only, in English, in the receipt’s order', async () => {
    const leather = lots.find((lot) => lot.supplierLotRef === 'CONC-7')!
    const sent = await ok('warehouse', 'POST', url(), { contactIds: [A.orderDesk], documents: [`${leather.id}:CR_VI_REPORT`], language: 'en' }, 201)
    expect(sent.request).toMatchObject({ language: 'en', documents: [`${leather.id}:CR_VI_REPORT`] })
    const [message] = await admin(`SELECT "bodyText" FROM "Message" WHERE id = $1`, [sent.request.messageId])
    expect(message!.bodyText).toContain('the hexavalent chromium (Cr VI) test report — lot your CONC-7, dye batch DB-R')
    expect(message!.bodyText).not.toContain('PPE')
  })

  it('only the supplier’s own contacts: a contact of another party is refused, alone or beside the supplier’s, and nothing is sent', async () => {
    const before = await mailsOf(receipt.id)
    expect((await refused('warehouse', 'POST', url(), { contactIds: [A.customerBuyer] }, 400)).issues).toEqual([{ path: 'body/contactIds/0', message: expect.stringContaining('Not an active contact of') }])
    expect((await refused('warehouse', 'POST', url(), { contactIds: [A.orderDesk, A.customerBuyer] }, 400)).issues).toEqual([{ path: 'body/contactIds/1', message: expect.stringContaining('Not an active contact of') }])
    // No free address: the body takes contact ids only.
    await refused('warehouse', 'POST', url(), { contactIds: [A.orderDesk], to: ['someone@example.com'] }, 400)
    await refused('warehouse', 'POST', url(), { contactIds: ['someone@example.com'] }, 400)
    expect(await mailsOf(receipt.id)).toBe(before)
  })

  it('refuses in words: a document not missing, a note too long, a supplier with no e-mail', async () => {
    expect((await refused('warehouse', 'POST', url(), { contactIds: [A.orderDesk], documents: ['receipt:DELIVERY_NOTE'] }, 400)).issues).toEqual([{ path: 'body/documents/0', message: 'Not a document this receipt still waits for.' }])
    expect((await refused('warehouse', 'POST', url(), { contactIds: [A.orderDesk], note: 'x'.repeat(501) }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/note' })])
    // The supplier's only contact loses its e-mail: nobody to ask.
    await admin(`UPDATE "PartyContact" SET email = NULL WHERE id = $1`, [A.orderDesk])
    try {
      const error = await refused('warehouse', 'POST', url(), { contactIds: [A.orderDesk] }, 409)
      expect(error.issues).toEqual([{ path: 'contactIds', message: expect.stringContaining('has no active contact with an e-mail') }])
      expect((await ok('warehouse', 'GET', url())).problems).toEqual([{ path: 'contactIds', message: expect.stringContaining('has no active contact with an e-mail') }])
    } finally {
      await admin(`UPDATE "PartyContact" SET email = 'orders.p2@example.com' WHERE id = $1`, [A.orderDesk])
    }
  })

  it('refuses a receipt that waits for nothing, and one reversed', async () => {
    const order = await makeOrder([{ itemId: A.lining, colourId: A.liningGRY, quantity: '100', uom: 'M', unitPrice: '2.000000' }])
    const lining = (await ok('warehouse', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, supplierDdtNumber: `DDT-L-${run}`, supplierDdtDate: '2026-10-29', lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ quantity: '100' }] }] }, 201)).receipt
    const nothing = await ok('warehouse', 'GET', `/inventory/receipts/${lining.id}/documents/request`)
    expect(nothing).toMatchObject({ ready: false, wanted: [], problems: [{ path: 'documents', message: expect.stringContaining('Nothing is missing') }] })
    expect((await refused('warehouse', 'POST', `/inventory/receipts/${lining.id}/documents/request`, { contactIds: [A.orderDesk] }, 409)).issues).toEqual([{ path: 'documents', message: expect.stringContaining('Nothing is missing') }])

    const reversed = await receiptWaitingForDocuments()
    await ok('warehouse', 'POST', `/inventory/receipts/${reversed.id}/reverse`, { version: reversed.version, reason: 'Booked on the wrong order' }, 201)
    const error = await refused('warehouse', 'POST', `/inventory/receipts/${reversed.id}/documents/request`, { contactIds: [A.orderDesk] }, 409)
    expect(error).toMatchObject({ code: 'invalid_state', message: `${reversed.number} is reversed: it waits for no document.` })
    expect((await ok('warehouse', 'GET', `/inventory/receipts/${reversed.id}/documents/request`)).problems).toEqual(expect.arrayContaining([{ path: 'receipt', message: `${reversed.number} is reversed: it waits for no document.` }]))
    expect(await mailsOf(reversed.id)).toBe(0)
  })

  it('a role without the new permission is refused (403), even holding the rest of the warehouse template', async () => {
    expect((await refused('noRequest', 'POST', url(), { contactIds: [A.orderDesk] }, 403)).code).toBe('forbidden')
    expect((await refused('noRequest', 'GET', url(), undefined, 403)).code).toBe('forbidden')
    await refused('viewer', 'POST', url(), { contactIds: [A.orderDesk] }, 403)
  })
})
