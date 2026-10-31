import type { FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { deviceModeProblems, MODE_RULES, type DeviceMode } from '@nexus/factory-domain/auth/floor/modes'
import { defaultTiming, normalizeShiftEnds, timingProblems } from '@nexus/factory-domain/auth/floor/session'
import { deviceStatus } from '@nexus/factory-domain/auth/floor/status'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { idempotencyKeyFrom, type CommandTx } from '../../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { closeDeviceBlocks } from '../../numbering/scan-ids'
import type { OfficeAuth } from '../sessions/office-auth'
import type { CreateDeviceBody, DeviceView, EditDeviceBody, PutSettingsBody, RevokeDeviceBody } from './contract'
import { KIOSK_CHECKED } from './device'
import { endSessions, isLiveSession } from './store'
import { floorHash, mintSiteToken, type SiteToken } from './tokens'

/**
 * The Office's device registry and floor session times (plan A1 §3.10 "Floor"; features PLT-056, PLT-060, PLT-226).
 * Every route is scoped by record: an office person reaches the devices and sites of the companies and sites their
 * grants reach (can() for one, scopeWhere() for a list); every write is one office command with its audit row.
 *
 *   enrol      a PENDING device and a one-time code (15 minutes), shown once as a QR code of a web link; the tablet
 *              that scans it trades the code for its token (floor/device.ts). A new code retires the older ones. The
 *              code is minted before the command and never in its result: a repeat with the same Idempotency-Key
 *              answers from the receipt, with the first device and no code.
 *   edit       rename, move to another station of its site (version).
 *   revoke     PENDING or ACTIVE → REVOKED: the token is cleared, open sign-ins end at once (DEVICE_REVOKED), unused
 *              codes are retired. A revoked device stays listed; enrol a new one.
 *   times      a site's idle minutes (1 to 120, default 10) and shift ends (HH:MM in the site's time zone), and whether a
 *              badge alone signs a worker in (Owner answer F1 a; default false: badge and PIN). Switching it on asks no
 *              step-up, like the idle minutes; it is audited with before and after. Sessions already started keep
 *              running until their idle or shift end.
 *   modes      B-W2b-52 (MES-181, MES-186): the mode chosen at enrolment (STATION by default; LINE and DISPLAY show a
 *              line, their own or their station's; PHONE names its one person, of the site, and sits at no station),
 *              checked by factory-domain auth/floor/modes; changed later only while nobody is signed in on the device
 *              (409 otherwise: a line board or a phone must never keep someone else's session).
 * The registry says whether a device is in use, never who uses it (Statuto dei Lavoratori art. 4: no presence board);
 * a phone's person is an id here (the name only inside the device's record). It also carries the tablet's last kiosk
 * check (PLT-227), as reported, never "locked".
 */

export const ENROLMENT_TTL_MS = 15 * 60_000

const DEVICES_VIEW: Permission = 'devices.view'
const DEVICES_MANAGE: Permission = 'devices.manage'
const DEVICES_REVOKE: Permission = 'devices.revoke'

export const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** The office person may do `permission` on a record of this company and site; a 403 otherwise. */
export function assertReaches(context: OfficeContext, permission: Permission, record: { readonly companyId: string; readonly siteId: string }): void {
  if (!can(actorOf(context), permission, record)) throw new ForbiddenError('This site is outside your access.')
}

/** The active site of the tenant, or a 400 at `path`. */
export async function activeSite(client: FactoryClient, siteId: string, path = 'siteId') {
  const site = await client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, status: true, timezone: true } })
  if (!site || site.status !== 'ACTIVE') throw new ValidationError('No active site of the tenant has this id.', [{ path, message: 'Expected an active site.' }])
  return site
}

async function checkStation(client: FactoryClient | CommandTx, siteId: string, stationId: string): Promise<{ lineId: string | null }> {
  const station = await client.station.findFirst({ where: { id: stationId, siteId, status: 'ACTIVE' }, select: { id: true, lineId: true } })
  if (!station) throw new ValidationError('The station must be an active station of the device\'s site.', [{ path: 'stationId', message: 'Expected a station of the site.' }])
  return { lineId: station.lineId }
}

interface ModeChoice {
  readonly mode: DeviceMode
  readonly kind: 'TABLET' | 'HANDHELD' | 'PC'
  readonly stationId: string | null
  readonly lineId: string | null
  readonly personalWorkerId: string | null
}

/**
 * B-W2b-52: the mode, line and person of a device are right together (factory-domain deviceModeProblems), the line is an
 * active line of the device's site and the person an active worker of it (400 at the field otherwise).
 */
