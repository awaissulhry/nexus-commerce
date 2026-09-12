import { describe, expect, it, vi } from 'vitest'

import { runAction } from './runAction'
import { AVAILABLE, ROW, type ActionImpact, type GridAction } from './registry'

interface Row { id: string }
const rows: Row[] = [{ id: 'r1' }]

const verb = (over: Partial<GridAction<Row>> = {}): GridAction<Row> => ({
  id: 'delete', label: 'Delete', scope: ROW, available: () => AVAILABLE,
  run: async () => ({ ok: true }),
  ...over,
})

const yes = async () => true
const no = async () => false

describe('runAction — a verb with no preflight', () => {
  it('runs immediately, with NO impact — not an invented empty one', async () => {
    let seen: unknown = 'unset'
    const out = await runAction(verb({ run: async (_r, i) => { seen = i; return { ok: true } } }), rows, yes)
    expect(out).toMatchObject({ kind: 'ran' })
    expect(seen).toBeUndefined()
  })

  it('never asks — there is nothing to describe', async () => {
    const ask = vi.fn(yes)
    await runAction(verb(), rows, ask)
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('runAction — the preflight gates everything', () => {
  it('cancels a parameter picker without confirming, running or reporting an error', async () => {
    const run = vi.fn(async () => ({ ok: true })), ask = vi.fn(yes)
    expect(await runAction(verb({ preflight: async () => ({ level: 'none', title: 'Pick a product', cancelled: true }), run }), rows, ask)).toEqual({ kind: 'cancelled' })
    expect(run).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })
  it('a preflight that throws does NOT let the verb run', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const out = await runAction(verb({ preflight: async () => { throw new Error('listings service unreachable') }, run }), rows, yes)
    expect(out).toEqual({ kind: 'failed', message: 'listings service unreachable' })
    expect(run).not.toHaveBeenCalled()
  })

  /**
   * 🔴 The one that matters most. An impact asking to be typed while naming no phrase is a BUG in
   * the preflight; running it as a plain confirm is how a five-live-listing delete becomes a click.
   */
  it('REFUSES a malformed impact rather than softening it to a plain confirm', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const ask = vi.fn(yes)
    const out = await runAction(verb({ preflight: async () => ({ level: 'type-to-confirm', title: 'Delete?' }), run }), rows, ask)
    expect(out.kind).toBe('refused')
    expect(run).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled() // not even asked — the check itself is broken
  })

  it('refuses when the preflight itself reported it could not look', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const out = await runAction(
      verb({ preflight: async () => ({ level: 'none', title: 'x', unavailable: 'Amazon did not answer' }), run }),
      rows, yes,
    )
    expect(out).toEqual({ kind: 'refused', problem: 'Amazon did not answer' })
    expect(run).not.toHaveBeenCalled()
  })

  it('level "none" runs without asking — the preflight looked and found nothing to stop for', async () => {
    const ask = vi.fn(yes)
    const out = await runAction(verb({ preflight: async () => ({ level: 'none', title: 'Nothing is listed' }) }), rows, ask)
    expect(out.kind).toBe('ran')
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('runAction — the operator’s answer', () => {
  it('a no means NOTHING happened', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const out = await runAction(verb({ preflight: async () => ({ level: 'confirm', title: 'Sure?' }), run }), rows, no)
    expect(out).toEqual({ kind: 'cancelled' })
    expect(run).not.toHaveBeenCalled()
  })

  /**
   * 🔴 `cancelled` and `refused` are different facts. A surface that collapsed them would go silent
   * on a broken confirm dialog — which from the operator's side is indistinguishable from having
   * pressed Cancel, while actually meaning the safety check never ran.
   */
  it('a confirm that BLEW UP is a refusal, not a yes and not a cancel', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const out = await runAction(
      verb({ preflight: async () => ({ level: 'confirm', title: 'Sure?' }), run }),
      rows,
      () => { throw new Error('confirm host unmounted') },
    )
    expect(out).toEqual({ kind: 'refused', problem: 'confirm host unmounted' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a synchronous ask is honoured too', async () => {
    expect((await runAction(verb({ preflight: async () => ({ level: 'confirm', title: 'q' }) }), rows, () => false)).kind).toBe('cancelled')
  })
})

describe('runAction — what run receives and returns', () => {
  /** Ruling #118: the operator approves snapshot A, so run applies snapshot A. */
  it('run receives the very impact its own preflight produced', async () => {
    const fetched = { rev: 'A' }
    const impact: ActionImpact = { level: 'confirm', title: 'Pull?', payload: fetched }
    let seen: unknown = 'unset'
    const out = await runAction(
      verb({ preflight: async () => impact, run: async (_r, i) => { seen = i; return { ok: true } } }),
      rows, yes,
    )
    expect(seen).toBe(impact) // identity: proof there was no second fetch
    expect(out).toMatchObject({ kind: 'ran', impact })
  })

  it('a throwing run reports the SERVER’s words, not a rewrite', async () => {
    const out = await runAction(verb({ run: async () => { throw new Error('GALE-JACKET has 20 children.') } }), rows, yes)
    expect(out).toEqual({ kind: 'failed', message: 'GALE-JACKET has 20 children.' })
  })

  /** A verb that returns ok:false SUCCEEDED at running and FAILED at its job — a different fact. */
  it('a run that returns ok:false is "ran", so the surface can show the server’s message', async () => {
    const out = await runAction(verb({ run: async () => ({ ok: false, message: '3 of 20 could not be attached' }) }), rows, yes)
    expect(out).toEqual({ kind: 'ran', result: { ok: false, message: '3 of 20 could not be attached' }, impact: undefined })
  })

  it('a non-Error throw still produces a readable message', async () => {
    const out = await runAction(verb({ run: async () => { throw 'plain string' } }), rows, yes)
    expect(out).toEqual({ kind: 'failed', message: 'plain string' })
  })
})
