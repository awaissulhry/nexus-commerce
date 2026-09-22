import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ tokens: {} as Record<string, string | null> }))
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => p === 'channelConnection' ? {
  findMany: async ({ select }: { select: Record<string, boolean> }) => [{
    id: 'account', channelType: 'EBAY', accountLabel: 'seller', isActive: true, isPrimary: true,
    authStatus: 'connected', externalAccountId: 'seller', lastSyncAt: null,
    ...Object.fromEntries(Object.entries(m.tokens).filter(([field]) => select[field])),
  }],
} : { count: async () => 0 } }) }))
const { connectionDependentsReport } = await import('./connection-dependents.service.js')
beforeEach(() => { m.tokens = { refreshToken: null, ebayRefreshToken: null } })

describe('refresh-token presence in the connection report', () => {
  it.each(['refreshToken', 'ebayRefreshToken'])('reports a token stored in %s without exposing it', async column => {
    m.tokens[column] = 'private-fixture-token'
    const rows = await connectionDependentsReport({ channel: 'EBAY' })
    expect(rows[0].hasRefreshToken).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('private-fixture-token')
    expect(rows[0]).not.toHaveProperty('refreshToken')
    expect(rows[0]).not.toHaveProperty('ebayRefreshToken')
  })
  it('positive control for absence: both columns empty means no refresh token', async () => {
    m.tokens.refreshToken = ''; m.tokens.ebayRefreshToken = ''
    expect((await connectionDependentsReport())[0].hasRefreshToken).toBe(false)
  })
})
