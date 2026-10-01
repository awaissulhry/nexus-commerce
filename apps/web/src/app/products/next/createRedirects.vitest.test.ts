import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The retired create and upload pages (2026-10-01) are config redirects, so their bookmarks and every old link still
 * land somewhere that works: creating opens the Products page's New product dialog (`?new=1`), uploading opens
 * "Import & export". Inside a business the redirect keeps the business.
 */
const WEB_ROOT = join(__dirname, '..', '..', '..', '..')
const APP = join(WEB_ROOT, 'src', 'app')

interface NextRedirect { source: string; destination: string; permanent?: boolean }
const loadRedirects = async (): Promise<NextRedirect[]> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(join(WEB_ROOT, 'next.config.js')) as { redirects: () => Promise<NextRedirect[]> }
  return cfg.redirects()
}

describe('retired create and upload pages', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it.each([
    ['/products/new', '/products?new=1'],
    ['/catalog/add', '/products?new=1'],
    ['/products/upload', '/products/catalog-transfer'],
  ])('%s goes to %s, also inside a business', async (source, destination) => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    expect(redirects.find((r) => r.source === source)?.destination).toBe(destination)
    expect(redirects.find((r) => r.source === `/w/:workspaceId${source}`)?.destination).toBe(`/w/:workspaceId${destination}`)
    // The page is gone (a page would never be reached), and the destination is a real page.
    expect(existsSync(join(APP, ...source.split('/').filter(Boolean), 'page.tsx'))).toBe(false)
    expect(existsSync(join(APP, ...destination.split('?')[0]!.split('/').filter(Boolean), 'page.tsx'))).toBe(true)
  })
})
