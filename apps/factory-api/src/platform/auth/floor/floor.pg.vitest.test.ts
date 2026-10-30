import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../sessions/testing/harness'
import { DEVICE_COOKIE, FLOOR_COOKIE } from './cookies'

/**
 * Floor sign-in on the local stack (features PLT-018, PLT-019, PLT-056, PLT-057, PLT-058, PLT-060, PLT-062, PLT-226,
 * MES-276), through the real app, the real authenticator and the FLOOR database role: a device is enrolled once by its
 * one-time code; a sign-in needs the device token; wrong PINs lock the worker after five, not the device; one operator
 * per device and "switch operator"; the idle and shift ends; a revoked device or badge, a deactivated worker and a PIN
 * reset end sessions; the grants come from floor roles only, with at most wages; a floor session reads only its own
 * site and no hidden column; no biometric, personal or monitoring field exists; the tenant wall holds. The clock only
 * moves forward.
 */

let h: Harness
let alpha: TestTenant
let beta: TestTenant
let p1: Site
let p2: Site
let b1: Site
let office: Browser
let betaOffice: Browser

interface Site {
  readonly id: string
  readonly companyId: string
  readonly stationId: string
  readonly tenant: TestTenant
}

interface Tablet {
  readonly browser: Browser
  readonly deviceId: string
  readonly site: Site
}

interface TestWorker {
  readonly id: string
  readonly badgeCode: string
  readonly pin: string
}

const PIN = '482913'
/** The TOTP secret of each signed-in office browser: credential and floor-role changes need a fresh step-up. */
const totp = new Map<Browser, string>()
const stepped = (browser: Browser) => stepUp(h, browser, totp.get(browser)!)
const OTHER_PIN = '730561'
const admin = async (sql: string, values: unknown[] = []) => (await h.db.admin.query(sql, values)).rows as Record<string, any>[]

async function addSite(tenant: TestTenant, code: string): Promise<Site> {
  const companyId = tenant.companies[0]!.id
  const [siteId, centreId, stationId] = [newId(), newId(), newId()]
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
    await client.site.create({ data: { id: siteId, companyId, code, name: `Test plant ${code}`, kind: 'PLANT' } })
    await client.workCentre.create({ data: { id: centreId, companyId, siteId, code: 'CUT', name: 'Cutting', kind: 'CUTTING' } })
    await client.station.create({ data: { id: stationId, companyId, siteId, workCentreId: centreId, code: 'CUT-01', name: 'Cutting table 1' } })
  })
  return { id: siteId, companyId, stationId, tenant }
}

async function signedIn(tenant: TestTenant, email: string, role: string): Promise<Browser> {
  const user = await addUser(h, tenant, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(tenant.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  totp.set(browser, await enrolTotp(h, browser))
  return browser
}

const send = (browser: Browser, method: 'PUT' | 'PATCH', url: string, body: unknown) => browser.send(method as never, url, body)

async function roleId(tenant: TestTenant, key: string): Promise<string> {
  const [row] = await admin('SELECT id::text FROM "Role" WHERE "tenantId" = $1::uuid AND key = $2', [tenant.id, key])
  return row!.id
}

/** An enrolled tablet of a site (the Office makes the code, the tablet trades it). */
async function tablet(site: Site, by: Browser = office): Promise<Tablet> {
  const made = await by.post('/auth/floor/devices', { siteId: site.id, stationId: site.stationId, name: `Tablet ${newId().slice(-4)}` })
  if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
  const browser = new Browser(h.app)
  await browser.get('/auth/csrf')
  const enrolled = await browser.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
  if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
  return { browser, deviceId: made.body.device.id, site }
}

/** A worker of a site with floor roles, a badge (issued through the API) and a PIN (written straight in, peppered). */
async function worker(site: Site, name: string, roles: string[] = ['operator'], by: Browser = office, locale = 'it'): Promise<TestWorker> {
  const roleIds = await Promise.all(roles.map((key) => roleId(site.tenant, key)))
  await stepped(by)
  const made = await by.post('/auth/floor/workers', { siteId: site.id, displayName: name, locale, roleIds })
  if (made.status !== 200) throw new Error(`worker: ${made.status} ${JSON.stringify(made.body)}`)
  const badge = await by.post(`/auth/floor/workers/${made.body.id}/badges`)
  if (badge.status !== 200) throw new Error(`badge: ${badge.status} ${JSON.stringify(badge.body)}`)
  const pinHash = await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })
  await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1::uuid', [made.body.id, pinHash])
  return { id: made.body.id, badgeCode: badge.body.code, pin: PIN }
}

const signIn = (device: Tablet, who: TestWorker, pin = who.pin) => device.browser.post('/floor/sign-in', { badgeCode: who.badgeCode, pin })
const me = (device: Tablet) => device.browser.get('/floor/me')
const sessionRow = async (id: string) => (await admin('SELECT "endReason"::text AS reason, "endedAt" FROM "FloorSession" WHERE id = $1::uuid', [id]))[0]
const currentSession = async (deviceId: string) => (await admin('SELECT "currentSessionId"::text AS id FROM "Device" WHERE id = $1::uuid', [deviceId]))[0]!.id as string | null

beforeAll(async () => {
  h = await startHarness('auth_floor')
  alpha = await addTenant(h, 'alpha')
  beta = await addTenant(h, 'beta')
  p1 = await addSite(alpha, 'P1')
  p2 = await addSite(alpha, 'P2')
  b1 = await addSite(beta, 'B1')
  office = await signedIn(alpha, 'lead@example.com', 'floor_supervisor')
  betaOffice = await signedIn(beta, 'lead.beta@example.com', 'floor_supervisor')
}, 60_000)

afterAll(async () => {
  await h?.close()
})

