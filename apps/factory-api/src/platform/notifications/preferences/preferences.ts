import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { DIGEST_DEFAULT_CATEGORIES, DIGEST_REPORT_KEY } from '@nexus/factory-domain/notifications/rules'
import {
  cadencesOf,
  cellProblem,
  EVENT_KINDS,
  PREFERENCE_CHANNELS,
  preferenceKey,
  quietDefault,
  roleDefaultKey,
  type Cadence,
  type EventKind,
  type MatrixCell,
  type PreferenceChannel,
} from '@nexus/factory-domain/notifications/preferences/preferences'
import { HOME_NOTIFICATIONS_MANAGE } from '@nexus/factory-domain/notifications/preferences/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeOf } from '../notifications'
import { matrixOf } from './store'

/**
 * The preferences matrix (B-W2b-385; PLT-141; design home.notifications › Preferences, "each cell saves at once (CellSaveMark);
 * Reset to my role's defaults"): a person's own matrix and its cells, and the defaults of the office roles (admins,
 * home.notifications.manage). Every write is ONE command with its audit row; a cell is the person's (or the role's) last word
 * (no version: nobody else edits it), and the database keeps one row per person or role, kind and channel by its key.
 */

export interface CellBody {
  readonly event: EventKind
  readonly channel: PreferenceChannel
  readonly cadence: Cadence
}

function cellView(cell: MatrixCell, roleNames: ReadonlyMap<string, string>) {
  return {
    event: cell.event,
    channel: cell.channel,
    cadence: cell.cadence,
    source: cell.source,
    /** "Default for Planner" (source ROLE). */
    role: cell.roleId ? { id: cell.roleId, name: roleNames.get(cell.roleId) ?? '' } : null,
    /** What the cell is without the person's own choice and without a role default. */
    quiet: cell.quiet,
    choices: [...cadencesOf(cell.channel)],
  }
}

/** GET /notifications/preferences: my matrix, where each cell comes from, whether my digest is on, whether I set role defaults. */
export async function readPreferences(caller: CommandCaller) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const matrix = await matrixOf(client, context.actorId, now)
    const digest = await client.reportSubscription.findFirst({ where: { userId: context.actorId, reportKey: DIGEST_REPORT_KEY }, orderBy: { createdAt: 'asc' }, select: { active: true } })
    const devices = await client.pushSubscription.count({ where: { userId: context.actorId, revokedAt: null } })
    const names = new Map(matrix.roles.map((role) => [role.id, role.name]))
    return {
      asOf: toUtcIso(now),
      events: [...EVENT_KINDS],
      channels: [...PREFERENCE_CHANNELS],
      cells: matrix.cells.map((cell) => cellView(cell, names)),
      roles: [...matrix.roles],
      /** The e-mail column's "Daily digest" goes out only while the digest is on (GET/PUT /notifications/digest). */
      digestOn: digest?.active ?? false,
      /** The push column reaches only the devices turned on (GET /notifications/push). */
      pushDevices: devices,
      mayManageDefaults: holds(actorOf(context), HOME_NOTIFICATIONS_MANAGE),
    }
  })
}

function checkCell(body: { readonly event: string; readonly channel: string; readonly cadence: string | null }): void {
  const problem = cellProblem(body)
  if (problem) throw new ValidationError(problem.message, [problem])
}

/** PUT /notifications/preferences: one cell of my matrix (saved at once). */
export async function savePreference(caller: CommandCaller, body: CellBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  checkCell(body)
  const key = preferenceKey(context.actorId, body.event, body.channel)
  await command(caller, { name: 'notifications.savePreference', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    // One writer per cell at a time (two tabs): the key is unique, the lock keeps the read-then-write whole.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
    const existing = await tx.notificationPreference.findFirst({ where: { key }, select: { id: true, cadence: true, version: true } })
    let id: string
    if (existing) {
      id = existing.id
      if (existing.cadence !== body.cadence) await tx.notificationPreference.update({ where: { id }, data: { cadence: body.cadence, version: existing.version + 1, updatedAt: now }, select: { id: true } })
    } else {
      id = newId()
      await tx.notificationPreference.create({ data: { id, userId: context.actorId, event: body.event, channel: body.channel, cadence: body.cadence, key, createdAt: now, updatedAt: now }, select: { id: true } })
    }
    tools.audit({ recordType: 'NotificationPreference', recordId: id, ...(existing ? { before: { cadence: existing.cadence } } : {}), after: { event: body.event, channel: body.channel, cadence: body.cadence } })
    return null
  })
  return readPreferences(caller)
}

