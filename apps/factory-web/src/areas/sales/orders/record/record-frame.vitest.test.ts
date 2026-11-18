import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { canOf } from '../_demo/fixtures'
import { groupedMenu, landingOf, MENU_GROUPS, MERGED_TABS, recordTabs, tabOf } from '../model'
import { designScreen } from './fixtures'

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so a dialog's words are checked.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), createElement('p', null, subtitle as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

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

  // ---- F-SA-230: the tabs re-cut without losing anything ----
  it('F-SA-230: the tabs Lines · Production · Changes · Money · Shipments, the same for every role (Margin is a section of Money)', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('thread-docked', locale))
      const words = locale === 'en' ? ['Overview', 'Lines', 'Production', 'Changes', 'Money', 'Shipments', 'Files'] : ['Panoramica', 'Righe', 'Produzione', 'Modifiche', 'Importi', 'Spedizioni', 'File']
      for (const tab of words) expect(text, tab).toContain(tab)
      expect(text).not.toContain(locale === 'en' ? 'Shipments & invoices' : 'Spedizioni e fatture')
    }
    // F-SA-232: Overview first.
    // F-SA-237: + Files, last.
    expect(recordTabs(canOf('sales'))).toEqual(['overview', 'lines', 'production', 'changes', 'money', 'shipments', 'files'])
    expect(recordTabs(canOf('manager'))).toEqual(['overview', 'lines', 'production', 'changes', 'money', 'shipments', 'files'])
  })

  it('F-SA-230 / F-SA-234: Production hosts the work orders, then the dates and milestones (#dates), then the tech pack in force', () => {
    const html = draw('production-progress')
    expect(html).toContain('class="fw-so-merged"')
    expect(textOf(html).indexOf('Work orders')).toBeGreaterThan(-1)
    expect(html).toContain('id="dates"')
    const tab = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(tab).toMatch(/<WorkOrdersCard order=\{order\} model=\{model\} actions=\{actions\} \/>\s*<section id="dates"/)
    // F-SA-235: the tech pack in force is Production's "Specs in force" (inside the tab, no longer at its foot).
    expect(tab).toContain('<TechPackCard model={model.depth} actions={actions?.depth} />')
    // F-SA-234: today's Dates card merged into Production and deleted.
    expect(() => readFileSync(new URL('./view/DatesTab.tsx', import.meta.url), 'utf8')).toThrow()
  })

  it('F-SA-230: Money holds the deposit, the payment schedule, the invoices (#invoices) and the Margin section (#margin) only with the grain', () => {
    const finance = draw('w2a-margin')
    for (const id of ['id="invoices"', 'id="margin"']) expect(finance).toContain(id)
    expect(textOf(draw('money-new'))).toContain('Deposit')
    expect(draw('w2a-margin-no-grain')).not.toContain('id="margin"')
    // The money left Shipments: its foot says where it is.
    const shipments = textOf(draw('shipments'))
    expect(shipments).toContain('Invoices and payments are on Money ›')
    expect(shipments).not.toContain('Invoices and credit notes')
  })

  it('F-SA-236: Changes — waiting on us / on the customer, the confirmation as a row at #confirmation, the history, what can still change', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('w2b-323-documents', locale)
      expect(html).toContain('id="confirmation"')
      const text = textOf(html)
      for (const words of locale === 'en' ? ['Waiting on us', 'Waiting on the customer', "Confirmation & the customer's yes", 'Order confirmation v2', 'How the customer said yes', 'History', 'What can still change'] : ['Tocca a noi', 'Tocca al cliente', 'Conferma e sì del cliente', "Conferma d'ordine v2", 'Cronologia', 'Cosa si può ancora cambiare']) expect(text, words).toContain(words)
    }
    expect(draw('w2b-323-documents')).not.toMatch(/min\(70vh/)
    expect(landingOf('documents')).toMatchObject({ tab: 'changes', anchor: 'confirmation' })
  })

  it('F-SA-230: the band — the health chip only when Late (never "On track"), no "Late N days" banner; Made to measure on an MTM order', () => {
    const late = draw('dates')
    const band = late.slice(0, late.indexOf('class="fw-rcf-body"'))
    expect(textOf(band)).toMatch(/Late · \d+ d/)
    expect(readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')).not.toContain("'record.late'")
    expect(textOf(draw('sales-lines'))).not.toMatch(/Late · \d+ d|On track/)
  })

  it('F-SA-230: ⋯ grouped — Next steps · Edit · People · Go to · Copy, each heading only over items, Cancel last after a rule', () => {
    expect(MENU_GROUPS).toEqual(['next', 'edit', 'people', 'goTo', 'copy'])
    const menu = groupedMenu({ next: [{ id: 'promise' }], people: [{ id: 'assignSupervisor' }, { id: 'askSupervisor' }], copy: [{ id: 'copy' }] }, [{ id: 'cancel' }], (group) => group.toUpperCase())
    expect(menu.map((entry) => entry.id)).toEqual(['head-next', 'promise', 'sep-people', 'head-people', 'assignSupervisor', 'askSupervisor', 'sep-copy', 'head-copy', 'copy', 'sep-danger', 'cancel'])
    expect(groupedMenu({}, [], String)).toEqual([])
    const source = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(source).toContain('<AssignSupervisorDialog model={model.people.assign}')
    expect(source).toContain('<NoteDialog model={model.people.note}')
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

  it('F-SA-230: every old ?tab= keeps working (R-8): its new tab and section; Activity → the first tab with the thread; never Object’s own names', () => {
    expect(Object.keys(MERGED_TABS).sort()).toEqual(['activity', 'confirmation', 'dates', 'documents', 'invoices', 'margin'])
    expect(landingOf('dates')).toEqual({ tab: 'production', anchor: 'dates', moved: true })
    expect(landingOf('invoices')).toEqual({ tab: 'money', anchor: 'invoices', moved: true })
    expect(landingOf('margin', canOf('finance'))).toEqual({ tab: 'money', anchor: 'margin', moved: true })
    expect(landingOf('margin', canOf('manager'))).toEqual({ tab: 'money', anchor: null, moved: true })
    expect(landingOf('documents')).toEqual({ tab: 'changes', anchor: 'confirmation', moved: true })
    expect(landingOf('confirmation')).toEqual({ tab: 'changes', anchor: 'confirmation', moved: true })
    // Activity stays in the address (the frame opens the thread from it) and shows the first tab.
    // F-SA-232: no address (or an unknown one) → Overview; Activity → Overview with the thread.
    expect(landingOf('activity')).toEqual({ tab: 'overview', anchor: null, moved: false })
    for (const tab of ['overview', 'lines', 'production', 'changes', 'money', 'shipments', 'files']) expect(landingOf(tab)).toEqual({ tab, anchor: null, moved: false })
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nope', '']) expect(landingOf(name), name).toEqual({ tab: 'overview', anchor: null, moved: false })
    expect(tabOf(null)).toBe('overview')
    // The page writes the new address (Back keeps it): OrderRecord replaces an old id with its tab and #section.
    const container = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("router.replace(`${pathname}?${next.toString()}${landing.anchor ? `#${landing.anchor}` : ''}`, { scroll: false })")
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
  it('Shipments lists the order’s complaints and returns, each a real link to its record, after the money', () => {
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
    // F-SA-230: Complaints & returns are Shipments' last section (the money moved to Money).
    const source = readFileSync(new URL('./view/ShipmentsTab.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/\{delivered\}\s*<PointsAtOrder model=\{model\.links\}/)
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
