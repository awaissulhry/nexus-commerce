import { UserStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedPortalAuth } from './portal-auth'
import { seed as seedRoles } from './roles'
import { seed as seedTwoBrands } from './two-brands'

/**
 * B-PR-42a (production plan §3 "Supervisor", lead pick L21; review fix R-57; PW-14): the production supervisor of the seeds'
 * customer P1, and the office people a walk needs to see who may and may not be one — per tenant of seed/_core.ts, written in
 * the tenant's office scope as the app does (PUT /production/brands/:partyId/supervisor writes PortalSettings there).
 *
 *   "Seed Production Supervisor"   ACTIVE office, production manager over every company, LIMITED to P1: P1's supervisor
 *   "Seed Production Backup"       ACTIVE office, production manager over every company, LIMITED to P1: P1's backup
 *   "Seed Brand Two Office"        (seed/two-brands.ts, B-PR-39) production manager LIMITED to Seed Brand Two: holds the
 *                                  measurements right, may supervise Seed Brand Two, never P1 (PW-14)
 *   "Seed Brand Two Planner"       ACTIVE office, planner over every company, LIMITED to Seed Brand Two: no measurements right,
 *                                  so refused as a supervisor anywhere ("a supervisor must open measurement sheets")
 *   P1's PortalSettings            productionSupervisorId + since when, productionBackupId (its portal and every other column as
 *                                  they are); Seed Brand Two has none (its office people choose one in the walk)
 *
 * The roles are the office SYSTEM roles of seed/roles.ts (production_manager, planner), which no other seed or golden-flow step
 * deletes (golden-flow/portal's world step takes away only the PARTNER system roles). The production manager holds
 * workorders.view, production.brand.manage, sales.measurements.view, threads.read and orders.view; the planner all but the
 * measurements right. The customer is never told who its supervisor is (R-41): PortalSettings has no partner grant.
 *
 * The CLI runs the seeds in name order, so this one first runs those whose rows it names (each idempotent): auth, roles, the
 * portal people (P1's PortalSettings row) and the second brand (seed/two-brands.ts). People and assignments take ids that start
 * with eight f's (no generated isolation test copies them); every name is made up (`example.com`). Idempotent: people and
 * assignments are upserted; P1's supervisor and backup are written once, only while P1 has none (a supervisor the app set
 * since stays).
 */

/** Fixed instants, so the seed never depends on the clock (before the day the step was built). */
const T = { people: new Date('2026-11-12T08:00:00.000Z'), named: new Date('2026-11-12T09:00:00.000Z') } as const

export interface ProductionSupervisorSeed {
  readonly userIds: { readonly supervisor: string; readonly backup: string; readonly secondBrandOffice: string; readonly secondBrandPlanner: string }
  /** P1, whose supervisor and backup this seed names. */
  readonly partyId: string
}

export async function seed(context: SeedContext): Promise<ProductionSupervisorSeed> {
  const { db, namespace } = context
  await seedAuth(context)
  const { roleIds } = await seedRoles(context)
  await seedPortalAuth(context)
  const twoBrands = await seedTwoBrands(context)
  const base = (key: string): string => seedUuid(namespace, key)
  const id = (key: string): string => `ffffffff${seedUuid(namespace, `production-supervisor:${key}`).slice(8)}`
  const tenantId = base('tenant')
  const actorId = base('actor')
  const p1 = base('party:P1')
  const secondBrand = twoBrands.second.partyId
  const userIds = { supervisor: id('user:supervisor'), backup: id('user:backup'), secondBrandOffice: twoBrands.officeUserId, secondBrandPlanner: id('user:second-brand-planner') }
  const select = { id: true } as const

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      const people = [
        { key: 'supervisor', userId: userIds.supervisor, email: `production.supervisor.${namespace}@example.com`, displayName: 'Seed Production Supervisor', role: 'production_manager', partyIds: [p1] },
        { key: 'backup', userId: userIds.backup, email: `production.backup.${namespace}@example.com`, displayName: 'Seed Production Backup', role: 'production_manager', partyIds: [p1] },
        { key: 'second-brand-planner', userId: userIds.secondBrandPlanner, email: `brand-two.planner.${namespace}@example.com`, displayName: 'Seed Brand Two Planner', role: 'planner', partyIds: [secondBrand] },
      ]
      for (const person of people) {
        const user = { email: person.email, displayName: person.displayName, status: UserStatus.ACTIVE, requireMfa: false }
        await tx.user.upsert({ where: { id: person.userId }, create: { id: person.userId, ...user, createdAt: T.people, createdById: actorId }, update: user, select })
        const assignmentId = id(`assignment:${person.key}`)
        const row = { userId: person.userId, roleId: roleIds[person.role]!, allCompanies: true, companyIds: [], siteIds: [], partyIds: person.partyIds, validFrom: T.people, grantedById: actorId }
        await tx.roleAssignment.upsert({ where: { id: assignmentId }, create: { id: assignmentId, ...row, createdAt: T.people }, update: row, select })
      }

      // P1's supervisor and backup, once (one row per party, its id the party's: B-W2b-152; the portal and its limits as they are).
      const settings = await tx.portalSettings.findUnique({ where: { id: p1 }, select: { productionSupervisorId: true, version: true } })
      const named = { productionSupervisorId: userIds.supervisor, productionSupervisorSetAt: T.named, productionBackupId: userIds.backup }
      if (!settings) {
        await tx.portalSettings.create({ data: { id: p1, partyId: p1, portalOn: false, ...named, createdAt: T.named, createdById: actorId }, select })
      } else if (settings.productionSupervisorId === null) {
        await tx.portalSettings.update({ where: { id: p1 }, data: { ...named, version: settings.version + 1, updatedAt: T.named }, select })
      }
    }),
  )
  return { userIds, partyId: p1 }
}
