import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SizeGridEditor } from './SizeGridEditor'
import { pasteIntoSizeGrid, SIZE_GRID_COPY, stackedPasteText, type SizeGridColour, type SizeGridSize } from './sizeGridModel'

/**
 * B-W2b-155 — SizeGridEditor's stacked layout (a phone): one colourway at a time, sizes as rows with − / + and what is
 * left; the table stays the default, drawn exactly as before.
 */
const SIZES: SizeGridSize[] = ['S', 'M', 'L'].map((k) => ({ key: k, label: k }))
const COLOURS: SizeGridColour[] = [
  { key: 'blk', label: 'Black', swatch: 'black' },
  { key: 'tan', label: 'Tan', offered: ['S', 'M'] },
]
const VALUE = { blk: { S: 2, M: 0, L: 5 }, tan: { S: 3, M: 4 } }
const noop = () => {}
const inputs = (html: string) => [...html.matchAll(/<input\b([^>]*)>/g)].map((m) => m[1])
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

describe('the table stays the default', () => {
  it('no layout and layout="table" draw the same markup, with no stacked part in it', () => {
    const plain = renderToStaticMarkup(createElement(SizeGridEditor, { colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop }))
    const table = renderToStaticMarkup(createElement(SizeGridEditor, { colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop, layout: 'table' }))
    const strip = (html: string) => html.replace(/id="[^"]*"|aria-labelledby="[^"]*"|aria-describedby="[^"]*"/g, '')
    expect(strip(table)).toBe(strip(plain))
    expect(plain).not.toMatch(/data-layout|nds-size-grid-stack|nds-size-grid-tabs?"|nds-size-grid-step/)
    expect(plain).toContain('<table class="nds-size-grid-table">')
  })
  it('auto draws the table on the server (the phone switch is the browser\'s)', () => {
    expect(renderToStaticMarkup(createElement(SizeGridEditor, { colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop, layout: 'auto' }))).toContain('<table class="nds-size-grid-table">')
  })
})

describe('stacked markup', () => {
  const html = renderToStaticMarkup(
    createElement(SizeGridEditor, { colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop, layout: 'stacked', left: { blk: { S: 10, M: 0, L: 4 } } }),
  )
  it('the colourways are tabs (one selected, roving tab stop), each named with its pieces', () => {
    expect(html).toContain('data-layout="stacked"')
    expect(html).toContain(`role="tablist" aria-label="${SIZE_GRID_COPY.colourPicker}"`)
    expect(html).toMatch(/role="tab" aria-selected="true" aria-controls="[^"]+" aria-label="Black, 7 pieces" tabindex="0"/)
    expect(html).toMatch(/role="tab" aria-selected="false" aria-controls="[^"]+" aria-label="Tan, 7 pieces" tabindex="-1"/)
    expect(html).toMatch(/role="tabpanel" aria-labelledby="[^"]+-tab-0"/)
  })
  it('only the shown colourway\'s sizes are inputs, named as in the table', () => {
    expect(inputs(html).map((t) => attr(t, 'aria-label'))).toEqual(['Black, size S', 'Black, size M', 'Black, size L'])
    for (const t of inputs(html)) expect(attr(t, 'inputMode')).toBe('numeric')
  })
  it('each size has − and +, named by the cell; − holds at 0 and says why', () => {
    expect(html).toContain('aria-label="Fewer: Black, size S"')
    expect(html).toContain('aria-label="More: Black, size L"')
    expect(html).toMatch(/aria-label="Fewer: Black, size M" aria-disabled="true" aria-description="Already 0"/)
  })
  it('what is left beside each size, and the totals in words', () => {
    expect(html).toContain('<th scope="col">Left</th>')
    expect(html).toContain('10 left')
    expect(html).toContain('Black: 7 · All colourways: 14')
  })
  it('one colourway: no tabs; a size it is not made in reads "not offered" (no input)', () => {
    const tan = renderToStaticMarkup(createElement(SizeGridEditor, { colours: [COLOURS[1]], sizes: SIZES, value: VALUE, onChange: noop, layout: 'stacked' }))
    expect(tan).not.toContain('role="tablist"')
    expect(inputs(tan)).toHaveLength(2)
    expect(tan).toContain('Tan, size L: not offered')
  })
  it('speaks the page\'s words', () => {
    const it = renderToStaticMarkup(
      createElement(SizeGridEditor, {
        colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop, layout: 'stacked',
        copy: { colourPicker: 'Colore', less: (c: string) => `Meno: ${c}`, atZero: 'Già 0', stackTotals: ({ colour, total, grand }) => `${colour}: ${total} · Tutti i colori: ${grand}` },
      }),
    )
    expect(it).toContain('aria-label="Colore"')
    expect(it).toContain('aria-description="Già 0"')
    expect(it).toContain('Tutti i colori: 14')
  })
})

describe('stackedPasteText', () => {
  it('a single column lands down the sizes of the colourway shown', () => {
    expect(stackedPasteText('1\n2\n3\n')).toBe('1\t2\t3')
    const r = pasteIntoSizeGrid(VALUE, COLOURS, SIZES, { colour: 'blk', size: 'S' }, stackedPasteText('1\n2\n3\n'))
    expect(r.value.blk).toEqual({ S: 1, M: 2, L: 3 })
    expect(r.value.tan).toEqual({ S: 3, M: 4, L: 0 })
  })
  it('a row, or a block, lands as in the table', () => {
    expect(stackedPasteText('1\t2')).toBe('1\t2')
    expect(stackedPasteText('1\t2\n3\t4')).toBe('1\t2\n3\t4')
    expect(stackedPasteText('7')).toBe('7')
  })
})
