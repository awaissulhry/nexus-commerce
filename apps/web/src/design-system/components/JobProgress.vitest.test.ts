import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { JobProgress, jobPercent, type JobProgressProps } from './JobProgress'

const render = (props: Partial<JobProgressProps> = {}) =>
  renderToStaticMarkup(createElement(JobProgress, { label: 'Saving changes', ...props }))

it('is determinate only when both value and max are known', () => {
  expect(jobPercent(120, 400)).toBe(30)
  expect(jobPercent(500, 400)).toBe(100)
  expect(jobPercent(120, undefined)).toBeNull()
  expect(jobPercent(undefined, 400)).toBeNull()
  expect(jobPercent(0, 0)).toBeNull()
})

it('names the bar after the job and reports how far it is', () => {
  const html = render({ value: 120, max: 400, detail: '120 of 400 records' })
  expect(html).toContain('role="progressbar"')
  expect(html).toContain('aria-label="Saving changes"')
  expect(html).toContain('aria-valuenow="30"')
  expect(html).not.toContain('indet')
  expect(html).toContain('120 of 400 records')
})

it('moves without a count when the size is unknown', () => {
  const html = render({ value: 120 })
  expect(html).toContain('nds-progress indet')
  expect(html).not.toContain('aria-valuenow')
})

it('keeps the count line mounted as a polite live region, even before the first count', () => {
  for (const html of [render(), render({ detail: '3 of 9 records' })]) {
    expect(html).toContain('class="nds-jobprogress-detail" aria-live="polite" aria-atomic="true"')
  }
})

it('shows the elapsed time from the start as a timer, reading 0 s before the first tick', () => {
  const html = render({ startedAt: Date.now() - 12_000 })
  expect(html).toContain('role="timer"')
  expect(html).toContain('>0 s<')
  expect(render()).not.toContain('role="timer"')
})

it('shows the note only when there is one', () => {
  expect(render({ note: 'You can close this window. The job continues in Nexus.' })).toContain('<p class="nds-jobprogress-note">You can close this window. The job continues in Nexus.</p>')
  expect(render()).not.toContain('nds-jobprogress-note')
})
