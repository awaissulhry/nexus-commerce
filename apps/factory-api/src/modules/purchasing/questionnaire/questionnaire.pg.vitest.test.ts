import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { STARTER_QUESTIONS } from '@nexus/factory-domain/purchasing/questionnaire/starter'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedParties } from '../../../../../../packages/factory-db/seed/parties'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { useScanner } from '../../../platform/files/scan/service'
import { reviewTaskId } from './store'

/**
 * The supplier questionnaire on the local stack (B-W2b-172; SCM-023): a throwaway PostgreSQL 17 database from the
 * migrations (row-level security, the partner role's grants and the …_portal_supply_w2b_guards triggers are real), the
 * real app with an office buyer and a quality inspector, the supplier's SUPPLIER_ONBOARD link (only its token: no cookie),
 * the FAKE file store and mailbox. The factory-db seeds give company A and its supplier P2; every name and number is made
 * up. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/questionnaire`.
 */

let h: Harness
let buyer: Browser
let inspector: Browser
let buyerId = ''
const NS = 'questionnaire'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P2 = seedId('party:P2')
const today = () => businessDate(h.clock.now())
const addDays = (day: string, days: number): string => {
  const at = new Date(`${day}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `questionnaire-${label}-${++counter}-${newId()}`
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const PDF = Buffer.from('%PDF-1.4\n% made-up certificate for a test\n%%EOF\n')

async function as(browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  // The screen's company, as the office web sends it with every call (x-factory-company).
  const answer = await browser.send(method, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? { 'x-factory-company': companyA } : { 'x-factory-company': companyA, 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

/** A PATCH of the signed-in browser (its cookies and CSRF token; Browser.send knows GET and POST only). */
async function patch(browser: Browser, url: string, body: unknown): Promise<{ status: number; body: Json }> {
  const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  const answer = await h.app.inject({ method: 'PATCH', url, payload: body as object, headers: { cookie, 'x-csrf-token': browser.csrfToken ?? '', 'x-factory-company': companyA, 'idempotency-key': key() } })
  return { status: answer.statusCode, body: answer.json() }
}

/** A request of the supplier's browser: only the link's token, no cookie. */
async function viaLink(token: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200, idempotencyKey: string = key('link')): Promise<Json> {
  const answer = await h.app.inject({
    method,
    url,
    headers: { 'x-factory-link': token, 'user-agent': 'SeedLaptop/1.0', ...(method === 'GET' ? {} : { 'idempotency-key': idempotencyKey }) },
    ...(method === 'GET' ? {} : { payload: (body ?? {}) as object }),
  })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.headers['content-type']?.toString().startsWith('application/json') ? answer.json() : { raw: answer.rawPayload }
}

const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')
const outbox = (type: string) => admin<{ subject: string; payload: Json }>('SELECT subject, payload FROM "OutboxEvent" WHERE type = $1 ORDER BY "occurredAt", id', [type])
/** Every money-looking or internal key in a JSON answer (none may reach the supplier's page). */
const leaks = (body: unknown): string[] => [/price/i, /amount/i, /"cost/i, /internalNote/, /createdById/, /reviewNote/].filter((pattern) => pattern.test(JSON.stringify(body))).map(String)

/** A whole answer to the starter set, with the LWG certificate uploaded through the link. */
function wholeAnswer(questionnaireId: string, lwgFileId: string | null): Json {
  const answers: Json = {}
  for (const question of STARTER_QUESTIONS) {
    if (question.kind === 'TEXT' || question.kind === 'ADDRESS' || question.kind === 'LONG_TEXT') answers[question.key] = { value: 'Made-up words for the test' }
    if (question.kind === 'VAT') answers[question.key] = { value: 'IT00000000026' }
    if (question.kind === 'CONTACT') answers[question.key] = { value: { name: 'Carla Example', email: 'carla@seed-p2.example', phone: '+39 0571 000 000' } }
    if (question.kind === 'CHOICE') answers[question.key] = { value: question.options![1]!.code }
    if (question.kind === 'SIGN') answers[question.key] = { value: 'SIGNED' }
    if (question.kind === 'YES_NO') answers[question.key] = question.explain === 'YES' ? { value: 'NO' } : { value: 'YES' }
  }
  if (lwgFileId) answers['certs.lwg'] = { value: { fileId: lwgFileId, issuer: 'Made-up issuer', number: 'LWG-TEST-1', issuedOn: addDays(today(), -30), expiresOn: addDays(today(), 335) } }
  return {
    questionnaireId,
    answers,
    sites: [{ name: 'Seed tannery, finishing', country: 'IT', town: 'Seedville', steps: ['RETANNING', 'FINISHING'] }],
    subTierSites: [{ name: 'Seed beamhouse partner', country: 'IT', town: null, steps: ['BEAMHOUSE', 'TANNING'] }],
    signedName: 'Carla Example',
    signedRole: 'Quality manager',
    truthful: true,
  }
}

beforeAll(async () => {
  h = await startHarness('questionnaire')
  h.clock.set(new Date())
  useScanner(null)
  await seedCore({ db: h.database, namespace: NS })
  await seedParties({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
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
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const buyerUser = await addUser(h, seedTenant, { email: 'paolo.buyer@seed-a.example.com', role: 'buyer' })
  buyerId = (await one<{ id: string }>('SELECT id FROM "User" WHERE email = $1', [buyerUser.email])).id
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  const inspectorUser = await addUser(h, seedTenant, { email: 'quinto.quality@seed-a.example.com', role: 'quality_inspector' })
  inspector = new Browser(h.app)
  expect((await inspector.signIn(NS, inspectorUser.email, inspectorUser.password)).status).toBe(200)
  await enrolTotp(h, inspector)
}, 240_000)

afterAll(async () => {
  useScanner(undefined)
  await h?.close()
}, 60_000)

const supplierUrl = `/purchasing/suppliers/${P2}/questionnaire`

describe('the supplier questionnaire (SCM-023)', () => {
  let version: Json
  let token = ''
  let lwg: Json
  let responseId = ''

  it('REFUSED: no link while the company has no published questionnaire; the buyer publishes the starter set', async () => {
    const empty = await as(buyer, 'GET', supplierUrl)
    expect(empty).toMatchObject({ current: null, answers: [], links: [], may: { send: true, review: true, manage: true } })
    await as(buyer, 'POST', `/purchasing/suppliers/${P2}/questionnaire-link`, { send: false }, 409)
    const draft = (await as(buyer, 'POST', '/purchasing/questionnaires', { from: 'STARTER' }, 201)).version
    expect(draft).toMatchObject({ revision: 1, published: false, title: 'Supplier due diligence' })
    expect(draft.questions).toHaveLength(STARTER_QUESTIONS.length)
    // A version is checked as data: a doubled key is refused at its place.
    const bad = await patch(buyer, `/purchasing/questionnaires/${draft.id}`, { version: draft.version, questions: [STARTER_QUESTIONS[0], STARTER_QUESTIONS[0]] })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toContain('body/questions/1/key')
    version = (await as(buyer, 'POST', `/purchasing/questionnaires/${draft.id}/publish`, { version: draft.version })).version
    expect(version).toMatchObject({ revision: 1, published: true })
    expect((await outbox('supplier_questionnaire.published')).map((row) => row.payload)).toEqual([{ questionnaireId: draft.id, revision: 1, questions: STARTER_QUESTIONS.length }])
    // Published, it is fixed (a change is a new version).
    expect((await patch(buyer, `/purchasing/questionnaires/${draft.id}`, { version: version.version, title: 'Changed' })).status).toBe(409)
    // The quality inspector reads it, never changes it.
    await as(inspector, 'POST', '/purchasing/questionnaires', { from: 'LATEST' }, 403)
  })

  it('sends the link from the supplier record: the address once, nothing of it in the command', async () => {
    const sent = await as(buyer, 'POST', `/purchasing/suppliers/${P2}/questionnaire-link`, { send: false, note: 'Thank you!', language: 'en' }, 201)
    expect(sent.url).toContain('/l#token=')
    expect(sent.delivery).toBeNull()
    token = tokenOf(sent.url)
    const link = await one('SELECT purpose, "recordType", "recordId", "partyId", "companyId", "maxUses", uses, note, "createdById" FROM "OneOffLink" WHERE id = $1', [sent.link.id])
    expect(link).toMatchObject({ purpose: 'SUPPLIER_ONBOARD', recordType: 'Party', recordId: P2, partyId: P2, companyId: companyA, maxUses: 1, uses: 0, note: 'Thank you!', createdById: buyerId })
    expect(JSON.stringify(await admin('SELECT response FROM "IdempotencyReceipt"'))).not.toContain(token)
    // The quality inspector may read the tab but not send.
    await as(inspector, 'POST', `/purchasing/suppliers/${P2}/questionnaire-link`, { send: false }, 403)
    expect((await as(inspector, 'GET', supplierUrl)).may).toEqual({ send: false, review: false, manage: false })
  })

  it("the supplier's page: the questions, its own data as we hold it, the buyer; never a price or an internal column", async () => {
    const page = await viaLink(token, 'GET', '/link/supplier-questionnaire?language=en')
    expect(page).toMatchObject({ sender: { companyName: expect.any(String) }, reviewer: { name: expect.any(String) }, note: 'Thank you!', questionnaire: { id: version.id, revision: 1, hasCode: true }, uploaded: [], locale: 'en' })
    expect(page.supplier.code).toBeTruthy()
    expect(page.questionnaire.questions.map((question: Json) => question.key)).toEqual(STARTER_QUESTIONS.map((question) => question.key))
    expect(leaks(page)).toEqual([])
    // The code of conduct, a PDF painted on request.
    const code = await h.app.inject({ method: 'GET', url: '/link/supplier-questionnaire/code-of-conduct?language=it', headers: { 'x-factory-link': token } })
    expect(code.statusCode).toBe(200)
    expect(code.headers['content-type']).toContain('application/pdf')
    expect(code.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    // The VAT number: an Italian one is checked for its shape only; a wrong one says so; nothing is kept.
    expect(await viaLink(token, 'POST', '/link/supplier-questionnaire/vat-check', { vatNumber: 'IT 00000000026' })).toEqual({ result: 'NOT_CHECKED', nameMatches: null, vatNumber: 'IT00000000026' })
    expect((await viaLink(token, 'POST', '/link/supplier-questionnaire/vat-check', { vatNumber: 'IT00000000023' })).result).toBe('FORMAT')
  })

  it('keeps the draft with us and takes a certificate: a CERTIFICATE file of the supplier, office and link only, counted for nothing yet', async () => {
    const saved = await viaLink(token, 'PUT', '/link/draft', { data: { step: 'sites', answers: { 'company.legal-name': { value: 'Seed Tannery Two S.r.l.' } } } })
    expect(saved.draft.version).toBe(1)
    expect((await viaLink(token, 'GET', '/link/draft')).draft.data.step).toBe('sites')
    // REFUSED: a document of a question that asks for none, a type the page does not take.
    await viaLink(token, 'POST', '/link/supplier-questionnaire/documents', { questionKey: 'labour.wages', originalName: 'wages.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, sha256: sha256(PDF) }, 400)
    await viaLink(token, 'POST', '/link/supplier-questionnaire/documents', { questionKey: 'certs.lwg', originalName: 'lwg.docx', contentType: 'application/msword', sizeBytes: PDF.length, sha256: sha256(PDF) }, 400)
    const announced = await viaLink(token, 'POST', '/link/supplier-questionnaire/documents', { questionKey: 'certs.lwg', originalName: 'lwg-certificate.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, sha256: sha256(PDF) }, 201)
    expect((await h.app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: PDF })).statusCode).toBe(200)
    lwg = (await viaLink(token, 'POST', `/link/supplier-questionnaire/documents/${announced.file.id}/complete`)).file
    expect(lwg).toMatchObject({ id: announced.file.id, name: 'lwg-certificate.pdf', status: 'AVAILABLE' })
    expect(await one('SELECT "recordType", "recordId", kind, category, visibility::text[] AS visibility, "partyId", "expiresOn" FROM "StoredFile" WHERE id = $1', [lwg.id])).toEqual({ recordType: 'Party', recordId: P2, kind: 'CERTIFICATE', category: 'QUESTIONNAIRE', visibility: ['OFFICE', 'LINK'], partyId: P2, expiresOn: null })
    expect((await viaLink(token, 'GET', '/link/supplier-questionnaire')).uploaded.map((file: Json) => file.id)).toEqual([lwg.id])
  })

  it('REFUSED before the link is used: answers missing, an expired certificate, an older version', async () => {
    const whole = wholeAnswer(version.id, lwg.id)
    const missing = await h.app.inject({ method: 'POST', url: '/link/supplier-questionnaire', headers: { 'x-factory-link': token, 'idempotency-key': key() }, payload: { ...whole, sites: [], answers: { ...whole.answers, 'labour.recruitment-fees': { value: 'YES' } }, truthful: false } })
    expect(missing.statusCode).toBe(400)
    const paths = (missing.json().error.issues as Json[]).map((issue) => issue.path)
    expect(paths).toEqual(expect.arrayContaining(['body/sites', 'body/answers/labour.recruitment-fees/explain', 'body/truthful']))
    const expired = { ...whole, answers: { ...whole.answers, 'certs.lwg': { value: { fileId: lwg.id, issuedOn: addDays(today(), -400), expiresOn: addDays(today(), -1) } } } }
    await viaLink(token, 'POST', '/link/supplier-questionnaire', expired, 400)
    await viaLink(token, 'POST', '/link/supplier-questionnaire', { ...whole, questionnaireId: newId() }, 409)
    expect((await one('SELECT uses FROM "OneOffLink" WHERE "purpose" = \'SUPPLIER_ONBOARD\' AND "partyId" = $1 AND "revokedAt" IS NULL', [P2])).uses).toBe(0)
  })

  it('takes the signed answer once: kept in the link scope with its link, as a PDF on the supplier, with a review task for the buyer', async () => {
    const idempotencyKey = key('send')
    const sent = await viaLink(token, 'POST', '/link/supplier-questionnaire?language=en', wholeAnswer(version.id, lwg.id), 200, idempotencyKey)
    expect(sent).toMatchObject({ sent: { revision: 1, documents: 1 }, reviewer: { name: expect.any(String) } })
    responseId = sent.sent.id
    // The link had one use: a second send through it (even with the same key) opens nothing — one answer.
    await viaLink(token, 'POST', '/link/supplier-questionnaire?language=en', wholeAnswer(version.id, lwg.id), 404, idempotencyKey)
    expect(await one('SELECT count(*)::int AS n FROM "SupplierQuestionnaireResponse" WHERE "partyId" = $1', [P2])).toEqual({ n: 1 })
    const row = await one('SELECT "partyId", "companyId", "questionnaireId", "linkId", "signedName", "signedRole", decision, version, answers, sites, "subTierSites" FROM "SupplierQuestionnaireResponse" WHERE id = $1', [responseId])
    expect(row).toMatchObject({ partyId: P2, companyId: companyA, questionnaireId: version.id, signedName: 'Carla Example', signedRole: 'Quality manager', decision: null, version: 1 })
    expect(row.linkId).toBeTruthy()
    expect(row.answers['company.vat']).toEqual({ value: 'IT00000000026' })
    expect(row.subTierSites).toEqual([{ name: 'Seed beamhouse partner', country: 'IT', town: null, steps: ['BEAMHOUSE', 'TANNING'] }])
    expect(await one('SELECT uses FROM "OneOffLink" WHERE id = $1', [row.linkId])).toEqual({ uses: 1 })
    expect(await one('SELECT action, "typedName" FROM "LinkEvidence" WHERE "linkId" = $1 AND action = \'SUBMITTED\'', [row.linkId])).toEqual({ action: 'SUBMITTED', typedName: 'Carla Example' })
    // The draft is gone with the send.
    expect((await admin('SELECT id FROM "LinkDraft" WHERE "linkId" = $1', [row.linkId])).length).toBe(0)
    // The PDF on the supplier's files, office only, named by the answer's audit row.
    const pdf = await one(`SELECT f.kind, f.category, f.visibility::text[] AS visibility, f."recordType", f."recordId", f."contentType" FROM "AuditLog" a JOIN "StoredFile" f ON f.id = (a.after->>'fileId')::uuid WHERE a."recordType" = 'SupplierQuestionnaireResponse' AND a."recordId" = $1 AND a.action = 'purchasing.questionnaire.answerPdf'`, [responseId])
    expect(pdf).toEqual({ kind: 'DOCUMENT', category: 'QUESTIONNAIRE', visibility: ['OFFICE'], recordType: 'Party', recordId: P2, contentType: 'application/pdf' })
    // The buyer who sent the link reviews it: the task on the supplier, due in five days.
    expect(await one('SELECT status, "assigneeId", "recordType", "recordId", "dueDate"::text AS "dueDate" FROM "Task" WHERE id = $1', [reviewTaskId(responseId)])).toEqual({ status: 'OPEN', assigneeId: buyerId, recordType: 'Party', recordId: P2, dueDate: addDays(today(), 5) })
    expect((await outbox('supplier_questionnaire.answered')).map((event) => event.payload)).toEqual([expect.objectContaining({ responseId, partyId: P2, revision: 1, documents: 1 })])
    // The used link opens nothing any more.
    await viaLink(token, 'GET', '/link/supplier-questionnaire', undefined, 404)
  })

  it('the buyer reads it on the supplier record and accepts it: the certificate in force with its expiry, shared back, the task done', async () => {
    const tab = await as(buyer, 'GET', supplierUrl)
    const answer = tab.answers.find((entry: Json) => entry.id === responseId)
    expect(answer).toMatchObject({ state: 'WAITING', via: 'LINK', revision: 1, signedName: 'Carla Example', review: null, task: { open: true }, pdf: { fileId: expect.any(String) } })
    expect(answer.documents).toEqual([expect.objectContaining({ key: 'certs.lwg', fileId: lwg.id, category: 'SUPPLIER_CERTIFICATE', inForce: false, expiresOn: addDays(today(), 335) })])
    expect(tab.links[0]).toMatchObject({ state: 'ANSWERED', answerId: responseId })
    // REFUSED: questions back without words; the quality inspector; a stale version.
    await as(buyer, 'POST', `/purchasing/questionnaire-answers/${responseId}/review`, { decision: 'QUESTIONS', questions: ' ', version: answer.version }, 400)
    await as(inspector, 'POST', `/purchasing/questionnaire-answers/${responseId}/review`, { decision: 'ACCEPTED', version: answer.version }, 403)
    await as(buyer, 'POST', `/purchasing/questionnaire-answers/${responseId}/review`, { decision: 'ACCEPTED', version: answer.version + 1 }, 409)
    const accepted = await as(buyer, 'POST', `/purchasing/questionnaire-answers/${responseId}/review`, { decision: 'ACCEPTED', note: 'Beamhouse partner known to us.', version: answer.version })
    expect(accepted).toEqual({ id: responseId, state: 'ACCEPTED', documents: 1, messageId: null })
    expect(await one('SELECT decision, "reviewedById", "reviewNote" FROM "SupplierQuestionnaireResponse" WHERE id = $1', [responseId])).toEqual({ decision: 'ACCEPTED', reviewedById: buyerId, reviewNote: 'Beamhouse partner known to us.' })
    expect(await one('SELECT category, "expiresOn"::text AS "expiresOn", visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1', [lwg.id])).toEqual({ category: 'SUPPLIER_CERTIFICATE', expiresOn: addDays(today(), 335), visibility: ['OFFICE', 'LINK', 'PARTNER'] })
    expect(await one('SELECT status, "closedById" FROM "Task" WHERE id = $1', [reviewTaskId(responseId)])).toEqual({ status: 'DONE', closedById: buyerId })
    // Reviewed once.
    await as(buyer, 'POST', `/purchasing/questionnaire-answers/${responseId}/review`, { decision: 'QUESTIONS', questions: 'Again?', version: answer.version + 1 }, 409)
    expect((await outbox('supplier_questionnaire.reviewed')).map((event) => event.payload)).toEqual([expect.objectContaining({ responseId, decision: 'ACCEPTED', documents: 1 })])
  })

  it('asked again: a new link withdraws the open one; questions back go on the supplier thread, shared with it', async () => {
    const first = await as(buyer, 'POST', `/purchasing/suppliers/${P2}/questionnaire-link`, { send: false }, 201)
    const second = await as(buyer, 'POST', `/purchasing/suppliers/${P2}/questionnaire-link`, { send: false }, 201)
    expect(second.link.withdrawn).toBe(1)
    await viaLink(tokenOf(first.url), 'GET', '/link/supplier-questionnaire', undefined, 404)
    const again = await viaLink(tokenOf(second.url), 'POST', '/link/supplier-questionnaire', wholeAnswer(version.id, null))
    expect(again.sent.documents).toBe(0)
    const tab = await as(buyer, 'GET', supplierUrl)
    expect(tab.answers.map((entry: Json) => entry.state)).toEqual(['WAITING', 'ACCEPTED'])
    const reviewed = await as(buyer, 'POST', `/purchasing/questionnaire-answers/${again.sent.id}/review`, { decision: 'QUESTIONS', questions: 'Who does the beamhouse work for you, and where?', note: 'Ask by phone too.', version: tab.answers[0].version })
    expect(reviewed.state).toBe('QUESTIONS')
    const message = await one('SELECT m.direction, m.audience, m."partyId", m."bodyText", t."recordType", t."recordId" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE m.id = $1', [reviewed.messageId])
    expect(message).toMatchObject({ direction: 'OUTBOUND', audience: 'PARTNER', partyId: P2, recordType: 'Party', recordId: P2 })
    expect(message.bodyText).toContain('Who does the beamhouse work for you, and where?')
    // The office note stays the office's: never in the supplier's message.
    expect(message.bodyText).not.toContain('Ask by phone too.')
  })
})
