import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { codeWordsOf, emailTemplateProblems, MAIL_DRAFTS, MAIL_EVENT_DEFINITIONS, MAIL_EVENTS } from '@nexus/factory-domain/templates/mail'
import { DRAFTED_LANGUAGES, LANGUAGE_REVIEW, messageLanguageOf, unreadWords } from '@nexus/factory-domain/templates/message-languages'
import { BRAND_ALPHA, BRAND_BETA } from '../../golden-flow/portal/testing/two-brands'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { MAIL_FILL_WORDS } from './replies'
// th-backend-g step 2: the receipt of a request (the language rule of B-TH-098, the one who sent it) and its worker.
import { callerFor } from '../../core/command'
import { systemContext } from '../outbox/system'
import { requestReceiptHandler, sendRequestReceipt } from '../../modules/sales/inquiries/receipt'

/**
 * B-TH-098 (threads plan TH-9, thread-G07; T8-F02 "Saved replies ▾ in the customer's language"; plan decision: "mail texts in DE/FR/ES
 * drafted by Claude, read once by the Owner or a trusted customer contact") and B-TH-279's back end (the request mails and the
 * new-message notice as e-mail templates).
 *
 *   saved replies       written by people in Italian, English, German, French or Spanish; another language is refused in words
 *   the language        a German contact's message language is German (its fixed texts not read yet: `read` false); a Portuguese
 *                       one's is English, Portuguese named as not offered; documents stay Italian or English
 *   the fixed texts     every event has German, French and Spanish drafts using only its own placeholders; an unread draft never
 *                       goes on its own (English, said why) — with the office's tick it is used, and the tick is recorded
 *   the request mails   request.received names the customer's OWN number of the request (never the office's series: §0.5);
 *                       the new-message notice is Nexus's own (no starting words to fill)
 *
 * Every name and word is made up (the two-brand harness's brands). Run with `node scripts/factory/run-pg-tests.mjs platform/templates`.
 */

type Json = Record<string, any>

let h: Harness
let tenant: TestTenant
let owner: Browser
let companyId: string
const german = newId()
const portuguese = newId()
const germanContact = newId()
const portugueseContact = newId()
const germanRequest = newId()
// th-backend-g step 2: more of brand A's requests (8, 9, 10) for the receipt; the mails two of them were made from.
const germanRequest2 = newId()
const mailRequest = newId()
const forwardedRequest = newId()
const ownMail = newId()
const forwardedMail = newId()
const system = () => callerFor(h.database, systemContext(tenant.id, `test-${newId()}`))

const admin = async (sql: string, values: unknown[] = []): Promise<Json[]> => (await h.db.admin.query(sql, values)).rows as Json[]

