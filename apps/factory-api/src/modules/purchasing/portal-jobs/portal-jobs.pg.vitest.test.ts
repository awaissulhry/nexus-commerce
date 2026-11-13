import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSubcontract, type SubcontractSeed } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Subcontractor jobs on the local stack (B-W2b-176; SCM-154 to SCM-157, PLN-163; Owner answers C2 and C3): a throwaway
 * PostgreSQL 17 database from the migrations (row-level security, the partner role's column grants and the
 * …_portal_supply_w2b_guards triggers are real), the real app with the office buyer and warehouse, the workshop's people
 * signed in to the portal by e-mail code and its JOB_ACCEPT link (FAKE mailbox). The factory-db seeds give the work order
 * WO-0001 and the workshop P2 with its place A1-TERZ-P2; every name, number and fee is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/purchasing/portal-jobs`.
 */

let h: Harness
let buyer: Browser
let warehouse: Browser
let rosa: Browser
let vito: Browser
let otto: Browser
let seed: SubcontractSeed
const NS = 'portal-jobs'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const P9 = newId()
const YEAR = businessDate(new Date()).slice(0, 4)
const people = { rosa: 'rosa.jobs@workshop-p2.example', vito: 'vito.viewer@workshop-p2.example', otto: 'otto.jobs@other-p9.example' }
const today = () => businessDate(h.clock.now())

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `jobs-${label}-${++counter}-${newId()}`

async function as(browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'POST' ? { 'idempotency-key': key() } : {} })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

/** A request of the workshop's phone: only the link's token, no cookie. */
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

/** Every price-looking key in a JSON answer (none may be there: Owner answer C2). */
function priceTraces(body: unknown): string[] {
  const text = JSON.stringify(body)
  return [/price/i, /amount/i, /cost/i, /"fee/i, /internalNote/, /createdById/, /issuedById/, /DecidedById/].filter((pattern) => pattern.test(text)).map(String)
}

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'SUBCONTRACTOR' }, select: { id: true } })
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

const office = (id: string, rest = '') => `/purchasing/subcontracting/orders/${id}${rest}`
const tasksOf = (orderId: string) => admin<{ kind: string; status: string; doneById: string | null }>('SELECT kind, status, "doneById" FROM "PartnerTask" WHERE "recordId" = $1 ORDER BY "createdAt", id', [orderId])
const eventsOf = async (subject: string) => (await admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject]))
const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')

let order: Json
let bin = ''
let liningLot = ''
let bundles: { id: string; code: string; quantity: number }[] = []

beforeAll(async () => {
  h = await startHarness('portal_jobs')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  seed = await seedSubcontract({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000) ON CONFLICT DO NOTHING`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  // The released revision's sewing step done by the workshop P2 (a released routing is frozen: its guard is off for this).
  await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER "RoutingOperation_revision_guard"`)
  await admin(
    `UPDATE "RoutingOperation" r SET "supplierId" = $1, "pricePerPiece" = 5.25, "transitDays" = 7
       FROM "WorkOrderOperation" o WHERE o.id = $2 AND r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq"`,
    [P2, seed.production.operationIds.sew],
  )
  await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER "RoutingOperation_revision_guard"`)
  // B-W2b-365: an order made by hand goes to a workshop approved for the work: P2 approved for sewing and packing in company A (written as
  // the owner with the guards off: a decided qualification needs evidence files this test does not upload).
  await h.db.admin.query(
    `SET session_replication_role = replica; INSERT INTO "SupplierQualification" (id, "tenantId", "companyId", "partyId", "workCentreKinds", status, "validFrom", evidence, "decidedAt", "createdAt", "updatedAt") VALUES ('${newId()}', '${tenant}', '${companyA}', '${P2}', '{SEWING,PACKING}'::"WorkCentreKind"[], 'APPROVED', DATE '2026-01-01', '[{"recordType": "StoredFile", "recordId": "${newId()}"}]'::jsonb, now() - interval '1 hour', now(), now()); SET session_replication_role = origin;`,
  )
  // Two made-up whole-garment bundles of the work order (the seed's carry sleeves only): 2 garments of its 2-garment cell, 1 of another.
  const cells = await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY quantity DESC, id LIMIT 2`, [seed.production.workOrderId])
  for (const [index, quantity] of [2, 1].entries()) {
    await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [newId(), tenant, siteA1, seed.production.workOrderId, cells[index]!.id, `T-PJ-${index + 1}`, quantity])
  }
  bundles = await admin(`SELECT id, code, quantity FROM "Bundle" WHERE "workOrderId" = $1 AND code LIKE 'T-PJ-%' ORDER BY code`, [seed.production.workOrderId])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SUBCONTRACT', 'MAIN', $4, 'YEARLY', 'SC-{YYYY}-{N:4}', false) ON CONFLICT DO NOTHING`, [newId(), tenant, companyA, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'SUBCONTRACT'`, [tenant])
  bin = (await one<{ id: string }>(`SELECT id FROM "Location" WHERE "tenantId" = $1 AND code = 'A1-STORE-01'`, [tenant])).id
  liningLot = (await one<{ id: string }>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [tenant])).id
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  await portalWorld(h, seedTenant)
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => {
    const settings = await client.portalSettings.findFirst({ where: { partyId: P2 }, select: { id: true } })
    if (settings) await client.portalSettings.update({ where: { id: settings.id }, data: { portalOn: true }, select: { id: true } })
    else await client.portalSettings.create({ data: { id: P2, partyId: P2, portalOn: true }, select: { id: true } })
    await client.party.create({ data: { id: P9, code: `P${P9.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Other Workshop S.n.c.', roles: ['SUBCONTRACTOR'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: P9, partyId: P9, portalOn: true }, select: { id: true } })
  })
  await partnerPerson(people.rosa, P2, ['subcontractor-jobs', 'partner-approve', 'partner-comment', 'partner-upload'])
  await partnerPerson(people.vito, P2, ['subcontractor-jobs'])
  await partnerPerson(people.otto, P9, ['subcontractor-jobs', 'partner-approve'])
  buyer = await officeBrowser(seedTenant, 'bianca.buyer@seed-a.example.com', 'buyer')
  warehouse = await officeBrowser(seedTenant, 'walter.warehouse@seed-a.example.com', 'warehouse')
  freshGuard(h)
  rosa = await signedIn(people.rosa)
  vito = await signedIn(people.vito)
  otto = await signedIn(people.otto)
  // The office's order for the sewing step, issued; the seed's draft cancelled (its kit plan is the lining).
  const seedOrder = (await as(buyer, 'GET', office(seed.orderId))).order
  await as(buyer, 'POST', office(seed.orderId, '/cancel'), { version: seedOrder.version, reason: 'Made again for the jobs test' })
  order = (await as(buyer, 'POST', '/purchasing/subcontracting/orders', { workOrderId: seed.production.workOrderId, operations: [{ workOrderOperationId: seed.production.operationIds.sew }] }, 201)).order
  // The kit: 3 m of the grey lining (lot SEED-LOT-LIN-01, 120 m in A1-STORE-01).
  order = (await as(buyer, 'POST', office(order.id, '/kit'), { version: order.version, lines: [{ itemId: seedId('product:item:lining'), itemColourId: seedId('product:item-colour:lining:GRY'), lotId: liningLot, quantity: '3' }] }, 201)).order
  order = (await as(buyer, 'POST', office(order.id, '/issue'), { version: order.version })).order
}, 300_000)

afterAll(async () => {
  await h?.close()
})

describe('a job, from the link to the goods back', () => {
  let token = ''

  it('the office sends the job by mail, then hands a new link out once; the first one stops', async () => {
    const view = await as(buyer, 'GET', office(order.id, '/workshop'))
    expect(view.job).toMatchObject({ state: 'TO_ANSWER', chip: 'NEW', nextStep: 'ACCEPT' })
    expect(view.office).toMatchObject({ manage: true, sendLink: null })
    const mailed = await as(buyer, 'POST', office(order.id, '/job-link'), { email: 'laboratorio@workshop-p2.example', send: true, language: 'it' }, 201)
    expect(mailed).toMatchObject({ url: null, delivery: 'SENT' })
    const mail = h.ses.mails.filter((entry) => entry.templateKey === 'purchasing.job_link').at(-1)!
    const first = tokenOf(/https?:\/\/\S+#token=\S+/.exec(textOf(mail.raw))![0])
    expect(textOf(mail.raw)).toContain(order.number)
    expect(priceTraces(textOf(mail.raw))).toEqual([])
    const handed = await as(buyer, 'POST', office(order.id, '/job-link'), { send: false }, 201)
    expect(handed.url).toContain('#token=')
    token = tokenOf(handed.url)
    expect(handed.links.map((link: Json) => link.state)).toEqual(['REVOKED', 'LIVE'])
    await viaLink(first, 'GET', '/link/job', undefined, 404)
    expect((await eventsOf(order.id)).filter((event) => event.type === 'subcontract_order.job_sent')).toHaveLength(2)
  })

  it('the link shows the job without any price; the workshop proposes another day', async () => {
    const page = await viaLink(token, 'GET', '/link/job?language=en')
    expect(page.job).toMatchObject({ number: order.number, state: 'TO_ANSWER', acts: { accept: null, decline: null, moveDate: null } })
    expect(page.job.operations[0].pieces).toBe(7)
    expect(priceTraces(page)).toEqual([])
    const refused = await h.app.inject({ method: 'POST', url: '/link/job/move-date', headers: { 'x-factory-link': token, 'idempotency-key': key() }, payload: { version: page.job.version, proposedDate: addDays(today(), 20) } })
    expect(refused.statusCode).toBe(400)
    const answer = await viaLink(token, 'POST', '/link/job/move-date?language=en', { version: page.job.version, proposedDate: addDays(today(), 20), reason: 'Two machines in service this week', typedName: 'Rosa Demo' })
    expect(answer.done).toContain('you proposed')
    expect(answer.job.answer).toMatchObject({ proposedDate: addDays(today(), 20), proposedDateReason: 'Two machines in service this week', acceptedByName: 'Rosa Demo' })
    const evidence = await one(`SELECT action, "typedName" FROM "LinkEvidence" WHERE "linkId" = (SELECT id FROM "OneOffLink" WHERE "recordId" = $1 AND "revokedAt" IS NULL AND purpose = 'JOB_ACCEPT')`, [order.id])
    expect(evidence).toMatchObject({ action: 'MOVED_DATE', typedName: 'Rosa Demo' })
    expect((await eventsOf(order.id)).find((event) => event.type === 'subcontract_order.job_answered')!.payload).toMatchObject({ answer: 'ACCEPTED', via: 'LINK' })
    // REFUSED: the link answered once (one use).
    await viaLink(token, 'POST', '/link/job/decline', { version: answer.job.version, reason: 'NO_CAPACITY' }, 404)
  })

  it('the office accepts the proposed date once: the expected-back date moves', async () => {
    let view = await as(buyer, 'GET', office(order.id, '/workshop'))
    expect(view.office.decideDate).toBeNull()
    view = await as(buyer, 'POST', office(order.id, '/workshop/date'), { version: view.job.version, decision: 'ACCEPTED' })
    expect(view.job.expectedBackDate).toBe(addDays(today(), 20))
    expect(view.job.answer.dateDecision.decision).toBe('ACCEPTED')
    const again = await buyer.send('POST', office(order.id, '/workshop/date'), { version: view.job.version, decision: 'REFUSED' }, { headers: { 'idempotency-key': key() } })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toContain('answered already')
  })

  it('the warehouse sends the kit: the workshop is asked to confirm it and to report progress', async () => {
    order = (await as(buyer, 'GET', office(order.id))).order
    const lining = order.kitLines.find((line: Json) => line.status === 'PLANNED')!
    const sent = await as(
      warehouse,
      'POST',
      office(order.id, '/kit/send'),
      { version: order.version, lines: [{ lineId: lining.id, fromLocationId: bin, lotId: liningLot }], bundles: bundles.map((bundle) => ({ bundleId: bundle.id })), pieces: [{ operationId: order.operations[0].id, pieces: 7 }], ddt: null },
      201,
    )
    order = sent.order
    expect(order.status).toBe('AT_WORKSHOP')
    expect((await tasksOf(order.id)).map((task) => `${task.kind}:${task.status}`)).toEqual(['CONFIRM_KIT:OPEN', 'REPORT_PROGRESS:OPEN'])
  })

  it('the workshop reads its jobs in the portal, never a price; another workshop and a viewer may not act', async () => {
    const list = await as(rosa, 'GET', '/portal/jobs')
    expect(list.chip).toBe('KIT')
    expect(list.items.map((item: Json) => item.number)).toEqual([order.number])
    expect(list.counts).toMatchObject({ toAccept: 0, kitToConfirm: 1 })
    expect(priceTraces(list)).toEqual([])
    const record = await as(rosa, 'GET', `/portal/jobs/${order.id}`)
    expect(record.mayAct).toEqual({ approve: true, comment: true, upload: true })
    expect(record.job.kit.toConfirm).toBe(1)
    expect(record.job.bundles).toHaveLength(2)
    expect(priceTraces(record)).toEqual([])
    const home = await as(rosa, 'GET', '/portal/home')
    expect(JSON.stringify(home)).toContain('jobs.kit_to_confirm')
    await as(otto, 'GET', `/portal/jobs/${order.id}`, undefined, 404)
    const viewer = await as(vito, 'GET', `/portal/jobs/${order.id}`)
    expect(viewer.mayAct).toEqual({ approve: false, comment: false, upload: false })
    const refused = await as(vito, 'POST', `/portal/jobs/${order.id}/kit`, { version: viewer.job.version, all: true }, 403)
    expect(refused.error.message).toContain('ask your admin')
    // REFUSED: the office's record is not the portal's.
    expect((await rosa.get(office(order.id))).status).toBe(401)
  })

  it('confirms the kit with a shortfall in words, and a photo of it', async () => {
    let record = await as(rosa, 'GET', `/portal/jobs/${order.id}`)
    const line = record.job.kit.lines.find((row: Json) => row.status === 'SENT')
    const noWords = await as(rosa, 'POST', `/portal/jobs/${order.id}/kit`, { version: record.job.version, lines: [{ kitLineId: line.id, quantity: '1' }] }, 400)
    expect(noWords.error.issues[0].path).toBe('body/lines/0/note')
    record = await as(rosa, 'POST', `/portal/jobs/${order.id}/kit`, { version: record.job.version, lines: [{ kitLineId: line.id, quantity: '1', note: 'One roll end wet' }] })
    expect(record.done).toContain('difference')
    expect(record.job.kit.lines.find((row: Json) => row.id === line.id).check).toMatchObject({ quantity: '1.0000', short: true, note: 'One roll end wet' })
    expect(record.job.chip).toBe('WORK')
    const kitTask = (await tasksOf(order.id)).find((task) => task.kind === 'CONFIRM_KIT')!
    expect(kitTask.status).toBe('DONE')
    expect(kitTask.doneById).not.toBeNull()
    const pdf = await as(rosa, 'POST', `/portal/jobs/${order.id}/kit/photos`, { kitLineId: line.id, originalName: 'damage.pdf', contentType: 'application/pdf', sizeBytes: 1000, sha256: 'a'.repeat(64) }, 400)
    expect(pdf.error.issues[0].path).toBe('body/contentType')
    const photo = await as(rosa, 'POST', `/portal/jobs/${order.id}/kit/photos`, { kitLineId: line.id, originalName: 'damage.jpg', contentType: 'image/jpeg', sizeBytes: 1000, sha256: 'b'.repeat(64) }, 201)
    expect(photo.file.status).toBe('PENDING_UPLOAD')
    const file = await one('SELECT "recordType", "partyId", kind, visibility FROM "StoredFile" WHERE id = $1', [photo.file.id])
    expect(file).toMatchObject({ recordType: 'SubcontractKitLine', partyId: P2, kind: 'PHOTO' })
    // The office's kit tab: a line the workshop confirmed it received never comes back "unsent".
    const view = await as(warehouse, 'GET', office(order.id))
    const back = await warehouse.send('POST', office(order.id, `/kit/${line.id}/return`), { version: view.order.version, reason: 'test' }, { headers: { 'idempotency-key': key() } })
    expect(back.status).toBe(409)
    expect(back.body.error.message).toContain('confirmed it received')
  })

  it('reports finished pieces per size and bundle, never past the pieces', async () => {
    let record = await as(rosa, 'GET', `/portal/jobs/${order.id}`)
    const operation = record.job.operations[0]
    const size = operation.sizes[0]
    const over = await as(rosa, 'POST', `/portal/jobs/${order.id}/progress`, { version: record.job.version, entries: [{ operationId: operation.id, workOrderSizeId: size.workOrderSizeId, finished: size.pieces + 1 }] }, 400)
    expect(over.error.issues[0].path).toBe('body/entries/0/finished')
    record = await as(rosa, 'POST', `/portal/jobs/${order.id}/progress`, {
      version: record.job.version,
      entries: [{ operationId: operation.id, bundleId: bundles[0]!.id, finished: 2 }, { operationId: operation.id, finished: 2 }],
      finishBy: addDays(today(), 15),
      note: 'Linings in from tomorrow',
    })
    expect(record.done).toContain('4 finished')
    expect(record.job.operations[0]).toMatchObject({ finished: 4, ready: 4 })
    expect(record.job.chip).toBe('BACK')
    expect(record.job.finishBy).toBe(addDays(today(), 15))
    expect((await tasksOf(order.id)).find((task) => task.kind === 'REPORT_PROGRESS')!.status).toBe('DONE')
    const reports = await admin('SELECT "reportedByName", "createdById", "bundleId" FROM "SubcontractProgressReport" WHERE "subcontractOrderId" = $1 ORDER BY "finishedQuantity", id', [order.id])
    expect(reports.every((row) => row.createdById === null && row.reportedByName === 'rosa jobs')).toBe(true)
  })

  let noticeId = ''
  it('announces the send-back with its DDT: it prefills the receive back and moves nothing', async () => {
    let record = await as(rosa, 'GET', `/portal/jobs/${order.id}`)
    const operation = record.job.operations[0]
    const base = { version: record.job.version, parcels: 2, expectedDate: addDays(today(), 3), ddt: { number: 'W-77', date: today() } }
    const noReason = await as(rosa, 'POST', `/portal/jobs/${order.id}/returns`, { ...base, quantities: [{ operationId: operation.id, finished: 2, scrapped: 1 }] }, 400)
    expect(noReason.error.issues[0].path).toBe('body/quantities/0/reasonCode')
    const tooMany = await as(rosa, 'POST', `/portal/jobs/${order.id}/returns`, { ...base, quantities: [{ operationId: operation.id, finished: 8 }] }, 400)
    expect(tooMany.error.message).toContain('7 piece(s)')
    const moves = (await one<{ n: string }>('SELECT count(*) AS n FROM "StockMove" WHERE "tenantId" = $1', [tenant])).n
    record = await as(rosa, 'POST', `/portal/jobs/${order.id}/returns`, { ...base, quantities: [{ operationId: operation.id, bundleId: bundles[0]!.id, finished: 2 }, { operationId: operation.id, finished: 1, scrapped: 1, reasonCode: 'STAIN' }] })
    expect(record.done).toBe(`We expect 4 piece(s) on ${Number(addDays(today(), 3).slice(8))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(addDays(today(), 3).slice(5, 7)) - 1]}.`)
    expect((await one<{ n: string }>('SELECT count(*) AS n FROM "StockMove" WHERE "tenantId" = $1', [tenant])).n).toBe(moves)
    noticeId = record.job.returns[0].id
    const view = await as(warehouse, 'GET', office(order.id, '/workshop'))
    expect(view.prefills).toEqual([
      expect.objectContaining({
        returnNoticeId: noticeId,
        supplierDdt: { number: 'W-77', date: today() },
        lines: [expect.objectContaining({ bundleId: bundles[0]!.id, good: 2 }), expect.objectContaining({ bundleId: null, good: 1, scrapped: 1, reason: 'STAIN' })],
      }),
    ])
  })

  it('the warehouse receives back from the notice: it is RECEIVED with the receipt', async () => {
    const view = await as(warehouse, 'GET', office(order.id, '/workshop'))
    const prefill = view.prefills[0]
    const current = (await as(warehouse, 'GET', office(order.id))).order
    const lines = prefill.lines.map((line: Json) => ({ operationId: line.operationId, ...(line.bundleId ? { bundleId: line.bundleId } : {}), good: line.good, defective: line.defective, scrapped: line.scrapped, reason: line.reason }))
    const received = await as(warehouse, 'POST', office(order.id, '/receive'), { version: current.version, lines, supplierDdt: prefill.supplierDdt, returnNoticeId: prefill.returnNoticeId }, 201)
    expect(received.order.status).toBe('PARTLY_RECEIVED')
    const notice = await one('SELECT status, "receiptId", "receivedAt" FROM "SubcontractReturnNotice" WHERE id = $1', [noticeId])
    expect(notice.status).toBe('RECEIVED')
    expect(notice.receiptId).not.toBeNull()
    // REFUSED: the same notice twice.
    const again = (await as(warehouse, 'GET', office(order.id))).order
    const twice = await warehouse.send('POST', office(order.id, '/receive'), { version: again.version, lines: [{ operationId: prefill.lines[0].operationId, good: 1, defective: 0, scrapped: 0 }], returnNoticeId: noticeId }, { headers: { 'idempotency-key': key() } })
    expect(twice.status).toBe(409)
  })

  it('the office acts for a workshop without e-mail (C3): a report and a send-back it then cancels', async () => {
    let view = await as(buyer, 'GET', office(order.id, '/workshop'))
    const operation = view.job.operations[0]
    view = await as(buyer, 'POST', office(order.id, '/workshop/progress'), { version: view.job.version, entries: [{ operationId: operation.id, finished: 1 }], name: 'Gino by phone' })
    expect(view.job.reports.filter((report: Json) => report.byOffice)).toEqual([expect.objectContaining({ byName: 'Gino by phone', finished: 1 })])
    view = await as(buyer, 'POST', office(order.id, '/workshop/returns'), { version: view.job.version, quantities: [{ operationId: operation.id, finished: 1 }], parcels: 1, expectedDate: addDays(today(), 2), weCollect: true })
    const notice = view.job.returns.find((row: Json) => row.status === 'ANNOUNCED')
    expect(notice).toMatchObject({ byOffice: true, weCollect: true })
    const events = (await eventsOf(order.id)).filter((event) => event.type === 'subcontract_order.return_announced')
    expect(events.map((event) => event.payload.via).sort()).toEqual(['OFFICE', 'PORTAL'])
    // REFUSED: the buyer may not cancel what comes back (purchasing.subcontract.receive); the warehouse may.
    expect((await buyer.send('POST', office(order.id, `/workshop/returns/${notice.id}/cancel`), { version: view.job.version, reason: 'x' }, { headers: { 'idempotency-key': key() } })).status).toBe(403)
    view = await as(warehouse, 'POST', office(order.id, `/workshop/returns/${notice.id}/cancel`), { version: view.job.version, reason: 'The workshop will bring them with the rest' })
    expect(view.job.returns.find((row: Json) => row.id === notice.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'The workshop will bring them with the rest' })
    // The audit says who and how.
    const audits = await admin(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.subcontract.progress'`, [order.id])
    expect(audits.map((row) => row.after.via).sort()).toEqual(['OFFICE', 'PORTAL'])
    expect(audits.find((row) => row.after.via === 'OFFICE')!.after).toMatchObject({ byPartner: false, byName: 'Gino by phone' })
  })
})

