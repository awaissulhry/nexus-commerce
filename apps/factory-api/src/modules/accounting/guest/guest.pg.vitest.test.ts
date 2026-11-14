import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// B-W2b-F45: the year an export is numbered in.
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAccounting } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * Accountant access on the local stack (B-W2b-201; FIN-158, PLT-022; design portal.guest.accountant, SCR-268, and its
 * office half on Finance › Close), through the real app: a real office sign-in with two-factor and step-up, a real portal
 * sign-in by e-mail code. Tenant A from the factory-db seeds up to accounting (September 2026 exported as EXP-2026-0001
 * with three empty journals and HARD-locked; FT-2026-00001 of 28 October and the deposit FT-2026-00003 of 29 October,
 * XML only; the supplier invoice 2026/0412 received on 13 November; October's export a DRAFT). Made up here: an adviser
 * firm (the CONSULTANT role) of company A, its accountants, one customer buyer, the bytes of FT-2026-00001's XML.
 *
 *   - finance gives access (step-up; the firm's portal switched on, the invitation mailed, finance follows the firm);
 *   - the accountant signs in: September handed over, October not yet (PERIOD_NOT_SHARED);
 *   - finance exports October: the accountant sees its journals, both sales e-invoices and the Intrastat file, no amount;
 *   - a download and two zips, each in the audit log; refused: another period's file, a file of no period, a period not
 *     handed over, another party's person, the accountant on another portal page;
 *   - the end of access moved, then ended now (sessions end); an access that ends by its date ends by itself.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/accounting/guest`.
 */

type Json = Record<string, any>
let h: Harness
let world: PortalWorld
let finance: Browser
let financeSecret: string
let viewer: Browser
const NS = 'accounting-guest-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
const firmId = newId()
const people = { accountant: 'anna.conti@studio-prova.example', second: 'bruno.conti@studio-prova.example', buyer: 'bianca@brand-alpha.example' }
let accountantId = ''
let accountant: Browser

const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const office = <R>(work: (client: any) => Promise<R>): Promise<R> => h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, work)
const MONEY = /cost|margin|price|amount|total|wage|vat|net/i
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])
const inAYear = () => new Date(h.clock.now().getTime() + 30 * 86_400_000).toISOString()
// B-W2b-F45: October's batch number, read from the seed's numbered batches when finance exports it.
let octoberNumber = ''

async function asFinance(method: 'POST' | 'PATCH', url: string, body: Json): Promise<{ status: number; body: any }> {
  await stepUp(h, finance, financeSecret)
  return finance.send(method as 'POST', url, body)
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

const ok = async (answer: Promise<{ status: number; body: any }>, status = 200): Promise<any> => {
  const done = await answer
  expect(done.status, JSON.stringify(done.body)).toBe(status)
  return done.body
}
const problem = async (answer: Promise<{ status: number; body: any }>, status: number): Promise<string[]> => {
  const done = await answer
  expect(done.status, JSON.stringify(done.body)).toBe(status)
  return (done.body?.error?.issues ?? []).map((issue: Json) => issue.path)
}

/** The entries of a zip (local headers in order), inflated. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let at = 0
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const method = bytes.readUInt16LE(at + 8)
    const packed = bytes.readUInt32LE(at + 18)
    const nameLength = bytes.readUInt16LE(at + 26)
    const extra = bytes.readUInt16LE(at + 28)
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8')
    const data = bytes.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + packed)
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))
    at += 30 + nameLength + extra + packed
  }
  return out
}

beforeAll(async () => {
  h = await startHarness('accounting_guest')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedAccounting({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-guest', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.party.create({ data: { id: firmId, companyId: companyA, code: 'STUDIO-PROVA', kind: 'ORGANISATION', legalName: 'Studio Prova Commercialisti (made up)', tradeName: 'Studio Prova', roles: ['CONSULTANT'] }, select: { id: true } })
  })
  // The company's portal terms and a made-up customer (Brand Alpha) with its portal on.
  world = await portalWorld(h, TENANT)
  const financeUser = await addUser(h, TENANT, { email: 'fiona.finance@example.com', role: 'finance' })
  await admin(`UPDATE "User" SET "displayName" = 'Fiona Neri' WHERE id = $1`, [financeUser.id])
  finance = new Browser(h.app)
  await finance.signIn(NS, financeUser.email, financeUser.password)
  financeSecret = await enrolTotp(h, finance)
  const viewerUser = await addUser(h, TENANT, { email: 'rita.reader@example.com', role: 'read_only' })
  viewer = new Browser(h.app)
  await viewer.signIn(NS, viewerUser.email, viewerUser.password)
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
}, 60_000)

describe('finance gives the accountant access (FIN-158, PLT-022)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists the firm with nobody yet; refuses without step-up, without the permission, without an end, for a non-adviser', async () => {
    const before = await ok(finance.get(`/accounting/accountants?companyId=${companyA}`))
    expect(before.firms.map((firm: Json) => [firm.party.name, firm.portalOn, firm.people.length])).toContainEqual(['Studio Prova', false, 0])
    expect(before.may.manage).toBe(true)
    expect(before.downloads).toEqual([])
    const body = { companyId: companyA, partyId: firmId, email: people.accountant, displayName: 'Anna Conti', locale: 'it', accessUntil: inAYear() }
    h.clock.advance(6 * 60_000)
    expect((await finance.post('/accounting/accountants', body)).status).toBe(403)
    expect((await viewer.post('/accounting/accountants', body)).status).toBe(403)
    expect((await ok(viewer.get(`/accounting/accountants?companyId=${companyA}`))).may.manage).toBe(false)
    const { accessUntil: _end, ...noEnd } = body
    expect((await asFinance('POST', '/accounting/accountants', noEnd)).status).toBe(400)
    expect(await problem(asFinance('POST', '/accounting/accountants', { ...body, partyId: world.partyId }), 409)).toEqual(['partyId'])
  })

  it('switches the firm’s portal on, invites the accountant, mails the sign-in page, and follows the firm', async () => {
    const answer = await ok(asFinance('POST', '/accounting/accountants', { companyId: companyA, partyId: firmId, email: people.accountant, displayName: 'Anna Conti', locale: 'it', accessUntil: inAYear() }), 201)
    expect(answer).toMatchObject({ delivery: 'sent', portalSwitchedOn: true, invitation: { email: people.accountant } })
    accountantId = answer.invitation.userId
    const mails = h.ses.mails.filter((mail) => mail.templateKey === 'auth.portal_invitation' && mail.to[0] === people.accountant)
    expect(mails).toHaveLength(1)
    const [settings] = await admin(`SELECT "portalOn" FROM "PortalSettings" WHERE id = $1`, [firmId])
    expect(settings).toEqual({ portalOn: true })
    const [user] = await admin(`SELECT "partnerKind", status, "accessUntil" IS NOT NULL AS "ends" FROM "User" WHERE id = $1`, [accountantId])
    expect(user).toEqual({ partnerKind: 'GUEST', status: 'INVITED', ends: true })
    expect((await admin(`SELECT count(*)::int AS n FROM "RecordFollower" WHERE "recordType" = 'Party' AND "recordId" = $1`, [firmId]))[0]!.n).toBe(1)
    expect((await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'partner_user.invited' AND subject = $1`, [accountantId]))[0]!.n).toBe(1)
    const listed = await ok(finance.get(`/accounting/accountants?companyId=${companyA}`))
    const firm = listed.firms.find((entry: Json) => entry.party.id === firmId)
    expect(firm).toMatchObject({ portalOn: true, people: [{ displayName: 'Anna Conti', status: 'INVITED', endsSoon: false }] })
  })
})

