import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { RECIPIENT_REFUSALS } from '@nexus/factory-domain/email/recipient-party'
import { callerFor, command } from '../../core/command'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { systemContext } from '../outbox/system'
import { sendEmail } from './outbound'

/**
 * B-TH-004 (threads plan TH-0, WALL-G03/G04; T20 and T21 of the brand wall, Owner rule 2026-11-16: "one brand must not be able to
 * see anything related to any other brand"): ONE recipient rule for every mail on a party's record, with the app's real route and
 * sessions on a throwaway PostgreSQL 17 database: a mail on Brand Alpha's record with an address of Brand Beta's contact or
 * portal person in To or Cc is refused in words (409 `refusal/OTHER_PARTY`, each address at its field) unless the person ticks
 * "Send outside this customer" — then it goes and the tick is recorded with what it let through; a contact of both brands (an
 * agent) and an address nobody knows pass; a blind copy goes only to our own people or Brand Alpha's own (refused otherwise, tick
 * or not); a module's own send (inside sendEmail) meets the same rule; the mis-send check says which addresses need the tick.
 * Made-up names and addresses only. Run with `node scripts/factory/run-pg-tests.mjs platform/email-out/recipient-party`.
 */

let h: Harness
let tenant: TestTenant
let sales: Browser
let companyId = ''
let salesId = ''
const alpha = newId()
const beta = newId()
const ALPHA_CONTACT = 'anna@brand-alpha.example'
const BETA_CONTACT = 'bruno@brand-beta.example'
const BETA_PORTAL = 'berta.portal@brand-beta.example'
const AGENT = 'agent@moto-agency.example'
const COLLEAGUE = 'sara.sales@rp-a.example.invalid'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const outbound = async (): Promise<number> => Number((await admin<{ n: string }>(`SELECT count(*) AS n FROM "EmailOutbound" WHERE "tenantId" = $1`, [tenant.id]))[0]!.n)
const send = (body: Json) => sales.post(`/threads/Party/${alpha}/emails`, { subject: 'Taglie', body: 'Buongiorno, le taglie sono confermate.', ...body })

