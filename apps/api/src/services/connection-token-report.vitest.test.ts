import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ tokens: {} as Record<string, string | null>, state: {} as Record<string, unknown>, counts: {} as Record<string, number | Error> }))
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => p === 'channelConnection' ? {
  findMany: async ({ select }: { select: Record<string, boolean> }) => [{
    id: 'account', channelType: 'EBAY', accountLabel: 'seller', isActive: true, isPrimary: true,
    authStatus: 'connected', externalAccountId: 'seller', lastSyncAt: null, ...m.state,
    ...Object.fromEntries(Object.entries(m.tokens).filter(([field]) => select[field])),
  }],
} : { count: async () => {
  const count = m.counts[String(p)] ?? 0
  if (count instanceof Error) throw count
  return count
} } }) }))
const { connectionDependentsReport } = await import('./connection-dependents.service.js')
beforeEach(() => { m.tokens = { refreshToken: null, ebayRefreshToken: null }; m.state = { isActive: false, isPrimary: false, authStatus: 'disconnected' }; m.counts = {} })

describe('refresh-token presence in the connection report', () => {
  it.each(['refreshToken', 'ebayRefreshToken'])('reports a token stored in %s without exposing it', async column => {
    m.tokens[column] = 'private-fixture-token'
    const rows = await connectionDependentsReport({ channel: 'EBAY' })
    expect(rows[0].hasRefreshToken).toBe(true)
    expect(rows[0].safeToDelete).toBe(false)
    expect(JSON.stringify(rows)).not.toContain('private-fixture-token')
    expect(rows[0]).not.toHaveProperty('refreshToken')
    expect(rows[0]).not.toHaveProperty('ebayRefreshToken')
  })
  it('positive control for absence: both columns empty means no refresh token', async () => {
    m.tokens.refreshToken = ''; m.tokens.ebayRefreshToken = ''
    expect((await connectionDependentsReport())[0].hasRefreshToken).toBe(false)
  })
})

// 2026-09-22 production: live primary and one disconnected row hold encrypted credentials.
it('distinguishes encrypted storage from empty plaintext columns and refuses deletion', async () => {
  m.tokens.credentialsEnc = 'encrypted-private-fixture'
  const [row] = await connectionDependentsReport()
  expect(row.hasEncryptedCredentials).toBe(true)
  expect(row.hasRefreshToken).toBe(false)
  expect(row.safeToDelete).toBe(false)
  expect(JSON.stringify(row)).not.toContain('encrypted-private-fixture')
  expect(row).not.toHaveProperty('credentialsEnc')
})
it('positive control: a truly empty disconnected row is reported safe', async () => {
  const [row] = await connectionDependentsReport()
  expect(row.hasEncryptedCredentials).toBe(false)
  expect(row.safeToDelete).toBe(true)
})
it.each([{ isActive: true }, { isPrimary: true }, ...['connected', 'CONNECTED', 'degraded', 'DEGRADED'].map(authStatus => ({ authStatus }))])('the report never calls a live row safe: %j', async state => {
  Object.assign(m.state, state)
  expect((await connectionDependentsReport())[0].safeToDelete).toBe(false)
})
it.each(['accessToken', 'ebayAccessToken'])('refuses deletion with %s and never exposes it', async column => {
  m.tokens[column] = 'private-access-fixture'
  const [row] = await connectionDependentsReport()
  expect(row.safeToDelete).toBe(false)
  expect(row.hasRefreshToken).toBe(false)
  expect(JSON.stringify(row)).not.toContain('private-access-fixture')
  expect(row).not.toHaveProperty(column)
})
it.each([1, new Error('count unavailable')])('keeps dependent-count checking for an empty disconnected row: %s', async count => {
  m.counts.connectionScope = count
  expect((await connectionDependentsReport())[0].safeToDelete).toBe(false)
})
it('allows surviving SetNull history on an otherwise eligible row', async () => {
  m.counts.connectionEvent = 1
  expect((await connectionDependentsReport())[0]).toMatchObject({ safeToDelete: true, unlinkedTotal: 1 })
})
