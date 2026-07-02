/**
 * Phase S1 (auth core) — idempotent OWNER bootstrap.
 *
 * Creates or promotes the first OWNER from an env-provided email, and
 * ensures the protected OWNER role row exists. Safe to re-run: it
 * converges state and never duplicates.
 *
 *   Required:  NEXUS_OWNER_EMAIL
 *   Optional:  NEXUS_OWNER_INITIAL_PASSWORD  (else the owner sets one
 *              via the password-reset flow; the password is NEVER
 *              printed and NEVER hardcoded)
 *
 * Run:  npx tsx apps/api/src/scripts/bootstrap-owner.ts
 * (or via the built dist path in production).
 */

import 'dotenv/config'
import prisma from '../db.js'
import { hashPassword, checkPasswordStrength } from '../lib/auth/password.js'

const OWNER_ROLE_KEY = 'OWNER'

async function ensureOwnerRole(): Promise<string> {
  const role = await (prisma as any).role.upsert({
    where: { key: OWNER_ROLE_KEY },
    update: { isSystem: true },
    create: {
      key: OWNER_ROLE_KEY,
      name: 'Owner',
      description: 'Full, implicit access to everything. System-protected — cannot be deleted or demoted.',
      isSystem: true,
      // OWNER is implicit-all: the resolver never reads this list for
      // an owner, so it stays empty by design.
      permissions: [],
      requireMfa: false, // S5 flips this on
    },
    select: { id: true },
  })
  return role.id as string
}

async function main() {
  const email = (process.env.NEXUS_OWNER_EMAIL ?? '').trim().toLowerCase()
  if (!email) {
    console.error('✗ NEXUS_OWNER_EMAIL is required. Set it and re-run.')
    process.exit(1)
  }

  const roleId = await ensureOwnerRole()

  // Adopt an existing row for this email, or the legacy singleton with
  // an empty email, or create fresh.
  const byEmail = await (prisma as any).userProfile.findUnique({ where: { email }, select: { id: true, passwordHash: true } })
  let userId: string
  let hadPassword = false
  if (byEmail) {
    userId = byEmail.id
    hadPassword = !!byEmail.passwordHash
  } else {
    const singleton = await (prisma as any).userProfile.findFirst({ where: { email: '' }, select: { id: true, passwordHash: true } })
    if (singleton) {
      const u = await (prisma as any).userProfile.update({ where: { id: singleton.id }, data: { email }, select: { id: true } })
      userId = u.id
      hadPassword = !!singleton.passwordHash
    } else {
      const u = await (prisma as any).userProfile.create({
        data: { email, displayName: email.split('@')[0] },
        select: { id: true },
      })
      userId = u.id
    }
  }

  // Optional initial password (strength-gated). Never logged.
  let passwordSet = false
  const initialPw = process.env.NEXUS_OWNER_INITIAL_PASSWORD
  if (initialPw) {
    const strength = checkPasswordStrength(initialPw, [email])
    if (!strength.ok) {
      console.error(`✗ NEXUS_OWNER_INITIAL_PASSWORD too weak: ${strength.message}`)
      process.exit(1)
    }
    const passwordHash = await hashPassword(initialPw)
    await (prisma as any).userProfile.update({ where: { id: userId }, data: { passwordHash } })
    passwordSet = true
  }

  // Activate + bump permissionsVersion (invalidates any cached perms).
  await (prisma as any).userProfile.update({
    where: { id: userId },
    data: { status: 'active', deactivatedAt: null, permissionsVersion: { increment: 1 } },
  })

  // Assign OWNER (idempotent).
  await (prisma as any).userRole.upsert({
    where: { userId_roleId: { userId, roleId } },
    create: { userId, roleId },
    update: {},
  })

  console.log('✓ OWNER bootstrap complete')
  console.log(`  email:        ${email}`)
  console.log(`  role:         OWNER (system-protected)`)
  if (passwordSet) {
    console.log('  password:     set from NEXUS_OWNER_INITIAL_PASSWORD')
  } else if (hadPassword) {
    console.log('  password:     unchanged (existing hash kept)')
  } else {
    console.log('  password:     NOT set — use POST /api/auth/password/reset-request to set one')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('✗ bootstrap failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
