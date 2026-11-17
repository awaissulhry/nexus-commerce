import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NOT_INVITABLE, PARTNER_WORDS } from '@nexus/factory-domain/auth/partners/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../portal/service'
import { freshGuard, inWorld, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../portal/testing/portal'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../sessions/testing/harness'

/**
 * B-TH-007 (threads plan TH-0, WALL-G10; T04 of the brand wall, Owner rule 2026-11-16: "one brand must not be able to see anything
 * related to any other brand"): a brand's portal admin who invites a colleague never learns that an address has an account with
 * another organisation of this factory, or with the office: both answer ONE neutral sentence ("We could not invite this address.
 * Ask us.", refusal/NOT_INVITABLE), word for word the same. The office, inviting the same addresses, reads the real reason. With
 * the app's real routes and sign-ins. Made-up names and addresses only. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/auth/partners/invite-wall`.
 */

const SLUG = 'invite-wall'
let h: Harness
let tenant: TestTenant
let world: PortalWorld
let owner: Browser
let ownerSecret = ''
let ownerEmail = ''
let alphaAdmin: Browser
const ADMIN = 'ada.admin@brand-alpha.example'
const BETA_PERSON = 'berta.becker@brand-beta.example'
const betaParty = newId()

async function asOwner(url: string, body: Record<string, unknown>) {
  await stepUp(h, owner, ownerSecret)
  return owner.post(url, body)
}

beforeAll(async () => {
  h = await startHarness('invite_wall')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  freshGuard(h)
  tenant = await addTenant(h, SLUG, 2)
  world = await portalWorld(h, tenant)
  const ownerUser = await addUser(h, tenant, { email: 'owner@invite-wall.example', role: 'owner' })
  ownerEmail = ownerUser.email
  owner = new Browser(h.app)
  await owner.signIn(SLUG, ownerUser.email, ownerUser.password)
  ownerSecret = await enrolTotp(h, owner)
  // Brand Beta: another customer of the factory, with a person who has an account in its portal.
  await inWorld(h, world, async (client) => {
    await client.party.create({ data: { id: betaParty, code: 'IW-BETA', kind: 'ORGANISATION', legalName: 'Brand Beta GmbH', tradeName: 'Brand Beta', roles: ['CUSTOMER', 'BRAND'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: betaParty, partyId: betaParty, portalOn: true }, select: { id: true } })
    await client.user.create({ data: { id: newId(), email: BETA_PERSON, displayName: 'Berta Becker', status: 'ACTIVE', audience: 'PARTNER', partyId: betaParty, partnerKind: 'CUSTOMER', locale: 'en' }, select: { id: true } })
  })
  // Brand Alpha's admin: invited by the office, signed in, the terms taken, a fresh portal step-up.
  const invited = await asOwner(`/partners/${world.partyId}/people`, { companyId: world.companyId, email: ADMIN, displayName: 'Ada Admin', roleKey: 'customer-admin' })
  expect(invited.status, JSON.stringify(invited.body)).toBe(200)
  alphaAdmin = await portalBrowser(h)
  expect((await alphaAdmin.post('/portal/signin/start', { tenant: SLUG, company: 'C1', email: ADMIN })).status).toBe(200)
  await h.auth.settled()
  expect((await alphaAdmin.post('/portal/signin/code', { tenant: SLUG, company: 'C1', email: ADMIN, code: mailedCode(h, ADMIN)!.code })).status).toBe(200)
  const terms = await alphaAdmin.get('/portal/terms?locale=en')
  expect((await alphaAdmin.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
}, 120_000)

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

async function portalStepUp(): Promise<void> {
  h.clock.advance(61_000)
  expect((await alphaAdmin.post('/portal/step-up/start')).status).toBe(200)
  const proved = await alphaAdmin.post('/portal/step-up', { code: mailedCode(h, ADMIN, 'auth.portal_step_up')!.code })
  expect(proved.status, JSON.stringify(proved.body)).toBe(200)
}

describe('B-TH-007 portal invitations never reveal another organisation (T04)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('Brand Alpha’s admin inviting Brand Beta’s person or an office person hears one neutral sentence, word for word the same; nothing is made', async () => {
    await portalStepUp()
    const users = async () => Number((await h.db.admin.query('SELECT count(*) AS n FROM "User" WHERE "tenantId" = $1', [tenant.id])).rows[0].n)
    const before = await users()
    const answers = []
    for (const email of [BETA_PERSON, ownerEmail]) {
      const refused = await alphaAdmin.post('/portal/colleagues', { email, displayName: 'Someone', roleKey: 'customer-viewer' })
      expect(refused.status, JSON.stringify(refused.body)).toBe(409)
      expect(refused.body.error.message).toBe(NOT_INVITABLE.en)
      expect(refused.body.error.issues).toEqual([
        { path: 'email', message: NOT_INVITABLE.en },
        { path: 'refusal/NOT_INVITABLE', message: NOT_INVITABLE.en },
      ])
      const said = JSON.stringify(refused.body)
      for (const word of ['organisation', 'Office', 'Brand Beta', 'account']) expect(said).not.toContain(word)
      answers.push({ message: refused.body.error.message, issues: refused.body.error.issues })
    }
    expect(answers[0]).toEqual(answers[1])
    expect(await users()).toBe(before)
    expect(NOT_INVITABLE.it).toBe('Non abbiamo potuto invitare questo indirizzo. Chiedete a noi.')
  })

  it('the office, inviting the same addresses to Brand Alpha’s portal, reads the real reason', async () => {
    const other = await asOwner(`/partners/${world.partyId}/people`, { companyId: world.companyId, email: BETA_PERSON, displayName: 'Someone', roleKey: 'customer-viewer' })
    expect(other.status, JSON.stringify(other.body)).toBe(409)
    expect(other.body.error.issues).toEqual([{ path: 'email', message: PARTNER_WORDS.otherOrganisation }])
    const office = await asOwner(`/partners/${world.partyId}/people`, { companyId: world.companyId, email: ownerEmail, displayName: 'Someone', roleKey: 'customer-viewer' })
    expect(office.status, JSON.stringify(office.body)).toBe(409)
    expect(office.body.error.issues).toEqual([{ path: 'email', message: PARTNER_WORDS.officeAddress }])
  })

  it('a colleague of Brand Alpha’s own is still invited from the portal (the wall refuses nothing else)', async () => {
    await portalStepUp()
    const invited = await alphaAdmin.post('/portal/colleagues', { email: 'carl@brand-alpha.example', displayName: 'Carl', roleKey: 'customer-viewer' })
    expect(invited.status, JSON.stringify(invited.body)).toBe(200)
  })
})
