/**
 * P2 (2026-09-30, I4-7) — the studio loads a tab's code when the tab is opened.
 *
 * Measured before: `StudioTabHost` imported all twelve tabs statically, so the eBay sheet shipped the images workspace
 * (1.8 MB in dev), the Shopify editors, the variants page and the master sheet. One static import is enough to pull a tab
 * back into the frame's chunk, so the frame's two files are read for any.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STUDIO_TABS } from './types'
import { STUDIO_TAB_LOADERS } from './studioTabs'

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
