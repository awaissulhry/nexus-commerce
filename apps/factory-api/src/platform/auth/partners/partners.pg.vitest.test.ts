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
    expect(tab.body).toMatchObject({ kinds: ['CUSTOMER'], settings: { portalOn: true }, seats: { taken: 0, max: null }, termsInForce: null })
    expect(tab.body.settings).not.toHaveProperty('progressShared') // B-PR-40: the level is the limits card's
    // B-PR-13: + the customer Production role.
    expect(tab.body.roles.map((role: { key: string }) => role.key)).toEqual(['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-production', 'customer-viewer', 'customer-admin'])

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
    // B-W2b-180: the sign-in reaches the office's Portal access tab (its live line); the first one says so.
    expect(await events('partner_user.signed_in')).toEqual([{ userId: invited.body.invitation.userId, partyId: world.partyId, firstSignIn: true }])
    // B-W2b-180: Admin › Users lists the person as a partner of the party (audience, party, portal), never as an office person.
    const people = (await owner.get('/auth/users')).body.users as Array<Record<string, unknown>>
    expect(people.find((user) => user.id === invited.body.invitation.userId)).toMatchObject({ audience: 'PARTNER', partyId: world.partyId, partnerKind: 'CUSTOMER', accessUntil: null, status: 'ACTIVE' })
    expect(people.find((user) => user.id === ownerUser.id)).toMatchObject({ audience: 'OFFICE', partyId: null, partnerKind: null, accessUntil: null })
    expect((await bea.get('/portal/me')).body.permissions).toEqual([])
    await acknowledge(bea)
    // B-PR-13: the Buyer also sees production and marks orders urgent.
    expect((await bea.get('/portal/me')).body.permissions).toEqual(['files.read', 'money.price', 'portal.addresses.view', 'portal.approvals.view', 'portal.approve', 'portal.catalogue.view', 'portal.colleagues.view', 'portal.comment', 'portal.customerDocuments.conformity', 'portal.customerDocuments.view', 'portal.home.view', 'portal.orderRequests.manage', 'portal.production.urgency', 'portal.production.view', 'portal.returns.request', 'portal.returns.view', 'portal.salesOrders.ask', 'portal.salesOrders.view', 'portal.samples.view', 'portal.search', 'portal.upload', 'threads.read'])
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

    const narrowed = await asOwner('post', `/partners/${world.partyId}/settings`, { maxUsers: null, allowedRoleKeys: ['customer-viewer', 'customer-admin'], version: full.body.settings.version })
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200)
    expect(narrowed.body.settings).toMatchObject({ maxUsers: null, allowedRoleKeys: ['customer-viewer', 'customer-admin'] })
    const outside = await invite({ email: 'dan@brand-alpha.example', displayName: 'Dan', roleKey: 'customer-finance' })
    expect(outside.status).toBe(400)
    expect(outside.body.error.issues).toEqual([{ path: 'roleKey', message: "This organisation's portal offers only: Viewer, Admin." }])
    const changed = (await events('partner_portal.settings_changed')).at(-1)!
    expect(changed).toMatchObject({ partyId: world.partyId, fields: ['maxUsers', 'allowedRoleKeys'] })
    expect(changed).not.toHaveProperty('progressShared') // B-PR-40: no longer sent

    const stale = await asOwner('post', `/partners/${world.partyId}/settings`, { portalOn: true, version: full.body.settings.version })
    expect(stale.status).toBe(409)
    const supplier = await party(['SUPPLIER'])
    // B-PR-40: the old progress switch is gone from the settings: the field is refused (the level is the limits card's, and
    // that card is a customer's only).
    const refused = await asOwner('post', `/partners/${supplier}/settings`, { progressShared: true, version: 1 })
    expect(refused.status).toBe(400)
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
    // B-PR-13: + portal.production.view (a preview reads production, never the urgency mark).
    expect(me.body).toMatchObject({ preview: true, permissions: ['files.read', 'portal.addresses.view', 'portal.approvals.view', 'portal.catalogue.view', 'portal.colleagues.view', 'portal.complaints.view', 'portal.customerDocuments.conformity', 'portal.customerDocuments.finance', 'portal.customerDocuments.view', 'portal.home.view', 'portal.payments.view', 'portal.production.view', 'portal.returns.view', 'portal.salesOrders.view', 'portal.samples.view', 'portal.search', 'threads.read'] })
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

