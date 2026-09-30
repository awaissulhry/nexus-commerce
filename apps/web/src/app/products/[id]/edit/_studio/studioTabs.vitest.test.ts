/**
 * P2 (2026-09-30, I4-7) — the studio loads a tab's code when the tab is opened.
 *
 * Measured before: `StudioTabHost` imported all twelve tabs statically, so the eBay sheet shipped the images workspace
 * (1.8 MB in dev), the Shopify editors, the variants page and the master sheet. One static import is enough to pull a tab
 * back into the frame's chunk, so the frame's two files are read for any.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { STUDIO_TABS } from './types'
import { isChunkLoadError, STUDIO_TAB_LOADERS, studioTabCache } from './studioTabs'

const here = __dirname
const TAB_MODULES = ['./sheet/ProductSheetTab', './matrix/MatrixTab', './variants/VariantsTab', './PresentationTab', './shopify/ShopifyLinkedRoute',
  './images', './sharing/SharingTab', './ancillary/AnalyticsAdsTab', './channel-ops/ErrorsSyncTab', './ancillary/ActivityTab']

/** `import … from '<path>'` at the top level — a dynamic `import('<path>')` is not one. */
const staticImports = (source: string) => [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('studio tabs', () => {
  it('the frame imports no tab statically', () => {
    for (const file of ['StudioTabHost.tsx', 'studioTabs.ts', 'StudioLoader.tsx']) {
      const imported = staticImports(readFileSync(join(here, file), 'utf8'))
      expect(imported.filter((path) => TAB_MODULES.includes(path)), file).toEqual([])
    }
  })

  it('every tab has a loader, and every loader names a tab module', () => {
    expect(Object.keys(STUDIO_TAB_LOADERS).sort()).toEqual([...STUDIO_TABS].sort())
    const loaders = readFileSync(join(here, 'studioTabs.ts'), 'utf8')
    const loaded = new Set([...loaders.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]))
    expect([...loaded].sort()).toEqual([...TAB_MODULES].sort())
  })
})

/**
 * Audit B04 — a tab whose code fails to load used to replace the whole studio with the app-wide error page, and its
 * "Try again" re-threw: `next/dynamic` keeps one `React.lazy` per component, and a lazy keeps its rejected import.
 */
describe('a tab that fails to load stays a tab (B04)', () => {
  it('knows a chunk that did not arrive from a tab that broke', () => {
    const chunk = new Error('Loading chunk 4711 failed.\n(error: https://nexus.example/_next/static/chunks/4711.js)')
    chunk.name = 'ChunkLoadError'
    expect(isChunkLoadError(chunk)).toBe(true)
    expect(isChunkLoadError(new Error('Loading CSS chunk images failed.'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://nexus.example/chunk.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'rows')"))).toBe(false)
    expect(isChunkLoadError('Loading chunk 1 failed')).toBe(false)
  })

  it('"Reload tab" makes the tab\'s component again, so its code is imported again', () => {
    const make = vi.fn((id: string) => ({ id, made: make.mock.calls.length }))
    const tabs = studioTabCache(make)
    const first = tabs.get('images')
    expect(tabs.get('images')).toBe(first)
    tabs.forget('images')
    expect(tabs.get('images')).not.toBe(first)
    expect(make).toHaveBeenCalledTimes(2)
    // Another tab is untouched.
    const sheet = tabs.get('sheet')
    tabs.forget('images')
    expect(tabs.get('sheet')).toBe(sheet)
  })

  it('the host renders every tab inside its own boundary, and the boundary retries with a new component', () => {
    const host = readFileSync(join(here, 'StudioTabHost.tsx'), 'utf8')
    expect(host).toMatch(/static getDerivedStateFromError\(/)
    expect(host).toMatch(/retry = \(\) => \{ TABS\.forget\(this\.props\.tab\); this\.setState\(\{ error: null \}\) \}/)
    expect(host).toMatch(/<StudioTabBoundary key=\{surfaceKey\} tab=\{shown\} surfaceKey=\{surfaceKey\} \/>/)
    expect(host).toMatch(/>Reload tab<\/Button>/)
    // No surface rendered outside it.
    expect(host.match(/<Surface /g)).toHaveLength(1)
  })
})
