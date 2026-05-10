#!/usr/bin/env node
/**
 * W15.2 — Wave audit + roll-up.
 *
 * Single runner that executes every verify-bulk-w*.mjs script in
 * order, collects pass/fail, and prints a roll-up at the end. Use
 * this as the smoke gate before / after a refactor that touches
 * multiple bulk-operations surfaces, or to sanity-check the
 * engagement is still green after a Prisma migration.
 *
 * Skips itself (verify-bulk-w15-2) so the runner can't recurse,
 * and skips W15.3 by default (perf bench takes minutes; opt in
 * with NEXUS_RUN_PERF_BENCH=1).
 *
 * Exit code: 0 if every wave passed, 1 if any wave failed.
 */

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

function naturalSortKey(name) {
  // Sort by (waveNumber, subNumber) so w2-* comes before w10-*.
  const m = name.match(/verify-bulk-w(\d+)-(\d+)\.mjs$/)
  if (!m) return [Infinity, 0]
  return [parseInt(m[1], 10), parseInt(m[2], 10)]
}

const SELF = path.basename(fileURLToPath(import.meta.url))
const SKIP = new Set([SELF])
if (process.env.NEXUS_RUN_PERF_BENCH !== '1') {
  SKIP.add('verify-bulk-w15-3.mjs')
}

const dir = path.join(repo, 'scripts')
const all = fs
  .readdirSync(dir)
  .filter((f) => /^verify-bulk-w\d+-\d+\.mjs$/.test(f) && !SKIP.has(f))
  .sort((a, b) => {
    const [aw, as] = naturalSortKey(a)
    const [bw, bs] = naturalSortKey(b)
    return aw - bw || as - bs
  })

console.log(`\nW15.2 — wave audit (${all.length} scripts)\n`)

const summary = []
let passed = 0
let failed = 0

for (const script of all) {
  const tag = script.replace(/^verify-bulk-/, '').replace(/\.mjs$/, '')
  const start = Date.now()
  let pass = true
  let asserts = 0
  let failedAsserts = 0
  let stdoutTail = ''
  try {
    const out = execFileSync('node', [path.join(dir, script)], {
      cwd: repo,
      stdio: 'pipe',
      env: process.env,
      timeout: 120_000,
    }).toString()
    asserts = (out.match(/^\s*[✓✗]/gm) ?? []).length
    failedAsserts = (out.match(/^\s*✗/gm) ?? []).length
    pass = failedAsserts === 0
    stdoutTail = out.split('\n').slice(-3).join('\n')
  } catch (err) {
    pass = false
    const out =
      (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '')
    asserts = (out.match(/^\s*[✓✗]/gm) ?? []).length
    failedAsserts = (out.match(/^\s*✗/gm) ?? []).length || 1
    stdoutTail = out.split('\n').slice(-3).join('\n')
  }
  const dur = Date.now() - start
  summary.push({ tag, pass, asserts, failedAsserts, durMs: dur, tail: stdoutTail })
  if (pass) passed++
  else failed++
  process.stdout.write(
    `  ${pass ? '✓' : '✗'} ${tag.padEnd(8)}  ${String(asserts).padStart(3)} asserts  ${String(dur).padStart(5)}ms${pass ? '' : `  ${failedAsserts} failed`}\n`,
  )
}

console.log('\nRoll-up')
console.log(`  ${passed}/${all.length} waves passed`)
const totalAsserts = summary.reduce((s, r) => s + r.asserts, 0)
const totalFailedAsserts = summary.reduce((s, r) => s + r.failedAsserts, 0)
console.log(`  ${totalAsserts - totalFailedAsserts}/${totalAsserts} assertions passed`)
const totalDur = summary.reduce((s, r) => s + r.durMs, 0)
console.log(`  ${(totalDur / 1000).toFixed(1)}s total wall-clock`)

if (failed > 0) {
  console.log('\nFailing waves:')
  for (const r of summary) {
    if (r.pass) continue
    console.log(`\n  ${r.tag}:`)
    console.log(r.tail.split('\n').map((l) => `    ${l}`).join('\n'))
  }
  process.exit(1)
}
console.log('\n✓ all waves passed')
