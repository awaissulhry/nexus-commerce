import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { RECIPIENT_REFUSALS } from '@nexus/factory-domain/email/recipient-party'
import { buildApp } from '../../core/app'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { addTenant, addUser, Browser, START, startHarness, WEB_ORIGIN, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { registerLinkRecordSource } from './records'

/**
 * B-TH-004 (threads plan TH-0, WALL-G05; T24 of the brand wall, Owner rule 2026-11-16: "one brand must not be able to see anything
 * related to any other brand"): the address a one-off link is made for follows the one recipient rule of every mail on the
 * record's party. A link of Brand Alpha's record for an address of Brand Beta's contact is refused in words (409
 * `refusal/OTHER_PARTY` at `email`) and nothing is made, unless the person ticks "Send outside this customer" — then the link is
 * made and the tick recorded; Brand Alpha's own contact, the record's address and an address nobody knows pass. With the app's
 * real routes and a made-up record source (no module offers POST /links a record yet). Made-up names and addresses only. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/links/link-address`.
 */

let h: Harness
let app: FastifyInstance
let tenant: TestTenant
let sales: Browser
const withdraw: (() => void)[] = []
const alpha = newId()
const beta = newId()
const quote = newId()
const ALPHA_CONTACT = 'anna@brand-alpha.example'
const BETA_CONTACT = 'bruno@brand-beta.example'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const links = async (): Promise<number> => Number((await admin<{ n: string }>(`SELECT count(*) AS n FROM "OneOffLink" WHERE "tenantId" = $1`, [tenant.id]))[0]!.n)
let counter = 0
const make = (body: Json) => sales.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quote, ...body }, { headers: { 'idempotency-key': `link-address-${++counter}-${newId()}` } })

beforeAll(async () => {
  h = await startHarness('link_address')
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: WEB_ORIGIN, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database: h.database, officeAuth: h.auth, clock: h.clock, routesRoot: fileURLToPath(new URL('../..', import.meta.url)) },
  )
  tenant = await addTenant(h, 'la-a')
  const companyId = tenant.companies[0]!.id
  // The made-up quote of Brand Alpha, read in the caller's tenant (as a module's source does).
  withdraw.push(
    registerLinkRecordSource('Quote', {
      async read(client, recordId) {
        const [scope] = await client.$queryRaw<{ tenant: string }[]>`SELECT current_setting('factory.tenant_id', true) AS tenant`
        return recordId === quote && scope?.tenant === tenant.id ? { companyId, partyId: alpha, email: ALPHA_CONTACT } : null
      },
    }),
  )
  const seller = await addUser(h, tenant, { email: 'sara.sales@la-a.example.invalid', role: 'sales' })
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: seller.id }, async (client) => {
    await client.party.create({ data: { id: alpha, companyId, code: 'LA-ALPHA', kind: 'ORGANISATION', legalName: 'Brand Alpha S.r.l.', tradeName: 'Brand Alpha', roles: ['CUSTOMER', 'BRAND'] } })
    await client.party.create({ data: { id: beta, companyId, code: 'LA-BETA', kind: 'ORGANISATION', legalName: 'Brand Beta GmbH', tradeName: 'Brand Beta', roles: ['CUSTOMER', 'BRAND'] } })
    await client.partyContact.create({ data: { id: newId(), partyId: alpha, name: 'Anna Alfieri', email: ALPHA_CONTACT } })
    await client.partyContact.create({ data: { id: newId(), partyId: beta, name: 'Bruno Becker', email: BETA_CONTACT } })
    // The W0 templates give links.* to the owner only: a custom role makes and lists links (as the links tests give it).
    const role = await client.role.create({ data: { id: newId(), key: 'custom.link_sender', name: 'Link sender', permissions: ['links.view', 'links.manage'], grains: ['price'] }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: seller.id, roleId: role.id, allCompanies: true, validFrom: new Date(START) } })
  })
  sales = new Browser(app)
  const signed = await sales.signIn('la-a', seller.email, seller.password)
  expect(signed.body?.status, JSON.stringify(signed.body)).toBe('signed_in')
}, 90_000)

afterAll(async () => {
  for (const off of withdraw) off()
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-004 a one-off link’s address follows the recipient rule (T24)', () => {
  it('a link of Brand Alpha’s quote for Brand Beta’s contact is refused in words at `email`; nothing is made', async () => {
    const before = await links()
    const refused = await make({ email: BETA_CONTACT })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(refused.body.error.issues).toEqual([
      { path: 'refusal/OTHER_PARTY', message: RECIPIENT_REFUSALS.OTHER_PARTY.en },
      { path: 'email', message: `${BETA_CONTACT} belongs to Brand Beta.` },
    ])
    expect(await links()).toBe(before)
  })

  it('with "Send outside this customer" ticked the link is made, and its audit row records the address it let through', async () => {
    const made = await make({ email: BETA_CONTACT, sendOutside: true })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.link).toMatchObject({ email: BETA_CONTACT })
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'OneOffLink' AND "recordId" = $1 AND action = 'links.create'`, [made.body.link.id])
    expect(audit!.after.sentOutside).toEqual([{ address: BETA_CONTACT, parties: [beta] }])
  })

  it('Brand Alpha’s own contact, the record’s own address and an address nobody knows pass without a tick', async () => {
    for (const body of [{ email: ALPHA_CONTACT }, {}, { email: 'new.person@nobody.example' }]) {
      const made = await make(body)
      expect(made.status, JSON.stringify(made.body)).toBe(201)
      const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'OneOffLink' AND "recordId" = $1 AND action = 'links.create'`, [made.body.link.id])
      expect(audit!.after).not.toHaveProperty('sentOutside')
    }
  })
})
