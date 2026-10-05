/**
 * CC-19 — a market is offered for a launch only when a campaign created there can reach Amazon: the write gate's four
 * checks (active, production, writes enabled, Amazon's limits known). It used to be active + production only.
 */
import { describe, expect, it } from 'vitest'
import { launchability } from './launchability'

const conn = (over: Partial<Parameters<typeof launchability>[0]> = {}) => ({ code: 'DE', isActive: true, mode: 'production', writesEnabled: true, ...over })

describe('CC-19 — launchable means a create can reach Amazon', () => {
  it('active + production + writes enabled + a limits row → launchable', () => {
    expect(launchability(conn())).toEqual({ launchable: true, whyNot: null, short: null })
  })

  it('🔴 production with writes NOT enabled is not launchable (it was), and says why', () => {
    const l = launchability(conn({ writesEnabled: false }))
    expect(l.launchable).toBe(false)
    expect(l.short).toBe('writes off')
    expect(l.whyNot).toMatch(/Writes are not enabled/)
  })

  it('🔴 a production market with no checked Amazon limits is not launchable (it was)', () => {
    const l = launchability(conn({ code: 'UK' }))
    expect(l.launchable).toBe(false)
    expect(l.short).toBe('no limits list')
  })

  it('sandbox and inactive connections stay not launchable, each with its reason', () => {
    expect(launchability(conn({ mode: 'sandbox' }))).toMatchObject({ launchable: false, short: 'sandbox' })
    expect(launchability(conn({ isActive: false }))).toMatchObject({ launchable: false, short: 'not active' })
  })
})
