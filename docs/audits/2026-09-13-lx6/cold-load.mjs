/**
 * LX.6 item 2 — provider calls on a COLD Studio page load, both paths, per scope.
 *
 * Measured EXACTLY as the routes call them, with provider transport blocked and COUNTED, and the
 * stack of every attempt recorded so the count can be attributed to a path:
 *
 *   A. `GET /products/:id/studio/sheet` → `getInformationSheet` — NOT wrapped in
 *      `withCachedSchemas` by `product-studio.routes.ts`, so `sheet-columns.service.ts` →
 *      `channel-specs/index.ts:71-73` may fall back to `amazonSellerSpec` when no ACTIVE
 *      `CategorySchema` row exists for the (marketplace, productType). LX.R P2-19; the fix is
 *      LX.F's (the file is under VT.1's claim). This probe only counts it.
 *   B. `GET /categories/reference-labels?…&shipping=1` → `amazonReferenceLabels` — now served
 *      inside `withCachedSchemas` unless the caller sends `live=1` (LX.6's fix).
 *
 * Arm C forces path A: a coordinate whose product type has NO active cached row, read the way the
 * route reads it. Without that arm a zero on A would be "measured empty" only for coordinates that
 * happen to be cached — the positive control this measurement needs.
 *
 * Read-only connection; no business-data write.
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
Object.assign(process.env, { DATABASE_URL: url.toString(), NEXUS_WORKSPACES_ENABLED: '0', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: 'false' })

const attempts = []
const deny = (...args) => {
  const stack = (new Error('transport').stack ?? '').split('\n').slice(1, 8).map(l => l.trim()).join(' | ')
  attempts.push({ at: new Date().toISOString(), host: String(args[0]?.hostname ?? args[0] ?? '').slice(0, 120), stack })
  throw new Error('LX.6 probe forbids provider transport.')
}
https.request = deny; https.get = deny; http.request = deny; http.get = deny
globalThis.fetch = deny
syncBuiltinESMExports()

const { getInformationSheet } = await import('../../../apps/api/src/services/pim/information-sheet.ts')
const { amazonReferenceLabels } = await import('../../../apps/api/src/services/categories/reference-labels.service.ts')
const { withCachedSchemas } = await import('../../../apps/api/src/services/pim/cached-schema-context.ts')
const { clearChannelSpecCache } = await import('../../../apps/api/src/services/pim/channel-specs/index.ts')
const { clearStudioColumnCache } = await import('../../../apps/api/src/services/pim/studio-columns.ts')
const prisma = (await import('../../../apps/api/src/db.ts')).default

const productId = 'cmokmy3a40078pm0p1fvnu523'
const connections = await prisma.channelConnection.findMany({ select: { id: true, channelType: true, isPrimary: true } })
const idOf = c => connections.find(x => x.channelType === c && x.isPrimary)?.id ?? connections.find(x => x.channelType === c)?.id
const familyTypes = [...new Set((await prisma.product.findMany({ where: { OR: [{ id: productId }, { parentId: productId }] }, select: { productType: true } })).map(p => p.productType).filter(Boolean))]
const cached = await prisma.categorySchema.findMany({ where: { channel: 'AMAZON', isActive: true }, select: { marketplace: true, productType: true, fetchedAt: true, expiresAt: true } })
const cachedKeys = new Set(cached.map(r => `${r.marketplace}|${r.productType}`))
const expiredRows = cached.filter(r => r.expiresAt && r.expiresAt < new Date()).length

/** A cold process: drop the two in-process caches so each arm is a genuine first read. */
const cold = () => { clearChannelSpecCache(); clearStudioColumnCache() }

