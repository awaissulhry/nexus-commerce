import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { BRAND_ALPHA, BRAND_BETA, findMarkers, fixtureMarkers } from '../../golden-flow/portal/testing/two-brands'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { inquirySubjectOf } from './replies'

/**
 * B-TH-046 (threads plan TH-3, N5; wall check W20): saved replies for requests (Sales › Incoming). Inquiry is a record type of
 * the saved replies with its own placeholders — the request's number, what it is about (the subject of the mail it came by,
 * else its first line) and the wanted date — besides the contact, the customer, the writer, today and the company. A reply
 * filled for brand A's request names brand A's own contact only (a contact of brand B is refused at the field); a prospect's
 * request names the prospect. Nothing is sent. Every name and word is made up (the two-brand harness's brands).
 *
 * th-backend-g step 1 (threads plan §0.5, counts do not leak; lead's decision): a text filled for the customer (the default: a mail or a
 * portal message) names the customer's OWN number of its request or order ("#7", "#12"), never the office's series; an office note
 * (audience OFFICE) names the office's; both forms come back for the composer. A prospect has no number of its own: the office's.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/templates`.
 */

type Json = Record<string, any>

let h: Harness
let tenant: TestTenant
let owner: Browser
let companyId: string
const alpha = newId()
const beta = newId()
const alphaContact = newId()
const betaContact = newId()
const alphaRequest = newId()
const prospectRequest = newId()
const alphaOrder = newId() // th-backend-g step 1

const admin = async (sql: string, values: unknown[] = []): Promise<Json[]> => (await h.db.admin.query(sql, values)).rows as Json[]

