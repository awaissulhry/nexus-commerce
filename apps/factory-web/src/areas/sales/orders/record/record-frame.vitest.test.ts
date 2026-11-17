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

// ---- B-TH-256: the order shows what points at it (O-SAL-ORD-REC.body-F07, .notice-F04, .notice-F06; picture 29) -----------------
describe('B-TH-256 — what points at the order', () => {
  it('Shipments & invoices lists the order’s complaints and returns, each a real link to its record, after the money', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('th-256-links', locale)
      const text = textOf(html)
      expect(text).toContain(locale === 'en' ? 'Complaints and returns' : 'Reclami e resi')
      for (const number of ['RCL-2026-0012', 'RCL-2026-0009', 'RMA-2026-0031']) expect(text).toContain(number)
      expect(html).toContain('/quality/complaints/0190f0e2-6501-7000-8000-000000000001')
      expect(html).toContain('/sales/returns/0190f0e2-6502-7000-8000-000000000001')
      expect(text).toContain(locale === 'en' ? 'Investigating' : 'In analisi')
      expect(text).toContain(locale === 'en' ? 'A replacement' : 'Una sostituzione')
    }
    const source = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/<MoneyTab order=\{order\} model=\{model\} actions=\{actions\} \/>\s*\{\/\*[^*]*\*\/\}\s*<PointsAtOrder/)
  })

  it('no complaints or returns: said in words, never an empty table; no right to either: nothing drawn (W27)', () => {
    const none = textOf(draw('th-256-links-none'))
    expect(none).toContain('No complaints about this order.')
    expect(none).toContain('No returns of this order.')
    const manager = textOf(draw('th-256-repromise-manager'))
    expect(manager).not.toContain('Complaints and returns')
    expect(manager).not.toContain('RCL-2026-0012')
  })

  it('planning’s re-promise in the one notice: the sizes from → to, who proposed it, Accept / Decline and the "Tell the customer" tick', () => {
    const html = draw('th-256-repromise')
    const text = textOf(html)
    expect(text).toContain('Planning proposes new dates for line 20 · AX-100')
    expect(text).toContain('Proposed by Paola Esempio')
    expect(text).toContain('Tell the customer')
    expect(text).toMatch(/50: 22\/12\/2026 → 12\/01\/2027/)
    for (const words of ['Accept', 'Decline…']) expect(text).toContain(words)
    // Inside the body column's notices, never above the thread.
    const notices = html.slice(html.indexOf('fw-rcf-notices-list'), html.indexOf('class="fw-so-main"'))
    expect(notices).toContain('Planning proposes new dates')
    expect(html.slice(html.indexOf('class="fw-rcf-dock"'))).not.toContain('Planning proposes new dates')
  })

  it('who may not decide (the production manager; the proposer) reads it with Accept and Decline held, and why', () => {
    const html = draw('th-256-repromise-manager')
    expect(textOf(html)).toContain('Planning proposes new dates for line 20')
    expect(html).toContain('Sales decides new dates (the right to manage orders), never the planner who proposed them.')
    expect(textOf(html)).not.toContain('Tell the customer')
  })

  it('Decline asks the reason the planner reads (held until typed); the typed reason stays', () => {
    const text = textOf(draw('th-256-decline'))
    expect(text).toContain('Decline the new dates for line 20?')
    expect(text).toContain('Il cliente ha già promesso la consegna al negozio.')
  })

  it('a compliance gate that blocks a work order: the gate’s own words, "Open in Compliance" only with the compliance view right', () => {
    const html = draw('th-256-gate')
    expect(textOf(html)).toContain('Work order release blocked: WO-2026-0140')
    expect(textOf(html)).toContain('No valid EU type-examination certificate covers AX-100')
    expect(html).toContain('/compliance/status?gate=WORK_ORDER_RELEASE&amp;feed=blocked&amp;days=30&amp;q=WO-2026-0140')
    const words = draw('th-256-repromise-manager')
    expect(textOf(words)).toContain('Work order release blocked: WO-2026-0140')
    expect(words).not.toContain('/compliance/status?gate=')
    expect(textOf(words)).toContain('Compliance clears or overrides it.')
  })

  it('the page reads the links with the order and again whenever it is read again; Accept and Decline go to planning’s routes', () => {
    const container = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("useOrderLinks(api, order.status === 'ready' ? order.value : null, () => void load())")
    const hook = readFileSync(new URL('./links/use-order-links.ts', import.meta.url), 'utf8')
    expect(hook).toContain('[api, orderId, version, attempt]')
    expect(hook).toContain('acceptRepromise(api, proposalId, { tell }, newIdempotencyKey())')
    expect(hook).toContain('const tell = proposal.may.tell && current.tell[proposalId] === true')
    expect(hook).toContain('declineRepromise(api, decline.proposalId, decline.reason, newIdempotencyKey())')
  })
})
