import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { useScanner } from '../../../platform/files/scan/service'
import { qualificationsFor } from './qualifications'

/**
 * The document vault, the compliance gate on a PO and supplier qualification (B-W2b-315; SCM-020, SCM-022, SCM-027) on the
 * local stack: a throwaway PostgreSQL 17 database from the migrations (row-level security, the approvals history guard and
 * B-W2b-287's qualification guard are real), the real app with office people signed in with two-factor (step-up), the
 * factory-db seeds up to production (company A's supplier and subcontractor P2 with its leather, which needs a chromium VI
 * test, and its protector, a PPE component), FAKE file store and mail. Every name, number and document is made up. Run
 * with `node scripts/factory/run-pg-tests.mjs modules/purchasing/qualification`.
 */

let h: Harness
const NS = 'qualify-315'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const leather = seedId('product:item:leather')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const protector = seedId('product:item:protector')
const FAKE_VAT = '12345670009'
const people: Record<string, { browser: Browser; secret: string; id: string }> = {}

type Json = Record<string, any>
const sql = async <T = Json>(text: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(text, values)).rows as T[]
let counter = 0
const key = () => `qual315-${++counter}-${newId()}`
async function call(name: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) {
  const answer = await people[name]!.browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  return { status: answer.status, body: answer.body as Json }
}
async function as(name: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(name, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const paths = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => issue.path)
const codes = (checks: Json[]): string[] => checks.map((check) => check.code).filter((code: string) => code.startsWith('COMPLIANCE_'))
const today = () => businessDate(h.clock.now())
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')

/** A draft PO of P2 with one line of the material. */
async function draft(itemId: string, needDays = 30, extra: Json = {}): Promise<Json> {
  const order = (await as('buyer', 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2, incoterms: 'EXW Seedville' }, 201)).order
  return (await as('buyer', 'POST', `/purchasing/orders/${order.id}/lines`, { version: order.version, itemId, quantity: '105', needDate: addDays(today(), needDays), ...extra }, 201)).order
}

/** A document of P2 in the vault: uploaded on the Party, then tagged with its category and last valid day. */
async function partyDocument(category: string, expiresOn: string | null, name: string): Promise<string> {
  const body = Buffer.from(`%PDF-1.7 made-up ${name}`)
  const { file, upload } = await as('buyer', 'POST', '/files', { companyId: companyA, recordType: 'Party', recordId: P2, kind: 'CERTIFICATE', originalName: `${name}.pdf`, contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body) }, 201)
  expect((await h.app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })).statusCode).toBe(200)
  await as('buyer', 'POST', `/files/${file.id}/complete`)
  const version = (await sql<{ version: number }>('SELECT version FROM "StoredFile" WHERE id = $1', [file.id]))[0]!.version
  await as('buyer', 'PUT', `/files/${file.id}/document`, { category, expiresOn, version })
  return file.id
}

