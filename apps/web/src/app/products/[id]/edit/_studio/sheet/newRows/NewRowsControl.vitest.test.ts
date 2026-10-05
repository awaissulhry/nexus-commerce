/**
 * Add rows — the footer control ("Rows to add" + "Add rows", a menu on a channel scope) and an empty row's identity cell,
 * as the markup a person and a screen reader get.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GRID_SHEET_STATUS_WIDE } from '@/design-system/grid'
import { NewRowsControl, addRowsName, newRowsMenuItems, type NewRowsControlProps } from './NewRowsControl'
import { NewRowCell, removeRowName } from './NewRowCell'
import { NEW_ROWS_WORDS, makeNewRows } from './newRows'

const props = (over: Partial<NewRowsControlProps> = {}): NewRowsControlProps => ({
  kinds: ['variation'], count: 3, onCount: vi.fn(), onAdd: vi.fn(), onHeld: vi.fn(), ...over,
})
const render = (over: Partial<NewRowsControlProps> = {}) => renderToStaticMarkup(createElement(NewRowsControl, props(over)))

describe('the footer control', () => {
  it('Shared scope: "Rows to add" (1–50, named by its label) and an "Add rows" button that says how many it adds', () => {
    const html = render()
    expect(html).toContain(`<span class="${GRID_SHEET_STATUS_WIDE}"><span id=`)
    expect(html).toContain('>Rows to add</span>')
    const input = html.match(/<input[^>]*>/)?.[0] ?? ''
    for (const attribute of ['type="number"', 'value="3"', 'min="1"', 'max="50"']) expect(input).toContain(attribute)
    const labelId = html.match(/<span id="([^"]+)">Rows to add<\/span>/)?.[1]
    expect(labelId).toBeTruthy()
    expect(input).toContain(`aria-labelledby="${labelId}"`)
    expect(html).toContain('aria-label="One row fewer"')
    expect(html).toContain(`aria-label="${addRowsName(3)}"`)
    expect(addRowsName(1)).toBe('Add rows: 1 empty row')
    expect(html).toContain('>Add rows</button>')
    expect(html).not.toContain('aria-haspopup')
  })

  it('a held button stays focusable and says why (description and tip), never a silent disabled button', () => {
    const html = render({ unavailable: { variation: 'Only a parent can hold variations. Promote this product first.' } })
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('aria-description="Only a parent can hold variations. Promote this product first."')
    expect(html).toContain('h10-tipwrap')
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Add rows/)
  })

  it('channel scope: "Add rows ▾" opens a menu of Variations and Listing (alias), each saying what it creates or why not', () => {
    const html = render({ kinds: ['variation', 'alias'] })
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('Add rows ▾')
    const onAdd = vi.fn()
    const items = newRowsMenuItems(['variation', 'alias'], { alias: 'Connect an eBay account before adding a listing on IT.' }, onAdd)
    expect(items.map((i) => [i.label, i.description, !!i.disabled])).toEqual([
      ['Variations', NEW_ROWS_WORDS.variationsNote, false],
      ['Listing (alias)', 'Connect an eBay account before adding a listing on IT.', true],
    ])
    items[0].onSelect?.()
    expect(onAdd).toHaveBeenCalledWith('variation')
  })

  it('draws nothing when the scope offers no kind', () => {
    expect(render({ kinds: [] })).toBe('')
  })
})

describe('an empty row\'s identity cell', () => {
  const [row] = makeNewRows('variation', 1, () => 'cell-1')
  const cell = (over = {}) => renderToStaticMarkup(createElement(NewRowCell, { row: { ...row, ...over }, onRemove: vi.fn() }))

  it('asks for the SKU, wears "Not saved" and offers a named remove button', () => {
    const html = cell()
    expect(html).toContain('>Type the SKU</span>')
    expect(html).toContain('>Not saved</span>')
    expect(html).toContain(NEW_ROWS_WORDS.newVariation)
    expect(html).toContain(`aria-label="${removeRowName(row)}"`)
    expect(removeRowName({ sku: 'GALE-L' })).toBe('Remove the new row GALE-L')
  })

  it('keeps a refusal in the server\'s words on the row', () => {
    const html = cell({ sku: 'GALE-L', state: 'refused', reason: 'SKU "GALE-L" already exists' })
    expect(html).toContain('GALE-L')
    expect(html).toContain('>Refused</span>')
    expect(html).toContain('SKU &quot;GALE-L&quot; already exists')
  })

  it('has no remove button while its create is on its way', () => {
    const html = cell({ sku: 'GALE-L', state: 'saving' })
    expect(html).toContain('>Saving…</span>')
    expect(html).not.toContain('Remove the new row')
  })
})