describe('device enrolment (PLT-056)', () => {
  it('enrols a device once with a one-time QR code; the token is stored hashed', async () => {
    const made = await office.post('/auth/floor/devices', { siteId: p1.id, stationId: p1.stationId, name: 'Cutting tablet', kind: 'TABLET' })
    expect(made.status).toBe(200)
    expect(made.body.device).toMatchObject({ status: 'PENDING', siteId: p1.id, stationId: p1.stationId, inUse: false })
    const { code, url, qrSvg } = made.body.enrolment
    expect(url).toContain('/floor/enrol#token=')
    expect(qrSvg).toMatch(/^<svg/)
    const deviceId = made.body.device.id

    const first = new Browser(h.app)
    await first.get('/auth/csrf')
    const enrolled = await first.post('/floor/device/enrol', { code, appVersion: '1.0.0' })
    expect(enrolled.status).toBe(200)
    expect(enrolled.body).toMatchObject({ device: { id: deviceId, station: { code: 'CUT-01' } }, site: { id: p1.id }, defaultLocale: 'it', operatorSignedIn: false })
    const token = first.cookies.get(DEVICE_COOKIE)!
    expect(token.split('.').slice(0, 3)).toEqual([alpha.id, p1.id, deviceId])
    const [row] = await admin('SELECT status::text, "tokenHash", "enrolledAt", "appVersion" FROM "Device" WHERE id = $1::uuid', [deviceId])
    expect(row).toMatchObject({ status: 'ACTIVE', appVersion: '1.0.0' })
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row!.tokenHash).not.toContain(token.split('.')[3])

    // The code works once.
    const second = new Browser(h.app)
    await second.get('/auth/csrf')
    expect((await second.post('/floor/device/enrol', { code })).status).toBe(401)
    // The audit row is the device's own (audience FLOOR, its site, the device as actor and device).
    const [audit] = await admin(`SELECT audience::text, "actorId"::text AS actor, "deviceId"::text AS device, "siteId"::text AS site FROM "AuditLog" WHERE action = 'floor.enrolDevice' AND "recordId" = $1::uuid`, [deviceId])
    expect(audit).toEqual({ audience: 'FLOOR', actor: deviceId, device: deviceId, site: p1.id })
  })

  it('refuses an expired code; a new code retires the older one', async () => {
    const made = await office.post('/auth/floor/devices', { siteId: p1.id, name: 'Late tablet' })
    const renewed = await office.post(`/auth/floor/devices/${made.body.device.id}/enrolment`)
    expect(renewed.status).toBe(200)
    const browser = new Browser(h.app)
    await browser.get('/auth/csrf')
    expect((await browser.post('/floor/device/enrol', { code: made.body.enrolment.code })).status).toBe(401)
    h.clock.advance(16 * 60_000)
    expect((await browser.post('/floor/device/enrol', { code: renewed.body.enrolment.code })).status).toBe(401)
    expect((await office.get('/auth/floor/devices')).body.devices.find((device: { id: string }) => device.id === made.body.device.id)).toMatchObject({ status: 'PENDING' })
  })
})

describe('signing in needs the device token (PLT-057)', () => {
  it('refuses a sign-in without an enrolled device, with a forged token, or with another site in the token', async () => {
    const device = await tablet(p1)
    const ada = await worker(p1, 'Ada Test')
    const nobody = new Browser(h.app)
    await nobody.get('/auth/csrf')
    expect((await nobody.post('/floor/sign-in', { badgeCode: ada.badgeCode, pin: ada.pin })).status).toBe(401)
    expect((await nobody.get('/floor/device')).status).toBe(401)

    const real = device.browser.cookies.get(DEVICE_COOKIE)!
    const [tenantId, siteId, deviceId] = real.split('.')
    for (const forged of [`${tenantId}.${siteId}.${deviceId}.${'A'.repeat(43)}`, `${tenantId}.${p2.id}.${deviceId}.${real.split('.')[3]}`]) {
      nobody.cookies.set(DEVICE_COOKIE, forged)
      expect((await nobody.post('/floor/sign-in', { badgeCode: ada.badgeCode, pin: ada.pin })).status).toBe(401)
    }
    expect((await signIn(device, ada)).status).toBe(200)
  })

  it('a floor session cookie opens nothing without its device token', async () => {
    const device = await tablet(p1)
    const ben = await worker(p1, 'Ben Test')
    expect((await signIn(device, ben)).status).toBe(200)
    expect((await me(device)).status).toBe(200)
    const thief = new Browser(h.app)
    thief.cookies.set(FLOOR_COOKIE, device.browser.cookies.get(FLOOR_COOKIE)!)
    expect((await thief.get('/floor/me')).status).toBe(401)
    // Another enrolled device's token does not carry it either.
    const other = await tablet(p1)
    other.browser.cookies.set(FLOOR_COOKIE, device.browser.cookies.get(FLOOR_COOKIE)!)
    expect((await me(other)).status).toBe(401)
  })
})

