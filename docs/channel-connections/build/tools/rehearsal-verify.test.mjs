import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CX_MIGRATIONS, verifyDelta, verifyHistory, verifyReady, verifyBoot, verifyObjects, verifyEnvFile, verifyRefusal,
} from './rehearsal-verify.mjs'

const tools = dirname(fileURLToPath(import.meta.url))
const evidence = '/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/rehearsal-guards-20260925'
mkdirSync(evidence, { recursive: true })
const base = [
  { name: '20260923a_channel_drift', checksum: 'a'.repeat(64) },
  { name: '20260923b_channel_drift_checked_by_source', checksum: 'b'.repeat(64) },
  { name: '20260924a_a53', checksum: 'c'.repeat(64) },
]
const release = [...base, ...CX_MIGRATIONS.map(name => ({ name, checksum: 'd'.repeat(64) }))].sort((a, b) => a.name.localeCompare(b.name))
const history = release.map(row => ({ ...row, finished: true, rolledBack: false }))
const sha = 'a'.repeat(40)
const ready = { status: 'healthy', build: sha.slice(0, 8), services: { database: 'connected', api: 'operational' } }
const boot = 'API server initialized\n' + JSON.stringify({ message: 'inbound-retry cron started', context: { ebayProcessingEnabled: false } })
const objects = Object.fromEntries(['ownerSafe', 'rolesSafe', 'functionsSafe', 'tablesSafe', 'runtimeDenied', 'membershipSafe', 'auditTrigger'].map(key => [key, true]))

