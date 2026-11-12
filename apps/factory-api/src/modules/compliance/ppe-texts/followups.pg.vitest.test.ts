import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPpeTexts } from '../../../../../../packages/factory-db/seed/ppe-texts'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedTechfiles } from '../../../../../../packages/factory-db/seed/techfiles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { useDeclarationsClock } from '../declarations/common'
import { labelLanguagesApproved } from './store'

/**
 * B-W2b-288 — the compliance follow-ups on B-W2b-275's columns, through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and the guards are real), the harness's local file
 * store behind a FAKE R2 account, on the technical files seed (shipping, quality, production, compliance rules and files:
 * SEED-JKT-02 of every company, revision 1 released, WO-0001's batch SEED-BT-0001 on SEED-SH-0001; markets IT, DE, FR, ES;
 * a released leather lot with its Cr VI PASS) and the PPE texts seed (company B's DoC approval in force; company A's user
 * information and SEED-LBL-JKT-02 approvals withdrawn). The owner signs in for real (two-factor, step-up) to record a yes.
 *
 *   FU2:01  a PPE consultant's yes recorded per template (with the file, a fresh code) and withdrawn with a reason; the DoC
 *           generator, the user information builder and the label class warnings read it
 *   FU2:02  the status board says "Not sold there" for a market the style is not sold in
 *   FU2:03  the lab's price typed with a lab result (money.cost), shown per lot, dropped without the cost grain
 *   FU2:04  a batch made while an older DoC was in force keeps that DoC when it ships late
 *
 * Every name, code and file is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/ppe-texts`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b288-followups'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }

const grant = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: readonly string[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions)] })
const LAB = ['quality.lots.view', 'quality.lots.test', 'files.upload', 'files.read']
const SESSIONS: Record<string, SessionContext> = {
  quality: office(['compliance.certificates.view', 'compliance.declarations.generate', 'compliance.declarations.manage', 'compliance.userInformation.generate', 'shipping.view', 'files.read', 'files.upload']),
  viewer: office(['compliance.certificates.view']),
  // Holds the permission but has no real session: it is always asked for a fresh code.
  keeper: office(['compliance.certificates.view', 'compliance.ppeTexts.manage', 'files.upload', 'files.read']),
  lab: office([...LAB, 'money.cost']),
  labNoCost: office(LAB),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async <Row = Json>(sql: string, values: unknown[]): Promise<Row> => (await admin<Row>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let serial = 0
const key = () => `fu288-${run}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const pdfBytes = (text: string) => Buffer.from(`%PDF-1.4\n% made-up file: ${text}\n%%EOF\n`)
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const put = async (upload: Json, body: Buffer) => {
  const sent = await app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
}

let owner: { browser: Browser; secret: string }
async function asOwner(url: string, body: unknown, status: number): Promise<Json> {
  const answer = await owner.browser.send('POST', url, body, { headers: { 'idempotency-key': key(), 'x-factory-company': companyA } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
/** The consultant's file, announced and sent (as a session, or as the owner). */
async function evidence(companyId: string | null, by: 'owner' | string = 'owner'): Promise<{ approvalId: string; fileId: string }> {
  const body = pdfBytes(`consultant check ${newId()}`)
  const payload = { companyId, originalName: 'consultant-check.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) }
  const announced = by === 'owner' ? await asOwner('/compliance/ppe-texts/evidence', payload, 201) : await ok(by, 'POST', '/compliance/ppe-texts/evidence', payload, 201)
  expect(announced.file).toMatchObject({ recordType: 'PpeTextApproval', recordId: announced.approvalId, kind: 'DOCUMENT', status: 'PENDING_UPLOAD', companyId })
  await put(announced.upload, body)
  return { approvalId: announced.approvalId, fileId: announced.file.id }
}
const CONSULTANT = 'Demo PPE consultant, Studio Demo Sicurezza (made-up)'

let jkt02 = ''
let jkt02Rev = ''
let wo1 = ''
let sh1 = ''
let lea09 = ''
let testedCode = ''
let otherCode = ''
let italianDoc: Json = {}
let englishDocId = ''
let docApproval: Json = {}

beforeAll(async () => {
  h = await startHarness('w2b288_followups')
  useDeclarationsClock(h.clock)
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedTechfiles({ db: h.database, namespace: NS })
  await seedPpeTexts({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  // The system roles as the templates hold them now (compliance.ppeTexts.manage: the owner's, from every()).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  const user = await addUser(h, TENANT, { email: `owner.288.${run}@example.test`, role: 'owner' })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if ((answer.body as Json)?.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  owner = { browser, secret: await enrolTotp(h, browser) }
  jkt02 = (await one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-02'])).id
  jkt02Rev = (await one<{ id: string }>('SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1', [jkt02])).id
  wo1 = (await one<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND "batchNumber" = 'SEED-BT-0001'`, [T])).id
  sh1 = (await one<{ id: string }>(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = 'SEED-SH-0001'`, [T])).id
  // A released leather lot with its Cr VI PASS (the seeds'), and another lot.
  const lots = await admin<{ id: string; code: string; requiresCrViTest: boolean; crViStatus: string }>(`SELECT id, code, "requiresCrViTest", "crViStatus"::text AS "crViStatus" FROM "Lot" WHERE "tenantId" = $1 ORDER BY code, id`, [T])
  const tested = lots.find((lot) => lot.requiresCrViTest && lot.crViStatus === 'PASS')!
  lea09 = tested.id
  testedCode = tested.code
  otherCode = lots.find((lot) => lot.id !== tested.id)!.code
}, 1_500_000)

afterAll(async () => {
  useDeclarationsClock(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('the PPE text approvals per template (FU2:01)', () => {
  it('lists the templates that generate PPE texts with their state, and every approval the reader reaches', async () => {
    const list = await ok('viewer', 'GET', '/compliance/ppe-texts')
    const byId = Object.fromEntries(list.templates.map((template: Json) => [`${template.templateKind}:${template.templateId}`, template]))
    expect(byId['DOC:annex-ix.1']).toMatchObject({ state: 'APPROVED', liveLanguages: ['en', 'it'], label: null })
    expect(byId['USER_INFORMATION:annex-ii-1.4.1']).toMatchObject({ state: 'WITHDRAWN', liveLanguages: [] })
    expect(byId['LABEL_WARNING:SEED-LBL-JKT-02.1']).toMatchObject({ state: 'WITHDRAWN', label: { code: 'SEED-LBL-JKT-02', revision: 1, companyId: null } })
    expect(byId['LABEL_WARNING:SEED-LBL-JKT-01.1']).toMatchObject({ state: 'NONE', approvals: 0 })
    // A glove or care label carries no class warning: not a template here.
    expect(Object.keys(byId).some((id) => id.includes('GLOVE') || id.includes('CARE'))).toBe(false)
    expect(list.approvals).toHaveLength(3)
    expect(list.approvals.find((row: Json) => row.templateKind === 'DOC')).toMatchObject({ companyId: companyB, live: true, mayWithdraw: false, evidence: { status: 'AVAILABLE' } })
    expect(list.mayRecord).toEqual({ company: false, everyCompany: false })
  })

  it('keeps a generated DoC of every company a draft while no approval of every company covers it', async () => {
    italianDoc = (await ok('quality', 'POST', '/compliance/declarations', { styleId: jkt02, languages: ['it', 'en'] }, 201)).declaration
    englishDocId = italianDoc.languages.find((entry: Json) => entry.language === 'en').id
    // Company B's yes covers company B's texts only.
    expect(italianDoc.gate).toMatchObject({ name: 'GATE-PPE-TEXTS', open: true, state: 'WAITING', approval: null, languages: [], withdrawn: false })
  })

  it('refuses a wrong template and a language twice in words before asking for a code; a viewer announces nothing', async () => {
    const { approvalId, fileId } = await evidence(null, 'keeper')
    const body = { approvalId, fileId, companyId: null, templateKind: 'DOC', templateKey: 'annex-ix', templateVersion: 2, languages: ['it'], checkedBy: CONSULTANT }
    expect(paths(await no('keeper', 'POST', '/compliance/ppe-texts', body, 400))).toEqual(['body/templateKey'])
    expect(paths(await no('keeper', 'POST', '/compliance/ppe-texts', { ...body, templateVersion: 1, languages: ['it', 'IT'] }, 400))).toEqual(['body/languages'])
    // A viewer may not even announce the file; a role over one company cannot record for every company.
    await no('viewer', 'POST', '/compliance/ppe-texts/evidence', { companyId: null, originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) }, 403)
    expect(await admin('SELECT id FROM "PpeTextApproval" WHERE id = $1', [approvalId])).toEqual([])
  })

  it('records the owner’s yes with a fresh code: the file kept ten years, the audit row, the event; the Italian DoC may leave draft', async () => {
    const { approvalId, fileId } = await evidence(null)
    const body = { approvalId, fileId, companyId: null, templateKind: 'DOC', templateKey: 'annex-ix', templateVersion: 1, languages: ['IT'], checkedBy: `  ${CONSULTANT}  ` }
    h.clock.advance(6 * 60_000)
    const asked = await owner.browser.send('POST', '/compliance/ppe-texts', body, { headers: { 'idempotency-key': key(), 'x-factory-company': companyA } })
    expect(asked.status, JSON.stringify(asked.body)).toBe(403)
    expect(JSON.stringify(asked.body)).toContain('stepUp')
    await stepUp(h, owner.browser, owner.secret)
    docApproval = (await asOwner('/compliance/ppe-texts', body, 201)).approval
    expect(docApproval).toMatchObject({ id: approvalId, companyId: null, templateId: 'annex-ix.1', languages: ['it'], checkedBy: CONSULTANT, live: true, recordedBy: { name: expect.any(String) }, evidence: { id: fileId, status: 'AVAILABLE' } })
    const file = await one<{ status: string; retainUntil: Date }>('SELECT status::text AS status, "retainUntil" FROM "StoredFile" WHERE id = $1', [fileId])
    expect(file.status).toBe('AVAILABLE')
    expect(file.retainUntil.getUTCFullYear()).toBeGreaterThanOrEqual(h.clock.now().getUTCFullYear() + 10)
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'compliance_ppe_texts.approval_changed' ORDER BY "occurredAt", id`, [T])
    expect(events.map((event) => event.payload)).toEqual([{ approvalId, companyId: null, templateKind: 'DOC', templateKey: 'annex-ix', templateVersion: 1, languages: ['it'], change: 'RECORDED' }])
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordType" = 'PpeTextApproval' AND "recordId" = $1`, [approvalId])).toEqual([{ action: 'compliance.ppeTexts.record' }])
    // The DoC generator reads it: the Italian draft may leave draft, the English one still waits.
    const italian = (await ok('viewer', 'GET', `/compliance/declarations/${italianDoc.id}`)).declaration
    expect(italian.gate).toMatchObject({ open: false, state: 'APPROVED', approval: { id: approvalId, checkedBy: CONSULTANT, languages: ['it'], companyId: null }, languages: ['it'] })
    const english = (await ok('viewer', 'GET', `/compliance/declarations/${englishDocId}`)).declaration
    expect(english.gate).toMatchObject({ open: true, state: 'WAITING', languages: ['it'], withdrawn: false })
    // The same approval again (another Idempotency-Key): refused in words.
    expect(paths((await asOwner('/compliance/ppe-texts', body, 409)).error)).toEqual(['refusal/RECORDED'])
  })

  it('the user information builder reads it too: a leaflet of every company waits for a yes of every company', async () => {
    const leaflet = (await ok('quality', 'POST', '/compliance/user-information', { styleId: jkt02, languages: ['it'] }, 201)).leaflet
    expect(leaflet).toMatchObject({ template: 'annex-ii-1.4.1', gate: { name: 'GATE-PPE-TEXTS', open: true, state: 'WAITING', approval: null, languages: [] } })
    // Company A's yes to the user information was withdrawn, and covers company A's texts only.
    expect(leaflet.gate.withdrawn).toBe(false)
    const again = (await ok('viewer', 'GET', `/compliance/user-information/${leaflet.id}`)).leaflet
    expect(again.gate).toMatchObject({ open: true, state: 'WAITING' })
  })

  it('the label class warnings read the languages approved for the label’s code and revision (office only)', async () => {
    const label = { code: 'SEED-LBL-JKT-02', revision: 1, companyId: null }
    const read = () => h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, (client) => labelLanguagesApproved(client, label))
    // Company A's yes was withdrawn (and covers company A's labels only): this label of every company waits.
    expect(await read()).toEqual([])
    const { approvalId, fileId } = await evidence(null)
    expect(paths((await asOwner('/compliance/ppe-texts', { approvalId, fileId, companyId: null, templateKind: 'LABEL_WARNING', templateKey: 'NO-SUCH-LABEL', templateVersion: 1, languages: ['it'], checkedBy: CONSULTANT }, 400)).error)).toEqual(['body/templateKey'])
    await asOwner('/compliance/ppe-texts', { approvalId, fileId, companyId: null, templateKind: 'LABEL_WARNING', templateKey: 'SEED-LBL-JKT-02', templateVersion: 1, languages: ['it', 'en'], checkedBy: CONSULTANT }, 201)
    expect(await read()).toEqual(['en', 'it'])
  })

  it('withdraws once with a reason: the DoC goes back to waiting and says the yes was withdrawn', async () => {
    expect(paths((await asOwner(`/compliance/ppe-texts/${docApproval.id}/withdraw`, { version: docApproval.version, reason: 'no' }, 400)).error)).toEqual(['body/reason'])
    const withdrawn = (await asOwner(`/compliance/ppe-texts/${docApproval.id}/withdraw`, { version: docApproval.version, reason: 'The consultant asked for a new wording of point 9 (made-up).' }, 200)).approval
    expect(withdrawn).toMatchObject({ live: false, withdrawReason: 'The consultant asked for a new wording of point 9 (made-up).', withdrawnBy: { name: expect.any(String) }, mayWithdraw: false })
    expect(paths((await asOwner(`/compliance/ppe-texts/${docApproval.id}/withdraw`, { version: withdrawn.version, reason: 'Again (made-up).' }, 409)).error)).toEqual(['refusal/WITHDRAWN'])
    const italian = (await ok('viewer', 'GET', `/compliance/declarations/${italianDoc.id}`)).declaration
    expect(italian.gate).toMatchObject({ open: true, state: 'WAITING', approval: null, withdrawn: true })
    const list = await ok('viewer', 'GET', '/compliance/ppe-texts?kind=DOC')
    expect(list.templates).toHaveLength(1)
    expect(list.approvals.map((row: Json) => [row.companyId, row.live])).toEqual(expect.arrayContaining([[null, false], [companyB, true]]))
  })
})

describe('Not sold there on the status board (FU2:02)', () => {
  it('asks a style only in the markets it is sold in; another market is "Not sold there", never a gap', async () => {
    await admin(`UPDATE "Style" SET "marketCodes" = '{IT}' WHERE id = $1`, [jkt02])
    const board = await ok('viewer', 'GET', '/compliance/status/board?q=SEED-JKT-02')
    const row = board.rows.find((entry: Json) => entry.style.id === jkt02)
    expect(row.style.marketCodes).toEqual(['IT'])
    const states = Object.fromEntries(row.cells.map((cell: Json) => [cell.marketCode, cell.state]))
    expect(states.IT).not.toBe('NOT_SOLD')
    for (const code of ['DE', 'FR', 'ES']) expect(states[code]).toBe('NOT_SOLD')
    expect(row.cells.find((cell: Json) => cell.marketCode === 'DE')).toMatchObject({ words: 'Not sold there', missing: 0, blocking: 0, first: null, blockedGates: [] })
    const actions = await ok('viewer', 'GET', '/compliance/status/actions?q=SEED-JKT-02')
    expect(actions.lines.filter((line: Json) => line.marketCode !== 'IT')).toEqual([])
    const cell = await ok('viewer', 'GET', `/compliance/status/cell?styleId=${jkt02}&market=DE`)
    expect(cell).toMatchObject({ standing: 'NOT_SOLD_THERE', style: { marketCodes: ['IT'] }, cell: { state: 'NOT_SOLD' }, items: [] })
    expect((await ok('viewer', 'GET', `/compliance/status/cell?styleId=${jkt02}&market=IT`)).standing).toBe('SOLD_THERE')
    // None named: every market is asked, as before.
    await admin(`UPDATE "Style" SET "marketCodes" = '{}' WHERE id = $1`, [jkt02])
    const every = (await ok('viewer', 'GET', '/compliance/status/board?q=SEED-JKT-02')).rows.find((entry: Json) => entry.style.id === jkt02)
    expect(every.cells.some((cell: Json) => cell.state === 'NOT_SOLD')).toBe(false)
    expect((await ok('viewer', 'GET', `/compliance/status/cell?styleId=${jkt02}&market=DE`)).standing).toBe('EVERY_MARKET')
  })
})

describe('the lab’s price of a result (FU2:03)', () => {
  async function report(): Promise<string> {
    const body = pdfBytes(`lab report ${newId()}`)
    const announced = await ok('lab', 'POST', `/quality/lots/${lea09}/results/report`, { originalName: 'lab-report.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) }, 201)
    await put(announced.upload, body)
    return announced.file.id
  }
  const version = async () => (await one<{ version: number }>('SELECT version FROM "Lot" WHERE id = $1', [lea09])).version
  const RESULT = { test: 'CR_VI', method: 'EN ISO 17075-1', lab: 'Demo Lab (made-up)', reportNumber: 'DL-288', evidence: 'LOT_REPORT', valueMgKg: '5.5' }

  it('refuses a price without the cost grain, and a currency that is not ISO 4217', async () => {
    const fileId = await report()
    const today = new Date().toISOString().slice(0, 10)
    const without = await call('labNoCost', 'POST', `/quality/lots/${lea09}/results`, { version: await version(), testedOn: today, ...RESULT, fileId, cost: { cents: 8500, currency: 'EUR' } })
    expect(without.statusCode, without.body).toBe(403)
    expect(paths(await no('lab', 'POST', `/quality/lots/${lea09}/results`, { version: await version(), testedOn: today, ...RESULT, fileId, cost: { cents: 8500, currency: 'eu' } }, 400))).toEqual(['body/cost/currency'])
  })

  it('types the lab’s price with a later FAIL; reads it back per result and per lot for the cost grain only', async () => {
    const fileId = await report()
    const today = new Date().toISOString().slice(0, 10)
    const recorded = await ok('lab', 'POST', `/quality/lots/${lea09}/results`, { version: await version(), testedOn: today, ...RESULT, fileId, cost: { cents: 8500, currency: 'EUR' } }, 201)
    expect(recorded.result).toMatchObject({ verdict: 'FAIL', cost: { cents: 8500, currency: 'EUR' } })
    const row = await one<{ costAmount: number; costCurrency: string }>('SELECT "costAmount", "costCurrency" FROM "LabResult" WHERE id = $1', [recorded.result.id])
    expect(row).toEqual({ costAmount: 8500, costCurrency: 'EUR' })
    const audit = await one<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'LabResult' AND "recordId" = $1`, [recorded.result.id])
    expect(audit.after.cost).toEqual({ $money: 'cost', value: { cents: 8500, currency: 'EUR' } })
    const withCost = (await ok('lab', 'GET', `/quality/lots/${lea09}`)).results.find((result: Json) => result.id === recorded.result.id)
    expect(withCost.cost).toEqual({ cents: 8500, currency: 'EUR' })
    const without = (await ok('labNoCost', 'GET', `/quality/lots/${lea09}`)).results.find((result: Json) => result.id === recorded.result.id)
    expect(without).not.toHaveProperty('cost')
    const listed = (await ok('lab', 'GET', `/quality/lots?q=${testedCode}`)).lots[0]
    expect(listed.labCost).toEqual([{ currency: 'EUR', cents: 8500, results: 1 }])
    const listedWithout = (await ok('labNoCost', 'GET', `/quality/lots?q=${testedCode}`)).lots[0]
    expect(listedWithout).not.toHaveProperty('labCost')
    expect((await ok('lab', 'GET', `/quality/lots?q=${otherCode}`)).lots.find((lot: Json) => lot.code === otherCode).labCost).toEqual([])
  })
})

describe('a late batch of an older DoC (FU2:04)', () => {
  it('records a batch made while a superseded DoC was in force with that DoC, also when it ships late; refuses a batch made after', async () => {
    // W1's signed Italian DoC of revision 1 (announce, store, confirm), then superseded (a newer declaration replaced it).
    const body = pdfBytes('signed DoC r1')
    const announced = await ok('quality', 'POST', `/product/styles/${jkt02}/compliance/documents`, { revisionId: jkt02Rev, kind: 'DECLARATION_OF_CONFORMITY', language: 'it', originalName: 'doc-it.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) }, 201)
    await put(announced.upload, body)
    await ok('quality', 'POST', `/product/styles/${jkt02}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
    const documentId = announced.document.id
    await admin(`UPDATE "ComplianceDocument" SET status = 'SUPERSEDED', version = version + 1 WHERE id = $1`, [documentId])
    // WO-0001 made revision 1: its batch keeps the superseded DoC.
    const made = (await ok('quality', 'POST', '/compliance/declarations/batches', { documentId, workOrderId: wo1 }, 201)).record
    expect(made).toMatchObject({ batchNumber: 'SEED-BT-0001', document: { id: documentId, status: 'SUPERSEDED' }, shipment: null })
    // A batch typed now has no trace of being made while it was in force.
    expect(paths(await no('quality', 'POST', '/compliance/declarations/batches', { documentId, batchNumber: 'DEMO-LATE-1', companyId: companyA }, 409))).toEqual(['refusal/NOT_IN_FORCE'])
    // What travelled with the late shipment of that batch is recorded with it.
    const travelled = await ok('quality', 'POST', `/compliance/declarations/shipments/${sh1}/versions`)
    expect(travelled.recorded.map((record: Json) => [record.document.id, record.batchNumber, record.shipment?.id])).toContainEqual([documentId, 'SEED-BT-0001', sh1])
    expect(travelled.skipped.filter((entry: Json) => entry.documentId === documentId)).toEqual([])
  })
})