beforeAll(async () => {
  h = await startHarness('templates_reply_languages')
  tenant = await addTenant(h, 'tpl-lang')
  companyId = tenant.companies[0]!.id
  await admin(`UPDATE "Company" SET "tradeName" = 'Esempio Moto', locale = 'it' WHERE id = $1`, [companyId])
  for (const [party, contact, brand, language] of [[german, germanContact, BRAND_ALPHA, 'de'], [portuguese, portugueseContact, BRAND_BETA, 'pt']] as const) {
    await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", "tradeName", roles, language) VALUES ($1, $2, $3, $4, 'ORGANISATION', $5, $6, '{CUSTOMER,BRAND}', $7)`, [party, tenant.id, companyId, brand.code, brand.legalName, brand.tradeName, language])
    await admin(`INSERT INTO "PartyContact" (id, "tenantId", "partyId", name, email, language, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, now())`, [contact, tenant.id, party, brand.contact.name, brand.contact.email, language])
  }
  // Brand A's 7th request (its own number) under the office's INQ-2026-0042 — written past the number triggers: test data only.
  await admin(`DO $$ BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO "Inquiry" (id, "tenantId", "companyId", source, "receivedAt", status, number, "partyId", "contactId", request, "customerSeq")
    VALUES ('${germanRequest}', '${tenant.id}', '${companyId}', 'OFFICE', now(), 'NEW', 'INQ-2026-0042', '${german}', '${germanContact}', 'Made-up: 40 jackets for the spring', 7);
  END $$`)
  // ---- th-backend-g step 2: a sending address (the FAKE mail account), brand A's requests 8 (typed), 9 (from its contact's own mail,
  // DMARC passed) and 10 (made from a mail of another address), written past their triggers: test data only.
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-tpl-lang', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    await client.emailIdentity.create({ data: { id: newId(), companyId, kind: 'NOTIFICATION', domain: 'mail.tpl-lang.example.com', fromAddress: 'noreply@mail.tpl-lang.example.com', displayName: 'Esempio Moto', displayNamePolicy: 'COMPANY', replyDomain: 'reply.tpl-lang.example.com', accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true } })
  })
  await admin(`DO $$ BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO "InboundEmail" (id, "tenantId", "companyId", "accountId", "receiptId", "sesMessageId", "s3Bucket", "s3Key", "receivedAt", "fromAddress", subject, "spfVerdict", "dkimVerdict", "dmarcVerdict", "spamVerdict", "virusVerdict", status)
    VALUES ('${ownMail}', '${tenant.id}', '${companyId}', '${newId()}', '${newId()}', 'ses-own', 'bucket', 'own', now(), '${BRAND_ALPHA.contact.email.toLowerCase()}', 'Made-up: 20 vests', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'RECEIVED'),
           ('${forwardedMail}', '${tenant.id}', '${companyId}', '${newId()}', '${newId()}', 'ses-fwd', 'bucket', 'fwd', now(), 'someone@forwarder.example.com', 'Fwd: 5 vests', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'RECEIVED');
    INSERT INTO "Inquiry" (id, "tenantId", "companyId", source, "sourceEmailId", "receivedAt", status, number, "partyId", "contactId", request, "customerSeq") VALUES
      ('${germanRequest2}', '${tenant.id}', '${companyId}', 'OFFICE', NULL, now(), 'NEW', 'INQ-2026-0043', '${german}', '${germanContact}', 'Made-up: 12 jackets', 8),
      ('${mailRequest}', '${tenant.id}', '${companyId}', 'MAIL', '${ownMail}', now(), 'NEW', 'INQ-2026-0044', '${german}', '${germanContact}', 'Made-up: 20 vests', 9),
      ('${forwardedRequest}', '${tenant.id}', '${companyId}', 'MAIL', '${forwardedMail}', now(), 'NEW', 'INQ-2026-0045', '${german}', '${germanContact}', 'Made-up: 5 vests', 10);
  END $$`)
  // ---- end th-backend-g step 2
  const user = await addUser(h, tenant, { email: 'owner@tpl-lang.example.com', role: 'owner' })
  owner = new Browser(h.app)
  const answer = await owner.signIn(tenant.slug, user.email, user.password)
  if (answer.status !== 200) throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  await enrolTotp(h, owner)
}, 180_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('B-TH-098: the drafted texts and their reading (pure)', () => {
  it('every event has German, French and Spanish drafts that use only its own placeholders', () => {
    for (const event of MAIL_EVENTS) {
      for (const language of DRAFTED_LANGUAGES) expect(emailTemplateProblems(event, language, MAIL_DRAFTS[event][language]), `${event} ${language}`).toEqual([])
      for (const language of ['it', 'en'] as const) expect(emailTemplateProblems(event, language, MAIL_EVENT_DEFINITIONS[event].words[language]), `${event} ${language}`).toEqual([])
    }
  })

  it('a drafted language not read yet never goes on its own: English, said why; the tick uses the draft', () => {
    expect(LANGUAGE_REVIEW.de.readBy).toBeNull()
    const plain = codeWordsOf('request.need_info', 'de')
    expect(plain).toMatchObject({ language: 'en', read: false, fellBack: true })
    expect(plain.words).toEqual(MAIL_EVENT_DEFINITIONS['request.need_info'].words.en)
    const ticked = codeWordsOf('request.need_info', 'de', { sendUnread: true })
    expect(ticked).toMatchObject({ language: 'de', read: false, fellBack: false })
    expect(ticked.words).toEqual(MAIL_DRAFTS['request.need_info'].de)
    expect(codeWordsOf('request.need_info', 'it')).toMatchObject({ language: 'it', read: true, fellBack: false })
    expect(unreadWords('de', 'en')).toContain('German text was drafted by Claude')
  })

  it('the message language: German stays German, Portuguese is English with "pt" named; none: Italian', () => {
    expect(messageLanguageOf({ contact: 'de-DE' })).toEqual({ language: 'de', source: 'CONTACT', notOffered: null, read: false })
    expect(messageLanguageOf({ contact: null, party: 'pt' })).toEqual({ language: 'en', source: 'PARTY', notOffered: 'pt', read: true })
    expect(messageLanguageOf({})).toEqual({ language: 'it', source: 'COMPANY', notOffered: null, read: true })
  })
})

