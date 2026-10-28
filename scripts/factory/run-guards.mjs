#!/usr/bin/env node
/**
 * run-guards — RULE: every factory guard passes. Runs each scripts/factory/check-*.mjs (found by name, so a new guard
 * joins without editing this file), one after another, shows each one's output, and exits 1 when any guard fails.
 * A guard that only warns (for example the lane-ownership check) exits 0 and so never fails the run.
 *
 * Run: node scripts/factory/run-guards.mjs
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('.', import.meta.url))
const guards = readdirSync(DIR)
  .filter((name) => /^check-.+\.mjs$/.test(name))
  .sort()

if (guards.length === 0) {
  console.error('run-guards: no scripts/factory/check-*.mjs found')
  process.exit(1)
}

const results = guards.map((name) => {
  const run = spawnSync(process.execPath, [join(DIR, name)], { encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd()
  const passed = run.status === 0
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${output ? `\n${output.replace(/^/gm, '      ')}` : ''}`)
  return passed
})

const failed = results.filter((passed) => !passed).length
console.log(`\nrun-guards: ${guards.length - failed} of ${guards.length} factory guards passed`)
process.exit(failed === 0 ? 0 : 1)
