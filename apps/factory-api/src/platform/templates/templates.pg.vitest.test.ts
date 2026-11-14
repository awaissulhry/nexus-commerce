import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DocumentTemplateKind } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { sampleDocument } from '@nexus/factory-domain/documents/sample'
import { DOCUMENT_TEMPLATE_KINDS } from '@nexus/factory-domain/templates/documents'
import { callerFor, type CommandCaller } from '../../core/command'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { companyLegalOf } from '../documents/documents'
import { systemContext } from '../outbox/system'
import { mailWordsOf } from './active'

/**
 * Templates (B-W2b-422; PLT-131, PLT-231, PLT-232, COL-016) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and the …_config_templates_w2b_guards triggers are real), the real
 * office sign-in, real HTTP with cookies and CSRF. Two tenants; every company, person, address and word is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/templates`.
 */

type Json = Record<string, any>

let h: Harness
let tenant: TestTenant
let tenantB: TestTenant
let owner: Browser
let sales: Browser
let finance: Browser
let readOnly: Browser
let ownerB: Browser
let companyA: string
let companyA2: string
const party = newId()
const contactEn = newId()
const contactNone = newId()
const contactDe = newId()

const admin = async (sql: string, values: unknown[] = []): Promise<Json[]> => (await h.db.admin.query(sql, values)).rows as Json[]
const system = (tenantId = tenant.id): CommandCaller => callerFor(h.database, systemContext(tenantId, newId()))
const del = (browser: Browser, url: string) => browser.send('DELETE' as never, url)
const events = async (type: string): Promise<Json[]> => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant.id, type])

