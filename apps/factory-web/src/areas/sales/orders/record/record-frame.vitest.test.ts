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
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
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
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    const body = html.slice(html.indexOf('class="fw-rcf-body"'), dockAt)
    expect(body).toContain('fw-rcf-notices-list')
    const notices = html.slice(html.indexOf('fw-rcf-notices-list'), html.indexOf('class="fw-so-main"'))
    expect((notices.match(/class="nds-banner /g) ?? []).length).toBeGreaterThanOrEqual(2)
    const dock = html.slice(dockAt)
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

  // ---- B-TH-228: an order made straight from a request names it (office only), never "Typed by the office" before it knows
  it('B-TH-228: "Made from INQ-… — Open" on the band and the request in the chain; nothing while the source is read', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('th-228-made-from', locale)
      expect(html).toContain('/sales/incoming/0190f0e2-5151-7000-8000-000000000041')
      expect(textOf(html)).toContain(locale === 'en' ? 'Made from INQ-2026-0041 — Open' : 'Creato da INQ-2026-0041 — Apri')
      expect(textOf(html)).toContain(locale === 'en' ? 'Made from request INQ-2026-0041 (no quote)' : 'Creato dalla richiesta INQ-2026-0041 (senza preventivo)')
      expect(textOf(html)).not.toContain(locale === 'en' ? 'Typed by the office' : "Inserito dall'ufficio")
    }
    const reading = textOf(draw('th-228-made-from-reading'))
    expect(reading).not.toContain('Typed by the office')
    expect(reading).not.toContain('Made from INQ')
  })
})
