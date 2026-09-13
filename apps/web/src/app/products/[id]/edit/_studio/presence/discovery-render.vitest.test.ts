import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StudioClient } from '../StudioClient'
import { connectionHealth, connectionScopePolicy, DISCOVERY_FAILURE } from './connection'
import type { StudioProduct } from '../types'
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
describe('held discovery and binned render contract', () => {
  it('revoked is held with the exact reconnect sentence; expired remains editable', () => {
    const revoked = connectionHealth({ isActive: false, authStatus: 'revoked' }, Date.now())
    expect(connectionScopePolicy(revoked, 'Amazon', false)).toMatchObject({ disabled: true, disabledReason: 'The Amazon account is disconnected. Reconnect it in Settings → Channels to work on this listing.' })
    const expired = connectionHealth({ isActive: true, authStatus: 'expired' }, Date.now())
    expect(connectionScopePolicy(expired, 'eBay', false)).toMatchObject({ disabled: false, needsReconnect: true })
  })
  it('discovery failure has its own held reason regardless of a stale healthy account', () => {
    expect(connectionScopePolicy(null, 'Amazon', true)).toMatchObject({ disabled: true, disabledReason: DISCOVERY_FAILURE })
    expect(DISCOVERY_FAILURE).toBe('Channel availability could not be read. This does not mean the product has no listings.')
  })
  it('a binned Active product opens the placeholder with no editable studio frame', () => {
    const product = { id: 'p', sku: 'XAVIA', status: 'ACTIVE', deletedAt: '2026-09-13T12:00:00Z' } as StudioProduct
    const html = renderToStaticMarkup(createElement(StudioClient, { product, family: null, primaryLanguage: 'it', marketplaces: [], marketplacesFailed: false }))
    expect(html).toContain('This product is in the bin')
    expect(html).toContain('XAVIA')
    expect(html).not.toContain('Active')
    expect(html).not.toContain('data-studio-dock')
  })
})
