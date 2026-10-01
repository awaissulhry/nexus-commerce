/**
 * P2 (2026-09-30, I4-8) — a channel cell mounts only what it shows. Measured before on xracing Amazon IT (209 columns):
 * a horizontal scroll rendered 254 components per frame, 36 of them an empty `CellSaveReason` and `CellSaveMark` in
 * every cell entering the viewport, and every source mark mounted a `Tooltip` that the grid's hint-less host renders as
 * its trigger alone. Rendered here with the real components (node SSR) and counted.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const counts = vi.hoisted(() => ({ reason: 0, mark: 0, tooltip: 0 }))
vi.mock('@/design-system/grid', async (original) => {
  const real = await original<typeof import('@/design-system/grid')>()
  return { ...real, CellSaveReason: (p: Parameters<typeof real.CellSaveReason>[0]) => { counts.reason++; return real.CellSaveReason(p) } }
})
vi.mock('@/design-system/grid/renderers/CellSaveMark', async (original) => {
  const real = await original<typeof import('@/design-system/grid/renderers/CellSaveMark')>()
  return { CellSaveMark: (p: Parameters<typeof real.CellSaveMark>[0]) => { counts.mark++; return real.CellSaveMark(p) } }
})
vi.mock('@/design-system/primitives/Tooltip', async (original) => {
  const real = await original<typeof import('@/design-system/primitives/Tooltip')>()
  return { ...real, Tooltip: (p: Parameters<typeof real.Tooltip>[0]) => { counts.tooltip++; return real.Tooltip(p) } }
})

import { CellSaveTracker } from '@/design-system/grid'
import { TooltipPortalProvider } from '@/design-system/primitives/Tooltip'
import { SourceIndicator } from '@/design-system/components/SourceIndicator'
import { CascadeCell } from './CascadeCell'

const column = { key: 'brand', writeField: 'attr_brand', label: 'Brand', group: 'Item specifics', kind: 'text', storage: 'categoryAttributes', scope: 'global', requiredBy: [], editable: true, defaultVisible: true } as const
const row = { rowId: 'r1', id: 'p1', sku: 'SKU-1', rowKind: 'variant', productType: null, values: { brand: { value: 'Brand A', source: 'channelExplicit', inheritedFrom: null, inherited: false, layer: 'channel', pinned: true, follows: false, editable: true, linkGroupId: null, mapped: null, writeField: 'attr_brand', writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, writable: true, writeBlockedReason: null } } }
const api = { getColumn: () => ({ isCellEditable: () => true }) }
const cell = (tracker: CellSaveTracker) => createElement(TooltipPortalProvider, { disabled: true,
  children: createElement(CascadeCell as never, { data: row, value: 'Brand A', node: { rowIndex: 0 }, api, column, tracker, onDetails: () => {} }) })

describe('a channel cell mounts only what it shows', () => {
  beforeEach(() => { counts.reason = 0; counts.mark = 0; counts.tooltip = 0 })

  it('a cell with no save state mounts no save reason, no save mark and no inert tooltip', () => {
    const markup = renderToStaticMarkup(cell(new CellSaveTracker()))
    expect(markup).toContain('Brand A')
    expect(markup).toContain('data-value-source="override"')
    expect(counts).toEqual({ reason: 0, mark: 0, tooltip: 0 })
  })

  it('a saving cell still shows its mark and its reason', () => {
    const tracker = new CellSaveTracker()
    tracker.set('r1', 'brand', 'unknown', 'Could not confirm this save.')
    const markup = renderToStaticMarkup(cell(tracker))
    expect(counts.reason).toBe(1)
    expect(counts.mark).toBe(1)
    expect(markup).toContain('Could not confirm this save.')
    expect(markup).toContain('nds-save-mark')
  })
})

describe('SourceIndicator in a host without hints', () => {
  beforeEach(() => { counts.tooltip = 0 })
  const mark = () => createElement(SourceIndicator, { kind: 'master', label: 'Follows Shared', description: 'Uses the Shared product.', tooltip: 'Follows Shared. Uses the Shared product', actionLabel: 'Show cell details', onAction: () => {} })

  it('draws exactly what the inert tooltip drew, without mounting it', () => {
    const hintless = renderToStaticMarkup(createElement(TooltipPortalProvider, { disabled: true, children: mark() }))
    expect(counts.tooltip).toBe(0)
    // With hints, the tooltip is mounted and wraps the same trigger.
    const hinted = renderToStaticMarkup(createElement(TooltipPortalProvider, { children: mark() }))
    expect(counts.tooltip).toBe(1)
    expect(hinted).toContain(hintless)
    expect(hintless).toMatch(/^<button[^>]*data-value-source="master"/)
    expect(hintless).toContain('title="Follows Shared. Uses the Shared product"')
  })
})
