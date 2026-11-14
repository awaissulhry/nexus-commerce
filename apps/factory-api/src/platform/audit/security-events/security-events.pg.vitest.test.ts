import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOCKOUT } from '@nexus/factory-domain/auth/lockout/lockout'
import { newId } from '@nexus/factory-domain/core/ids'
import { addTenant, addUser, Browser, enrolTotp, START, stepUp, startHarness, type Harness, type TestTenant, type TestUser } from '../../auth/sessions/testing/harness'
import { insertSecurityEvent } from './record'

/**
 * Security events always logged (B-W2b-399; PLT-075) on the real app, sign-in and routes: an address nobody has, wrong
 * passwords up to the lockout and a try while locked, a sign-in with the request's address hash, two-factor set up, a role
 * given, a refusal (once a minute, never "confirm with a fresh code first"); then the list and one event for administrators
 * only, over every company, with its filters (the design's saved views, an address typed); the floor and portal roles may
 * write their own; never an address or free text in the details.
 */

let h: Harness
let tenant: TestTenant
let admin: TestUser
let member: TestUser
let limited: TestUser
let adminBrowser: Browser
let adminSecret: string
const ADDRESS = '127.0.0.1'

type Event = { id: string; kind: string; surface: string; result: string; actor: { kind: string; id: string | null; name: string | null }; record: { type: string; id: string } | null; details: Record<string, unknown>; siteId: string | null; partyId: string | null }

/** Every event of the tenant, oldest first, as stored. */
const stored = () =>
  h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: tenant.id }, (client) =>
    client.securityEvent.findMany({ orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { id: true, kind: true, surface: true, actorId: true, ipHash: true, recordType: true, recordId: true, details: true, siteId: true, partyId: true } }),
  )
const newest = async (kind: string) => (await stored()).filter((event) => event.kind === kind).at(-1)

beforeAll(async () => {
  h = await startHarness('audit_sec_events')
  h.clock.set(START)
  tenant = await addTenant(h, 'secev', 2)
  admin = await addUser(h, tenant, { email: 'admin.demo@example.com', role: 'admin' })
  member = await addUser(h, tenant, { email: 'member.demo@example.com', role: 'read_only' })
  limited = await addUser(h, tenant, { email: 'limited.demo@example.com' })
  // An administrator of one company only: never the security events (they are about the whole group).
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: limited.id }, async (client) => {
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key: 'admin' } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: limited.id, roleId: role.id, allCompanies: false, companyIds: [tenant.companies[0]!.id], validFrom: new Date(START) } })
  })
}, 120_000)

afterAll(async () => {
  await h?.close()
})

