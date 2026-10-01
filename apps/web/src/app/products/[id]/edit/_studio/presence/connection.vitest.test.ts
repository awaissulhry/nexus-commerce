import { describe, expect, it } from 'vitest'
import { connectionHealth, connectionScopePolicy } from './connection'
const now = Date.parse('2026-09-13T12:00:00Z')
const connected = { isActive: true, authStatus: 'connected', accessTokenExpiresAt: '2026-09-14T12:00:00Z' }
describe('connection evidence is tri-state', () => {
  it('recognises connected evidence and preserves its source', () => {
    expect(connectionHealth(connected, now)).toMatchObject({ state: 'connected', via: 'ChannelConnection', refusal: null })
  })
  it('retains a revoked account as disconnected evidence', () => {
    expect(connectionHealth({ ...connected, isActive: false, authStatus: 'revoked' }, now)).toMatchObject({ state: 'not-connected', refusal: 'Connection revoked. Stored listings remain visible.' })
  })
  it('an expired grant never reads healthy merely because isActive is true', () => {
    expect(connectionHealth({ ...connected, accessTokenExpiresAt: '2026-09-12T12:00:00Z' }, now)).toMatchObject({ state: 'not-connected', refusal: 'Connection grant expired. Stored listings remain visible.' })
  })
  it.each([{}, { isActive: true }, { ...connected, authStatus: 'degraded' }, { ...connected, accessTokenExpiresAt: 'bad date' }])('keeps missing or unreliable evidence unknown: %j', raw => {
    expect(connectionHealth(raw, now).state).toBe('unknown')
  })
})

// Audit P12 (2026-10-01) — the sheet footer says what each login state means, in plain words, or nothing.
describe('the studio footer note for an account', () => {
  const policy = (raw: Record<string, unknown>, account?: string) => connectionScopePolicy(connectionHealth(raw, now), 'eBay', false, account)
  it('needs re-authentication: reconnect THIS account, with a link to where', () => {
    expect(policy({ ...connected, authStatus: 'needs_reauth' }, 'Motovento eBay')).toMatchObject({ disabled: false, needsReconnect: true,
      note: 'Reconnect Motovento eBay in Settings → Channels.', link: { href: '/settings/channels', label: 'Settings → Channels' } })
    expect(policy({ ...connected, authStatus: 'needs_reauth' }).note).toBe('Reconnect the eBay account in Settings → Channels.')
  })
  it('degraded: Nexus retries the login itself; nothing to click', () => {
    expect(policy({ ...connected, authStatus: 'degraded' })).toMatchObject({ note: 'Nexus could not refresh this account\'s login; it retries on its own.', link: null, needsReconnect: false })
  })
  it('unknown or healthy: no message at all', () => {
    expect(policy({})).toMatchObject({ note: null, link: null })
    expect(policy({ isActive: true })).toMatchObject({ note: null, link: null })
    expect(policy(connected)).toMatchObject({ note: null, link: null })
  })
  it('a channel read that failed keeps its own sentence and no link', () => {
    expect(connectionScopePolicy(null, 'eBay', true)).toMatchObject({ note: 'Channel availability could not be read. This does not mean the product has no listings.', link: null })
  })
})
