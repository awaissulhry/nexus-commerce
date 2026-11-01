import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FactoryClient, WorkCentreKind } from '@nexus/factory-db'
import { kioskApplies, kioskCheck, type KioskReport } from '@nexus/factory-domain/auth/floor/kiosk'
import { speechLang } from '@nexus/factory-domain/auth/floor/literacy'
import { MODE_RULES, shownLineOf, type DeviceMode } from '@nexus/factory-domain/auth/floor/modes'
import { deviceStatus } from '@nexus/factory-domain/auth/floor/status'
import { ConflictError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertCsrf } from '../sessions/cookies'
import type { OfficeAuth } from '../sessions/office-auth'
import { deviceCookieOf, setDeviceCookie } from './cookies'
import { badgeOnlySignIn, floorCommand, floorContext, isLiveSession, liveDevice, SESSION_SELECT, siteScope, type FloorDevice } from './store'
import { floorHash, mintSiteToken, parseSiteToken, type SiteToken } from './tokens'
import type { DEVICE_NETWORKS } from './contract'

/**
 * The enrolled device itself (plan A1 §3.10 "Floor"; features PLT-056, PLT-058, PLT-062), before any operator signs in:
 *
 *   POST /floor/device/enrol   the tablet trades the one-time code of the Office's QR code for its device token
 *                              (an HttpOnly cookie): one command claims the code (unused, unexpired, not retired),
 *                              moves the device PENDING → ACTIVE and stores the token's hash, with its audit row.
 *   GET  /floor/device         what the floor app shows before a sign-in: the device, its site and station (with its
 *                              work centre's kind: the tablet's mode), the tenant's language, the site's sign-in rule
 *                              (a badge alone, or badge and PIN), whether someone is signed in, and the roster of the
 *                              site's active workers who have a PIN (names only, for a sign-in by name and PIN).
 *   POST /floor/device/state   the tablet's own state (B-W2a-42; PLT-241; design admin.devices): the floor app's version,
 *                              the battery (when the browser says it) and the actions waiting in its offline queue (a
 *                              count, never whose), signed in or not. Bookkeeping like the device's last contact: written
 *                              without an audit row and without the record's version (an office edit never conflicts
 *                              with a tablet's report). A new app version is a fact of the device's history ("app
 *                              updated" on its Activity tab): it is written in a floor command with its audit row
 *                              `floor.deviceAppUpdated` (before → after).
 * B-W2b-52 (MES-181, MES-186, MES-188, PLT-227): GET /floor/device also says the device's mode, what it means (who signs
 * in, where the tablet goes first, a crew, the kiosk guide), the line it shows, and the voice language of the screen;
 * a phone's roster is its one person and a line board's is empty. A phone keeps no battery or network (it is a
 * person's own: never more than the floor app needs). POST /floor/device/kiosk: the kiosk lock guide's honest check,
 * reported by the tablet: kept as a floor command's audit row on the device (`floor.deviceKioskChecked`), answered as
 * rows, never as "locked".
 * All run in the FLOOR scope of the code's or token's tenant and site; a bad code or token answers 401.
 */

export interface DeviceRequest {
  readonly device: FloorDevice
  readonly token: SiteToken
}

const notEnrolled = () => new UnauthenticatedError('This device is not enrolled, or it was revoked. Ask an administrator for a new enrolment QR code.')

/** The live device of the request's device cookie, or a 401. */
export async function requireDevice(auth: OfficeAuth, request: FastifyRequest): Promise<DeviceRequest> {
  const token = parseSiteToken(deviceCookieOf(request))
  if (!token) throw notEnrolled()
  const device = await auth.database.withScope(siteScope(token), (client) => liveDevice(client, token))
  if (!device) throw notEnrolled()
  return { device, token }
}

/** What a station read must select for `stationRef`. */
export const STATION_SELECT = { id: true, code: true, name: true, workCentre: { select: { kind: true } } } as const

export const stationRef = (station: { id: string; code: string; name: string; workCentre: { kind: WorkCentreKind } } | null) =>
  station ? { id: station.id, code: station.code, name: station.name, workCentreKind: station.workCentre.kind } : null

/** B-W2b-52: what a device's mode means for the tablet (factory-domain MODE_RULES), as the floor answers carry it. */
export function modeRulesOf(mode: DeviceMode) {
  const rule = MODE_RULES[mode]
  return { signIn: rule.signIn, landing: rule.landing, crew: rule.crew, kiosk: rule.kiosk, look: rule.look }
}

