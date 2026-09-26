/**
 * VTR step 1b — the variation backfill (docs/variation-theme/STEP1-PLAN.md), run where the data is.
 *
 *   npx tsx docs/variation-theme/tools/vtr-backfill.mts [--workspace <id>]                     → DRY RUN: the plan + its digest
 *   npx tsx docs/variation-theme/tools/vtr-backfill.mts [--workspace <id>] --write --digest <sha256> → write, only if the plan is unchanged
 *
 * The write runs ONLY the plan the Owner read: it re-plans and refuses unless the digest matches. Per family, one transaction
 * (applyFamilyVariationsBackfill). On the production server (`railway ssh`, no .env) it uses the service's settings; anywhere
 * else it refuses a database whose name does not contain "test". A second run plans nothing (idempotent).
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const SERVER = process.env.RAILWAY_ENVIRONMENT_NAME === 'production' && !existsSync(`${ROOT}/.env`)
const args = process.argv.slice(2)
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const write = args.includes('--write'), expected = arg('--digest'), workspaceId = arg('--workspace') ?? 'nexus_legacy_workspace'
if (write && !expected) throw new Error('--write needs --digest <sha256> from a dry run the Owner read')
Object.assign(process.env, { NEXUS_WORKSPACES_ENABLED: '1', NEXUS_DATABASE_POOL_MAX: '2', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: '0' })

const { default: prisma } = await import(`${ROOT}/apps/api/src/db.js`)
const [{ name }] = await prisma.$queryRawUnsafe<Array<{ name: string }>>('select current_database()::text as name')
if (!SERVER && !/test/.test(name)) throw new Error(`refusing: not on the production server and the database "${name}" is not a test copy`)
const { withWorkspace } = await import(`${ROOT}/apps/api/src/lib/workspace-context.js`)
const { applyFamilyVariationsBackfill } = await import(`${ROOT}/apps/api/src/services/pim/family-variations-backfill.js`)
const scoped = <T,>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, work)

const canonical = (value: unknown): string => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)
const planOf = (families: Array<Record<string, unknown>>) => families.filter(f => f.status !== 'unchanged').map(({ status: _s, reason: _r, ...rest }) => rest)

const plan = await scoped(() => applyFamilyVariationsBackfill({ write: false }))
const digest = createHash('sha256').update(canonical(planOf(plan.families))).digest('hex')
console.log(JSON.stringify({ database: name, server: SERVER, workspaceId, digest, families: plan.families }, null, 1))
if (write) {
  if (digest !== expected) throw new Error(`refusing: the plan changed since the dry run (digest ${digest}, expected ${expected}). Run a new dry run.`)
  const result = await scoped(() => applyFamilyVariationsBackfill({ write: true }))
  console.log(JSON.stringify({ written: result.families.filter(f => f.status === 'written').map(f => f.sku),
    failed: result.families.filter(f => f.status === 'failed').map(f => ({ sku: f.sku, reason: f.reason })),
    skipped: result.families.filter(f => f.status === 'skipped').map(f => ({ sku: f.sku, reason: f.reason })) }, null, 1))
  const again = await scoped(() => applyFamilyVariationsBackfill({ write: false }))
  console.log('SECOND DRY RUN — families still planned:', again.families.filter(f => f.status === 'planned').map(f => f.sku))
}
await prisma.$disconnect()
// Imported services open queue connections that would keep the process alive.
process.exit(0)
