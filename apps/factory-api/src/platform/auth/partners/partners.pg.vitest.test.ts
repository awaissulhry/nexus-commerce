import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { textOf } from '../../../adapters/ses/fake'
import type { Log } from '../../../core/queue'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../portal/service'
import { freshGuard, inWorld, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../portal/testing/portal'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant, type TestUser } from '../sessions/testing/harness'
import { noticeAccessEnding } from './access-ending'

/**
 * Partner organisations, their people and roles on the local stack (B-W2b-162; PLT-006, PLT-021, PLT-022, SAL-060,
 * SCM-092), through the real app: the office invites from a party's Portal access (step-up, GATE-PRIVACY, the limits), the
 * first sign-in gives the partner roles, the partner's admin manages colleagues with an e-mail step-up, the switch and
 * limits, the production-progress switch (C1), the office preview (read-only, audited), and time-boxed access ending by
 * itself with one "access ends soon" notice. The harness clock starts at the real time (the code guard compares expiry
 * with the database's now()) and only moves forward.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
let owner: Browser
let ownerSecret: string
let ownerUser: TestUser
const SLUG = 'partners-a'
const lines: string[] = []
const log: Log = { info: (_fields, message) => void lines.push(message), warn: (_fields, message) => void lines.push(message), error: (_fields, message) => void lines.push(message) }

beforeAll(async () => {
  h = await startHarness('auth_partners')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  tenant = await addTenant(h, SLUG, 2)
  world = await portalWorld(h, tenant)
  ownerUser = await addUser(h, tenant, { email: 'owner@partners-a.example', role: 'owner' })
  owner = new Browser(h.app)
  await owner.signIn(SLUG, ownerUser.email, ownerUser.password)
  ownerSecret = await enrolTotp(h, owner)
}, 120_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

async function asOwner(method: 'post' | 'patch', url: string, body: Record<string, unknown> = {}) {
  await stepUp(h, owner, ownerSecret)
  return method === 'patch' ? owner.send('PATCH' as never, url, body) : owner.post(url, body)
}

const invite = (body: Record<string, unknown>, partyId = world.partyId) => asOwner('post', `/partners/${partyId}/people`, { companyId: world.companyId, ...body })

/** Signs a partner in by code (company C1's portal); returns the browser with its portal cookie. */
async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  // The tenant has two companies: the sign-in names the portal's (C1).
  expect((await browser.post('/portal/signin/start', { tenant: SLUG, company: 'C1', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: SLUG, company: 'C1', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return browser
}

/** The first visit: the portal terms in force acknowledged (the session's grants start here). */
async function acknowledge(browser: Browser): Promise<void> {
  const terms = await browser.get('/portal/terms?locale=en')
  const done = await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })
  expect(done.status).toBe(200)
}

/** A fresh step-up by e-mail code on a portal session (a new code at most once a minute: the clock moves on first). */
async function portalStepUp(browser: Browser, email: string): Promise<void> {
  h.clock.advance(61_000)
  expect((await browser.post('/portal/step-up/start')).status).toBe(200)
  const proved = await browser.post('/portal/step-up', { code: mailedCode(h, email, 'auth.portal_step_up')!.code })
  expect(proved.status, JSON.stringify(proved.body)).toBe(200)
}

const invitationMails = (to: string) => h.ses.mails.filter((mail) => mail.templateKey === 'auth.portal_invitation' && mail.to[0] === to)
const events = async (type: string) =>
  (await h.db.admin.query('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [tenant.id, type])).rows.map((row) => row.payload as Record<string, unknown>)
const versionOf = async (userId: string) => inWorld(h, world, async (client) => (await client.user.findUniqueOrThrow({ where: { id: userId }, select: { version: true } })).version)

async function party(roles: string[], portalOn = true): Promise<string> {
  const id = newId()
  await inWorld(h, world, async (client) => {
    await client.party.create({ data: { id, code: `P${id.slice(-6)}`, kind: 'ORGANISATION', legalName: `Made-up ${roles.join(' ')} S.r.l.`, roles: roles as never }, select: { id: true } })
    await client.portalSettings.create({ data: { id, partyId: id, portalOn }, select: { id: true } })
  })
  return id
}

describe('the office invites; the first sign-in gives the role (SAL-060, PLT-006)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('shows the Portal access, invites a buyer with a step-up, mails the sign-in page, and the sign-in gives the roles', async () => {
    const tab = await owner.get(`/partners/${world.partyId}`)
    expect(tab.status).toBe(200)
    expect(tab.body).toMatchObject({ kinds: ['CUSTOMER'], settings: { portalOn: true, progressShared: false }, seats: { taken: 0, max: null }, termsInForce: null })
    expect(tab.body.roles.map((role: { key: string }) => role.key)).toEqual(['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer', 'customer-admin'])

    const email = 'bea@brand-alpha.example'
    // No step-up in the last 5 minutes: refused before anything is written.
    h.clock.advance(6 * 60_000)
    expect((await owner.post(`/partners/${world.partyId}/people`, { email, displayName: 'Bea Buyer', roleKey: 'customer-buyer', companyId: world.companyId })).status).toBe(403)
    const invited = await invite({ email, displayName: 'Bea Buyer', roleKey: 'customer-buyer' })
    expect(invited.status, JSON.stringify(invited.body)).toBe(200)
    expect(invited.body).toMatchObject({ delivery: 'sent', invitation: { email, roleKeys: ['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve'], accessUntil: null } })
    const [mail] = invitationMails(email)
    expect(mail).toBeDefined()
    const text = textOf(mail!.raw)
    expect(text).toContain(`/p/signin?tenant=${SLUG}&company=C1`)
    expect(text).toContain('con il ruolo Buyer')
    expect(await events('partner_user.invited')).toEqual([expect.objectContaining({ userId: invited.body.invitation.userId, partyId: world.partyId, kind: 'CUSTOMER', roleKey: 'customer-buyer', byPartner: false })])

    const bea = await signedIn(email)
    expect((await bea.get('/portal/me')).body.permissions).toEqual([])
    await acknowledge(bea)
    expect((await bea.get('/portal/me')).body.permissions).toEqual(['files.read', 'money.price', 'portal.approve', 'portal.colleagues.view', 'portal.comment', 'portal.home.view', 'portal.salesOrders.view', 'portal.search', 'portal.upload', 'threads.read'])
    const access = await bea.get('/portal/access')
    expect(access.body).toMatchObject({ kind: 'CUSTOMER', role: { key: 'customer-buyer', name: 'Buyer', seesPrices: true, admin: false }, capabilities: ['comment', 'upload', 'approve'], admins: [], preview: false })
    const team = await bea.get('/portal/colleagues')
    expect(team.body).toMatchObject({ canManage: false, roles: [], seats: null, people: [expect.objectContaining({ displayName: 'Bea Buyer', email: null, roleName: 'Buyer' })] })
    expect((await bea.post('/portal/colleagues', { email: 'x@brand-alpha.example', displayName: 'X', roleKey: 'customer-viewer' })).status).toBe(403)
  })

  it('refuses in words: someone with access, an office address, a role of another kind, a capability the role lacks, no company named', async () => {
    const officePerson = await addUser(h, tenant, { email: 'clerk@partners-a.example' })
    const cases: [Record<string, unknown>, number, string][] = [
      [{ email: 'bea@brand-alpha.example', displayName: 'Bea', roleKey: 'customer-viewer' }, 409, 'already has access'],
      [{ email: officePerson.email, displayName: 'Clerk', roleKey: 'customer-viewer' }, 409, 'person of the Office'],
      [{ email: 'sam@brand-alpha.example', displayName: 'Sam', roleKey: 'supplier-orders' }, 400, 'not valid'],
      [{ email: 'sam@brand-alpha.example', displayName: 'Sam', roleKey: 'customer-viewer', capabilities: ['approve'] }, 400, 'not valid'],
    ]
    for (const [body, status, words] of cases) {
      const answer = await invite(body)
      expect(answer.status, JSON.stringify(answer.body)).toBe(status)
      expect(answer.body.error.message).toContain(words)
    }
    const nobody = await asOwner('post', `/partners/${world.partyId}/people`, { email: 'sam@brand-alpha.example', displayName: 'Sam', roleKey: 'customer-viewer' })
    expect(nobody.status).toBe(400)
    expect(nobody.body.error.issues).toEqual([expect.objectContaining({ path: 'companyId' })])
    // GATE-PRIVACY: company C2 has no portal terms published.
    const noTerms = await invite({ email: 'sam@brand-alpha.example', displayName: 'Sam', roleKey: 'customer-viewer', companyId: tenant.companies[1]!.id })
    expect(noTerms.status).toBe(409)
    expect(noTerms.body.error.message).toContain('portal terms of this company are not published')
    // The office's own role screen never gives a portal role.
    const roleId = await inWorld(h, world, async (client) => (await client.role.findFirstOrThrow({ where: { key: 'customer-buyer', system: true }, select: { id: true } })).id)
    const given = await asOwner('post', `/auth/users/${officePerson.id}/roles`, { roleId, allCompanies: true })
    expect(given.status).toBe(400)
    expect(JSON.stringify(given.body)).toContain('A portal role is given to a customer')
  })
})

describe("the limits: seats, allowed roles, the production-progress switch (PLT-021, C1)", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('keeps the seats and the allowed roles; production progress only for a customer; a stale version is refused', async () => {
    const before = (await owner.get(`/partners/${world.partyId}`)).body
    const full = await asOwner('post', `/partners/${world.partyId}/settings`, { maxUsers: before.seats.taken, version: before.settings.version })
    expect(full.status, JSON.stringify(full.body)).toBe(200)
    const noSeat = await invite({ email: 'dan@brand-alpha.example', displayName: 'Dan', roleKey: 'customer-viewer' })
    expect(noSeat.status).toBe(409)
    expect(noSeat.body.error.message).toContain(`holds at most ${before.seats.taken}`)

    const narrowed = await asOwner('post', `/partners/${world.partyId}/settings`, { maxUsers: null, allowedRoleKeys: ['customer-viewer', 'customer-admin'], progressShared: true, version: full.body.settings.version })
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200)
    expect(narrowed.body.settings).toMatchObject({ maxUsers: null, allowedRoleKeys: ['customer-viewer', 'customer-admin'], progressShared: true })
    const outside = await invite({ email: 'dan@brand-alpha.example', displayName: 'Dan', roleKey: 'customer-finance' })
    expect(outside.status).toBe(400)
    expect(outside.body.error.issues).toEqual([{ path: 'roleKey', message: "This organisation's portal offers only: Viewer, Admin." }])
    expect((await events('partner_portal.settings_changed')).at(-1)).toMatchObject({ partyId: world.partyId, fields: ['progressShared', 'maxUsers', 'allowedRoleKeys'], progressShared: true })

    const stale = await asOwner('post', `/partners/${world.partyId}/settings`, { portalOn: true, progressShared: false, version: full.body.settings.version })
    expect(stale.status).toBe(409)
    const supplier = await party(['SUPPLIER'])
    const refused = await asOwner('post', `/partners/${supplier}/settings`, { progressShared: true, version: 1 })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('only to a customer or a brand')
    const wrongKind = await invite({ email: 'eve@supplier.example', displayName: 'Eve', roleKey: 'customer-viewer', kind: 'CUSTOMER' }, supplier)
    expect(wrongKind.status).toBe(409)
    expect(wrongKind.body.error.message).toContain('not a customer')
  })
})

