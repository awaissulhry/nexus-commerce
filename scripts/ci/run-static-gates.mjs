#!/usr/bin/env node
/**
 * CI Tier C (docs/ci-plan.md §2.3) — every static gate, in parallel, reporting ALL failures.
 *
 * WHY
 * The pre-push hook ran these ~45 scripts one after another and stopped at the first red. The hook
 * is skipped since 2026-09-25, so on main they ran nowhere. CI runs them here instead. Each script
 * already finishes in about a second; the cost is process start-up, so they run side by side.
 *
 * THE RULES
 * - The list below is the hook's list (.githooks/pre-push), minus the steps that need a database,
 *   a browser or a build — those have their own CI jobs.
 * - Every gate runs, even after one fails, and every failure prints its own tail. Fixing gates one
 *   push at a time was the slowest part of the old hook.
 * - A gate whose script file is missing FAILS. A deleted gate must be removed from this list on
 *   purpose; it may not vanish silently.
 *
 *   node scripts/ci/run-static-gates.mjs             run all gates
 *   node scripts/ci/run-static-gates.mjs --list      print the gate names
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const PRISMA = join(ROOT, 'node_modules', '.bin', 'prisma')

const node = (script, ...args) => ({ file: script, cmd: [process.execPath, script, ...args] })
const nodeTest = (...scripts) => ({ file: scripts[0], cmd: [process.execPath, '--test', ...scripts] })
const tsx = (script, cwd, ...args) => ({ file: join(cwd ?? '.', script), cwd, cmd: [TSX, script, ...args] })

const GATES = {
  'schema drift (tables)': node('packages/database/scripts/check-schema-drift.mjs'),
  'schema drift (columns)': node('packages/database/scripts/check-column-drift.mjs'),
  // Prisma 6 resolves env("DATABASE_URL") even to validate; a placeholder that reaches nothing is enough.
  'prisma validate': { file: 'packages/database/prisma/schema.prisma', cmd: [PRISMA, 'validate', '--schema=packages/database/prisma/schema.prisma'], env: { DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://validate@127.0.0.1:1/validate_only_test' } },
  'model ownership': node('packages/database/scripts/check-model-ownership.mjs'),
  'Prisma client adapter (Prisma 7)': node('scripts/check-prisma-client-adapter-ratchet.mjs', '--check'),
  'policy ⇄ migration parity': node('packages/database/scripts/check-policy-migration-parity.mjs'),
  'migrations: expand/contract + shipped folders unchanged': node('scripts/check-migration-expand-contract.mjs'),
  'migration gate self-test': nodeTest('scripts/check-migration-expand-contract.test.mjs'),
  'i18n catalog parity': node('scripts/check-i18n-catalog.mjs'),
  'link targets': node('scripts/check-link-targets.mjs'),
  'UI token sweep (P3)': node('scripts/p3-token-sweep.mjs', '--check'),
  'DS conformance': node('scripts/ds-conformance-guard.mjs', '--check'),
  'raw hex': node('scripts/check-css-hex-ratchet.mjs', '--check'),
  'shell pin freshness': node('scripts/check-shell-pin-fresh.mjs', '--check'),
  'dark alias scope': node('scripts/check-dark-alias-scope.mjs', '--check'),
  'raw primitives': node('scripts/check-raw-primitives-ratchet.mjs', '--check'),
  'alias form': node('scripts/check-alias-form.mjs', '--check'),
  'DS fork drift (web ⇄ factory)': node('scripts/check-ds-fork-drift.mjs', '--check'),
  'CSS radius': node('scripts/check-css-radius-ratchet.mjs', '--check'),
  'DS fonts (no Arial)': node('scripts/check-font-families.mjs', '--check'),
  'DS fonts self-test': node('scripts/check-font-families.mjs', '--self-test'),
  'CSS parse': node('scripts/check-css-parse.mjs'),
  'CSS DS shadow': node('scripts/check-css-ds-shadow-ratchet.mjs', '--check'),
  'silent disabled (U13)': node('scripts/check-silent-disabled.mjs'),
  'button vocabulary (D2c)': node('scripts/check-button-vocabulary.mjs'),
  'help cursor': node('scripts/check-help-cursor.mjs'),
  'connection resolver (MAP.3)': tsx('scripts/map0-connection-resolution-audit.mts', 'apps/api', '--ratchet'),
  'channel gateway (P1.2)': tsx('scripts/channel-gateway-ratchet.mts', 'apps/api', '--check'),
  'inbound ledger (P2.1)': node('scripts/check-inbound-ledger.mjs'),
  'web tokens.css in sync': tsx('apps/web/src/design-system/tools/generate-tokens-css.ts', undefined, '--check'),
  'factory tokens.css in sync': tsx('apps/factory/src/design-system/tools/generate-tokens-css.ts', undefined, '--check'),
  'token resolution': node('scripts/check-token-resolution.mjs', '--check'),
  'dark ⇄ pin parity': node('scripts/check-dark-pin-parity.mjs'),
  'DS token guard': node('apps/web/src/design-system/tools/token-guard.mjs'),
  'AG Grid import boundary': node('scripts/check-ag-grid-import-boundary.mjs'),
  'grid option identity': node('scripts/check-grid-option-identity.mjs'),
  'grid kit': node('scripts/check-grid-kit-ratchet.mjs', '--check'),
  'AG Grid modules': node('scripts/check-grid-modules.mjs'),
  'event contract (EV.1)': node('scripts/check-event-contract.mjs'),
  'graph contract (PH.3)': node('scripts/check-graph-contract.mjs'),
  'route ⇄ prisma (PH.4a)': node('scripts/check-route-prisma-ratchet.mjs', '--check'),
  'context boundary (PH.4b)': node('scripts/check-context-boundary.mjs', '--check'),
  'stock writer lock (AE.1)': node('scripts/check-stock-writer-lock.mjs', '--check'),
  'sync ledger source': node('scripts/check-sync-ledger-source.mjs'),
  'market currency (P4.4a)': node('apps/api/scripts/check-market-currency.mjs'),
  'clustered cron (EV.4)': node('scripts/check-cron-clustered.mjs'),
  'client bundle global exposure': node('scripts/check-global-exposure.mjs'),
  'contrast checker self-test': nodeTest('scripts/check-nds-contrast.test.mjs'),
  'contrast 7:1 (web)': node('scripts/check-nds-contrast.mjs', '--max-failures', '0', '--max-aa-failures', '0'),
  'contrast 7:1 (factory)': node('scripts/check-nds-contrast.mjs', '--tokens', 'apps/factory/src/design-system/styles/tokens.css', '--max-failures', '0', '--max-aa-failures', '0'),
  'browser gate runner self-tests': nodeTest('scripts/run-browser-gates.test.mjs', 'scripts/lib/gate-write-guard.test.mjs', 'scripts/lib/gate-aloneness.test.mjs'),
  'DS-GAPS append-only': node('scripts/check-ds-gaps-append-only.mjs', '--check'),
  'DS api guard': node('apps/web/src/design-system/tools/api-guard.mjs'),
}

if (process.argv.includes('--list')) {
  for (const name of Object.keys(GATES)) console.log(name)
  process.exit(0)
}

function run(name, gate) {
  const started = Date.now()
  if (!existsSync(join(ROOT, gate.file))) {
    return Promise.resolve({ name, ok: false, ms: 0, output: `script not found: ${gate.file}` })
  }
  return new Promise(resolve => {
    const child = spawn(gate.cmd[0], gate.cmd.slice(1), { cwd: join(ROOT, gate.cwd ?? '.'), env: { ...process.env, ...gate.env } })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => resolve({ name, ok: false, ms: Date.now() - started, output: String(error) }))
    child.on('close', code => resolve({ name, ok: code === 0, ms: Date.now() - started, output }))
  })
}

const queue = Object.entries(GATES)
const results = []
const lanes = Math.max(2, availableParallelism())
await Promise.all(Array.from({ length: lanes }, async () => {
  while (queue.length) {
    const [name, gate] = queue.shift()
    const result = await run(name, gate)
    results.push(result)
    console.log(`${result.ok ? '✓' : '✗'} ${name} (${(result.ms / 1000).toFixed(1)}s)`)
  }
}))

const failed = results.filter(r => !r.ok)
for (const r of failed) {
  const lines = r.output.trim().split('\n')
  // A test runner's summary is at the end, but the NAME of the failing test is not. Show both.
  const named = lines.filter(l => /^\s*not ok\b|✖|AssertionError|\bError:/.test(l)).slice(0, 30)
  console.log(`\n──── ✗ ${r.name} ────\n${named.length ? `${named.join('\n')}\n…\n` : ''}${lines.slice(-25).join('\n')}`)
}
console.log(`\n${results.length - failed.length}/${results.length} static gates passed.`)
process.exit(failed.length ? 1 : 0)
