/**
 * LX.6 item 1 (R-LX-2) — is the cross-channel footer note MISSING on eBay·IT, or correctly absent?
 *
 * The note renders iff `crossChannelColumnCount(firstVariantRow) > 0`
 * (`_studio/sheet/channel/rows.ts:390`): a cell with `affectsAllChannels` AND `editable !== false`
 * AND `writable !== false`. This reads the same predicate off the wire, per scope, and lists the
 * cells that carry the flag with their editable/writable answers — so "absent" is distinguishable
 * from "not measured". Read-only, transport blocked and counted.
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
const deny = () => { attempts.push(new Date().toISOString()); throw new Error('LX.6 probe forbids provider transport.') }
https.request = deny; https.get = deny; http.request = deny; http.get = deny
globalThis.fetch = deny
syncBuiltinESMExports()

const { getInformationSheet } = await import('../../../apps/api/src/services/pim/information-sheet.ts')
const { withCachedSchemas } = await import('../../../apps/api/src/services/pim/cached-schema-context.ts')
/**
 * `rows.ts` cannot be imported outside the web app (its `@/` alias does not resolve under tsx), so
 * the predicate is restated HERE and the restatement is CHECKED against the source line in the same
 * run — a second copy that can drift silently would be the defect this probe exists to rule out.
 */
const rowsSource = fs.readFileSync(new URL('../../../apps/web/src/app/products/[id]/edit/_studio/sheet/channel/rows.ts', import.meta.url), 'utf8')
const predicateLine = "return Object.values(row.values).filter((c) => c?.affectsAllChannels && c.editable !== false && c.writable !== false).length"
assert.ok(rowsSource.includes(predicateLine), 'crossChannelColumnCount changed; update this probe')
const crossChannelColumnCount = row => !row?.values ? 0 : Object.values(row.values).filter(c => c?.affectsAllChannels && c.editable !== false && c.writable !== false).length
const prisma = (await import('../../../apps/api/src/db.ts')).default

const productId = 'cmokmy3a40078pm0p1fvnu523'
const connections = await prisma.channelConnection.findMany({ select: { id: true, channelType: true, isPrimary: true } })
const idOf = c => connections.find(x => x.channelType === c && x.isPrimary)?.id ?? connections.find(x => x.channelType === c)?.id

const scopes = [
  { name: 'EBAY·IT·it', channel: 'EBAY', market: 'IT', locale: 'it' },
  { name: 'AMAZON·DE·de', channel: 'AMAZON', market: 'DE', locale: 'de' },
  { name: 'AMAZON·IT·it', channel: 'AMAZON', market: 'IT', locale: 'it' },
  { name: 'AMAZON·BE·nl', channel: 'AMAZON', market: 'BE', locale: 'nl' },
]
const out = []
for (const s of scopes) {
  const wire = await withCachedSchemas(() => getInformationSheet({ productId, scope: 'channel', channel: s.channel, market: s.market, locale: s.locale, accountId: idOf(s.channel) }))
  // The adapter measures the FIRST variant row, not the parent (`useChannelSheetAdapter.tsx:528`).
  const variant = wire.rows.find(r => r.parentId) ?? wire.rows[1] ?? wire.rows[0]
  const flagged = Object.entries(variant.values).filter(([, c]) => c?.affectsAllChannels)
  out.push({
    scope: s.name,
    columns: wire.columns.length,
    rowMeasured: { id: variant.id, sku: variant.sku },
    affectsAllChannelsCells: flagged.length,
    flagged: flagged.map(([key, c]) => ({ key, editable: c.editable ?? null, writable: c.writable ?? null, writeTarget: c.writeTarget ?? null, writeVerb: c.writeVerb ?? null })),
    crossChannelColumnCount: crossChannelColumnCount(variant),
    footerNoteRenders: crossChannelColumnCount(variant) > 0,
  })
  console.log(JSON.stringify(out[out.length - 1]))
}
fs.writeFileSync(new URL('footer-note.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), database: target.identity, scopes: out, transportAttempts: attempts }, null, 2) + '\n')
console.log(JSON.stringify({ transportAttempts: attempts.length }))
await prisma.$disconnect()
