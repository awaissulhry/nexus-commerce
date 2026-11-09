import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCapa, type CapaSeed } from '../../../../../packages/factory-db/seed/capa'
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedPricing, type PricingSeed } from '../../../../../packages/factory-db/seed/pricing'
import { seed as seedProduction, type ProductionSeed } from '../../../../../packages/factory-db/seed/production'
import { seed as seedSafety } from '../../../../../packages/factory-db/seed/safety'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../adapters/ses/fake'
import { callerFor } from '../../core/command'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { mailOfficeApprovals } from '../../modules/insights/sources/approvals-mail'
import { usePortalOptions } from '../auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { storeGeneratedFile } from '../files/files'
import { systemContext } from '../outbox/system'
import { sweepApprovals } from './sweep'

/**
 * Approval requests to partners on the local stack (B-W2b-184; COL-064, SAL-222, SAL-294, PLT-089; follow-ups AP1:01,
 * AP1:02): a throwaway PostgreSQL 17 database from the migrations (row-level security, the partner role's grants and the
 * …_links_depth_w2b_guards are real), the real app with an office owner and a production manager signed in, the customer's
 * people signed in to the portal by e-mail code, and APPROVAL links (FAKE mailbox, FAKE file store). The factory-db seeds
 * give the order SEED-SO-0001 of customer P1, its concession on SEED-NCR-0002 and the draft work order WO-0002; every name
 * is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/approvals-out`.
 */

let h: Harness
let owner: Browser
let manager: Browser
let quality: Browser
let viewer: Browser
let capa: CapaSeed
let pricing: PricingSeed
let production: ProductionSeed
const NS = 'approvals-out'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const people = { owner: 'olga.owner@seed-a.example.com', manager: 'pietro.pm@seed-a.example.com', quality: 'quinta.quality@customer-p1.example', viewer: 'vera.viewer@customer-p1.example' }
const BRAND_QA = 'qa.sample@customer-p1.example'
const ARROW = { kind: 'arrow', from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.5 } }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `approvals-${label}-${++counter}-${newId()}`

async function as(browser: Browser, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

/** A request of the partner's phone: only the link's token, no cookie. */
async function viaLink(token: string, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await h.app.inject({
    method,
    url,
    headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0', ...(method === 'POST' ? { 'idempotency-key': key('link') } : {}) },
    ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}),
  })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json()
}

const tokenOf = (text: string): string => decodeURIComponent(/#token=(\S+)/.exec(text)![1]!)
const pathsOf = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => issue.path)
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])
const taskOf = (requestId: string) => one<{ kind: string; status: string; doneById: string | null; sourceKey: string }>('SELECT kind, status, "doneById", "sourceKey" FROM "PartnerTask" WHERE "recordId" = $1', [requestId])
const system = () => callerFor(h.database, systemContext(tenant, newId()))
const log = { info() {}, warn() {}, error() {} } as never
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

async function photoOf(recordType: string, recordId: string, name: string): Promise<string> {
  const made = await storeGeneratedFile(h.files, system(), { companyId: companyA, recordType, recordId, kind: 'PHOTO', originalName: name, contentType: 'image/png', body: PNG })
  return made.id
}

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant, key: roleKey } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

async function officeBrowser(seedTenant: TestTenant, email: string, role: string): Promise<Browser> {
  const user = await addUser(h, seedTenant, { email, role })
  const browser = new Browser(h.app)
  expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
  await enrolTotp(h, browser)
  return browser
}

const lastMail = (template: string, to: string) => h.ses.mails.filter((mail) => mail.templateKey === template && mail.to.includes(to)).at(-1)

