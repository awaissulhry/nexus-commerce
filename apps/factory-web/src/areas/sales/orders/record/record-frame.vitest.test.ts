import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { canOf } from '../_demo/fixtures'
import { MERGED_TABS, recordTabs, tabOf } from '../model'
import { designScreen } from './fixtures'

/**
 * B-TH-214 — the docked thread on the sales order (O-SAL-ORD-REC; picture 29): the band in the area row, ONE thread docked beside the
 * five tabs, Activity's tools in the thread's "⋯" (R-ACT), one notice, the old addresses (R-8).
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)

describe('the order on RecordFrame', () => {
  it('ONE thread on the page: the docked thread, no Activity tab and no record panels', () => {
    const html = draw('thread-docked')
    expect(html.match(/<aside/g)?.length).toBe(1)
    expect(html).toContain('class="fw-rt-column is-docked"')
    expect(html).not.toContain('fw-rp-tabs')
    expect(textOf(html)).not.toMatch(/\bActivity\b/)
  })

  it('R-ACT: the thread’s "⋯" is reachable on every tab (Activity’s tools moved there)', () => {
    for (const id of ['held-deposit', 'thread-docked', 'money-new', 'w2a-margin']) expect(draw(id), id).toContain('aria-label="Thread tools"')
  })

  it('the tabs 9 → 5: Lines · Production & dates · Shipments & invoices · Confirmation & changes · Margin (the margin grain only)', () => {
    const text = textOf(draw('thread-docked'))
    for (const tab of ['Lines', 'Production & dates', 'Shipments & invoices', 'Confirmation & changes', 'Margin']) expect(text).toContain(tab)
    expect(recordTabs(canOf('sales'))).toEqual(['lines', 'production', 'shipments', 'changes', 'margin'])
    expect(recordTabs(canOf('manager'))).toEqual(['lines', 'production', 'shipments', 'changes'])
    expect(textOf(draw('manager-lines'))).not.toMatch(/\bMargin\b/)
  })

  it('Production & dates hosts the production lane’s body as it is, then the promise, then the tech pack in force', () => {
    const html = draw('production-progress')
    const text = textOf(html)
    expect(html).toContain('class="fw-so-merged"')
    expect(text.indexOf('Work orders')).toBeGreaterThan(-1)
    const source = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/<ProductionTab order=\{order\} model=\{model\} actions=\{actions\} \/>\s*<DatesTab/)
    expect(source).toContain('<TechPackCard model={model.depth} actions={actions?.depth} />')
  })

  it('one notice: the most serious shows, the rest wait behind "N more notices" (never above the thread)', () => {
    const html = draw('notices')
    expect(html).toContain('class="fw-rcf-notices"')
    const body = html.slice(html.indexOf('class="fw-rcf-body"'), html.indexOf('<aside'))
    expect(body).toContain('fw-rcf-notices-list')
    const notices = html.slice(html.indexOf('fw-rcf-notices-list'), html.indexOf('class="fw-so-main"'))
    expect((notices.match(/class="nds-banner /g) ?? []).length).toBeGreaterThanOrEqual(2)
    const dock = html.slice(html.indexOf('<aside'))
    expect(dock).not.toContain('fw-rcf-notices')
  })

  it('every old ?tab= keeps working (R-8): the merged tab, Activity → Lines with the thread opened, Margin without the grain → Lines', () => {
    expect(MERGED_TABS).toEqual({ dates: 'production', money: 'shipments', documents: 'changes', activity: 'lines' })
    expect(tabOf('dates')).toBe('production')
    expect(tabOf('money')).toBe('shipments')
    expect(tabOf('documents')).toBe('changes')
    expect(tabOf('activity')).toBe('lines')
    expect(tabOf('shipments')).toBe('shipments')
    expect(tabOf('margin', canOf('manager'))).toBe('lines')
    expect(tabOf('margin', canOf('finance'))).toBe('margin')
  })

  it('the page mounts the office thread docked; the files leave the tabs (the thread’s Files view)', () => {
    const container = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).not.toContain('useThreadDock')
    const documents = readFileSync(new URL('./view/DocumentsTab.tsx', import.meta.url), 'utf8')
    expect(documents).not.toContain('?tab=activity')
    expect(documents).not.toContain('TechPackCard')
  })
})
