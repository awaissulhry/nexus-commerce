import type { FactoryClient } from '@nexus/factory-db'
import { normalizeContent } from '@nexus/factory-domain/auth/roles/roles'
import { ROLE_TEMPLATES, templateOf, type RoleTemplate } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CommandTx } from '../../../core/command'

/**
 * The system roles of a tenant follow the templates of factory-domain auth/roles (feature PLT-030): one Role row per
 * template, `system` set, its content equal to the template. `systemRoleChanges` finds what differs (a new template,
 * a changed one, a retired one, which keeps its row but gives nothing), `applySystemRoleChanges` writes it.
 *
 * Who runs it: tenant set-up (before the first owner is invited), the seed, and `POST /auth/roles/sync-templates`
 * after a deploy that changed a template (one audit row per changed role, so a widened system role is never silent).
 * Custom roles are never touched here.
 */

export interface SystemRoleContent {
  readonly name: string
  readonly description: string | null
  readonly requireMfa: boolean
  readonly permissions: readonly string[]
  readonly grains: readonly string[]
}

export interface SystemRoleChange {
  readonly key: string
  readonly roleId: string
  readonly kind: 'created' | 'updated' | 'retired'
  readonly before: SystemRoleContent | null
  readonly after: SystemRoleContent
}

const RETIRED: Omit<SystemRoleContent, 'name' | 'description'> = { requireMfa: false, permissions: [], grains: [] }

export function templateContent(template: RoleTemplate): SystemRoleContent {
  const { permissions, grains } = normalizeContent(template)
  return { name: template.name, description: template.description, requireMfa: template.requireMfa, permissions, grains }
}

const same = (a: SystemRoleContent, b: SystemRoleContent): boolean =>
  a.name === b.name &&
  a.description === b.description &&
  a.requireMfa === b.requireMfa &&
  a.permissions.join(',') === b.permissions.join(',') &&
  a.grains.join(',') === b.grains.join(',')

const CONTENT_SELECT = { id: true, key: true, name: true, description: true, requireMfa: true, permissions: true, grains: true } as const

/** A system row differs from its template (or has none left). */
export function isOutdated(row: { readonly key: string } & SystemRoleContent): boolean {
  const template = templateOf(row.key)
  return template ? !same(row, templateContent(template)) : row.permissions.length > 0 || row.grains.length > 0 || row.requireMfa
}

/** What a sync would change in the tenant of this client. */
export async function systemRoleChanges(client: FactoryClient | CommandTx): Promise<SystemRoleChange[]> {
  const rows = await client.role.findMany({ where: { system: true }, select: CONTENT_SELECT, orderBy: { key: 'asc' } })
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const changes: SystemRoleChange[] = []
  for (const template of ROLE_TEMPLATES) {
    const after = templateContent(template)
    const row = byKey.get(template.key)
    if (!row) changes.push({ key: template.key, roleId: newId(), kind: 'created', before: null, after })
    else if (!same(row, after)) changes.push({ key: template.key, roleId: row.id, kind: 'updated', before: contentOfRow(row), after })
  }
  for (const row of rows) {
    if (templateOf(row.key) || !isOutdated(row)) continue
    changes.push({ key: row.key, roleId: row.id, kind: 'retired', before: contentOfRow(row), after: { ...contentOfRow(row), ...RETIRED } })
  }
  return changes
}

const contentOfRow = (row: SystemRoleContent): SystemRoleContent => ({
  name: row.name,
  description: row.description,
  requireMfa: row.requireMfa,
  permissions: [...row.permissions],
  grains: [...row.grains],
})

/** Writes the changes (inside a command's transaction, or tenant set-up's). */
export async function applySystemRoleChanges(tx: FactoryClient | CommandTx, changes: readonly SystemRoleChange[], at: { now: Date; actorId: string }): Promise<void> {
  for (const change of changes) {
    const data = { ...change.after, permissions: [...change.after.permissions], grains: [...change.after.grains] }
    if (change.kind === 'created') {
      // A template's audience never changes, so it is set once, when its system role is made.
      const audience = templateOf(change.key)?.audience === 'floor' ? 'FLOOR' : 'OFFICE'
      await tx.role.create({ data: { id: change.roleId, key: change.key, system: true, audience, ...data, createdAt: at.now, createdById: at.actorId } })
    } else {
      await tx.role.update({ where: { id: change.roleId }, data: { ...data, version: { increment: 1 } } })
    }
  }
}
