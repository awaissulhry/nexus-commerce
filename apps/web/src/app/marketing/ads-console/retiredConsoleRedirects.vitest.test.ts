import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPORT_CATALOGUE } from '../ads/reporting/catalogue'

/**
 * OC (2026-10-06) — the old ads console is retired, except Rank Control. Every other page is a config redirect to the
 * Ad Manager page that does the same job, so bookmarks and old links still land on a working page; inside a business
 * the redirect keeps the business. Rank Control stays where it is: product rank plans are made and switched only
 * there for now, and the rank-defend alert links to it.
 */
const WEB_ROOT = join(__dirname, '..', '..', '..', '..')
const APP = join(WEB_ROOT, 'src', 'app')
const REPO = join(WEB_ROOT, '..', '..')

interface NextRedirect { source: string; destination: string; permanent?: boolean; has?: unknown[] }
const loadRedirects = async (): Promise<NextRedirect[]> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(join(WEB_ROOT, 'next.config.js')) as { redirects: () => Promise<NextRedirect[]> }
  return cfg.redirects()
}

/** The page.tsx a path renders, following a `[param]` folder where no literal one exists (null = no page). */
function pageFor(path: string): string | null {
  let dir = APP
  for (const seg of path.split('?')[0]!.split('/').filter(Boolean)) {
    if (existsSync(join(dir, seg))) { dir = join(dir, seg); continue }
    const dynamic = existsSync(dir) ? readdirSync(dir).find((n) => /^\[[^.\]]+\]$/.test(n)) : undefined
    if (!dynamic) return null
    dir = join(dir, dynamic)
  }
  const page = join(dir, 'page.tsx')
  return existsSync(page) ? page : null
}

const RETIRED: Array<[string, string]> = [
  ['/marketing/ads-console', '/marketing/ads/dashboard'],
  ['/marketing/ads-console/overview', '/marketing/ads/dashboard'],
  ['/marketing/ads-console/campaigns', '/marketing/ads/campaigns'],
  ['/marketing/ads-console/products', '/marketing/ads/reporting/advertised-product'],
  ['/marketing/ads-console/targeting', '/marketing/ads/reporting/targeting'],
  ['/marketing/ads-console/activity', '/marketing/ads/rules-automation/control-room?tab=activity'],
  ['/marketing/ads-console/bulk', '/marketing/ads/bulk'],
  ['/marketing/ads-console/automation', '/marketing/ads/rules-automation/automations'],
  ['/marketing/ads-console/campaign-builder/guided', '/marketing/ads/campaign-builder/guided'],
  ['/marketing/ads-console/settings', '/settings/advertising'],
]

describe('the retired old ads console', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it.each(RETIRED)('%s goes to %s, also inside a business', async (source, destination) => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    const plain = redirects.find((r) => r.source === source && !r.has)
    expect(plain?.destination).toBe(destination)
    expect(plain?.permanent).toBe(true)
    expect(redirects.find((r) => r.source === `/w/:workspaceId${source}` && !r.has)?.destination).toBe(`/w/:workspaceId${destination}`)
    // The old page is gone (a page would never be reached), and the destination is a real page.
    expect(existsSync(join(APP, ...source.split('/').filter(Boolean), 'page.tsx'))).toBe(false)
    expect(pageFor(destination)).not.toBeNull()
  })

  it('sends the reporting redirects to reports the Reporting page knows', () => {
    const ids = new Set(REPORT_CATALOGUE.map((r) => r.id))
    for (const [, destination] of RETIRED) {
      const id = destination.match(/^\/marketing\/ads\/reporting\/([^/?]+)$/)?.[1]
      if (id) expect(ids.has(id)).toBe(true)
    }
  })

  it("keeps the old hub's ?tab=rank link on Rank Control, ahead of the plain Automation rule", async () => {
    const redirects = await loadRedirects()
    const rank = redirects.findIndex((r) => r.source === '/marketing/ads-console/automation' && r.has)
    const plain = redirects.findIndex((r) => r.source === '/marketing/ads-console/automation' && !r.has)
    expect(rank).toBeGreaterThanOrEqual(0)
    expect(redirects[rank]!.destination).toBe('/marketing/ads-console/rank')
    expect(redirects[rank]!.has).toEqual([{ type: 'query', key: 'tab', value: 'rank' }])
    expect(rank).toBeLessThan(plain)
  })

  it('keeps Rank Control at its address: a page, and no redirect that could take it', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    expect(pageFor('/marketing/ads-console/rank')).not.toBeNull()
    const redirects = await loadRedirects()
    const takesRank = redirects.filter((r) => /ads-console/.test(r.source) && (/\/rank/.test(r.source) || /[:*(]/.test(r.source.replace('/w/:workspaceId', ''))))
    expect(takesRank).toEqual([])
  })

  it('the rank-defend alert still links to a page that exists', () => {
    const job = readFileSync(join(REPO, 'apps/api/src/jobs/ad-rank-defend.job.ts'), 'utf8')
    const hrefs = [...job.matchAll(/href: '([^']+)'/g)].map((m) => m[1]!).filter((h) => h.includes('ads-console'))
    expect(hrefs).toEqual(['/marketing/ads-console/rank?mode=plan'])
    for (const h of hrefs) expect(pageFor(h)).not.toBeNull()
  })

  it("the console's own menu links only to pages that still exist", () => {
    const chrome = readFileSync(join(__dirname, '_shared', 'ConsoleChrome.tsx'), 'utf8')
    const base = chrome.match(/const BASE = '([^']+)'/)?.[1]
    expect(base).toBe('/marketing/ads-console')
    const hrefs = [...chrome.matchAll(/href: (?:'([^']+)'|`\$\{BASE\}([^`]*)`)/g)].map((m) => m[1] ?? `${base}${m[2]}`)
    expect(hrefs.length).toBe(6)
    for (const h of hrefs) expect(pageFor(h), h).not.toBeNull()
  })
})