describe('badge + PIN, name + PIN, and the lockout (PLT-057, PLT-058)', () => {
  it('signs in by badge or by name, in the worker\'s language', async () => {
    const device = await tablet(p1)
    const cleo = await worker(p1, 'Cleo Test', ['operator'], office, 'ro')
    const answer = await signIn(device, cleo)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ status: 'signed_in', worker: { id: cleo.id, displayName: 'Cleo Test', locale: 'ro' }, pinMustChange: false })
    expect((await me(device)).body).toMatchObject({ worker: { locale: 'ro' }, site: { id: p1.id }, device: { station: { code: 'CUT-01' } } })
    expect((await device.browser.post('/floor/sign-out')).status).toBe(200)

    const roster = (await device.browser.get('/floor/device')).body.roster as { id: string; displayName: string }[]
    expect(roster.map((entry) => entry.displayName)).toContain('Cleo Test')
    expect(Object.keys(roster[0]!).sort()).toEqual(['displayName', 'id', 'locale'])
    expect((await device.browser.post('/floor/sign-in', { workerId: cleo.id, pin: cleo.pin })).status).toBe(200)
    expect((await device.browser.post('/floor/sign-in', { workerId: cleo.id, badgeCode: cleo.badgeCode, pin: cleo.pin })).status).toBe(400)
  })

  it('locks the worker after five wrong PINs, not the device; the lock ends after minutes', async () => {
    const device = await tablet(p1)
    const dan = await worker(p1, 'Dan Test')
    const eve = await worker(p1, 'Eve Test')
    for (let attempt = 1; attempt <= 5; attempt++) {
      const answer = await signIn(device, dan, OTHER_PIN)
      expect(answer.status).toBe(401)
    }
    const [row] = await admin('SELECT "failedPinAttempts" AS n, "pinLockedUntil" AS until FROM "Worker" WHERE id = $1::uuid', [dan.id])
    expect(row!.n).toBe(5)
    expect(row!.until).not.toBeNull()
    // Locked: the right PIN opens nothing, with the same answer.
    const locked = await signIn(device, dan)
    expect(locked.status).toBe(401)
    expect(locked.body.error.message).toBe((await signIn(device, dan, OTHER_PIN)).body.error.message)
    // The device is not locked: the next person signs in.
    expect((await signIn(device, eve)).status).toBe(200)
    expect((await device.browser.post('/floor/sign-out')).status).toBe(200)
    h.clock.advance(5 * 60_000 + 1_000)
    expect((await signIn(device, dan)).status).toBe(200)
    expect((await admin('SELECT "failedPinAttempts" AS n FROM "Worker" WHERE id = $1::uuid', [dan.id]))[0]!.n).toBe(0)
    const wrong = await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'floor.signInFailed' AND "recordId" = $1::uuid AND audience = 'FLOOR'`, [dan.id])
    // Five wrong PINs counted; the attempts while locked were not checked, so not counted.
    expect(wrong[0]!.n).toBe(5)
  })
})

describe('one operator per device, and switch operator', () => {
  it('refuses a second operator; switch ends the first; the same worker replaces their own', async () => {
    const device = await tablet(p1)
    const fay = await worker(p1, 'Fay Test')
    const gus = await worker(p1, 'Gus Test')
    expect((await signIn(device, fay)).status).toBe(200)
    const faySession = await currentSession(device.deviceId)
    const fayCookie = device.browser.cookies.get(FLOOR_COOKIE)!

    // A sign-in from the same device while Fay is on: 409, Fay stays.
    const other = new Browser(h.app)
    other.cookies.set(DEVICE_COOKIE, device.browser.cookies.get(DEVICE_COOKIE)!)
    await other.get('/auth/csrf')
    expect((await other.post('/floor/sign-in', { badgeCode: gus.badgeCode, pin: gus.pin })).status).toBe(409)
    expect(await currentSession(device.deviceId)).toBe(faySession)

    // Switch operator from Fay's session: Gus is on, Fay's session ended.
    const switched = await device.browser.post('/floor/switch', { badgeCode: gus.badgeCode, pin: gus.pin })
    expect(switched.status).toBe(200)
    expect(switched.body.worker.id).toBe(gus.id)
    expect(await sessionRow(faySession!)).toMatchObject({ reason: 'SWITCHED' })
    expect((await me(device)).body.worker.id).toBe(gus.id)
    const stale = new Browser(h.app)
    stale.cookies.set(DEVICE_COOKIE, device.browser.cookies.get(DEVICE_COOKIE)!)
    stale.cookies.set(FLOOR_COOKIE, fayCookie)
    expect((await stale.get('/floor/me')).status).toBe(401)
    // A wrong PIN on a switch changes nothing.
    expect((await device.browser.post('/floor/switch', { badgeCode: fay.badgeCode, pin: OTHER_PIN })).status).toBe(401)
    expect((await me(device)).body.worker.id).toBe(gus.id)

    // Gus signs in again on the device: his own session is replaced.
    const gusSession = await currentSession(device.deviceId)
    expect((await signIn(device, gus)).status).toBe(200)
    expect(await sessionRow(gusSession!)).toMatchObject({ reason: 'REPLACED' })
    const open = await admin('SELECT count(*)::int AS n FROM "FloorSession" WHERE "deviceId" = $1::uuid AND "endedAt" IS NULL', [device.deviceId])
    expect(open[0]!.n).toBe(1)
  })

  it('only the device\'s current session is valid, even one not marked ended', async () => {
    const device = await tablet(p1)
    const kai = await worker(p1, 'Kai Test')
    expect((await signIn(device, kai)).status).toBe(200)
    expect((await me(device)).status).toBe(200)
    // The device names another session of its site as its current one: this cookie's session is no longer the operator.
    const mine = await currentSession(device.deviceId)
    const [other] = await admin('SELECT id::text FROM "FloorSession" WHERE "siteId" = $1::uuid AND id <> $2::uuid LIMIT 1', [p1.id, mine])
    await admin('UPDATE "Device" SET "currentSessionId" = $2::uuid WHERE id = $1::uuid', [device.deviceId, other!.id])
    expect((await me(device)).status).toBe(401)
    await admin('UPDATE "Device" SET "currentSessionId" = NULL WHERE id = $1::uuid', [device.deviceId])
    expect((await me(device)).status).toBe(401)
  })

  it('serializes two sign-ins on one device: one wins, the other is refused', async () => {
    const device = await tablet(p1)
    const hal = await worker(p1, 'Hal Test')
    const ivy = await worker(p1, 'Ivy Test')
    const twin = new Browser(h.app)
    twin.cookies.set(DEVICE_COOKIE, device.browser.cookies.get(DEVICE_COOKIE)!)
    await twin.get('/auth/csrf')
    await device.browser.get('/auth/csrf')
    const answers = await Promise.all([signIn(device, hal), twin.post('/floor/sign-in', { badgeCode: ivy.badgeCode, pin: ivy.pin })])
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409])
    const open = await admin('SELECT count(*)::int AS n FROM "FloorSession" WHERE "deviceId" = $1::uuid AND "endedAt" IS NULL', [device.deviceId])
    expect(open[0]!.n).toBe(1)
  })

  it('signs out: the session ends, the device stays enrolled', async () => {
    const device = await tablet(p1)
    const jo = await worker(p1, 'Jo Test')
    expect((await signIn(device, jo)).status).toBe(200)
    const sessionId = await currentSession(device.deviceId)
    const out = await device.browser.post('/floor/sign-out')
    expect(out.body).toEqual({ status: 'signed_out' })
    expect(device.browser.cookies.has(FLOOR_COOKIE)).toBe(false)
    expect(await sessionRow(sessionId!)).toMatchObject({ reason: 'SIGNED_OUT' })
    expect(await currentSession(device.deviceId)).toBeNull()
    expect((await device.browser.get('/floor/device')).body).toMatchObject({ operatorSignedIn: false })
  })
})

describe('idle sign-out (PLT-060)', () => {
  it('ends a session after the site\'s idle minutes without a request; use keeps it alive', async () => {
    expect((await send(office, 'PUT', `/auth/floor/sites/${p1.id}/settings`, { idleMinutes: 10, shiftEnds: [] })).status).toBe(200)
    const device = await tablet(p1)
    const kit = await worker(p1, 'Kit Test')
    expect((await signIn(device, kit)).status).toBe(200)
    const sessionId = await currentSession(device.deviceId)
    h.clock.advance(9 * 60_000)
    expect((await me(device)).status).toBe(200)
    h.clock.advance(9 * 60_000)
    expect((await me(device)).status).toBe(200)
    h.clock.advance(10 * 60_000 + 1_000)
    expect((await me(device)).status).toBe(401)
    // The next sign-in on the device closes the idle session.
    expect((await signIn(device, kit)).status).toBe(200)
    expect(await sessionRow(sessionId!)).toMatchObject({ reason: 'IDLE' })
  })

  it('checks the site settings', async () => {
    expect((await send(office, 'PUT', `/auth/floor/sites/${p1.id}/settings`, { idleMinutes: 0, shiftEnds: ['25:00'] })).status).toBe(400)
    expect((await office.get(`/auth/floor/sites/${p2.id}/settings`)).body).toEqual({ siteId: p2.id, idleMinutes: 10, shiftEnds: [], badgeOnlySignIn: false, timeZone: 'Europe/Rome', version: null })
  })
})

describe('badge alone starts work, as a site setting (Owner answer F1 a)', () => {
  const settingsOf = (site: Site) => office.get(`/auth/floor/sites/${site.id}/settings`)
  const badgeOnly = async (site: Site, on: boolean) => {
    const { body } = await settingsOf(site)
    const answer = await send(office, 'PUT', `/auth/floor/sites/${site.id}/settings`, { idleMinutes: body.idleMinutes, shiftEnds: body.shiftEnds, badgeOnlySignIn: on, ...(body.version ? { version: body.version } : {}) })
    expect(answer.status).toBe(200)
    return answer.body
  }
  const badgeAlone = (device: Tablet, who: TestWorker) => device.browser.post('/floor/sign-in', { badgeCode: who.badgeCode })
  const pinVerifiedAt = async (deviceId: string) =>
    (await admin('SELECT s."pinVerifiedAt" AS at FROM "FloorSession" s JOIN "Device" d ON d."currentSessionId" = s.id WHERE d.id = $1::uuid', [deviceId]))[0]!.at as Date | null
  let site: Site

  beforeAll(async () => {
    site = await addSite(alpha, 'F1')
  })

  it('is off by default: a badge without a PIN is a 400 that never looks at the badge; the office reads and writes the setting', async () => {
    const device = await tablet(site)
    const lia = await worker(site, 'Lia Test')
    expect((await settingsOf(site)).body).toMatchObject({ badgeOnlySignIn: false, version: null })
    expect((await device.browser.get('/floor/device')).body.signIn).toEqual({ badgeOnly: false })
    for (const badgeCode of [lia.badgeCode, 'NOT-A-BADGE']) {
      const answer = await device.browser.post('/floor/sign-in', { badgeCode })
      expect(answer.status).toBe(400)
      expect(answer.body.error.issues[0].path).toBe('pin')
    }
    expect(await currentSession(device.deviceId)).toBeNull()

    // On, with before and after in the audit row; left out of a later PUT, it stays as it is.
    expect(await badgeOnly(site, true)).toMatchObject({ badgeOnlySignIn: true, version: 1 })
    const [audit] = await admin(`SELECT "before", "after" FROM "AuditLog" WHERE action = 'devices.setFloorTimes' AND "recordId" = $1::uuid ORDER BY "at" DESC LIMIT 1`, [site.id])
    expect(audit!.after).toMatchObject({ badgeOnlySignIn: true })
    const kept = await send(office, 'PUT', `/auth/floor/sites/${site.id}/settings`, { idleMinutes: 12, shiftEnds: [], version: 1 })
    expect(kept.body).toMatchObject({ idleMinutes: 12, badgeOnlySignIn: true, version: 2 })
    expect((await device.browser.get('/floor/device')).body.signIn).toEqual({ badgeOnly: true })
    // The floor reads the setting; it never writes it.
    const tablets = await admin(`SELECT has_column_privilege('factory_floor_runtime', '"FloorSettings"', 'badgeOnlySignIn', 'UPDATE') AS write, has_column_privilege('factory_floor_runtime', '"FloorSettings"', 'badgeOnlySignIn', 'SELECT') AS read`)
    expect(tablets[0]).toEqual({ write: false, read: true })
  })

  it('on: a badge alone signs in with no PIN proved; signing acts and My day wait for a step-up with the PIN', async () => {
    await badgeOnly(site, true)
    const device = await tablet(site)
    const max = await worker(site, 'Max Test')
    const answer = await badgeAlone(device, max)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ status: 'signed_in', worker: { id: max.id }, session: { stepUpUntil: null, idleMinutes: expect.any(Number) } })
    expect(await pinVerifiedAt(device.deviceId)).toBeNull()
    const signedIn = await me(device)
    expect(signedIn.body).toMatchObject({ session: { stepUpUntil: null }, device: { station: { code: 'CUT-01', workCentreKind: 'CUTTING' } } })
    expect(signedIn.body.scanTag).toMatch(/^[0-9A-HJKMNP-TV-Z]{2}$/)
    const [audit] = await admin(`SELECT "after" FROM "AuditLog" WHERE action = 'floor.signIn' AND "actorId" = $1::uuid ORDER BY "at" DESC LIMIT 1`, [max.id])
    expect(audit!.after).toMatchObject({ method: 'badge', pin: false })

    // The step-up: a wrong PIN counts (as at sign-in) and keeps the worker signed in; the right one opens 2 minutes.
    const wrong = await device.browser.post('/floor/step-up', { pin: OTHER_PIN })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.issues[0].path).toBe('pin')
    expect((await admin('SELECT "failedPinAttempts" AS n FROM "Worker" WHERE id = $1::uuid', [max.id]))[0]!.n).toBe(1)
    expect((await me(device)).status).toBe(200)
    const stepped = await device.browser.post('/floor/step-up', { pin: max.pin })
    expect(stepped.status).toBe(200)
    expect(Date.parse(stepped.body.stepUpUntil) - h.clock.now().getTime()).toBe(2 * 60_000)
    expect(await pinVerifiedAt(device.deviceId)).not.toBeNull()
    expect((await me(device)).body.session.stepUpUntil).toBe(stepped.body.stepUpUntil)
    expect((await admin('SELECT "failedPinAttempts" AS n FROM "Worker" WHERE id = $1::uuid', [max.id]))[0]!.n).toBe(0)
    h.clock.advance(2 * 60_000 + 1_000)
    // Past its window the session is still live; the step-up is what ran out (requireFloorStepUp then answers 403 stepUp).
    expect((await me(device)).status).toBe(200)
    // A step-up's audit row holds no PIN.
    const rows = await admin(`SELECT "after"::text AS after FROM "AuditLog" WHERE action = 'floor.stepUp' AND "actorId" = $1::uuid`, [max.id])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.after).not.toContain(max.pin)
  })

  it('on: a badge with a PIN still proves it; a name always needs the PIN', async () => {
    await badgeOnly(site, true)
    const device = await tablet(site)
    const nia = await worker(site, 'Nia Test')
    const withPin = await signIn(device, nia)
    expect(withPin.status).toBe(200)
    expect(withPin.body.session.stepUpUntil).not.toBeNull()
    expect(await pinVerifiedAt(device.deviceId)).not.toBeNull()
    expect((await device.browser.post('/floor/sign-out')).status).toBe(200)
    const byName = await device.browser.post('/floor/sign-in', { workerId: nia.id })
    expect(byName.status).toBe(400)
    expect(byName.body.error.issues[0].path).toBe('pin')
    expect((await device.browser.post('/floor/sign-in', { workerId: nia.id, pin: nia.pin })).status).toBe(200)
    // A wrong PIN with a badge is refused, even where a badge alone would do.
    expect((await device.browser.post('/floor/sign-out')).status).toBe(200)
    expect((await signIn(device, nia, OTHER_PIN)).status).toBe(401)
  })

  it('on: a badge alone never clears wrong PINs, and opens nothing for a locked worker, one without a PIN, or a revoked badge', async () => {
    await badgeOnly(site, true)
    const device = await tablet(site)
    const oli = await worker(site, 'Oli Test')
    for (let attempt = 1; attempt <= 4; attempt++) expect((await signIn(device, oli, OTHER_PIN)).status).toBe(401)
    expect((await badgeAlone(device, oli)).status).toBe(200)
    expect((await admin('SELECT "failedPinAttempts" AS n FROM "Worker" WHERE id = $1::uuid', [oli.id]))[0]!.n).toBe(4)
    // The fifth wrong PIN (here at a step-up) locks the worker: no step-up, no new sign-in by badge alone.
    expect((await device.browser.post('/floor/step-up', { pin: OTHER_PIN })).status).toBe(400)
    const locked = await device.browser.post('/floor/step-up', { pin: oli.pin })
    expect(locked.status).toBe(403)
    expect(locked.body.error.issues ?? []).toEqual([])
    expect((await device.browser.post('/floor/sign-out')).status).toBe(200)
    const refused = await badgeAlone(device, oli)
    expect(refused.status).toBe(401)
    expect(refused.body.error.message).toBe((await signIn(device, oli, OTHER_PIN)).body.error.message)

    // A worker without a PIN, and a revoked badge: the same 401.
    const pia = await worker(site, 'Pia Test')
    await admin('UPDATE "Worker" SET "pinHash" = NULL WHERE id = $1::uuid', [pia.id])
    expect((await badgeAlone(device, pia)).status).toBe(401)
    const quin = await worker(site, 'Quin Test')
    const [badge] = await admin('SELECT id::text FROM "Badge" WHERE "workerId" = $1::uuid AND status = \'ACTIVE\'', [quin.id])
    await stepped(office)
    expect((await office.post(`/auth/floor/badges/${badge!.id}/revoke`, { status: 'LOST' })).status).toBe(200)
    expect((await badgeAlone(device, quin)).status).toBe(401)
    expect(await currentSession(device.deviceId)).toBeNull()
  })

  it('on: the next badge switches person with no PIN; off again: a badge alone is refused', async () => {
    await badgeOnly(site, true)
    const device = await tablet(site)
    const ray = await worker(site, 'Ray Test')
    const sol = await worker(site, 'Sol Test')
    expect((await badgeAlone(device, ray)).status).toBe(200)
    const switched = await device.browser.post('/floor/switch', { badgeCode: sol.badgeCode })
    expect(switched.status).toBe(200)
    expect(switched.body).toMatchObject({ worker: { id: sol.id }, session: { stepUpUntil: null } })
    expect((await device.browser.post('/floor/sign-out')).status).toBe(200)

    await badgeOnly(site, false)
    expect((await device.browser.get('/floor/device')).body.signIn).toEqual({ badgeOnly: false })
    expect((await badgeAlone(device, ray)).status).toBe(400)
    expect((await signIn(device, ray)).status).toBe(200)
  })
})

describe('revocation ends sessions', () => {
  it('a revoked device: its session ends, its token opens nothing, its number blocks close', async () => {
    const device = await tablet(p1)
    const lou = await worker(p1, 'Lou Test')
    expect((await signIn(device, lou)).status).toBe(200)
    const sessionId = await currentSession(device.deviceId)
    // Two blocks of the tablet's for offline labels (numbering/scan-ids), and an online block that names no tablet.
    const blockAt = async (kind: string, purpose: string, deviceId: string | null) => {
      const [{ top }] = (await admin(`SELECT coalesce(max("toRef"), 0)::int AS top FROM "NumberBlock" WHERE "tenantId" = (SELECT "tenantId" FROM "Device" WHERE id = $1::uuid) AND kind = $2::"NumberKind"`, [device.deviceId, kind])) as [{ top: number }]
      const id = newId()
      await admin(
        `INSERT INTO "NumberBlock" (id, "tenantId", kind, purpose, "fromRef", "toRef", "deviceId", "requestId") SELECT $1::uuid, "tenantId", $2::"NumberKind", $3::"NumberBlockPurpose", $4, $5, $6::uuid, 'test' FROM "Device" WHERE id = $7::uuid`,
        [id, kind, purpose, top + 1, top + 10, deviceId, device.deviceId],
      )
      return id
    }
    const own = [await blockAt('HIDE', 'DEVICE', device.deviceId), await blockAt('BUNDLE', 'DEVICE', device.deviceId)]
    const online = await blockAt('HIDE', 'ONLINE', null)
    const revoked = await office.post(`/auth/floor/devices/${device.deviceId}/revoke`, { reason: 'lost' })
    expect(revoked.status).toBe(200)
    expect(revoked.body).toMatchObject({ status: 'REVOKED', inUse: false })
    expect(await sessionRow(sessionId!)).toMatchObject({ reason: 'DEVICE_REVOKED' })
    expect((await me(device)).status).toBe(401)
    expect((await device.browser.get('/floor/device')).status).toBe(401)
    expect((await signIn(device, lou)).status).toBe(401)
    expect((await admin('SELECT "tokenHash" FROM "Device" WHERE id = $1::uuid', [device.deviceId]))[0]!.tokenHash).toBeNull()
    const blocks = await admin('SELECT id::text AS id, status::text AS status, "closedReason" FROM "NumberBlock" WHERE id = ANY($1::uuid[])', [[...own, online]])
    expect(Object.fromEntries(blocks.map((row) => [row.id, [row.status, row.closedReason]]))).toEqual({
      [own[0]!]: ['CLOSED', 'Tablet revoked: lost'],
      [own[1]!]: ['CLOSED', 'Tablet revoked: lost'],
      [online]: ['ACTIVE', null],
    })
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE action = 'devices.revoke' AND "recordId" = $1::uuid`, [device.deviceId])
    expect(audit!.after).toMatchObject({ status: 'REVOKED', blocksClosed: 2 })
    expect(await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'numbering.closeBlock' AND "recordId" = ANY($1::uuid[])`, [own])).toEqual([{ n: 2 }])
  })

  it('a revoked or reprinted badge: its sessions end and it signs in no more', async () => {
    const device = await tablet(p1)
    const max = await worker(p1, 'Max Test')
    expect((await signIn(device, max)).status).toBe(200)
    const first = await currentSession(device.deviceId)
    await stepped(office)
    const reprint = await office.post(`/auth/floor/workers/${max.id}/badges`)
    expect(reprint.status).toBe(200)
    expect(reprint.body.badge.hint).toBe(reprint.body.code.slice(-4))
    expect(await sessionRow(first!)).toMatchObject({ reason: 'BADGE_REVOKED' })
    expect((await me(device)).status).toBe(401)
    expect((await signIn(device, max)).status).toBe(401)
    const fresh = { ...max, badgeCode: reprint.body.code }
    expect((await signIn(device, fresh)).status).toBe(200)
    const second = await currentSession(device.deviceId)
    await stepped(office)
    const revoked = await office.post(`/auth/floor/badges/${reprint.body.badge.id}/revoke`, { status: 'LOST' })
    expect(revoked.body).toMatchObject({ status: 'LOST' })
    expect(await sessionRow(second!)).toMatchObject({ reason: 'BADGE_REVOKED' })
    expect((await me(device)).status).toBe(401)
    // Name + PIN still works for the worker (the badge was lost, not the person).
    expect((await device.browser.post('/floor/sign-in', { workerId: max.id, pin: max.pin })).status).toBe(200)
  })

  it('a deactivated worker: sessions end, no sign-in until reactivated', async () => {
    const device = await tablet(p1)
    const ned = await worker(p1, 'Ned Test')
    expect((await signIn(device, ned)).status).toBe(200)
    const sessionId = await currentSession(device.deviceId)
    expect((await office.post(`/auth/floor/workers/${ned.id}/deactivate`, {})).body).toMatchObject({ status: 'INACTIVE' })
    expect(await sessionRow(sessionId!)).toMatchObject({ reason: 'WORKER_DEACTIVATED' })
    expect((await signIn(device, ned)).status).toBe(401)
    expect((await device.browser.get('/floor/device')).body.roster.some((entry: { id: string }) => entry.id === ned.id)).toBe(false)
    expect((await office.post(`/auth/floor/workers/${ned.id}/reactivate`, {})).body).toMatchObject({ status: 'ACTIVE' })
    expect((await signIn(device, ned)).status).toBe(200)
  })

  it('a PIN reset: sessions end; the worker holds nothing until they chose their own PIN', async () => {
    const device = await tablet(p1)
    const ola = await worker(p1, 'Ola Test')
    expect((await signIn(device, ola)).status).toBe(200)
    const sessionId = await currentSession(device.deviceId)
    await stepped(office)
    const reset = await office.post(`/auth/floor/workers/${ola.id}/pin-reset`)
    expect(reset.status).toBe(200)
    expect(reset.body.pin).toMatch(/^\d{6}$/)
    expect(await sessionRow(sessionId!)).toMatchObject({ reason: 'PIN_RESET' })
    expect((await signIn(device, ola)).status).toBe(401)
    const temporary = await signIn(device, ola, reset.body.pin)
    expect(temporary.body).toMatchObject({ status: 'signed_in', pinMustChange: true })
    expect((await me(device)).body).toMatchObject({ pinMustChange: true, permissions: [] })
    expect((await device.browser.post('/floor/pin', { currentPin: reset.body.pin, newPin: '123456' })).status).toBe(400)
    expect((await device.browser.post('/floor/pin', { currentPin: reset.body.pin, newPin: '905218' })).body).toEqual({ status: 'changed' })
    expect((await me(device)).body).toMatchObject({ pinMustChange: false, permissions: ['floor.work', 'inventory.issue', 'inventory.locations.view', 'inventory.receive', 'inventory.transfer', /* B-W2a-35 */ 'plant.report', 'print.labels', 'print.view', 'production.bundles', 'production.cut', 'production.rework', 'production.scan', 'production.serials', 'shipping.pack'] })
    expect((await device.browser.post('/floor/sign-out')).status).toBe(200)
    expect((await signIn(device, ola, reset.body.pin)).status).toBe(401)
    expect((await signIn(device, ola, '905218')).status).toBe(200)
  })
})

describe('floor grants come from floor roles, with at most wages', () => {
  it('gives each worker their floor roles\' permissions, follows a change at the next request', async () => {
    const device = await tablet(p1)
    const pia = await worker(p1, 'Pia Test', ['team_leader'])
    expect((await signIn(device, pia)).status).toBe(200)
    expect((await me(device)).body.permissions).toEqual(['floor.lead', 'floor.work', 'inventory.issue', 'inventory.locations.view', 'inventory.receive', 'inventory.transfer', /* B-W2a-35 */ 'plant.report', 'print.labels', 'print.view', 'production.bundles', 'production.cut', 'production.rework', 'production.scan', 'production.serials', 'quality.inspections.view', 'shipping.pack'])
    await stepped(office)
    expect((await send(office, 'PUT', `/auth/floor/workers/${pia.id}/roles`, { roleIds: [] })).status).toBe(200)
    expect((await me(device)).body.permissions).toEqual([])
    expect((await send(office, 'PUT', `/auth/floor/workers/${pia.id}/roles`, { roleIds: [await roleId(alpha, 'operator')] })).body.roles.map((role: { key: string }) => role.key)).toEqual(['operator'])
    expect((await me(device)).body.permissions).toEqual(['floor.work', 'inventory.issue', 'inventory.locations.view', 'inventory.receive', 'inventory.transfer', /* B-W2a-35 */ 'plant.report', 'print.labels', 'print.view', 'production.bundles', 'production.cut', 'production.rework', 'production.scan', 'production.serials', 'shipping.pack'])
  })

  it('drops every grain but wages, and refuses office roles for workers and floor roles for people', async () => {
    const customId = newId()
    await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: newId() }, (client) =>
      client.role.create({ data: { id: customId, key: 'custom.floor_money', name: 'Floor money test', audience: 'FLOOR', permissions: ['floor.work'], grains: ['cost', 'margin', 'price', 'wages'] } }),
    )
    const device = await tablet(p1)
    const quin = await worker(p1, 'Quin Test', [])
    await stepped(office)
    expect((await send(office, 'PUT', `/auth/floor/workers/${quin.id}/roles`, { roleIds: [customId] })).status).toBe(200)
    expect((await signIn(device, quin)).status).toBe(200)
    expect((await me(device)).body.permissions).toEqual(['floor.work', 'money.wages'])
    expect((await send(office, 'PUT', `/auth/floor/workers/${quin.id}/roles`, { roleIds: [await roleId(alpha, 'sales')] })).status).toBe(400)
    // The floor session never reaches an office route.
    expect((await device.browser.get('/auth/floor/workers')).status).toBe(403)
    expect((await device.browser.get('/auth/office/me')).status).toBe(403)
  })
})

describe('a floor session reads only its own site, and no hidden column', () => {
  it('refuses another site\'s badge or worker on a device, and lists only its own site\'s workers', async () => {
    const device = await tablet(p1)
    const away = await worker(p2, 'Ray Test')
    expect((await signIn(device, away)).status).toBe(401)
    expect((await device.browser.post('/floor/sign-in', { workerId: away.id, pin: away.pin })).status).toBe(401)
    const roster = (await device.browser.get('/floor/device')).body.roster as { id: string }[]
    expect(roster.some((entry) => entry.id === away.id)).toBe(false)
    const own = await tablet(p2)
    expect((await signIn(own, away)).status).toBe(200)
  })

  it('in the FLOOR role: its site\'s rows only, no office-user link, no fiscal or money column', async () => {
    const sam = await worker(p1, 'Sam Test')
    await worker(p2, 'Tia Test')
    const floor = { audience: 'floor' as const, tenantId: alpha.id, siteId: p1.id, actorId: sam.id }
    const sites = await h.database.withScope(floor, (client) => client.$queryRawUnsafe<{ site: string }[]>('SELECT DISTINCT "siteId"::text AS site FROM "Worker"'))
    expect(sites).toEqual([{ site: p1.id }])
    for (const sql of ['SELECT "userId" FROM "Worker" LIMIT 1', 'SELECT "shareCapital" FROM "Company" LIMIT 1', 'SELECT "vatNumber" FROM "Company" LIMIT 1', 'SELECT 1 FROM "RoleAssignment" LIMIT 1', 'SELECT 1 FROM "User" LIMIT 1']) {
      await expect(h.database.withScope(floor, (client) => client.$queryRawUnsafe(sql)), sql).rejects.toThrow(/permission denied/)
    }
    await expect(h.database.withScope(floor, (client) => client.$executeRawUnsafe('INSERT INTO "Worker" (id, "companyId", "siteId", "displayName") VALUES ($1::uuid, $2::uuid, $3::uuid, $4)', newId(), p1.companyId, p1.id, 'x'))).rejects.toThrow(/permission denied/)
    await expect(h.database.withScope(floor, (client) => client.$executeRawUnsafe(`UPDATE "Worker" SET "displayName" = 'x' WHERE "siteId" = $1::uuid`, p2.id))).resolves.toBe(0)
  })
})

describe('Statuto dei Lavoratori art. 4 and GDPR art. 5(1)(c): minimal worker records, no biometrics, no monitoring', () => {
  const FORBIDDEN = /biometric|fingerprint|face|photo|image|birth|dob|national|fiscal|tax|ssn|gender|health|address|phone|email|score|productiv|rating|speed|efficien|piece|earning|wage|cost|price|margin|amount|total|output|location|gps/i

  it('GDPR art. 5(1)(c): a worker row is a name, a language, an employee number, a site, a status, a badge and a PIN hash', async () => {
    const columns = await admin(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Worker' ORDER BY column_name`)
    expect(columns.map((column) => column.name)).toEqual(
      [
        'companyId', 'createdAt', 'createdById', 'displayName', 'employeeCode', 'failedPinAttempts', 'id', 'locale', 'pinChangedAt', 'pinHash', 'pinLockedUntil',
        'pinMustChange', 'siteId', 'status', 'tenantId', 'updatedAt', 'userId', 'version',
      ].sort(),
    )
    const listed = (await office.get(`/auth/floor/workers?siteId=${p1.id}`)).body.workers[0]
    expect(Object.keys(listed).sort()).toEqual(['badge', 'displayName', 'employeeCode', 'hasPin', 'id', 'locale', 'locked', 'pinMustChange', 'roles', 'siteId', 'status', 'userId', 'version'])
  })

  it('MES-276 and Statuto dei Lavoratori art. 4: no biometric, personal or monitoring column in any floor table; the registry never says who', async () => {
    const tables = ['Device', 'DeviceEnrolment', 'Worker', 'Badge', 'WorkerRole', 'FloorSession', 'FloorSettings']
    const columns = await admin(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [tables])
    expect(new Set(columns.map((column) => column.t))).toEqual(new Set(tables))
    expect(columns.filter((column) => FORBIDDEN.test(column.c)).map((column) => `${column.t}.${column.c}`)).toEqual([])
    // A floor session records who, where and when; nothing counts or scores the work.
    const session = await admin(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'FloorSession' ORDER BY column_name`)
    expect(session.map((column) => column.c)).toEqual(
      ['badgeId', 'deviceId', 'endReason', 'endedAt', 'endsAt', 'id', 'idleExpiresAt', 'lastSeenAt', 'pinVerifiedAt', 'siteId', 'startedAt', 'tenantId', 'tokenHash', 'workerId'].sort(),
    )
    const device = await tablet(p1)
    const una = await worker(p1, 'Una Test')
    expect((await signIn(device, una)).status).toBe(200)
    const listed = (await office.get(`/auth/floor/devices?siteId=${p1.id}`)).body.devices.find((entry: { id: string }) => entry.id === device.deviceId)
    expect(listed.inUse).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(una.id)
    expect(JSON.stringify(listed)).not.toContain('Una Test')
    // A sign-in takes a badge or a name and a PIN, nothing else (no biometric factor).
    expect((await device.browser.post('/floor/sign-in', { workerId: una.id, pin: una.pin, fingerprint: 'x' })).status).toBe(400)
  })
})

describe('credentials and floor roles need a fresh office step-up', () => {
  it('refuses a badge, a PIN reset, a role change or a worker made with roles without one; plain edits need none', async () => {
    const ivo = await worker(p1, 'Ivo Test')
    h.clock.advance(6 * 60_000)
    const refusals = [
      await office.post(`/auth/floor/workers/${ivo.id}/badges`),
      await office.post(`/auth/floor/workers/${ivo.id}/pin-reset`),
      await send(office, 'PUT', `/auth/floor/workers/${ivo.id}/roles`, { roleIds: [] }),
      await office.post('/auth/floor/workers', { siteId: p1.id, displayName: 'Roled Test', roleIds: [await roleId(alpha, 'operator')] }),
    ]
    for (const answer of refusals) {
      expect(answer.status).toBe(403)
      expect(answer.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    }
    expect((await office.post('/auth/floor/workers', { siteId: p1.id, displayName: 'Plain Test' })).status).toBe(200)
    await stepped(office)
    expect((await office.post(`/auth/floor/workers/${ivo.id}/pin-reset`)).status).toBe(200)
  })
})

describe('the Office keeps to its scope; the tenant wall holds', () => {
  it('an office person limited to one site sees and changes only that site\'s devices and workers', async () => {
    const user = await addUser(h, alpha, { email: 'p1.lead@example.com' })
    await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: user.id }, async (client) => {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: alpha.id, key: 'floor_supervisor' } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: user.id, roleId: role.id, companyIds: [p1.companyId], siteIds: [p1.id], validFrom: h.clock.now() } })
    })
    const limited = new Browser(h.app)
    await limited.signIn(alpha.slug, user.email, user.password)
    const devices = (await limited.get('/auth/floor/devices')).body.devices as { siteId: string }[]
    expect(devices.length).toBeGreaterThan(0)
    expect(devices.every((device) => device.siteId === p1.id)).toBe(true)
    expect((await limited.post('/auth/floor/devices', { siteId: p2.id, name: 'Not mine' })).status).toBe(403)
    const p2worker = await worker(p2, 'Wes Test')
    expect((await limited.post(`/auth/floor/workers/${p2worker.id}/pin-reset`)).status).toBe(403)
    expect(((await limited.get('/auth/floor/workers')).body.workers as { siteId: string }[]).every((entry) => entry.siteId === p1.id)).toBe(true)
  })

  it('nobody manages the badge, PIN or roles of the worker linked to themselves', async () => {
    const user = await addUser(h, alpha, { email: 'self.lead@example.com', role: 'floor_supervisor' })
    const self = new Browser(h.app)
    await self.signIn(alpha.slug, user.email, user.password)
    expect((await self.post('/auth/floor/workers', { siteId: p1.id, displayName: 'Me Test', userId: user.id })).status).toBe(403)
    const made = await office.post('/auth/floor/workers', { siteId: p1.id, displayName: 'Linked Test', userId: user.id })
    expect(made.status).toBe(200)
    expect((await self.post(`/auth/floor/workers/${made.body.id}/pin-reset`)).status).toBe(403)
    expect((await self.post(`/auth/floor/workers/${made.body.id}/badges`)).status).toBe(403)
  })

  it('tenant wall: another tenant\'s devices, workers and tokens open nothing', async () => {
    const theirs = await tablet(b1, betaOffice)
    const yan = await worker(b1, 'Yan Test', ['operator'], betaOffice)
    const ours = await worker(p1, 'Zoe Test')
    expect(((await betaOffice.get('/auth/floor/workers')).body.workers as { id: string }[]).map((entry) => entry.id)).toEqual([yan.id])
    expect((await send(betaOffice, 'PATCH', `/auth/floor/workers/${ours.id}`, { version: 1, displayName: 'Taken' })).status).toBe(404)
    expect((await betaOffice.post(`/auth/floor/workers/${ours.id}/pin-reset`)).status).toBe(404)
    // A beta device's token renamed into alpha's tenant and site finds nothing there.
    const [, , deviceId, secret] = theirs.browser.cookies.get(DEVICE_COOKIE)!.split('.')
    const forged = new Browser(h.app)
    forged.cookies.set(DEVICE_COOKIE, `${alpha.id}.${p1.id}.${deviceId}.${secret}`)
    await forged.get('/auth/csrf')
    expect((await forged.get('/floor/device')).status).toBe(401)
    expect((await forged.post('/floor/sign-in', { badgeCode: ours.badgeCode, pin: ours.pin })).status).toBe(401)
    // An alpha badge on a beta device: not found in beta's site.
    expect((await signIn(theirs, ours)).status).toBe(401)
    expect((await signIn(theirs, yan)).status).toBe(200)
  })
})

describe('shift end (PLT-060)', () => {
  it('ends the session at the site\'s shift end in its time zone, however busy', async () => {
    // 2026-11-02 08:00 UTC is 09:00 in Rome; the shift ends at 10:00 Rome (09:00 UTC).
    h.clock.set('2026-11-02T08:00:00.000Z')
    // Days later: the morning's office session has expired; the supervisor signs in again.
    office = await signedIn(alpha, 'morning.lead@example.com', 'floor_supervisor')
    expect((await send(office, 'PUT', `/auth/floor/sites/${p2.id}/settings`, { idleMinutes: 10, shiftEnds: ['22:00', '10:00'] })).body).toMatchObject({ shiftEnds: ['10:00', '22:00'] })
    const device = await tablet(p2)
    const ann = await worker(p2, 'Ann Test')
    const answer = await signIn(device, ann)
    expect(answer.body.session.endsAt).toBe('2026-11-02T09:00:00.000Z')
    const sessionId = await currentSession(device.deviceId)
    for (let minute = 5; minute < 60; minute += 5) {
      h.clock.advance(5 * 60_000)
      expect((await me(device)).status, `minute ${minute}`).toBe(200)
    }
    h.clock.advance(5 * 60_000)
    expect((await me(device)).status).toBe(401)
    expect((await signIn(device, ann)).status).toBe(200)
    expect(await sessionRow(sessionId!)).toMatchObject({ reason: 'SHIFT_END' })
  })
})

it('syncs floor templates as FLOOR roles; refuses a floor role for a person and a copy of a floor template', async () => {
  const user = await addUser(h, beta, { email: 'owner.beta@example.com', role: 'owner' })
  const member = await addUser(h, beta, { email: 'member.beta@example.com' })
  const owner = new Browser(h.app)
  await owner.signIn(beta.slug, user.email, user.password)
  const secret = await enrolTotp(h, owner)
  const roles = (await owner.get('/auth/roles')).body.roles as { id: string; key: string; audience: string }[]
  expect(roles.filter((role) => role.audience === 'floor').map((role) => role.key).sort()).toEqual(['cutting_operator', 'floor_inspector', 'operator', 'team_leader', /* B-W2a-35 */ 'technician'])
  expect(roles.find((role) => role.key === 'admin')?.audience).toBe('office')
  await stepUp(h, owner, secret)
  const operator = roles.find((role) => role.key === 'operator')!.id
  const given = await owner.post(`/auth/users/${member.id}/roles`, { roleId: operator, allCompanies: true })
  expect(given.status).toBe(400)
  expect(given.body.error.issues[0].message).toMatch(/floor workers/)
  await stepUp(h, owner, secret)
  expect((await owner.post('/auth/roles', { key: 'floor_copy', name: 'Floor copy', basedOn: 'operator' })).status).toBe(400)
  await stepUp(h, owner, secret)
  expect((await owner.post('/auth/roles', { key: 'floor_perm', name: 'Floor permission', permissions: ['floor.work'] })).status).toBe(400)
})
