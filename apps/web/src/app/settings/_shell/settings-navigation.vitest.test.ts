import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let buildSettingsNavigation: typeof import('./settings-navigation').buildSettingsNavigation
beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
  vi.resetModules()
  ;({ buildSettingsNavigation } = await import('./settings-navigation'))
})
afterAll(() => vi.unstubAllEnvs())

describe('settings navigation', () => {
  it('provides unique, whitespace-free IDs for disclosure labels and controls', () => {
    const ids = buildSettingsNavigation('/settings').map(group => group.id)
    expect(ids.every(id => /^[a-z0-9-]+$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps native business links scoped while identity settings remain shared', () => {
    const items = buildSettingsNavigation('/w/business_a/settings/channels/ebay').flatMap(group => group.items)
    expect(items.find(item => item.label === 'Channels')).toMatchObject({
      href: '/w/business_a/settings/channels', active: true,
    })
    expect(items.find(item => item.label === 'Business')).toMatchObject({ href: '/w/business_a/settings/account' })
    for (const href of ['/settings/profile', '/settings/profiles', '/settings/security', '/settings/notifications']) {
      expect(items.find(item => item.id === href)?.href).toBe(href)
    }
    expect(items.filter(item => item.active)).toHaveLength(1)
  })

  it('filters permissions before scoping URLs and drops empty groups', () => {
    const groups = buildSettingsNavigation('/w/business_a/settings/channels', permission => permission === 'pim.manage')
    expect(groups.flatMap(group => group.items).map(item => item.id)).toEqual([
      '/settings/profile', '/settings/notifications', '/settings/profiles',
      '/settings/pim/families', '/settings/pim/attributes', '/settings/pim/workflows', '/settings/security',
    ])
    expect(groups.some(group => group.label === 'Integrations' || group.label === 'Developer')).toBe(false)
    expect(groups.every(group => group.items.length > 0)).toBe(true)
  })

  it('keeps nested family pages selected without matching similarly named routes', () => {
    const active = (path: string) => buildSettingsNavigation(path).flatMap(group => group.items).filter(item => item.active).map(item => item.id)
    expect(active('/w/business_b/settings/pim/families/family-id')).toEqual(['/settings/pim/families'])
    expect(active('/settings/profiles')).toEqual(['/settings/profiles'])
    expect(active('/settings/profile')).toEqual(['/settings/profile'])
    expect(active('/settings/channels-archive')).toEqual([])
    expect(active('/settings')).toEqual([])
  })

  it('uses the current URL profile and supports unscoped settings', () => {
    const channelsHref = (path: string) => buildSettingsNavigation(path).flatMap(group => group.items).find(item => item.label === 'Channels')?.href
    expect(channelsHref('/w/business_a/settings')).toBe('/w/business_a/settings/channels')
    expect(channelsHref('/w/business_b/settings')).toBe('/w/business_b/settings/channels')
    expect(channelsHref('/settings')).toBe('/settings/channels')
  })
})
