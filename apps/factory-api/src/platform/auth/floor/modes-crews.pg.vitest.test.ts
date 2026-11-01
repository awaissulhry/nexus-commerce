import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../sessions/testing/harness'
import { FLOOR_COOKIE } from './cookies'

/**
 * Floor modes, phones, the kiosk check and crews (B-W2b-52; MES-181, MES-186, MES-188, PLT-059, PLT-227) on the local
 * stack, through the real app, the real floor authenticator and the FLOOR database role: the mode chosen at enrolment
 * (a line board signs nobody in and goes to its line's board; a personal phone signs in only its person and keeps no
 * battery or network; a line tablet shows its line); the mode changed only while nobody is signed in; the kiosk check
 * kept honest; several workers on one station tablet with one active, switched only with a proof, up to four, ended by a
 * sign-out, a leave, idle time or a revoke. Every person is made up. The clock only moves forward.
 */

let h: Harness
let alpha: TestTenant
let office: Browser
let site: Site

interface Site {
  readonly id: string
  readonly companyId: string
  /** A station on the line. */
  readonly stationId: string
  /** A station on no line. */
  readonly loneStationId: string
  readonly lineId: string
  readonly otherLineId: string
}

interface Tablet {
  readonly browser: Browser
  readonly deviceId: string
}

interface TestWorker {
  readonly id: string
  readonly badgeCode: string
  readonly pin: string
}

const PIN = '482913'
let secret = ''
const admin = async (sql: string, values: unknown[] = []) => (await h.db.admin.query(sql, values)).rows as Record<string, any>[]

async function addSite(tenant: TestTenant): Promise<Site> {
  const companyId = tenant.companies[0]!.id
  const [siteId, centreId, stationId, loneStationId, lineId, otherLineId] = [newId(), newId(), newId(), newId(), newId(), newId()]
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
    await client.site.create({ data: { id: siteId, companyId, code: 'M1', name: 'Made-up plant M1', kind: 'PLANT' } })
    await client.line.create({ data: { id: lineId, companyId, siteId, code: 'L1', name: 'Line 1' } })
    await client.line.create({ data: { id: otherLineId, companyId, siteId, code: 'L2', name: 'Line 2' } })
    await client.workCentre.create({ data: { id: centreId, companyId, siteId, code: 'SEW', name: 'Sewing', kind: 'SEWING' } })
    await client.station.create({ data: { id: stationId, companyId, siteId, workCentreId: centreId, lineId, code: 'SEW-01', name: 'Sewing station 1' } })
    await client.station.create({ data: { id: loneStationId, companyId, siteId, workCentreId: centreId, code: 'SEW-09', name: 'Sewing station 9' } })
  })
  return { id: siteId, companyId, stationId, loneStationId, lineId, otherLineId }
}

const roleId = async (key: string) => (await admin('SELECT id::text FROM "Role" WHERE "tenantId" = $1::uuid AND key = $2', [alpha.id, key]))[0]!.id as string

async function worker(name: string, roles: string[] = ['operator']): Promise<TestWorker> {
  const roleIds = await Promise.all(roles.map(roleId))
  await stepUp(h, office, secret)
  const made = await office.post('/auth/floor/workers', { siteId: site.id, displayName: name, locale: 'it', roleIds })
  if (made.status !== 200) throw new Error(`worker: ${made.status} ${JSON.stringify(made.body)}`)
  const badge = await office.post(`/auth/floor/workers/${made.body.id}/badges`)
  if (badge.status !== 200) throw new Error(`badge: ${badge.status} ${JSON.stringify(badge.body)}`)
  await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1::uuid', [made.body.id, await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })])
  return { id: made.body.id, badgeCode: badge.body.code, pin: PIN }
}