beforeAll(async () => {
  h = await startHarness('recipient_party')
  tenant = await addTenant(h, 'rp-a')
  companyId = tenant.companies[0]!.id
  const ses = (await admin(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'SES'`, [tenant.id]))[0]!.id
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
    await client.emailIdentity.create({
      data: { id: newId(), companyId, kind: 'CONVERSATION', domain: 'rp-a.example.invalid', fromAddress: 'noreply@rp-a.example.invalid', displayName: 'Made-up RP', displayNamePolicy: 'COMPANY', replyDomain: 'reply.rp-a.example.invalid', accountId: ses, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.party.create({ data: { id: alpha, companyId, code: 'RP-ALPHA', kind: 'ORGANISATION', legalName: 'Brand Alpha S.r.l.', tradeName: 'Brand Alpha', roles: ['CUSTOMER', 'BRAND'] } })
    await client.party.create({ data: { id: beta, companyId, code: 'RP-BETA', kind: 'ORGANISATION', legalName: 'Brand Beta GmbH', tradeName: 'Brand Beta', roles: ['CUSTOMER', 'BRAND'] } })
    await client.partyContact.create({ data: { id: newId(), partyId: alpha, name: 'Anna Alfieri', email: ALPHA_CONTACT } })
    await client.partyContact.create({ data: { id: newId(), partyId: beta, name: 'Bruno Becker', email: BETA_CONTACT } })
    // An agent who works for both brands: a contact of each.
    await client.partyContact.create({ data: { id: newId(), partyId: alpha, name: 'Moto Agent', email: AGENT } })
    await client.partyContact.create({ data: { id: newId(), partyId: beta, name: 'Moto Agent', email: AGENT } })
    // Brand Beta's portal person.
    await client.user.create({ data: { id: newId(), email: BETA_PORTAL, displayName: 'Berta Becker', status: 'ACTIVE', audience: 'PARTNER', partyId: beta, partnerKind: 'CUSTOMER', locale: 'en' } })
  })
  const seller = await addUser(h, tenant, { email: COLLEAGUE, role: 'sales' })
  salesId = seller.id
  sales = new Browser(h.app)
  await sales.signIn('rp-a', seller.email, seller.password)
  await enrolTotp(h, sales)
}, 90_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('B-TH-004 one recipient rule for every mail on a party’s record', () => {
  it('T20 a thread mail on Brand Alpha’s record with Brand Beta’s contact in Cc (or its portal person in To) is refused in words; nothing is queued', async () => {
    const before = await outbound()
    const cc = await send({ to: [ALPHA_CONTACT], cc: [BETA_CONTACT] })
    expect(cc.status, JSON.stringify(cc.body)).toBe(409)
    expect(cc.body.error.message).toBe(RECIPIENT_REFUSALS.OTHER_PARTY.en)
    expect(cc.body.error.issues).toEqual([
      { path: 'refusal/OTHER_PARTY', message: RECIPIENT_REFUSALS.OTHER_PARTY.en },
      { path: 'body/cc/0', message: `${BETA_CONTACT} belongs to Brand Beta.` },
    ])
    const to = await send({ to: [ALPHA_CONTACT, BETA_PORTAL] })
    expect(to.status, JSON.stringify(to.body)).toBe(409)
    expect(to.body.error.issues).toContainEqual({ path: 'body/to/1', message: `${BETA_PORTAL} belongs to Brand Beta.` })
    expect(await outbound()).toBe(before)
  })

  it('with "Send outside this customer" ticked it goes, and the tick is recorded with the address it let through and whose it is', async () => {
    const sent = await send({ to: [ALPHA_CONTACT], cc: [BETA_CONTACT], sendOutside: true })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'EmailOutbound' AND "recordId" = $1`, [sent.body.email.id])
    expect(audit!.after.sentOutside).toEqual([{ address: BETA_CONTACT, parties: [beta] }])
  })

  it('lets through a contact of both brands (an agent), an address nobody knows and a colleague, without a tick; nothing is recorded as outside', async () => {
    const sent = await send({ to: [AGENT], cc: ['new.person@nobody.example', COLLEAGUE] })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'EmailOutbound' AND "recordId" = $1`, [sent.body.email.id])
    expect(audit!.after).not.toHaveProperty('sentOutside')
  })

  it('takes a blind copy only to our own people or Brand Alpha’s own: Brand Beta’s or an unknown address in Bcc is refused, tick or not', async () => {
    const before = await outbound()
    for (const bcc of [[BETA_CONTACT], ['hidden@nobody.example']]) {
      const refused = await send({ to: [ALPHA_CONTACT], bcc, sendOutside: true })
      expect(refused.status, JSON.stringify(refused.body)).toBe(409)
      expect(refused.body.error.issues[0]).toEqual({ path: 'refusal/HIDDEN_OUTSIDE', message: RECIPIENT_REFUSALS.HIDDEN_OUTSIDE.en })
      expect(refused.body.error.issues[1].path).toBe('body/bcc/0')
    }
    expect(await outbound()).toBe(before)
    expect((await send({ to: [ALPHA_CONTACT], bcc: [COLLEAGUE] })).status).toBe(201)
  })

  it('T21 a module’s own send (inside sendEmail, as the order confirmation, the quote and the statement send) meets the same rule', async () => {
    const caller = callerFor(h.database, systemContext(tenant.id, newId()))
    const moduleSend = (sendOutside?: boolean) =>
      command(caller, { name: 'test.moduleSend', input: { sendOutside: sendOutside ?? null } }, async (tools) => {
        const sent = await sendEmail(tools, { record: { type: 'Party', id: alpha }, sender: { userId: salesId, name: 'Sara Sales', email: COLLEAGUE }, to: [BETA_CONTACT], subject: 'Order confirmation', body: 'Your order is confirmed.', ...(sendOutside === undefined ? {} : { sendOutside }) })
        return { outbound: { id: sent.outbound.id, to: [...sent.outbound.to] } }
      })
    await expect(moduleSend()).rejects.toMatchObject({ code: 'conflict', issues: [{ path: 'refusal/OTHER_PARTY' }, { path: 'body/to/0', message: `${BETA_CONTACT} belongs to Brand Beta.` }] })
    const { result } = await moduleSend(true)
    expect(result.outbound.to).toEqual([BETA_CONTACT])
  })

  it('the mis-send check says which addresses need the tick (the same rule): another brand’s contact and portal person, never the agent, a colleague or an unknown address', async () => {
    const answer = await sales.post(`/threads/Party/${alpha}/emails/check`, { to: [ALPHA_CONTACT, BETA_CONTACT, BETA_PORTAL, AGENT, COLLEAGUE, 'new.person@nobody.example'], body: 'Buongiorno.' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.outsideCustomer).toEqual([BETA_CONTACT, BETA_PORTAL])
    // The office reads the real reason (the other customer's name); a record without a party has nothing to tick.
    expect(answer.body.warnings).toContainEqual({ code: 'OTHER_ORGANISATION', items: ['Brand Beta'] })
    const company = await sales.post(`/threads/Company/${companyId}/emails/check`, { to: [BETA_CONTACT], body: 'Buongiorno.' })
    expect(company.status, JSON.stringify(company.body)).toBe(200)
    expect(company.body.outsideCustomer).toEqual([])
  })
})