/** DELETE /notifications/preferences: "Reset to my role's defaults" (my own rows go; my roles' defaults and the quiet ones stay). */
export async function resetPreferences(caller: CommandCaller, idempotencyKey?: string) {
  const context = officeOf(caller)
  await command(caller, { name: 'notifications.resetPreferences', idempotencyKey, input: { userId: context.actorId } }, async (tools) => {
    const rows = await tools.tx.notificationPreference.findMany({ where: { userId: context.actorId }, select: { id: true, event: true, channel: true, cadence: true } })
    if (rows.length > 0) await tools.tx.notificationPreference.deleteMany({ where: { userId: context.actorId } })
    // The audit row names the person (their own matrix) and what they had chosen.
    tools.audit({ recordType: 'User', recordId: context.actorId, before: { cells: rows.map((row) => ({ event: row.event, channel: row.channel, cadence: row.cadence })) }, after: { cells: [] } })
    return null
  })
  return readPreferences(caller)
}

// ---- role defaults (home.notifications.manage) ----------------------------------------------------------------------------

/** GET /notifications/role-defaults?roleId=: the office roles, and the chosen role's defaults (null cadence: the quiet default). */
export async function readRoleDefaults(caller: CommandCaller, roleId?: string) {
  officeOf(caller)
  return caller.withClient(async (client) => {
    const roles = await client.role.findMany({ where: { audience: 'OFFICE' }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 200, select: { id: true, name: true, key: true, system: true } })
    const chosen = roleId ?? roles[0]?.id ?? null
    if (chosen !== null && !roles.some((role) => role.id === chosen)) throw new NotFoundError('Office role not found.')
    const rows = chosen ? await client.roleNotificationDefault.findMany({ where: { roleId: chosen }, select: { event: true, channel: true, cadence: true, updatedAt: true } }) : []
    return {
      roles: roles.map((role) => ({ id: role.id, name: role.name, key: role.key, system: role.system })),
      roleId: chosen,
      cells: EVENT_KINDS.flatMap((event) =>
        PREFERENCE_CHANNELS.map((channel) => {
          const row = rows.find((entry) => entry.event === event && entry.channel === channel)
          return { event, channel, cadence: (row?.cadence as Cadence | undefined) ?? null, quiet: quietDefault(event, channel, DIGEST_DEFAULT_CATEGORIES), choices: [...cadencesOf(channel)], changedAt: row ? toUtcIso(row.updatedAt) : null }
        }),
      ),
    }
  })
}

/** PUT /notifications/role-defaults: one cell of an office role's defaults; cadence null removes it (back to the quiet default). */
export async function saveRoleDefault(caller: CommandCaller, body: { readonly roleId: string; readonly event: EventKind; readonly channel: PreferenceChannel; readonly cadence: Cadence | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  checkCell(body)
  const key = roleDefaultKey(body.roleId, body.event, body.channel)
  await command(caller, { name: 'notifications.saveRoleDefault', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const role = await tx.role.findFirst({ where: { id: body.roleId, audience: 'OFFICE' }, select: { id: true, name: true } })
    if (!role) {
      const message = 'Choose an office role: floor and partner roles get no office notifications.'
      throw new ValidationError(message, [{ path: 'body/roleId', message }])
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
    const existing = await tx.roleNotificationDefault.findFirst({ where: { key }, select: { id: true, cadence: true, version: true } })
    let id = existing?.id ?? newId()
    if (body.cadence === null) {
      if (existing) await tx.roleNotificationDefault.delete({ where: { id: existing.id }, select: { id: true } })
    } else if (existing) {
      if (existing.cadence !== body.cadence) await tx.roleNotificationDefault.update({ where: { id: existing.id }, data: { cadence: body.cadence, version: existing.version + 1, updatedAt: now }, select: { id: true } })
    } else {
      id = newId()
      await tx.roleNotificationDefault.create({ data: { id, roleId: role.id, event: body.event, channel: body.channel, cadence: body.cadence, key, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    }
    // Recorded on the role (its defaults are part of it); the cell before and after.
    tools.audit({ recordType: 'Role', recordId: role.id, before: { event: body.event, channel: body.channel, cadence: existing?.cadence ?? null }, after: { event: body.event, channel: body.channel, cadence: body.cadence, defaultId: body.cadence === null ? null : id } })
    return null
  })
  return readRoleDefaults(caller, body.roleId)
}
