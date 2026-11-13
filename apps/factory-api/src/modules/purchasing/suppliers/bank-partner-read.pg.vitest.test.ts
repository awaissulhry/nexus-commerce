import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * A partner reads the last four characters of an IBAN, never the whole number (B-W2b-377; follow-up XF5:07; SCM-007): the
 * supplier's portal answers its accounts masked to their country and last four characters, nothing in the answer carries the
 * whole IBAN, and the database refuses the partner's own read of `iban` (B-W2b-363's write-only column) — while the office
 * reads the same masked view. The real app over a throwaway PostgreSQL 17 database; the supplier's Admin signed in to its
 * portal by e-mail code (FAKE mail). Made-up test IBANs only (bank and branch codes 00000). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/purchasing/suppliers/bank-partner-read`.
 */

let h: Harness
const NS = 'iban-377'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const SUPPLIER = newId()
const SUPPLIER_ADMIN = 'paola.admin@made-up-mill.example'
// A made-up test IBAN: IT, check digits right, ABI and CAB 00000.
const IBAN = 'IT37X0000000000000000377001'
let partnerId: string
let supplierAdmin: Browser
let finance: Browser

type Json = Record<string, any>
const sql = async <T = Json>(text: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(text, values)).rows as T[]

beforeAll(async () => {
  h = await startHarness('iban_377')
  h.clock.set(new Date(Date.now() - 8 * 60_000))
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
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
  const financeUser = await addUser(h, seedTenant, { email: 'finance.377@seed-a.example.com', role: 'finance' })
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: financeUser.id }, async (client) => {
    await client.party.create({ data: { id: SUPPLIER, companyId: companyA, code: `I377${SUPPLIER.slice(-4)}`, kind: 'ORGANISATION', legalName: 'Made-up Mill S.r.l.', roles: ['SUPPLIER'], status: 'ACTIVE' }, select: { id: true } })
    await client.portalSettings.create({ data: { id: SUPPLIER, partyId: SUPPLIER, portalOn: true }, select: { id: true } })
    // The supplier's account as the office proposed it (the database writes its country and last four characters).
    await client.supplierBankAccount.create({ data: { id: newId(), partyId: SUPPLIER, iban: IBAN, holder: 'Made-up Mill S.r.l.', bankName: 'Made-up Bank', currency: 'EUR', proposedById: financeUser.id, proposedAt: h.clock.now(), createdById: financeUser.id }, select: { id: true } })
    partnerId = newId()
    await client.user.create({ data: { id: partnerId, email: SUPPLIER_ADMIN, displayName: 'Paola Admin', locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId: SUPPLIER, partnerKind: 'SUPPLIER' }, select: { id: true } })
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant, key: 'supplier-admin' } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: partnerId, roleId: role.id, allCompanies: true, partyIds: [SUPPLIER], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  finance = new Browser(h.app)
  expect((await finance.signIn(NS, financeUser.email, financeUser.password)).status).toBe(200)
  await enrolTotp(h, finance)
  freshGuard(h)
  supplierAdmin = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await supplierAdmin.post('/portal/signin/start', { tenant: NS, company: 'SCA', email: SUPPLIER_ADMIN })).status).toBe(200)
  await h.auth.settled()
  expect((await supplierAdmin.post('/portal/signin/code', { tenant: NS, company: 'SCA', email: SUPPLIER_ADMIN, code: mailedCode(h, SUPPLIER_ADMIN)!.code })).status).toBe(200)
  const terms = await supplierAdmin.get('/portal/terms?locale=en')
  if (terms.body?.notice) expect((await supplierAdmin.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
}, 300_000)

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
}, 60_000)

describe('a partner reads the last four characters of an IBAN, never the whole number (XF5:07)', () => {
  it('the supplier’s portal answers its account masked; no part of the answer carries the IBAN', async () => {
    const page = await supplierAdmin.get('/portal/supplier-bank')
    expect(page.status, JSON.stringify(page.body)).toBe(200)
    expect(page.body.accounts).toEqual([expect.objectContaining({ masked: 'IT** **** **** 7001', state: 'WAITING', holder: 'Made-up Mill S.r.l.' })])
    const text = JSON.stringify(page.body)
    expect(text).not.toContain(IBAN)
    expect(text).not.toContain(IBAN.slice(4, 20))
  })

  it('the database refuses the partner’s own read of the IBAN, and answers its country and last four characters', async () => {
    const scope = { audience: 'partner' as const, tenantId: tenant, actorId: partnerId, partyId: SUPPLIER }
    await expect(h.database.withScope(scope, (client) => client.supplierBankAccount.findMany({ where: { partyId: SUPPLIER }, select: { id: true, iban: true } }))).rejects.toThrow(/permission denied/)
    expect(await h.database.withScope(scope, (client) => client.supplierBankAccount.findMany({ where: { partyId: SUPPLIER }, select: { ibanCountry: true, ibanLast4: true } }))).toEqual([{ ibanCountry: 'IT', ibanLast4: '7001' }])
  })

  it('the office reads the same masked view (the whole IBAN only by Reveal, with a fresh code)', async () => {
    const bank = await finance.get(`/purchasing/suppliers/${SUPPLIER}/bank`)
    expect(bank.status, JSON.stringify(bank.body)).toBe(200)
    expect(bank.body.accounts[0]).toMatchObject({ masked: 'IT** **** **** 7001', ibanLast4: '7001' })
    expect(JSON.stringify(bank.body)).not.toContain(IBAN)
  })
})
