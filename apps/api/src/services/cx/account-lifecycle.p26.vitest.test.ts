/**
 * P2.6 — every revoke signal reaches the ONE state machine.
 *
 * Most of this package already worked and the measurement had to establish that before
 * anything was written: the gateway already HOLDS a call whose account is inactive or
 * `needs_reauth` / `revoked` / `disconnected`; `transition()` already guards the
 * terminal states, writes with a compare-and-set, records a ConnectionEvent and raises
 * a CONNECTION_HEALTH alert; and Amazon's `invalid_grant` and Etsy's refresh 401
 * already reach it, both classifying as `auth_revoked` → `needs_reauth`.
 *
 * What did not reach it: eBay's revocation, and Shopify's uninstall — which P2.4 wrote
 * as a raw `updateMany`, skipping all four.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const transitions: Array<{ id: string; next: string; reason: string }> = []
const updates: any[] = []
let row: any = { id: 'conn-1', channelType: 'SHOPIFY', authStatus: 'connected', displayName: 'a-shop' }

// A PARTIAL mock: `transition` is stubbed so its effects can be observed, while
// `statusAfterConnectionFailure` stays REAL. Mocking the whole module would have left
// the Amazon/Etsy assertions below testing this file's own stub, which proves nothing.
vi.mock('./token.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./token.service.js')>()),
  transition: async (r: any, next: string, reason: string) => { transitions.push({ id: r.id, next, reason }) },
}))
vi.mock('../../db.js', () => ({
  default: {
    channelConnection: {
      findUnique: async () => row,
      updateMany: async (args: any) => { updates.push(args); return { count: 1 } },
    },
  },
}))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { revokeChannelConnection } = await import('./account-lifecycle.service.js')
const { statusAfterConnectionFailure } = await import('./token.service.js')

beforeEach(() => {
  transitions.length = 0
  updates.length = 0
  row = { id: 'conn-1', channelType: 'SHOPIFY', authStatus: 'connected', displayName: 'a-shop' }
})

describe('revoking an account', () => {
  it('goes through the state machine, which is what raises the alert', async () => {
    const outcome = await revokeChannelConnection('conn-1', 'uninstalled', 'shopify_app_uninstalled')
    expect(outcome.ok).toBe(true)
    // Not a column write. The state machine is where the compare-and-set, the
    // ConnectionEvent and the CONNECTION_HEALTH alert live.
    expect(transitions).toEqual([{ id: 'conn-1', next: 'revoked', reason: 'uninstalled' }])
  })

  it('also stands the account down, because the routing index keys on isActive', async () => {
    await revokeChannelConnection('conn-1', 'uninstalled', 'shopify_app_uninstalled')
    const stand = updates.find((u) => u.data?.isActive === false)
    expect(stand).toBeDefined()
    expect(stand.where).toEqual({ id: 'conn-1' })
    // `isActive` is not part of the state machine, and leaving it true would keep a
    // revoked account in the inbound routing index after its grant is gone.
    expect(stand.data.lastError).toContain('uninstalled')
  })

  it('writes the stand-down AFTER the transition, never before', async () => {
    // Reversed, a failed transition would leave an account inactive while still
    // reading as connected — invisible to the operator and dead to the channel.
    const order: string[] = []
    transitions.push = ((...args: any[]) => { order.push('transition'); return Array.prototype.push.apply(transitions, args) }) as any
    updates.push = ((...args: any[]) => { order.push('update'); return Array.prototype.push.apply(updates, args) }) as any
    await revokeChannelConnection('conn-1', 'uninstalled', 'shopify_app_uninstalled')
    expect(order).toEqual(['transition', 'update'])
  })

  it('does nothing to an account that is already terminal', async () => {
    row = { ...row, authStatus: 'revoked' }
    const outcome = await revokeChannelConnection('conn-1', 'again', 'ebay_authorization_revocation')
    expect(outcome.skipped).toBe('already_terminal')
    expect(transitions).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })

  it('refuses loudly when the revocation names an account we do not have', async () => {
    row = null
    const outcome = await revokeChannelConnection('conn-missing', 'revoked', 'ebay_authorization_revocation')
    expect(outcome.ok).toBe(false)
    expect(outcome.skipped).toBe('not_found')
    // A revocation naming an unknown account is either a routing defect or another
    // application's notification, and both are worth seeing.
    expect(transitions).toHaveLength(0)
  })
})

describe('the signals that already reached the state machine', () => {
  it('maps a dead grant to needs_reauth, which the gateway already holds', () => {
    // Amazon's invalid_grant and Etsy's refresh 401 both classify as auth_revoked.
    // This is the rule that carries them, and it is asserted here so the other half of
    // P2.6 is pinned rather than assumed from a reading of the code.
    expect(statusAfterConnectionFailure('connected', 'auth_revoked', 1)).toBe('needs_reauth')
    expect(statusAfterConnectionFailure('connected', 'auth_expired', 1)).toBe('needs_reauth')
    // And a terminal state is never walked back by a failure.
    expect(statusAfterConnectionFailure('revoked', 'auth_revoked', 9)).toBe('revoked')
    expect(statusAfterConnectionFailure('disconnected', 'transient', 9)).toBe('disconnected')
  })
})