describe('every sign-in, refused or not, is an event', () => {
  it('an address nobody has: SIGN_IN_FAILED by nobody known, after the answer, with the address only as its keyed hash', async () => {
    const answer = await new Browser(h.app).signIn('secev', 'nobody.here@example.com', 'wrong-but-long-enough')
    expect(answer.status).toBe(401)
    await h.auth.settled()
    const event = await newest('SIGN_IN_FAILED')
    expect(event).toMatchObject({ surface: 'OFFICE', actorId: null, ipHash: h.auth.secrets.ipHash(ADDRESS), details: { reason: 'UNKNOWN_ACCOUNT' } })
    expect(JSON.stringify(await stored())).not.toContain('@')
    // A tenant nobody has: nothing to write into, nothing written.
    const before = (await stored()).length
    expect((await new Browser(h.app).signIn('no-such-group', 'member.demo@example.com', 'x'.repeat(12))).status).toBe(401)
    await h.auth.settled()
    expect((await stored()).length).toBe(before)
  })

  it('wrong passwords count to the lockout (LOCKOUT ACCOUNT), and a try while locked is refused as LOCKED', async () => {
    const browser = new Browser(h.app)
    for (let attempt = 1; attempt <= LOCKOUT.maxFailures; attempt += 1) expect((await browser.signIn('secev', member.email, 'not-the-password-1')).status).toBe(401)
    const failed = (await stored()).filter((event) => event.kind === 'SIGN_IN_FAILED' && event.actorId === member.id)
    expect(failed.map((event) => event.details)).toEqual(Array.from({ length: LOCKOUT.maxFailures }, (_, index) => ({ reason: 'WRONG_PASSWORD', failedAttempts: index + 1 })))
    expect(await newest('LOCKOUT')).toMatchObject({ actorId: member.id, surface: 'OFFICE', recordType: 'User', recordId: member.id, details: { what: 'ACCOUNT' } })
    expect((await browser.signIn('secev', member.email, member.password)).status).toBe(401)
    await h.auth.settled()
    expect(await newest('SIGN_IN_FAILED')).toMatchObject({ actorId: member.id, details: { reason: 'LOCKED' } })
    h.clock.advance(LOCKOUT.firstLockMs + 1_000)
  })

  it('a sign-in is SIGN_IN with the session and the address hash; two-factor set up is MFA_CHANGED', async () => {
    const browser = new Browser(h.app)
    expect((await browser.signIn('secev', member.email, member.password)).status).toBe(200)
    expect(await newest('SIGN_IN')).toMatchObject({ actorId: member.id, surface: 'OFFICE', recordType: 'Session', ipHash: h.auth.secrets.ipHash(ADDRESS), details: { secondFactor: 'NONE' } })
    adminBrowser = new Browser(h.app)
    expect((await adminBrowser.signIn('secev', admin.email, admin.password)).status).toBe(200)
    adminSecret = await enrolTotp(h, adminBrowser)
    expect(await newest('MFA_CHANGED')).toMatchObject({ actorId: admin.id, details: { change: 'SET_UP' } })
  })

  it('a role given is ROLE_CHANGED on the assignment', async () => {
    await stepUp(h, adminBrowser, adminSecret)
    const role = await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: admin.id }, (client) => client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key: 'sales' } }, select: { id: true } }))
    const given = await adminBrowser.post(`/auth/users/${member.id}/roles`, { roleId: role.id, allCompanies: true })
    expect(given.status, JSON.stringify(given.body)).toBe(200)
    expect(await newest('ROLE_CHANGED')).toMatchObject({ actorId: admin.id, recordType: 'RoleAssignment', details: { change: 'roles.assign' } })
  })
})

describe('a refusal is PERMISSION_DENIED', () => {
  it('the route and the permission, once a minute for the same person and route; "a fresh code first" is no refusal', async () => {
    const browser = new Browser(h.app)
    expect((await browser.signIn('secev', member.email, member.password)).status).toBe(200)
    const count = async () => (await stored()).filter((event) => event.kind === 'PERMISSION_DENIED').length
    const before = await count()
    expect((await browser.get('/audit/security-events')).status).toBe(403)
    expect(await newest('PERMISSION_DENIED')).toMatchObject({ actorId: member.id, surface: 'OFFICE', recordType: null, details: { route: 'GET /audit/security-events', permission: 'security.events.view' } })
    expect((await browser.get('/audit/security-events')).status).toBe(403)
    expect(await count()).toBe(before + 1)
    h.clock.advance(61_000)
    expect((await browser.get('/audit/security-events')).status).toBe(403)
    expect(await count()).toBe(before + 2)
    // The administrator without a fresh code: 403 stepUp, no refusal recorded.
    h.clock.advance(6 * 60_000)
    const role = await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: admin.id }, (client) => client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key: 'warehouse' } }, select: { id: true } }))
    const asked = await adminBrowser.post(`/auth/users/${member.id}/roles`, { roleId: role.id, allCompanies: true })
    expect(asked.status).toBe(403)
    expect(asked.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect(await count()).toBe(before + 2)
  })
})