async function tablet(body: Record<string, unknown>): Promise<Tablet> {
  const made = await office.post('/auth/floor/devices', { siteId: site.id, name: `Device ${newId().slice(-4)}`, ...body })
  if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
  const browser = new Browser(h.app)
  await browser.get('/auth/csrf')
  const enrolled = await browser.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
  if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
  return { browser, deviceId: made.body.device.id }
}

const signIn = (device: Tablet, who: TestWorker, pin = who.pin) => device.browser.post('/floor/sign-in', { badgeCode: who.badgeCode, pin })
const me = (device: Tablet) => device.browser.get('/floor/me')
const deviceRow = async (id: string) => (await admin('SELECT mode::text, "lineId"::text, "personalWorkerId"::text, "currentSessionId"::text, "batteryPercent", network::text, version FROM "Device" WHERE id = $1::uuid', [id]))[0]!
const failedPins = async (workerId: string) => (await admin('SELECT "failedPinAttempts" AS n FROM "Worker" WHERE id = $1::uuid', [workerId]))[0]!.n as number
const listed = async (deviceId: string) => ((await office.get(`/auth/floor/devices?siteId=${site.id}`)).body.devices as Record<string, any>[]).find((row) => row.id === deviceId)!
const crewRows = async (deviceId: string) =>
  admin(
    `SELECT m."workerId"::text AS "workerId", m.active, m."leftAt", m."floorSessionId"::text AS "sessionId", c."endedAt" AS "crewEndedAt", c."endReason"::text AS "crewEndReason"
       FROM "CrewMember" m JOIN "CrewSession" c ON c.id = m."crewSessionId" WHERE c."deviceId" = $1::uuid ORDER BY m."joinedAt", m.id`,
    [deviceId],
  )
const sessionOf = async (id: string) => (await admin('SELECT "endedAt", "endReason"::text AS reason FROM "FloorSession" WHERE id = $1::uuid', [id]))[0]!