async function checkMode(client: FactoryClient, siteId: string, choice: ModeChoice): Promise<void> {
  const stationLineId = choice.stationId ? (await client.station.findFirst({ where: { id: choice.stationId, siteId }, select: { lineId: true } }))?.lineId ?? null : null
  const issues = deviceModeProblems({ ...choice, stationLineId })
  if (issues.length > 0) throw new ValidationError("The device's mode does not fit its line, station or person.", issues)
  if (choice.lineId) {
    const line = await client.line.findFirst({ where: { id: choice.lineId, siteId, status: 'ACTIVE' }, select: { id: true } })
    if (!line) throw new ValidationError('The line must be an active line of the device\'s site.', [{ path: 'lineId', message: 'Expected a line of the site.' }])
  }
  if (choice.personalWorkerId) {
    const worker = await client.worker.findFirst({ where: { id: choice.personalWorkerId, siteId, status: 'ACTIVE' }, select: { id: true } })
    if (!worker) throw new ValidationError('The phone\'s person must be an active worker of the device\'s site.', [{ path: 'personalWorkerId', message: 'Expected a worker of the site.' }])
  }
}

const DEVICE_VIEW_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  stationId: true,
  name: true,
  kind: true,
  status: true,
  enrolledAt: true,
  lastSeenAt: true,
  appVersion: true,
  batteryPercent: true,
  batteryCharging: true,
  queuedActions: true,
  statusReportedAt: true,
  revokedAt: true,
  version: true,
  network: true,
  inUseSince: true,
  mode: true,
  lineId: true,
  personalWorkerId: true,
  currentSession: { select: { endedAt: true, idleExpiresAt: true, endsAt: true, startedAt: true } },
} as const

/** B-W2b-52 (PLT-227): a tablet's last kiosk check, as its audit row keeps it. */
type KioskSeen = NonNullable<DeviceView['kiosk']>

type DeviceRow = Prisma.DeviceGetPayload<{ select: typeof DEVICE_VIEW_SELECT }>

function deviceViewOf(row: DeviceRow, now: Date, kiosk: KioskSeen | null = null): DeviceView {
  return {
    id: row.id,
    siteId: row.siteId,
    stationId: row.stationId,
    name: row.name,
    kind: row.kind,
    status: row.status,
    enrolledAt: row.enrolledAt ? toUtcIso(row.enrolledAt) : null,
    lastSeenAt: row.lastSeenAt ? toUtcIso(row.lastSeenAt) : null,
    appVersion: row.appVersion,
    batteryPercent: row.batteryPercent,
    batteryCharging: row.batteryCharging,
    queuedActions: row.queuedActions,
    statusReportedAt: row.statusReportedAt ? toUtcIso(row.statusReportedAt) : null,
    revokedAt: row.revokedAt ? toUtcIso(row.revokedAt) : null,
    inUse: row.currentSession !== null && isLiveSession(row.currentSession, now),
    // B-W2b-24: since the session opened (the column the sign-in sets; the session's own start for one opened before it).
    inUseSince: row.currentSession !== null && isLiveSession(row.currentSession, now) ? toUtcIso(row.inUseSince ?? row.currentSession.startedAt) : null,
    network: row.network,
    mode: row.mode,
    lineId: row.lineId,
    personalWorkerId: row.personalWorkerId,
    kiosk,
    version: row.version,
  }
}

const HOME_TESTS = new Set(['STAYED', 'LEFT', 'NOT_TESTED'])
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

/** The last kiosk check each device reported (its audit row `floor.deviceKioskChecked`), by device. */
async function kioskChecks(client: FactoryClient | CommandTx, deviceIds: readonly string[]): Promise<Map<string, KioskSeen>> {
  if (deviceIds.length === 0) return new Map()
  const rows = await client.auditLog.findMany({
    where: { recordType: 'Device', recordId: { in: [...deviceIds] }, action: KIOSK_CHECKED },
    orderBy: [{ recordId: 'asc' }, { at: 'desc' }, { id: 'desc' }],
    distinct: ['recordId'],
    select: { recordId: true, at: true, after: true },
  })
  const seen = new Map<string, KioskSeen>()
  for (const row of rows) {
    const after = (row.after ?? {}) as Record<string, unknown>
    const homeTest = typeof after.homeTest === 'string' && HOME_TESTS.has(after.homeTest) ? (after.homeTest as KioskSeen['homeTest']) : 'NOT_TESTED'
    seen.set(row.recordId, { checkedAt: toUtcIso(row.at), fullScreen: flag(after.fullScreen), installed: flag(after.installed), homeTest, looksLocked: after.looksLocked === true })
  }
  return seen
}

