import type { FactoryClient } from '@nexus/factory-db'
import { DIGEST_REPORT_KEY, digestCategoriesOf, DIGEST_DEFAULT_CATEGORIES, type NotificationCategory } from '@nexus/factory-domain/notifications/rules'
import { resolveMatrix, type Cadence, type EventKind, type MatrixCell, type PreferenceChannel } from '@nexus/factory-domain/notifications/preferences/preferences'
import type { CommandTx } from '../../../core/command'
import { heldRoles } from '../../auth/roles/access'

/**
 * The preferences' storage (B-W2b-385; PLT-141; notify-depth.prisma NotificationPreference and RoleNotificationDefault): every
 * read of the matrix is here. The rules are factory-domain notifications/preferences; the fan-out (fan-out.ts), the instant
 * mail and push (deliver.ts) and the daily digest (platform/email-out/digest) ask `matrixOf` what a person hears.
 */

type Client = FactoryClient | CommandTx

/** The person's digest choice (W2a's ReportSubscription `notifications.digest`): the quiet default of the e-mail column. */
export async function digestCategoriesFor(client: Client, userId: string): Promise<NotificationCategory[]> {
  const row = await client.reportSubscription.findFirst({ where: { userId, reportKey: DIGEST_REPORT_KEY }, orderBy: { createdAt: 'asc' }, select: { params: true } })
  return row ? digestCategoriesOf(row.params) : [...DIGEST_DEFAULT_CATEGORIES]
}

export interface PersonMatrix {
  readonly cells: MatrixCell[]
  /** The person's live office roles, in the order they were given (the role defaults' tie-break), with their names. */
  readonly roles: readonly { readonly id: string; readonly name: string }[]
}

/** One person's matrix now: their rows, their live office roles' defaults, the quiet defaults (with their digest's choice). */
export async function matrixOf(client: Client, userId: string, now: Date, digestCategories?: readonly NotificationCategory[]): Promise<PersonMatrix> {
  const held = await heldRoles(client, userId, now)
  const roleIds = [...new Set(held.map((entry) => entry.roleId))]
  // One after the other: inside a command they share its transaction's connection.
  const person = await client.notificationPreference.findMany({ where: { userId }, select: { event: true, channel: true, cadence: true } })
  const defaults = roleIds.length ? await client.roleNotificationDefault.findMany({ where: { roleId: { in: roleIds } }, select: { roleId: true, event: true, channel: true, cadence: true } }) : []
  const names = roleIds.length ? await client.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }) : []
  const categories = digestCategories ? [...digestCategories] : await digestCategoriesFor(client, userId)
  const order = new Map(roleIds.map((id, index) => [id, index]))
  const roles = [...defaults].sort((a, b) => (order.get(a.roleId) ?? 0) - (order.get(b.roleId) ?? 0))
  const nameOf = new Map(names.map((role) => [role.id, role.name]))
  return {
    cells: resolveMatrix({
      person: person.map((row) => ({ event: row.event as EventKind, channel: row.channel as PreferenceChannel, cadence: row.cadence as Cadence })),
      roles: roles.map((row) => ({ roleId: row.roleId, event: row.event as EventKind, channel: row.channel as PreferenceChannel, cadence: row.cadence as Cadence })),
      digestCategories: categories,
    }),
    roles: roleIds.map((id) => ({ id, name: nameOf.get(id) ?? '' })),
  }
}
