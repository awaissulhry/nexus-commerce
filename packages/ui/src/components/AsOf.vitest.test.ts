import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { AsOf } from './AsOf'
it('distinguishes absent checks, absent events and unknown observation sources', () => {
  expect(render(createElement(AsOf, { at: null }))).toContain('not checked')
  expect(render(createElement(AsOf, { at: null, kind: 'event' }))).toContain('never')
  expect(render(createElement(AsOf, { at: '2026-09-13T12:00:00Z', via: null }))).toContain('not checked')
  expect(render(createElement(AsOf, { at: 'bad timestamp' }))).not.toContain('<time')
})
it('renders a real timestamp and visible source using the common formatters', () => {
  const html = render(createElement(AsOf, { at: '2026-09-13T12:00:00Z', via: 'channel read', now: Date.parse('2026-09-13T12:02:00Z') }))
  expect(html).toContain('dateTime="2026-09-13T12:00:00Z"')
  expect(html).toContain('title="2026-09-13T12:00:00Z · channel read"'); expect(html).toContain('channel read')
})
