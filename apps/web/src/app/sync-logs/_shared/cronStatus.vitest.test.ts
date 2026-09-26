/**
 * P1.8 re-review (2026-09-24) — the hub never draws a partial cron run as healthy.
 *
 * The API records PARTIAL and NOT_CONFIGURED for a run that finished without proving everything (the channel
 * contract run). The KPI tile said "good" beside such a row, and the row itself was an unlabelled grey dot
 * shared with any unknown status. The completed statuses are read from the API's own source, so a new one
 * cannot arrive unmapped.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CronStatusPill, cronKpiTone, cronStatusTone } from './cronStatus'

const recorder = readFileSync(new URL('../../../../../api/src/utils/cron-observability.ts', import.meta.url), 'utf8')
const completed = [...(/export type CronCompletedStatus = ([^\n]+)/.exec(recorder)?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])
const incomplete = completed.filter((status) => status !== 'SUCCESS')

describe('cron status in the sync-logs hub', () => {
  it('reads the API\'s completed statuses (positive control)', () => {
    expect(completed).toContain('SUCCESS')
    expect(incomplete.length).toBeGreaterThanOrEqual(2)
  })
  it('only SUCCESS is green; every other completed status is a warning; FAILED danger; unknown neutral', () => {
    expect(cronStatusTone('SUCCESS')).toBe('success')
    for (const status of incomplete) expect(cronStatusTone(status), status).toBe('warning')
    expect(cronStatusTone('FAILED')).toBe('danger')
    expect(cronStatusTone('RUNNING')).toBe('info')
    expect(cronStatusTone('SOMETHING_NEW')).toBe('neutral')
  })
  it('the KPI tile warns while any latest row is incomplete, and is good only when all succeeded', () => {
    const ok = [{ status: 'SUCCESS' }, { status: 'SUCCESS' }]
    expect(cronKpiTone(ok, 0)).toBe('good')
    for (const status of incomplete) expect(cronKpiTone([...ok, { status }], 0), status).toBe('warn')
    expect(cronKpiTone([...ok, { status: 'RUNNING' }], 0)).toBe('warn')
    expect(cronKpiTone([...ok, { status: 'PARTIAL' }, { status: 'FAILED' }], 0)).toBe('bad')
    expect(cronKpiTone(ok, 1)).toBe('bad')
  })
  it('a row\'s status is a design-system Pill with the status in words, in its tone', () => {
    const html = renderToStaticMarkup(createElement(CronStatusPill, { status: 'PARTIAL' }))
    expect(html).toMatch(/class="nds-pill warning has-dot"/)
    expect(html).toContain('PARTIAL')
    expect(renderToStaticMarkup(createElement(CronStatusPill, { status: 'SUCCESS' }))).toMatch(/nds-pill success/)
  })
})
