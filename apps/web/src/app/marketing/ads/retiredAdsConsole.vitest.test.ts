import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPORT_CATALOGUE } from './reporting/catalogue'

/**
 * OC (2026-10-06) — the old ads console (/marketing/ads-console) is deleted, Rank Control included. Every page is a
 * config redirect to the Ad Manager page that does the same job, so bookmarks and old links still land on a working
 * page; inside a business the redirect keeps the business. Rank Control lands on the Control Room, where the
 * Rank-defend engine is switched (Hourly Bids stays exactly as it was); the rank-defend alert links there too.
 */
const WEB_ROOT = join(__dirname, '..', '..', '..', '..')
const APP = join(WEB_ROOT, 'src', 'app')
const REPO = join(WEB_ROOT, '..', '..')
const PLANS = '/marketing/ads/rules-automation/control-room'

interface NextRedirect { source: string; destination: string; permanent?: boolean; has?: unknown[] }
const loadRedirects = async (): Promise<NextRedirect[]> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(join(WEB_ROOT, 'next.config.js')) as { redirects: () => Promise<NextRedirect[]> }
  return cfg.redirects()
}

/** The page.tsx a path renders, following a `[param]` folder where no literal one exists (null = no page). */
function pageFor(path: string): string | null {
  let dir = APP
  for (const seg of path.split(/[?#]/)[0]!.split('/').filter(Boolean)) {
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
  ['/marketing/ads-console/rank', PLANS],
]

describe('the deleted old ads console', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('is gone: no page is left under /marketing/ads-console', () => {
    expect(existsSync(join(APP, 'marketing', 'ads-console'))).toBe(false)
  })

  it.each(RETIRED)('%s goes to %s, also inside a business', async (source, destination) => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    const plain = redirects.find((r) => r.source === source && !r.has)
    expect(plain?.destination).toBe(destination)
    expect(plain?.permanent).toBe(true)
    expect(redirects.find((r) => r.source === `/w/:workspaceId${source}` && !r.has)?.destination).toBe(`/w/:workspaceId${destination}`)
    expect(pageFor(destination)).not.toBeNull()
  })

  it('sends the reporting redirects to reports the Reporting page knows', () => {
    const ids = new Set(REPORT_CATALOGUE.map((r) => r.id))
    for (const [, destination] of RETIRED) {
      const id = destination.match(/^\/marketing\/ads\/reporting\/([^/?#]+)$/)?.[1]
      if (id) expect(ids.has(id)).toBe(true)
    }
  })

  it("lands the old hub's ?tab=rank link where Rank Control lands, ahead of the plain Automation rule", async () => {
    const redirects = await loadRedirects()
    const rank = redirects.findIndex((r) => r.source === '/marketing/ads-console/automation' && r.has)
    const plain = redirects.findIndex((r) => r.source === '/marketing/ads-console/automation' && !r.has)
    expect(redirects[rank]?.destination).toBe(PLANS)
    expect(redirects[rank]?.has).toEqual([{ type: 'query', key: 'tab', value: 'rank' }])
    expect(rank).toBeLessThan(plain)
  })

  it("opens a stored alert's /rank?mode=plan unfiltered: the destination's empty mode wins over the request's", async () => {
    const redirects = await loadRedirects()
    const withMode = redirects.findIndex((r) => r.source === '/marketing/ads-console/rank' && r.has)
    const plain = redirects.findIndex((r) => r.source === '/marketing/ads-console/rank' && !r.has)
    expect(redirects[withMode]?.has).toEqual([{ type: 'query', key: 'mode' }])
    expect(redirects[withMode]?.destination).toBe('/marketing/ads/rules-automation/control-room?mode=')
    expect(withMode).toBeLessThan(plain)
  })

  it('the rank-defend alert links to the Control Room, where the Rank-defend engine is switched', () => {
    const job = readFileSync(join(REPO, 'apps/api/src/jobs/ad-rank-defend.job.ts'), 'utf8')
    expect(job).not.toContain('ads-console')
    expect(job).toContain(`href: '${PLANS}'`)
    expect(pageFor(PLANS)).not.toBeNull()
  })
})