describe("the partner's admin manages colleagues with a step-up (SAL-059, SAL-069, SCM-092)", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('invites, raises a role and deactivates within the limits; never its own access', async () => {
    const adaEmail = 'ada@brand-alpha.example'
    expect((await invite({ email: adaEmail, displayName: 'Ada Admin', roleKey: 'customer-admin' })).status).toBe(200)
    const ada = await signedIn(adaEmail)
    await acknowledge(ada)
    const team = await ada.get('/portal/colleagues')
    expect(team.body).toMatchObject({ canManage: true, seats: { max: null } })
    expect(team.body.roles.filter((role: { offered: boolean }) => role.offered).map((role: { key: string }) => role.key)).toEqual(['customer-viewer', 'customer-admin'])
    expect(team.body.admins).toEqual([expect.objectContaining({ displayName: 'Ada Admin' })])

    const carl = { email: 'carl@brand-alpha.example', displayName: 'Carl', roleKey: 'customer-viewer' }
    const held = await ada.post('/portal/colleagues', carl)
    expect(held.status).toBe(403)
    expect(held.body.error.issues).toEqual([expect.objectContaining({ path: 'stepUp' })])
    await portalStepUp(ada, adaEmail)
    const invited = await ada.post('/portal/colleagues', carl)
    expect(invited.status, JSON.stringify(invited.body)).toBe(200)
    expect(invited.body.invitation.roleKeys).toEqual(['customer-viewer'])
    expect(invitationMails(carl.email)).toHaveLength(1)
    expect(textOf(invitationMails(carl.email)[0]!.raw)).toContain('Ada Admin (Brand Alpha)')

    const carlId = invited.body.invitation.userId as string
    // Not offered any more (the office narrowed the roles): refused; the offered admin role is fine.
    expect((await ada.send('PATCH' as never, `/portal/colleagues/${carlId}`, { roleKey: 'customer-quality', version: await versionOf(carlId) })).status).toBe(400)
    const raised = await ada.send('PATCH' as never, `/portal/colleagues/${carlId}`, { roleKey: 'customer-admin', version: await versionOf(carlId) })
    expect(raised.status, JSON.stringify(raised.body)).toBe(200)
    expect(raised.body.roleKeys).toEqual(['customer-admin'])
    const adaId = team.body.me as string
    const own = await ada.send('PATCH' as never, `/portal/colleagues/${adaId}`, { roleKey: 'customer-viewer', version: await versionOf(adaId) })
    expect(own.status).toBe(403)

    const beaId = (await inWorld(h, world, (client) => client.user.findFirstOrThrow({ where: { email: 'bea@brand-alpha.example' }, select: { id: true } }))).id
    const bea = await signedIn('bea@brand-alpha.example')
    const gone = await ada.post(`/portal/colleagues/${beaId}/deactivate`, { version: await versionOf(beaId) })
    expect(gone.status, JSON.stringify(gone.body)).toBe(200)
    expect(gone.body).toMatchObject({ status: 'DEACTIVATED', sessionsEnded: expect.any(Number) })
    expect((await bea.get('/portal/me')).status).toBe(401)
    expect((await events('partner_user.changed')).at(-1)).toMatchObject({ userId: beaId, changes: ['DEACTIVATED'], status: 'DEACTIVATED', byPartner: true })
  })
})

