/**
 * The web's AppRail is the design system's rail with this app's router: the workspace `Link` (it keeps the `/w/<id>`
 * prefix) and the workspace-free pathname. Rendered in Node with the app's real nav; both router pieces are stand-ins
 * that say they were used.
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({ pathname: '/fleet/workers' as string | null }))

vi.mock('@/lib/workspaces/navigation', () => ({ usePathname: () => router.pathname }))
vi.mock('@/lib/workspaces/Link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
    createElement('a', { ...rest, href: `/w/acme${href}`, 'data-workspace-link': '' }, children),
}))

const { AppRail } = await import('./AppRail')
const { buildAppNav } = await import('./app-nav')

const nav = buildAppNav({}, { amazon: true, ebay: true })
const render = () => renderToStaticMarkup(createElement(AppRail, { navItems: nav }))
const lit = (html: string) => [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)].map((m) => m[0])

describe('AppRail (web) — the design system rail with the workspace router', () => {
  it('draws its in-app links with the workspace Link', () => {
    router.pathname = '/products'
    const html = render()
    const links = html.match(/<a [^>]*>/g) ?? []
    const internal = links.filter((a) => !a.includes('target="_blank"'))
    expect(internal.length).toBeGreaterThan(5)
    for (const a of internal) expect(a).toContain('data-workspace-link=""')
    expect(html).toContain('href="/w/acme/products"')
  })

  it('matches the rows against the workspace-free pathname: one current row', () => {
    router.pathname = '/products'
    expect(lit(render())).toHaveLength(1)
    expect(lit(render())[0]).toContain('href="/w/acme/products"')
    router.pathname = '/no-such-page'
    expect(lit(render())).toEqual([])
  })

  it('no pathname yet (null) lights nothing', () => {
    router.pathname = null
    expect(lit(render())).toEqual([])
  })
})