beforeAll(async () => {
  h = await startHarness('floor_modes')
  alpha = await addTenant(h, 'alpha')
  site = await addSite(alpha)
  const user = await addUser(h, alpha, { email: 'devices@example.com', role: 'floor_supervisor' })
  office = new Browser(h.app)
  const answer = await office.signIn(alpha.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  secret = await enrolTotp(h, office)
}, 120_000)

afterAll(async () => {
  await h?.close()
})

describe('the mode chosen at enrolment (MES-181)', { timeout: 60_000 }, () => {
  it('a station tablet by default: anyone signs in, Home first, crews and the kiosk guide apply; the voice speaks the screen\'s language', async () => {
    const station = await tablet({ stationId: site.stationId })
    const info = await station.browser.get('/floor/device')
    expect(info.status).toBe(200)
    expect(info.body).toMatchObject({ device: { mode: 'STATION' }, rules: { signIn: 'ANYONE', landing: 'HOME', crew: true, kiosk: true, look: { icon: 'tablet', tone: 'info' } }, line: { id: site.lineId, code: 'L1' }, speech: { lang: 'it-IT' } })
    expect(await listed(station.deviceId)).toMatchObject({ mode: 'STATION', lineId: null, personalWorkerId: null, kiosk: null })
  })

  it('a line board: nobody signs in (403 before any PIN is checked), the roster is empty, it goes straight to its line\'s board', async () => {
    const noLine = await office.post('/auth/floor/devices', { siteId: site.id, name: 'TV without a line', mode: 'DISPLAY', stationId: site.loneStationId })
    expect(noLine.status).toBe(400)
    expect(noLine.body.error.issues[0].path).toBe('lineId')
    const board = await tablet({ mode: 'DISPLAY', lineId: site.otherLineId })
    const info = await board.browser.get('/floor/device')
    expect(info.body).toMatchObject({ device: { mode: 'DISPLAY', station: null }, rules: { signIn: 'NOBODY', landing: 'LINE_BOARD', crew: false }, line: { id: site.otherLineId, code: 'L2' }, roster: [] })
    const someone = await worker('Made-up Board Tester')
    expect((await signIn(board, someone)).status).toBe(403)
    expect((await signIn(board, someone, '000001')).status).toBe(403)
    expect(await failedPins(someone.id)).toBe(0)
    expect(board.browser.cookies.has(FLOOR_COOKIE)).toBe(false)
  })

  it('a line tablet shows its line (its own, else its station\'s) and the Line view first', async () => {
    const lead = await worker('Made-up Lead', ['team_leader'])
    const own = await tablet({ mode: 'LINE', lineId: site.otherLineId })
    expect((await own.browser.get('/floor/device')).body).toMatchObject({ rules: { landing: 'LINE_VIEW', signIn: 'ANYONE' }, line: { id: site.otherLineId } })
    const byStation = await tablet({ mode: 'LINE', stationId: site.stationId })
    expect((await byStation.browser.get('/floor/device')).body.line).toMatchObject({ id: site.lineId })
    expect((await signIn(own, lead)).status).toBe(200)
    expect((await me(own)).body).toMatchObject({ device: { mode: 'LINE' }, rules: { landing: 'LINE_VIEW' }, line: { id: site.otherLineId }, crew: null, speech: { lang: 'it-IT' } })
    // A line of its own is only for a line tablet or a board.
    expect((await office.post('/auth/floor/devices', { siteId: site.id, name: 'Wrong', stationId: site.stationId, lineId: site.lineId })).body.error.issues[0].path).toBe('lineId')
  })
})

describe('a personal phone (MES-186)', { timeout: 60_000 }, () => {
  it('names its one person, sits at no station, is no PC; only a phone names a person', async () => {
    const owner = await worker('Made-up Phone Owner')
    const paths = async (body: Record<string, unknown>) => ((await office.post('/auth/floor/devices', { siteId: site.id, name: 'Phone', kind: 'HANDHELD', ...body })).body.error?.issues ?? []).map((issue: { path: string }) => issue.path)
    expect(await paths({ mode: 'PHONE' })).toEqual(['personalWorkerId'])
    expect(await paths({ mode: 'PHONE', personalWorkerId: owner.id, stationId: site.stationId })).toEqual(['stationId'])
    expect(await paths({ mode: 'PHONE', personalWorkerId: owner.id, kind: 'PC' })).toEqual(['kind'])
    expect(await paths({ personalWorkerId: owner.id })).toEqual(['personalWorkerId'])
    expect(await paths({ mode: 'PHONE', personalWorkerId: newId() })).toEqual(['personalWorkerId'])
  })

  it('signs in only its person (another\'s right PIN is a 403, a wrong one still counts); keeps no battery or network; is never kiosk-locked', async () => {
    const owner = await worker('Made-up Phone Owner Two')
    const other = await worker('Made-up Colleague')
    const phone = await tablet({ mode: 'PHONE', kind: 'HANDHELD', personalWorkerId: owner.id })
    const info = await phone.browser.get('/floor/device')
    expect(info.body).toMatchObject({ device: { mode: 'PHONE' }, rules: { signIn: 'ONE_PERSON', kiosk: false, crew: false, look: { icon: 'smartphone' } }, line: null })
    expect(info.body.roster.map((row: { id: string }) => row.id)).toEqual([owner.id])
    expect((await signIn(phone, other)).status).toBe(403)
    expect((await signIn(phone, other, '000002')).status).toBe(401)
    expect(await failedPins(other.id)).toBe(1)
    expect((await signIn(phone, owner)).status).toBe(200)
    expect((await me(phone)).body.worker.id).toBe(owner.id)
    // Another person cannot take it over with "switch operator" either.
    expect((await phone.browser.post('/floor/switch', { badgeCode: other.badgeCode, pin: other.pin })).status).toBe(403)
    const state = await phone.browser.post('/floor/device/state', { appVersion: '1.0.0', batteryPercent: 64, batteryCharging: true, queuedActions: 2, network: 'CELLULAR' })
    expect(state.status).toBe(200)
    expect(await deviceRow(phone.deviceId)).toMatchObject({ batteryPercent: null, network: null })
    expect((await phone.browser.post('/floor/device/kiosk', { fullScreen: true, installed: true, homeTest: 'STAYED' })).status).toBe(409)
    // The registry names the person by id only (the name stays inside the device's record).
    const row = await listed(phone.deviceId)
    expect(row).toMatchObject({ mode: 'PHONE', personalWorkerId: owner.id, stationId: null })
    expect(JSON.stringify(row)).not.toContain('Made-up Phone Owner Two')
  })
})

describe('a mode changes only while nobody is signed in', { timeout: 60_000 }, () => {
  it('refuses a new mode while someone works on the device; takes it once they signed out, dropping what the old mode had', async () => {
    const operator = await worker('Made-up Mode Tester')
    const line = await tablet({ mode: 'LINE', lineId: site.otherLineId, stationId: site.stationId })
    expect((await signIn(line, operator)).status).toBe(200)
    const before = await listed(line.deviceId)
    const busy = await office.send('PATCH' as never, `/auth/floor/devices/${line.deviceId}`, { version: before.version, mode: 'STATION' })
    expect(busy.status).toBe(409)
    // A line change alone is fine while in use.
    const moved = await office.send('PATCH' as never, `/auth/floor/devices/${line.deviceId}`, { version: before.version, lineId: site.lineId })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({ mode: 'LINE', lineId: site.lineId })
    expect((await line.browser.post('/floor/sign-out')).status).toBe(200)
    const changed = await office.send('PATCH' as never, `/auth/floor/devices/${line.deviceId}`, { version: moved.body.version, mode: 'STATION' })
    expect(changed.status).toBe(200)
    expect(changed.body).toMatchObject({ mode: 'STATION', lineId: null })
    expect(await deviceRow(line.deviceId)).toMatchObject({ mode: 'STATION', lineId: null })
  })

  it('a session that no longer fits the device stops at its next request (a phone given to another person)', async () => {
    const first = await worker('Made-up First Owner')
    const second = await worker('Made-up Second Owner')
    const phone = await tablet({ mode: 'PHONE', kind: 'HANDHELD', personalWorkerId: first.id })
    expect((await signIn(phone, first)).status).toBe(200)
    // The office cannot move a phone in use; the database row is changed here as a stand-in for a race.
    await admin('UPDATE "Device" SET "personalWorkerId" = $2::uuid WHERE id = $1::uuid', [phone.deviceId, second.id])
    expect((await me(phone)).status).toBe(401)
  })
})

describe('the kiosk lock guide with an honest check (PLT-227)', { timeout: 60_000 }, () => {
  it('keeps what the tablet could check and what the person said; never "locked"; the office sees the last check', async () => {
    const station = await tablet({ stationId: site.loneStationId })
    const first = await station.browser.post('/floor/device/kiosk', { fullScreen: true, installed: null, homeTest: 'NOT_TESTED' })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ applies: true, lockedKnown: false, looksLocked: false })
    expect(first.body.rows.map((row: { id: string; state: string; source: string }) => [row.id, row.state, row.source])).toEqual([
      ['fullScreen', 'ok', 'TABLET'],
      ['installed', 'unknown', 'NOBODY'],
      ['pinned', 'unknown', 'NOBODY'],
    ])
    h.clock.advance(1_000)
    const second = await station.browser.post('/floor/device/kiosk', { fullScreen: true, installed: true, homeTest: 'STAYED' })
    expect(second.body).toMatchObject({ lockedKnown: false, looksLocked: true })
    expect((await listed(station.deviceId)).kiosk).toMatchObject({ fullScreen: true, installed: true, homeTest: 'STAYED', looksLocked: true })
    const audits = await admin(`SELECT action, audience::text FROM "AuditLog" WHERE "recordType" = 'Device' AND "recordId" = $1::uuid AND action = 'floor.deviceKioskChecked'`, [station.deviceId])
    expect(audits).toHaveLength(2)
    expect(audits[0]).toMatchObject({ audience: 'FLOOR' })
    // Without the device token: nothing (no other way in).
    const stranger = new Browser(h.app)
    await stranger.get('/auth/csrf')
    expect((await stranger.post('/floor/device/kiosk', { fullScreen: true, installed: true, homeTest: 'STAYED' })).status).toBe(401)
  })
})

