/**
 * Browser check 2026-10-05 — F3 and F8, ONE way for both: a refused first-column SKU reads in the sheet's own refusal
 * words wherever the person looks.
 *   - when it happens: the toast (`announceRefusals` for a real row's save; the empty-row store's `say` for a create);
 *   - on the band: the hover LEADS with the refusal ("Not saved: …"), so the listing band's own sentence never covers it
 *     (it used to: the band's `title` hid the cell's hover), and an empty row's hover says it the same way;
 *   - trying again: the editor leads with it, in full (`identitySkuColumn.vitest.test.ts`).
 * Rendered with the real cells (node SSR); the band's sentence on a normal row is unchanged.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AliasBandCell, bandTitle } from './channel/AliasBandCell'
import { NewRowCell, newRowHover } from './newRows/NewRowCell'
import { identitySkuHover } from './identitySkuEdit'
import type { NewRow } from './newRows/newRows'
import type { ChannelSheetRow } from './channel/types'

const node = { expanded: true, group: true, allChildrenCount: 3, setExpanded: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined }
const band = { rowId: 'primary:p', id: 'p', sku: 'DEMO-JACKET', rowKind: 'parent', aliasId: null, aliasPosition: 0, name: 'Demo jacket', imageUrl: null } as unknown as ChannelSheetRow
const render = (titleOf?: (own: string) => string | undefined) => renderToStaticMarkup(createElement(AliasBandCell as never, {
  data: band, node, summary: undefined, aliasCount: 1, menuItems: [], ...(titleOf ? { titleOf } : {}),
}))
const titleOfBand = (html: string) => /class="nds-identity-band" title="([^"]*)"/.exec(html)?.[1]?.replace(/&#x27;/g, '\'').replace(/&amp;/g, '&')

describe('F3 — the listing band\'s hover leads with the first column\'s refusal', () => {
  const own = bandTitle(undefined, 'Demo jacket', null, undefined, null)
  const refusal = 'Nexus cannot move a family\'s main listing on Amazon to a new SKU yet (DEMO-JACKET → DEMO-JACKET-IT): its variations hang under DEMO-JACKET. Delete the family here, then list it again.'

  it('a refused band: "Not saved: …" first, then the band\'s own sentence', () => {
    expect(titleOfBand(render(sentence => identitySkuHover(refusal, sentence)))).toBe(`Not saved: ${refusal}\n\n${own}`)
  })

  it('a normal band: its own sentence, unchanged', () => {
    expect(titleOfBand(render(sentence => identitySkuHover(null, sentence)))).toBe(own)
    expect(titleOfBand(render())).toBe(own)
  })

  it('the channel scope gives the band the first column\'s hover (`useIdentitySkuColumn().hover`)', () => {
    const adapter = readFileSync(join(__dirname, 'channel', 'useChannelSheetAdapter.tsx'), 'utf8')
    expect(adapter).toContain('const identityHoverRef = useRef(identitySku.hover);')
    expect(adapter).toMatch(/<AliasBandCell [^\n]*titleOf=\{\(own\) => identityHoverRef\.current\(row, own\)\}/)
  })
})

describe('F8 — an empty row\'s refusal reads the same way', () => {
  const row = (over: Partial<NewRow>): NewRow => ({ id: 'new-row:1', kind: 'variation', unsaved: true, sku: 'DEMO-JACKET-M', state: 'refused', reason: 'DEMO-JACKET-M is already in this family.', createdId: null, ...over })

  it('its hover is the refusal in the first column\'s words; other states keep their state and line', () => {
    expect(newRowHover(row({}))).toBe('Not saved: DEMO-JACKET-M is already in this family.')
    expect(newRowHover(row({ state: 'empty', sku: '', reason: null }))).toBe('Not saved. New variation: type its SKU to create it')
    const html = renderToStaticMarkup(createElement(NewRowCell, { row: row({}), onRemove: () => undefined }))
    expect(html).toContain('title="Not saved: DEMO-JACKET-M is already in this family."')
  })
})
