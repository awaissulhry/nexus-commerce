import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrintSection, PrintView } from './PrintView'
import { forceLight, printFiltersLine, printHide, printedLine } from './printViewModel'

/** B-W2b-09 — the print view: paper says what it shows (filters or none), Print held while reading, always light. */
const Link = ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { href, ...rest }, children)

describe('printViewModel', () => {
  it('writes the filters that are on, or that none is', () => {
    expect(printFiltersLine([{ label: 'Status', value: 'Open' }, { label: 'Site', value: '' }, { label: 'Line', value: 'L1, L2' }])).toBe('Filters: Status: Open · Line: L1, L2')
    expect(printFiltersLine([])).toBe('No filters: every row')
    expect(printFiltersLine([{ label: 'Site', value: '  ' }])).toBe('No filters: every row')
  })
  it('says who printed and when', () => {
    expect(printedLine('31 Oct 2026, 10:42', 'Maria Rossi')).toBe('Printed by Maria Rossi on 31 Oct 2026, 10:42')
    expect(printedLine('31 Oct 2026, 10:42', null)).toBe('Printed on 31 Oct 2026, 10:42')
    expect(printedLine(null, 'Maria Rossi')).toBeNull()
  })
  it('draws light and puts a dark theme back after', () => {
    const classes = new Set(['dark'])
    const root = { classList: { contains: (c: string) => classes.has(c), add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) } }
    const restore = forceLight(root)
    expect(classes.has('dark')).toBe(false)
    restore()
    expect(classes.has('dark')).toBe(true)
    classes.clear()
    forceLight(root)()
    expect(classes.has('dark')).toBe(false)
    expect(printHide).toEqual({ 'data-print-hide': '' })
  })
})

describe('PrintView', () => {
  it('keeps the strip off paper, writes the head and holds Print while reading', () => {
    const html = render(h(PrintView, {
      title: 'Daily production report', printedAt: '31 Oct 2026, 10:42', printedBy: 'Maria Rossi', filters: [{ label: 'Line', value: 'L1' }],
      printHeld: 'Still reading the report', back: { href: '/production/reports' }, linkAs: Link,
    }, h(PrintSection, { title: 'L1' }, 'figures')))
    expect(html).toMatch(/class="nds-printview-strip"[^>]*data-print-hide=""/)
    expect(html).toContain('<h1 class="nds-printview-title">Daily production report</h1>')
    expect(html).toContain('Printed by Maria Rossi on 31 Oct 2026, 10:42')
    expect(html).toContain('Filters: Line: L1')
    expect(html).toContain('aria-description="Still reading the report"')
    expect(html).toContain('href="/production/reports"')
    expect(html).toContain('nds-printview-section')
  })
  it('draws no filters line for a page without filters, and speaks the words it is given', () => {
    const html = render(h(PrintView, { title: 'Scheda', filters: null, labels: { print: 'Stampa' } }))
    expect(html).not.toContain('nds-printview-filters')
    expect(html).toContain('Stampa')
  })
})