describe('crew mode on one station tablet (PLT-059)', { timeout: 60_000 }, () => {
  it('several workers signed in, one active; every request books to the active one; a switch needs a proof', async () => {
    const [anna, bruno, carla] = [await worker('Made-up Anna'), await worker('Made-up Bruno'), await worker('Made-up Carla')]
    const station = await tablet({ stationId: site.stationId })
    expect((await signIn(station, anna)).status).toBe(200)
    expect((await station.browser.get('/floor/crew')).body).toEqual({ crew: null, allowed: true })
    const annaCookie = station.browser.cookies.get(FLOOR_COOKIE)!

    const joined = await station.browser.post('/floor/crew/join', { badgeCode: bruno.badgeCode, pin: bruno.pin })
    expect(joined.status).toBe(200)
    expect(joined.body).toMatchObject({ status: 'signed_in', worker: { id: bruno.id }, crew: { max: 4 } })
    expect(joined.body.crew.members.map((row: { workerId: string; active: boolean }) => [row.workerId, row.active])).toEqual([
      [anna.id, false],
      [bruno.id, true],
    ])
    expect(joined.body.crew.members[1].look).toEqual({ icon: 'user-check', tone: 'success' })
    expect((await me(station)).body).toMatchObject({ worker: { id: bruno.id }, crew: { members: [{ workerId: anna.id }, { workerId: bruno.id, active: true }] } })
    const rows = await crewRows(station.deviceId)
    expect(rows.map((row) => [row.workerId, row.active, row.leftAt])).toEqual([
      [anna.id, false, null],
      [bruno.id, true, null],
    ])
    // Anna's session is not ended: she waits signed in; the device's current session is Bruno's.
    expect((await sessionOf(rows[0]!.sessionId)).endedAt).toBeNull()
    expect((await deviceRow(station.deviceId)).currentSessionId).toBe(rows[1]!.sessionId)
    // Anna's old cookie opens nothing now (one current session per device).
    const old = new Browser(h.app)
    for (const [name, value] of station.browser.cookies) old.cookies.set(name, value)
    old.cookies.set(FLOOR_COOKIE, annaCookie)
    expect((await old.get('/floor/me')).status).toBe(401)

    // A switch: Anna taps her chip and types her PIN; a wrong one is refused and counted.
    expect((await station.browser.post('/floor/crew/switch', { workerId: anna.id, pin: '000003' })).status).toBe(401)
    expect(await failedPins(anna.id)).toBe(1)
    const back = await station.browser.post('/floor/crew/switch', { workerId: anna.id, pin: anna.pin })
    expect(back.status).toBe(200)
    expect(back.body.crew.members.map((row: { active: boolean }) => row.active)).toEqual([true, false])
    expect(await failedPins(anna.id)).toBe(0)
    expect((await me(station)).body.worker.id).toBe(anna.id)
    // Her own session took the new token (no new session): the crew keeps one session per member.
    expect((await deviceRow(station.deviceId)).currentSessionId).toBe(rows[0]!.sessionId)
    // Only a member is switched to.
    expect((await station.browser.post('/floor/crew/switch', { badgeCode: carla.badgeCode, pin: carla.pin })).status).toBe(409)
  })

  it('up to four; "switch operator" on a crew tablet adds or activates (nobody\'s session ends); one crew per worker', async () => {
    const people = [await worker('Made-up Dario'), await worker('Made-up Elena'), await worker('Made-up Fabio'), await worker('Made-up Gina'), await worker('Made-up Hugo')]
    const station = await tablet({ stationId: site.stationId })
    expect((await signIn(station, people[0]!)).status).toBe(200)
    expect((await station.browser.post('/floor/crew/join', { badgeCode: people[1]!.badgeCode, pin: PIN })).status).toBe(200)
    expect((await station.browser.post('/floor/switch', { badgeCode: people[2]!.badgeCode, pin: PIN })).status).toBe(200)
    expect((await station.browser.post('/floor/crew/join', { workerId: people[3]!.id, pin: PIN })).status).toBe(200)
    const full = await station.browser.post('/floor/crew/join', { badgeCode: people[4]!.badgeCode, pin: PIN })
    expect(full.status).toBe(409)
    expect(full.body.error.message).toContain('Four people')
    // "Switch operator" to a member activates them; no session ended.
    expect((await station.browser.post('/floor/switch', { badgeCode: people[0]!.badgeCode, pin: PIN })).status).toBe(200)
    const rows = await crewRows(station.deviceId)
    expect(rows.map((row) => [row.active, row.leftAt])).toEqual([
      [true, null],
      [false, null],
      [false, null],
      [false, null],
    ])
    expect(await admin(`SELECT count(*)::int AS n FROM "FloorSession" WHERE "deviceId" = $1::uuid AND "endedAt" IS NOT NULL`, [station.deviceId])).toEqual([{ n: 0 }])
    // A member of this crew cannot join another tablet's crew while in it.
    const second = await tablet({ stationId: site.loneStationId })
    expect((await signIn(second, people[4]!)).status).toBe(200)
    const elsewhere = await second.browser.post('/floor/crew/join', { badgeCode: people[1]!.badgeCode, pin: PIN })
    expect(elsewhere.status).toBe(409)
    expect(elsewhere.body.error.message).toContain('another tablet')
  })

  it('leave: the active one signs out of the crew, nobody is active until a member signs in again; end: everyone signs out', async () => {
    const [ivo, lia] = [await worker('Made-up Ivo'), await worker('Made-up Lia')]
    const station = await tablet({ stationId: site.stationId })
    expect((await signIn(station, ivo)).status).toBe(200)
    expect((await station.browser.post('/floor/crew/join', { badgeCode: lia.badgeCode, pin: PIN })).status).toBe(200)
    const left = await station.browser.post('/floor/crew/leave')
    expect(left.status).toBe(200)
    expect(left.body).toMatchObject({ status: 'left', crew: { members: [{ workerId: ivo.id, active: false }] } })
    expect(station.browser.cookies.has(FLOOR_COOKIE)).toBe(false)
    let rows = await crewRows(station.deviceId)
    expect(rows[1]).toMatchObject({ workerId: lia.id, active: false })
    expect(rows[1]!.leftAt).not.toBeNull()
    expect(await sessionOf(rows[1]!.sessionId)).toMatchObject({ reason: 'SIGNED_OUT' })
    expect((await deviceRow(station.deviceId)).currentSessionId).toBeNull()
    expect((await station.browser.get('/floor/device')).body.operatorSignedIn).toBe(false)
    // Ivo scans his badge on the sign-in screen: his own session is active again (the crew's), no new one.
    expect((await signIn(station, ivo)).status).toBe(200)
    expect((await deviceRow(station.deviceId)).currentSessionId).toBe(rows[0]!.sessionId)
    // A stranger's sign-in while Ivo is active stays a 409 (switch instead), as without a crew.
    const stranger = await worker('Made-up Stranger')
    expect((await signIn(station, stranger)).status).toBe(409)
    const ended = await station.browser.post('/floor/crew/end')
    expect(ended.status).toBe(200)
    rows = await crewRows(station.deviceId)
    expect(rows.every((row) => row.leftAt !== null && row.active === false)).toBe(true)
    expect(rows[0]).toMatchObject({ crewEndReason: 'SIGNED_OUT' })
    expect(rows[0]!.crewEndedAt).not.toBeNull()
    expect((await me(station)).status).toBe(401)
    expect((await station.browser.post('/floor/crew/end')).status).toBe(401)
  })

  it('the crew stays signed in while the tablet is used; idle for the whole crew, it ends at the next sign-in', async () => {
    const [mia, noa] = [await worker('Made-up Mia'), await worker('Made-up Noa')]
    const station = await tablet({ stationId: site.loneStationId })
    expect((await signIn(station, mia)).status).toBe(200)
    expect((await station.browser.post('/floor/crew/join', { badgeCode: noa.badgeCode, pin: PIN })).status).toBe(200)
    // Noa works for 15 minutes (the site's idle is 10): Mia's session slides with the crew's.
    for (let minute = 0; minute < 15; minute += 3) {
      h.clock.advance(3 * 60_000)
      expect((await me(station)).status).toBe(200)
    }
    const members = await crewRows(station.deviceId)
    const mias = await admin('SELECT "idleExpiresAt" FROM "FloorSession" WHERE id = $1::uuid', [members[0]!.sessionId])
    expect(new Date(mias[0]!.idleExpiresAt).getTime()).toBeGreaterThan(h.clock.now().getTime())
    expect((await station.browser.post('/floor/crew/switch', { workerId: mia.id, pin: PIN })).status).toBe(200)
    // Then nobody touches the tablet for 11 minutes: the crew is gone; the next sign-in finds no crew.
    h.clock.advance(11 * 60_000)
    expect((await me(station)).status).toBe(401)
    expect((await signIn(station, noa)).status).toBe(200)
    const after = await crewRows(station.deviceId)
    expect(after.every((row) => row.leftAt !== null)).toBe(true)
    expect(after[0]).toMatchObject({ crewEndReason: 'IDLE' })
    expect((await me(station)).body).toMatchObject({ worker: { id: noa.id }, crew: null })
  })

  it('a revoked device ends its crew; a crew never opens on a line tablet', async () => {
    const [olga, pia] = [await worker('Made-up Olga'), await worker('Made-up Pia')]
    const station = await tablet({ stationId: site.stationId })
    expect((await signIn(station, olga)).status).toBe(200)
    expect((await station.browser.post('/floor/crew/join', { badgeCode: pia.badgeCode, pin: PIN })).status).toBe(200)
    const before = await listed(station.deviceId)
    expect((await office.post(`/auth/floor/devices/${station.deviceId}/revoke`, { version: before.version, reason: 'Made-up test' })).status).toBe(200)
    const rows = await crewRows(station.deviceId)
    expect(rows.every((row) => row.leftAt !== null && !row.active)).toBe(true)
    expect(rows[0]).toMatchObject({ crewEndReason: 'DEVICE_REVOKED' })

    const lineTablet = await tablet({ mode: 'LINE', lineId: site.lineId })
    expect((await signIn(lineTablet, olga)).status).toBe(200)
    expect((await lineTablet.browser.get('/floor/crew')).body).toEqual({ crew: null, allowed: false })
    expect((await lineTablet.browser.post('/floor/crew/join', { badgeCode: pia.badgeCode, pin: PIN })).status).toBe(409)
  })

  it('Statuto dei Lavoratori art. 4: the registry says "in use", never who, also with a crew', async () => {
    const [quinto, rita] = [await worker('Made-up Quinto'), await worker('Made-up Rita')]
    const station = await tablet({ stationId: site.loneStationId })
    expect((await signIn(station, quinto)).status).toBe(200)
    expect((await station.browser.post('/floor/crew/join', { badgeCode: rita.badgeCode, pin: PIN })).status).toBe(200)
    const row = await listed(station.deviceId)
    expect(row.inUse).toBe(true)
    expect(JSON.stringify(row)).not.toMatch(/Quinto|Rita/)
  })
})