beforeAll(async () => {
  h = await startHarness('qualify_315')
  // The guards refuse a time more than 5 minutes ahead of the database: the app's clock starts behind it.
  h.clock.set(new Date(Date.now() - 15 * 60_000))
  useScanner(null)
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await sql(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await sql(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await sql(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  await sql(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  for (const [name, role] of [['buyer', 'buyer'], ['quality', 'quality_inspector'], ['owner', 'owner']] as const) {
    const user = await addUser(h, seedTenant, { email: `${name}.315@seed-a.example.com`, role })
    const browser = new Browser(h.app)
    expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
    people[name] = { browser, secret: await enrolTotp(h, browser), id: user.id }
  }
}, 300_000)

afterAll(async () => {
  useScanner(undefined)
  await h?.close()
}, 60_000)

describe('the compliance gate on a PO (SCM-022)', () => {
  let order: Json

  it('asks by the supplier’s kinds: not set, a leather goes as before and the gate says it could not check it', async () => {
    const plain = await draft(leather, 30, { itemColourId: leatherBLK, uom: 'FT2' })
    expect(codes((await as('buyer', 'GET', `/purchasing/orders/${plain.id}/send-check`)).checks)).toEqual([])
    expect((await as('buyer', 'GET', `/purchasing/orders/${plain.id}/compliance`)).notChecked).toEqual([expect.stringMatching(/is not set as a tannery: the chromium VI test report of line 1 \(SEED-LEA-100\) is not checked at Send/)])
    const profile = (await as('buyer', 'GET', `/purchasing/suppliers/${P2}/profile`)).supplier
    await as('buyer', 'PATCH', `/purchasing/suppliers/${P2}/profile`, { version: profile.version, kinds: ['TANNERY', 'PROTECTOR_MAKER', 'SUBCONTRACTOR'] })
  })

  it('holds the send of a tannery’s leather it has no chromium VI test report in force for, line by line', async () => {
    order = await draft(leather, 30, { itemColourId: leatherBLK, uom: 'FT2' })
    const check = await as('buyer', 'GET', `/purchasing/orders/${order.id}/send-check`)
    expect(check.ready).toBe(false)
    expect(codes(check.checks)).toEqual(['COMPLIANCE_DOCUMENT_MISSING'])
    const refused = await call('buyer', 'POST', `/purchasing/orders/${order.id}/send`, { version: order.version })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/Chromium VI test report: .* has none in force; line 1 \(SEED-LEA-100\) needs one to be sent \(REACH Annex XVII entry 47\)/)
    const gate = await as('buyer', 'GET', `/purchasing/orders/${order.id}/compliance`)
    expect(gate).toMatchObject({ ready: false, overridden: false, request: null, may: { ask: true, decide: false } })
    expect(gate.lines).toMatchObject([{ seq: 1, held: true, kinds: ['CR_VI_TEST_REPORT'] }])
  })

  it('goes without the document only on a second person’s yes (step-up), never the asker’s', async () => {
    expect((await call('buyer', 'POST', `/purchasing/orders/${order.id}/compliance-override`, { version: order.version, reason: 'no' })).status).toBe(400)
    const asked = await as('buyer', 'POST', `/purchasing/orders/${order.id}/compliance-override`, { version: order.version, reason: 'The renewed report comes next week; the lot is tested at receipt as always.' })
    expect(asked.request).toMatchObject({ state: 'WAITING', askedBy: { id: people.buyer!.id, me: true }, current: true })
    expect(codes(asked.checks)).toEqual(['COMPLIANCE_DOCUMENT_MISSING', 'COMPLIANCE_OVERRIDE_WAITING'])
    expect((await call('buyer', 'POST', `/purchasing/orders/${order.id}/compliance-override`, { version: order.version, reason: 'Again, please.' })).status).toBe(409)
    // The buyer holds no override permission; the quality inspector does, and finds the request on its list.
    expect((await call('buyer', 'POST', `/purchasing/orders/${order.id}/compliance-override/decide`, { decision: 'APPROVED' })).status).toBe(403)
    const list = await as('quality', 'GET', '/purchasing/compliance-overrides')
    expect(list.requests.find((entry: Json) => entry.order.id === order.id)).toMatchObject({ mayDecide: true, held: [expect.stringMatching(/Chromium VI/)] })
    expect(paths((await call('quality', 'POST', `/purchasing/orders/${order.id}/compliance-override/decide`, { decision: 'APPROVED' })).body)).toEqual(['stepUp'])
    await stepUp(h, people.quality!.browser, people.quality!.secret)
    const decided = await as('quality', 'POST', `/purchasing/orders/${order.id}/compliance-override/decide`, { decision: 'APPROVED', words: 'Yes: the lot is held at receipt until its test passes.' })
    expect(decided).toMatchObject({ ready: true, overridden: true, request: { state: 'APPROVED', decidedBy: { id: people.quality!.id } } })
    const check = await as('buyer', 'GET', `/purchasing/orders/${order.id}/send-check`)
    expect(codes(check.checks)).toEqual(['COMPLIANCE_OVERRIDDEN'])
    const sent = await as('buyer', 'POST', `/purchasing/orders/${order.id}/send`, { version: order.version })
    expect(sent.order.status).toBe('SENT')
    const history = await as('buyer', 'GET', `/approvals/history/PurchaseOrder/${order.id}`)
    expect(JSON.stringify(history)).toMatch(/REQUESTED/)
    expect(JSON.stringify(history)).toMatch(/APPROVED/)
  })

  it('never lets the person who asked say yes, the Owner included (the API and the database)', async () => {
    const second = await draft(leather, 30, { itemColourId: leatherBLK, uom: 'FT2' })
    await as('owner', 'POST', `/purchasing/orders/${second.id}/compliance-override`, { version: second.version, reason: 'Owner asks to send it without the report.' })
    await stepUp(h, people.owner!.browser, people.owner!.secret)
    const own = await call('owner', 'POST', `/purchasing/orders/${second.id}/compliance-override/decide`, { decision: 'APPROVED' })
    expect(own.status).toBe(403)
    expect(paths(own.body)).toEqual(['refusal/OWN_REQUEST'])
    // The database refuses it too, whoever writes the line.
    const asked = (await sql<{ byId: string }>(`SELECT "byId" FROM "ApprovalEvent" WHERE "recordId" = $1 AND action = 'REQUESTED'`, [second.id]))[0]!
    await expect(
      h.database.withScope({ audience: 'office', tenantId: tenant, actorId: asked.byId }, (client) =>
        client.approvalEvent.create({ data: { id: newId(), companyId: companyA, taskId: null, recordType: 'PurchaseOrder', recordId: second.id, action: 'APPROVED', byId: asked.byId, at: new Date(), createdById: asked.byId }, select: { id: true } }),
      ),
    ).rejects.toThrow(/nobody approves their own request/)
    // A no needs words; the one who asked takes the request back.
    expect(paths((await call('quality', 'POST', `/purchasing/orders/${second.id}/compliance-override/decide`, { decision: 'REJECTED' })).body)).toEqual(['body/words'])
    const back = await as('owner', 'POST', `/purchasing/orders/${second.id}/compliance-override/withdraw`)
    expect(back.request).toMatchObject({ state: 'WITHDRAWN' })
    expect(back.ready).toBe(false)
  })

  it('passes a leather with a test report in force, warns when it lapses before the need date, holds a protector without a certificate', async () => {
    const report = await partyDocument('TEST_REPORT', addDays(today(), 45), 'Chromium VI test report SEED-LEA-100')
    const ok = await draft(leather, 30, { itemColourId: leatherBLK, uom: 'FT2' })
    expect(codes((await as('buyer', 'GET', `/purchasing/orders/${ok.id}/send-check`)).checks)).toEqual([])
    const late = await draft(leather, 90, { itemColourId: leatherBLK, uom: 'FT2' })
    const lateCheck = await as('buyer', 'GET', `/purchasing/orders/${late.id}/send-check`)
    expect(codes(lateCheck.checks)).toEqual(['COMPLIANCE_EXPIRES_BEFORE_NEED'])
    const ppe = await draft(protector, 30)
    const ppeCheck = await as('buyer', 'GET', `/purchasing/orders/${ppe.id}/send-check`)
    expect(codes(ppeCheck.checks)).toEqual(['COMPLIANCE_CERTIFICATE_MISSING'])
    expect(ppeCheck.checks.find((check: Json) => check.code === 'COMPLIANCE_CERTIFICATE_MISSING').message).toMatch(/No valid certificate in the register covers SEED-PRO-300/)
    expect(report).toBeTruthy()
  })

  it('holds a send that a company rule before SENT blocks (Admin › Documents › Required documents)', async () => {
    const rule = (await as('buyer', 'POST', '/files/required-rules', { companyId: companyA, recordType: 'PurchaseOrder', category: 'DECLARATION', beforeStatus: 'SENT', partyRole: 'SUPPLIER', level: 'BLOCK' }, 201)).rule
    const blocked = await draft(leather, 30, { itemColourId: leatherBLK, uom: 'FT2' })
    expect(codes((await as('buyer', 'GET', `/purchasing/orders/${blocked.id}/send-check`)).checks)).toEqual(['COMPLIANCE_RULE_MISSING'])
    await as('buyer', 'PATCH', `/files/required-rules/${rule.id}`, { active: false, version: rule.version })
    expect(codes((await as('buyer', 'GET', `/purchasing/orders/${blocked.id}/send-check`)).checks)).toEqual([])
  })
})

describe('the vault and qualification (SCM-020, SCM-027, VN2:01, VN2:02)', () => {
  it('says what we ask of a tannery and workshop, what is in force, what it unlocks, and what waits for our check', async () => {
    const vault = await as('buyer', 'GET', `/purchasing/suppliers/${P2}/documents`)
    expect(vault.asked.map((entry: Json) => [entry.category, entry.required, entry.state])).toEqual([
      ['SUPPLIER_CERTIFICATE', true, 'MISSING'],
      ['TEST_REPORT', true, 'MET'],
      ['DECLARATION', true, 'MISSING'],
    ])
    expect(vault.asked.find((entry: Json) => entry.category === 'TEST_REPORT').unlocks).toBe('POs for SEED-LEA-100 need a valid chromium VI test report in force to be sent.')
    expect(vault.materials.map((entry: Json) => [entry.code, entry.needs, entry.state, entry.checkedAtSend, entry.heldAtSend])).toEqual([
      ['SEED-LEA-100', 'CR_VI_TEST_REPORT', 'MET', true, false],
      ['SEED-PRO-300', 'PPE_CERTIFICATE', 'MISSING', true, true],
    ])
    expect(vault.gateSentences).toEqual(['POs for SEED-PRO-300 need a valid certificate in the register in force to be sent.'])
    expect(vault.documents).toMatchObject([{ category: 'TEST_REPORT', state: 'VALID', source: 'OFFICE' }])
    expect(vault.nextStep).toBe('2 documents we ask for are missing or expired.')
    expect(vault.may).toMatchObject({ review: true, decideChanges: true, upload: true, qualify: true })
    const summary = await as('buyer', 'GET', `/purchasing/suppliers/documents-summary?companyId=${companyA}`)
    expect(summary.suppliers.find((entry: Json) => entry.partyId === P2)).toMatchObject({ valid: 1, expiring: 0, expired: 0, missing: 2 })
  })

  it('qualifies a workshop for sewing on its evidence, decided once; planning reads it; suspended, lifted, withdrawn', async () => {
    const made = await as('buyer', 'POST', `/purchasing/suppliers/${P2}/qualifications`, { companyId: companyA, workCentreKinds: ['SEWING'] }, 201)
    let row = made.qualifications.find((entry: Json) => entry.id === made.qualificationId)
    expect(row).toMatchObject({ status: 'PENDING', evidence: [], standing: { standing: 'PENDING' }, may: { decide: true } })
    // No evidence, no yes.
    expect(paths((await call('buyer', 'POST', `/purchasing/suppliers/${P2}/qualifications/${row.id}/decide`, { version: row.version, decision: 'APPROVED' })).body)).toEqual(['body/evidence'])
    const fileId = made.suggestions.files[0].recordId
    row = (await as('buyer', 'PATCH', `/purchasing/suppliers/${P2}/qualifications/${row.id}`, { version: row.version, evidence: [{ recordType: 'StoredFile', recordId: fileId }] })).qualifications.find((entry: Json) => entry.id === row.id)
    const decided = await as('quality', 'POST', `/purchasing/suppliers/${P2}/qualifications/${row.id}/decide`, { version: row.version, decision: 'APPROVED' })
    row = decided.qualifications.find((entry: Json) => entry.id === row.id)
    expect(row).toMatchObject({ status: 'APPROVED', validFrom: today(), decided: { by: { id: people.quality!.id } }, standing: { standing: 'QUALIFIED' } })
    expect(decided.work.find((entry: Json) => entry.workCentreKind === 'SEWING')).toMatchObject({ qualified: true })
    expect(decided.work.find((entry: Json) => entry.workCentreKind === 'CUTTING')).toMatchObject({ qualified: false, standing: 'NONE' })
    expect((await call('quality', 'POST', `/purchasing/suppliers/${P2}/qualifications/${row.id}/decide`, { version: row.version, decision: 'REFUSED', refuseReason: 'x' })).status).toBe(409)
    const planning = await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: people.quality!.id }, (client) => qualificationsFor(client, { companyId: companyA, partyIds: [P2], need: { workCentreKind: 'SEWING' }, today: today() }))
    expect(planning.get(P2)).toMatchObject({ qualified: true, standing: 'QUALIFIED' })
    row = (await as('quality', 'POST', `/purchasing/suppliers/${P2}/qualifications/${row.id}/suspend`, { version: row.version, reason: 'The DURC expired.' })).qualifications.find((entry: Json) => entry.id === row.id)
    expect(row.standing).toEqual({ standing: 'SUSPENDED', words: 'Suspended: The DURC expired.' })
    row = (await as('quality', 'POST', `/purchasing/suppliers/${P2}/qualifications/${row.id}/lift`, { version: row.version })).qualifications.find((entry: Json) => entry.id === row.id)
    expect(row.status).toBe('APPROVED')
    row = (await as('quality', 'POST', `/purchasing/suppliers/${P2}/qualifications/${row.id}/withdraw`, { version: row.version, reason: 'No more sewing out.' })).qualifications.find((entry: Json) => entry.id === row.id)
    expect(row).toMatchObject({ status: 'WITHDRAWN', withdrawn: { reason: 'No more sewing out.' }, may: { withdraw: false } })
  })

  it('is not in order once a document it rests on has expired', async () => {
    const expired = await partyDocument('SUPPLIER_CERTIFICATE', addDays(today(), -3), 'DURC made-up')
    const made = await as('buyer', 'POST', `/purchasing/suppliers/${P2}/qualifications`, { companyId: companyA, materialKinds: ['LEATHER'], evidence: [{ recordType: 'StoredFile', recordId: expired }] }, 201)
    let row = made.qualifications.find((entry: Json) => entry.id === made.qualificationId)
    row = (await as('buyer', 'POST', `/purchasing/suppliers/${P2}/qualifications/${row.id}/decide`, { version: row.version, decision: 'CONDITIONAL', conditions: 'A visit before the next season.' })).qualifications.find((entry: Json) => entry.id === row.id)
    expect(row).toMatchObject({ status: 'CONDITIONAL', standing: { standing: 'EVIDENCE_EXPIRED' }, evidence: [{ recordType: 'StoredFile', documents: [{ fileId: expired, expired: true }] }] })
    const scoped = await call('buyer', 'POST', `/purchasing/suppliers/${P2}/qualifications`, { companyId: companyA, materialKinds: ['LEATHER'], evidence: [{ recordType: 'SupplierDocumentUpload', recordId: newId() }] })
    expect(paths(scoped.body)).toEqual(['body/evidence'])
  })
})
