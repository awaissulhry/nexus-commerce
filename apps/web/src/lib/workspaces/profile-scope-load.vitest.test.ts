import { describe, expect, it, vi } from 'vitest'
import type { BusinessProfile } from '@/app/_shared/ProfileScope'
import { loadProfileScope } from './profile-scope-load'

const profile = (id: string): BusinessProfile => ({ id, name: `Business ${id}`, version: 1, status: 'active', membershipId: `member-${id}`, roleNames: ['Owner'], isOwner: true, canConnectAccounts: true })

describe('profile scope loading', () => {
  it('uses the current profile from the fresh first page without another read', async () => {
    const current = profile('current')
    const page = vi.fn(async () => ({ workspaces: [current], nextCursor: 'next-page' }))
    const detail = vi.fn(async () => profile('unexpected'))
    expect(await loadProfileScope('current', { page, detail })).toEqual({ profiles: [current], selected: current, hasMore: true, error: null })
    expect(page).toHaveBeenCalledOnce()
    expect(detail).not.toHaveBeenCalled()
  })

  it('still verifies a current profile outside the first page', async () => {
    const current = profile('current'), other = profile('other')
    const detail = vi.fn(async () => current)
    expect(await loadProfileScope('current', { page: async () => ({ workspaces: [other], nextCursor: 'next-page' }), detail }))
      .toEqual({ profiles: [other], selected: current, hasMore: true, error: null })
    expect(detail).toHaveBeenCalledExactlyOnceWith('current')
  })

  it('keeps an independently verified current profile when the list fails, and reports that failure', async () => {
    const current = profile('current'), detail = vi.fn(async () => current)
    expect(await loadProfileScope('current', { page: async () => { throw new Error('Profile list unavailable') }, detail }))
      .toEqual({ profiles: [], selected: current, hasMore: false, error: 'Profile list unavailable' })
    expect(detail).toHaveBeenCalledExactlyOnceWith('current')
  })

  it('keeps a detail failure visible and does not substitute another profile', async () => {
    const other = profile('other')
    expect(await loadProfileScope('current', { page: async () => ({ workspaces: [other], nextCursor: null }), detail: async () => { throw new Error('Current profile unavailable') } }))
      .toEqual({ profiles: [other], selected: null, hasMore: false, error: 'Current profile unavailable' })
  })

  it('rejects a detail reply for another business', async () => {
    const result = await loadProfileScope('current', { page: async () => ({ workspaces: [], nextCursor: null }), detail: async () => profile('wrong') })
    expect(result.selected).toBeNull()
    expect(result.error).toBe('The selected profile could not be verified.')
  })

  it('does not request a detail record when no business is selected', async () => {
    const detail = vi.fn()
    expect(await loadProfileScope(null, { page: async () => ({ workspaces: [], nextCursor: null }), detail }))
      .toEqual({ profiles: [], selected: null, hasMore: false, error: null })
    expect(detail).not.toHaveBeenCalled()
  })
})
