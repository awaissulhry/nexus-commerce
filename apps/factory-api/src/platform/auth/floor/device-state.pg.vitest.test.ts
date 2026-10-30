import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../sessions/testing/harness'

/**
 * The tablet's own state (B-W2a-42; PLT-241; design admin.devices "App version (outdated marked)", "Battery", the Status
 * tab's "actions waiting to sync") through the real app and the FLOOR database role: the enrolled device reports its
 * app version, battery and queue count, signed in or not; the office's device registry shows them; a new app version
 * leaves one audit row (the Activity tab's "app updated"), a plain report none; the report never names the person on
 * the tablet and never touches the device's version (an office edit in flight still saves). Refused: without the CSRF
 * token, without or with a revoked device token, out-of-range values. Made-up names only.
 */

let h: Harness
let alpha: TestTenant
let office: Browser
let siteId: string
let stationId: string
const PIN = '482913'
const admin = async (sql: string, values: unknown[] = []) => (await h.db.admin.query(sql, values)).rows as Record<string, any>[]
const state = (over: Record<string, unknown> = {}) => ({ appVersion: '1.0.0', batteryPercent: 64, batteryCharging: false, queuedActions: 3, ...over })

async function tablet(name: string): Promise<{ browser: Browser; deviceId: string }> {
  const made = await office.post('/auth/floor/devices', { siteId, stationId, name })
  if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
  const browser = new Browser(h.app)
  await browser.get('/auth/csrf')
  const enrolled = await browser.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
  if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
  return { browser, deviceId: made.body.device.id }
}

const listed = async (deviceId: string) => ((await office.get('/auth/floor/devices')).body.devices as Record<string, unknown>[]).find((device) => device.id === deviceId)!

beforeAll(async () => {
  h = await startHarness('auth_floor_state')
  alpha = await addTenant(h, 'alpha')
  const companyId = alpha.companies[0]!.id
  siteId = newId()
  stationId = newId()
  const centreId = newId()
  await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: newId() }, async (client) => {
    await client.site.create({ data: { id: siteId, companyId, code: 'P1', name: 'Test plant P1', kind: 'PLANT' } })
    await client.workCentre.create({ data: { id: centreId, companyId, siteId, code: 'CUT', name: 'Cutting', kind: 'CUTTING' } })
    await client.station.create({ data: { id: stationId, companyId, siteId, workCentreId: centreId, code: 'CUT-01', name: 'Cutting table 1' } })
  })
  const user = await addUser(h, alpha, { email: 'lead@example.com', role: 'floor_supervisor' })
  office = new Browser(h.app)
  const answer = await office.signIn(alpha.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status}`)
  const secret = await enrolTotp(h, office)
  ;(office as Browser & { totp?: string }).totp = secret
}, 60_000)

afterAll(async () => {
  await h?.close()
})

describe('the tablet reports its state (PLT-241)', () => {
  it('signed in or not: battery, charging and the queue count show in the registry; the same version leaves no audit row', async () => {
    const { browser, deviceId } = await tablet('Tablet state A')
    const versionBefore = (await listed(deviceId)).version
    const answer = await browser.post('/floor/device/state', state())
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body).toMatchObject({ appUpdated: false, reportedAt: expect.any(String) })
    expect(await listed(deviceId)).toMatchObject({ appVersion: '1.0.0', batteryPercent: 64, batteryCharging: false, queuedActions: 3, statusReportedAt: answer.body.reportedAt, version: versionBefore })
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE "recordId" = $1::uuid AND action = 'floor.deviceAppUpdated'`, [deviceId])).toHaveLength(0)
    // A browser that does not say its battery: null, kept as null.
    expect((await browser.post('/floor/device/state', state({ batteryPercent: null, batteryCharging: null, queuedActions: 0 }))).status).toBe(200)
    expect(await listed(deviceId)).toMatchObject({ batteryPercent: null, batteryCharging: null, queuedActions: 0 })
  })

  it('a new app version is the device history (one audit row, the device as the actor), never the record version', async () => {
    const { browser, deviceId } = await tablet('Tablet state B')
    // A worker is signed in on it: the report still names only the device.
    const roles = await admin(`SELECT id::text FROM "Role" WHERE "tenantId" = $1::uuid AND key = 'operator'`, [alpha.id])
    await stepUp(h, office, (office as Browser & { totp?: string }).totp!)
    const worker = await office.post('/auth/floor/workers', { siteId, displayName: 'Made-up worker', locale: 'it', roleIds: [roles[0]!.id] })
    const badge = await office.post(`/auth/floor/workers/${worker.body.id}/badges`)
    await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1::uuid', [worker.body.id, await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })])
    expect((await browser.post('/floor/sign-in', { badgeCode: badge.body.code, pin: PIN })).status).toBe(200)

    const before = await listed(deviceId)
    const answer = await browser.post('/floor/device/state', state({ appVersion: '1.1.0', queuedActions: 0 }))
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.appUpdated).toBe(true)
    const audits = await admin(`SELECT "actorId"::text AS actor, before, after FROM "AuditLog" WHERE "recordId" = $1::uuid AND action = 'floor.deviceAppUpdated'`, [deviceId])
    expect(audits).toEqual([{ actor: deviceId, before: { appVersion: '1.0.0' }, after: { appVersion: '1.1.0' } }])
    expect(JSON.stringify(audits)).not.toContain(worker.body.id)
    const after = await listed(deviceId)
    expect(after).toMatchObject({ appVersion: '1.1.0', queuedActions: 0, version: before.version })
    // The office's rename with the version it read before the report still saves.
    const renamed = await office.send('PATCH' as never, `/auth/floor/devices/${deviceId}`, { version: before.version, name: 'Tablet state B renamed' })
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200)
    // The same version again: no second row.
    await browser.post('/floor/device/state', state({ appVersion: '1.1.0' }))
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE "recordId" = $1::uuid AND action = 'floor.deviceAppUpdated'`, [deviceId])).toHaveLength(1)
  })

  it('refuses a report without the CSRF token, without a device, from a revoked device, or out of range', async () => {
    const { browser, deviceId } = await tablet('Tablet state C')
    expect((await browser.post('/floor/device/state', state(), { csrf: false })).status).toBe(403)
    const stranger = new Browser(h.app)
    await stranger.get('/auth/csrf')
    expect((await stranger.post('/floor/device/state', state())).status).toBe(401)
    for (const bad of [{ batteryPercent: 101 }, { batteryPercent: -1 }, { queuedActions: -1 }, { appVersion: '' }, { appVersion: 'x'.repeat(41) }, { queuedActions: 1.5 }]) {
      expect((await browser.post('/floor/device/state', state(bad))).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await office.post(`/auth/floor/devices/${deviceId}/revoke`, { reason: 'made-up test' })).status).toBe(200)
    expect((await browser.post('/floor/device/state', state())).status).toBe(401)
    const [row] = await admin('SELECT "batteryPercent", "statusReportedAt" FROM "Device" WHERE id = $1::uuid', [deviceId])
    expect(row).toEqual({ batteryPercent: null, statusReportedAt: null })
  })
})
