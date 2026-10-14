import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { STUDIO_TABS } from './[id]/edit/_studio/types'

/**
 * The old editors and catalog grids are deleted (2026-10-14): the old variant matrix (/products/[id]/matrix), the old
 * catalog editor (/catalog/[id]/edit) and the two whole-catalog grids (/catalog/matrix, /command-matrix). Each is a
 * config redirect, so bookmarks still land on a working page, and inside a business the redirect keeps the business:
 * the variant matrix opens that product's Matrix tab, the catalog editor opens that product, the grids open Products.
 */
const WEB_ROOT = join(__dirname, '..', '..', '..')
const SRC = join(WEB_ROOT, 'src')
const APP = join(SRC, 'app')

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
    if (!seg.startsWith(':') && existsSync(join(dir, seg))) { dir = join(dir, seg); continue }
    const dynamic = existsSync(dir) ? readdirSync(dir).find((n) => /^\[[^.\]]+\]$/.test(n)) : undefined
    if (!dynamic) return null
    dir = join(dir, dynamic)
  }
  const page = join(dir, 'page.tsx')
  return existsSync(page) ? page : null
}

const RETIRED: Array<[source: string, folder: string, destination: string]> = [
  ['/products/:id/matrix', 'products/[id]/matrix', '/products/:id/edit/studio?tab=matrix'],
  ['/catalog/:id/edit', 'catalog/[id]/edit', '/products/:id/edit/studio'],
  ['/catalog/matrix', 'catalog/matrix', '/products'],
  ['/command-matrix', 'command-matrix', '/products'],
]

describe('the retired old editors and catalog grids', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it.each(RETIRED)('%s is gone and goes to its replacement, also inside a business', async (source, folder, destination) => {
    expect(existsSync(join(APP, ...folder.split('/')))).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    const plain = redirects.find((r) => r.source === source && !r.has)
    expect(plain?.destination).toBe(destination)
    expect(plain?.permanent).toBe(true)
    expect(redirects.find((r) => r.source === `/w/:workspaceId${source}` && !r.has)?.destination).toBe(`/w/:workspaceId${destination}`)
    expect(pageFor(destination)).not.toBeNull()
  })

  it("the old variant matrix lands on a tab the product page has: its Matrix", () => {
    expect(STUDIO_TABS).toContain('matrix')
  })

  it('no link in the app points at a retired page', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
    })
    const retired = [/['"`]\/catalog\/matrix\b/, /['"`]\/command-matrix\b/, /\/products\/\$\{[^}]+\}\/matrix\b/, /\/catalog\/\$\{[^}]+\}\/edit\b/]
    const offenders = files(SRC).filter((path) => !path.endsWith('retiredEditors.vitest.test.ts')).flatMap((path) =>
      readFileSync(path, 'utf8').split('\n').flatMap((line, i) => retired.some((re) => re.test(line)) ? [`${relative(SRC, path)}:${i + 1}`] : []))
    expect(offenders).toEqual([])
  })
})
