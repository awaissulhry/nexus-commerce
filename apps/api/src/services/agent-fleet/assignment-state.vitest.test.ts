/**
 * NAF.SB.AS — state derivation. Two rules here are easy to regress and both
 * would show the operator a confident lie:
 *
 *  1. `abandoned` must be matched BEFORE `stopped`. The reaper writes a
 *     haltedReason like every other guard, but "we closed it after 2 hours
 *     and cannot say what it cost" is not "a limit stopped it on purpose".
 *  2. An in-flight run is created ok:false and only flips true when it
 *     finishes — the trap the Workers stream hit three times. Counting
 *     !run.ok without excluding status==='running' renders every live run as
 *     a failure.
 */
import { describe, expect, it } from 'vitest'

import { deriveState, type RunRollup } from './assignment.service.js'

function run(over: Partial<RunRollup> = {}): RunRollup {
  return {
    id: 'r1',
    status: 'done',
    ok: true,
    findingCount: 0,
    costUSD: 0,
    haltedReason: null,
    errorMessage: null,
    createdAt: new Date(),
    endedAt: new Date(),
    ...over,
  }
}

describe('deriveState', () => {
  it('no runs → not started', () => {
    expect(deriveState('not_started', [])).toBe('not_started')
  })

  it('an in-flight run is RUNNING, not failed — ok:false is its birth state', () => {
    expect(deriveState('not_started', [run({ status: 'running', ok: false })])).toBe('running')
  })

  it('a clean run → finished, whether or not it found anything', () => {
    expect(deriveState('not_started', [run({ ok: true, findingCount: 0 })])).toBe('finished')
    expect(deriveState('not_started', [run({ ok: true, findingCount: 3 })])).toBe('finished')
  })

  it('a guard → stopped', () => {
    expect(
      deriveState('not_started', [run({ ok: false, haltedReason: 'kill_switch' })]),
    ).toBe('stopped')
  })

  it('the reaper → abandoned, NOT stopped', () => {
    expect(
      deriveState('not_started', [
        run({ ok: false, haltedReason: 'orphaned: stuck running >2h, reclaimed' }),
      ]),
    ).toBe('abandoned')
  })

  it('a broken run → failed', () => {
    expect(
      deriveState('not_started', [run({ ok: false, errorMessage: 'schema validation failed' })]),
    ).toBe('failed')
  })

  it('human endings outrank the machine — closing a failed assignment reads closed', () => {
    expect(deriveState('closed', [run({ ok: false })])).toBe('closed')
    expect(deriveState('cancelled', [])).toBe('cancelled')
  })

  it('the LATEST attempt decides — a retry that works clears an earlier failure', () => {
    const newest = run({ id: 'new', ok: true, createdAt: new Date(2000) })
    const older = run({ id: 'old', ok: false, createdAt: new Date(1000) })
    expect(deriveState('not_started', [newest, older])).toBe('finished')
  })

  it('a live retry after a failure reads running, not failed', () => {
    expect(
      deriveState('not_started', [
        run({ id: 'new', status: 'running', ok: false }),
        run({ id: 'old', status: 'done', ok: false }),
      ]),
    ).toBe('running')
  })
})
