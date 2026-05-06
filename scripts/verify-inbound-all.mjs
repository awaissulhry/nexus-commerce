#!/usr/bin/env node
// H.18 — consolidated verification runner. Spawns every individual
// verify-inbound-h*.mjs script in sequence and prints a green-or-fail
// summary at the end. Designed for CI smoke + post-deploy gating.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-all.mjs
//
// Each child script either exits 0 (pass) or non-zero (fail). The
// runner forwards the child's stdout in real time so you see progress;
// it doesn't try to merge or filter the output.
//
// Sequential, not parallel: the verifies share a single Railway
// instance and a single Postgres connection pool. Running them in
// parallel risks rate-limiting + makes failures harder to attribute.
// Total runtime is ~2-3 min on a warm Railway box; cold-start adds
// ~30s for the first call.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

// Order matters: lower-numbered commits set up state that later ones
// might exercise. H.8a-d hit Amazon SP-API directly (no DB state
// required), so they're safe at any position.
const SCRIPTS = [
  'verify-inbound-h1.mjs',
  'verify-inbound-h2.mjs',
  'verify-inbound-h3.mjs',
  'verify-inbound-h4.mjs',
  'verify-inbound-h5.mjs',
  'verify-inbound-h6.mjs',
  'verify-inbound-h7.mjs',
  'verify-inbound-h8a.mjs',
  'verify-inbound-h8b.mjs',
  'verify-inbound-h8c.mjs',
  'verify-inbound-h8d.mjs',
  'verify-inbound-h10a.mjs',
  'verify-inbound-h11.mjs',
  'verify-inbound-h12.mjs',
  'verify-inbound-h13.mjs',
  'verify-inbound-h14.mjs',
  'verify-inbound-h15.mjs',
  'verify-inbound-h16.mjs',
  'verify-inbound-h17.mjs',
]

const results = []

function runOne(script) {
  return new Promise((resolve) => {
    const start = Date.now()
    console.log(`\n${'─'.repeat(70)}`)
    console.log(`▶ ${script}`)
    console.log('─'.repeat(70))
    const child = spawn('node', [path.join(here, script)], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      results.push({ script, code: code ?? -1, elapsed })
      resolve()
    })
    child.on('error', (err) => {
      console.error(`spawn error: ${err.message}`)
      results.push({ script, code: -1, elapsed: '0', error: err.message })
      resolve()
    })
  })
}

console.log(`[verify-inbound-all] target: ${process.env.API_BASE_URL ?? 'http://localhost:3001'}`)
console.log(`[verify-inbound-all] scripts: ${SCRIPTS.length}`)

for (const script of SCRIPTS) {
  await runOne(script)
}

// ── Summary ───────────────────────────────────────────────────
const passed = results.filter((r) => r.code === 0)
const failed = results.filter((r) => r.code !== 0)

console.log(`\n${'═'.repeat(70)}`)
console.log(`SUMMARY — ${passed.length}/${results.length} passed`)
console.log('═'.repeat(70))
for (const r of results) {
  const mark = r.code === 0 ? '✓' : '✗'
  const tone = r.code === 0 ? '\x1b[32m' : '\x1b[31m'
  const reset = '\x1b[0m'
  console.log(`${tone}${mark} ${r.script}${reset}  (${r.elapsed}s${r.code !== 0 ? `, exit ${r.code}` : ''})`)
}
console.log('═'.repeat(70))

if (failed.length > 0) {
  console.log(`\n[verify-inbound-all] ${failed.length} script${failed.length === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('\n[verify-inbound-all] all green')