// ---- B-PR-14: a customer's production limits (the limits card) ---------------------------------------------------------------

describe("B-PR-14 a customer's production limits card (PW-S01, PW-08b, PW-15)", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const card = (partyId: string) => `/partners/${partyId}/production`
  async function asOwnerPut(url: string, body: Record<string, unknown>) {
    await stepUp(h, owner, ownerSecret)
    return owner.put(url, body)
  }
  const audits = async (partyId: string) =>
    (await h.db.admin.query(`SELECT action, before, after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'PortalSettings' AND "recordId" = $2 AND action = 'partners.changeProduction' ORDER BY at, id`, [tenant.id, partyId])).rows as { action: string; before: Record<string, unknown> | null; after: Record<string, unknown> }[]
  /** A made-up office person limited to one customer (a sales rep of that customer only), signed in. */
  async function repOf(partyId: string, email: string): Promise<Browser> {
    const person = await addUser(h, tenant, { email })
    await inWorld(h, world, async (client) => {
      const role = await client.role.findFirstOrThrow({ where: { key: 'sales', system: true }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: person.id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    })
    const browser = new Browser(h.app)
    expect((await browser.signIn(SLUG, person.email, person.password)).status).toBe(200)
    await enrolTotp(h, browser)
    return browser
  }

  it('reads the defaults (Status only, urgency off, quota 3, no asks, no supervisor); a write asks a step-up; the preset turns on Progress, urgency and every ask', async () => {
    const alpha = await party(['CUSTOMER'])
    const read = await owner.get(card(alpha))
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body).toMatchObject({
      party: { id: alpha },
      production: {
        level: 'STATUS',
        urgency: { on: false, max: 3, now: 0, dormant: null, overQuota: null },
        askKinds: [],
        openAsks: [],
        approver: null,
        overrideFourEyes: false,
        supervisor: null,
        backup: null,
        productionRoleOffered: true,
        productionRoleWords: null,
        version: 1,
      },
      mayManage: true,
    })

    // PW-S01: no step-up in the last 5 minutes: refused before anything is written.
    h.clock.advance(6 * 60_000)
    const held = await owner.put(card(alpha), { preset: 'PRODUCTION_PARTNER', version: 1 })
    expect(held.status).toBe(403)
    expect(held.body.error.issues).toEqual([expect.objectContaining({ path: 'stepUp' })])
    expect(await audits(alpha)).toEqual([])

    const preset = await asOwnerPut(card(alpha), { preset: 'PRODUCTION_PARTNER', version: 1 })
    expect(preset.status, JSON.stringify(preset.body)).toBe(200)
    expect(preset.body.production).toMatchObject({
      level: 'PROGRESS',
      urgency: { on: true, max: 3, now: 0 },
      askKinds: ['HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'],
      openAsks: ['RUSH', 'HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'],
      version: 2,
    })
    // B-PR-40: the old progress switch is gone from every answer: the card's level says it, not the Portal access tab or the list.
    expect(preset.body.production).not.toHaveProperty('progressShared')
    expect((await owner.get(`/partners/${alpha}`)).body.settings).not.toHaveProperty('progressShared')
    expect((await owner.get('/partners')).body.organisations.find((entry: { party: { id: string } }) => entry.party.id === alpha)).not.toHaveProperty('progressShared')
    // PW-S01: every change has its audit row.
    expect(await audits(alpha)).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ productionLevel: 'STATUS', productionUrgencyOn: false }),
        after: expect.objectContaining({ productionLevel: 'PROGRESS', productionUrgencyOn: true, productionAskKinds: ['HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'], preset: 'PRODUCTION_PARTNER' }),
      }),
    ])
    const event = (await events('partner_portal.settings_changed')).at(-1)!
    expect(event).toEqual({
      partyId: alpha,
      fields: ['productionLevel', 'productionUrgencyOn', 'productionAskKinds'],
      portalOn: true,
      productionLevel: 'PROGRESS',
      productionUrgencyOn: true,
      productionUrgentMax: 3,
      productionAskKinds: ['HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'],
    })
  })

  it('refuses in words: RUSH in the asks, a quota out of 0 to 20, a stale version, nothing to change, an approver of another organisation, a supplier', async () => {
    const beta = await party(['BRAND'])
    const rush = await asOwnerPut(card(beta), { productionAskKinds: ['RUSH'], version: 1 })
    expect(rush.status).toBe(400)
    expect(rush.body.error.issues).toEqual([{ path: 'body/productionAskKinds/0', message: '"Urgent – asked" follows the urgency switch, not this list.' }])
    expect((await asOwnerPut(card(beta), { productionUrgentMax: 21, version: 1 })).status).toBe(400)
    expect((await asOwnerPut(card(beta), { version: 1 })).status).toBe(400)
    expect((await asOwnerPut(card(beta), { productionLevel: 'GATES', version: 0 })).status).toBe(409)
    expect((await asOwnerPut(card(beta), { productionLevel: 'STATUS', version: 1 })).status).toBe(409)
    // Neutral: a person of another organisation reads as no person of this one.
    const other = newId()
    await inWorld(h, world, (client) =>
      client.user.create({ data: { id: other, email: 'omar@brand-alpha.example', displayName: 'Omar Other', status: 'ACTIVE', audience: 'PARTNER', partyId: world.partyId, partnerKind: 'CUSTOMER' }, select: { id: true } }),
    )
    const foreign = await asOwnerPut(card(beta), { productionApproverId: other, version: 1 })
    expect(foreign.status).toBe(400)
    expect(foreign.body.error.issues).toEqual([{ path: 'body/productionApproverId', message: "The approver is an active person of this customer's portal." }])
    expect(JSON.stringify(foreign.body)).not.toContain('Brand Alpha')
    const supplier = await party(['SUPPLIER'])
    const refused = await asOwnerPut(card(supplier), { productionUrgencyOn: true, version: 1 })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toBe('Production limits are set only for a customer or a brand.')
  })

  it("names the customer's own approver; switching urgency off keeps the marks (audited, R-46); a lower quota keeps them; a customer without a portal row gets one with the portal off", async () => {
    const gamma = await party(['CUSTOMER'])
    const approverId = newId()
    await inWorld(h, world, (client) =>
      client.user.create({ data: { id: approverId, email: 'paola@brand-gamma.example', displayName: 'Paola Approver', status: 'ACTIVE', audience: 'PARTNER', partyId: gamma, partnerKind: 'CUSTOMER' }, select: { id: true } }),
    )
    const named = await asOwnerPut(card(gamma), { preset: 'PRODUCTION_PARTNER', productionApproverId: approverId, overrideFourEyes: true, productionUrgentMax: 5, version: 1 })
    expect(named.status, JSON.stringify(named.body)).toBe(200)
    expect(named.body.production).toMatchObject({ approver: { id: approverId, name: 'Paola Approver', active: true }, overrideFourEyes: true, urgency: { on: true, max: 5 } })

    const off = await asOwnerPut(card(gamma), { productionUrgencyOn: false, version: 2 })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body.production).toMatchObject({ urgency: { on: false, max: 5, now: 0, dormant: null }, openAsks: ['HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'] })
    expect((await audits(gamma)).at(-1)!.after).toMatchObject({ productionUrgencyOn: false, urgencyMarksKept: 0, urgencyMarks: 'kept, not used while urgency is off' })

    const on = await asOwnerPut(card(gamma), { productionUrgencyOn: true, productionUrgentMax: 1, version: 3 })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body.production.urgency).toMatchObject({ on: true, max: 1, overQuota: null })

    // No portal row yet (no portal): the card makes one with the portal OFF; nobody can sign in through it.
    const delta = newId()
    await inWorld(h, world, (client) => client.party.create({ data: { id: delta, code: `P${delta.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Made-up Brand Delta S.r.l.', roles: ['BRAND'] }, select: { id: true } }))
    expect((await owner.get(card(delta))).body.production).toMatchObject({ level: 'STATUS', version: 0 })
    const made = await asOwnerPut(card(delta), { productionLevel: 'GATES', version: 0 })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    expect((await h.db.admin.query('SELECT "portalOn", "productionLevel"::text AS level FROM "PortalSettings" WHERE id = $1', [delta])).rows).toEqual([{ portalOn: false, level: 'GATES' }])
  })

  it("says when the customer's allowed roles leave out the Production role", async () => {
    const epsilon = await party(['CUSTOMER'])
    await inWorld(h, world, (client) => client.portalSettings.update({ where: { id: epsilon }, data: { allowedRoleKeys: ['customer-buyer', 'customer-viewer'] }, select: { id: true } }))
    expect((await owner.get(card(epsilon))).body.production).toMatchObject({ productionRoleOffered: false, productionRoleWords: { en: "The Production role is not among this customer's allowed roles: add it to give it to someone." } })
  })

  it('wall (PW-S01, PW-08b): a person limited to another customer gets 404 on this card, its write and its preview; its own card answers', async () => {
    const zeta = await party(['CUSTOMER'])
    const eta = await party(['CUSTOMER'])
    const rep = await repOf(eta, 'rep.eta@partners-a.example')
    for (const answer of [await rep.get(card(zeta)), await rep.put(card(zeta), { productionUrgencyOn: true, version: 1 }), await rep.post(`/partners/${zeta}/preview`, { companyId: world.companyId })]) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(404)
      expect(JSON.stringify(answer.body)).not.toContain(zeta)
    }
    const own = await rep.get(card(eta))
    expect(own.status, JSON.stringify(own.body)).toBe(200)
    // A sales rep keeps the card (partners.production.manage) of its own customer.
    expect(own.body.mayManage).toBe(true)
    expect(await audits(zeta)).toEqual([])
  })

  it('wall (PW-15): the supervisor and backup show on the office card by name only; the settings event and the preview carry none', async () => {
    const theta = await party(['CUSTOMER'])
    const backup = await addUser(h, tenant, { email: 'backup.theta@partners-a.example', role: 'production_manager' })
    await inWorld(h, world, (client) =>
      client.portalSettings.update({ where: { id: theta }, data: { productionSupervisorId: ownerUser.id, productionSupervisorSetAt: h.clock.now(), productionBackupId: backup.id }, select: { id: true } }),
    )
    const read = await owner.get(card(theta))
    expect(read.body.production).toMatchObject({ supervisor: { id: ownerUser.id, name: 'owner', active: true }, backup: { id: backup.id, active: true } })
    const changed = await asOwnerPut(card(theta), { productionLevel: 'QUALITY', version: read.body.production.version })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    const event = (await events('partner_portal.settings_changed')).at(-1)!
    expect(Object.keys(event).sort()).toEqual(['fields', 'partyId', 'portalOn', 'productionAskKinds', 'productionLevel', 'productionUrgencyOn', 'productionUrgentMax'])
    expect(JSON.stringify(event)).not.toContain(ownerUser.id)
    expect(JSON.stringify(event)).not.toContain(backup.id)
    const opened = await owner.post(`/partners/${theta}/preview`, { companyId: world.companyId })
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    for (const answer of [opened, await owner.get('/portal/me'), await owner.get('/portal/access')]) {
      const text = JSON.stringify(answer.body)
      expect(text).not.toMatch(/supervis|backup/i)
      expect(text).not.toContain(ownerUser.id)
      expect(text).not.toContain(backup.id)
    }
  })

  // ---- B-PR-15 (production plan, schema wave 3/5): "n urgent now" reads the customer's marks on BrandOrderProduction.
  it("B-PR-15: n urgent now counts the customer's own open orders marked Urgent — never a Regular one, never another customer's", async () => {
    const iota = await party(['CUSTOMER'])
    const kappa = await party(['CUSTOMER'])
    const order = async (partyId: string, urgency: 'URGENT' | 'REGULAR', urgentRank: number | null) => {
      const orderId = newId()
      await inWorld(h, world, async (client) => {
        await client.salesOrder.create({
          data: { id: orderId, companyId: world.companyId, partyId, number: `T-PR15-SO-${orderId.slice(-6)}`, status: 'CONFIRMED', orderDate: new Date('2026-11-02T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' } },
          select: { id: true },
        })
        await client.brandOrderProduction.create({
          data: { id: newId(), companyId: world.companyId, partyId, salesOrderId: orderId, key: `brand-production:${orderId}`, urgency, urgentRank, ...(urgency === 'URGENT' ? { urgencySetAt: h.clock.now(), urgencySetBy: 'BRAND' as const } : {}) },
          select: { id: true },
        })
      })
    }
    await order(iota, 'URGENT', 1)
    await order(iota, 'URGENT', 2)
    await order(iota, 'REGULAR', null)
    await order(kappa, 'URGENT', 1)
    const read = await owner.get(card(iota))
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.production.urgency).toMatchObject({ on: false, max: 3, now: 2 })
    // PW-11: another customer's mark never counts in this one's card, nor the other way round.
    expect((await owner.get(card(kappa))).body.production.urgency).toMatchObject({ now: 1 })
  })
  // ---- end B-PR-15
})
