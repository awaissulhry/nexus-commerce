import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Disclosure } from './Disclosure'
it('preserves native details/open semantics while adding tone without leaking it as a DOM attribute', () => {
 const html = render(createElement(Disclosure, { summary: 'Review consequences', tone: 'warning', open: true, children: 'A loss remains.' }))
 expect(html).toContain('<details class="nds-disclosure warning" open="">')
 expect(html).toContain('<summary'); expect(html).not.toContain(' tone=')
 expect(render(createElement(Disclosure, { summary: 'Details', children: 'Body' }))).toContain('class="nds-disclosure"')
})
