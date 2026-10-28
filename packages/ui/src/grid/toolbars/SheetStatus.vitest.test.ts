import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SheetStatuses, partitionSheetStatuses, type SheetStatus } from './SheetStatus'
it('a detail is a real md pill button; a plain status stays a span', () => {
 const html = render(createElement(SheetStatuses, { status: [{ tone: 'neutral', label: 'Read only', detail: 'Choose a coordinate first.' }, { tone: 'warning', label: 'Waiting' }] }))
 expect(html).toMatch(/<button[^>]*class="nds-pill neutral btn md"/)
 expect(html).toContain('Choose a coordinate first.')
 expect(html).toContain('<span class="nds-pill warning md">Waiting</span>')
})
it('caps visible pills at three; a danger mark takes a slot first and its surplus details stay on +N', () => {
 const html = render(createElement(SheetStatuses, { status: [
 { tone: 'info', label: 'A' }, { tone: 'neutral', label: 'B' }, { tone: 'warning', label: 'C' }, { tone: 'danger', label: 'Read failed', detail: 'Try again.' },
 ] }))
 expect(html.match(/class="nds-pill /g)).toHaveLength(3)
 expect(html).toContain('>A</span>'); expect(html).toContain('Read failed')
 expect(html).toContain('+2'); expect(html).toContain('B; C')
 expect(html).toContain('role="alert"')
})

it('compacts at the host requested tier: other tones fold into +N, a danger mark stays on the bar', () => {
 const status = [{ tone: 'warning' as const, label: 'Waiting', detail: 'A write is pending.' }, { tone: 'danger' as const, label: 'Read failed', detail: 'Try again.' }]
 const html = render(createElement(SheetStatuses, { status, compact: true }))
 expect(html.match(/class="nds-pill /g)).toHaveLength(2)
 expect(html).toMatch(/<span role="alert"><span[^>]*><button[^>]*class="nds-pill danger btn md"[^>]*aria-label="Read failed. Try again."/)
 expect(html).toContain('+1')
 expect(html).toContain('Waiting. A write is pending.')
 const normal = render(createElement(SheetStatuses, { status }))
 expect(normal.match(/class="nds-pill /g)).toHaveLength(2)
 expect(normal).not.toContain('+1')
 expect(render(createElement(SheetStatuses, { compact: true }))).not.toContain('nds-pill ')
 // Nothing dangerous: the compact tier still folds everything into one +N, as before.
 const calm = render(createElement(SheetStatuses, { status: [{ tone: 'info', label: 'Checking' }, { tone: 'neutral', label: 'Read only' }], compact: true }))
 expect(calm.match(/class="nds-pill /g)).toHaveLength(1); expect(calm).toContain('+2')
})

it('severity outranks order: every danger mark stays, others keep their order, nothing is lost', () => {
 const mk = (tone: SheetStatus['tone'], label: string): SheetStatus => ({ tone, label })
 const labels = (list: SheetStatus[]) => list.map(s => s.label)
 const four = [mk('info', 'a'), mk('warning', 'b'), mk('neutral', 'c'), mk('danger', 'd')]
 expect(labels(partitionSheetStatuses(four, false).visible)).toEqual(['a', 'd'])
 expect(labels(partitionSheetStatuses(four, false).folded)).toEqual(['b', 'c'])
 expect(labels(partitionSheetStatuses(four, true).visible)).toEqual(['d'])
 expect(labels(partitionSheetStatuses(four, true).folded)).toEqual(['a', 'b', 'c'])
 const dangers = [mk('danger', 'x'), mk('info', 'i'), mk('danger', 'y'), mk('danger', 'z')]
 expect(labels(partitionSheetStatuses(dangers, false).visible)).toEqual(['x', 'y', 'z'])
 expect(labels(partitionSheetStatuses(dangers, false).folded)).toEqual(['i'])
 const three = [mk('info', 'p'), mk('warning', 'q'), mk('neutral', 'r')]
 expect(partitionSheetStatuses(three, false)).toEqual({ visible: three, folded: [] })
 for (const list of [four, dangers, three]) for (const compact of [false, true]) {
  const { visible, folded } = partitionSheetStatuses(list, compact)
  expect(visible.length + folded.length).toBe(list.length)
 }
})

it('an action makes the mark a real button whose name says what it does; without one nothing changes', () => {
 const onSelect = () => {}
 const html = render(createElement(SheetStatuses, { status: [{ tone: 'danger', label: '2 rejected on Amazon · IT', detail: 'Amazon refused 2 products.', onSelect, actionLabel: 'Show these rows', selected: false }] }))
 expect(html).toMatch(/<button[^>]*class="nds-pill danger btn md"/)
 expect(html).toContain('aria-pressed="false"')
 expect(html).toContain('aria-label="2 rejected on Amazon · IT. Amazon refused 2 products. Show these rows"')
 const on = render(createElement(SheetStatuses, { status: [{ tone: 'warning', label: 'Processing', onSelect, actionLabel: 'Show these rows', selected: true }] }))
 expect(on).toContain('aria-pressed="true"')
 expect(on).toContain('aria-label="Processing. Show these rows"')
 const plain = render(createElement(SheetStatuses, { status: [{ tone: 'neutral', label: 'Read only', detail: 'Choose a coordinate first.' }] }))
 expect(plain).not.toContain('aria-pressed')
 expect(plain).toContain('aria-label="Read only. Choose a coordinate first."')
})
