/**
 * Phase S2 (RBAC engine) — dev-only seed users, one per role.
 *
 * Lets you log in as each role to eyeball what it can see/do. HARD-GUARDED
 * so it can NEVER run in production (master prompt §S2: "never in
 * production"): refuses unless NODE_ENV !== 'production', NEXUS_ENV !==
 * 'production', AND NEXUS_ALLOW_DEV_SEED=1 is set explicitly.
 *
 * This repo verifies on prod (no local scratch DB), so do NOT point this at
 * the production database — run it only against a disposable dev/staging DB.
 *
 * Run:  NEXUS_ALLOW_DEV_SEED=1 npx tsx apps/api/src/scripts/seed-dev-users.ts
 */

import 'dotenv/config'
import prisma from '../db.js'
import { hashPassword } from '../lib/auth/password.js'
import { SYSTEM_ROLES, type SystemRoleKey } from '@nexus/shared/permissions'

const DEV_PASSWORD = 'dev-password-change-me-9271' // dev-only, non-secret

async function main() {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.NEXUS_ENV === 'production' ||
    process.env.NEXUS_ALLOW_DEV_SEED !== '1'
  ) {
    console.error('✗ Refusing to seed dev users. Set NEXUS_ALLOW_DEV_SEED=1 and ensure NODE_ENV/NEXUS_ENV != production.')
    console.error('  NEVER run this against the production database.')
    process.exit(1)
  }

  const passwordHash = await hashPassword(DEV_PASSWORD)
  for (const key of Object.keys(SYSTEM_ROLES) as SystemRoleKey[]) {
    const email = `dev+${key.toLowerCase()}@nexus.local`
    const role = await (prisma as any).role.findUnique({ where: { key }, select: { id: true } })
    if (!role) {
      console.error(`  ! role ${key} not seeded — run seed-roles.ts first`)
      continue
    }
    const user = await (prisma as any).userProfile.upsert({
      where: { email },
      create: { email, displayName: `Dev ${SYSTEM_ROLES[key].name}`, passwordHash, status: 'active' },
      update: { passwordHash, status: 'active' },
      select: { id: true },
    })
    await (prisma as any).userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      create: { userId: user.id, roleId: role.id },
      update: {},
    })
    console.log(`  ✓ ${email}  (role ${key})`)
  }
  console.log(`\n✓ Dev users seeded. Password for all: ${DEV_PASSWORD}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('✗ seed-dev-users failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