async function signedIn(target: TestTenant, email: string, role: string): Promise<Browser> {
  const user = await addUser(h, target, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(target.slug, user.email, user.password)
  if (answer.status !== 200) throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  // Office roles that ask two-factor give their permissions once it is set up.
  await enrolTotp(h, browser)
  return browser
}

beforeAll(async () => {
  h = await startHarness('templates')
  tenant = await addTenant(h, 'tpl-a', 2)
  tenantB = await addTenant(h, 'tpl-b')
  companyA = tenant.companies[0]!.id
  companyA2 = tenant.companies[1]!.id
  // Company C1's legal data (made up): the documents print it.
  await admin(
    `UPDATE "Company" SET "vatNumber" = 'IT00000000000', "fiscalCode" = '00000000000', "reaOffice" = 'FI', "reaNumber" = '123456', "shareCapital" = 10000, "tradeName" = 'Esempio Moto', pec = 'tpl-a@pec.example.com',
       address = '{"line1":"Via Esempio 1","postalCode":"50100","city":"Firenze","province":"FI","country":"IT"}'::jsonb, "documentFooter" = 'Company footer (made up)'
     WHERE id = $1`,
    [companyA],
  )
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, language) VALUES ($1, $2, $3, 'CLI-T1', 'ORGANISATION', 'Cliente Esempio S.r.l.', '{CUSTOMER}', 'it')`, [party, tenant.id, companyA])
  for (const [id, name, language] of [[contactEn, 'Ann Example', 'en'], [contactNone, 'Bruno Esempio', null], [contactDe, 'Greta Beispiel', 'de']] as const) {
    await admin(`INSERT INTO "PartyContact" (id, "tenantId", "partyId", name, email, language, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, now())`, [id, tenant.id, party, name, `${name.split(' ')[0]!.toLowerCase()}@cliente-esempio.example.com`, language])
  }
  owner = await signedIn(tenant, 'owner@tpl-a.example.com', 'owner')
  sales = await signedIn(tenant, 'sales@tpl-a.example.com', 'sales')
  finance = await signedIn(tenant, 'finance@tpl-a.example.com', 'finance')
  readOnly = await signedIn(tenant, 'reader@tpl-a.example.com', 'read_only')
  ownerB = await signedIn(tenantB, 'owner@tpl-b.example.com', 'owner')
}, 180_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('document templates (PLT-231)', () => {
  let first: Json
  let second: Json

  it("the kinds are the database's, each with its optional and mandatory columns and placeholders", async () => {
    expect([...DOCUMENT_TEMPLATE_KINDS].sort()).toEqual(Object.values(DocumentTemplateKind).sort())
    const kinds = await owner.get('/templates/documents/kinds')
    expect(kinds.status).toBe(200)
    const quote = kinds.body.kinds.find((entry: Json) => entry.kind === 'QUOTE')
    expect(quote).toMatchObject({ layout: 'QUOTE/2', optionalColumns: ['code', 'uom', 'unitPrice', 'discount'], mandatoryColumns: ['description', 'quantity', 'amount'] })
    expect(quote.placeholders).toContain('quote.validUntil')
    const list = await owner.get(`/templates/documents?companyId=${companyA}`)
    expect(list.status).toBe(200)
    expect(list.body.templates).toEqual([])
    expect(list.body.slots).toHaveLength(12)
    expect(list.body.slots.every((slot: Json) => slot.active === null && !slot.layout.includes('+t'))).toBe(true)
  })

  it('a draft starts from the code layout, takes words and columns, refuses a mandatory column, and is published', async () => {
    const made = await owner.post('/templates/documents', { companyId: companyA, kind: 'QUOTE', language: 'it' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    first = made.body.template
    expect(first).toMatchObject({ kind: 'QUOTE', language: 'it', revision: 1, status: 'DRAFT', header: null, fieldsShown: ['code', 'uom', 'unitPrice', 'discount'], layout: 'QUOTE/2+t1' })
    // REFUSED: the amount is always printed; an unknown placeholder.
    const refused = await owner.put(`/templates/documents/${first.id}`, { version: first.version, fieldsShown: ['amount'], header: '{{order.promiseDate}}' })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/header', 'body/fieldsShown/0'])
    const saved = await owner.put(`/templates/documents/${first.id}`, { version: first.version, header: 'Offerta {{quote.number}} per {{party.name}}:', terms: 'Condizioni (inventate).\nSeconda riga.', footer: 'Grazie da {{company.name}}.', fieldsShown: ['discount', 'unitPrice'] })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.template.fieldsShown).toEqual(['unitPrice', 'discount'])
    const published = await owner.post(`/templates/documents/${first.id}/publish`, { version: saved.body.template.version })
    expect(published.status, JSON.stringify(published.body)).toBe(200)
    expect(published.body).toMatchObject({ template: { status: 'ACTIVE', publishedBy: { name: 'owner' } }, retired: null })
    first = published.body.template
  })

  it('a document printed after it reads it first (header, terms, footer, columns); another company or language prints the code layout', async () => {
    const company = await companyLegalOf(system(), companyA)
    const composed = composeDocument(sampleDocument('QUOTE', 'it', company, '2026-11-14'))
    expect(composed).toMatchObject({ layout: 'QUOTE/2+t1', intro: 'Offerta SAMPLE per Example Customer S.r.l.:', terms: 'Condizioni (inventate).\nSeconda riga.', footer: { text: 'Grazie da Esempio Moto.' } })
    expect(composed.table.columns.map((column) => column.key)).toEqual(['description', 'quantity', 'unitPrice', 'discount', 'amount'])
    expect(composeDocument(sampleDocument('QUOTE', 'en', company, '2026-11-14')).layout).toBe('QUOTE/2')
    // An office caller reads it as the system does; another tenant never.
    const preview = await owner.get(`/templates/documents/${first.id}/preview`)
    expect(preview.status).toBe(200)
    expect(preview.response.headers['content-type']).toContain('application/pdf')
    expect(preview.response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await ownerB.get(`/templates/documents/${first.id}`)).status).toBe(404)
  })

  it('a published version never changes nor goes; one draft at a time; publishing the next retires the one in use in one command', async () => {
    expect((await owner.put(`/templates/documents/${first.id}`, { version: first.version, header: 'x' })).body.error.issues[0].path).toBe('refusal/NOT_A_DRAFT')
    expect((await del(owner, `/templates/documents/${first.id}?version=${first.version}`)).status).toBe(409)
    const made = await owner.post('/templates/documents', { companyId: companyA, kind: 'QUOTE', language: 'it' })
    expect(made.status).toBe(201)
    second = made.body.template
    expect(second).toMatchObject({ revision: 2, header: first.header, fieldsShown: ['unitPrice', 'discount'] })
    const again = await owner.post('/templates/documents', { companyId: companyA, kind: 'QUOTE', language: 'it' })
    expect(again.status).toBe(409)
    expect(again.body.error.issues[0].path).toBe('refusal/DRAFT_OPEN')
    // A stale version is refused.
    expect((await owner.post(`/templates/documents/${second.id}/publish`, { version: second.version + 5 })).status).toBe(409)
    const published = await owner.post(`/templates/documents/${second.id}/publish`, { version: second.version })
    expect(published.status, JSON.stringify(published.body)).toBe(200)
    expect(published.body.retired).toEqual({ id: first.id, revision: 1 })
    const rows = await admin(`SELECT revision, status, "retiredAt" IS NOT NULL AS retired FROM "DocumentTemplate" WHERE "companyId" = $1 ORDER BY revision`, [companyA])
    expect(rows).toEqual([{ revision: 1, status: 'RETIRED', retired: true }, { revision: 2, status: 'ACTIVE', retired: false }])
    const list = await owner.get(`/templates/documents?companyId=${companyA}&kind=QUOTE`)
    expect(list.body.slots.find((slot: Json) => slot.kind === 'QUOTE' && slot.language === 'it')).toMatchObject({ layout: 'QUOTE/2+t2', active: { revision: 2 }, draft: null, versions: 2 })
    // Retired: the code's layout prints again.
    const retired = await owner.post(`/templates/documents/${second.id}/retire`, { version: published.body.template.version })
    expect(retired.status).toBe(200)
    expect(composeDocument(sampleDocument('QUOTE', 'it', await companyLegalOf(system(), companyA), '2026-11-14')).layout).toBe('QUOTE/2')
    expect((await owner.post(`/templates/documents/${second.id}/retire`, { version: retired.body.template.version })).body.error.issues[0].path).toBe('refusal/NOT_IN_USE')
  })

  it('a draft is deleted; who may not write templates is refused; the events and audit rows are written', async () => {
    const made = await owner.post('/templates/documents', { companyId: companyA, kind: 'DDT', language: 'en', footer: 'Goods travel at the buyer’s risk (made up).' })
    expect(made.status).toBe(201)
    expect(made.body.template.fieldsShown).toEqual(['code'])
    expect((await readOnly.get(`/templates/documents/${made.body.template.id}`)).status).toBe(200)
    expect((await readOnly.put(`/templates/documents/${made.body.template.id}`, { version: 1, footer: null })).status).toBe(403)
    expect((await readOnly.post('/templates/documents', { companyId: companyA, kind: 'DDT', language: 'it' })).status).toBe(403)
    const gone = await del(owner, `/templates/documents/${made.body.template.id}?version=${made.body.template.version}`)
    expect(gone.status, JSON.stringify(gone.body)).toBe(200)
    const changes = (await events('document_template.changed')).map((row) => `${row.payload.kind}/${row.payload.language}/${row.payload.revision} ${row.payload.change}`)
    expect(changes).toEqual(['QUOTE/it/1 CREATED', 'QUOTE/it/1 EDITED', 'QUOTE/it/1 PUBLISHED', 'QUOTE/it/2 CREATED', 'QUOTE/it/1 RETIRED', 'QUOTE/it/2 PUBLISHED', 'QUOTE/it/2 RETIRED', 'DDT/en/1 CREATED', 'DDT/en/1 DELETED'])
    const audits = await admin(`SELECT action FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'DocumentTemplate' ORDER BY at, id`, [tenant.id])
    expect(audits.map((row) => row.action)).toContain('templates.publishDocument')
  })
})

describe('e-mail templates (PLT-232)', () => {
  it("lists the events with the code's words, writes a company's draft from them, refuses an unknown placeholder, previews it", async () => {
    const offered = await owner.get('/templates/mail/events')
    expect(offered.status).toBe(200)
    expect(offered.body.events.map((entry: Json) => entry.event)).toEqual(['service.status_changed', 'shipping.tracking_link'])
    const made = await owner.post('/templates/mail', { companyId: companyA, event: 'service.status_changed', language: 'it' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.template).toMatchObject({ companyId: companyA, revision: 1, status: 'DRAFT', subject: 'Pratica di assistenza {{case.number}}: {{case.status}}' })
    const bad = await owner.put(`/templates/mail/${made.body.template.id}`, { version: made.body.template.version, body: 'Gentile {{contact.name}}, il suo ordine {{order.number}}.' })
    expect(bad.status).toBe(400)
    const saved = await owner.put(`/templates/mail/${made.body.template.id}`, { version: made.body.template.version, subject: '{{company.name}} · pratica {{case.number}}', body: 'Gentile {{contact.name}},\nla pratica {{case.number}} è {{case.status}}.\n\n{{message}}\n\n{{company.legalName}}' })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    const preview = await owner.post(`/templates/mail/${made.body.template.id}/preview`, {})
    expect(preview.status).toBe(200)
    expect(preview.body).toEqual({ subject: 'Esempio Moto · pratica SVC-2026-0042', body: 'Gentile Anna Esempio,\nla pratica SVC-2026-0042 è in lavorazione.\n\nIl tecnico la chiamerà domani in mattinata.\n\nTest company C1', missing: [] })
    const published = await owner.post(`/templates/mail/${made.body.template.id}/publish`, { version: saved.body.template.version })
    expect(published.status).toBe(200)
  })

  it("the mail reads the company's own version, else every company's, else the code's words", async () => {
    const all = await owner.post('/templates/mail', { companyId: null, event: 'service.status_changed', language: 'it', subject: 'Gruppo · pratica {{case.number}}' })
    expect(all.status, JSON.stringify(all.body)).toBe(201)
    expect((await owner.post(`/templates/mail/${all.body.template.id}/publish`, { version: all.body.template.version })).status).toBe(200)
    const values = { 'case.number': 'SVC-9', 'case.status': 'risolta', 'case.sentence': '', 'contact.name': 'Ann', message: '', 'company.name': 'Esempio Moto', 'company.legalName': 'Test company C1', 'company.tradeName': 'Esempio Moto' }
    const read = (companyId: string, language: string) => system().withClient((db) => mailWordsOf(db, systemContext(tenant.id, newId()), { companyId, event: 'service.status_changed', language, values }))
    expect(await read(companyA, 'it')).toEqual({ subject: 'Esempio Moto · pratica SVC-9', body: 'Gentile Ann,\nla pratica SVC-9 è risolta.\n\nTest company C1' })
    expect((await read(companyA2, 'it'))?.subject).toBe('Gruppo · pratica SVC-9')
    expect(await read(companyA, 'en')).toBeNull()
    // A floor or partner context reads no template (the code's words go).
    expect(await system().withClient((db) => mailWordsOf(db, { audience: 'floor' }, { companyId: companyA, event: 'service.status_changed', language: 'it', values }))).toBeNull()
    // Every company's templates need the permission over every company: the list says who may.
    const list = await owner.get(`/templates/mail?companyId=${companyA2}`)
    expect(list.body.mayManage).toEqual({ company: true, all: true })
    expect(list.body.slots.find((slot: Json) => slot.event === 'service.status_changed' && slot.language === 'it')).toMatchObject({ inUse: 'ALL', company: { active: null }, all: { active: { revision: 1 } } })
    expect((await finance.post('/templates/mail', { companyId: null, event: 'service.status_changed', language: 'en' })).status).toBe(403)
  })
})

describe('saved replies (COL-016)', () => {
  let own: Json
  let shared: Json

  it('a person keeps their own, the administrator keeps shared ones; nobody else sees another person’s own', async () => {
    const made = await finance.post('/templates/replies', { name: 'Promemoria (mio)', language: 'it', body: 'Gentile {{contact.name}}, le scrivo per {{party.name}}. {{me.name}}', recordType: 'Party', companyId: null, shared: false })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    own = made.body.reply
    expect(own).toMatchObject({ shared: false, owner: { name: 'finance' }, mayChange: true })
    // REFUSED: a shared reply without email.replies.share; a placeholder the record type does not fill.
    expect((await finance.post('/templates/replies', { name: 'Shared', language: 'it', body: 'x', recordType: null, companyId: null, shared: true })).status).toBe(403)
    expect((await owner.post('/templates/replies', { name: 'Delay', language: 'en', body: '{{order.number}}', recordType: 'Party', companyId: null, shared: true })).status).toBe(400)
    const team = await owner.post('/templates/replies', { name: 'Delay notice', language: 'en', body: 'Dear {{contact.name}},\nwe are late for {{party.name}}.\n{{company.name}}, {{today}}', recordType: null, companyId: companyA, shared: true })
    expect(team.status, JSON.stringify(team.body)).toBe(201)
    shared = team.body.reply
    const salesList = await sales.get('/templates/replies')
    expect(salesList.body).toMatchObject({ replies: [{ name: 'Delay notice', shared: true, owner: null, mayChange: false }], mayShare: false })
    const financeList = await finance.get('/templates/replies?language=en')
    expect(financeList.body.replies).toEqual([expect.objectContaining({ name: 'Delay notice', shared: true, mayChange: false })])
    expect((await sales.put(`/templates/replies/${own.id}`, { version: own.version, name: 'Taken' })).status).toBe(404)
    expect((await finance.put(`/templates/replies/${shared.id}`, { version: shared.version, name: 'Mine now' })).status).toBe(403)
  })

  it("fills a reply with a record's values for the message box (nothing is sent)", async () => {
    const filled = await finance.post(`/templates/replies/${own.id}/fill`, { recordType: 'Party', recordId: party, contactId: contactEn })
    expect(filled.status, JSON.stringify(filled.body)).toBe(200)
    expect(filled.body).toEqual({ body: 'Gentile Ann Example, le scrivo per Cliente Esempio S.r.l.. finance', language: 'it', missing: [] })
    const noContact = await sales.post(`/templates/replies/${shared.id}/fill`, { recordType: 'Party', recordId: party })
    expect(noContact.body.missing).toEqual(['contact.name'])
    expect(noContact.body.body.startsWith('Dear ,\nwe are late for Cliente Esempio S.r.l..\nEsempio Moto, ')).toBe(true)
    expect((await ownerB.post(`/templates/replies/${shared.id}/fill`, { recordType: 'Party', recordId: party })).status).toBe(404)
    const outbound = await admin(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "tenantId" = $1`, [tenant.id])
    expect(outbound[0]!.n).toBe(0)
    const changed = await owner.put(`/templates/replies/${shared.id}`, { version: shared.version, name: 'Delay notice (v2)' })
    expect(changed.status).toBe(200)
    expect((await del(sales, `/templates/replies/${shared.id}?version=${changed.body.reply.version}`)).status).toBe(403)
    expect((await del(owner, `/templates/replies/${shared.id}?version=${changed.body.reply.version}`)).status).toBe(200)
    expect((await events('saved_reply.changed')).map((row) => row.payload.change)).toEqual(['CREATED', 'CREATED', 'EDITED', 'DELETED'])
  })
})

