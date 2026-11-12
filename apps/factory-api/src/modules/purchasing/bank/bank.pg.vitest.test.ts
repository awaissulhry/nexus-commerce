import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Supplier bank details with change control (B-W2b-315; SCM-007) on the local stack: a throwaway PostgreSQL 17 database
 * from the migrations (row-level security, the partner grants and B-W2b-287's …_suppliers_depth_w2b_guards are real), the
 * real app with office people signed in with two-factor (step-up), and the supplier's Admin signed in to its portal by
 * e-mail code (FAKE mailbox). Made-up people, a made-up supplier and made-up Italian test IBANs (bank and branch codes of
 * zeros) only. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/bank`.
 */

let h: Harness
const NS = 'bank-315'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const SUPPLIER = newId()
const ORDER_DESK = newId()
// Made-up test IBANs: IT, check digits right, ABI and CAB 00000.
const IBAN = { first: 'IT11X0000000000000000315001', second: 'IT81X0000000000000000315002', portal: 'IT54X0000000000000000315003', refused: 'IT27X0000000000000000315004' }
const people: Record<string, { browser: Browser; secret: string; id: string }> = {}
let admin: Browser
let supplierAdmin: Browser
let supplierOrders: Browser
const SUPPLIER_ADMIN = 'anna.admin@made-up-tannery.example'
const SUPPLIER_ORDERS = 'otto.orders@made-up-tannery.example'

type Json = Record<string, any>
const sql = async <T = Json>(text: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(text, values)).rows as T[]
let counter = 0
const key = () => `bank315-${++counter}-${newId()}`
async function call(browser: Browser, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) {
  const answer = await browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  return { status: answer.status, body: answer.body as Json }
}
async function as(browser: Browser, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(browser, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const paths = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => issue.path)
const bankUrl = `/purchasing/suppliers/${SUPPLIER}/bank`
const step = (name: string) => stepUp(h, people[name]!.browser, people[name]!.secret)
const account = (bank: Json, last4: string): Json => bank.accounts.find((row: Json) => row.ibanLast4 === last4)
const row = (id: string) => sql('SELECT status, iban, "proposedById", "callBackById", "verifiedById", "createdById", "retireReason", "refuseReason" FROM "SupplierBankAccount" WHERE id = $1', [id]).then((rows) => rows[0]!)

async function partnerPerson(email: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId: SUPPLIER, partnerKind: 'SUPPLIER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant, key: roleKey } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [SUPPLIER], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

async function portalSignedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  if (terms.body?.notice) expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

async function portalStepUp(browser: Browser, email: string): Promise<void> {
  h.clock.advance(61_000)
  expect((await browser.post('/portal/step-up/start')).status).toBe(200)
  await h.auth.settled()
  const proved = await browser.post('/portal/step-up', { code: mailedCode(h, email, 'auth.portal_step_up')!.code })
  expect(proved.status, JSON.stringify(proved.body)).toBe(200)
}

beforeAll(async () => {
  h = await startHarness('bank_315')
  // The bank guards refuse a time more than 5 minutes ahead of the database, the portal a code past its 15 minutes: the app's
  // clock starts 8 minutes behind the database (sign-ins and step-ups move it on, about 9 minutes in all).
  h.clock.set(new Date(Date.now() - 8 * 60_000))
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  const ses = newId()
  await sql(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await sql(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  await portalWorld(h, seedTenant)
  // A made-up supplier of company A with its order desk on file a day before anything is proposed.
  const before = new Date(h.clock.now().getTime() - 86_400_000)
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => {
    await client.party.create({ data: { id: SUPPLIER, companyId: companyA, code: `B315${SUPPLIER.slice(-4)}`, kind: 'ORGANISATION', legalName: 'Made-up Tannery S.r.l.', roles: ['SUPPLIER'], status: 'ACTIVE' }, select: { id: true } })
    await client.partyContact.create({ data: { id: ORDER_DESK, partyId: SUPPLIER, name: 'Order desk', email: 'orders@made-up-tannery.example', phone: '+39 000 0000315', roles: ['ORDERS'], createdAt: before, updatedAt: before }, select: { id: true } })
    await client.portalSettings.create({ data: { id: SUPPLIER, partyId: SUPPLIER, portalOn: true }, select: { id: true } })
  })
  for (const [name, role] of [['fin1', 'finance'], ['fin2', 'finance'], ['fin3', 'finance'], ['buyer', 'buyer']] as const) {
    const user = await addUser(h, seedTenant, { email: `${name}.315@seed-a.example.com`, role })
    const browser = new Browser(h.app)
    expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
    people[name] = { browser, secret: await enrolTotp(h, browser), id: user.id }
  }
  const adminUser = await addUser(h, seedTenant, { email: 'admin.315@seed-a.example.com', role: 'admin' })
  admin = new Browser(h.app)
  expect((await admin.signIn(NS, adminUser.email, adminUser.password)).status).toBe(200)
  await enrolTotp(h, admin)
  freshGuard(h)
  await partnerPerson(SUPPLIER_ADMIN, ['supplier-admin'])
  await partnerPerson(SUPPLIER_ORDERS, ['supplier-orders'])
  supplierAdmin = await portalSignedIn(SUPPLIER_ADMIN)
  supplierOrders = await portalSignedIn(SUPPLIER_ORDERS)
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
}, 60_000)

describe('a new account from the supplier’s letter (SCM-007)', () => {
  let accountId: string

  it('is finance’s: a buyer reads no bank details; a proposal asks a fresh step-up and a valid IBAN', async () => {
    expect((await call(people.buyer!.browser, 'GET', bankUrl)).status).toBe(403)
    const empty = await as(people.fin1!.browser, 'GET', bankUrl)
    expect(empty).toMatchObject({ accounts: [], payable: [], emptyWords: 'No bank account — payments to this supplier are held.', may: { propose: true } })
    const noStep = await call(people.fin1!.browser, 'POST', bankUrl, { iban: IBAN.first, holder: 'Made-up Tannery S.r.l.' })
    expect(noStep.status).toBe(403)
    expect(paths(noStep.body)).toEqual(['stepUp'])
    await step('fin1')
    const wrong = await call(people.fin1!.browser, 'POST', bankUrl, { iban: 'IT12X0000000000000000315001', holder: 'Made-up Tannery S.r.l.' })
    expect(wrong.status).toBe(400)
    expect(paths(wrong.body)).toEqual(['body/iban'])
  })

  it('is PROPOSED, masked everywhere, waiting for its call-back; nothing about it carries the IBAN', async () => {
    const made = await as(people.fin1!.browser, 'POST', bankUrl, { iban: 'it11 x000 0000 0000 0000 0315 001', holder: 'Made-up Tannery S.r.l.', bankName: 'Made-up Bank', bic: 'madeitm1xxx' }, 201)
    accountId = made.accountId
    expect(account(made, '5001')).toMatchObject({ id: accountId, masked: 'IT** **** **** 5001', status: 'PROPOSED', pill: 'WAITING_CALL_BACK', source: 'OFFICE', bic: 'MADEITM1XXX', replacesId: null, callBack: null })
    expect(account(made, '5001').callBackCandidates.usable.map((entry: Json) => entry.id)).toEqual([ORDER_DESK])
    expect(JSON.stringify(made)).not.toContain(IBAN.first)
    expect(await row(accountId)).toMatchObject({ status: 'PROPOSED', iban: IBAN.first, proposedById: people.fin1!.id, createdById: people.fin1!.id })
    const audit = await sql('SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [accountId, 'purchasing.bank.propose'])
    expect(JSON.stringify(audit)).not.toContain(IBAN.first)
    const events = await sql('SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = $2', [accountId, 'supplier_bank_account.proposed'])
    expect(events.map((event) => event.payload)).toEqual([{ accountId, partyId: SUPPLIER, source: 'OFFICE', currency: 'EUR' }])
  })

  it('is called back by someone else on a number we had before the proposal, never one added after', async () => {
    const version = account(await as(people.fin2!.browser, 'GET', bankUrl), '5001').version
    const own = await call(people.fin1!.browser, 'POST', `${bankUrl}/${accountId}/call-back`, { version, contactId: ORDER_DESK, phone: '+39 000 0000315' })
    expect(own.status).toBe(403)
    expect(paths(own.body)).toEqual(['refusal/OWN_CHANGE'])
    // A contact added after the change was proposed (it may have come with the change) is offered to nobody.
    const late = newId()
    await sql(`INSERT INTO "PartyContact" (id, "tenantId", "partyId", name, email, phone, roles, "createdAt", "updatedAt") VALUES ($1, $2, $3, 'New accounts', 'new@made-up-tannery.example', '+39 000 0000999', '{INVOICES}', now(), now())`, [late, tenant, SUPPLIER])
    const bank = await as(people.fin2!.browser, 'GET', bankUrl)
    expect(account(bank, '5001').callBackCandidates.held.find((entry: Json) => entry.id === late)).toMatchObject({ hold: 'ADDED_AFTER' })
    const toLate = await call(people.fin2!.browser, 'POST', `${bankUrl}/${accountId}/call-back`, { version, contactId: late, phone: '+39 000 0000999' })
    expect(toLate.status).toBe(400)
    expect(paths(toLate.body)).toEqual(['body/onFile'])
    const wrongNumber = await call(people.fin2!.browser, 'POST', `${bankUrl}/${accountId}/call-back`, { version, contactId: ORDER_DESK, phone: '+39 000 0000999' })
    expect(paths(wrongNumber.body)).toEqual(['body/phone'])
    const called = await as(people.fin2!.browser, 'POST', `${bankUrl}/${accountId}/call-back`, { version, contactId: ORDER_DESK, phone: '(+39) 000 0000315' })
    expect(account(called, '5001')).toMatchObject({ pill: 'WAITING_SECOND_CHECK', callBack: { by: { id: people.fin2!.id }, kind: 'CONTACT', onFileId: ORDER_DESK, phone: '(+39) 000 0000315' }, may: { callBack: false } })
  })

  it('is checked by a second person (never who proposed it) with a fresh step-up, and payments use it', async () => {
    const version = account(await as(people.fin1!.browser, 'GET', bankUrl), '5001').version
    await step('fin1')
    const own = await call(people.fin1!.browser, 'POST', `${bankUrl}/${accountId}/verify`, { version })
    expect(own.status).toBe(403)
    expect(paths(own.body)).toEqual(['refusal/OWN_CHANGE'])
    const noStep = await call(people.fin2!.browser, 'POST', `${bankUrl}/${accountId}/verify`, { version })
    expect(paths(noStep.body)).toEqual(['stepUp'])
    await step('fin2')
    const checked = await as(people.fin2!.browser, 'POST', `${bankUrl}/${accountId}/verify`, { version })
    expect(checked.approval).toBeNull()
    expect(account(checked, '5001')).toMatchObject({ status: 'ACTIVE', pill: 'USABLE', verified: { by: { id: people.fin2!.id } } })
    expect(checked.payable).toEqual([{ currency: 'EUR', accountId }])
    expect(checked.emptyWords).toBeNull()
  })

  it('reveals the full IBAN to finance behind a step-up, and records who saw it', async () => {
    expect((await call(people.buyer!.browser, 'POST', `${bankUrl}/${accountId}/reveal`)).status).toBe(403)
    expect(paths((await call(people.fin3!.browser, 'POST', `${bankUrl}/${accountId}/reveal`)).body)).toEqual(['stepUp'])
    await step('fin3')
    expect(await as(people.fin3!.browser, 'POST', `${bankUrl}/${accountId}/reveal`)).toEqual({ accountId, iban: IBAN.first, grouped: 'IT11 X000 0000 0000 0000 0315 001' })
    const seen = await sql('SELECT "actorId", after FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [accountId, 'purchasing.bank.reveal'])
    expect(seen).toEqual([{ actorId: people.fin3!.id, after: { masked: 'IT** **** **** 5001' } }])
  })
})

describe('a change in the supplier’s portal, with a second approval the rule asks (SCM-007, VN2:03)', () => {
  let portalId: string
  let taskId: string

  it('shows the supplier its account masked; its Orders person sees none; proposing asks the e-mail step-up', async () => {
    const page = await as(supplierAdmin, 'GET', '/portal/supplier-bank')
    expect(page).toMatchObject({ accounts: [{ masked: 'IT** **** **** 5001', state: 'USABLE', holder: 'Made-up Tannery S.r.l.' }], waitingWords: null, mayPropose: true })
    expect(JSON.stringify(page)).not.toContain(IBAN.first)
    expect((await call(supplierOrders, 'GET', '/portal/supplier-bank')).status).toBe(403)
    expect(paths((await call(supplierAdmin, 'POST', '/portal/supplier-bank', { iban: IBAN.portal, holder: 'Made-up Tannery S.r.l.' })).body)).toEqual(['stepUp'])
  })

  it('proposes new bank details in the partner scope: nothing changes for payments until our call-back and check', async () => {
    await portalStepUp(supplierAdmin, SUPPLIER_ADMIN)
    const made = await as(supplierAdmin, 'POST', '/portal/supplier-bank', { iban: IBAN.portal, holder: 'Made-up Tannery S.r.l.', bankName: 'Made-up Bank Two' }, 201)
    portalId = made.accountId
    expect(made.waitingWords).toMatch(/we call you on your registered number/)
    expect(made.accounts.find((entry: Json) => entry.id === portalId)).toMatchObject({ state: 'WAITING', masked: 'IT** **** **** 5003' })
    expect(await row(portalId)).toMatchObject({ status: 'PROPOSED', createdById: null })
    // A second open change of the currency waits for the first.
    await portalStepUp(supplierAdmin, SUPPLIER_ADMIN)
    expect((await call(supplierAdmin, 'POST', '/portal/supplier-bank', { iban: IBAN.refused, holder: 'Made-up Tannery S.r.l.' })).status).toBe(409)
    const office = await as(people.fin1!.browser, 'GET', bankUrl)
    expect(account(office, '5003')).toMatchObject({ source: 'PORTAL', pill: 'WAITING_CALL_BACK' })
    expect(office.payable).toEqual([{ currency: 'EUR', accountId: account(office, '5001').id }])
  })

  it('asks the second approval a switched-on SUPPLIER_BANK_CHANGE rule names; the asker never approves it', async () => {
    const financeRole = (await sql<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'finance'`, [tenant]))[0]!.id
    const rule = (await as(admin, 'POST', '/approvals/rules', { kind: 'SUPPLIER_BANK_CHANGE', companyId: companyA, name: 'Every bank change', condition: { combinator: 'AND', rows: [] }, approver: { roleId: financeRole } }, 201)).rule
    await as(admin, 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true })
    let version = account(await as(people.fin1!.browser, 'GET', bankUrl), '5003').version
    await as(people.fin1!.browser, 'POST', `${bankUrl}/${portalId}/call-back`, { version, contactId: ORDER_DESK, phone: '+39 000 0000315' })
    version = account(await as(people.fin1!.browser, 'GET', bankUrl), '5003').version
    await step('fin1')
    const asked = await as(people.fin1!.browser, 'POST', `${bankUrl}/${portalId}/verify`, { version }, 202)
    taskId = asked.approval.taskId
    expect(account(asked, '5003')).toMatchObject({ status: 'PROPOSED', pill: 'WAITING_SECOND_CHECK', approval: { taskId, status: 'PENDING' }, heldWhy: { verify: expect.stringMatching(/Approvals/) } })
    const task = (await as(people.fin1!.browser, 'GET', `/approvals/tasks/${taskId}`)).task
    expect(JSON.stringify(task)).not.toContain(IBAN.portal)
    const own = await call(people.fin1!.browser, 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version })
    expect(own.status).toBe(403)
    expect(paths(own.body)).toEqual(['refusal/OWN_REQUEST'])
  })

  it('activates it on a second person’s yes, the old account retired first: one account in use', async () => {
    const task = (await as(people.fin3!.browser, 'GET', `/approvals/tasks/${taskId}`)).task
    await as(people.fin3!.browser, 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version })
    const bank = await as(people.fin1!.browser, 'GET', bankUrl)
    expect(account(bank, '5003')).toMatchObject({ status: 'ACTIVE', pill: 'USABLE', verified: { by: { id: people.fin3!.id } } })
    expect(account(bank, '5001')).toMatchObject({ status: 'RETIRED', retired: { reason: 'Replaced by the account ending 5003.' } })
    expect(bank.payable).toEqual([{ currency: 'EUR', accountId: portalId }])
    expect((await sql(`SELECT count(*)::int AS n FROM "SupplierBankAccount" WHERE "partyId" = $1 AND status = 'ACTIVE'`, [SUPPLIER]))[0]!.n).toBe(1)
    const page = await as(supplierAdmin, 'GET', '/portal/supplier-bank')
    expect(page.accounts.find((entry: Json) => entry.id === portalId)).toMatchObject({ state: 'USABLE' })
    expect(page.waitingWords).toBeNull()
  })

  it('refuses a change with why (the supplier reads it), and retires the account in use: payments are held', async () => {
    await step('fin2')
    const made = await as(people.fin2!.browser, 'POST', bankUrl, { iban: IBAN.refused, holder: 'Made-up Tannery S.r.l.' }, 201)
    const refusedId = made.accountId
    const version = account(made, '5004').version
    expect((await call(people.fin1!.browser, 'POST', `${bankUrl}/${refusedId}/refuse`, { version, reason: ' ' })).status).toBe(400)
    const refused = await as(people.fin1!.browser, 'POST', `${bankUrl}/${refusedId}/refuse`, { version, reason: 'The order desk did not ask for this change when we called back.' })
    expect(account(refused, '5004')).toMatchObject({ status: 'REFUSED', refused: { reason: 'The order desk did not ask for this change when we called back.' } })
    expect((await call(people.fin1!.browser, 'POST', `${bankUrl}/${refusedId}/verify`, { version: version + 1 })).status).toBe(409)
    const portal = await as(supplierAdmin, 'GET', '/portal/supplier-bank')
    expect(portal.accounts.find((entry: Json) => entry.id === refusedId)).toMatchObject({ state: 'REFUSED', reason: 'The order desk did not ask for this change when we called back.' })
    const active = account(refused, '5003')
    const retired = await as(people.fin2!.browser, 'POST', `${bankUrl}/${active.id}/retire`, { version: active.version, reason: 'Account closed by the supplier.' })
    expect(retired).toMatchObject({ payable: [], emptyWords: 'No bank account — payments to this supplier are held.' })
  })
})
