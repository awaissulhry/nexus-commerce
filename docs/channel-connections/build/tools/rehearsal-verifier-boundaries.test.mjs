import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CX_MIGRATIONS, verifyHistory, verifyReady, verifyEnvFile, verifyRefusal } from './rehearsal-verify.mjs'

const evidence = '/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/rehearsal-guards-20260925'
test('empty history cannot certify an empty manifest', () => assert.throws(() => verifyHistory([], []), /migration history missing/))
test('readiness refuses a short expected revision even if the response matches it', () => {
  assert.throws(() => verifyReady(200, { build: 'aaaaaaaa', status: 'healthy', services: { database: 'connected', api: 'operational' } }, 'aaaaaaaa'), /full commit/)
})
for (const [name, content, pattern] of [
  ['unknown key', 'AMAZON_REFRESH_TOKEN=postgresql://synthetic@db.invalid/db', /unexpected env content/],
  ['non-database protocol', 'DATABASE_URL=https://db.invalid/db', /unexpected env protocol/],
  ['URL query', 'DATABASE_URL=postgresql://synthetic@db.invalid/db?sslmode=disable', /unexpected env URL options/],
  ['URL fragment', 'DATABASE_URL="postgresql://synthetic@db.invalid/db#secret"', /unexpected env URL options/],
  ['malformed URL', 'DATABASE_URL=invalid', /value withheld/],
]) test(`synthetic environment rejects ${name}`, () => assert.throws(() => verifyEnvFile(content, true), pattern))

test('unchanged verifier rejects modified history identity or timestamps', () => {
  mkdirSync(evidence, { recursive: true })
  const root = mkdtempSync(join(evidence, 'unchanged-'))
  writeFileSync(join(root, 'before.json'), JSON.stringify([{ id: 'receipt-a', finished_at: '2026-09-25T00:00:00Z' }]))
  writeFileSync(join(root, 'after.json'), JSON.stringify([{ id: 'receipt-b', finished_at: '2026-09-25T00:00:01Z' }]))
  const verifier = join(dirname(fileURLToPath(import.meta.url)), 'rehearsal-verify.mjs')
  const result = spawnSync(process.execPath, [verifier, 'unchanged', join(root, 'before.json'), join(root, 'after.json')], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /migration history changed during boot\/refusal/)
})

test('a refusal must identify exactly eight missing migrations, even when all names appear', () => {
  const names = CX_MIGRATIONS.join('\n')
  assert.throws(() => verifyRefusal(1, 'REFUSED — 9 migration(s)\n' + names), /exactly eight/)
  assert.throws(() => verifyRefusal(1, 'connection failure\n' + names), /exactly eight/)
})