describe('a job declined in the portal', () => {
  it('the workshop declines with its reason; nothing else may follow', async () => {
    let second = (await as(buyer, 'POST', '/purchasing/subcontracting/orders', { workOrderId: seed.production.workOrderId, partyId: P2, operations: [{ workOrderOperationId: seed.production.operationIds.pack, pricePerPiece: '1.50' }], expectedBackDate: addDays(today(), 10) }, 201)).order
    second = (await as(buyer, 'POST', office(second.id, '/issue'), { version: second.version })).order
    const list = await as(rosa, 'GET', '/portal/jobs')
    expect(list.chip).toBe('NEW')
    expect(list.counts.toAccept).toBe(1)
    let record = await as(rosa, 'GET', `/portal/jobs/${second.id}`)
    const other = await as(rosa, 'POST', `/portal/jobs/${second.id}/decline`, { version: record.job.version, reason: 'OTHER' }, 400)
    expect(other.error.issues[0].path).toBe('body/note')
    record = await as(rosa, 'POST', `/portal/jobs/${second.id}/decline`, { version: record.job.version, reason: 'NO_CAPACITY', note: 'Full until next month' })
    expect(record.job).toMatchObject({ state: 'DECLINED', chip: 'DONE', answer: { declineReason: 'No capacity: Full until next month', declinedByName: 'rosa jobs' } })
    const progress = await as(rosa, 'POST', `/portal/jobs/${second.id}/progress`, { version: record.job.version, entries: [{ operationId: record.job.operations[0].id, finished: 1 }] }, 409)
    expect(progress.error.message).toContain('declined')
    const stale = await as(rosa, 'POST', `/portal/jobs/${second.id}/accept`, { version: record.job.version - 1 }, 409)
    expect(stale).toBeDefined()
    // The office cancels it: the job ends in the portal.
    second = (await as(buyer, 'GET', office(second.id))).order
    await as(buyer, 'POST', office(second.id, '/cancel'), { version: second.version, reason: 'Declined by the workshop' })
    expect((await as(rosa, 'GET', `/portal/jobs/${second.id}`)).job.state).toBe('CANCELLED')
  })
})