test('exact eight-CX delta preserves main channel-drift names and out-of-order baseline', () => verifyDelta(base, release, release))
test('missing/extra CX migrations and altered baseline/recovery fail', () => {
  assert.throws(() => verifyDelta(base, release.slice(1), release.slice(1)))
  assert.throws(() => verifyDelta(base, [...release, { name: 'unexpected', checksum: 'e'.repeat(64) }], [...release, { name: 'unexpected', checksum: 'e'.repeat(64) }] ))
  const changed = release.map(row => ({ ...row, checksum: 'f'.repeat(64) }))
  assert.throws(() => verifyDelta(base, changed, changed))
  assert.throws(() => verifyDelta(base, release, changed))
})
test('history must be finished, unique, complete and checksum identical', () => {
  verifyHistory(history, release)
  assert.throws(() => verifyHistory(history.slice(1), release))
  assert.throws(() => verifyHistory([...history, history[0]], release))
  for (const change of [{ finished: false }, { rolledBack: true }, { checksum: 'f'.repeat(64) }]) {
    assert.throws(() => verifyHistory([{ ...history[0], ...change }, ...history.slice(1)], release))
  }
})
test('serving base acceptance or unrelated failure cannot pass the refusal control', () => {
  const refused = 'REFUSED — 8 migration(s)\n' + CX_MIGRATIONS.join('\n')
  verifyRefusal(1, refused)
  assert.throws(() => verifyRefusal(0, refused))
  assert.throws(() => verifyRefusal(1, 'connection unavailable'))
  assert.throws(() => verifyRefusal(1, refused.replace(CX_MIGRATIONS[0], 'other')))
})
test('readiness requires HTTP 200, exact build and healthy API/database', () => {
  verifyReady(200, ready, sha)
  assert.throws(() => verifyReady(503, ready, sha))
  assert.throws(() => verifyReady(200, { ...ready, build: 'bbbbbbbb' }, sha))
  assert.throws(() => verifyReady(200, { ...ready, status: 'unhealthy' }, sha))
  assert.throws(() => verifyReady(200, { ...ready, services: { database: 'down', api: 'operational' } }, sha))
})
test('boot must initialize and background jobs must report eBay processing held', () => {
  verifyBoot(boot, true)
  assert.throws(() => verifyBoot('', false))
  assert.throws(() => verifyBoot(boot + '\nFailed to start API', false))
  assert.throws(() => verifyBoot(boot + '\nCX_REHEARSAL_NETWORK_BLOCKED', false))
  assert.throws(() => verifyBoot('API server initialized', true))
  assert.throws(() => verifyBoot(boot.replace('false', 'true'), true))
  assert.throws(() => verifyBoot(boot + '\n' + boot, true))
})
test('each maintenance role/object condition is mandatory', () => {
  verifyObjects(objects)
  for (const key of Object.keys(objects)) {
    assert.throws(() => verifyObjects({ ...objects, [key]: false }))
    assert.throws(() => verifyObjects({ ...objects, [key]: null }))
  }
})
test('dotenv cannot inject credentials, switches, remote targets or Node options', () => {
  verifyEnvFile('DATABASE_URL="postgresql://synthetic@db.invalid/test"', true)
  verifyEnvFile('DATABASE_URL=postgresql://postgres@127.0.0.1:55439/test')
  for (const bad of ['AMAZON_REFRESH_TOKEN=secret', 'NODE_OPTIONS=--require=/tmp/x', 'NEXUS_ENABLE_EBAY_INBOUND_PROCESSING=1', 'DATABASE_URL=postgresql://secret@production.example/db']) {
    assert.throws(() => verifyEnvFile(bad))
  }
  assert.throws(() => verifyEnvFile('DATABASE_URL=postgresql://postgres@127.0.0.1/db', true))
})
test('socket guard blocks external connections before a socket opens', () => {
  const probe = `const net=require('node:net'); const tls=require('node:tls'); net.Socket.prototype.connect=()=>{throw new Error('unexpected socket')}; tls.connect=()=>{throw new Error('unexpected TLS socket')}; require(${JSON.stringify(join(tools, 'rehearsal-network.cjs'))}); assert.throws(()=>net.connect({host:'example.invalid',port:443}), /CX_REHEARSAL_NETWORK_BLOCKED/); assert.throws(()=>tls.connect({host:'example.invalid',port:443}), /CX_REHEARSAL_NETWORK_BLOCKED/);`
  const result = spawnSync(process.execPath, ['-e', `const assert=require('node:assert/strict');${probe}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('both shell entrypoints fail closed on a database command failure', () => {
  // Synthetic command boundary: no real Docker, build, Prisma, API or database.
  const fixture = mkdtempSync(join(evidence, 'shell-'))
  const bin = join(fixture, 'bin'); mkdirSync(bin)
  for (const tree of ['base', 'release', 'recovery']) {
    mkdirSync(join(fixture, tree, 'apps/api/dist'), { recursive: true })
    mkdirSync(join(fixture, tree, 'packages/database'), { recursive: true })
  }
  for (const tree of ['release', 'recovery']) writeFileSync(join(fixture, tree, 'apps/api/dist/index.js'), '// fixture')
  const fake = { docker: 'exit 17', git: 'if [ "$3" = rev-parse ]; then echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi', node: 'exit 0' }
  for (const [name, content] of Object.entries(fake)) writeFileSync(join(bin, name), '#!/bin/sh\n' + content + '\n', { mode: 0o755 })
  const mapping = [
    ['/private/tmp/cx-0a-20260923', join(fixture, 'base')],
    ['/private/tmp/cx-release-20260923', join(fixture, 'release')],
    ['/private/tmp/cx-recovery-20260923', join(fixture, 'recovery')],
  ]
  for (const name of ['rehearse.sh', 'rehearse-jobs.sh', 'rehearsal-common.sh']) {
    let script = readFileSync(join(tools, name), 'utf8')
    script = script.replace(/\/private\/tmp\/cx-(?:0a|release|recovery)-20260923/g, path => new Map(mapping).get(path))
    writeFileSync(join(fixture, name), script)
  }
  for (const failure of ['docker', 'bootstrap', 'migration']) {
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\n' + (failure === 'docker' ? 'exit 17' : 'if [ "$1" = port ]; then echo 127.0.0.1:54321; fi\nexit 0') + '\n', { mode: 0o755 })
    const failingCommand = failure === 'bootstrap' ? 'packages/database/scripts/bootstrap-fresh-database.mjs' : 'scripts/migrate-direct.mjs'
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nif [ "$1" = "' + failingCommand + '" ]; then exit 17; fi\nexit 0\n', { mode: 0o755 })
    for (const name of ['rehearse.sh', 'rehearse-jobs.sh']) {
      const result = spawnSync('bash', [join(fixture, name)], { cwd: fixture, env: { PATH: bin + ':/usr/bin:/bin', CX_BASE_SHA: sha, CX_RELEASE_SHA: sha, CX_RECOVERY_SHA: sha }, encoding: 'utf8', timeout: 5000 })
      writeFileSync(join(fixture, failure + '-' + name + '.log'), result.stdout + result.stderr)
      assert.equal(result.status, 17, result.stdout + result.stderr)
      assert.doesNotMatch(result.stdout, /PASS:/)
    }
  }
})
