import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SizeGridEditor } from './SizeGridEditor'
import { SizeGridView } from './SizeGridView'
import type { SizeGridColour, SizeGridSize } from './sizeGridModel'

const SIZES: SizeGridSize[] = ['S', 'M', 'L'].map((k) => ({ key: k, label: k }))
const COLOURS: SizeGridColour[] = [
  { key: 'blk', label: 'Black', swatch: 'black' },
  { key: 'tan', label: 'Tan', offered: ['S', 'M'] },
]
const VALUE = { blk: { S: 2, M: 1200, L: 0 }, tan: { S: 3, M: 4 } }
const noop = () => {}

const inputs = (html: string) => [...html.matchAll(/<input\b([^>]*)>/g)].map((m) => m[1])
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

describe('SizeGridEditor markup', () => {
  const html = renderToStaticMarkup(createElement(SizeGridEditor, { colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop }))

  it('is a table: caption, size column headers, colour row headers, the totals row in tfoot', () => {
    expect(html).toMatch(/<table class="nds-size-grid-table"><caption id="[^"]+" class="nds-vh">Quantities by colour and size<\/caption>/)
    for (const s of ['S', 'M', 'L', 'Total']) expect(html).toContain(`scope="col" class="nds-size-grid-colhead${s === 'Total' ? ' nds-size-grid-total' : ''}">${s}</th>`)
    expect(html).toMatch(/<th scope="row" class="nds-size-grid-rowhead"><span class="nds-size-grid-rowlabel"><span class="nds-size-grid-swatch" style="background:black" aria-hidden="true"><\/span><span class="nds-size-grid-rowtext">Black<\/span>/)
    expect(html).toMatch(/<tfoot><tr><th scope="row" class="nds-size-grid-rowhead">Total<\/th>/)
  })

  it('every cell that takes an entry is an input named by colour and size; a size not offered is no input', () => {
    const names = inputs(html).map((t) => attr(t, 'aria-label'))
    expect(names).toEqual(['Black, size S', 'Black, size M', 'Black, size L', 'Tan, size S', 'Tan, size M'])
    expect(html).toContain('<span class="nds-vh">Tan, size L: not offered</span>')
    for (const t of inputs(html)) {
      expect(attr(t, 'inputMode')).toBe('numeric')
      expect(t).not.toMatch(/\sdisabled/)
    }
  })

  it('shows row, column and grand totals, grouped', () => {
    expect(html).toContain('<td class="nds-size-grid-num nds-size-grid-total">1,202</td>')
    expect(html).toContain('<td class="nds-size-grid-num nds-size-grid-total">7</td>')
    expect(html).toContain('<td class="nds-size-grid-num nds-size-grid-total nds-size-grid-grand">1,209</td>')
    // Column totals S 5, M 1,204, L 0.
    expect(html).toMatch(/<tfoot>.*>5<\/td>.*>1,204<\/td>.*>0<\/td>/)
  })

  it('has a polite status region for the totals', () => {
    expect(html).toContain('<div role="status" class="nds-vh"></div>')
  })

  it('no curve fill and no MTM switch unless asked for', () => {
    expect(html).not.toContain('nds-size-grid-curve')
    expect(html).not.toContain('role="switch"')
  })
})