describe('the accountant’s room (SCR-268)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('signs in and sees September handed over; October is not yet', async () => {
    accountant = await signedIn(people.accountant)
    const overview = await ok(accountant.get('/portal/accounting'))
    expect(overview.access).toMatchObject({ firm: { id: firmId, name: 'Studio Prova' }, company: { id: companyA, code: 'SCA' }, givenBy: 'Fiona Neri', preview: false, endsSoon: false })
    expect(overview.access.accessUntil).not.toBeNull()
    expect(overview.months).toEqual([{ month: '2026-09', lock: { level: 'HARD', lockedAt: expect.any(String) }, batches: 1 }])
    expect(overview.choices).toEqual({ months: ['2026-09'], quarters: ['2026-Q3'], years: ['2026'] })
    expect(overview.latest).toBe('2026-09')
    expect(await problem(accountant.get('/portal/accounting/periods/2026-10'), 409)).toEqual(['problem/PERIOD_NOT_SHARED'])
    expect((await accountant.get('/portal/accounting/periods/2026-13')).status).toBe(400)
    const september = await ok(accountant.get('/portal/accounting/periods/2026-09'))
    expect(september.exports.map((batch: Json) => [batch.number, batch.amendedBy, batch.files.map((file: Json) => file.package)])).toEqual([['EXP-2026-0001', null, ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS']]])
    expect(september.invoices).toEqual([])
    // B-W2b-426: the VAT registers are made (an export carries them): nothing is said to come later.
    expect(september.later).toBeUndefined()
  })

  it('reads October once finance exported it: journals, both sales e-invoices, the Intrastat file — files only, no amount', async () => {
    const month = await ok(finance.get(`/accounting/periods/2026-10?companyId=${companyA}`))
    const packages = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT']
    const explanations = (month.checks as Json[]).filter((check) => !check.passed).map((check) => ({ code: check.code, explanation: 'Made-up explanation for the test.' }))
    // B-W2b-F45: the batch takes the next number of the company's ACCOUNTING_EXPORT series in the year it is made (yearly):
    // after the seed's EXP-2026-0001, EXP-2026-0002 in 2026 and EXP-2027-0001 in 2027 — read from the batches numbered so far.
    const year = businessDate(new Date()).slice(0, 4)
    const [numbered] = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AccountingExport" WHERE "companyId" = $1 AND number LIKE $2`, [companyA, `EXP-${year}-%`])
    octoberNumber = `EXP-${year}-${String(numbered!.n + 1).padStart(4, '0')}`
    expect(month.nextNumber).toBe(octoberNumber)
    // B-W2b-F45 end
    const exported = await ok(finance.post('/accounting/exports', { companyId: companyA, month: '2026-10', packages, explanations }), 201)
    expect(exported.export.number).toBe(octoberNumber)

    const overview = await ok(accountant.get('/portal/accounting'))
    expect(overview.months.map((entry: Json) => entry.month)).toEqual(['2026-10', '2026-09'])
    expect(overview.latest).toBe('2026-10')
    const october = await ok(accountant.get('/portal/accounting/periods/2026-10'))
    expect(october.period).toMatchObject({ key: '2026-10', kind: 'MONTH', months: [{ month: '2026-10', shared: true, lock: null }] })
    // B-W2b-F45: October's number, read above.
    expect(october.exports.map((batch: Json) => [batch.number, batch.files.map((file: Json) => file.package)])).toEqual([[octoberNumber, ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS']]])
    expect(october.registers.map((row: Json) => [row.package, row.exportNumber, row.current])).toEqual([['INTRASTAT', octoberNumber, true]])
    expect(october.invoices.map((row: Json) => [row.side, row.kind, row.number, row.state, row.xml !== null, row.pdf])).toEqual([
      ['SALES', 'INVOICE', 'FT-2026-00001', 'DELIVERED', true, null],
      ['SALES', 'DEPOSIT', 'FT-2026-00003', 'DELIVERED', true, null],
    ])
    expect(keysOf(october).filter((name) => MONEY.test(name))).toEqual([])
    // Files only: every listed file is a batch's, an invoice's or a supplier invoice's — never another record's.
    const ids = [...october.exports.flatMap((batch: Json) => batch.files.map((file: Json) => file.file.id)), ...october.registers.map((row: Json) => row.file.id), ...october.invoices.flatMap((row: Json) => [row.xml?.id, row.pdf?.id].filter(Boolean))]
    const types = await admin<{ recordType: string }>(`SELECT DISTINCT "recordType" FROM "StoredFile" WHERE id = ANY($1::uuid[])`, [ids])
    expect(types.map((row) => row.recordType).sort()).toEqual(['AccountingExport', 'Invoice'])
    // A quarter covers its handed-over months only, and names the others.
    const q4 = await ok(accountant.get('/portal/accounting/periods/2026-Q4'))
    expect(q4.period.months.map((entry: Json) => [entry.month, entry.shared])).toEqual([['2026-10', true], ['2026-11', false], ['2026-12', false]])
    expect(q4.invoices.map((row: Json) => row.number)).toEqual(['FT-2026-00001', 'FT-2026-00003'])
  })

  it('downloads a file through a 60-second link, the download in the audit log', async () => {
    const october = await ok(accountant.get('/portal/accounting/periods/2026-10'))
    const sales = october.exports[0].files.find((file: Json) => file.package === 'SALES_JOURNAL')
    const answer = await ok(accountant.post(`/portal/accounting/files/${sales.file.id}/download`, { period: '2026-10' }))
    expect(answer.file).toEqual({ id: sales.file.id, name: sales.file.name })
    const bytes = await h.app.inject({ method: 'GET', url: answer.download.url })
    expect(bytes.statusCode).toBe(200)
    expect(createHash('sha256').update(bytes.rawPayload).digest('hex')).toBe(sales.file.sha256)
    const rows = await admin(`SELECT "actorId", audience, "companyId", after FROM "AuditLog" WHERE action = 'portal.accountingDownload' AND "recordId" = $1`, [sales.file.id])
    expect(rows).toEqual([{ actorId: accountantId, audience: 'PARTNER', companyId: companyA, after: expect.objectContaining({ period: '2026-10', what: 'SALES_JOURNAL', number: /* B-W2b-F45 */ octoberNumber }) }])
  })

  it('refuses another period’s file, a file of no period, a period not handed over (PERIOD, FILE refusals)', async () => {
    const october = await ok(accountant.get('/portal/accounting/periods/2026-10'))
    const octoberFile = october.exports[0].files[0].file.id
    expect(await problem(accountant.post(`/portal/accounting/files/${octoberFile}/download`, { period: '2026-09' }), 409)).toEqual(['problem/FILE_NOT_IN_PERIOD'])
    expect(await problem(accountant.post(`/portal/accounting/files/${octoberFile}/download`, { period: '2026-11' }), 409)).toEqual(['problem/PERIOD_NOT_SHARED'])
    expect(await problem(accountant.post(`/portal/accounting/files/${newId()}/download`, { period: '2026-10' }), 409)).toEqual(['problem/FILE_NOT_IN_PERIOD'])
    // The supplier invoice of 13 November: its month is not handed over, so the quarter does not list or give it.
    const [supplierXml] = await admin<{ xmlFileId: string }>(`SELECT "xmlFileId" FROM "SupplierInvoice" WHERE "tenantId" = $1 AND "xmlFileId" IS NOT NULL LIMIT 1`, [T])
    expect(await problem(accountant.post(`/portal/accounting/files/${supplierXml!.xmlFileId}/download`, { period: '2026-Q4' }), 409)).toEqual(['problem/FILE_NOT_IN_PERIOD'])
    expect((await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'portal.accountingDownload'`))[0]!.n).toBe(1)
  })

  it('zips the period’s XML (a missing object named in the index) and the whole quarter, each zip in the audit log', async () => {
    const october = await ok(accountant.get('/portal/accounting/periods/2026-10'))
    const first = october.invoices.find((row: Json) => row.number === 'FT-2026-00001').xml
    // The seed keeps the rows of its XML files, not their bytes: put FT-2026-00001's (made up) in the FAKE store.
    const [stored] = await admin<{ storageKey: string; contentType: string }>(`SELECT "storageKey", "contentType" FROM "StoredFile" WHERE id = $1`, [first.id])
    const xml = Buffer.from('<?xml version="1.0"?><FatturaElettronica><Esempio>FT-2026-00001 (made up)</Esempio></FatturaElettronica>')
    await h.files.local!.put({ account: { mode: 'FAKE' } } as never, { key: stored!.storageKey, contentType: stored!.contentType, body: xml, sha256: createHash('sha256').update(xml).digest('hex') })

    const zip = await accountant.post('/portal/accounting/zip', { period: '2026-10', what: 'XML' })
    expect(zip.status, String(zip.body).slice(0, 300)).toBe(200)
    expect(zip.response.headers['content-type']).toContain('application/zip')
    expect(String(zip.response.headers['content-disposition'])).toContain('SCA_2026-10_xml.zip')
    const entries = unzip(zip.response.rawPayload)
    expect([...entries.keys()]).toEqual(['index.csv', `e-invoices/sales/${first.name}`])
    expect(entries.get(`e-invoices/sales/${first.name}`)!.equals(xml)).toBe(true)
    const index = entries.get('index.csv')!.toString('utf8')
    expect(index).toContain('FT-2026-00001')
    expect(index).toContain('FT-2026-00003')
    expect(index).toContain('no: not in the file store')

    h.clock.advance(1_000)
    const quarter = await accountant.post('/portal/accounting/zip', { period: '2026-Q4', what: 'PERIOD' })
    expect(quarter.status).toBe(200)
    const names = [...unzip(quarter.response.rawPayload).keys()]
    expect(names[0]).toBe('index.csv')
    expect(names.filter((name) => name.startsWith('exports/'))).toHaveLength(3)
    expect(names.filter((name) => name.startsWith('registers/'))).toHaveLength(1)
    expect(names).toContain(`e-invoices/sales/${first.name}`)

    expect(await problem(accountant.post('/portal/accounting/zip', { period: '2026-10', what: 'FILES', fileIds: [newId()] }), 409)).toEqual(['problem/FILE_NOT_IN_PERIOD'])
    expect(await problem(accountant.post('/portal/accounting/zip', { period: '2026-11', what: 'PERIOD' }), 409)).toEqual(['problem/PERIOD_NOT_SHARED'])
    const zips = await admin(`SELECT "actorId", after FROM "AuditLog" WHERE action = 'portal.accountingZip' ORDER BY at, id`)
    expect(zips.map((row) => [row.actorId, row.after.period, row.after.what])).toEqual([
      [accountantId, '2026-10', 'XML'],
      [accountantId, '2026-Q4', 'PERIOD'],
    ])
    // The office sees who downloaded what.
    const listed = await ok(finance.get(`/accounting/accountants?companyId=${companyA}`))
    expect(listed.downloads.map((row: Json) => [row.person, row.firm, row.what, row.period])).toEqual([
      ['Anna Conti', 'Studio Prova', 'ZIP', '2026-Q4'],
      ['Anna Conti', 'Studio Prova', 'ZIP', '2026-10'],
      ['Anna Conti', 'Studio Prova', 'FILE', '2026-10'],
    ])
    expect(listed.firms.find((entry: Json) => entry.party.id === firmId).people[0]).toMatchObject({ status: 'ACTIVE', lastSignInAt: expect.any(String) })
  })

  it('another party’s person has no room; the accountant has no other portal page', async () => {
    const buyerId = newId()
    await office(async (client) => {
      await client.user.create({ data: { id: buyerId, email: people.buyer, displayName: 'Bianca', locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId: world.partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'customer-buyer' } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: buyerId, roleId: role.id, allCompanies: true, partyIds: [world.partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    })
    const buyer = await signedIn(people.buyer)
    expect((await buyer.get('/portal/accounting')).status).toBe(403)
    expect((await buyer.get('/portal/accounting/periods/2026-10')).status).toBe(403)
    expect((await accountant.get('/portal/customer-documents')).status).toBe(403)
    expect((await accountant.get('/portal/purchase-orders')).status).toBeGreaterThanOrEqual(403)
    // The office's routes are not the accountant's.
    expect((await accountant.get(`/accounting/exports?companyId=${companyA}`)).status).toBeGreaterThanOrEqual(401)
  })
})

describe('the end of access (PLT-022)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('moves the end, then ends it now: the accountant’s session ends at once', async () => {
    const version = async () => (await admin<{ version: number }>(`SELECT version FROM "User" WHERE id = $1`, [accountantId]))[0]!.version
    const later = new Date(h.clock.now().getTime() + 60 * 86_400_000).toISOString()
    const moved = await ok(asFinance('PATCH', `/accounting/accountants/${accountantId}`, { companyId: companyA, version: await version(), accessUntil: later }))
    expect(moved.accessUntil).toBe(later)
    expect((await accountant.get('/portal/accounting')).body.access.accessUntil).toBe(later)
    const ended = await ok(asFinance('POST', `/accounting/accountants/${accountantId}/end`, { companyId: companyA, version: await version(), reason: 'The engagement ended (made up).' }))
    expect(ended).toMatchObject({ status: 'DEACTIVATED' })
    expect(ended.sessionsEnded).toBeGreaterThanOrEqual(1)
    expect((await accountant.get('/portal/accounting')).status).toBe(401)
    expect((await asFinance('POST', `/accounting/accountants/${accountantId}/end`, { companyId: companyA, version: await version() })).status).toBe(409)
  })

  it('an access that ends by its date ends by itself', async () => {
    const soon = new Date(h.clock.now().getTime() + 5 * 60_000).toISOString()
    const answer = await ok(asFinance('POST', '/accounting/accountants', { companyId: companyA, partyId: firmId, email: people.second, displayName: 'Bruno Conti', locale: 'en', accessUntil: soon }), 201)
    expect(answer.portalSwitchedOn).toBe(false)
    const second = await signedIn(people.second)
    expect((await second.get('/portal/accounting')).status).toBe(200)
    h.clock.advance(6 * 60_000)
    expect((await second.get('/portal/accounting')).status).toBe(401)
  })
})