describe('B-TH-098: saved replies in the customer’s language', () => {
  it('a German reply is written, listed by language and filled; Portuguese is refused in words', async () => {
    const made = await owner.post('/templates/replies', { name: 'Anfrage erhalten', language: 'de', body: 'Guten Tag {{contact.name}},\nIhre Anfrage {{inquiry.yourNumber}} ist bei uns.', recordType: 'Inquiry', companyId, shared: true })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const listed = await owner.get('/templates/replies?language=de&recordType=Inquiry')
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.replies.map((reply: Json) => reply.name)).toEqual(['Anfrage erhalten'])
    const filled = await owner.post(`/templates/replies/${made.body.reply.id}/fill`, { recordType: 'Inquiry', recordId: germanRequest })
    expect(filled.status, JSON.stringify(filled.body)).toBe(200)
    // th-backend-g step 1: filled for the customer (the default), naming no record number.
    expect(filled.body).toEqual({ body: `Guten Tag ${BRAND_ALPHA.contact.name},\nIhre Anfrage 7 ist bei uns.`, language: 'de', missing: [], audience: 'CUSTOMER', numbers: [] })
    const refused = await owner.post('/templates/replies', { name: 'Pedido', language: 'pt', body: 'Olá', recordType: null, companyId, shared: true })
    expect(refused.status).toBe(400)
  })

  it('the send panel’s language: German for the German contact (its fixed texts not read yet), English for the Portuguese one', async () => {
    const de = await owner.get(`/templates/language?partyId=${german}&contactId=${germanContact}`)
    expect(de.status, JSON.stringify(de.body)).toBe(200)
    expect(de.body).toMatchObject({ language: 'en', notOffered: 'de', message: { language: 'de', source: 'CONTACT', notOffered: null, read: false } })
    const pt = await owner.get(`/templates/language?partyId=${portuguese}&contactId=${portugueseContact}`)
    expect(pt.body.message).toEqual({ language: 'en', source: 'CONTACT', notOffered: 'pt', read: true })
  })
})