/** B-W2b-52: the line a device shows (a LINE or DISPLAY device its own or its station's; a station tablet its station's). */
export async function shownLine(client: FactoryClient, device: Pick<FloorDevice, 'mode' | 'lineId' | 'stationId'>) {
  const station = device.stationId ? await client.station.findUnique({ where: { id: device.stationId }, select: { lineId: true } }) : null
  const lineId = shownLineOf(device, station?.lineId ?? null)
  return lineId ? client.line.findUnique({ where: { id: lineId }, select: { id: true, code: true, name: true } }) : null
}

/** The device's answer (read in its site's floor scope). */
export async function deviceInfoOf(client: FactoryClient, device: FloorDevice, now: Date) {
  const [site, station, tenant, current, roster, badgeOnly, line] = await Promise.all([
    client.site.findUniqueOrThrow({ where: { id: device.siteId }, select: { id: true, code: true, name: true } }),
    device.stationId ? client.station.findUnique({ where: { id: device.stationId }, select: STATION_SELECT }) : null,
    client.tenant.findUniqueOrThrow({ where: { id: device.tenantId }, select: { defaultLocale: true } }),
    device.currentSessionId ? client.floorSession.findUnique({ where: { id: device.currentSessionId }, select: SESSION_SELECT }) : null,
    // B-W2b-52: a phone's roster is its one person; nobody signs in on a line board.
    device.mode === 'DISPLAY' || (device.mode === 'PHONE' && device.personalWorkerId === null) ? Promise.resolve([]) : client.worker.findMany({
      where: { status: 'ACTIVE', pinHash: { not: null }, ...(device.mode === 'PHONE' ? { id: device.personalWorkerId! } : {}) },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { id: true, displayName: true, locale: true },
    }),
    badgeOnlySignIn(client, device.siteId),
    shownLine(client, device),
  ])
  return {
    device: { id: device.id, name: device.name, kind: device.kind as 'TABLET' | 'HANDHELD' | 'PC', station: stationRef(station), mode: device.mode },
    rules: modeRulesOf(device.mode),
    line,
    speech: { lang: speechLang(tenant.defaultLocale) },
    site,
    defaultLocale: tenant.defaultLocale,
    signIn: { badgeOnly },
    operatorSignedIn: current !== null && isLiveSession(current, now),
    roster,
  }
}

export async function deviceInfo(auth: OfficeAuth, request: FastifyRequest) {
  const { device, token } = await requireDevice(auth, request)
  return auth.database.withScope(siteScope(token), (client) => deviceInfoOf(client, device, auth.clock.now()))
}

export async function enrolDevice(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, body: { code: string; appVersion?: string | undefined }) {
  assertCsrf(request)
  const refused = () => new UnauthenticatedError('This enrolment code is not valid, was used or has expired. Ask for a new QR code.')
  const code = parseSiteToken(body.code)
  if (!code) throw refused()
  const now = auth.clock.now()
  const enrolment = await auth.database.withScope(siteScope(code), (client) =>
    client.deviceEnrolment.findUnique({
      where: { codeHash: floorHash(code.value) },
      select: { id: true, deviceId: true, createdById: true, expiresAt: true, usedAt: true, revokedAt: true, device: { select: { status: true } } },
    }),
  )
  if (!enrolment || enrolment.id !== code.id || enrolment.usedAt || enrolment.revokedAt || enrolment.expiresAt.getTime() <= now.getTime() || enrolment.device.status !== 'PENDING') {
    throw refused()
  }

  const place = { tenantId: code.tenantId, siteId: code.siteId, id: enrolment.deviceId }
  const token = mintSiteToken(code.tenantId, code.siteId, enrolment.deviceId)
  const appVersion = body.appVersion ?? null
  await floorCommand(
    auth,
    floorContext(request, place, place.id),
    { name: 'floor.enrolDevice', input: { enrolmentId: enrolment.id, appVersion }, record: { type: 'Device', id: place.id, transition: { machine: deviceStatus, to: 'ACTIVE' } } },
    async ({ tx, now: at, audit }) => {
      // The code works once: a second tablet racing the first finds it used.
      const { count } = await tx.deviceEnrolment.updateMany({ where: { id: enrolment.id, usedAt: null, revokedAt: null, expiresAt: { gt: at } }, data: { usedAt: at } })
      if (count !== 1) throw refused()
      await tx.device.updateMany({
        where: { id: place.id },
        data: { tokenHash: floorHash(token.value), enrolledAt: at, enrolledById: enrolment.createdById, appVersion, lastSeenAt: at },
      })
      audit({ recordType: 'Device', recordId: place.id, after: { status: 'ACTIVE', enrolmentId: enrolment.id, appVersion } })
      return null
    },
  )
  setDeviceCookie(reply, token.value)
  return auth.database.withScope(siteScope(token), async (client) => {
    const device = await liveDevice(client, token)
    if (!device) throw refused()
    return deviceInfoOf(client, device, auth.clock.now())
  })
}

