#!/usr/bin/env node
// Pure assertions shared by both release rehearsals. No database or env loading here.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CX_MIGRATIONS = [
  '20260923a_cx_inbound_leases', '20260923b_cx_grant_versions',
  '20260923c_cx_ebay_quarantine', '20260923d_cx_bootstrap_parity',
  '20260923e_cx_inbound_archive', '20260923f_cx_quarantine_maintenance',
  '20260923g_cx_quarantine_inventory', '20260923h_cx_quarantine_verification',
]
const sorted = rows => [...rows].sort((a, b) => a.name.localeCompare(b.name))
export function migrationManifest(tree) {
  const root = join(tree, 'packages/database/prisma/migrations')
  return sorted(readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => ({
    name: d.name, checksum: createHash('sha256').update(readFileSync(join(root, d.name, 'migration.sql'))).digest('hex'),
  })))
}
export function verifyDelta(base, release, recovery) {
  assert.deepEqual(recovery, release, 'recovery migration files differ from release')
  const before = new Map(base.map(row => [row.name, row.checksum]))
  const after = new Map(release.map(row => [row.name, row.checksum]))
  for (const [name, checksum] of before) assert.equal(after.get(name), checksum, `base migration changed or missing: ${name}`)
  assert.deepEqual(release.filter(row => !before.has(row.name)).map(row => row.name).sort(), [...CX_MIGRATIONS].sort(), 'release must add exactly the eight CX migrations')
}
export function verifyHistory(history, manifest) {
  assert.ok(Array.isArray(history) && history.length > 0, 'migration history missing')
  for (const row of history) {
    assert.equal(row.finished, true, `unfinished migration: ${row.name}`)
    assert.equal(row.rolledBack, false, `rolled-back migration: ${row.name}`)
  }
  assert.deepEqual(sorted(history.map(({ name, checksum }) => ({ name, checksum }))), sorted(manifest), 'history/checksum differs from files')
}
export function verifyRefusal(status, log) {
  assert.equal(Number(status), 1, 'serving base must exit 1 on migrated history')
  assert.match(log, /REFUSED[^\n]*8 migration\(s\)/, 'base must refuse exactly eight missing migrations')
  for (const name of CX_MIGRATIONS) assert.ok(log.includes(name), `base refusal omitted ${name}`)
}
export function verifyReady(status, body, expected) {
  assert.equal(Number(status), 200, 'readiness must return HTTP 200')
  assert.match(expected, /^[a-f0-9]{40}$/, 'expected build must be a full commit')
  assert.equal(body.build, expected.slice(0, 8), 'unexpected serving build')
  assert.equal(body.status, 'healthy', 'API is unhealthy')
  assert.deepEqual(body.services, { database: 'connected', api: 'operational' }, 'API/database not ready')
}
export function verifyBoot(log, jobs) {
  assert.match(log, /API server initialized/, 'API did not initialize')
  assert.doesNotMatch(log, /Failed to start API|CX_REHEARSAL_NETWORK_BLOCKED/, 'boot failed or attempted external access')
  if (jobs) {
    const rows = log.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const starts = rows.filter(row => (row.message ?? row.msg ?? '').includes('inbound-retry cron started'))
    assert.equal(starts.length, 1, 'inbound retry cron must initialize once')
    assert.equal(starts[0].ebayProcessingEnabled ?? starts[0].context?.ebayProcessingEnabled, false, 'eBay processing must remain held')
  }
}
export function verifyObjects(objects) {
  for (const key of ['ownerSafe', 'rolesSafe', 'functionsSafe', 'tablesSafe', 'runtimeDenied', 'membershipSafe', 'auditTrigger']) {
    assert.equal(objects[key], true, `unsafe/missing maintenance object: ${key}`)
  }
}
export function verifyEnvFile(content, root = false) {
  // Refuse all credentials/switches, including unknown keys. DATABASE_URL is overwritten
  // in the child, but only known throwaway placeholders may exist on disk at all.
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = line.match(/^DATABASE_URL=(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*$/)
    assert.ok(match, 'unexpected env content; values are intentionally not printed')
    let url
    try { url = new URL(match[1] ?? match[2] ?? match[3]) } catch { throw new Error('Invalid synthetic DATABASE_URL; value withheld') }
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'unexpected env protocol')
    assert.ok((root ? ['db.invalid'] : ['db.invalid', '127.0.0.1', 'localhost', '[::1]']).includes(url.hostname), 'non-synthetic env target')
    assert.ok(!url.search && !url.hash, 'unexpected env URL options')
  }
}
export function verifyEnvTree(tree) {
  // API starts at repo root; env.ts also resolves that same root. Prisma loads
  // packages/database/.env and may inspect prisma/.env. Check apps/api too so a
  // later cwd change cannot quietly load the developer's credentials.
  for (const relative of ['.env', 'apps/api/.env', 'packages/database/.env', 'packages/database/prisma/.env']) {
    const path = join(tree, relative)
    if (existsSync(path)) verifyEnvFile(readFileSync(path, 'utf8'), relative === '.env')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2)
  const json = file => JSON.parse(readFileSync(file, 'utf8'))
  switch (command) {
    case 'manifest': console.log(JSON.stringify(migrationManifest(args[0]))); break
    case 'env': verifyEnvTree(args[0]); break
    case 'delta': verifyDelta(...args.map(json)); break
    case 'history': verifyHistory(...args.map(json)); break
    case 'unchanged': assert.deepEqual(json(args[0]), json(args[1]), 'migration history changed during boot/refusal'); break
    case 'refusal': verifyRefusal(args[0], readFileSync(args[1], 'utf8')); break
    case 'ready': verifyReady(args[0], json(args[1]), args[2]); break
    case 'boot': verifyBoot(readFileSync(args[0], 'utf8'), args[1] === 'jobs'); break
    case 'objects': verifyObjects(json(args[0])); break
    default: throw new Error('Unknown rehearsal assertion')
  }
}