beforeAll(async () => {
  h = await startHarness('approvals_out')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  capa = await seedCapa({ db: h.database, namespace: NS })
  pricing = await seedPricing({ db: h.database, namespace: NS })
  production = await seedProduction({ db: h.database, namespace: NS })
  await seedSafety({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses-ao', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  for (const kind of ['CONVERSATION', 'NOTIFICATION']) {
    await admin(
      `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
       SELECT $1, $2, $3, $4::"EmailIdentityKind", 'mail.seed-a.example.com', $5, 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $6, 'SUCCESS', 'SUCCESS', true
       WHERE NOT EXISTS (SELECT 1 FROM "EmailIdentity" WHERE "tenantId" = $2 AND "companyId" = $3 AND kind = $4::"EmailIdentityKind" AND "isDefault")`,
      [newId(), tenant, companyA, kind, kind === 'CONVERSATION' ? 'vendite@mail.seed-a.example.com' : 'avvisi@mail.seed-a.example.com', ses],
    )
  }
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  await portalWorld(h, seedTenant)
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => {
    const settings = await client.portalSettings.findFirst({ where: { partyId: P1 }, select: { id: true } })
    if (settings) await client.portalSettings.update({ where: { id: settings.id }, data: { portalOn: true }, select: { id: true } })
    else await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  await partnerPerson(people.quality, P1, ['customer-quality', 'partner-approve'])
  await partnerPerson(people.viewer, P1, ['customer-viewer'])
  owner = await officeBrowser(seedTenant, people.owner, 'owner')
  manager = await officeBrowser(seedTenant, people.manager, 'production_manager')
  freshGuard(h)
  quality = await signedIn(people.quality)
  viewer = await signedIn(people.viewer)
}, 300_000)

afterAll(async () => {
  await h?.close()
})

describe('a sample asked on an order, answered by link with changes and a marked photo (COL-064)', () => {
  let requestId = ''
  let token = ''
  let photoCopy = ''

  it('the office asks: the request, its APPROVAL link, the partner\'s APPROVE task and the mail, in one command', async () => {
    const photo = await photoOf('SalesOrder', pricing.money.sales.orderId, 'Made-up sample front.png')
    const refused = await as(owner, 'POST', '/approvals-out', { kind: 'SAMPLE', recordType: 'SalesOrder', recordId: pricing.money.sales.orderId, email: BRAND_QA, question: 'Approve the stitching of the sample.', send: true, language: 'en' }, 400)
    expect(pathsOf(refused)).toEqual(['body/fileIds'])
    const made = await as(owner, 'POST', '/approvals-out', { kind: 'SAMPLE', recordType: 'SalesOrder', recordId: pricing.money.sales.orderId, email: BRAND_QA, question: 'Approve the stitching of the sample.', fileIds: [photo], send: true, language: 'en' }, 201)
    expect(made).toMatchObject({ url: null, delivery: 'SENT', request: { kind: 'SAMPLE', status: 'OPEN', record: { type: 'SalesOrder', words: { it: expect.any(String), en: expect.any(String) } }, party: { id: P1 } } })
    // B-W2b-F16: codes and the record's words; no English-only kind, state or due words.
    for (const field of ['kindName', 'stateWords', 'dueWords']) expect(made.request).not.toHaveProperty(field)
    requestId = made.request.id
    expect(made.request.files).toHaveLength(1)
    photoCopy = made.request.files[0].id
    const copy = await one('SELECT "recordType", "recordId", visibility::text[] AS visibility, "partyId", "sourceFileId" FROM "StoredFile" WHERE id = $1', [photoCopy])
    expect(copy).toEqual({ recordType: 'ApprovalRequest', recordId: requestId, visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: P1, sourceFileId: photo })
    expect(await taskOf(requestId)).toMatchObject({ kind: 'APPROVE', status: 'OPEN', sourceKey: `ApprovalRequest:${requestId}` })
    const link = await one('SELECT purpose, "recordType", "maxUses", email FROM "OneOffLink" WHERE "recordId" = $1', [requestId])
    expect(link).toEqual({ purpose: 'APPROVAL', recordType: 'ApprovalRequest', maxUses: 1, email: BRAND_QA })
    const mail = lastMail('approvals.request', BRAND_QA)!
    expect(textOf(mail.raw)).toContain('Approve the stitching of the sample.')
    token = tokenOf(textOf(mail.raw))
    expect((await eventsOf(requestId)).map((event) => event.type)).toContain('approval_request.asked')
    // REFUSED: a second open request of the same kind on the record; a person who may only see approvals.
    await as(owner, 'POST', '/approvals-out', { kind: 'SAMPLE', recordType: 'SalesOrder', recordId: pricing.money.sales.orderId, email: BRAND_QA, question: 'Again.', fileIds: [photo], send: false }, 409)
    await as(manager, 'POST', '/approvals-out', { kind: 'SAMPLE', recordType: 'SalesOrder', recordId: pricing.money.sales.orderId, email: BRAND_QA, question: 'Again.', fileIds: [photo], send: false }, 403)
  })

  it('the link shows what we ask, the photo, and what may be answered; opening uses nothing', async () => {
    const page = await viaLink(token, 'GET', '/link/approval?language=en')
    expect(page.request).toMatchObject({ kind: 'SAMPLE', question: 'Approve the stitching of the sample.', status: 'OPEN', from: { companyName: expect.any(String) } })
    // B-W2b-F16: a sample on an order is named by the order's number, the same in both languages (`label` keeps the English).
    expect(page.request.words.it).toBe(page.request.words.en)
    expect(page.request.label).toBe(page.request.words.en)
    for (const field of ['kindName', 'stateWords', 'dueWords']) expect(page.request).not.toHaveProperty(field)
    expect(page.files.map((file: Json) => file.id)).toEqual([photoCopy])
    expect(page.may).toEqual({ answer: true, withChanges: true, held: null })
    expect(page.content.revisedOrder).toBeNull()
    expect(page.link.usesLeft).toBe(1)
  })

  it('REFUSED in words: changes without saying which; the answer then signs, marks the photo and closes the link', async () => {
    const empty = await viaLink(token, 'POST', '/link/approval/approve?language=en', { decision: 'APPROVED_WITH_CHANGES', answer: '', typedName: 'Anna Demo' }, 400)
    expect(pathsOf(empty)).toEqual(['body/answer'])
    const answered = await viaLink(token, 'POST', '/link/approval/approve?language=en', { decision: 'APPROVED_WITH_CHANGES', answer: 'Darker thread on the collar.', typedName: 'Anna Demo', markup: { fileId: photoCopy, page: null, shapes: [ARROW], note: 'Here.' } })
    expect(answered.request.decided).toMatch(/^Approved with changes — signed by Anna Demo at /)
    expect(answered.may.answer).toBe(false)
    expect(answered.receipt).toBe('SENT')
    const row = await one('SELECT status, answer, "typedName", "markupFileId", "answeredByUserId", "answeredViaLinkId" IS NOT NULL AS "byLink", "answerRequestId" IS NOT NULL AS "evidence", "answerIpHash" IS NOT NULL AS "ip" FROM "ApprovalRequest" WHERE id = $1', [requestId])
    expect(row).toEqual({ status: 'APPROVED_WITH_CHANGES', answer: 'Darker thread on the collar.', typedName: 'Anna Demo', markupFileId: photoCopy, answeredByUserId: null, byLink: true, evidence: true, ip: true })
    expect(await one('SELECT action, "typedName" FROM "LinkEvidence" WHERE "linkId" = (SELECT id FROM "OneOffLink" WHERE "recordId" = $1)', [requestId])).toEqual({ action: 'APPROVED', typedName: 'Anna Demo' })
    expect(await one('SELECT "partyId", "createdById", note, page FROM "FileMarkup" WHERE "fileId" = $1', [photoCopy])).toEqual({ partyId: P1, createdById: null, note: 'Here.', page: null })
    expect(await taskOf(requestId)).toMatchObject({ status: 'DONE', doneById: null })
    // The office's side: the order's thread keeps the partner's own signed message, the receipt went to the address.
    const message = await one(`SELECT m.direction, m."authorName", m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1 ORDER BY m."createdAt" DESC LIMIT 1`, [pricing.money.sales.orderId])
    expect(message).toMatchObject({ direction: 'INBOUND', authorName: 'Anna Demo' })
    expect(message.bodyText).toContain('Darker thread on the collar.')
    expect(textOf(lastMail('approvals.receipt', BRAND_QA)!.raw)).toContain('Your words: Darker thread on the collar.')
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE action = 'approvalsOut.settle' AND "recordId" = $1`, [requestId])).toHaveLength(1)
    expect((await eventsOf(requestId)).find((event) => event.type === 'approval_request.answered')!.payload).toMatchObject({ status: 'APPROVED_WITH_CHANGES', via: 'LINK', markedUp: true })
    // One answer per request: the link opens nothing any more.
    await viaLink(token, 'GET', '/link/approval', undefined, 404)
    const office = await as(owner, 'GET', `/approvals-out/${requestId}`)
    expect(office.request.answer).toMatchObject({ typedName: 'Anna Demo', via: 'LINK', markup: { fileId: photoCopy, note: 'Here.' } })
  })
})

describe('the customer\'s concession answered in the portal (QHS-085; AP1:01)', () => {
  let requestId = ''

  it('asked on the NCR\'s concession: the concession names the request; a viewer reads it but cannot answer', async () => {
    const made = await as(owner, 'POST', '/approvals-out', { kind: 'CONCESSION', recordType: 'NcrConcession', recordId: capa.concessionId, question: 'Accept the shade, slightly darker (ΔE 1.8)?', send: false }, 201)
    requestId = made.request.id
    expect(made.url).toContain('#token=')
    expect(await one('SELECT "approvalRequestId" FROM "NcrConcession" WHERE id = $1', [capa.concessionId])).toEqual({ approvalRequestId: requestId })
    const list = await as(viewer, 'GET', '/portal/approvals')
    expect(list.items.map((item: Json) => item.id)).toContain(requestId)
    // B-W2b-F16: the concession in both languages, the kind and state as codes.
    const item = list.items.find((entry: Json) => entry.id === requestId)
    expect(item).toMatchObject({ kind: 'CONCESSION', status: 'OPEN', words: { it: expect.stringMatching(/ · concessione \d+$/), en: expect.stringMatching(/ · concession \d+$/) } })
    for (const field of ['kindName', 'stateWords', 'dueWords', 'label']) expect(item).not.toHaveProperty(field)
    const page = await as(viewer, 'GET', `/portal/approvals/${requestId}`)
    expect(page.may.answer).toBe(false)
    expect(page.content.facts.map((fact: Json) => fact.label)).toEqual(['Nonconformance', 'The deviation', 'What we propose'])
    await as(viewer, 'POST', `/portal/approvals/${requestId}/answer`, { decision: 'APPROVED', typedName: 'Vera Viewer', version: page.request.version }, 403)
    await as(owner, 'POST', '/approvals-out', { kind: 'CONCESSION', recordType: 'NcrConcession', recordId: capa.concessionId, question: 'Again.', send: false }, 409)
  })

  it('the quality person refuses with words: the concession REFUSED by the customer (recordedById null), the request done', async () => {
    const page = await as(quality, 'GET', `/portal/approvals/${requestId}`)
    expect(page.may).toEqual({ answer: true, withChanges: true, held: null })
    const noWords = await as(quality, 'POST', `/portal/approvals/${requestId}/answer`, { decision: 'REFUSED', answer: ' ', typedName: 'Quinta Quality', version: page.request.version }, 400)
    expect(pathsOf(noWords)).toEqual(['body/answer'])
    await as(quality, 'POST', `/portal/approvals/${requestId}/answer`, { decision: 'REFUSED', answer: 'Too dark for our riders.', typedName: 'Quinta Quality', version: page.request.version + 5 }, 409)
    const answered = await as(quality, 'POST', `/portal/approvals/${requestId}/answer`, { decision: 'REFUSED', answer: 'Too dark for our riders.', typedName: 'Quinta Quality', version: page.request.version })
    expect(answered.request).toMatchObject({ status: 'REFUSED', answer: { typedName: 'Quinta Quality', words: 'Too dark for our riders.' } })
    expect(await one('SELECT status, answer, "answeredBy", "recordedById" FROM "NcrConcession" WHERE id = $1', [capa.concessionId])).toEqual({ status: 'REFUSED', answer: 'Too dark for our riders.', answeredBy: 'Quinta Quality', recordedById: null })
    const row = await one<{ answeredByUserId: string | null; viaLink: string | null }>('SELECT "answeredByUserId", "answeredViaLinkId" AS "viaLink" FROM "ApprovalRequest" WHERE id = $1', [requestId])
    expect(row.answeredByUserId).not.toBeNull()
    expect(row.viaLink).toBeNull()
    expect((await taskOf(requestId)).status).toBe('DONE')
    expect((await eventsOf(capa.ncrId)).map((event) => event.type)).toContain('ncr.changed')
    // The NCR's thread keeps it (an internal note when the thread is not the customer's).
    expect(await admin(`SELECT 1 FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'Nonconformance' AND t."recordId" = $1 AND m."bodyText" LIKE '%Too dark for our riders.%'`, [capa.ncrId])).toHaveLength(1)
  })
})

describe('a revised order re-confirmed by the customer (SAL-222)', () => {
  it('REFUSED: an amendment that did not move the net total needs no re-acceptance', async () => {
    const refused = await as(owner, 'POST', '/approvals-out', { kind: 'REVISED_ORDER', recordType: 'SalesOrderAmendment', recordId: pricing.amendmentId, question: 'Confirm the new date.', send: false }, 409)
    expect(refused.error.message).toMatch(/did not change the net total/)
  })

  it('an amendment that moves the net total: the customer reads it line by line with its prices and accepts; the wait clears', async () => {
    const order = (await as(owner, 'GET', `/sales/orders/${pricing.money.sales.orderId}`)).order
    const line = order.lines[0]
    const sizes = line.sizes.map((size: Json, index: number) => ({ size: size.size, quantity: size.quantity + (index === 0 ? 1 : 0) }))
    const amended = await as(owner, 'POST', `/sales/orders/${order.id}/amendments`, { version: order.version, reason: 'One more jacket, as the customer asked by phone.', lines: order.lines.map((entry: Json) => (entry.id === line.id ? { id: entry.id, sizes } : { id: entry.id })) }, 201)
    expect(amended.amendment.reacceptance).toBe('NEEDED')
    const made = await as(owner, 'POST', '/approvals-out', { kind: 'REVISED_ORDER', recordType: 'SalesOrderAmendment', recordId: amended.amendment.id, question: 'Please confirm the order as revised.', send: false }, 201)
    expect(await taskOf(made.request.id)).toMatchObject({ kind: 'RECONFIRM_ORDER', status: 'OPEN' })
    const token = tokenOf(made.url)
    const page = await viaLink(token, 'GET', '/link/approval?language=en')
    expect(page.may.withChanges).toBe(false)
    // B-W2b-F16: the revision in both languages (the page shows the reader's; Italian no longer reads "revision").
    expect(page.request.words).toEqual({ it: `${order.number} · revisione ${amended.amendment.revision}`, en: `${order.number} · revision ${amended.amendment.revision}` })
    const office = await as(owner, 'GET', `/approvals-out/${made.request.id}`)
    expect(office.request.record).toEqual({ type: 'SalesOrderAmendment', id: amended.amendment.id, words: page.request.words })
    expect(page.content.revisedOrder).toMatchObject({ orderNumber: order.number, revision: amended.amendment.revision })
    expect(page.content.revisedOrder.netAmountAfter).toBeGreaterThan(page.content.revisedOrder.netAmountBefore)
    expect(page.content.revisedOrder.lines[0]).toMatchObject({ change: 'CHANGED', style: { code: expect.any(String) } })
    const changes = await viaLink(token, 'POST', '/link/approval/approve', { decision: 'APPROVED_WITH_CHANGES', answer: 'one more', typedName: 'Paolo Demo' }, 400)
    expect(pathsOf(changes)).toEqual(['body/decision'])
    expect((await one('SELECT "reapprovalNeededAt" IS NOT NULL AS waits FROM "SalesOrder" WHERE id = $1', [order.id])).waits).toBe(true)
    await viaLink(token, 'POST', '/link/approval/approve', { decision: 'APPROVED', typedName: 'Paolo Demo' })
    expect(await one('SELECT "reapprovalNeededAt", version FROM "SalesOrder" WHERE id = $1', [order.id])).toMatchObject({ reapprovalNeededAt: null, version: amended.order.version + 1 })
    expect((await taskOf(made.request.id)).status).toBe('DONE')
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE action = 'sales.reaccepted' AND "recordId" = $1`, [order.id])).toHaveLength(1)
  })
})