/** A request row as the inquiries module keeps it (written past its number trigger: test data only). */
async function request(id: string, values: Record<string, string | null>): Promise<void> {
  const columns = Object.keys(values).map((column) => `"${column}"`).join(', ')
  const literals = Object.values(values).map((value) => (value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`)).join(', ')
  await admin(`DO $$ BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO "Inquiry" (id, "tenantId", "companyId", source, "receivedAt", status, ${columns}) VALUES ('${id}', '${tenant.id}', '${companyId}', 'OFFICE', now(), 'NEW', ${literals});
  END $$`)
}

beforeAll(async () => {
  h = await startHarness('templates_inquiries')
  tenant = await addTenant(h, 'tpl-inq')
  companyId = tenant.companies[0]!.id
  await admin(`UPDATE "Company" SET "tradeName" = 'Esempio Moto' WHERE id = $1`, [companyId])
  for (const [party, contact, brand] of [[alpha, alphaContact, BRAND_ALPHA], [beta, betaContact, BRAND_BETA]] as const) {
    await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", "tradeName", roles, language) VALUES ($1, $2, $3, $4, 'ORGANISATION', $5, $6, '{CUSTOMER,BRAND}', 'en')`, [party, tenant.id, companyId, brand.code, brand.legalName, brand.tradeName])
    await admin(`INSERT INTO "PartyContact" (id, "tenantId", "partyId", name, email, language, "updatedAt") VALUES ($1, $2, $3, $4, $5, 'en', now())`, [contact, tenant.id, party, brand.contact.name, brand.contact.email])
  }
  // th-backend-g step 1: brand A's 7th request (its own number) under the office's INQ-2026-0042.
  await request(alphaRequest, { number: 'INQ-2026-0042', customerSeq: '7', partyId: alpha, contactId: alphaContact, request: `Quote for AX-100\n${BRAND_ALPHA.message}`, wantedDate: '2026-12-15' })
  // th-backend-g step 1: brand A's 12th order under the office's SO-2026-0101 (written past its triggers: test data only).
  await admin(`DO $$ BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO "SalesOrder" (id, "tenantId", "companyId", "partyId", number, "customerSeq", "orderDate", "taxMode", "billTo", "shipTo") VALUES ('${alphaOrder}', '${tenant.id}', '${companyId}', '${alpha}', 'SO-2026-0101', 12, '2026-11-01', 'IT_B2B', '{}', '{}');
  END $$`)
  await request(prospectRequest, { number: 'INQ-2026-0043', partyId: null, contactId: null, prospectName: 'Pia Prospect', prospectCompany: 'Moto Club Esempio', prospectEmail: 'pia@moto-club.example.com', prospectLawfulBasis: 'CONTRACT', request: 'Do you make team suits?', wantedDate: null })
  const user = await addUser(h, tenant, { email: 'owner@tpl-inq.example.com', role: 'owner' })
  owner = new Browser(h.app)
  const answer = await owner.signIn(tenant.slug, user.email, user.password)
  if (answer.status !== 200) throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  await enrolTotp(h, owner)
}, 180_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('saved replies for requests (B-TH-046)', () => {
  let reply: Json

  it("Inquiry is a reply record type with the request's own placeholders; another record's placeholder is refused", async () => {
    const list = await owner.get('/templates/replies?recordType=Inquiry')
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect(list.body.placeholders.Inquiry).toEqual(expect.arrayContaining(['contact.name', 'party.name', 'inquiry.number', 'inquiry.subject', 'inquiry.wantedDate']))
    const wrong = await owner.post('/templates/replies', { name: 'Wrong', language: 'en', body: 'About {{order.number}}', recordType: 'Inquiry', companyId: null, shared: true })
    expect(wrong.status).toBe(400)
    const made = await owner.post('/templates/replies', {
      name: 'We got your request',
      language: 'en',
      body: 'Dear {{contact.name}},\nthank you for {{inquiry.number}} ({{inquiry.subject}}), wanted by {{inquiry.wantedDate}}.\n{{company.name}} for {{party.name}}',
      recordType: 'Inquiry',
      companyId,
      shared: true,
    })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    reply = made.body.reply
    expect(reply).toMatchObject({ recordType: 'Inquiry', shared: true })
  })

  it("filled for brand A's request, it names brand A's own contact only (W20) and its own number (§0.5)", async () => {
    const filled = await owner.post(`/templates/replies/${reply.id}/fill`, { recordType: 'Inquiry', recordId: alphaRequest })
    expect(filled.status, JSON.stringify(filled.body)).toBe(200)
    expect(filled.body.missing).toEqual([])
    // th-backend-g step 1: the text goes to the customer (the default): brand A's own number of the request, never the office's series.
    expect(filled.body.body).toBe(`Dear ${BRAND_ALPHA.contact.name},\nthank you for #7 (Quote for AX-100), wanted by 15 Dec 2026.\nEsempio Moto for ${BRAND_ALPHA.tradeName}`)
    expect(filled.body).toMatchObject({ audience: 'CUSTOMER', numbers: [{ placeholder: 'inquiry.number', office: 'INQ-2026-0042', customer: '#7' }] })
    expect(JSON.stringify(filled.body.body)).not.toContain('INQ-')
    expect(findMarkers(filled.body, fixtureMarkers(BRAND_BETA))).toEqual([])
    // REFUSED: a contact of brand B on brand A's request (at the field); nothing names brand B.
    const other = await owner.post(`/templates/replies/${reply.id}/fill`, { recordType: 'Inquiry', recordId: alphaRequest, contactId: betaContact })
    expect(other.status).toBe(400)
    expect(other.body.error.issues[0].path).toBe('body/contactId')
    expect(findMarkers(other.body, fixtureMarkers(BRAND_BETA))).toEqual([])
  })

  // ---- th-backend-g step 1 (§0.5, lead's decision): the office keeps its own series in an office note; the customer reads its own.
  it('an office note names the office’s number; a reply for an order names the customer’s own order number in text to it', async () => {
    const note = await owner.post(`/templates/replies/${reply.id}/fill`, { recordType: 'Inquiry', recordId: alphaRequest, audience: 'OFFICE' })
    expect(note.status, JSON.stringify(note.body)).toBe(200)
    expect(note.body.body).toContain('thank you for INQ-2026-0042 (Quote for AX-100)')
    expect(note.body).toMatchObject({ audience: 'OFFICE', numbers: [{ placeholder: 'inquiry.number', office: 'INQ-2026-0042', customer: '#7' }] })
    const orderReply = await owner.post('/templates/replies', { name: 'Order news', language: 'en', body: 'Your order {{order.number}} is in production.', recordType: 'SalesOrder', companyId, shared: true })
    expect(orderReply.status, JSON.stringify(orderReply.body)).toBe(201)
    const toCustomer = await owner.post(`/templates/replies/${orderReply.body.reply.id}/fill`, { recordType: 'SalesOrder', recordId: alphaOrder })
    expect(toCustomer.status, JSON.stringify(toCustomer.body)).toBe(200)
    expect(toCustomer.body.body).toBe('Your order #12 is in production.')
    const office = await owner.post(`/templates/replies/${orderReply.body.reply.id}/fill`, { recordType: 'SalesOrder', recordId: alphaOrder, audience: 'OFFICE' })
    expect(office.body.body).toBe('Your order SO-2026-0101 is in production.')
    // A reply that names no number answers no pair.
    const plain = await owner.post('/templates/replies', { name: 'Thanks', language: 'en', body: 'Thank you, {{contact.name}}.', recordType: 'Inquiry', companyId, shared: false })
    expect((await owner.post(`/templates/replies/${plain.body.reply.id}/fill`, { recordType: 'Inquiry', recordId: alphaRequest })).body.numbers).toEqual([])
  })
  // ---- end th-backend-g step 1

  it("a prospect's request names the prospect; nothing is sent", async () => {
    const filled = await owner.post(`/templates/replies/${reply.id}/fill`, { recordType: 'Inquiry', recordId: prospectRequest })
    expect(filled.status, JSON.stringify(filled.body)).toBe(200)
    expect(filled.body.body).toContain('Dear Pia Prospect,')
    // th-backend-g step 1: a prospect has no number of its own — its request keeps the office's number.
    expect(filled.body.body).toContain('INQ-2026-0043 (Do you make team suits?)')
    expect(filled.body.body).toContain('for Moto Club Esempio')
    expect(filled.body.missing).toEqual(['inquiry.wantedDate'])
    expect(findMarkers(filled.body, [...fixtureMarkers(BRAND_ALPHA), ...fixtureMarkers(BRAND_BETA)])).toEqual([])
    expect((await admin(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "tenantId" = $1`, [tenant.id]))[0]!.n).toBe(0)
  })

  it('what a request is about: its mail subject, else its first line, at most 120 characters', () => {
    expect(inquirySubjectOf('Re: suits for 2027', 'ignored')).toBe('Re: suits for 2027')
    expect(inquirySubjectOf(null, '\n  Ten race suits\nsizes 48-56')).toBe('Ten race suits')
    expect(inquirySubjectOf('  ', '')).toBeNull()
    expect(inquirySubjectOf(null, 'x'.repeat(200))).toHaveLength(120)
  })
})
