#!/usr/bin/env node
/**
 * Nightly (docs/ci-plan.md §2.5) — the legacy API tests: plain `*.test.ts` files outside `__tests__/`
 * that vitest does not collect. Each is its own runner (`tests.push(...)` + a loop) and runs with tsx.
 * Before this script they ran nowhere.
 *
 * THE RULES
 * - Every legacy file runs, one at a time, with a time limit; exit 0 is a pass.
 * - A file on KNOWN_FAILING may fail, and must say why; a known-failing file that PASSES fails the run,
 *   so the list can only shrink. A new failure fails the run.
 * - Zero files found is a refusal, not a pass.
 *
 *   node scripts/ci/run-legacy-tests.mjs            (from the repo root; tests run in apps/api)
 */
import { execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API = join(ROOT, 'apps', 'api')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const LIMIT_MS = 120_000

/** Relative to apps/api → the reason it is allowed to fail today. */
export const KNOWN_FAILING = {}

const files = execFileSync('git', ['ls-files', 'src'], { cwd: API, encoding: 'utf8' })
  .split('\n')
  .filter(f => f.endsWith('.test.ts') && !f.endsWith('.vitest.test.ts') && !f.includes('/__tests__/'))
  .sort()
if (files.length === 0) { console.error('✗ no legacy test files found — refusing to call that a pass'); process.exit(1) }

function run(file) {
  const started = Date.now()
  return new Promise(resolve => {
    // Own process group: tsx runs the test in a GRANDCHILD. Killing only the tsx wrapper left a hung
    // test running for 21 minutes (measured 2026-09-26, ebay-pushback), so the timeout kills the group.
    const child = spawn(TSX, [file], { cwd: API, env: process.env, detached: true })
    let output = ''
    let timedOut = false
    let summarized = false
    let stoppedAfterSummary = false
    // A runner that prints its own all-green summary ("5/5 passed") and then stays alive is held open
    // by a client it imported (the BullMQ queue's Redis connection, measured on ebay-pushback and
    // channel-cancel). Its verdict is already printed; stop it 3 s later instead of waiting for the limit.
    const onData = d => {
      output += d
      if (!summarized && /\b(\d+)\/\1 passed\b/.test(output) && !/\b[1-9]\d* failed\b/.test(output)) {
        summarized = true
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); stoppedAfterSummary = true } catch { /* exited on its own */ } }, 3_000)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      timedOut = true
      output += `\n[timed out after ${LIMIT_MS / 1000}s — process group killed]`
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }, LIMIT_MS)
    child.on('exit', code => {
      clearTimeout(timer)
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* no stragglers */ }
      // Only OUR stop after an all-green summary counts as a pass; a runner that crashes on its own keeps its code.
      resolve({ file, code: timedOut ? 124 : stoppedAfterSummary ? 0 : code, ms: Date.now() - started, output, held: stoppedAfterSummary })
    })
  })
}

const results = []
for (const file of files) {
  const r = await run(file)
  results.push(r)
  console.log(`${r.code === 0 ? '✓' : '✗'} ${file} (${(r.ms / 1000).toFixed(1)}s)${r.held ? ' — all green, then held open by a client; stopped by the runner' : ''}`)
}
const newFailures = results.filter(r => r.code !== 0 && !(r.file in KNOWN_FAILING))
const nowPassing = results.filter(r => r.code === 0 && r.file in KNOWN_FAILING)
for (const r of newFailures) console.log(`\n──── ✗ ${r.file} ────\n${r.output.trim().split('\n').slice(-20).join('\n')}`)
if (nowPassing.length) console.log(`\nThese pass now — remove them from KNOWN_FAILING:\n${nowPassing.map(r => `  ${r.file}`).join('\n')}`)
console.log(`\n${results.filter(r => r.code === 0).length}/${results.length} legacy test files passed · ${Object.keys(KNOWN_FAILING).length} known failing`)
process.exit(newFailures.length || nowPassing.length ? 1 : 0)