const arms = [
  { name: 'A master·IT·it — sheet read as the route calls it', kind: 'sheet', input: { productId, scope: 'master', market: 'IT', locale: 'it' } },
  { name: 'A AMAZON·IT·it — sheet read as the route calls it', kind: 'sheet', input: { productId, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', accountId: idOf('AMAZON') } },
  { name: 'A EBAY·IT·it — sheet read as the route calls it', kind: 'sheet', input: { productId, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it', accountId: idOf('EBAY') } },
  { name: 'B master·IT — reference-labels shipping=1, no live flag', kind: 'labels', wrapped: true, input: { marketplace: 'IT', productType: familyTypes[0], shipping: true } },
  { name: 'B AMAZON·DE — reference-labels shipping=1, no live flag', kind: 'labels', wrapped: true, input: { marketplace: 'DE', productType: familyTypes[0], shipping: true, accountId: idOf('AMAZON') } },
  { name: 'B positive control — reference-labels with live=1', kind: 'labels', wrapped: false, input: { marketplace: 'DE', productType: familyTypes[0], shipping: true, accountId: idOf('AMAZON') } },
]

const results = []
for (const arm of arms) {
  cold()
  const before = attempts.length
  const t0 = Date.now()
  let error = null, note = null
  try {
    if (arm.kind === 'sheet') {
      const wire = await getInformationSheet(arm.input)
      note = { rows: wire.rows.length, columns: wire.columns.length, schemaMissing: wire.meta?.schemaMissing ?? null }
    } else {
      const read = () => amazonReferenceLabels(arm.input)
      const out = arm.wrapped ? await withCachedSchemas(read) : await read()
      note = { labelGroups: Object.keys(out.labels).length, shippingLabels: Object.keys(out.labels.merchant_shipping_group ?? {}).length, unavailable: out.unavailable, stamp: out.stamp }
    }
  } catch (e) { error = String(e?.message ?? e).slice(0, 200) }
  results.push({ arm: arm.name, ms: Date.now() - t0, providerAttempts: attempts.length - before, note, error,
    stacks: attempts.slice(before).map(a => a.stack) })
  console.log(JSON.stringify({ arm: arm.name, ms: results[results.length - 1].ms, providerAttempts: results[results.length - 1].providerAttempts, error }))
}

/** Arm C — force path A: an Amazon market with NO active cached row for the family's product type. */
const markets = await prisma.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { code: true, languages: true, language: true } })
const uncached = markets.find(m => !cachedKeys.has(`${m.code}|${familyTypes[0]}`))
let armC = { forced: false, reason: `every Amazon market has an active ${familyTypes[0]} row` }
if (uncached) {
  cold()
  const before = attempts.length
  const t0 = Date.now()
  let error = null, note = null
  try {
    const wire = await getInformationSheet({ productId, scope: 'channel', channel: 'AMAZON', market: uncached.code, locale: (uncached.languages?.[0] ?? uncached.language ?? 'en'), accountId: idOf('AMAZON') })
    note = { rows: wire.rows.length, columns: wire.columns.length, schemaMissing: wire.meta?.schemaMissing ?? null }
  } catch (e) { error = String(e?.message ?? e).slice(0, 200) }
  armC = { forced: true, market: uncached.code, productType: familyTypes[0], ms: Date.now() - t0,
    providerAttempts: attempts.length - before, note, error, stacks: attempts.slice(before).map(a => a.stack) }
  console.log(JSON.stringify({ arm: `C AMAZON·${uncached.code} — uncached ${familyTypes[0]}`, providerAttempts: armC.providerAttempts, error }))
}

const receipt = { at: new Date().toISOString(), phase: process.argv[2] ?? 'after', database: target.identity,
  familyProductTypes: familyTypes, cachedAmazonRows: cached.length, expiredAmazonRows: expiredRows,
  arms: results, forcedUncached: armC, totalProviderAttempts: attempts.length, attempts }
fs.writeFileSync(new URL(`cold-load-${receipt.phase}.json`, import.meta.url), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ totalProviderAttempts: attempts.length, cachedAmazonRows: cached.length, expiredAmazonRows: expiredRows }))
await prisma.$disconnect()