describe('preview as the partner (read-only, every preview audited)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('opens the portal in the office browser with the reads its people have, refuses a write, and keeps the office session', async () => {
    const opened = await owner.post(`/partners/${world.partyId}/preview`, { companyId: world.companyId })
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body).toMatchObject({ party: { id: world.partyId, name: 'Brand Alpha' }, company: { code: 'C1' } })
    const me = await owner.get('/portal/me')
    expect(me.body).toMatchObject({ preview: true, permissions: ['files.read', 'portal.colleagues.view', 'portal.home.view', 'portal.payments.view', 'portal.salesOrders.view', 'portal.search', 'threads.read'] })
    expect((await owner.get('/portal/colleagues')).body).toMatchObject({ canManage: false })
    const write = await owner.post('/portal/colleagues', { email: 'x@brand-alpha.example', displayName: 'X', roleKey: 'customer-viewer' })
    expect(write.status).toBe(403)
    expect((await owner.get(`/partners/${world.partyId}`)).status).toBe(200)
    const audited = await h.db.admin.query('SELECT "recordType", "actorId"::text AS actor FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2', [tenant.id, 'partners.preview'])
    expect(audited.rows).toEqual([{ recordType: 'Party', actor: ownerUser.id }])
  })
})

describe('time-boxed access (PLT-022)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('asks an adviser for an end, tells them once 7 days before, and ends the access by itself', async () => {
    const studio = await party(['CONSULTANT'])
    const email = 'gina@studio.example'
    const without = await invite({ email, displayName: 'Gina', roleKey: 'guest-accountant' }, studio)
    expect(without.status).toBe(400)
    expect(without.body.error.issues).toEqual([{ path: 'accessUntil', message: "An adviser's access always ends: give the date." }])
    const until = new Date(h.clock.now().getTime() + 5 * 24 * 60 * 60_000)
    const invited = await invite({ email, displayName: 'Gina', roleKey: 'guest-accountant', accessUntil: until.toISOString() }, studio)
    expect(invited.status, JSON.stringify(invited.body)).toBe(200)
    const gina = await signedIn(email)
    await acknowledge(gina)
    expect((await gina.get('/portal/access')).body).toMatchObject({ kind: 'GUEST', role: { key: 'guest-accountant' }, capabilities: ['comment'], accessEndsSoon: true })

    expect(await noticeAccessEnding({ database: h.database, log, clock: h.clock })).toBe(1)
    expect(await noticeAccessEnding({ database: h.database, log, clock: h.clock })).toBe(0)
    expect(h.ses.mails.filter((mail) => mail.templateKey === 'auth.portal_access_ending' && mail.to[0] === email)).toHaveLength(1)
    expect((await events('partner_user.access_ending')).map((payload) => payload.userId)).toEqual([invited.body.invitation.userId])
    const listed = await owner.get('/partners')
    expect(listed.body.counts.accessEndingSoon).toBe(1)

    // The end passes: the next request of the session is refused (the authenticator reads it on every request).
    await inWorld(h, world, (client) => client.user.update({ where: { id: invited.body.invitation.userId }, data: { accessUntil: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } }))
    expect((await gina.get('/portal/me')).status).toBe(401)
  })
})