describe('a design proof holds the made-to-measure release (SAL-294)', () => {
  it('REFUSED on a line that is not made to measure; a proof waiting holds WO-0002\'s release check in words until withdrawn', async () => {
    const cell = await one<{ id: string; salesOrderLineId: string }>('SELECT id, "salesOrderLineId" FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id LIMIT 1', [production.draftWorkOrderId])
    const refused = await as(owner, 'POST', '/approvals-out', { kind: 'PROOF', recordType: 'SalesOrderLine', recordId: cell.salesOrderLineId, email: BRAND_QA, question: 'Check the names.', fileIds: [], send: false }, 409)
    expect(refused.error.message).toMatch(/not made to measure/)
    // A made-to-measure unit of the draft (the line's rider profile on the cell; the API makes no such work order yet) and its proof waiting.
    await admin(`ALTER TABLE "WorkOrderSize" DISABLE TRIGGER USER`)
    await admin(`UPDATE "WorkOrderSize" SET "measurementProfileId" = (SELECT id FROM "MeasurementProfile" WHERE "partyId" = "WorkOrderSize"."partyId" ORDER BY id LIMIT 1) WHERE id = $1`, [cell.id])
    await admin(`ALTER TABLE "WorkOrderSize" ENABLE TRIGGER USER`)
    expect((await one('SELECT "measurementProfileId" IS NOT NULL AS mtm FROM "WorkOrderSize" WHERE id = $1', [cell.id])).mtm).toBe(true)
    const proofId = newId()
    const party = (await one<{ partyId: string; companyId: string }>('SELECT "partyId", "companyId" FROM "SalesOrderLine" WHERE id = $1', [cell.salesOrderLineId]))
    await admin(`INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'SalesOrderLine', $4, $5, 'PROOF', 'Check the names on the back.', now() + interval '3 days', now(), now())`, [proofId, tenant, party.companyId, cell.salesOrderLineId, party.partyId])
    const check = await as(owner, 'GET', `/production/work-orders/${production.draftWorkOrderId}/release-check`)
    const holds = check.checks.find((entry: Json) => entry.code === 'HOLDS')
    expect(holds.state).toBe('BLOCKED')
    expect(holds.problems.map((problem: Json) => problem.message).join(' ')).toMatch(/design proof of .* waits for the customer's approval .*The customer's approval of the proof lifts it\./)
    const withdrawn = (await as(owner, 'GET', `/approvals-out/${proofId}`)).request
    await as(owner, 'POST', `/approvals-out/${proofId}/withdraw`, { version: withdrawn.version, reason: 'The rider confirmed by phone.' })
    const again = await as(owner, 'GET', `/production/work-orders/${production.draftWorkOrderId}/release-check`)
    expect(again.checks.find((entry: Json) => entry.code === 'HOLDS').problems.map((problem: Json) => problem.message).join(' ')).not.toMatch(/design proof/)
  })
})