describe('B-TH-279 / B-TH-098: the request mails and the new-message notice as e-mail templates', () => {
  it('lists six events with the code’s words, the drafts and each drafted language’s reading', async () => {
    const offered = await owner.get('/templates/mail/events')
    expect(offered.status, JSON.stringify(offered.body)).toBe(200)
    expect(offered.body.events.map((entry: Json) => entry.event)).toEqual(['service.status_changed', 'shipping.tracking_link', 'request.received', 'request.need_info', 'request.declined', 'thread.message_posted'])
    const needInfo = offered.body.events.find((entry: Json) => entry.event === 'request.need_info')
    expect(Object.keys(needInfo.drafts).sort()).toEqual(['de', 'es', 'fr'])
    expect(needInfo.placeholders).toEqual(expect.arrayContaining(['inquiry.yourNumber', 'question']))
    expect(offered.body.review.de).toEqual({ readBy: null, readOn: null })
    expect(offered.body.messageLanguages).toEqual(['it', 'en', 'de', 'fr', 'es'])
  })

  it('"Ask for info" for the German customer: English until German is read, the German draft with the tick (recorded)', async () => {
    const plain = await owner.post('/templates/mail/events/request.need_info/fill', { recordType: 'Inquiry', recordId: germanRequest })
    expect(plain.status, JSON.stringify(plain.body)).toBe(200)
    expect(plain.body).toMatchObject({ language: 'en', source: 'CODE', read: false, fellBack: true, subject: 'Your request 7: we need one more thing' })
    expect(plain.body.words.en).toContain('German')
    expect(plain.body.missing).toEqual(['question'])
    const ticked = await owner.post('/templates/mail/events/request.need_info/fill', { recordType: 'Inquiry', recordId: germanRequest, sendUnread: true })
    expect(ticked.status, JSON.stringify(ticked.body)).toBe(200)
    expect(ticked.body).toMatchObject({ language: 'de', source: 'CODE', read: false, fellBack: false, words: null, subject: 'Ihre Anfrage 7: Wir benötigen noch etwas' })
    const audits = await admin(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'templates.useUnreadText' AND "recordId" = $2`, [tenant.id, germanRequest])
    expect(audits.map((row) => row.after)).toEqual([expect.objectContaining({ event: 'request.need_info', language: 'de', drafted: 'CLAUDE', read: false })])
  })

  it('the receipt names the customer’s own number of the request, never the office’s series; the new-message notice is Nexus’s own', async () => {
    const receipt = await owner.post('/templates/mail/events/request.received/fill', { recordType: 'Inquiry', recordId: germanRequest, language: 'it' })
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200)
    expect(receipt.body.subject).toBe('Abbiamo ricevuto la sua richiesta 7')
    expect(JSON.stringify(receipt.body)).not.toContain('INQ-2026-0042')
    const notice = await owner.post('/templates/mail/events/thread.message_posted/fill', { recordType: 'Inquiry', recordId: germanRequest })
    expect(notice.status).toBe(409)
    expect(JSON.stringify(notice.body)).toContain(MAIL_FILL_WORDS.SENT_BY_NEXUS.en)
    const wrongRecord = await owner.post('/templates/mail/events/request.declined/fill', { recordType: 'SalesOrder', recordId: germanRequest })
    expect(wrongRecord.status).toBe(400)
  })
})

// ---- th-backend-g step 2 (B-TH-279 "request received — the receipt with its number"; B-TH-098's language rule) ---------------------
describe('th-backend-g step 2: the receipt of a request, in the customer’s language, to the one who sent it', () => {
  const receiptsOf = (inquiryId: string) => admin(`SELECT "to", subject, locale FROM "EmailOutbound" WHERE "recordId" = $1 AND "templateKey" = 'request.received'`, [inquiryId])
  const received = (inquiryId: string, source: string, sourceEmailId: string | null) =>
    ({ eventId: newId(), type: 'inquiry.received', version: 1, context: 'sales-inquiries', tenantId: tenant.id, companyId, siteId: null, subject: inquiryId, correlationId: newId(), causationId: null, source: 'factory-api', occurredAt: new Date().toISOString(), payload: { inquiryId, number: 'INQ-x', source, status: 'NEW', partyId: german, sourceEmailId } }) as never

  it('German customer, German not read yet: the receipt goes in English, with its own number, never the office series', async () => {
    const outcome = await sendRequestReceipt(system(), h.email, { inquiryId: germanRequest, to: { email: BRAND_ALPHA.contact.email, name: BRAND_ALPHA.contact.name, language: 'de' }, clock: h.clock })
    expect(outcome).toMatchObject({ sent: true, language: 'en' })
    expect(await receiptsOf(germanRequest)).toEqual([{ to: [BRAND_ALPHA.contact.email.toLowerCase()], subject: 'We received your request 7', locale: 'en' }])
    expect(JSON.stringify(await receiptsOf(germanRequest))).not.toContain('INQ-2026-0042')
  })

  it('the company’s own German receipt goes in German (a person’s words need no reading)', async () => {
    const made = await owner.post('/templates/mail', { companyId, event: 'request.received', language: 'de', subject: 'Anfrage {{inquiry.yourNumber}} erhalten', body: 'Guten Tag {{contact.name}},\nIhre Anfrage {{inquiry.yourNumber}} ist bei uns.\n\n{{company.name}}' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const published = await owner.post(`/templates/mail/${made.body.template.id}/publish`, { version: made.body.template.version })
    expect(published.status, JSON.stringify(published.body)).toBe(200)
    const outcome = await sendRequestReceipt(system(), h.email, { inquiryId: germanRequest2, to: { email: BRAND_ALPHA.contact.email, name: BRAND_ALPHA.contact.name, language: 'de' }, clock: h.clock })
    expect(outcome).toMatchObject({ sent: true, language: 'de' })
    expect(await receiptsOf(germanRequest2)).toEqual([{ to: [BRAND_ALPHA.contact.email.toLowerCase()], subject: 'Anfrage 8 erhalten', locale: 'de' }])
  })

  it('the worker sends the receipt of a request made from the contact’s own mail; a mail of another address and a typed request get none', async () => {
    const handler = requestReceiptHandler({ runtime: () => h.email, clock: h.clock })
    await handler.handle(received(mailRequest, 'MAIL', ownMail), { caller: system(), attempt: 1 })
    expect((await receiptsOf(mailRequest)).map((row) => row.to)).toEqual([[BRAND_ALPHA.contact.email.toLowerCase()]])
    await handler.handle(received(forwardedRequest, 'MAIL', forwardedMail), { caller: system(), attempt: 1 })
    expect(await receiptsOf(forwardedRequest)).toEqual([])
    const before = (await admin(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "templateKey" = 'request.received'`))[0]!.n
    await handler.handle(received(germanRequest, 'OFFICE', null), { caller: system(), attempt: 1 })
    expect((await admin(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "templateKey" = 'request.received'`))[0]!.n).toBe(before)
    // Brand B never got any receipt.
    expect((await admin(`SELECT "to" FROM "EmailOutbound" WHERE "templateKey" = 'request.received'`)).flatMap((row) => row.to)).not.toContain(BRAND_BETA.contact.email.toLowerCase())
  })
})
// ---- end th-backend-g step 2

// ---- th-backend-g step 3 (B-TH-098's web half: Admin › Documents › Mail templates takes the de / fr / es slots) -------------------
describe('th-backend-g step 3: the mail templates keep the five languages', () => {
  it('one slot per event and language; a new French version starts from Claude’s draft and previews; another language is refused', async () => {
    const list = await owner.get(`/templates/mail?companyId=${companyId}`)
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect(list.body.slots).toHaveLength(MAIL_EVENTS.length * 5)
    expect(new Set(list.body.slots.map((slot: Json) => slot.language))).toEqual(new Set(['it', 'en', 'de', 'fr', 'es']))
    // The company's own German receipt (step 2's test) is the one in use; French still reads the code's words (Claude's draft).
    expect(list.body.slots.find((slot: Json) => slot.event === 'request.received' && slot.language === 'de')).toMatchObject({ inUse: 'COMPANY' })
    expect(list.body.slots.find((slot: Json) => slot.event === 'request.need_info' && slot.language === 'fr')).toMatchObject({ inUse: 'CODE' })
    const fr = await owner.post('/templates/mail', { companyId, event: 'request.need_info', language: 'fr' })
    expect(fr.status, JSON.stringify(fr.body)).toBe(201)
    expect(fr.body.template).toMatchObject({ language: 'fr', status: 'DRAFT', subject: MAIL_DRAFTS['request.need_info'].fr.subject, body: MAIL_DRAFTS['request.need_info'].fr.body })
    const preview = await owner.post(`/templates/mail/${fr.body.template.id}/preview`, {})
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    expect(preview.body.subject).toBe('Votre demande 7 : il nous manque encore quelque chose')
    expect((await owner.get(`/templates/mail?companyId=${companyId}&language=fr`)).body.templates.map((template: Json) => template.language)).toEqual(['fr'])
    expect((await owner.post('/templates/mail', { companyId, event: 'request.need_info', language: 'pt' })).status).toBe(400)
  })
})
// ---- end th-backend-g step 3
