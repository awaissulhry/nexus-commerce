#!/usr/bin/env node
/**
 * S.30 — verification of the master harness + docs.
 *
 *   1. scripts/verify-stock-all.mjs exists.
 *   2. It discovers ≥ 28 verify-s*.mjs scripts (S.1–S.30, minus a
 *      couple gaps like S.3).
 *   3. DEVELOPMENT.md has the new "Stock — workspace expansion" /
 *      S.1–S.30 section.
 *   4. Section names every wave (Foundation, Analytics, Bulk +
 *      integrations, Polish + verification).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')

const failures = []

const HARNESS = path.join(ROOT, 'scripts/verify-stock-all.mjs')
if (!fs.existsSync(HARNESS)) failures.push('missing scripts/verify-stock-all.mjs')

const verifyScripts = fs.readdirSync(here)
  .filter((f) => /^verify-s\d+(?:[a-z\-]\w*)?[\w\-]*\.mjs$/.test(f))
if (verifyScripts.length < 28) {
  failures.push(`expected ≥ 28 verify-s*.mjs scripts, found ${verifyScripts.length}`)
}

const DEV_MD = path.join(ROOT, 'DEVELOPMENT.md')
const dev = fs.readFileSync(DEV_MD, 'utf8')
const REQUIRED_HEADERS = [
  '## Stock — workspace expansion (S.1–S.30)',
  '### Foundation (S.1–S.13)',
  '### Analytics + intelligence (S.14–S.20)',
  '### Bulk + integrations (S.21–S.26)',
  '### Polish + verification (S.27–S.30)',
  '### New endpoints surfaced beyond H.1',
  '### Crons added',
]
for (const h of REQUIRED_HEADERS) {
  if (!dev.includes(h)) failures.push(`DEVELOPMENT.md missing header: ${h}`)
}

// Smoke-check that the harness contains the SKIPPED detection logic
// and the per-script summary.
const harness = fs.readFileSync(HARNESS, 'utf8')
if (!/\bSKIPPED\b/.test(harness)) failures.push('master harness missing SKIPPED detection')
if (!/passed.*skipped.*failed/i.test(harness)) failures.push('master harness missing summary')

if (failures.length === 0) {
  console.log(`✅ S.30 harness + docs verified (${verifyScripts.length} verify-s*.mjs scripts discovered)`)
  process.exit(0)
}

console.error(`❌ S.30 verification failed (${failures.length}):`)
for (const f of failures) console.error(`   - ${f}`)
process.exit(1)
