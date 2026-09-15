import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GridDensityProvider } from '@/design-system/lib/density'
import { gridDensity } from '@/design-system/tokens/grid'
import { GridLoadingOverlay, GridNoRowsOverlay } from '@/design-system/grid/renderers/overlays'
import { SheetToolbar } from './SheetToolbar'
import { SheetLoadError } from './SheetLoadError'
import { sheetEmptyState } from './sheetGridStates'

describe('information grid states', () => {
  it.each(['compact', 'cozy', 'spacious'] as const)('matches %s product-row height while loading', density => {
    const html = renderToStaticMarkup(createElement(GridDensityProvider, { value: density, children: createElement(GridLoadingOverlay, { rows: 2, rowKind: 'media-line' }) }))
    expect(html.match(new RegExp(`height:${gridDensity[density].rowMediaLine}px`, 'g'))).toHaveLength(2)
    expect(html).toContain('aria-label="Loading"')
    expect(html.match(/nds-grid-skel-thumb/g)).toHaveLength(2)
    expect(html).not.toContain('nds-grid-skel-line-sub')
  })

  it('distinguishes an empty read from filtered results and supplies the correct recovery', () => {
    const clear = vi.fn(), reload = vi.fn()
    const filtered = sheetEmptyState(21, clear, reload)
    expect(renderToStaticMarkup(createElement(GridNoRowsOverlay, filtered))).toContain('No matching products')
    filtered.action.onClick()
    expect(clear).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
    const empty = sheetEmptyState(0, clear, reload)
    expect(renderToStaticMarkup(createElement(GridNoRowsOverlay, empty))).toContain('No products to show')
    empty.action.onClick()
    expect(reload).toHaveBeenCalledOnce()
  })

  it.each([{ loading: true }, { unavailable: true }])('blocks data-dependent toolbar actions during %j', state => {
    const html = renderToStaticMarkup(createElement(SheetToolbar, {
      visible: 0, total: 0, selected: 0, search: '', onSearch: vi.fn(),
      onCustomise: vi.fn(), onImport: vi.fn(), onExport: vi.fn(), onReload: vi.fn(), ...state,
    }))
    expect(html).toContain(state.loading ? 'Loading information…' : 'Information unavailable')
    for (const label of ['All attributes', 'Customise', 'Export', 'Import']) expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`))
    expect(html).toContain('aria-label="More"')
    expect(html).not.toContain('0 rows')
    expect(html).not.toContain('views: not supplied')
  })

  it.each([false, true])('uses a labelled error and standard retry for unavailable=%s', unavailable => {
    const html = renderToStaticMarkup(createElement(SheetLoadError, { label: 'eBay information', unavailable, onRetry: vi.fn() }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Could not load eBay information')
    expect(html).toContain('Try again</button>')
    expect(html).not.toMatch(/Failed to fetch|PES|deploy/)
  })

  it('shows the actual read failure and keeps its recovery button', () => {
    const message = 'Nexus took too long to load this information. Try again.'
    const html = renderToStaticMarkup(createElement(SheetLoadError, { label: 'eBay · IT information', message, onRetry: vi.fn() }))
    expect(html).toContain(message)
    expect(html).toContain('Try again</button>')
    expect(html).not.toContain('check your access')
  })
})
