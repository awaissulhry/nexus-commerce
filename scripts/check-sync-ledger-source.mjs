#!/usr/bin/env node
/**
 * Shared stock (plan docs/2026-09-19-shared-stock-plan.md) — every listing number comes from ONE ledger.
 *
 * WHY
 * A product in a borrowing business sells from another business's pool. Its own StockLevel rows are not
 * what its listings advertise. A code path that builds a Sync Control ledger from this business's own
 * rows would push that (often empty) stock over the pool number, or "heal" a correct pool number to 0.
 * `loadSyncLedgers` (apps/api/src/services/stock-pool/sync-ledgers.ts) is the one source: it knows which
 * products sell from a pool. The derivation core takes a branded `SyncLedger`, so passing a plain array
 * is a type error; this check closes the remaining door — making a `SyncLedger` by hand.
 *
 * THE RULE
 * `syncLedgerOf(` and a cast to `SyncLedger` may appear only in the files listed below (and in tests).
 *   sync-control-core.ts      defines it
 *   stock-pool/sync-ledgers.ts the loader
 *   stock-import.service.ts   the import's own rows as planned inside its transaction — used only for a
 *                             product that does NOT sell from a pool (it asks the loader first)
 *
 *   node scripts/check-sync-ledger-source.mjs [--root <dir>]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const rootFlag = args.indexOf('--root')
const ROOT = rootFlag >= 0 ? args[rootFlag + 1] : fileURLToPath(new URL('..', import.meta.url))
const ALLOWED = new Set([
  'apps/api/src/services/sync-control-core.ts',
  'apps/api/src/services/stock-pool/sync-ledgers.ts',
  'apps/api/src/services/stock-import.service.ts',
])
const PATTERN = /\bsyncLedgerOf\s*\(|\bas\s+(?:unknown\s+as\s+)?SyncLedger\b/g
const NOT_RUNTIME = /(\.test\.|\.spec\.|[\\/]__tests__[\\/]|[\\/]test-support[\\/]|\.d\.ts$)/
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo'])

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.next')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !NOT_RUNTIME.test(full)) files.push(full)
  }
}
const src = join(ROOT, 'apps', 'api', 'src')
if (existsSync(src)) walk(src)

const problems = []
let allowedHits = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (!/SyncLedger|syncLedgerOf/.test(text)) continue
  // Comments never count.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '')
  const path = relative(ROOT, file).split(sep).join('/')
  for (const match of code.matchAll(PATTERN)) {
    const line = code.slice(0, match.index).split('\n').length
    if (ALLOWED.has(path)) allowedHits++
    else problems.push(`${path}:${line} makes a Sync Control ledger by hand (${match[0].trim()}). Take it from loadSyncLedgers() in services/stock-pool/sync-ledgers.ts, so a product that sells from a shared pool follows the pool.`)
  }
}
if (files.length === 0) problems.push(`scanned ZERO files under ${src} — the check measured nothing`)
if (allowedHits === 0) problems.push('found no syncLedgerOf( in the allowed files either — the scanner is not seeing them')

if (problems.length) {
  console.error(`❌ sync-ledger source: ${problems.length} problem(s)`)
  for (const p of problems) console.error(`  • ${p}`)
  process.exit(1)
}
console.log(`✓ sync-ledger source: ${files.length} files scanned; every Sync Control ledger comes from loadSyncLedgers (${allowedHits} construction(s) in the ${ALLOWED.size} allowed files)`)
