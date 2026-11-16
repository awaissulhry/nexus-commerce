import { normalizeContent } from '@nexus/factory-domain/auth/roles/roles'
import { SYSTEM_ROLE_TEMPLATES, type SystemRoleTemplate } from '@nexus/factory-domain/auth/roles/templates'
import type { Prisma } from '../src/generated/prisma/client'
import { RoleAudience } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The roles seed: every system role template of factory-domain (auth/roles/templates) as the tenant's system roles (the
 * office, floor and, B-W2b-F59, partner templates: without the partner ones a fresh seed could invite no portal person until
 * a worker's template sync ran: "the portal roles are not set up in this tenant yet"),
 * one custom role copied from a template, and assignments for the synthetic people of seed/auth.ts:
 *   - the owner holds `owner` over every company (two-factor required: nothing until proved on a session);
 *   - the member holds `sales` limited to company A and its site A1, and the custom role over every company;
 *   - the invited person holds `planner` limited to company B (live once the invitation is accepted).
 * Runs after seed/_core.ts and seed/auth.ts (name order) and writes in the tenant's office scope as the app does.
 * Made-up data only; idempotent (stable ids, upserts). The API's syncSystemRoles does the same for a real tenant.
 * B-W2b-GS1: also on a tenant the app has used: a role the app made first under the same key (the worker's template sync
 * makes a new template's system role with an id of its own) is adopted by (tenant, key), never made twice (writeSeedRoles).
 */

/** One role the seed writes: a system role (a template) or a custom one. */
export interface SeedRole {
  readonly key: string
  readonly name: string
  readonly description: string | null
  readonly system: boolean
  readonly basedOn: string | null
  readonly audience: RoleAudience
  readonly requireMfa: boolean
  readonly permissions: readonly string[]
  readonly grains: readonly string[]
}

/** A template's system role, its content as the template sync writes it (system-roles.ts templateContent). */
export function systemSeedRole(template: SystemRoleTemplate): SeedRole {
  const { permissions, grains } = normalizeContent(template)
  const audience = template.audience === 'floor' ? RoleAudience.FLOOR : template.audience === 'partner' ? RoleAudience.PARTNER : RoleAudience.OFFICE
  return { key: template.key, name: template.name, description: template.description, system: true, basedOn: null, audience, requireMfa: template.requireMfa, permissions, grains }
}

/**
 * B-W2b-GS1: writes the seed's roles in a tenant the app may already have used, and gives each key's role id. A role's key
 * is unique in its tenant, and the app makes roles too (the worker's template sync at its start and every night, tenant
 * set-up, a person's custom role), each with an id of its own. The rule, per key:
 *   - no role with the key: made with the seed's id;
 *   - the seed's own row (its id): the seed's content again (as before), except a raise of two-factor on an office system
 *     role, which a tenant may ask for and which the sync never lowers (system-roles.ts contentFor), so the seed keeps it too;
 *   - another row with the key: the seed ADOPTS it (its id is the one every seeded reference uses) and never deletes it. A
 *     system role gets only what the template sync writes on it (the template's content, the raise kept); any other role
 *     (a custom role a person made under that key) stays exactly as it is.
 */
export async function writeSeedRoles(tx: Prisma.TransactionClient, seedId: (key: string) => string, roles: readonly SeedRole[], createdAt: Date): Promise<Record<string, string>> {
  const found = await tx.role.findMany({ where: { key: { in: roles.map((role) => role.key) } }, select: { id: true, key: true, system: true, basedOn: true, audience: true, name: true, description: true, requireMfa: true, permissions: true, grains: true } })
  const byKey = new Map(found.map((row) => [row.key, row]))
  const roleIds: Record<string, string> = {}
  for (const { key, ...role } of roles) {
    const row = byKey.get(key)
    const ownId = seedId(`role:${key}`)
    roleIds[key] = row?.id ?? ownId
    const data = { ...role, permissions: [...role.permissions], grains: [...role.grains] }
    if (!row) {
      await tx.role.create({ data: { id: ownId, key, ...data, createdAt } })
      continue
    }
    if (row.id !== ownId && !(row.system && role.system)) continue
    const keepRaise = row.requireMfa && !role.requireMfa && role.system && role.audience === RoleAudience.OFFICE
    // On an adopted system role, what the sync writes (system-roles.ts applySystemRoleChanges): its audience stays.
    const synced = { name: data.name, description: data.description, permissions: data.permissions, grains: data.grains }
    const next = { ...(row.id === ownId ? data : synced), requireMfa: role.requireMfa || keepRaise }
    // A row that holds it already is not written again (nothing of it moves, its updatedAt neither).
    if (Object.entries(next).every(([field, value]) => JSON.stringify(row[field as keyof typeof row]) === JSON.stringify(value))) continue
    await tx.role.update({ where: { id: row.id }, data: next })
  }
  return roleIds
}

export interface RolesSeed {
  readonly roleIds: Readonly<Record<string, string>>
  readonly assignmentIds: readonly string[]
}

const SEEDED_AT = new Date('2026-10-28T08:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<RolesSeed> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const ownerId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA1 = id('site:A1')

  const roles: SeedRole[] = [
    ...SYSTEM_ROLE_TEMPLATES.map(systemSeedRole),
    {
      key: 'custom.night_lead',
      name: 'Night shift lead',
      description: 'A copy of the floor supervisor that also reads the audit log.',
      system: false,
      basedOn: 'floor_supervisor',
      audience: RoleAudience.OFFICE,
      requireMfa: false,
      permissions: ['audit.read'],
      grains: [],
    },
  ]

  const assignments = [
    { key: 'owner', userId: ownerId, role: 'owner', allCompanies: true, companyIds: [], siteIds: [] },
    { key: 'member:sales', userId: id('user:member'), role: 'sales', allCompanies: false, companyIds: [companyA], siteIds: [siteA1] },
    { key: 'member:night', userId: id('user:member'), role: 'custom.night_lead', allCompanies: true, companyIds: [], siteIds: [] },
    { key: 'invited:planner', userId: id('user:invited'), role: 'planner', allCompanies: false, companyIds: [companyB], siteIds: [] },
  ]

  const roleIds = await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      const roleIds = await writeSeedRoles(tx, id, roles, SEEDED_AT)
      for (const { key, role, ...data } of assignments) {
        const assignmentId = id(`assignment:${key}`)
        const row = { ...data, roleId: roleIds[role]!, partyIds: [], validFrom: SEEDED_AT, grantedById: ownerId }
        await tx.roleAssignment.upsert({ where: { id: assignmentId }, create: { id: assignmentId, ...row, createdAt: SEEDED_AT }, update: row })
      }
      return roleIds
    }),
  )

  return { roleIds, assignmentIds: assignments.map(({ key }) => id(`assignment:${key}`)) }
}
