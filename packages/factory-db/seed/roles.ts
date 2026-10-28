import { ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The roles seed: every system role template of factory-domain (auth/roles/templates) as the tenant's system roles,
 * one custom role copied from a template, and assignments for the synthetic people of seed/auth.ts:
 *   - the owner holds `owner` over every company (two-factor required: nothing until proved on a session);
 *   - the member holds `sales` limited to company A and its site A1, and the custom role over every company;
 *   - the invited person holds `planner` limited to company B (live once the invitation is accepted).
 * Runs after seed/_core.ts and seed/auth.ts (name order) and writes in the tenant's office scope as the app does.
 * Made-up data only; idempotent (stable ids, upserts). The API's syncSystemRoles does the same for a real tenant.
 */

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

  const roleIds: Record<string, string> = {}
  const roles = [
    ...ROLE_TEMPLATES.map((template) => ({
      key: template.key,
      name: template.name,
      description: template.description,
      system: true,
      basedOn: null,
      requireMfa: template.requireMfa,
      permissions: [...template.permissions],
      grains: [...template.grains],
    })),
    {
      key: 'custom.night_lead',
      name: 'Night shift lead',
      description: 'A copy of the floor supervisor that also reads the audit log.',
      system: false,
      basedOn: 'floor_supervisor',
      requireMfa: false,
      permissions: ['audit.read'],
      grains: [] as string[],
    },
  ]
  for (const role of roles) roleIds[role.key] = id(`role:${role.key}`)

  const assignments = [
    { key: 'owner', userId: ownerId, role: 'owner', allCompanies: true, companyIds: [], siteIds: [] },
    { key: 'member:sales', userId: id('user:member'), role: 'sales', allCompanies: false, companyIds: [companyA], siteIds: [siteA1] },
    { key: 'member:night', userId: id('user:member'), role: 'custom.night_lead', allCompanies: true, companyIds: [], siteIds: [] },
    { key: 'invited:planner', userId: id('user:invited'), role: 'planner', allCompanies: false, companyIds: [companyB], siteIds: [] },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      for (const { key, ...data } of roles) {
        const roleId = roleIds[key]!
        await tx.role.upsert({ where: { id: roleId }, create: { id: roleId, key, ...data, createdAt: SEEDED_AT }, update: data })
      }
      for (const { key, role, ...data } of assignments) {
        const assignmentId = id(`assignment:${key}`)
        const row = { ...data, roleId: roleIds[role]!, partyIds: [], validFrom: SEEDED_AT, grantedById: ownerId }
        await tx.roleAssignment.upsert({ where: { id: assignmentId }, create: { id: assignmentId, ...row, createdAt: SEEDED_AT }, update: row })
      }
    }),
  )

  return { roleIds, assignmentIds: assignments.map(({ key }) => id(`assignment:${key}`)) }
}
