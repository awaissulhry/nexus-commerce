import type { FastifyRequest } from 'fastify'
import type { FactoryClient, FactoryDatabase, FactoryScope, FloorSessionEndReason, Prisma } from '@nexus/factory-db'
import { floorGrants, type FloorRole } from '@nexus/factory-domain/auth/floor/grants'
import { defaultTiming, sessionState, type FloorTiming } from '@nexus/factory-domain/auth/floor/session'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandOutcome, type CommandSpec, type CommandTools, type CommandTx } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import type { Clock } from '../../../core/time'
import { matchesHash, type SiteToken } from './tokens'

/**
 * What the floor routes and the floor authenticator share (plan A1 §3.10 "Floor"). Every read and write a tablet
 * causes runs in the FLOOR scope of the device token's tenant and site (factory_floor_runtime): before an operator is
 * signed in the scope's actor is the device (or the enrolment code), afterwards the worker. Office administrators end
 * floor sessions from the office scope with `endSessions` too.
 */

export interface FloorCore {
  readonly database: FactoryDatabase
  readonly clock: Clock
}

/** The floor scope of a device token or enrolment code, with the device (or code) as the actor. */
export const siteScope = (token: SiteToken): FactoryScope => ({ audience: 'floor', tenantId: token.tenantId, siteId: token.siteId, actorId: token.id })

/** The device of a token, as the floor routes need it. */
export interface FloorDevice {
  readonly id: string
  readonly tenantId: string
  readonly siteId: string
  readonly companyId: string
  readonly stationId: string | null
  readonly name: string
  readonly kind: string
  readonly currentSessionId: string | null
  readonly lastSeenAt: Date | null
}

const DEVICE_SELECT = {
  id: true,
  companyId: true,
  stationId: true,
  name: true,
  kind: true,
  status: true,
  tokenHash: true,
  currentSessionId: true,
  lastSeenAt: true,
  site: { select: { status: true } },
} as const

/**
 * The live device of a token, read in the token's site: it exists there, is ACTIVE, its token matches (constant time),
 * and its site and tenant are active. Null otherwise (a revoked device, another site's id, a forged secret).
 */
export async function liveDevice(client: FactoryClient | CommandTx, token: SiteToken): Promise<FloorDevice | null> {
  const row = await client.device.findUnique({ where: { id: token.id }, select: DEVICE_SELECT })
  if (!row || row.status !== 'ACTIVE' || !matchesHash(row.tokenHash, token.value) || row.site.status !== 'ACTIVE') return null
  const tenant = await client.tenant.findUnique({ where: { id: token.tenantId }, select: { status: true } })
  if (tenant?.status !== 'ACTIVE') return null
  return {
    id: row.id,
    tenantId: token.tenantId,
    siteId: token.siteId,
    companyId: row.companyId,
    stationId: row.stationId,
    name: row.name,
    kind: row.kind,
    currentSessionId: row.currentSessionId,
    lastSeenAt: row.lastSeenAt,
  }
}

/** The site's floor session times (its FloorSettings row, whose id is the site's id), or the defaults. */
export async function siteTiming(client: FactoryClient | CommandTx, siteId: string): Promise<FloorTiming> {
  const [site, settings] = await Promise.all([
    client.site.findUnique({ where: { id: siteId }, select: { timezone: true } }),
    client.floorSettings.findUnique({ where: { id: siteId }, select: { idleMinutes: true, shiftEnds: true } }),
  ])
  const timeZone = site?.timezone ?? defaultTiming().timeZone
  return settings ? { idleMinutes: settings.idleMinutes, shiftEnds: settings.shiftEnds, timeZone } : defaultTiming(timeZone)
}

export const SESSION_SELECT = {
  id: true,
  deviceId: true,
  workerId: true,
  badgeId: true,
  startedAt: true,
  lastSeenAt: true,
  idleExpiresAt: true,
  endsAt: true,
  endedAt: true,
} as const

export type FloorSessionRow = Prisma.FloorSessionGetPayload<{ select: typeof SESSION_SELECT }>

/** A live session row: not ended, before its idle and shift end. */
export const isLiveSession = (row: Pick<FloorSessionRow, 'endedAt' | 'idleExpiresAt' | 'endsAt'>, now: Date): boolean => sessionState(row, now) === 'live'

/** The worker's live floor roles (FLOOR audience only), as the grants are built from. */
export async function floorRolesOf(client: FactoryClient | CommandTx, workerId: string): Promise<FloorRole[]> {
  const rows = await client.workerRole.findMany({
    where: { workerId, endedAt: null, role: { audience: 'FLOOR' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { role: { select: { permissions: true, grains: true } } },
  })
  return rows.map((row) => row.role)
}

/** The grants of a floor session of this worker on this device. */
export async function floorGrantsOf(
  client: FactoryClient | CommandTx,
  worker: { readonly id: string; readonly pinMustChange: boolean },
  device: Pick<FloorDevice, 'companyId' | 'siteId'>,
): Promise<Grant[]> {
  if (worker.pinMustChange) return []
  return floorGrants(await floorRolesOf(client, worker.id), { companyId: device.companyId, siteId: device.siteId })
}

/**
 * Ends the open sessions matching `where` (inside a command: office or floor scope) and frees their devices. Returns
 * the ended sessions' ids. A device whose current session ended no longer has an operator.
 */
export async function endSessions(tx: CommandTx, where: Prisma.FloorSessionWhereInput, reason: FloorSessionEndReason, now: Date): Promise<string[]> {
  const open = await tx.floorSession.findMany({ where: { AND: [where, { endedAt: null }] }, select: { id: true } })
  const ids = open.map((row) => row.id)
  if (ids.length === 0) return []
  await tx.floorSession.updateMany({ where: { id: { in: ids }, endedAt: null }, data: { endedAt: now, endReason: reason } })
  await tx.device.updateMany({ where: { currentSessionId: { in: ids } }, data: { currentSessionId: null } })
  return ids
}

/** The floor context of a device's request: the device's site, the worker (or the device) as the actor. */
export function floorContext(request: FastifyRequest, device: Pick<FloorDevice, 'tenantId' | 'siteId' | 'id'>, actorId: string, grants: readonly Grant[] = []): FloorContext {
  return { audience: 'floor', tenantId: device.tenantId, siteId: device.siteId, deviceId: device.id, actorId, grants, requestId: String(request.id) }
}

/**
 * command() for the floor's own sign-in bookkeeping, on the core's clock. Floor writes need an Idempotency-Key
 * (core/command.ts: a device resends its queue); these commands are never replays (a sign-in mints a new token, a
 * wrong PIN must count again), so each takes a fresh server key. Their input and result never hold a token or a PIN.
 */
export function floorCommand<Result, State extends string = string, Facts = undefined>(
  core: FloorCore,
  context: FloorContext,
  spec: Omit<CommandSpec<State, Facts>, 'idempotencyKey'>,
  work: (tools: CommandTools) => Promise<Result>,
): Promise<CommandOutcome<Result>> {
  return runCommand(callerFor(core.database, context), { ...spec, idempotencyKey: `floor-auth.${newId()}` }, work, { ...COMMAND_SETTINGS, clock: core.clock })
}