describe('withdrawn and expired requests open nothing', () => {
  it('the office withdraws an open request: WITHDRAWN, the link stops, the task is cancelled; a stale version is refused', async () => {
    const photo = await photoOf('SalesOrder', pricing.money.sales.orderId, 'Made-up colour card.png')
    const made = await as(owner, 'POST', '/approvals-out', { kind: 'COLOUR', recordType: 'SalesOrder', recordId: pricing.money.sales.orderId, email: BRAND_QA, question: 'Approve the red.', fileIds: [photo], send: false }, 201)
    const token = tokenOf(made.url)
    await as(owner, 'POST', `/approvals-out/${made.request.id}/withdraw`, { version: made.request.version + 1 }, 409)
    const done = await as(owner, 'POST', `/approvals-out/${made.request.id}/withdraw`, { version: made.request.version, reason: 'The customer chose by phone.' })
    expect(done.request).toMatchObject({ status: 'WITHDRAWN', withdrawn: { reason: 'The customer chose by phone.' } })
    expect((await taskOf(made.request.id)).status).toBe('CANCELLED')
    await viaLink(token, 'GET', '/link/approval', undefined, 404)
  })

  it('the sweep expires a request past its due time: EXPIRED, link revoked, task cancelled; an answer comes too late', async () => {
    const photo = await photoOf('SalesOrder', pricing.money.sales.orderId, 'Made-up leather swatch.png')
    const made = await as(owner, 'POST', '/approvals-out', { kind: 'LEATHER', recordType: 'SalesOrder', recordId: pricing.money.sales.orderId, email: BRAND_QA, question: 'Approve the grain.', fileIds: [photo], send: false }, 201)
    // Asked two hours ago, due an hour ago (the database's own clock decides EXPIRED; the guard keeps when it was asked, so it is
    // set aside for this one update).
    await admin(`ALTER TABLE "ApprovalRequest" DISABLE TRIGGER USER`)
    await admin(`UPDATE "ApprovalRequest" SET "createdAt" = now() - interval '2 hours', "dueAt" = now() - interval '1 hour' WHERE id = $1`, [made.request.id])
    await admin(`ALTER TABLE "ApprovalRequest" ENABLE TRIGGER USER`)
    const swept = await sweepApprovals({ database: h.database, log, clock: h.clock })
    expect(swept.expired).toBeGreaterThanOrEqual(1)
    expect(await one('SELECT status FROM "ApprovalRequest" WHERE id = $1', [made.request.id])).toEqual({ status: 'EXPIRED' })
    expect((await taskOf(made.request.id)).status).toBe('CANCELLED')
    expect((await one('SELECT "revokedAt" IS NOT NULL AS revoked FROM "OneOffLink" WHERE "recordId" = $1', [made.request.id])).revoked).toBe(true)
    expect((await eventsOf(made.request.id)).map((event) => event.type)).toContain('approval_request.expired')
  })
})

