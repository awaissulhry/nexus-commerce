/**
 * Phase S2 (RBAC engine) — seed the six default system roles.
 *
 * Idempotent + production-safe (roles are config). Delegates to
 * seedSystemRoles() — the same function the API runs at startup — with
 * bumpVersions so a manual re-seed re-resolves everyone's permissions.
 *
 * Run:  npx tsx apps/api/src/scripts/seed-roles.ts
 */

import 'dotenv/config'
import { seedSystemRoles } from '../services/team-access.service.js'

async function main() {
  const n = await seedSystemRoles({ bumpVersions: true })
  console.log(`✓ ${n} system roles seeded/refreshed from the registry (permissions re-resolved).`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('✗ seed-roles failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
