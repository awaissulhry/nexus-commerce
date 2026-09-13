import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SheetStatuses } from './SheetStatus'
it('a detail is a real md pill button; a plain status stays a span', () => {
 const html = render(createElement(SheetStatuses, { status: [{ tone: 'neutral', label: 'Read only', detail: 'Choose a coordinate first.' }, { tone: 'warning', label: 'Waiting' }] }))
 expect(html).toMatch(/<button[^>]*class="nds-pill neutral btn md"/)
 expect(html).toContain('Choose a coordinate first.')
 expect(html).toContain('<span class="nds-pill warning md">Waiting</span>')
})
it('caps visible pills at three and preserves surplus danger announcements and details', () => {
 const html = render(createElement(SheetStatuses, { status: [
 { tone: 'info', label: 'A' }, { tone: 'neutral', label: 'B' }, { tone: 'warning', label: 'C' }, { tone: 'danger', label: 'Read failed', detail: 'Try again.' },
 ] }))
 expect(html.match(/class="nds-pill /g)).toHaveLength(3)
 expect(html).toContain('+2'); expect(html).toContain('role="alert"'); expect(html).toContain('Read failed. Try again.')
})

it('compacts at the host requested tier without losing any status or danger announcement', () => {
 const status = [{ tone: 'warning' as const, label: 'Waiting', detail: 'A write is pending.' }, { tone: 'danger' as const, label: 'Read failed', detail: 'Try again.' }]
 const html = render(createElement(SheetStatuses, { status, compact: true }))
 expect(html.match(/class="nds-pill /g)).toHaveLength(1)
 expect(html).toContain('+2')
 expect(html).toContain('Waiting. A write is pending.; Read failed. Try again.')
 expect(html).toContain('role="alert"')
 const normal = render(createElement(SheetStatuses, { status }))
 expect(normal.match(/class="nds-pill /g)).toHaveLength(2)
 expect(normal).not.toContain('+2')
 expect(render(createElement(SheetStatuses, { compact: true }))).not.toContain('nds-pill ')
})
