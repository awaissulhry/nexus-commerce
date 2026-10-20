/**
 * AM-29 — the ads rail's "Settings" opens the real advertising settings (/settings/advertising: connections and their
 * read/write state). It opened a "This page is not built yet." stub; that route now redirects there too.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ADS_NAV, EBAY_ADS_NAV, GOOGLE_ADS_NAV, META_ADS_NAV, adChannelOf, navFor, switchTarget } from './nav'

describe('the rail’s Settings row', () => {
  it('goes to /settings/advertising', () => {
    const row = ADS_NAV.find((n) => n.label === 'Settings')
    expect(row?.href).toBe('/settings/advertising')
  })

  it('the old route redirects there instead of showing a stub', () => {
    const page = readFileSync(fileURLToPath(new URL('../account-settings/page.tsx', import.meta.url)), 'utf8')
    expect(page).toContain("redirect('/settings/advertising')")
    expect(page).not.toContain('<p>This page is not built yet.</p>')
  })
})

describe('the Google channel (Google Ads step 1a)', () => {
  it('has a read-only rail: its Ad Manager and the place its accounts are chosen', () => {
    expect(GOOGLE_ADS_NAV.map((n) => [n.label, n.route, n.href ?? null])).toEqual([
      ['Ad Manager', 'google', null],
      ['Settings', 'google-settings', '/settings/channels/google'],
    ])
  })

  it('knows which console a path is in', () => {
    expect(adChannelOf('/marketing/ads/google')).toBe('google')
    expect(adChannelOf('/marketing/ads/ebay/campaigns')).toBe('ebay')
    expect(adChannelOf('/marketing/ads/campaigns')).toBe('amazon')
    expect(adChannelOf('/marketing/ads/googlefoo')).toBe('amazon')
    expect(navFor('google')).toBe(GOOGLE_ADS_NAV)
    expect(navFor('ebay')).toBe(EBAY_ADS_NAV)
    expect(navFor('amazon')).toBe(ADS_NAV)
  })

  it('switching keeps the equivalent page: Ad Manager ↔ Google, dashboard → Google', () => {
    expect(switchTarget('/marketing/ads/campaigns', 'google')).toBe('google')
    expect(switchTarget('/marketing/ads/dashboard', 'google')).toBe('google')
    expect(switchTarget('/marketing/ads/ebay/campaigns', 'google')).toBe('google')
    expect(switchTarget('/marketing/ads/google', 'amazon')).toBe('campaigns')
    expect(switchTarget('/marketing/ads/google', 'ebay')).toBe('ebay/campaigns')
    expect(switchTarget('/marketing/ads/google', 'google')).toBeNull()
  })

  it('leaves the Amazon ⇄ eBay counterparts as they were', () => {
    expect(switchTarget('/marketing/ads/campaigns', 'ebay')).toBe('ebay/campaigns')
    expect(switchTarget('/marketing/ads/changelog', 'ebay')).toBe('ebay/change-log')
    expect(switchTarget('/marketing/ads/portfolios', 'ebay')).toBe('ebay')
    expect(switchTarget('/marketing/ads/ebay/products', 'amazon')).toBe('campaigns')
    expect(switchTarget('/marketing/ads/ebay/automation', 'amazon')).toBe('dashboard')
    expect(switchTarget('/marketing/ads/ebay', 'ebay')).toBeNull()
  })

  it('the switch draws Google as an SVG tile, never an emoji', () => {
    const marks = readFileSync(fileURLToPath(new URL('./BrandMarks.tsx', import.meta.url)), 'utf8')
    expect(marks).toMatch(/export function GoogleBadge[\s\S]*<svg/)
    const sidebar = readFileSync(fileURLToPath(new URL('./AdsSidebar.tsx', import.meta.url)), 'utf8')
    expect(sidebar).toContain("{ id: 'google', label: 'Google', Badge: GoogleBadge }")
    expect(sidebar + marks).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})

describe('the Meta channel (Meta ads step 2)', () => {
  it('has a read-only rail: its Ad Manager and the place its connection and ad account are set', () => {
    expect(META_ADS_NAV.map((n) => [n.label, n.route, n.href ?? null])).toEqual([
      ['Ad Manager', 'meta', null],
      ['Settings', 'meta-settings', '/settings/channels/meta'],
    ])
    expect(navFor('meta')).toBe(META_ADS_NAV)
  })

  it('knows its console, and "metadata"-like paths are not Meta', () => {
    expect(adChannelOf('/marketing/ads/meta')).toBe('meta')
    expect(adChannelOf('/marketing/ads/metadata')).toBe('amazon')
    expect(adChannelOf('/marketing/ads/google')).toBe('google')
  })

  it('switching: every page goes to Meta\'s one page; from Meta to the other channel\'s Ad Manager', () => {
    expect(switchTarget('/marketing/ads/campaigns', 'meta')).toBe('meta')
    expect(switchTarget('/marketing/ads/google', 'meta')).toBe('meta')
    expect(switchTarget('/marketing/ads/meta', 'amazon')).toBe('campaigns')
    expect(switchTarget('/marketing/ads/meta', 'ebay')).toBe('ebay/campaigns')
    expect(switchTarget('/marketing/ads/meta', 'google')).toBe('google')
    expect(switchTarget('/marketing/ads/meta', 'meta')).toBeNull()
  })

  it('the switch draws Meta as an SVG tile, never an emoji', () => {
    const marks = readFileSync(fileURLToPath(new URL('./BrandMarks.tsx', import.meta.url)), 'utf8')
    expect(marks).toMatch(/export function MetaBadge[\s\S]*<svg/)
    const sidebar = readFileSync(fileURLToPath(new URL('./AdsSidebar.tsx', import.meta.url)), 'utf8')
    expect(sidebar).toContain("{ id: 'meta', label: 'Meta', Badge: MetaBadge }")
    expect(sidebar + marks).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})
