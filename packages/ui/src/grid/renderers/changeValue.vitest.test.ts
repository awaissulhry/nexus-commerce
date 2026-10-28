import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChangeCell, ChangeValue } from './ChangeCell'
import {
  asChangeValueData, changeAccessibleText, changeKind, changeLineText, changeMoreCount, changeSummaryText, changeTooltipText,
  type ChangeLine,
} from './changeValue'

const PRICE: ChangeLine = { label: 'Price', from: '€49.90', to: '€44.90' }
const NEW: ChangeLine = { label: 'Sale price', from: null, to: '€39.90' }
const GONE: ChangeLine = { label: 'Handling fee', from: '€3.00', to: null }

describe('before → after words (G1)', () => {
  it('names the five shapes of a line; a null is a fact, never an empty string', () => {
    expect(changeKind(PRICE)).toBe('changed')
    expect(changeKind(NEW)).toBe('added')
    expect(changeKind(GONE)).toBe('removed')
    expect(changeKind({ label: 'Stock', from: '5', to: '5' })).toBe('unchanged')
    expect(changeKind({ label: 'Note', from: null, to: null })).toBe('empty')
  })

  it('says each line as one sentence for a screen reader', () => {
    expect(changeLineText(PRICE)).toBe('Price: from €49.90 to €44.90')
    expect(changeLineText(NEW)).toBe('Sale price: new value €39.90')
    expect(changeLineText(GONE)).toBe('Handling fee: €3.00 removed')
    expect(changeLineText({ label: 'Stock', from: '5', to: '5' })).toBe('Stock: unchanged, 5')
    expect(changeLineText({ label: '', from: '1', to: '2' })).toBe('from 1 to 2')
  })

  it('reads EVERY known line plus the uncounted rest — a compact cell never cuts the screen reader to line one', () => {
    expect(changeAccessibleText({ changes: [PRICE, NEW], more: 2 })).toBe('Price: from €49.90 to €44.90; Sale price: new value €39.90; and 2 more changes')
    expect(changeAccessibleText({ changes: [PRICE], more: 1 })).toBe('Price: from €49.90 to €44.90; and 1 more change')
    expect(changeAccessibleText({ changes: [], more: 3 })).toBe('3 more changes')
    expect(changeAccessibleText({ changes: [] })).toBe('No change')
  })

  it('"+N more" counts the lines a compact row leaves out, and only `more` on a full surface', () => {
    expect(changeMoreCount({ changes: [PRICE, NEW, GONE], more: 2 }, true)).toBe(4)
    expect(changeMoreCount({ changes: [PRICE, NEW, GONE], more: 2 }, false)).toBe(2)
    expect(changeMoreCount({ changes: [PRICE], more: -1 }, true)).toBe(0)
  })

  it('the tooltip and the CSV say the same lines with the arrow', () => {
    const data = { changes: [PRICE, NEW, GONE], more: 1 }
    expect(changeTooltipText(data)).toBe('Price: €49.90 → €44.90\nSale price: → €39.90 (new)\nHandling fee: €3.00 → removed\n+1 more')
    expect(changeSummaryText(data)).toBe('Price: €49.90 → €44.90; Sale price: → €39.90 (new); Handling fee: €3.00 → removed; +1 more')
    expect(changeTooltipText(null)).toBe('')
  })

  it('reads either cell shape and drops malformed lines instead of drawing "undefined"', () => {
    expect(asChangeValueData([PRICE, { label: 'x', from: 3 }])).toEqual({ changes: [PRICE] })
    expect(asChangeValueData({ changes: [PRICE], more: 2 })).toEqual({ changes: [PRICE], more: 2 })
    expect(asChangeValueData('€44.90')).toBeNull()
    expect(asChangeValueData(null)).toBeNull()
  })
})

describe('ChangeValue / ChangeCell markup', () => {
  it('draws muted old, an arrow, strong new — aria-hidden — and one hidden sentence', () => {
    const html = render(createElement(ChangeValue, { changes: [PRICE] }))
    expect(html).toContain('<span class="nds-change-lines" aria-hidden="true">')
    expect(html).toContain('<span class="nds-change-from">€49.90</span>')
    expect(html).toContain('<span class="nds-change-to">€44.90</span>')
    expect(html).toContain('nds-change-arrow')
    expect(html).toContain('<span class="nds-vh">Price: from €49.90 to €44.90</span>')
    expect(html).not.toContain('title=')
  })

  it('a new value has no "from"; a removal says removed', () => {
    const html = render(createElement(ChangeValue, { changes: [NEW, GONE] }))
    const added = html.slice(html.indexOf('nds-change-added'), html.indexOf('nds-change-removed'))
    expect(added).not.toContain('nds-change-from')
    expect(added).toContain('nds-change-arrow')
    expect(added).toContain('<span class="nds-change-to">€39.90</span>')
    const removed = html.slice(html.indexOf('nds-change-removed'))
    expect(removed).toContain('<span class="nds-change-from">€3.00</span>')
    expect(removed).toContain('<span class="nds-change-gone">removed</span>')
  })

  it('compact draws only the first line and "+N more"; hideLabels keeps the label for screen readers', () => {
    const html = render(createElement(ChangeValue, { changes: [PRICE, NEW], more: 2, compact: true, hideLabels: true }))
    expect(html).toContain('class="nds-change compact"')
    expect(html).not.toContain('nds-change-label')
    expect(html).not.toContain('€39.90</span><')
    expect(html).toContain('<span class="nds-change-more">+3 more</span>')
    expect(html).toContain('Sale price: new value €39.90; and 2 more changes')
  })

  it('renders nothing for nothing; the grid cell draws its dash instead', () => {
    expect(render(createElement(ChangeValue, { changes: [] }))).toBe('')
    const cell = render(createElement(ChangeCell, { value: { changes: [] } } as never))
    expect(cell).toContain('nds-cell-empty')
    expect(render(createElement(ChangeCell, { value: [PRICE] } as never))).toContain('class="nds-change compact"')
    expect(render(createElement(ChangeCell, { value: [PRICE], compact: false } as never))).toContain('class="nds-change"')
  })
})
