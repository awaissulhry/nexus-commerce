import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BarList } from './BarList'
import { barListView } from './barListModel'

/** B-W2b-09 — BarList: bars for categories, the value written, stacked parts, a drill-down; a table to a screen reader. */
const pct = (n: number) => `${n.toFixed(1)} %`
const Link = ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { href, ...rest }, children)

describe('barListView', () => {
  it('scales to the largest value (or the given end) and leaves unknown values without a bar', () => {
    const view = barListView([{ id: 'a', value: 10 }, { id: 'b', value: 40 }, { id: 'c', value: null }])
    expect(view.bars.map((bar) => [bar.known, bar.width])).toEqual([[true, 25], [true, 100], [false, 0]])
    expect(barListView([{ id: 'a', value: 10 }], { max: 50 }).bars[0]!.width).toBe(20)
  })
  it('draws a loss left of a 0 line', () => {
    const view = barListView([{ id: 'a', value: -10 }, { id: 'b', value: 30 }])
    expect(view.zero).toBe(25)
    expect(view.bars[0]).toMatchObject({ left: 0, width: 25 })
    expect(view.bars[1]).toMatchObject({ left: 25, width: 75 })
  })
  it('splits a stacked bar by its parts in the legend order', () => {
    const view = barListView([{ id: 'r', value: 12, parts: { d60: 4, d30: 8, d90: null } }], { keys: ['d30', 'd60', 'd90'] })
    expect(view.bars[0]!.parts.map((part) => [part.id, part.index])).toEqual([['d30', 0], ['d60', 1]])
  })
})

describe('BarList', () => {
  it('is a table with a caption, the value written, and a drill-down button', () => {
    const html = render(h(BarList, { label: 'Margin by customer', format: pct, active: 'c1', onPick: () => {}, items: [{ id: 'c1', label: 'Rossi Moto', sub: '4 orders', value: 18.2, tone: 'warning' }, { id: 'c2', label: 'Bianchi', value: null }] }))
    expect(html).toContain('<caption class="nds-vh">Margin by customer</caption>')
    expect(html).toContain('18.2 %')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="Show Rossi Moto: 18.2 %"')
    expect(html).toContain('aria-label="Show Bianchi: —"')
  })
  it('says a stacked bar’s parts after its value, with the legend', () => {
    const html = render(h(BarList, { label: 'Overdue', format: (n: number) => `€${n}`, keys: [{ id: 'd30', label: '0–30 days' }, { id: 'd60', label: '31–60 days', tone: 'warning' }], items: [{ id: 'r', label: 'Rossi', value: 12400, parts: { d30: 8000, d60: 4400 }, href: '/sales/customers/r' }], linkAs: Link }))
    expect(html).toContain(' (0–30 days: €8000; 31–60 days: €4400)')
    expect(html).toContain('pattern-1')
    expect(html).toContain('href="/sales/customers/r"')
  })
  it('says the empty words', () => {
    expect(render(h(BarList, { label: 'x', format: pct, items: [], labels: { empty: 'Niente da mostrare' } }))).toContain('Niente da mostrare')
  })
})
