#!/usr/bin/env node
// R.10 — end-to-end verification harness. Runs every R.X verify
// script in sequence and aggregates pass/fail. Exits non-zero if any
// downstream script fails.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-all.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

// Ordered to match the R.X commit chronology. Failure of any one
// script does NOT abort — we want the full picture in one run.
const SCRIPTS = [
  'verify-replenishment-r17.mjs',
  'verify-replenishment-r19.mjs',
  'verify-replenishment-r20.mjs',
  'verify-replenishment-r8.mjs',
  'verify-replenishment-r9.mjs',
]

function runOne(name) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, name)], {
      stdio: 'pipe',
      env: process.env,
    })
    let stdout = ''
    p.stdout.on('data', (d) => { stdout += d.toString() })
    p.stderr.on('data', (d) => { stdout += d.toString() })
    p.on('close', (code) => {
      const passLine = stdout.match(/PASS=(\d+)\s+FAIL=(\d+)/)
      const pass = passLine ? Number(passLine[1]) : 0
      const fail = passLine ? Number(passLine[2]) : (code === 0 ? 0 : 1)
      resolve({ name, exitCode: code, pass, fail, stdout })
    })
  })
}

const results = []
let totalPass = 0
let totalFail = 0
for (const name of SCRIPTS) {
  console.log(`\n┄┄┄┄ ${name} ┄┄┄┄`)
  const r = await runOne(name)
  // Re-emit the script's own output so the operator sees per-branch
  // detail; the aggregate summary follows.
  process.stdout.write(r.stdout)
  results.push(r)
  totalPass += r.pass
  totalFail += r.fail
}

console.log('\n══════ replenishment full verify summary ══════')
for (const r of results) {
  const status = r.exitCode === 0 ? '✓' : '✗'
  console.log(`${status} ${r.name.padEnd(35)} pass=${r.pass} fail=${r.fail}`)
}
console.log(`\nTOTAL pass=${totalPass} fail=${totalFail}`)
if (totalFail > 0) process.exit(1)
