import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * B-W2b-113 on the local stack with the app's real routes (a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login: row-level security and the …_quality_problems_w2b_guards triggers are real; tenant A from EVERY seed):
 *   - the NCR (modules/quality/ncr): its cause and the CAPA it is escalated to (the CAPA module's reads), its cost by the
 *     cost grain (QHS-086: SEED-NCR-0002's typed and computed lines), its concessions asked of the customer (QHS-085), its
 *     report (ncr-pdf), the safety rule on decisions and the rework scrap path for garments still in work;
 *   - the complaint (modules/quality/complaints, one database for both: fewer fresh databases under the migration lock):
 *     its investigation and its answer letter written, previewed and sent (QHS-116; FAKE e-mail), back to investigating.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/quality/ncr`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'w2b113-a'
const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  P1: id('party:P1'),
  P2: id('party:P2'),
  wo1: id('production:work-order:WO-0001'),
  seedNcr2: id('holds:ncr:NCR-0002'),
  complaint: id('returns:CMP-0001'),
}
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

let h: Harness
let app: FastifyInstance
let senderId = ''
const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const QUALITY: Permission[] = ['quality.ncr.view', 'quality.ncr.raise', 'quality.ncr.manage', 'quality.ncr.approve', 'quality.holds.view', 'inventory.stock.view', 'production.rework', 'production.scrap.view', 'quality.defects.view']
const COMPLAINTS: Permission[] = ['quality.complaints.view', 'quality.complaints.log', 'quality.complaints.manage', 'quality.ncr.view', 'compliance.register.view', 'threads.read', 'threads.post', 'files.read']
const ACTORS: Record<string, string> = {}
const SESSIONS: Record<string, () => SessionContext> = {
  qa: () => ({ audience: 'office', tenantId: A.tenant, actorId: (ACTORS.qa ??= newId()), grants: [grant([...QUALITY, 'quality.capa.view', 'money.cost'])] }),
  qaNoCost: () => ({ audience: 'office', tenantId: A.tenant, actorId: (ACTORS.qaNoCost ??= newId()), grants: [grant(QUALITY)] }),
  viewer: () => ({ audience: 'office', tenantId: A.tenant, actorId: (ACTORS.viewer ??= newId()), grants: [grant(['quality.ncr.view', 'money.cost'])] }),
  complaints: () => ({ audience: 'office', tenantId: A.tenant, actorId: senderId, grants: [grant([...COMPLAINTS, 'quality.capa.view'])] }),
  complaintsViewer: () => ({ audience: 'office', tenantId: A.tenant, actorId: (ACTORS.complaintsViewer ??= newId()), grants: [grant(['quality.complaints.view'])] }),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `w2b113-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)

const codes: Record<string, string> = {}
let bundle: { id: string; code: string }
let sewOp: string

beforeAll(async () => {
  h = await startHarness('quality_w2b113')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  // The letterhead the report and the letter need (c.c. art. 2250), made up.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  // The letter's sender is a real office person (the thread's message names its author).
  senderId = (await addUser(h, TENANT, { email: 'quality.w2b113@example.com', role: 'quality_inspector' })).id
  for (const row of await admin<{ id: string; code: string }>(`SELECT id, code FROM "DispositionCode" WHERE "tenantId" = $1`, [A.tenant])) codes[row.code] = row.id
  bundle = (await admin<{ id: string; code: string }>(`SELECT id, code FROM "Bundle" WHERE "workOrderId" = $1 AND code = 'SEED-BN-0001'`, [A.wo1]))[0]!
  sewOp = (await admin<{ id: string }>(`SELECT id FROM "WorkOrderOperation" WHERE "workOrderId" = $1 AND seq = 20`, [A.wo1]))[0]!.id
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('the NCR names its cause and its CAPA (the CAPA module\'s reads)', () => {
  it('a reader of the CAPA sees it on the record and the list row; another reader is told it is escalated elsewhere', async () => {
    const { record } = await ok('qa', 'GET', `/quality/ncr/${A.seedNcr2}`)
    expect(record.capaRecord).toMatchObject({ number: 'SEED-CAPA-0001', type: 'CAPA' })
    expect(record.capaElsewhere).toBe(false)
    expect(record.ncr.capa).toMatchObject({ number: 'SEED-CAPA-0001' })
    expect(record.ncr.cause).toMatchObject({ code: 'MAT-FAULT' })
    expect(record.may).toMatchObject({ cost: true, escalate: true })
    const other = (await ok('qaNoCost', 'GET', `/quality/ncr/${A.seedNcr2}`)).record
    expect(other.capaRecord).toBeNull()
    expect(other.capaElsewhere).toBe(true)
    expect(other.ncr.capa).toBeNull()
    expect(other.may).toMatchObject({ cost: false, escalate: false })
    const row = (await ok('qa', 'GET', '/quality/ncr?stage=CONTAINED')).items.find((item: Json) => item.id === A.seedNcr2)
    expect(row.capa).toMatchObject({ number: 'SEED-CAPA-0001' })
  })
})

describe('the cost of the NCR by the cost grain (QHS-086)', () => {
  const url = `/quality/ncr/${A.seedNcr2}/cost`
  it('the list shows the total only with the grain; the tab is refused without it', async () => {
    const withGrain = (await ok('qa', 'GET', '/quality/ncr?stage=CONTAINED')).items.find((item: Json) => item.id === A.seedNcr2)
    expect(withGrain.cost).toBe(22_700)
    const without = (await ok('qaNoCost', 'GET', '/quality/ncr?stage=CONTAINED')).items.find((item: Json) => item.id === A.seedNcr2)
    expect(without).not.toHaveProperty('cost')
    expect((await refused('qaNoCost', 'GET', url, undefined, 403)).message).toMatch(/cost grain/)
    const { sheet } = await ok('qa', 'GET', url)
    expect(sheet.lines.map((line: Json) => [line.seq, line.kind, line.source, line.amount])).toEqual([
      [1, 'MATERIAL', 'TYPED', 18_500],
      [2, 'SCRAP_VALUE', 'COMPUTED', 4_200],
    ])
    expect(sheet.total).toBe(22_700)
    expect(sheet.lines[1].record).toMatchObject({ type: 'NcrDispositionLine', label: expect.stringMatching(/^\d+ · SCRAP$/) })
    expect(sheet.held).toBeNull()
  })

  it('typed lines are added, changed at their own version and removed; a computed line is read-only; the audit marks the amounts', async () => {
    const versionBefore = (await ok('qa', 'GET', `/quality/ncr/${A.seedNcr2}`)).record.ncr.version
    expect(paths(await refused('qa', 'POST', `${url}/lines`, { kind: 'OTHER', amount: 300 }, 400))).toEqual(['body/description'])
    expect(paths(await refused('qa', 'POST', `${url}/lines`, { kind: 'FREIGHT', amount: -5 }, 400))).toEqual(['body/amount'])
    let { sheet } = await ok('qa', 'POST', `${url}/lines`, { kind: 'FREIGHT', description: 'Courier of the hide back to the tannery', amount: 1_500 }, 201)
    expect(sheet.total).toBe(24_200)
    const freight = sheet.lines.find((line: Json) => line.kind === 'FREIGHT')
    ;({ sheet } = await ok('qa', 'PATCH', `${url}/lines/${freight.id}`, { version: freight.version, amount: 2_000 }))
    expect(sheet.total).toBe(24_700)
    expect((await refused('qa', 'PATCH', `${url}/lines/${freight.id}`, { version: freight.version, amount: 2_500 }, 409)).code).toBe('conflict')
    const computed = sheet.lines.find((line: Json) => line.source === 'COMPUTED')
    expect((await refused('qa', 'PATCH', `${url}/lines/${computed.id}`, { version: computed.version, amount: 1 }, 409)).message).toMatch(/computed again/)
    const changed = sheet.lines.find((line: Json) => line.kind === 'FREIGHT')
    ;({ sheet } = await ok('qa', 'DELETE', `${url}/lines/${changed.id}?version=${changed.version}`))
    expect(sheet.total).toBe(22_700)
    // The NCR's own version did not move (an open Problem form stays good); the events name the field, never an amount.
    expect((await ok('qa', 'GET', `/quality/ncr/${A.seedNcr2}`)).record.ncr.version).toBe(versionBefore)
    const changes = (await events('ncr.changed')).filter((payload) => payload.ncrId === A.seedNcr2)
    expect(changes.filter((payload) => payload.fields.includes('cost'))).toHaveLength(3)
    expect(JSON.stringify(changes)).not.toMatch(/2000|1500/)
    const [audit] = await admin<Json>(`SELECT "after" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'quality.addNcrCostLine' ORDER BY "at" DESC LIMIT 1`, [A.tenant])
    expect(audit!.after.amount).toEqual({ $money: 'cost', value: 1_500 })
  })

  it('computing again brings the computed lines up to date (one per record), then nothing changes', async () => {
    const before = (await ok('qa', 'GET', url)).sheet
    const computed = await ok('qa', 'POST', `${url}/compute`, {})
    expect(computed.added + computed.changed + computed.removed).toBe(before.computed.add + before.computed.change + before.computed.remove)
    expect(computed.sheet.computed.upToDate).toBe(true)
    const again = await ok('qa', 'POST', `${url}/compute`, {})
    expect([again.added, again.changed, again.removed]).toEqual([0, 0, 0])
    expect(paths(await refused('qaNoCost', 'POST', `${url}/lines`, { kind: 'FREIGHT', amount: 100 }, 403))).toEqual(expect.any(Array))
  })
})

describe('a concession asked of the customer, their written answer recorded (QHS-085)', () => {
  let ncrId = ''
  it('asks the customer on a major NCR; never on a critical one', async () => {
    const { record } = await ok('qa', 'POST', `/quality/ncr/${A.seedNcr2}/concessions`, { partyId: A.P1, ask: 'Accept two jackets with a slightly darker sleeve', proposal: 'Delivered as they are, 5 % off' }, 201)
    ncrId = record.ncr.id
    expect(record.concessions.map((entry: Json) => [entry.seq, entry.status, entry.party.id])).toEqual([
      [1, 'ASKED', A.P1],
      [2, 'ASKED', A.P1],
    ])
    expect(record.actions.concession).toBeNull()
    expect(paths(await refused('qa', 'POST', `/quality/ncr/${ncrId}/concessions`, { partyId: A.P1, ask: ' ', proposal: '' }, 400))).toEqual(['body/ask', 'body/proposal'])
    const critical = (await ok('qa', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'Protector missing', quantityAffected: '1', severity: 'CRITICAL' }, 201)).record
    expect(critical.actions.concession).toMatch(/never accepted/)
    expect((await refused('qa', 'POST', `/quality/ncr/${critical.ncr.id}/concessions`, { partyId: A.P1, ask: 'x', proposal: 'y' }, 409)).message).toMatch(/never accepted/)
  })

  it('records the answer once: refused needs their words, a file must be of the concession', async () => {
    const asked = (await ok('qa', 'GET', `/quality/ncr/${ncrId}`)).record.concessions[1]
    const answered = new Date().toISOString()
    expect(paths(await refused('qa', 'POST', `/quality/ncr/${ncrId}/concessions/${asked.id}/answer`, { version: asked.version, status: 'REFUSED', answeredBy: 'Seed Buyer One', answeredAt: answered }, 400))).toEqual(['body/answer'])
    const foreign = (await admin<{ id: string }>(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "recordType" <> 'NcrConcession' AND status = 'AVAILABLE' LIMIT 1`, [A.tenant]))[0]
    if (foreign) expect(paths(await refused('qa', 'POST', `/quality/ncr/${ncrId}/concessions/${asked.id}/answer`, { version: asked.version, status: 'ACCEPTED', answeredBy: 'Seed Buyer One', answeredAt: answered, answerFileId: foreign.id }, 400))).toEqual(['body/answerFileId'])
    const { record } = await ok('qa', 'POST', `/quality/ncr/${ncrId}/concessions/${asked.id}/answer`, { version: asked.version, status: 'ACCEPTED', answer: 'Fine for this order', answeredBy: 'Seed Buyer One', answeredAt: answered })
    expect(record.concessions[1]).toMatchObject({ status: 'ACCEPTED', answeredBy: 'Seed Buyer One', answer: 'Fine for this order', recordedById: ACTORS.qa })
    expect((await refused('qa', 'POST', `/quality/ncr/${ncrId}/concessions/${asked.id}/answer`, { version: record.concessions[1].version, status: 'REFUSED', answer: 'No', answeredBy: 'X', answeredAt: answered }, 409)).message).toMatch(/once/)
    expect((await events('ncr.changed')).filter((payload) => payload.ncrId === ncrId && payload.fields.includes('concessions'))).toHaveLength(2)
  })
})

describe('the NCR report (ncr-pdf), the cause, the safety rule and the rework scrap path', () => {
  it('previews the PDF and keeps a version once (the same contents give it back)', async () => {
    const preview = await call('qa', 'GET', `/quality/ncr/${A.seedNcr2}/report?language=en`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.headers['content-type']).toMatch(/application\/pdf/)
    expect(preview.rawPayload.subarray(0, 4).toString()).toBe('%PDF')
    const first = await ok('qa', 'POST', `/quality/ncr/${A.seedNcr2}/report`, { language: 'it' }, 201)
    expect(first).toMatchObject({ made: true, report: { version: 1, language: 'it' } })
    const again = await ok('qa', 'POST', `/quality/ncr/${A.seedNcr2}/report`, { language: 'it' }, 201)
    expect(again).toMatchObject({ made: false, report: { id: first.report.id } })
    const [doc] = await admin<Json>(`SELECT kind::text, "siteId", "recordType" FROM "GeneratedDocument" WHERE id = $1`, [first.report.id])
    expect(doc).toEqual({ kind: 'NCR_REPORT', siteId: A.siteA1, recordType: 'Nonconformance' })
    expect((await ok('qa', 'GET', `/quality/ncr/${A.seedNcr2}`)).record.reports.map((report: Json) => report.version)).toEqual([1])
    expect((await refused('viewer', 'POST', `/quality/ncr/${A.seedNcr2}/report`, {}, 403)).code).toBe('forbidden')
  })

  it('names a cause while open; refuses an unknown one; a critical NCR is never regraded', async () => {
    const { record } = await ok('qa', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'Wrong thread on the pocket', quantityAffected: '4', severity: 'MINOR' }, 201)
    const cause = (await admin<{ id: string }>(`SELECT id FROM "CauseCode" WHERE "tenantId" = $1 AND code = 'SEW-ERROR'`, [A.tenant]))[0]!
    const named = (await ok('qa', 'PATCH', `/quality/ncr/${record.ncr.id}`, { version: record.ncr.version, causeCodeId: cause.id })).record
    expect(named.ncr.cause).toMatchObject({ code: 'SEW-ERROR' })
    expect(paths(await refused('qa', 'PATCH', `/quality/ncr/${record.ncr.id}`, { version: named.ncr.version, causeCodeId: newId() }, 400))).toEqual(['body/causeCodeId'])
    const critical = (await ok('qa', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'CE label missing', quantityAffected: '2', severity: 'CRITICAL' }, 201)).record
    expect(paths(await refused('qa', 'POST', `/quality/ncr/${critical.ncr.id}/decisions`, { version: critical.ncr.version, dispositionCodeId: codes.REGRADE, quantity: '1' }, 400))).toEqual(['body/dispositionCodeId'])
  })

  it('garments still in work are scrapped through a rework order done at once (the plan\'s rework scrap path)', async () => {
    let { record } = await ok('qa', 'POST', '/quality/ncr', { from: { recordType: 'Bundle', recordId: bundle.id }, title: 'Burnt panel, not repairable', quantityAffected: '1', severity: 'MAJOR' }, 201)
    ;({ record } = await ok('qa', 'POST', `/quality/ncr/${record.ncr.id}/decisions`, { version: record.ncr.version, dispositionCodeId: codes.REWORK, quantity: '1' }, 201))
    const decision = record.decisions[0]
    const made = await ok('qa', 'POST', `/quality/ncr/${record.ncr.id}/decisions/${decision.id}/rework`, { version: decision.version, reworkAtOperationId: sewOp, bundleId: bundle.id, reasonCode: 'RESTITCH', scrapAll: true })
    const [rework] = await admin<Json>(`SELECT status::text, "goodQuantity", "scrapQuantity", "recordType", "recordId" FROM "ReworkOrder" WHERE id = $1`, [made.reworkId])
    expect(rework).toEqual({ status: 'DONE', goodQuantity: 0, scrapQuantity: 1, recordType: 'Nonconformance', recordId: record.ncr.id })
    expect(made.record.decisions[0]).toMatchObject({ state: 'DONE', followUp: { type: 'ReworkOrder', id: made.reworkId } })
  })
})

describe('the complaint: investigation and the answer letter (QHS-116)', () => {
  const url = `/quality/complaints/${A.complaint}`
  it('the record shows the investigation, the letter being written and the CAPA it is escalated to', async () => {
    const { complaint } = await ok('complaints', 'GET', url)
    expect(complaint.findings).toMatch(/wrong thread/)
    expect(complaint.answer).toMatchObject({ language: 'it', text: expect.stringMatching(/^Gentile cliente/), sent: null, versions: [] })
    expect(complaint.capaRecord).toMatchObject({ number: 'SEED-8D-0001', type: 'EIGHT_D' })
    expect(complaint.capa).toMatchObject({ number: 'SEED-8D-0001' })
    expect(complaint.actions.find((entry: Json) => entry.action === 'sendAnswer')).toMatchObject({ allowed: true, held: null })
    const viewer = (await ok('complaintsViewer', 'GET', url)).complaint
    expect(viewer.capaRecord).toBeNull()
    expect(viewer.capaElsewhere).toBe(true)
    expect(viewer.actions.find((entry: Json) => entry.action === 'investigate').held).toBe('NO_PERMISSION')
  })

  it('writes the investigation and the letter; files must be of the complaint', async () => {
    let { complaint } = await ok('complaints', 'GET', url)
    ;({ complaint } = await ok('complaints', 'PATCH', `${url}/investigation`, { version: complaint.version, findings: 'Two jackets of the batch had the wrong thread on the pocket seam.' }))
    expect(complaint.findings).toMatch(/^Two jackets/)
    expect((await events('complaint.changed')).some((payload) => payload.complaintId === A.complaint && payload.fields.includes('findings'))).toBe(true)
    const foreign = (await admin<{ id: string }>(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "recordType" <> 'Complaint' AND status = 'AVAILABLE' LIMIT 1`, [A.tenant]))[0]
    if (foreign) expect(paths(await refused('complaints', 'PUT', `${url}/answer`, { version: complaint.version, fileIds: [foreign.id] }, 400))).toEqual(['body/fileIds/0'])
    ;({ complaint } = await ok('complaints', 'PUT', `${url}/answer`, { version: complaint.version, template: 'REPAIR', language: 'it', text: 'Gentile Seed Partner,\n\nripareremo il capo a nostre spese.' }))
    expect(complaint.answer).toMatchObject({ template: 'REPAIR', language: 'it', text: 'Gentile Seed Partner,\n\nripareremo il capo a nostre spese.' })
  })

  it('previews and sends the letter by e-mail (review then send): ANSWERED, frozen; back to investigating opens it again', async () => {
    const preview = await call('complaints', 'GET', `${url}/answer/letter`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.rawPayload.subarray(0, 4).toString()).toBe('%PDF')
    const check = await ok('complaints', 'GET', `${url}/answer/check`)
    expect(check.problems, JSON.stringify(check.problems)).toEqual([])
    const buyer = check.recipients.find((entry: Json) => entry.email === 'buyer.p1@example.com')
    expect(buyer).toBeTruthy()
    let { complaint } = await ok('complaints', 'GET', url)
    const sent = await ok('complaints', 'POST', `${url}/answer/send`, { version: complaint.version, contactIds: [buyer.contactId] })
    complaint = sent.complaint
    expect(complaint.status).toBe('ANSWERED')
    expect(complaint.answer.sent).toMatchObject({ via: 'EMAIL', byId: senderId, version: 1, documentId: sent.document.id })
    const [mail] = await admin<Json>(`SELECT status::text AS status, "to", "recordType", "recordId" FROM "EmailOutbound" WHERE id = $1`, [sent.emailId])
    expect(mail).toMatchObject({ status: 'QUEUED', to: ['buyer.p1@example.com'], recordType: 'Complaint', recordId: A.complaint })
    const [doc] = await admin<Json>(`SELECT kind::text, "siteId", language FROM "GeneratedDocument" WHERE id = $1`, [sent.document.id])
    expect(doc).toEqual({ kind: 'COMPLAINT_ANSWER', siteId: null, language: 'it' })
    expect((await events('complaint.status_changed')).filter((payload) => payload.complaintId === A.complaint).map((payload) => payload.to)).toContain('ANSWERED')
    expect(paths(await refused('complaints', 'PUT', `${url}/answer`, { version: complaint.version, text: 'Changed' }, 409))).toEqual(['held/ANSWER_SENT'])
    ;({ complaint } = await ok('complaints', 'POST', `${url}/status`, { version: complaint.version, to: 'INVESTIGATING' }))
    expect(complaint.answer.sent).toBeNull()
    expect(complaint.answer.versions).toHaveLength(1)
    const [row] = await admin<Json>(`SELECT "answeredAt", "answerDocumentId", "answeredVia"::text AS via FROM "Complaint" WHERE id = $1`, [A.complaint])
    expect(row).toEqual({ answeredAt: null, answerDocumentId: null, via: null })
  })
})
