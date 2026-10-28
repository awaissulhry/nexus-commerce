import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Timeline } from './Timeline'

const steps = [
  { key: 'reviewed', label: 'Reviewed', tone: 'neutral' as const, at: '2026-10-01T10:00:00Z' },
  { key: 'sent', label: 'Sent to Amazon', tone: 'info' as const, at: '2026-10-01T10:01:00Z', detail: 'Feed FEED-1' },
  { key: 'processed', label: 'Amazon refused 2 of 23', tone: 'danger' as const, at: '2026-10-01T10:06:00Z' },
  { key: 'verified', label: 'Verified', tone: 'neutral' as const, at: null },
]

it('is a named ordered list with one item per step and a decorative dot', () => {
  const html = render(createElement(Timeline, { steps, label: 'Publish steps', now: Date.parse('2026-10-01T10:10:00Z') }))
  expect(html).toMatch(/^<ol class="nds-timeline" aria-label="Publish steps">/)
  expect(html.match(/<li /g)).toHaveLength(4)
  expect(html.match(/class="nds-timeline-dot" aria-hidden="true"/g)).toHaveLength(4)
  expect(html).not.toContain('<button')
})

it('says a failure in words for a screen reader, not by colour alone', () => {
  const html = render(createElement(Timeline, { steps, label: 'Publish steps' }))
  expect(html).toContain('<span class="nds-vh">Problem: </span>Amazon refused 2 of 23')
  expect(html).not.toContain('<span class="nds-vh">Problem: </span>Sent to Amazon')
})

it('gives each happened step a machine time, a pending step "not yet", and shows the detail', () => {
  const html = render(createElement(Timeline, { steps, label: 'Publish steps' }))
  expect(html).toContain('dateTime="2026-10-01T10:01:00Z"')
  expect(html).toContain('is-pending')
  expect(html).toContain('not yet')
  expect(html).toContain('Feed FEED-1')
})

it('shows no time at all for a step without one', () => {
  const html = render(createElement(Timeline, { steps: [{ key: 'a', label: 'Queued', tone: 'info' }], label: 'Steps' }))
  expect(html).not.toContain('<time')
  expect(html).not.toContain('not yet')
})