async function deviceRow(client: FactoryClient | CommandTx, deviceId: string): Promise<DeviceRow> {
  const row = await client.device.findUnique({ where: { id: deviceId }, select: DEVICE_VIEW_SELECT })
  if (!row) throw new NotFoundError('Device not found.')
  return row
}

/** The device, if the office person may do `permission` on it (404 / 403 otherwise). */
async function reachableDevice(request: FastifyRequest, deviceId: string, permission: Permission): Promise<DeviceRow> {
  const row = await request.withClient((client) => deviceRow(client, deviceId))
  assertReaches(officeContextOf(request), permission, row)
  return row
}

export async function listDevices(auth: OfficeAuth, request: FastifyRequest, query: { siteId?: string | undefined }) {
  const context = officeContextOf(request)
  const scope = scopeWhere(actorOf(context), DEVICES_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.DeviceWhereInput
  const { rows, kiosk } = await request.withClient(async (client) => {
    const found = await client.device.findMany({
      where: { AND: [scope, query.siteId ? { siteId: query.siteId } : {}] },
      orderBy: [{ siteId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 500,
      select: DEVICE_VIEW_SELECT,
    })
    return { rows: found, kiosk: await kioskChecks(client, found.map((row) => row.id)) }
  })
  const now = auth.clock.now()
  return { devices: rows.map((row) => deviceViewOf(row, now, kiosk.get(row.id) ?? null)) }
}

/** The enrolment answer: the code, the web link the QR code carries (the code in its fragment) and the QR code. */
async function enrolmentAnswer(auth: OfficeAuth, code: string, expiresAt: string) {
  const url = auth.link('/floor/enrol', code)
  const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
  return { code, url, qrSvg, expiresAt }
}

/** A one-time enrolment code, minted BEFORE its command: only its hash enters the command (never its result). */
const mintEnrolment = (context: OfficeContext, siteId: string): SiteToken => mintSiteToken(context.tenantId, siteId, newId())

/** Stores a PENDING device's new code (inside the command); the older unused ones are retired. */
async function storeEnrolment(tx: CommandTx, context: OfficeContext, device: { id: string; siteId: string }, code: SiteToken, now: Date) {
  await tx.deviceEnrolment.updateMany({ where: { deviceId: device.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } })
  const expiresAt = new Date(now.getTime() + ENROLMENT_TTL_MS)
  await tx.deviceEnrolment.create({
    data: { id: code.id, siteId: device.siteId, deviceId: device.id, codeHash: floorHash(code.value), createdById: context.actorId, createdAt: now, expiresAt },
    select: { id: true },
  })
  return { enrolmentId: code.id, expiresAt }
}

export async function createDevice(auth: OfficeAuth, request: FastifyRequest, body: CreateDeviceBody) {
  const context = officeContextOf(request)
  const site = await request.withClient((client) => activeSite(client, body.siteId))
  assertReaches(context, DEVICES_MANAGE, { companyId: site.companyId, siteId: site.id })
  if (body.stationId) await request.withClient((client) => checkStation(client, site.id, body.stationId!))
  const deviceId = newId()
  const kind = body.kind ?? 'TABLET'
  // B-W2b-52: the mode chosen at enrolment (MES-181, MES-186).
  const mode = { mode: body.mode ?? ('STATION' as const), lineId: body.lineId ?? null, personalWorkerId: body.personalWorkerId ?? null }
  await request.withClient((client) => checkMode(client, site.id, { ...mode, kind, stationId: body.stationId ?? null }))
  const code = mintEnrolment(context, site.id)
  const spec = { name: 'devices.enrol' as const, idempotencyKey: idempotencyKeyFrom(request), input: { siteId: site.id, stationId: body.stationId ?? null, name: body.name, kind, ...mode } }
  const { result, replayed } = await auth.command(context, spec, async ({ tx, now, audit }) => {
    await tx.device.create({
      data: { id: deviceId, companyId: site.companyId, siteId: site.id, stationId: body.stationId ?? null, name: body.name, kind, ...mode, createdAt: now, createdById: context.actorId },
      select: { id: true },
    })
    const enrolment = await storeEnrolment(tx, context, { id: deviceId, siteId: site.id }, code, now)
    audit({
      recordType: 'Device',
      recordId: deviceId,
      companyId: site.companyId,
      siteId: site.id,
      after: { name: body.name, kind, stationId: body.stationId ?? null, ...mode, status: 'PENDING', enrolmentId: enrolment.enrolmentId, enrolmentExpiresAt: toUtcIso(enrolment.expiresAt) },
    })
    return { deviceId, expiresAt: toUtcIso(enrolment.expiresAt) }
  })
  // A repeat answers from its receipt: the first request's device, and no code (it was never stored).
  const row = await request.withClient((client) => deviceRow(client, result.deviceId))
  return { device: deviceViewOf(row, auth.clock.now()), enrolment: replayed ? null : await enrolmentAnswer(auth, code.value, result.expiresAt) }
}

export async function renewEnrolment(auth: OfficeAuth, request: FastifyRequest, deviceId: string) {
  const context = officeContextOf(request)
  const before = await reachableDevice(request, deviceId, DEVICES_MANAGE)
  if (before.status !== 'PENDING') throw new InvalidStateError('Only a device waiting for its enrolment gets a new code; revoke it and enrol a new one.')
  const code = mintEnrolment(context, before.siteId)
  const spec = { name: 'devices.renewEnrolment' as const, idempotencyKey: idempotencyKeyFrom(request), input: null, record: { type: 'Device' as const, id: deviceId } }
  const { result, replayed } = await auth.command(context, spec, async ({ tx, now, audit }) => {
    const row = await deviceRow(tx, deviceId)
    if (row.status !== 'PENDING') throw new InvalidStateError('This device is no longer waiting for its enrolment.')
    const enrolment = await storeEnrolment(tx, context, row, code, now)
    audit({ recordType: 'Device', recordId: deviceId, companyId: row.companyId, siteId: row.siteId, after: { enrolmentId: enrolment.enrolmentId, enrolmentExpiresAt: toUtcIso(enrolment.expiresAt) } })
    return { expiresAt: toUtcIso(enrolment.expiresAt) }
  })
  const row = await request.withClient((client) => deviceRow(client, deviceId))
  return { device: deviceViewOf(row, auth.clock.now()), enrolment: replayed ? null : await enrolmentAnswer(auth, code.value, result.expiresAt) }
}

export async function editDevice(auth: OfficeAuth, request: FastifyRequest, deviceId: string, body: EditDeviceBody) {
  const context = officeContextOf(request)
  const before = await reachableDevice(request, deviceId, DEVICES_MANAGE)
  if (before.status === 'REVOKED') throw new InvalidStateError('A revoked device is kept as it was.')
  if (body.stationId) await request.withClient((client) => checkStation(client, before.siteId, body.stationId!))
  // B-W2b-52: a new mode, line or person, checked with the station it will have.
  // Leaving a mode drops what only it has: the line of a line tablet or board, the person of a phone.
  const nextMode = body.mode ?? before.mode
  const next = {
    mode: nextMode,
    lineId: body.lineId !== undefined ? body.lineId : MODE_RULES[nextMode].showsLine ? before.lineId : null,
    personalWorkerId: body.personalWorkerId !== undefined ? body.personalWorkerId : nextMode === 'PHONE' ? before.personalWorkerId : null,
  }
  const modeChanged = next.mode !== before.mode || next.lineId !== before.lineId || next.personalWorkerId !== before.personalWorkerId
  const stationAfter = body.stationId !== undefined ? body.stationId : before.stationId
  if (modeChanged || body.stationId !== undefined) await request.withClient((client) => checkMode(client, before.siteId, { ...next, kind: before.kind, stationId: stationAfter }))
  const { result } = await auth.command(context, { name: 'devices.edit', input: body, record: { type: 'Device', id: deviceId, expectedVersion: body.version } }, async ({ tx, now, audit }) => {
    if (modeChanged && (next.mode !== before.mode || next.personalWorkerId !== before.personalWorkerId)) {
      const live = await tx.device.findUnique({ where: { id: deviceId }, select: { currentSession: { select: { endedAt: true, idleExpiresAt: true, endsAt: true } } } })
      const openCrews = await tx.crewSession.count({ where: { deviceId, endedAt: null } })
      if ((live?.currentSession && isLiveSession(live.currentSession, now)) || openCrews > 0) {
        throw new ConflictError('Someone is signed in on this device: change its mode or person once nobody is (or revoke it).')
      }
    }
    const data = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.stationId !== undefined ? { stationId: body.stationId } : {}),
      ...(modeChanged ? next : {}),
    }
    await tx.device.updateMany({ where: { id: deviceId }, data })
    audit({
      recordType: 'Device',
      recordId: deviceId,
      companyId: before.companyId,
      siteId: before.siteId,
      before: { name: before.name, stationId: before.stationId, ...(modeChanged ? { mode: before.mode, lineId: before.lineId, personalWorkerId: before.personalWorkerId } : {}) },
      after: data,
    })
    return deviceViewOf(await deviceRow(tx, deviceId), now, (await kioskChecks(tx, [deviceId])).get(deviceId) ?? null)
  })
  return result
}

export async function revokeDevice(auth: OfficeAuth, request: FastifyRequest, deviceId: string, body: RevokeDeviceBody) {
  const context = officeContextOf(request)
  const before = await reachableDevice(request, deviceId, DEVICES_REVOKE)
  const { result } = await auth.command(
    context,
    { name: 'devices.revoke', input: body, record: { type: 'Device', id: deviceId, ...(body.version ? { expectedVersion: body.version } : {}), transition: { machine: deviceStatus, to: 'REVOKED' } } },
    async ({ tx, now, audit }) => {
      const ended = await endSessions(tx, { deviceId }, 'DEVICE_REVOKED', now)
      await tx.device.updateMany({ where: { id: deviceId }, data: { tokenHash: null, currentSessionId: null, inUseSince: null, revokedAt: now, revokedById: context.actorId } })
      const retired = await tx.deviceEnrolment.updateMany({ where: { deviceId, usedAt: null, revokedAt: null }, data: { revokedAt: now } })
      // Its scan-id blocks close with it: a label it printed and never sent is refused, its numbers left never used.
      const blocksClosed = await closeDeviceBlocks({ tx, now, audit }, { id: deviceId, companyId: before.companyId, siteId: before.siteId }, `Tablet revoked${body.reason ? `: ${body.reason}` : ''}`)
      audit({
        recordType: 'Device',
        recordId: deviceId,
        companyId: before.companyId,
        siteId: before.siteId,
        before: { status: before.status },
        after: { status: 'REVOKED', sessionsEnded: ended.length, codesRetired: retired.count, blocksClosed },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      return deviceViewOf(await deviceRow(tx, deviceId), now)
    },
  )
  return result
}

const settingsSelect = { idleMinutes: true, shiftEnds: true, badgeOnlySignIn: true, version: true } as const

export async function getSettings(request: FastifyRequest, siteId: string) {
  const context = officeContextOf(request)
  return request.withClient(async (client) => {
    const site = await activeSite(client, siteId)
    assertReaches(context, DEVICES_VIEW, { companyId: site.companyId, siteId: site.id })
    const row = await client.floorSettings.findUnique({ where: { id: site.id }, select: settingsSelect })
    const timing = defaultTiming(site.timezone)
    return {
      siteId: site.id,
      idleMinutes: row?.idleMinutes ?? timing.idleMinutes,
      shiftEnds: row?.shiftEnds ?? [],
      badgeOnlySignIn: row?.badgeOnlySignIn ?? false,
      timeZone: site.timezone,
      version: row?.version ?? null,
    }
  })
}

export async function putSettings(auth: OfficeAuth, request: FastifyRequest, siteId: string, body: PutSettingsBody) {
  const context = officeContextOf(request)
  const issues = timingProblems(body)
  if (issues.length > 0) throw new ValidationError('The floor session times are not valid.', issues)
  const shiftEnds = normalizeShiftEnds(body.shiftEnds)
  const { site, existing } = await request.withClient(async (client) => {
    const found = await activeSite(client, siteId)
    return { site: found, existing: await client.floorSettings.findUnique({ where: { id: found.id }, select: settingsSelect }) }
  })
  assertReaches(context, DEVICES_MANAGE, { companyId: site.companyId, siteId: site.id })
  const after = { idleMinutes: body.idleMinutes, shiftEnds, badgeOnlySignIn: body.badgeOnlySignIn ?? existing?.badgeOnlySignIn ?? false }
  try {
    await auth.command(
      context,
      { name: 'devices.setFloorTimes', input: body, ...(existing ? { record: { type: 'FloorSettings' as const, id: site.id, ...(body.version ? { expectedVersion: body.version } : {}) } } : {}) },
      async ({ tx, now, audit }) => {
        if (existing) await tx.floorSettings.updateMany({ where: { id: site.id }, data: after })
        else await tx.floorSettings.create({ data: { id: site.id, companyId: site.companyId, siteId: site.id, ...after, createdAt: now, createdById: context.actorId }, select: { id: true } })
        audit({ recordType: 'FloorSettings', recordId: site.id, companyId: site.companyId, siteId: site.id, before: existing ? { idleMinutes: existing.idleMinutes, shiftEnds: existing.shiftEnds, badgeOnlySignIn: existing.badgeOnlySignIn } : null, after })
        return null
      },
    )
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('The floor session times of this site changed meanwhile. Reload them.')
    throw error
  }
  return getSettings(request, siteId)
}
