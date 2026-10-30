import type { FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
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
 * The registry says whether a device is in use, never who uses it (Statuto dei Lavoratori art. 4: no presence board).
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

async function checkStation(client: FactoryClient | CommandTx, siteId: string, stationId: string): Promise<void> {
  const station = await client.station.findFirst({ where: { id: stationId, siteId, status: 'ACTIVE' }, select: { id: true } })
  if (!station) throw new ValidationError('The station must be an active station of the device\'s site.', [{ path: 'stationId', message: 'Expected a station of the site.' }])
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
  currentSession: { select: { endedAt: true, idleExpiresAt: true, endsAt: true } },
} as const

type DeviceRow = Prisma.DeviceGetPayload<{ select: typeof DEVICE_VIEW_SELECT }>

function deviceViewOf(row: DeviceRow, now: Date): DeviceView {
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
    version: row.version,
  }
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
  const rows = await request.withClient((client) =>
    client.device.findMany({
      where: { AND: [scope, query.siteId ? { siteId: query.siteId } : {}] },
      orderBy: [{ siteId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 500,
      select: DEVICE_VIEW_SELECT,
    }),
  )
  const now = auth.clock.now()
  return { devices: rows.map((row) => deviceViewOf(row, now)) }
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
  const code = mintEnrolment(context, site.id)
  const spec = { name: 'devices.enrol' as const, idempotencyKey: idempotencyKeyFrom(request), input: { siteId: site.id, stationId: body.stationId ?? null, name: body.name, kind } }
  const { result, replayed } = await auth.command(context, spec, async ({ tx, now, audit }) => {
    await tx.device.create({
      data: { id: deviceId, companyId: site.companyId, siteId: site.id, stationId: body.stationId ?? null, name: body.name, kind, createdAt: now, createdById: context.actorId },
      select: { id: true },
    })
    const enrolment = await storeEnrolment(tx, context, { id: deviceId, siteId: site.id }, code, now)
    audit({
      recordType: 'Device',
      recordId: deviceId,
      companyId: site.companyId,
      siteId: site.id,
      after: { name: body.name, kind, stationId: body.stationId ?? null, status: 'PENDING', enrolmentId: enrolment.enrolmentId, enrolmentExpiresAt: toUtcIso(enrolment.expiresAt) },
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
  const { result } = await auth.command(context, { name: 'devices.edit', input: body, record: { type: 'Device', id: deviceId, expectedVersion: body.version } }, async ({ tx, now, audit }) => {
    const data = { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.stationId !== undefined ? { stationId: body.stationId } : {}) }
    await tx.device.updateMany({ where: { id: deviceId }, data })
    audit({ recordType: 'Device', recordId: deviceId, companyId: before.companyId, siteId: before.siteId, before: { name: before.name, stationId: before.stationId }, after: data })
    return deviceViewOf(await deviceRow(tx, deviceId), now)
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
      await tx.device.updateMany({ where: { id: deviceId }, data: { tokenHash: null, currentSessionId: null, revokedAt: now, revokedById: context.actorId } })
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
