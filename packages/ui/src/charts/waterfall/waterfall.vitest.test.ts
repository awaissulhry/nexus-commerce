import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Waterfall, type WaterfallStep } from './Waterfall'
import { waterfallView } from './waterfallModel'

/** B-W2b-09 — Waterfall: signed steps from a start to a result; grain-aware; totals checked, never hidden. */
const PRICE: WaterfallStep[] = [
  { id: 'base', kind: 'start', label: 'Base price', amount: 52 },
  { id: 'options', kind: 'step', label: 'Options', amount: 6, href: '/sales/pricelists/1' },
  { id: 'qty', kind: 'step', label: 'Quantity break', amount: -4.5, detail: 'Over 50 garments' },
  { id: 'net', kind: 'total', label: 'Net price', amount: 53.5 },
]
const eur = (n: number) => `€${n.toFixed(2)}`
const Link = ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { href, ...rest }, children)

describe('waterfallView', () => {
  it('runs the total from the start through each step', () => {
    const view = waterfallView(PRICE)
    expect(view.bars.map((bar) => [bar.from, bar.to])).toEqual([[0, 52], [52, 58], [58, 53.5], [0, 53.5]])
    expect(view.result).toBe(53.5)
    expect(view.bars[3]!.mismatch).toBeNull()
  })
  it('tones a change by which way is good', () => {
    expect(waterfallView(PRICE, 'up').bars.map((bar) => bar.tone)).toEqual(['total', 'up-good', 'down-bad', 'total'])
    expect(waterfallView(PRICE, 'down').bars.map((bar) => bar.tone)).toEqual(['total', 'up-bad', 'down-good', 'total'])
    expect(waterfallView(PRICE, 'none').bars.map((bar) => bar.tone)).toEqual(['total', 'neutral', 'neutral', 'total'])
  })
  it('reports a total that does not match its steps', () => {
    const view = waterfallView([{ id: 'a', kind: 'start', amount: 10 }, { id: 'b', kind: 'step', amount: 2 }, { id: 't', kind: 'total', amount: 13 }])
    expect(view.bars[2]!.mismatch).toBe(1)
  })
  it('puts every bar on one scale that holds 0 (a loss shows below it)', () => {
    const view = waterfallView([{ id: 'p', kind: 'start', amount: 10 }, { id: 'c', kind: 'step', amount: -15 }, { id: 'm', kind: 'total' }])
    expect(view.min).toBe(-5)
    expect(view.zero).toBeCloseTo((5 / 15) * 100)
    for (const bar of view.bars) expect(bar.left + bar.width).toBeLessThanOrEqual(100.0001)
  })
})

describe('Waterfall', () => {
  it('writes signed amounts, links a step, opens a popover for another', () => {
    const html = render(h(Waterfall, { steps: PRICE, label: 'Price build-up', format: eur, linkAs: Link }))
    expect(html).toContain('<ol class="nds-waterfall" aria-label="Price build-up">')
    expect(html).toContain('+ €6.00')
    expect(html).toContain('− €4.50')
    expect(html).toContain('href="/sales/pricelists/1"')
    expect(html).toContain('aria-label="Show how Quantity break is made"')
    expect(html).toContain('Quantity break, − €4.50, now €53.50')
  })
  it('shows the reason in place of the chart without the grain', () => {
    const html = render(h(Waterfall, { steps: PRICE, label: 'Cost', format: eur, heldReason: 'Needs the cost grain' }))
    expect(html).toBe('<p class="nds-waterfall is-held">Needs the cost grain</p>')
  })
  it('says a mismatched total in the app words', () => {
    const steps: WaterfallStep[] = [{ id: 'a', kind: 'start', label: 'Price', amount: 10 }, { id: 't', kind: 'total', label: 'Net', amount: 12 }]
    const html = render(h(Waterfall, { steps, label: 'x', format: eur, mismatchWords: (sum, given) => `Steps add up to ${sum}; the order says ${given}` }))
    expect(html).toContain('Steps add up to €10.00; the order says €12.00')
  })
})
