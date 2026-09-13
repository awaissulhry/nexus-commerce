import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { otherGateProcesses, ancestorsOf, parsePs, lockIsStale, acquireGateLock, releaseGateLock } from './gate-aloneness.mjs'

/* The shape the old guard could not tell apart: MY wrapper (pid 900), the zsh that launched it
   (pid 800, whose argv repeats the gate command), and A PEER wrapper (pid 700) plus the peer's own
   gate child (pid 701). Only 700 and 701 are findings. */
const PS = [
  '    1     0 /sbin/launchd',
  '  800     1 -zsh -c node scripts/studio-gate-session.mjs -- node scripts/check-control-census.mjs',
  '  900   800 node scripts/studio-gate-session.mjs -- node scripts/check-control-census.mjs',
  '  700     1 node scripts/studio-gate-session.mjs -- node scripts/check-layout-v2.mjs',
  '  701   700 node scripts/check-layout-v2.mjs',
  '  650     1 node scripts/check-editor-open.mjs --strict',
  '  600     1 node scripts/_vtf-db.mjs',
  '  500     1 node node_modules/.bin/next dev --port 3000',
].join('\n')

test('parsePs keeps argv containing spaces intact', () => {
  const rows = parsePs(PS)
  assert.equal(rows.length, 8)
  assert.deepEqual(rows.find((r) => r.pid === 900), {
    pid: 900, ppid: 800, args: 'node scripts/studio-gate-session.mjs -- node scripts/check-control-census.mjs',
  })
})

test('ancestorsOf walks the ppid chain and stops at init', () => {
  assert.deepEqual(ancestorsOf(parsePs(PS), 900), [800])
  assert.deepEqual(ancestorsOf(parsePs(PS), 701), [700])
})

test('a SECOND wrapper and its gate child are BOTH findings — the arm the old guard was blind to', () => {
  const found = otherGateProcesses(PS, { selfPid: 900 }).map((r) => r.pid).sort()
  assert.deepEqual(found, [650, 700, 701])
})

test('my own pid and my launching shell are excluded BY PID, not by name', () => {
  const found = otherGateProcesses(PS, { selfPid: 900 })
  assert.equal(found.some((r) => r.pid === 900), false, 'self must not count')
  assert.equal(found.some((r) => r.pid === 800), false, 'the launching shell must not count')
  /* POSITIVE CONTROL for the exclusion: the shell's line DOES match the gate pattern, so it is only
     the pid exclusion that removes it — a name exclusion would have removed 700 as well. */
  assert.match(parsePs(PS).find((r) => r.pid === 800).args, /studio-gate-session\.mjs/)
})

test('non-gate node processes are not findings (the dev server, a probe script)', () => {
  const found = otherGateProcesses(PS, { selfPid: 900 }).map((r) => r.pid)
  assert.equal(found.includes(500), false)
  assert.equal(found.includes(600), false)
})

test('running alone reads EMPTY, and the same run proves the instrument is not blind', () => {
  const soloPs = ['  800     1 -zsh', '  900   800 node scripts/studio-gate-session.mjs -- node scripts/check-layout-v2.mjs'].join('\n')
  assert.deepEqual(otherGateProcesses(soloPs, { selfPid: 900 }), [])
  /* positive control in the SAME run: point the same function at a ps that DOES carry a peer */
  assert.equal(otherGateProcesses(PS, { selfPid: 900 }).length, 3)
})

test('lockIsStale: a live holder blocks, a dead holder does not, and my own pid never blocks me', () => {
  assert.equal(lockIsStale({ pid: 700, startedAt: new Date().toISOString() }, () => true), false)
  assert.equal(lockIsStale({ pid: 700, startedAt: new Date().toISOString() }, () => false), true)
  assert.equal(lockIsStale({ pid: process.pid }, () => true), true)
  assert.equal(lockIsStale(null, () => true), true)
  assert.equal(lockIsStale({ command: 'x' }, () => true), true)
})

test('acquireGateLock refuses a live holder and names it; reclaims a dead one; releases only its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtf-lock-'))
  const lock = join(dir, 'gate.lock')

  const first = acquireGateLock(lock, { command: 'node scripts/check-layout-v2.mjs' })
  assert.equal(first.note, 'no previous lock')
  assert.equal(existsSync(lock), true)

  /* A LIVE peer: the record is another pid and isAlive says yes. */
  writeFileSync(lock, JSON.stringify({ pid: 12345, startedAt: new Date(Date.now() - 42_000).toISOString(), command: 'node scripts/check-control-census.mjs' }))
  assert.throws(() => acquireGateLock(lock, { command: 'mine', isAlive: () => true }), (error) => {
    assert.match(error.message, /pid 12345/)
    assert.match(error.message, /check-control-census/)
    assert.match(error.message, /42s ago/)
    return true
  })

  /* A DEAD peer: reclaimed, with the note saying so rather than silently. */
  const reclaimed = acquireGateLock(lock, { command: 'mine', isAlive: () => false })
  assert.match(reclaimed.note, /reclaimed a STALE lock from pid 12345/)
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid)

  assert.equal(releaseGateLock(lock), 'released')
  assert.equal(existsSync(lock), false)
  assert.equal(releaseGateLock(lock), 'already released')

  /* Somebody else's lock is LEFT ALONE. */
  writeFileSync(lock, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString(), command: 'theirs' }))
  assert.match(releaseGateLock(lock), /held by pid 12345/)
  assert.equal(existsSync(lock), true)
})
