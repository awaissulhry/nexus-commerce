/**
 * LX.6 — the wire facts behind items 1 and 3, read through the SAME producer the screen reads
 * (`getStudioSheet`), inside `withCachedSchemas` so no page-load path can reach a provider.
 * Provider transport is blocked AND counted before the import; read-only connection.
 *
 * Item 1 (R-LX-2, the cross-channel footer note): per scope, how many CELLS and COLUMNS carry
 * `affectsAllChannels` — the predicate the footer note is gated on.
 * Item 3 (LX.11): per scope, the single-language column set vs the `?locales=` widened set, the
 * `<key>@<locale>` shape, the field grouping, and the three toolbar chip counts computed from the
 * wire exactly as the screen computes them.
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
const deny = (...args) => { attempts.push({ at: new Date().toISOString(), target: String(args[0]?.hostname ?? args[0] ?? '').slice(0, 120) }); throw new Error('LX.6 probe forbids provider transport.') }
https.request = deny; https.get = deny; http.request = deny; http.get = deny
globalThis.fetch = deny
syncBuiltinESMExports()

// 🔴 The Languages view is widened by `getInformationSheet`, NOT by `getStudioSheet` — a first pass
// against `getStudioSheet({locales})` read 0 qualified columns on every scope, which was
// "could not measure", not "measured empty" (`reference_could_not_measure_vs_measured_empty`).
const { getInformationSheet } = await import('../../../apps/api/src/services/pim/information-sheet.ts')
const { withCachedSchemas } = await import('../../../apps/api/src/services/pim/cached-schema-context.ts')
const prisma = (await import('../../../apps/api/src/db.ts')).default

const productId = 'cmokmy3a40078pm0p1fvnu523'
const connections = await prisma.channelConnection.findMany({ select: { id: true, channelType: true, isPrimary: true } })
const idOf = channel => connections.find(c => c.channelType === channel && c.isPrimary)?.id ?? connections.find(c => c.channelType === channel)?.id

const scopes = [
  { name: 'master·IT·it', scope: 'master', market: 'IT', locale: 'it', locales: ['it', 'de', 'fr'] },
  { name: 'AMAZON·IT·it', scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', accountId: idOf('AMAZON'), locales: ['it'] },
  { name: 'AMAZON·DE·de', scope: 'channel', channel: 'AMAZON', market: 'DE', locale: 'de', accountId: idOf('AMAZON'), locales: ['de'] },
  { name: 'AMAZON·BE·nl', scope: 'channel', channel: 'AMAZON', market: 'BE', locale: 'nl', accountId: idOf('AMAZON'), locales: ['nl', 'fr'] },
  { name: 'AMAZON·BE·fr', scope: 'channel', channel: 'AMAZON', market: 'BE', locale: 'fr', accountId: idOf('AMAZON'), locales: ['nl', 'fr'] },
  { name: 'EBAY·IT·it', scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it', accountId: idOf('EBAY'), locales: ['it'] },
  { name: 'SHOPIFY·GLOBAL', scope: 'channel', channel: 'SHOPIFY', market: 'GLOBAL', locale: 'it', accountId: idOf('SHOPIFY'), locales: ['it', 'de'] },
]

const chipCounts = (wire, textKeys) => {
  const counts = { 'Needs translation': 0, 'AI drafts': 0, 'Out of date': 0 }
  for (const row of wire.rows) for (const [key, cell] of Object.entries(row.values)) {
    if (!textKeys.has(key)) continue
    if (cell.requested && cell.language !== cell.requested) counts['Needs translation']++
    if (cell.translation && cell.translation.source !== 'manual' && !cell.translation.reviewedAt) counts['AI drafts']++
    if (cell.translation?.outdated) counts['Out of date']++
  }
  return counts
}

const facts = []
for (const s of scopes) {
  const one = { name: s.name }
  for (const mode of ['single', 'languages']) {
    const before = attempts.length
    const t0 = Date.now()
    try {
      const wire = await withCachedSchemas(() => getInformationSheet({
        productId, scope: s.scope, market: s.market, channel: s.channel, locale: s.locale, accountId: s.accountId,
        ...(mode === 'languages' ? { locales: s.locales } : {}),
      }))
      const localizable = wire.columns.filter(c => c.localizable)
      const qualified = wire.columns.filter(c => c.locale)
      let cells = 0, crossChannelCells = 0
      const crossChannelCols = new Set()
      for (const row of wire.rows) for (const [key, cell] of Object.entries(row.values)) {
        cells++
        if (cell.affectsAllChannels) { crossChannelCells++; crossChannelCols.add(key) }
      }
      const textKeys = new Set(wire.columns.filter(c => c.locale || c.localizable).map(c => c.key))
      one[mode] = {
        ms: Date.now() - t0,
        transportAttempts: attempts.length - before,
        rows: wire.rows.length,
        columns: wire.columns.length,
        localizableColumns: localizable.length,
        qualifiedColumns: qualified.length,
        qualifiedShapeOk: qualified.every(c => c.key.endsWith('@' + c.locale)),
        qualifiedGroups: [...new Set(qualified.map(c => c.group ?? c.groupLabel ?? null))].slice(0, 12),
        localesEcho: wire.scope?.locales ?? wire.meta?.locales ?? null,
        cells,
        affectsAllChannelsCells: crossChannelCells,
        affectsAllChannelsColumns: crossChannelCols.size,
        affectsAllChannelsColumnKeys: [...crossChannelCols].slice(0, 12),
        schemaMissing: wire.meta?.schemaMissing ?? null,
        schemaAgeFetchedAt: wire.meta?.schemaAge ? Object.entries(wire.meta.schemaAge).slice(0, 3) : null,
        chipCounts: chipCounts(wire, textKeys),
      }
    } catch (e) {
      one[mode] = { ms: Date.now() - t0, transportAttempts: attempts.length - before, error: String(e?.message ?? e).slice(0, 300) }
    }
  }
  facts.push(one)
  console.log(JSON.stringify(one))
}

const receipt = { at: new Date().toISOString(), database: target.identity, productId, facts, transportAttempts: attempts }
fs.writeFileSync(new URL('sheet-facts.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ totalTransportAttempts: attempts.length }))
await prisma.$disconnect()
