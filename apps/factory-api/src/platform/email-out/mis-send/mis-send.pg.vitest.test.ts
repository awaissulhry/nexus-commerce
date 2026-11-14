import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'

/**
 * The mis-send guard (B-W2b-397; COL-004; design shell.panels pop:mis-send "Send to Pista Racing?") with the app's real route
 * and real sessions on a throwaway PostgreSQL 17 database from the migrations: a sales person checks a message from a
 * customer's thread before sending it — whose each address is (the customer's contact, another customer's contact, a
 * colleague, a domain only one party uses, nobody), what the text says (cost, another customer, a colleague @mentioned) and
 * who sees each attachment — and nothing is written. A role without email.send, a record that does not exist and another
 * record's file are refused or left out. Made-up names and addresses only. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/email-out/mis-send`.
 */

let h: Harness
let tenant: TestTenant
let sales: Browser
let reader: Browser
let companyId = ''
let store = ''
const customer = newId()
const other = newId()
const supplier = newId()

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const count = async (table: string): Promise<number> => Number((await admin<{ n: string }>(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [tenant.id]))[0]!.n)

async function file(recordId: string, name: string, sharing: { visibility: string[]; partyId: string | null }): Promise<string> {
  const id = newId()
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256,
       "storeAccountId", "storageKey", status, visibility, "partyId", "availableAt")
     VALUES ($1, $2, $3, 'Party', $4, 'DOCUMENT', $5, 'application/pdf', 2048, $6, $7, $8, 'AVAILABLE', $9::"FileAudience"[], $10, now())`,
    [id, tenant.id, companyId, recordId, name, createHash('sha256').update(id).digest('hex'), store, `t/${tenant.id}/c/${companyId}/2026/${newId()}`, sharing.visibility, sharing.partyId],
  )
  return id
}

beforeAll(async () => {
  h = await startHarness('mis_send')
  tenant = await addTenant(h, 'ms-a')
  companyId = tenant.companies[0]!.id
  store = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode) VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE')`, [store, tenant.id])
  const ses = (await admin(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'SES'`, [tenant.id]))[0]!.id
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
    await client.emailIdentity.create({
      data: { id: newId(), companyId, kind: 'CONVERSATION', domain: 'ms-a.example.invalid', fromAddress: 'noreply@ms-a.example.invalid', displayName: 'Made-up MS', displayNamePolicy: 'COMPANY', replyDomain: 'reply.ms-a.example.invalid', accountId: ses, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.party.create({ data: { id: customer, companyId, code: 'MS1', kind: 'ORGANISATION', legalName: 'Pista Esempio S.r.l.', tradeName: 'Pista Esempio', roles: ['CUSTOMER'] } })
    await client.party.create({ data: { id: other, companyId, code: 'MS2', kind: 'ORGANISATION', legalName: 'Club Inventato S.p.A.', roles: ['CUSTOMER'] } })
    await client.party.create({ data: { id: supplier, companyId: null, code: 'MS3', kind: 'ORGANISATION', legalName: 'Conceria Immaginaria S.r.l.', roles: ['SUPPLIER'] } })
    await client.partyContact.create({ data: { id: newId(), partyId: customer, name: 'Anna Esempio', email: 'anna@pista.example.invalid' } })
    await client.partyContact.create({ data: { id: newId(), partyId: other, name: 'Bruno Inventato', email: 'bruno@club.example.invalid' } })
    await client.partyContact.create({ data: { id: newId(), partyId: supplier, name: 'Carla Immaginaria', email: 'carla@conceria.example.invalid' } })
  })
  // The display name is the address's local part with spaces (the harness): "marco colombo".
  await addUser(h, tenant, { email: 'marco.colombo@ms-a.example.invalid', role: 'owner' })
  const seller = await addUser(h, tenant, { email: 'sara.sales@ms-a.example.invalid', role: 'sales' })
  sales = new Browser(h.app)
  await sales.signIn('ms-a', seller.email, seller.password)
  await enrolTotp(h, sales)
  const viewer = await addUser(h, tenant, { email: 'rita.reader@ms-a.example.invalid', role: 'read_only' })
  reader = new Browser(h.app)
  await reader.signIn('ms-a', viewer.email, viewer.password)
  await enrolTotp(h, reader)
}, 90_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('the mis-send guard (COL-004)', () => {
  it('says whose each address is, what the text mentions and who sees each attachment, and writes nothing', async () => {
    const shared = await file(customer, 'Scheda taglie.pdf', { visibility: ['OFFICE', 'PARTNER'], partyId: customer })
    const internal = await file(customer, 'Calcolo interno.pdf', { visibility: ['OFFICE'], partyId: null })
    const foreign = await file(other, 'Altro cliente.pdf', { visibility: ['OFFICE', 'PARTNER'], partyId: other })
    const before = { audit: await count('AuditLog'), outbound: await count('EmailOutbound'), events: await count('OutboxEvent') }

    const answer = await sales.post(`/threads/Party/${customer}/emails/check`, {
      to: ['Anna@Pista.example.invalid', 'bruno@club.example.invalid', 'marco.colombo@ms-a.example.invalid', 'nuovo@conceria.example.invalid', 'chiunque@nessuno.example.invalid'],
      subject: 'Taglie e margine',
      body: 'Buongiorno, come per Club Inventato il costo resta. @Marco ci pensi tu? Scrivete a marco.colombo@ms-a.example.invalid.',
      attachments: [shared, internal, foreign],
    })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const view = answer.body
    expect(view.party).toEqual({ id: customer, name: 'Pista Esempio' })
    expect(view.recipients).toEqual([
      { address: 'anna@pista.example.invalid', kind: 'PARTY', source: 'CONTACT', organisation: { id: customer, name: 'Pista Esempio' }, personName: 'Anna Esempio' },
      { address: 'bruno@club.example.invalid', kind: 'OTHER_PARTY', source: 'CONTACT', organisation: { id: other, name: 'Club Inventato S.p.A.' }, personName: 'Bruno Inventato' },
      { address: 'marco.colombo@ms-a.example.invalid', kind: 'OURS', source: 'COLLEAGUE', organisation: null, personName: null },
      { address: 'nuovo@conceria.example.invalid', kind: 'OTHER_PARTY', source: 'DOMAIN', organisation: { id: supplier, name: 'Conceria Immaginaria S.r.l.' }, personName: null },
      { address: 'chiunque@nessuno.example.invalid', kind: 'UNKNOWN', source: null, organisation: null, personName: null },
    ])
    expect(view.warnings).toEqual([
      { code: 'OTHER_ORGANISATION', items: ['Club Inventato S.p.A.', 'Conceria Immaginaria S.r.l.'] },
      { code: 'UNKNOWN_RECIPIENT', items: ['chiunque@nessuno.example.invalid'] },
      { code: 'MENTIONS_COST', items: ['costo', 'margine'] },
      { code: 'NAMES_OTHER_CUSTOMER', items: ['Club Inventato S.p.A.'] },
      { code: 'INTERNAL_MENTION', items: ['marco colombo'] },
      { code: 'OFFICE_FILE', items: ['Calcolo interno.pdf'] },
    ])
    // Another record's file is never named.
    expect(view.attachments).toEqual([
      { id: shared, name: 'Scheda taglie.pdf', sizeBytes: 2048, audience: 'PARTY' },
      { id: internal, name: 'Calcolo interno.pdf', sizeBytes: 2048, audience: 'OFFICE' },
    ])
    expect({ audit: await count('AuditLog'), outbound: await count('EmailOutbound'), events: await count('OutboxEvent') }).toEqual(before)
  })

  it('finds nothing to say about a plain message to the customer’s own contact', async () => {
    const answer = await sales.post(`/threads/Party/${customer}/emails/check`, { to: ['anna@pista.example.invalid'], body: 'Buongiorno, le taglie sono confermate.' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.warnings).toEqual([])
    expect(answer.body.attachments).toEqual([])
  })

  it('refuses a role without email.send, a record that does not exist and a body without recipients', async () => {
    const refused = await reader.post(`/threads/Party/${customer}/emails/check`, { to: ['anna@pista.example.invalid'], body: 'Ciao' })
    expect(refused.status, JSON.stringify(refused.body)).toBe(403)
    const missing = await sales.post(`/threads/Party/${newId()}/emails/check`, { to: ['anna@pista.example.invalid'], body: 'Ciao' })
    expect(missing.status, JSON.stringify(missing.body)).toBe(404)
    const empty = await sales.post(`/threads/Party/${customer}/emails/check`, { to: [], body: 'Ciao' })
    expect(empty.status, JSON.stringify(empty.body)).toBe(400)
  })
})
