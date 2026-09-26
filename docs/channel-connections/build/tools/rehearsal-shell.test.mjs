import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tools = dirname(fileURLToPath(import.meta.url))
const evidence = '/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/rehearsal-guards-20260925'
const source = readFileSync(join(tools, 'rehearsal-common.sh'), 'utf8')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
// Run the actual shell functions, with synthetic command boundaries. No Docker,
// API, Prisma, sockets, or build is invoked. A sleep process supplies boot liveness.
function fn(name) {
  const match = source.match(new RegExp('^' + name + '\\(\\)[\\s\\S]*?^}', 'm'))
  assert.ok(match, `missing shell function ${name}`)
  return match[0]
}
function fixture() {
  mkdirSync(evidence, { recursive: true })
  const root = mkdtempSync(join(evidence, 'boundaries-'))
  for (const tree of ['base', 'release', 'recovery']) {
    mkdirSync(join(root, tree, 'apps/api/dist'), { recursive: true })
    mkdirSync(join(root, tree, 'packages/database'), { recursive: true })
    writeFileSync(join(root, tree, 'apps/api/dist/index.js'), '// synthetic build')
  }
  return root
}
function run(root, script) {
  const prefix = `set -euo pipefail
EV=${quote(root)}
OA="$EV/base"; REL="$EV/release"; REC="$EV/recovery"
VERIFY=${quote(join(tools, 'rehearsal-verify.mjs'))}
PATH=${quote(dirname(process.execPath) + ':/usr/bin:/bin')}
APP=''; PORT=1; MODE=http; DISABLE_JOBS=1
log() { echo "$*"; }
fail() { echo "$*" >&2; exit 70; }
trap 'if [[ -n "$APP" ]]; then kill "$APP" 2>/dev/null || true; wait "$APP" 2>/dev/null || true; fi' EXIT
`
  const result = spawnSync('bash', ['-c', prefix + script], { cwd: root, encoding: 'utf8', timeout: 5000 })
  assert.equal(result.error, undefined, result.error?.message)
  writeFileSync(join(root, 'run.log'), result.stdout + result.stderr)
  return result
}
const sha = 'a'.repeat(40)
const ready = { status: 'healthy', build: sha.slice(0, 8), services: { database: 'connected', api: 'operational' } }

for (const fault of ['wrong-head', 'dirty-source', 'missing-build', 'short-sha', 'root-env']) {
  test(`preflight refuses ${fault} before accepting provenance`, () => {
    const root = fixture()
    if (fault === 'missing-build') writeFileSync(join(root, 'release/apps/api/dist/index.js'), '')
    if (fault === 'root-env') writeFileSync(join(root, 'release/.env'), 'AMAZON_REFRESH_TOKEN=postgresql://synthetic@db.invalid/db\n')
    const expected = fault === 'short-sha' ? sha.slice(0, 8) : sha
    const actual = fault === 'wrong-head' ? 'b'.repeat(40) : expected
    const result = run(root, `git() { if [[ "$3" == rev-parse ]]; then echo ${actual}; else return ${fault === 'dirty-source' ? 1 : 0}; fi; }
${fn('preflight')}
preflight "$REL" ${expected} yes
echo ACCEPTED
`)
    assert.notEqual(result.status, 0, 'invalid provenance was accepted')
    assert.doesNotMatch(result.stdout, /ACCEPTED/)
  })
}

test('baseline history refusal happens before release migration can run', () => {
  const root = fixture()
  writeFileSync(join(root, 'history-input.json'), JSON.stringify([{ name: 'base', checksum: 'a', finished: false, rolledBack: false }]))
  for (const label of ['base', 'release', 'recovery']) writeFileSync(join(root, `manifest-${label}.json`), JSON.stringify([{ name: 'base', checksum: 'a' }]))
  const result = run(root, `clean_env() { if [[ "$PWD" == "$REL/packages/database" && "$2" == scripts/migrate-direct.mjs ]]; then echo migrated > "$EV/migration-attempted"; fi; }
history() { cp "$EV/history-input.json" "$1"; }
${fn('prepare_history')}
prepare_history
`)
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(join(root, 'migration-attempted')), false, 'release migration ran before baseline history was verified')
  assert.match(result.stderr, /unfinished migration/)
})

for (const fault of ['ready-build', 'boot-error', 'dead-process']) {
  test(`boot refuses ${fault} before its next operational step`, () => {
    const root = fixture()
    writeFileSync(join(root, 'ready-good.json'), JSON.stringify(ready))
    writeFileSync(join(root, 'ready-bad.json'), JSON.stringify({ ...ready, build: 'bbbbbbbb' }))
    const result = run(root, `clean_env() { echo 'API server initialized'; ${fault === 'boot-error' ? "echo 'Failed to start API';" : ''} exec /bin/sleep 60; }
curl() {
  local output=''
  while [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then output=$2; shift; fi; shift; done
  echo called >> "$EV/curl-calls"
  cp "$EV/${fault === 'ready-build' ? 'ready-bad' : 'ready-good'}.json" "$output"
  echo 200
}
${fault === 'dead-process' ? 'kill() { if [[ "$1" == -0 ]]; then return 1; fi; builtin kill "$@"; }' : ''}
${fn('boot')}
boot "$REL" release ${sha}
`)
    assert.notEqual(result.status, 0)
    const calls = existsSync(join(root, 'curl-calls')) ? readFileSync(join(root, 'curl-calls'), 'utf8').trim().split('\n').length : 0
    assert.equal(calls, fault === 'dead-process' ? 0 : 1, 'boot advanced past a failed mandatory check')
    assert.match(result.stderr, fault === 'ready-build' ? /unexpected serving build/ : fault === 'boot-error' ? /boot failed or attempted external access/ : /process exited before readiness/)
  })
}

test('maintenance object verifier is mandatory after the SQL snapshot', () => {
  const root = fixture()
  const result = run(root, `Q() { echo '{"ownerSafe":false}'; }
${fn('objects')}
objects migrated
echo ACCEPTED
`)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unsafe\/missing maintenance object/)
  assert.doesNotMatch(result.stdout, /ACCEPTED/)
})
