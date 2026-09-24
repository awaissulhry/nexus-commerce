// node --test scripts/run-browser-gates.test.mjs — the browser-gate runner's rules (A-43, R-45, R-50).
// Pure rules + two process arms (a server that dies is NOT MEASURED; the runner stops what it started).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GATES, COMMON, stampFilesOf, watches, gatesToRun, ratchet, verdict, envKeyNames, waitFor, startServer, stopAll } from './run-browser-gates.mjs'
import { failureKey } from './lib/gate-report.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const stamps = Object.fromEntries(GATES.map((g) => [g.id, stampFilesOf(readFileSync(join(ROOT, g.script), 'utf8'))]))

test('every gate declares its watched files, parsed from its own source (positive control)', () => {
  for (const g of GATES) assert.ok(Array.isArray(stamps[g.id]) && stamps[g.id].length >= 3, `${g.id}: ${stamps[g.id]}`)
  assert.ok(stamps['editor-open'].includes('scripts/lib/gate-write-guard.mjs'))
  assert.equal(stampFilesOf('const x = 1'), null) // a gate with no list cannot be scoped — the runner refuses
})

test('🔴 path scope: a watched file runs its gate; an unwatched push runs nothing', () => {
  assert.deepEqual(gatesToRun(['apps/api/src/services/foo.ts', 'docs/x.md'], stamps), [])
  assert.deepEqual(gatesToRun(['apps/web/src/design-system/grid/NexusGrid.tsx'], stamps).map((g) => g.id).sort(), ['editor-open', 'grid-chrome'])
  assert.deepEqual(gatesToRun(['apps/web/src/app/products/[id]/edit/_studio/sheet/master/columns.tsx'], stamps).map((g) => g.id).sort(), ['control-census', 'editor-open'])
  assert.deepEqual(gatesToRun(['scripts/studio-gate-session.mjs'], stamps).map((g) => g.id), GATES.map((g) => g.id)) // COMMON runs all
  assert.equal(watches('apps/web/src/lib/workspaces/', 'apps/web/src/lib/workspaces/paths.ts'), true)
  assert.equal(watches('apps/web/src/proxy.ts', 'apps/web/src/proxy.tsx'), false)
  assert.ok(COMMON.includes('scripts/run-browser-gates.mjs'))
})

test('🔴 the ratchet: a NEW key fails, a known key passes, a key that went green is reported', () => {
  const r = ratchet(['a', 'b'], ['b', 'c'])
  assert.deepEqual(r, { newKeys: ['a'], dropped: ['c'] })
  const gate = { id: 'grid-chrome' }
  assert.equal(verdict([{ gate, measured: true, code: 1, secs: 1, keys: ['a', 'b'], ...r }]).failed, true)
  assert.equal(verdict([{ gate, measured: true, code: 1, secs: 1, keys: ['b'], ...ratchet(['b'], ['b', 'c']) }]).failed, false)
  assert.equal(verdict([{ gate, measured: true, code: 1, secs: 1, keys: ['a'], ...ratchet(['a'], []) }], { update: true }).failed, false)
})

test('🔴 NOT MEASURED always fails — even with an empty baseline', () => {
  assert.equal(verdict([{ gate: { id: 'editor-open' }, measured: false, code: 2, secs: 3 }]).failed, true)
  assert.equal(verdict([{ gate: { id: 'editor-open' }, measured: false, code: 0, secs: 3 }]).failed, true) // exit 0 with no report is not green
})

test('a failure key masks measured numbers, and only numbers', () => {
  assert.equal(failureKey('[monitor light compact] #big row: got 36.5, spec 37'), failureKey('[monitor light compact] #big row: got 35, spec 37'))
  assert.notEqual(failureKey('[monitor light compact] #big row: got 36, spec 37'), failureKey('[monitor dark compact] #big row: got 36, spec 37'))
})

test('env key NAMES only — values never read', () => {
  assert.deepEqual(envKeyNames('A=1\n# c\nexport B="x"\n  C_D = y\nnot a line'), ['A', 'B', 'C_D'])
})

test('🔴 a server that exits before answering is an ERROR, never a pass', async () => {
  const log = join(tmpdir(), `bg-test-${process.pid}.log`)
  const child = startServer('dying', process.execPath, ['-e', 'process.exit(3)'], { cwd: ROOT, env: process.env, log })
  await assert.rejects(waitFor('http://127.0.0.1:9/never', child, 20_000, log, 'dying'), /exited \(3\) before answering/)
})

test('🔴 the runner stops every server it started', async () => {
  const log = join(tmpdir(), `bg-test-${process.pid}-2.log`)
  const child = startServer('sleeper', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ROOT, env: process.env, log })
  child.unref() // an unstopped server must fail this arm, not hang the suite
  try {
    await new Promise((r) => setTimeout(r, 300))
    assert.doesNotThrow(() => process.kill(child.pid, 0)) // positive control: it is alive
    stopAll()
    await new Promise((r) => setTimeout(r, 300))
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/)
  } finally {
    try { process.kill(child.pid, 'SIGKILL') } catch { /* stopped, as it should be */ }
  }
})

test('🔴 a gate stopped at the time limit is NOT MEASURED — and says so', () => {
  const v = verdict([{ gate: { id: 'editor-open' }, measured: false, timedOut: true, code: 143, secs: 1800 }])
  assert.equal(v.failed, true)
  assert.match(v.lines[0], /stopped at the time limit/)
})

test('🔴 a baselined NOT MEASURED row is printed as a BLIND SPOT on every run, never silently green', () => {
  const key = failureKey('contract AMAZON·IT · text/fresh: NOT MEASURED — no rows rendered')
  const v = verdict([{ gate: { id: 'editor-open' }, measured: true, code: 1, secs: 1, keys: [key], ...ratchet([key], [key]) }])
  assert.equal(v.failed, false)
  assert.ok(v.lines.some((l) => /1 known row\(s\) NOT MEASURED — the gate is BLIND there/.test(l)), v.lines.join('\n'))
})
