/**
 * Review 2026-10-05 (m3) — the main listing is "Main listing" on the sheet's band too (an older read calls it
 * "Primary"), and a screen reader hears it once: the ★ mark, whose spoken name is "Main listing", is hidden beside those
 * words. An alias keeps its own name and its spoken mark ("Listing alias 1"). Rendered with the real cell (node SSR).
 * Fake ids only.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AliasBandCell } from './AliasBandCell'
import type { AliasSummary } from './rows'
import type { AliasGroup, ChannelSheetRow } from './types'

const node = { expanded: true, group: true, allChildrenCount: 2, setExpanded: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined }
const group = (id: string | null, label: string, position: number): AliasGroup => ({ id, label, position, status: 'ACTIVE', externalListingId: null,
  listingStatus: null, isPublished: null, readiness: { percent: null, state: 'ready' } as AliasGroup['readiness'], rowIds: [] })
const summary = (alias: AliasGroup): AliasSummary => ({ alias, variantRows: 2, variantSkus: 2, percent: null, errors: 0, warnings: 0, rowsMissingRequired: 0, isUnadoptedShell: false })
const band = (aliasId: string | null, aliasPosition: number) => ({ rowId: `${aliasId ?? 'primary'}:fam-1`, id: 'fam-1', sku: 'DEMO-FAMILY', rowKind: 'parent', aliasId,
  aliasPosition, name: 'Demo family', imageUrl: null }) as unknown as ChannelSheetRow
const render = (row: ChannelSheetRow, alias: AliasGroup) => renderToStaticMarkup(createElement(AliasBandCell as never, {
  data: row, node, summary: summary(alias), aliasCount: 2, menuItems: [],
}))

describe('the listing band names the main listing "Main listing" and reads it once', () => {
  it('the main band: "Main listing" (never "Primary"), its ★ hidden from screen readers', () => {
    const html = render(band(null, 0), group(null, 'Primary', 0))
    expect(html).toContain('Main listing')
    expect(html).not.toContain('Primary')
    expect(html).toMatch(/<span aria-hidden="true"><span class="nds-alias-mark" role="img" aria-label="Main listing">★<\/span><\/span>/)
  })

  it('an alias band: its own name, and its mark still spoken', () => {
    const html = render(band('alias-1', 1), group('alias-1', 'ALT1', 1))
    expect(html).toContain('ALT1')
    expect(html).toMatch(/role="img" aria-label="Listing alias 1"/)
    expect(html).not.toMatch(/aria-hidden="true"><span class="nds-alias-mark"/)
  })
})