export interface DeviceStateReport {
  readonly appVersion: string
  readonly batteryPercent: number | null
  readonly batteryCharging: boolean | null
  readonly queuedActions: number
  /** B-W2b-24: the network the browser says (null: it did not say; left out: an older floor app, the column is kept). */
  readonly network?: (typeof DEVICE_NETWORKS)[number] | null | undefined
}

export async function reportDeviceState(auth: OfficeAuth, request: FastifyRequest, body: DeviceStateReport) {
  assertCsrf(request)
  const { device, token } = await requireDevice(auth, request)
  const now = auth.clock.now()
  // B-W2b-52 (MES-186): a person's own phone keeps no battery and no network (GDPR art. 5(1)(c)): only what the floor
  // app needs (its version, its queue's count).
  const personal = !MODE_RULES[device.mode].keepsBatteryAndNetwork
  const state = personal
    ? { batteryPercent: null, batteryCharging: null, network: null, queuedActions: body.queuedActions, statusReportedAt: now, lastSeenAt: now }
    : { batteryPercent: body.batteryPercent, batteryCharging: body.batteryCharging, queuedActions: body.queuedActions, statusReportedAt: now, lastSeenAt: now, ...(body.network !== undefined ? { network: body.network } : {}) }
  const before = await auth.database.withScope(siteScope(token), (client) => client.device.findUnique({ where: { id: device.id }, select: { appVersion: true } }))
  const from = before?.appVersion ?? null
  if (from === body.appVersion) {
    await auth.database.withScope(siteScope(token), (client) => client.device.updateMany({ where: { id: device.id, status: 'ACTIVE' }, data: state }))
    return { reportedAt: toUtcIso(now), appUpdated: false }
  }
  const place = { tenantId: token.tenantId, siteId: token.siteId, id: device.id }
  await floorCommand(auth, floorContext(request, place, device.id), { name: 'floor.deviceAppUpdated', input: { deviceId: device.id, from, to: body.appVersion } }, async ({ tx, audit }) => {
    await tx.device.updateMany({ where: { id: device.id, status: 'ACTIVE' }, data: { ...state, appVersion: body.appVersion } })
    audit({ recordType: 'Device', recordId: device.id, before: { appVersion: from }, after: { appVersion: body.appVersion } })
    return null
  })
  return { reportedAt: toUtcIso(now), appUpdated: true }
}

/** The kiosk check's audit action on the device (the office's device view reads the last one). */
export const KIOSK_CHECKED = 'floor.deviceKioskChecked'

/**
 * POST /floor/device/kiosk (B-W2b-52; PLT-227): the kiosk lock guide's honest check, reported by the tablet itself (the
 * device token + CSRF, signed in or not). One floor command with its audit row on the device (the device as the actor):
 * what the tablet could check (full screen, installed) and what the person said after pressing Home, never more. A
 * person's own phone is never kiosk-locked: its report is refused (409).
 */
export async function reportKioskCheck(auth: OfficeAuth, request: FastifyRequest, body: KioskReport) {
  assertCsrf(request)
  const { device, token } = await requireDevice(auth, request)
  if (!kioskApplies(device.mode)) throw new ConflictError('A personal phone is never locked to the app: it is its person\'s own.')
  const check = kioskCheck(body)
  const place = { tenantId: token.tenantId, siteId: token.siteId, id: device.id }
  const { result } = await floorCommand(auth, floorContext(request, place, device.id), { name: KIOSK_CHECKED, input: { deviceId: device.id, ...body } }, async ({ tx, now, audit }) => {
    await tx.device.updateMany({ where: { id: device.id, status: 'ACTIVE' }, data: { lastSeenAt: now } })
    audit({ recordType: 'Device', recordId: device.id, after: { fullScreen: body.fullScreen, installed: body.installed, homeTest: body.homeTest, looksLocked: check.looksLocked } })
    return toUtcIso(now)
  })
  return { checkedAt: result, applies: true, rows: [...check.rows], lockedKnown: check.lockedKnown, looksLocked: check.looksLocked }
}