describe('outside signers of a DVR version (AP1:02)', () => {
  it('REFUSED while no outside signer with a party still signs the version', async () => {
    const version = await admin<{ id: string }>(`SELECT id FROM "RiskAssessmentVersion" WHERE "tenantId" = $1 AND status = 'AWAITING_SIGNATURES' LIMIT 1`, [tenant])
    expect(version).toHaveLength(1)
    const refused = await as(owner, 'POST', '/approvals-out', { kind: 'SIGNATURE', recordType: 'RiskAssessmentVersion', recordId: version[0]!.id, email: BRAND_QA, question: 'Sign the new version.', send: false }, 409)
    expect(refused.error.message).toMatch(/outside signer/)
  })
})

describe('office approvals by e-mail (PLT-089)', () => {
  it('a person who turned it on gets one mail per new approval, each link opening only for them after the sign-in', async () => {
    expect((await as(owner, 'GET', '/approvals/mail-me')).on).toBe(false)
    expect((await as(owner, 'PUT', '/approvals/mail-me', { on: true })).on).toBe(true)
    const ownerId = (await one<{ id: string }>('SELECT id FROM "User" WHERE email = $1', [people.owner])).id
    const notificationId = newId()
    await admin(
      `INSERT INTO "Notification" (id, "tenantId", "userId", "companyId", category, "eventType", "eventId", "recordType", "recordId", "recordLabel", anchor, "messageKey", params, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'APPROVAL', 'quote.approval_requested', $5, 'Quote', $6, 'Q-2026-0142', 'approval:x', 'notifications.approval.quote_requested', '{}', $7, $7)`,
      [notificationId, tenant, ownerId, companyA, newId(), newId(), h.clock.now()],
    )
    const first = await mailOfficeApprovals({ database: h.database, log, cookieSecret: LOCAL_COOKIE_SECRET, clock: h.clock })
    expect(first).toEqual({ people: 1, sent: 1, failed: 0 })
    const text = textOf(lastMail('approvals.office', people.owner)!.raw)
    expect(text).toContain('Q-2026-0142')
    const mailedKey = decodeURIComponent(/#key=(\S+)/.exec(text)![1]!)
    expect((await mailOfficeApprovals({ database: h.database, log, cookieSecret: LOCAL_COOKIE_SECRET, clock: h.clock })).people).toBe(0)
    expect(await one('SELECT channel, outcome FROM "NotificationDelivery" WHERE "notificationId" = $1', [notificationId])).toEqual({ channel: 'EMAIL', outcome: 'SENT' })
    const opened = await as(owner, 'POST', '/approvals/mail-open', { key: mailedKey })
    expect(opened).toMatchObject({ record: { type: 'Quote', label: 'Q-2026-0142' }, anchor: 'approval:x', waiting: true })
    // A forwarded mail opens nothing for anybody else; a forged key neither.
    await as(manager, 'POST', '/approvals/mail-open', { key: mailedKey }, 404)
    await as(owner, 'POST', '/approvals/mail-open', { key: `${mailedKey.slice(0, -2)}AA` }, 404)
  })
})
