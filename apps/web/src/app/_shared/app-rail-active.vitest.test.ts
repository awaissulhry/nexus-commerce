import { describe, expect, it } from 'vitest'
import { resolveActiveNav, hrefMatchesPath, type ActiveNavNode } from './app-rail-active'

/**
 * The real shape from app-nav.ts: a three-level group where EVERY group's href
 * equals its own first child's href. That is deliberate ("clicking Build lands
 * on Workers") and it is exactly what broke prefix-based highlighting.
 */
const FLEET: ActiveNavNode[] = [
  {
    href: '/fleet',
    children: [
      {
        href: '/fleet',
        children: [
          { href: '/fleet' },
          { href: '/fleet/approvals' },
          { href: '/fleet/activity' },
          { href: '/fleet/map' },
        ],
      },
      {
        href: '/fleet/workers',
        children: [
          { href: '/fleet/workers' },
          { href: '/fleet/workflows' },
          { href: '/fleet/assignments' },
          { href: '/fleet/files' },
        ],
      },
      {
        href: '/fleet/cost',
        children: [{ href: '/fleet/cost' }, { href: '/fleet/controls' }],
      },
    ],
  },
  { href: '/inbox' },
  { href: '/marketing/ads', children: [{ href: '/marketing/ads/rules-automation' }] },
  { href: '/docs', external: true },
]

describe('resolveActiveNav', () => {
  it('picks the deepest row when a group points at its own first child', () => {
    // /fleet matches three rows at equal length: the top item, "Operate", and
    // "Overview". Only the leaf may be highlighted.
    expect(resolveActiveNav(FLEET, '/fleet')).toEqual({ href: '/fleet', depth: 3 })
  })

  it('never lets a shorter ancestor beat a longer match — the /fleet/workers regression', () => {
    // Before the fix this lit up "Operate" (/fleet), "Overview" (/fleet) AND
    // "Workers" — three rows for one page.
    expect(resolveActiveNav(FLEET, '/fleet/workers')).toEqual({ href: '/fleet/workers', depth: 3 })
  })

  it('resolves every fleet page to exactly one row, and never to a sibling group', () => {
    const cases: Array<[string, string]> = [
      ['/fleet/approvals', '/fleet/approvals'],
      ['/fleet/activity', '/fleet/activity'],
      ['/fleet/map', '/fleet/map'],
      ['/fleet/workflows', '/fleet/workflows'],
      ['/fleet/assignments', '/fleet/assignments'],
      ['/fleet/files', '/fleet/files'],
      ['/fleet/cost', '/fleet/cost'],
      ['/fleet/controls', '/fleet/controls'],
    ]
    for (const [path, href] of cases) {
      expect(resolveActiveNav(FLEET, path), path).toEqual({ href, depth: 3 })
    }
  })

  it('keeps a detail route on its list row', () => {
    expect(resolveActiveNav(FLEET, '/fleet/assignments/abc123'))
      .toEqual({ href: '/fleet/assignments', depth: 3 })
  })

  it('prefers a two-level child over its top-level parent', () => {
    expect(resolveActiveNav(FLEET, '/marketing/ads/rules-automation'))
      .toEqual({ href: '/marketing/ads/rules-automation', depth: 2 })
  })

  it('matches a plain top-level item', () => {
    expect(resolveActiveNav(FLEET, '/inbox')).toEqual({ href: '/inbox', depth: 1 })
  })

  it('highlights nothing for a page with no rail entry', () => {
    expect(resolveActiveNav(FLEET, '/settings/profile')).toBeNull()
  })

  it('never highlights an external link', () => {
    expect(resolveActiveNav(FLEET, '/docs')).toBeNull()
  })
})

describe('hrefMatchesPath', () => {
  it('requires a segment boundary, so /fleet does not claim /fleets', () => {
    expect(hrefMatchesPath('/fleet', '/fleets')).toBe(false)
    expect(hrefMatchesPath('/fleet', '/fleet-map')).toBe(false)
    // The live pair this protects: /marketing/ads must not claim /marketing/ads-console.
    expect(hrefMatchesPath('/marketing/ads', '/marketing/ads-console/automation')).toBe(false)
    expect(hrefMatchesPath('/marketing/ads', '/marketing/ads/campaigns')).toBe(true)
  })
})
