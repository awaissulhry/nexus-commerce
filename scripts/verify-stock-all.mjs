#!/usr/bin/env node
/**
 * S.30 — Master verification harness for the Stock surface.
 *
 * Discovers every `verify-s*.mjs` in scripts/ and runs them
 * sequentially, capturing exit code + stdout + stderr. Reports a
 * red/green summary at the end and exits non-zero if any script
 * failed. Use this in CI as a single gate, or locally before any
 * stock-related commit.
 *
 * Discovery is shallow: only scripts/verify-s*.mjs (the per-commit
 * verifications). Other scripts/verify-*.mjs (e.g. verify-stock.mjs,
 * verify-r01-…) are not included — they have different contracts.
 */
import { readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const SCRIPTS = readdirSync(here)
  .filter((f) => /^verify-s\d+(?:[a-z\-]\w*)?[\w\-]*\.mjs$/.test(f))
  .sort((a, b) => {
    // Numeric sort by the "sN" prefix so s2 < s10 < s27.
    const na = parseInt(a.match(/^verify-s(\d+)/)?.[1] ?? '0', 10)
    const nb = parseInt(b.match(/^verify-s(\d+)/)?.[1] ?? '0', 10)
    if (na !== nb) return na - nb
    return a.localeCompare(b)
  })

if (SCRIPTS.length === 0) {
  console.error('No verify-s*.mjs scripts discovered.')
  process.exit(1)
}

console.log(`Running ${SCRIPTS.length} verify scripts:\n`)

const results = []
for (const script of SCRIPTS) {
  const start = Date.now()
  const result = await runOne(path.join(here, script))
  const elapsed = Date.now() - start
  // Scripts that detect a missing prerequisite exit 0 with the line
  // "SKIPPED —" in their stdout. Treat those as skipped, not passed.
  const skipped = result.code === 0 && /\bSKIPPED\b\s*[—-]/.test(result.stdout)
  const status = skipped ? 'skipped' : result.code === 0 ? 'passed' : 'failed'
  results.push({ script, status, ...result, elapsedMs: elapsed })
  const tick = status === 'passed' ? '✅' : status === 'skipped' ? '⏭️ ' : '❌'
  const ms = `${elapsed}ms`.padStart(7)
  console.log(`  ${tick} ${ms}  ${script}`)
  if (status === 'skipped') {
    const skipLine = result.stdout.split('\n').find((l) => /SKIPPED/.test(l))
    if (skipLine) console.log(`        ${skipLine.trim()}`)
  } else if (status === 'failed') {
    const lines = (result.stderr + result.stdout).trim().split('\n').slice(-12)
    for (const l of lines) console.log(`        ${l}`)
  }
}

const passed = results.filter((r) => r.status === 'passed').length
const skipped = results.filter((r) => r.status === 'skipped').length
const failed = results.filter((r) => r.status === 'failed').length
const totalMs = results.reduce((acc, r) => acc + r.elapsedMs, 0)

const summary = `${passed} passed, ${skipped} skipped, ${failed} failed`
console.log(`\n${failed === 0 ? '✅' : '❌'} ${summary} (${totalMs}ms total)`)

process.exit(failed === 0 ? 0 : 1)

function runOne(absPath) {
  return new Promise((resolve) => {
    const child = spawn('node', [absPath], { cwd: path.resolve(here, '..') })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: String(err) }))
  })
}