describe("the partner contact's language (PLT-131)", () => {
  it("is the contact's, else the party's; English for a language documents are not written in", async () => {
    expect((await sales.get(`/templates/language?partyId=${party}&contactId=${contactEn}`)).body).toEqual({ partyId: party, contactId: contactEn, language: 'en', source: 'CONTACT', notOffered: null })
    expect((await sales.get(`/templates/language?partyId=${party}&contactId=${contactNone}`)).body).toMatchObject({ language: 'it', source: 'PARTY' })
    expect((await sales.get(`/templates/language?partyId=${party}&contactId=${contactDe}`)).body).toMatchObject({ language: 'en', source: 'CONTACT', notOffered: 'de' })
    expect((await sales.get(`/templates/language?partyId=${party}&contactId=${newId()}`)).status).toBe(400)
    expect((await ownerB.get(`/templates/language?partyId=${party}`)).status).toBe(404)
  })

  it('lists the contacts with their own language and what goes out, a page at a time', async () => {
    const page = await sales.get('/templates/languages/contacts?limit=2')
    expect(page.status).toBe(200)
    expect(page.body.contacts.map((contact: Json) => [contact.name, contact.own, contact.language, contact.source])).toEqual([
      ['Ann Example', 'en', 'en', 'CONTACT'],
      ['Bruno Esempio', null, 'it', 'PARTY'],
    ])
    const next = await sales.get(`/templates/languages/contacts?limit=2&cursor=${page.body.nextCursor}`)
    expect(next.body).toMatchObject({ contacts: [{ name: 'Greta Beispiel', language: 'en', notOffered: 'de', party: { code: 'CLI-T1' } }], nextCursor: null })
    expect((await ownerB.get('/templates/languages/contacts')).body.contacts).toEqual([])
  })
})