describe('reading the events: administrators and the Owner only', () => {
  it('newest first, who by name (an office person), the result, the record; the saved views; an address typed', async () => {
    const all = await adminBrowser.get('/audit/security-events?limit=200')
    expect(all.status, JSON.stringify(all.body)).toBe(200)
    const events = all.body.events as Event[]
    expect(events.length).toBe((await stored()).length)
    expect(events[0]!.kind).toBe('PERMISSION_DENIED')
    const signIn = events.find((event) => event.kind === 'SIGN_IN' && event.actor.id === member.id)!
    expect(signIn).toMatchObject({ result: 'SUCCEEDED', surface: 'OFFICE', actor: { kind: 'PERSON', name: 'member demo' }, record: { type: 'Session' } })
    expect(events.find((event) => event.kind === 'SIGN_IN_FAILED' && event.actor.id === null)).toMatchObject({ result: 'REFUSED', actor: { kind: 'NOBODY', name: null } })
    expect(events.find((event) => event.kind === 'LOCKOUT')).toMatchObject({ result: 'LOCKED' })

    const failed = (await adminBrowser.get('/audit/security-events?view=failed-sign-ins&limit=200')).body.events as Event[]
    expect(new Set(failed.map((event) => event.kind))).toEqual(new Set(['SIGN_IN_FAILED', 'LOCKOUT']))
    const signIns = (await adminBrowser.get(`/audit/security-events?kind=SIGN_IN,MFA_CHANGED&actorId=${admin.id}`)).body.events as Event[]
    expect(signIns.map((event) => event.kind).sort()).toEqual(['MFA_CHANGED', 'SIGN_IN'])
    expect(((await adminBrowser.get(`/audit/security-events?ip=${ADDRESS}&limit=200`)).body.events as Event[]).length).toBe(events.length)
    expect(((await adminBrowser.get('/audit/security-events?ip=10.9.8.7')).body.events as Event[]).length).toBe(0)
    expect((await adminBrowser.get('/audit/security-events?ip=not-an-address')).status).toBe(400)
    expect((await adminBrowser.get('/audit/security-events?kind=SIGN_IN,NOT_A_KIND')).status).toBe(400)

    const page = await adminBrowser.get('/audit/security-events?limit=2')
    const next = await adminBrowser.get(`/audit/security-events?limit=2&before=${page.body.nextBefore}`)
    expect([...page.body.events, ...next.body.events].map((event: Event) => event.id)).toEqual(events.slice(0, 4).map((event) => event.id))

    const one = await adminBrowser.get(`/audit/security-events/${signIn.id}`)
    expect(one.status).toBe(200)
    expect(one.body.event).toEqual(signIn)
    // B-W2b-413: the other events from the same address around it (every event here came from one address), never itself.
    expect((one.body.related as Event[]).length).toBe(Math.min(events.length - 1, 20))
    expect((one.body.related as Event[]).some((event) => event.id === signIn.id)).toBe(false)
    expect((await adminBrowser.get(`/audit/security-events/${newId()}`)).status).toBe(404)
    // Rows, never a figure.
    expect(Object.keys(all.body).sort()).toEqual(['events', 'nextBefore'])
  })

  it('refused to the read-only role and to an administrator of one company', async () => {
    const browser = new Browser(h.app)
    expect((await browser.signIn('secev', member.email, member.password)).status).toBe(200)
    expect((await browser.get('/audit/security-events')).status).toBe(403)
    const oneCompany = new Browser(h.app)
    expect((await oneCompany.signIn('secev', limited.email, limited.password)).status).toBe(200)
    await enrolTotp(h, oneCompany)
    const refused = await oneCompany.get('/audit/security-events')
    expect(refused.status).toBe(403)
    expect(refused.body.error.message).toContain('over every company')
  })
})

describe('the floor and the portal write their own; the office reads them', () => {
  it('a floor device’s site, a party’s portal; a floor worker is never named', async () => {
    const site = newId()
    const party = newId()
    await h.db.admin.query(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'SE1', 'Test plant', 'PLANT')`, [site, tenant.id, tenant.companies[0]!.id])
    const worker = newId()
    await h.database.withScope({ audience: 'floor', tenantId: tenant.id, siteId: site, actorId: newId() }, (client) =>
      insertSecurityEvent(client, { kind: 'SIGN_IN_FAILED', surface: 'FLOOR', siteId: site, actorId: worker, ipHash: null, details: { reason: 'UNKNOWN_BADGE', note: 'a@b.c' } }),
    )
    await h.database.withScope({ audience: 'partner', tenantId: tenant.id, partyId: party, actorId: newId() }, (client) =>
      insertSecurityEvent(client, { kind: 'SIGN_IN_FAILED', surface: 'PORTAL', partyId: party, actorId: null, ipHash: null, details: { reason: 'UNKNOWN_ACCOUNT' } }),
    )
    const floor = ((await adminBrowser.get('/audit/security-events?surface=FLOOR')).body.events as Event[])[0]!
    expect(floor).toMatchObject({ siteId: site, actor: { kind: 'WORKER', id: worker, name: null }, details: { reason: 'UNKNOWN_BADGE' } })
    expect(floor.details).not.toHaveProperty('note')
    expect(((await adminBrowser.get('/audit/security-events?surface=PORTAL')).body.events as Event[])[0]).toMatchObject({ partyId: party, actor: { kind: 'NOBODY' } })
  })
})
