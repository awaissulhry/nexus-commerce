import { hashPin, pinKeyring } from '@nexus/factory-domain/auth/floor/pin'
import { ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { BadgeStatus, DeviceKind, DeviceStatus, FloorSessionEndReason, RoleAudience, WorkerStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The floor sign-in seed: on each seeded plant, its floor session times, one enrolled tablet at the cutting table (its
 * one-time code used), and two made-up floor workers ("Seed Worker …") with a badge and a floor role each (operator,
 * team leader), and one ended floor session. The floor system roles of factory-domain's templates are written here too
 * (the roles seed runs later, by name, and keeps them), so the workers' roles exist.
 *
 * Nothing seeded opens anything by itself: every token, code and badge hash is a marker that nothing hashes to (a real
 * one is 64 hex characters); the enrolment code is used and expired, the session ended. A local device is enrolled
 * through the API. B-W2b-30: each seed worker has a PIN (SEED_WORKER_PIN), hashed with the LOCAL pepper only (the API's
 * env.ts LOCAL_PIN_PEPPER, which staging and production refuse; the seed command runs only on a loopback test or worktree
 * database), so on a local stack a worker signs in by name on an enrolled tablet, and a badge-only site's sign-in finds
 * the PIN it asks for (sign-in.ts: pinHash not null). Written when the worker is made, never over a PIN changed since;
 * with a cheap scrypt that the first sign-in re-hashes. Runs after seed/_core.ts and seed/auth.ts; writes in the
 * tenant's office scope, and the session in the plant's floor scope.
 */

/** The made-up PIN of every seed worker (local stacks only: see above). */
export const SEED_WORKER_PIN = '418273'
/** = apps/factory-api env.ts LOCAL_PIN_PEPPER (public on purpose; the seed cannot import the API, a test there compares). */
export const SEED_PIN_PEPPER = 'factory-local-pin-pepper-not-for-staging-or-production'
/** The seed workers' PIN hash: the local pepper, a cheap scrypt (the first sign-in stores one with the full settings). */
export const seedWorkerPinHash = (): Promise<string> => hashPin(SEED_WORKER_PIN, pinKeyring(SEED_PIN_PEPPER), { logN: 12, r: 8, p: 1 })

export interface FloorAuthSeed {
  readonly deviceIds: readonly string[]
  readonly workerIds: readonly string[]
}

const SEEDED_AT = new Date('2026-10-28T08:00:00.000Z')
const ENDED_AT = new Date('2026-10-28T08:30:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<FloorAuthSeed> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const notAToken = (key: string): string => `seed-not-a-token:${id(key)}`
  const plants = [
    { code: 'A1', siteId: id('site:A1'), companyId: id('company:A') },
    { code: 'B1', siteId: id('site:B1'), companyId: id('company:B') },
  ]
  const floorTemplates = ROLE_TEMPLATES.filter((template) => template.audience === 'floor')
  const deviceIds: string[] = []
  const workerIds: string[] = []
  const pinHash = await seedWorkerPinHash()

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const template of floorTemplates) {
        const roleId = id(`role:${template.key}`)
        const data = {
          key: template.key,
          name: template.name,
          description: template.description,
          system: true,
          basedOn: null,
          audience: RoleAudience.FLOOR,
          requireMfa: template.requireMfa,
          permissions: [...template.permissions],
          grains: [...template.grains],
        }
        await tx.role.upsert({ where: { id: roleId }, create: { id: roleId, ...data, createdAt: SEEDED_AT }, update: data })
      }

      for (const plant of plants) {
        const at = { siteId: plant.siteId }
        // A site's floor settings row has the site's id.
        const settingsId = plant.siteId
        const settings = { companyId: plant.companyId, siteId: plant.siteId, idleMinutes: 10, shiftEnds: ['06:00', '14:00', '22:00'] }
        await tx.floorSettings.upsert({ where: { id: settingsId }, create: { id: settingsId, ...settings, createdAt: SEEDED_AT }, update: settings })

        const deviceId = id(`device:${plant.code}:cutting`)
        deviceIds.push(deviceId)
        const device = {
          companyId: plant.companyId,
          ...at,
          stationId: id(`site:${plant.code}:station:CUT-01`),
          name: `Seed tablet ${plant.code} cutting`,
          kind: DeviceKind.TABLET,
          status: DeviceStatus.ACTIVE,
          tokenHash: notAToken(`device:${plant.code}:cutting`),
          enrolledAt: SEEDED_AT,
          enrolledById: actorId,
          lastSeenAt: ENDED_AT,
          appVersion: 'seed',
        }
        await tx.device.upsert({ where: { id: deviceId }, create: { id: deviceId, ...device, createdAt: SEEDED_AT, createdById: actorId }, update: device })

        const enrolmentId = id(`enrolment:${plant.code}:cutting`)
        const enrolment = { ...at, deviceId, codeHash: notAToken(`enrolment:${plant.code}:cutting`), createdById: actorId, expiresAt: ENDED_AT, usedAt: SEEDED_AT }
        await tx.deviceEnrolment.upsert({ where: { id: enrolmentId }, create: { id: enrolmentId, ...enrolment, createdAt: SEEDED_AT }, update: enrolment })

        const workers = [
          { key: 'operator', name: `Seed Worker ${plant.code}-1`, locale: 'it', role: 'operator' },
          { key: 'lead', name: `Seed Worker ${plant.code}-2`, locale: 'en', role: 'team_leader' },
        ]
        for (const [index, entry] of workers.entries()) {
          const workerId = id(`worker:${plant.code}:${entry.key}`)
          workerIds.push(workerId)
          const worker = {
            companyId: plant.companyId,
            ...at,
            displayName: entry.name,
            locale: entry.locale,
            employeeCode: `SEED-${plant.code}-${index + 1}`,
            status: WorkerStatus.ACTIVE,
          }
          await tx.worker.upsert({ where: { id: workerId }, create: { id: workerId, ...worker, createdAt: SEEDED_AT, createdById: actorId }, update: worker })
          // B-W2b-30: the seed PIN, only on a worker without one (a PIN changed since, by the worker or a reset, stays).
          await tx.worker.updateMany({ where: { id: workerId, pinHash: null }, data: { pinHash, pinChangedAt: SEEDED_AT } })

          const badgeId = id(`badge:${plant.code}:${entry.key}`)
          const badge = { ...at, workerId, codeHash: notAToken(`badge:${plant.code}:${entry.key}`), hint: 'SEED', status: BadgeStatus.ACTIVE, issuedAt: SEEDED_AT, issuedById: actorId }
          await tx.badge.upsert({ where: { id: badgeId }, create: { id: badgeId, ...badge, createdAt: SEEDED_AT }, update: badge })

          const workerRoleId = id(`worker-role:${plant.code}:${entry.key}`)
          const workerRole = { ...at, workerId, roleId: id(`role:${entry.role}`), grantedById: actorId }
          await tx.workerRole.upsert({ where: { id: workerRoleId }, create: { id: workerRoleId, ...workerRole, createdAt: SEEDED_AT }, update: workerRole })

        }
      }
    }),
  )

  // Floor sessions are written by the floor (the device's site scope), as the app does: the office role adds none.
  for (const plant of plants) {
    const deviceId = id(`device:${plant.code}:cutting`)
    const workerId = id(`worker:${plant.code}:operator`)
    const sessionId = id(`floor-session:${plant.code}:operator`)
    const session = {
      siteId: plant.siteId,
      deviceId,
      workerId,
      badgeId: id(`badge:${plant.code}:operator`),
      tokenHash: notAToken(`floor-session:${plant.code}:operator`),
      startedAt: SEEDED_AT,
      lastSeenAt: ENDED_AT,
      idleExpiresAt: ENDED_AT,
      endsAt: ENDED_AT,
      endedAt: ENDED_AT,
      endReason: FloorSessionEndReason.SIGNED_OUT,
    }
    await db.withScope({ audience: 'floor', tenantId, actorId: workerId, siteId: plant.siteId }, (client) =>
      client.floorSession.upsert({ where: { id: sessionId }, create: { id: sessionId, ...session }, update: session, select: { id: true } }),
    )
  }

  return { deviceIds, workerIds }
}