describe('SizeGridEditor issues, curve fill, made to measure', () => {
  it('flags a cell: aria-invalid for an error, described by its message, listed with a button back to the cell', () => {
    const html = renderToStaticMarkup(createElement(SizeGridEditor, {
      colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop,
      issues: [{ colour: 'blk', size: 'M', message: 'Above the order limit' }, { colour: 'tan', size: 'S', message: 'Low stock of leather', tone: 'warning' }],
    }))
    const [, m, , tanS] = inputs(html)
    expect(attr(m, 'aria-invalid')).toBe('true')
    const id = attr(m, 'aria-describedby')!
    expect(html).toContain(`<span id="${id}">Above the order limit</span>`)
    expect(attr(tanS, 'aria-invalid')).toBeUndefined()
    expect(attr(tanS, 'aria-describedby')).toBeTruthy()
    expect(html).toMatch(/<button[^>]*>Black, size M<\/button>/)
  })

  it('curve fill is held, with its reason, until there are pieces to share', () => {
    const html = renderToStaticMarkup(createElement(SizeGridEditor, {
      colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop,
      curves: [{ key: 'core', label: 'Core run', ratios: { S: 1, M: 2, L: 1 } }],
    }))
    expect(html).toContain('<option value="__size-grid-every-colour__" selected="">Each colour</option>')
    const fill = /<button([^>]*)>Fill by curve<\/button>/.exec(html)!
    expect(fill[1]).toContain('aria-disabled="true"')
    expect(fill[1]).toContain('aria-description="Enter the pieces to share out: a whole number."')
    expect(fill[1]).not.toMatch(/\sdisabled=/)
    expect(html).toContain('Core run: S 1 · M 2 · L 1')
  })

  it('the MTM switch hides the grid and shows the slot in its place', () => {
    const on = renderToStaticMarkup(createElement(SizeGridEditor, {
      colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop,
      mtm: true, onMtmChange: noop, mtmSlot: createElement('p', null, 'PROFILE PICKER'),
      curves: [{ key: 'core', label: 'Core run', ratios: { S: 1 } }],
    }))
    expect(on).toMatch(/<label class="nds-size-grid-mtm" for="([^"]+)"><button type="button" role="switch" aria-checked="true" class="nds-toggle on" id="\1"><\/button><span>One made-to-measure unit<\/span><\/label>/)
    expect(on).toContain('PROFILE PICKER')
    expect(on).not.toContain('<table')
    expect(on).not.toContain('Fill by curve')

    const off = renderToStaticMarkup(createElement(SizeGridEditor, { colours: COLOURS, sizes: SIZES, value: VALUE, onChange: noop, onMtmChange: noop, mtmSlot: 'PROFILE PICKER' }))
    expect(off).toContain('aria-checked="false"')
    expect(off).toContain('<table')
    expect(off).not.toContain('PROFILE PICKER')
  })
})

describe('SizeGridView', () => {
  it('the same layout with numbers: zero muted, not offered named, totals', () => {
    const html = renderToStaticMarkup(createElement(SizeGridView, { colours: COLOURS, sizes: SIZES, value: VALUE }))
    expect(html).not.toContain('<input')
    expect(html).toContain('data-mode="view"')
    expect(html).toContain('<td class="nds-size-grid-num">1,200</td>')
    expect(html).toContain('<td class="nds-size-grid-num" data-zero="">0</td>')
    expect(html).toContain('<td class="nds-size-grid-num nds-size-grid-off"><span aria-hidden="true">–</span><span class="nds-vh">not offered</span></td>')
    expect(html).toContain('<td class="nds-size-grid-num nds-size-grid-total nds-size-grid-grand">1,209</td>')
  })

  it('a made-to-measure line shows its words and the slot, not the grid', () => {
    const html = renderToStaticMarkup(createElement(SizeGridView, { colours: COLOURS, sizes: SIZES, value: VALUE, mtm: true, mtmSlot: 'Profile 12' }))
    expect(html).toContain('<p class="nds-size-grid-mtm-title">One made-to-measure unit</p>Profile 12')
    expect(html).not.toContain('<table')
  })

  it('a shown caption sits above the scroll box (it never scrolls away); the table keeps its own caption', () => {
    const html = renderToStaticMarkup(createElement(SizeGridView, { colours: COLOURS, sizes: SIZES, value: VALUE, caption: 'Your quantities', showCaption: true }))
    expect(html).toMatch(/<p class="nds-size-grid-caption" aria-hidden="true">Your quantities<\/p><div class="nds-size-grid-scroll" role="region" aria-labelledby="([^"]+)"><table class="nds-size-grid-table"><caption id="\1" class="nds-vh">Your quantities<\/caption>/)
  })

  it('takes another language through copy', () => {
    const html = renderToStaticMarkup(createElement(SizeGridView, { colours: COLOURS, sizes: SIZES, value: VALUE, locale: 'it-IT', copy: { colourHeader: 'Colore', totalHeader: 'Totale' } }))
    expect(html).toContain('>Colore</th>')
    expect(html).toContain('>Totale</th>')
    expect(html).toContain('>1209</td>')
  })
})
