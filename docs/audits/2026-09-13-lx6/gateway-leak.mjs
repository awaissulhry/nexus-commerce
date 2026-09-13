/**
 * LX.6 item 2 — the seller-spec gateway leak on a Studio page load.
 *
 * Measures the `shipping=1` label path with provider transport BLOCKED AND COUNTED (the stub is
 * installed BEFORE the service import — `reference_node_probe_pure_modules`). Three arms in ONE run:
 *
 *   control-db      `shipping:false` — must return labels from the cached CategorySchema with 0 transport attempts
 *                   (the positive control: the instrument is pointed at a path that DOES work)
 *   leak-master     `shipping:true`, no accountId  — the master-scope page-load request the gate captured
 *   leak-channel    `shipping:true`, accountId     — the channel-scope page-load request the gate captured
 *
 * Read-only: `default_transaction_read_only=on` on the connection. No business-data write.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { databaseTarget } from '../2026-09-12-language-axis/step1/target.mjs'

const target = await databaseTarget('local')
assert.equal(target.identity.database, 'nexus_development')
const url = new URL(target.connectionString)
url.searchParams.set('options', '-c default_transaction_read_only=on')
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  NEXUS_WORKSPACES_ENABLED: '0',
  NEXUS_DISABLE_BACKGROUND_JOBS: '1',
  ENABLE_QUEUE_WORKERS: 'false',
})

const attempts = []
const deny = (...args) => {
  const where = new Error('provider transport attempt')
  attempts.push({ at: new Date().toISOString(), target: String(args[0]?.hostname ?? args[0] ?? '').slice(0, 120), stack: (where.stack ?? '').split('\n').slice(1, 6).join(' | ') })
  throw new Error('LX.6 probe forbids provider transport.')
}
https.request = deny; https.get = deny; http.request = deny; http.get = deny
globalThis.fetch = deny
syncBuiltinESMExports()

const { amazonReferenceLabels } = await import('../../../apps/api/src/services/categories/reference-labels.service.ts')
const prisma = (await import('../../../apps/api/src/db.ts')).default

const account = (await prisma.channelConnection.findFirst({ where: { channelType: 'AMAZON' }, select: { id: true, displayName: true, isPrimary: true }, orderBy: { id: 'asc' } }))
const gale = await prisma.product.findMany({ where: { sku: 'GALE-JACKET' }, select: { id: true, sku: true, version: true } })
const productRows = await prisma.product.count()
const schemas = await prisma.categorySchema.findMany({ where: { channel: 'AMAZON', productType: 'OUTERWEAR', isActive: true }, select: { marketplace: true, fetchedAt: true }, orderBy: { fetchedAt: 'desc' } })

const arms = [
  { name: 'control-db', input: { marketplace: 'DE', productType: 'OUTERWEAR', shipping: false } },
  { name: 'leak-master', input: { marketplace: 'IT', productType: 'OUTERWEAR', shipping: true } },
  { name: 'leak-channel', input: { marketplace: 'DE', productType: 'OUTERWEAR', shipping: true, accountId: account?.id } },
]
const results = []
for (const arm of arms) {
  const before = attempts.length
  const started = Date.now()
  let out = null, error = null
  try { out = await amazonReferenceLabels(arm.input) } catch (e) { error = String(e?.message ?? e) }
  results.push({
    arm: arm.name,
    input: { ...arm.input, accountId: arm.input.accountId ? '<amazon connection>' : undefined },
    ms: Date.now() - started,
    transportAttempts: attempts.length - before,
    labelGroups: out ? Object.keys(out.labels).length : null,
    shippingLabelCount: out ? Object.keys(out.labels.merchant_shipping_group ?? {}).length : null,
    unavailable: out?.unavailable ?? null,
    stamp: out?.stamp ?? null,
    error,
  })
}

const receipt = {
  at: new Date().toISOString(),
  phase: process.argv[2] ?? 'before',
  database: { ...target.identity, productRows, galeJacket: gale },
  cachedOuterwearSchemas: schemas.map(s => ({ marketplace: s.marketplace, fetchedAt: s.fetchedAt })),
  amazonConnection: account ? { present: true, displayName: account.displayName, isPrimary: account.isPrimary } : { present: false },
  arms: results,
  transportAttemptDetail: attempts,
}
console.log(JSON.stringify(receipt, null, 2))
fs.writeFileSync(new URL(`gateway-leak-${receipt.phase}.json`, import.meta.url), JSON.stringify(receipt, null, 2) + '\n')
await prisma.$disconnect()
