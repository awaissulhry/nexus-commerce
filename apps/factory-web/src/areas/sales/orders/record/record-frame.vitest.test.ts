import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url' // F-OP-134
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { leftKeys, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { canOf } from '../_demo/fixtures'
import { groupedMenu, landingOf, MENU_GROUPS, MERGED_TABS, recordTabs, tabOf } from '../model'
import { DOCK_DEFAULTS, RECORD_TABS } from '../model' // F-SA-263
import { defaultWidthAt } from '../../../_shared/record-frame/model' // F-SA-263
import { designScreen } from './fixtures'
// F-SA-262: the order dock's scope (the pick of ONE conversation)
import { choiceOfScope, choicesOffered, ORDER_SCOPE, SCOPE_PARAM, scopeOfChoice, scopeOfParam, scopeParamOf, scopeShown, workOrderGroups } from './dock/model'
import { scopeValueOf } from './dock/model' // F-OP-209
import { offerOf } from './dock/model' // F-OP-213
import { withThread } from '../../../_shared/record-frame/address' // F-OP-209
import { tabAddress, tabHref } from '../../../_shared/record-frame/address' // F-OP-210
import { viewOpenOf } from '../../../_shared/record-frame/model'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import type { BandDialog, ChangesDialog, LinesDialog, MoneyDialog, OverviewDialog, RecordDialog } from './record-model' // F-OP-134, F-OO-210
import type { StageHandDialog } from './record-model' // F-MS-102 (ms-fx1): the stage set by hand's dialogs (use-overview-acts)
// ---- F-OO-111: the banners on Overview and the band's "Who answers the customer…" ----
import { order } from '../_demo/fixtures'
import { base } from './fixtures'
import { answerHeldOf, OWNER_WORDS_NS } from './overview/people'
import { rightRef } from '../../../../lib/i18n/rights'
// ---- end F-OO-111
// ---- Z02 cleanups (W08's and W11's notes): the ONE waiting call's input, the date rows' door, the credit Check dialog under live ----
import { orderWaitingOf } from './overview/model'
import type { WaitDate } from './overview/dates'
import type { Order } from '../api'
// ---- end Z02 cleanups

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
    // F-PT-101: Production now first, then Work orders (each its own section file), then the dates (#dates).
    // F-PT-201: the dates are Dates & plan's own section file (#dates).
    expect(tab).toMatch(/<NowSection order=\{order\} model=\{model\} actions=\{actions\} \/>\s*<WorkOrdersSection order=\{order\} model=\{model\} actions=\{actions\} \/>\s*<DatesSection order=\{order\} model=\{model\} actions=\{actions\} \/>/)
    expect(html.indexOf('id="now"')).toBeLessThan(html.indexOf('id="work-orders"'))
    expect(html.indexOf('id="work-orders"')).toBeLessThan(html.indexOf('id="dates"'))
    // F-SA-235 → F-PT-402: the tech pack in force is What we make it to's own half (#specs), inside the tab.
    expect(tab).toContain('<MakeToSection order={order} model={model} actions={actions} />')
    expect(html).toContain('id="specs"')
    // F-SA-234: today's Dates card merged into Production and deleted.
    expect(() => readFileSync(new URL('./view/DatesTab.tsx', import.meta.url), 'utf8')).toThrow()
  })

  // F-OM-101 (rewrites F-SA-230): Money is the answer line and five sections that stack — Totals, Payments (the ONE plan: #deposit and
  // #schedule land on it), Invoices & credit notes (invoices.view), Price check (the price grain), Margin (the margin grain).
  it('F-OM-101: Money — Totals, Payments (#deposit, #schedule), Invoices (#invoices) and Margin (#margin) only with the grain, in that order', () => {
    const finance = draw('w2a-margin')
    for (const id of ['id="totals"', 'id="payments"', 'id="deposit"', 'id="schedule"', 'id="invoices"', 'id="margin"']) expect(finance, id).toContain(id)
    expect(finance.indexOf('id="totals"')).toBeLessThan(finance.indexOf('id="payments"'))
    expect(finance.indexOf('id="payments"')).toBeLessThan(finance.indexOf('id="invoices"'))
    expect(finance.indexOf('id="invoices"')).toBeLessThan(finance.indexOf('id="margin"'))
    expect(finance).toContain('class="fw-pt fw-om"')
    // The deposit is the plan's first step: its row, its anchor (the dock's "Show on the page").
    const fresh = draw('money-new')
    expect(textOf(fresh)).toContain('Deposit')
    expect(fresh).toContain('id="about-DepositRequest-')
    expect(draw('w2a-margin-no-grain')).not.toContain('id="margin"')
    // Without invoices.view the section is not drawn: the head says it once.
    const manager = draw('manager-money')
    expect(manager).not.toContain('id="invoices"')
    expect(textOf(manager)).toContain('Invoices are shown to people who see invoices.')
    expect(textOf(manager)).toContain('Amounts are shown to people who see prices.')
    // The money left Shipments: its foot says where it is.
    const shipments = textOf(draw('shipments'))
    expect(shipments).toContain('Invoices and payments are on Money ›')
    expect(shipments).not.toContain('Invoices and credit notes')
  })

  // F-OC-101: rewritten — four sections: Waiting (nothing waits here: its head's one line), Can it still change?, What changed, the
  // customer's agreement at #confirmation; Waiting first and the confirmation last.
  it('F-SA-236: Changes — Waiting, what can still change, the history, the confirmation as a row at #confirmation', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('w2b-323-documents', locale)
      for (const id of ['id="waiting"', 'id="freeze"', 'id="history"', 'id="confirmation"']) expect(html, id).toContain(id)
      expect(html.indexOf('id="waiting"')).toBeLessThan(html.indexOf('id="freeze"'))
      expect(html.indexOf('id="history"')).toBeLessThan(html.indexOf('id="confirmation"'))
      const text = textOf(html)
      // F-OC-203: the last section is the Customer's agreement — their yes and our confirmation.
      for (const words of locale === 'en' ? ['Waiting', 'Nothing waits.', "Customer's agreement", 'Their yes', 'Our confirmation', 'What changed', 'Can it still change?'] : ['In attesa', 'Niente in attesa.', 'Accordo del cliente', 'Il loro sì', 'La nostra conferma', 'Cosa è cambiato', 'Si può ancora cambiare?'] /* F-OC-301: History is What changed */) expect(text, words).toContain(words)
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
    // F-OP-210: through tabAddress (the dock's scope kept).
    const container = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain('router.replace(tabAddress(pathname, window.location.search, landing.tab, { anchor: landing.anchor, arrival: true }), { scroll: false })')
    // An arrival keeps every term as it came: the frame and the thread read `new`, `open` and the message after it.
    expect(tabAddress('/w/DEMO/sales/orders/o1', '?tab=dates&thread=new&message=m1', 'production', { anchor: 'dates', arrival: true })).toBe('/w/DEMO/sales/orders/o1?tab=production&thread=new&message=m1#dates')
  })

  it('the page mounts the office thread docked; the files leave the tabs (the thread’s Files view)', () => {
    const container = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).not.toContain('useThreadDock')
    // F-OC-203: the customer's yes and our confirmation are the Changes tab's Customer's agreement (the old Documents card went).
    const documents = readFileSync(new URL('./changes/view/AgreementSection.tsx', import.meta.url), 'utf8')
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
      // F-OS-104: one list, newest first, both kinds; the closed complaint folds behind "Show 1 closed".
      for (const number of ['RCL-2026-0012', 'RMA-2026-0031']) expect(text).toContain(number)
      expect(text).not.toContain('RCL-2026-0009')
      expect(text).toContain(locale === 'en' ? 'Show 1 closed' : 'Mostra 1 chiuso')
      expect(html).toContain('/quality/complaints/0190f0e2-6501-7000-8000-000000000001')
      expect(html).toContain('/sales/returns/0190f0e2-6502-7000-8000-000000000001')
      expect(text).toContain(locale === 'en' ? 'Investigating' : 'In analisi')
      expect(text).toContain(locale === 'en' ? 'A replacement' : 'Una sostituzione')
    }
    // F-SA-230 → F-OS-104: Complaints & returns are the Shipments tab's last section, after Shipments (the money moved to Money).
    const source = readFileSync(new URL('./view/ShipmentsTab.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/<ShipmentsSection [^>]*\/>[\s\S]*<AfterSalesSection [^>]*\/>/)
    expect(source).not.toContain('PointsAtOrder')
  })

  it('no complaints or returns: said in words, never an empty table; no right to either: nothing drawn (W27)', () => {
    // F-OS-104: one quiet line for the one list (never an empty table).
    const none = textOf(draw('th-256-links-none'))
    expect(none).toContain('Nothing reported for this order.')
    const manager = textOf(draw('th-256-repromise-manager'))
    expect(manager).not.toContain('Complaints and returns')
    expect(manager).not.toContain('RCL-2026-0012')
  })

  it('planning’s re-promise in the one notice: the sizes from → to, who proposed it, Accept / Decline and the "Tell the customer" tick', () => {
    // F-PT-201 (W2): on a tab other than Production it is the page's one notice …
    const html = draw('th-256-repromise-overview')
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
    // … and on Production it is Dates & plan's own (the page notice steps back: never twice), with the same doors.
    const production = draw('th-256-repromise')
    const at = production.indexOf('Planning proposes new dates')
    expect(at).toBeGreaterThan(production.indexOf('id="dates"'))
    expect(production.indexOf('id="dates"')).toBeGreaterThan(-1)
    const noticesAt = production.indexOf('fw-rcf-notices-list')
    if (noticesAt > -1) expect(production.slice(noticesAt, production.indexOf('class="fw-so-main"'))).not.toContain('Planning proposes new dates')
    for (const words of ['Accept', 'Decline…', 'Tell the customer']) expect(textOf(production.slice(at)), words).toContain(words)
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

// ---- F-OS-101 (order SHIPMENTS tab, 10-design §1; plan D1; 18-lead-settles L5, L10): the tab's one answer, then three sections ----
describe('F-OS-101 — the Shipments tab: its answer, then #left · #shipments (the old #deliveries lands there) · #after-sales', () => {
  it('in that order, in the Production kit\'s room container (the dock re-lays it live); the Money door stays at its foot', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('th-256-links', locale)
      // F-OS-W3 step 0: an element's own id (a leading space) — the tab bar's `data-tab-id="shipments"` comes first on the page.
      const at = (id: string) => html.indexOf(` id="${id}"`)
      for (const id of ['left', 'shipments', 'deliveries', 'after-sales']) expect(at(id), id).toBeGreaterThan(-1)
      expect(at('left')).toBeLessThan(at('shipments'))
      expect(at('shipments')).toBeLessThan(at('deliveries'))
      expect(at('deliveries')).toBeLessThan(at('after-sales'))
      expect(html).toContain('class="fw-pt fw-os"')
      expect(textOf(html)).toContain(locale === 'en' ? 'Where every garment is' : 'Dove si trova ogni capo')
    }
    const tab = readFileSync(new URL('./view/ShipmentsTab.tsx', import.meta.url), 'utf8')
    // The layout only: the sections are their own files; the Money lane's foot door (F-OM-104) kept as it was.
    for (const part of ['<ShipmentsHead ', '<WhereSection ', '<ShipmentsSection ', '<AfterSalesSection ', "{t('ship.moneyDoor')}"]) expect(tab, part).toContain(part)
    expect(tab).not.toMatch(/SummaryTable|SizeGridView|useState/)
  })

  it('L10: Create shipment… once on this tab — the band skips its primary and its ⋯ item here, and keeps them on every other tab', () => {
    const view_ = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view_).toContain("const step: NextStep = shipmentsTab && bandStep.kind === 'createShipment' ? { kind: null, held: null } : bandStep")
    expect(view_.match(/!shipmentsTab \/\* F-OS-101 \(L10\) \*\//g)?.length).toBe(2)
  })

  it('L11: the tab\'s own words are a namespace of their own, loaded with the page', async () => {
    const { RECORD_NAMESPACES } = await import('./OrderRecord')
    expect(RECORD_NAMESPACES).toContain('order-shipments')
  })
})
// ---- end F-OS-101

// ── F-SA-243 (sales page plan P5, R1; 14-change-flow §3.1, §3.4; review R-5): the order page's doors to the ONE review window ──
describe('F-SA-243: the order page opens the same review window as Home › Approvals, and keeps Still to do', () => {
  it('the band: "<Customer> asks: … · Answer…" (the oldest waiting on us, "1 more request"), a real link to ?open= on this page', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('f-sa-243-band', locale)
      const text = textOf(html)
      expect(text).toContain(locale === 'en' ? 'asks: Change · line 10 · JKT-DEMO-01 · Nero · 50: 6 → 4' : 'chiede: Modifica · riga 10 · JKT-DEMO-01 · Nero · 50: 6 → 4') // fx6 (walk 5): each line once, its style and colour
      expect(text).toContain(locale === 'en' ? '1 more request' : '1 altra richiesta')
      expect(text).toContain(locale === 'en' ? 'Answer…' : 'Rispondi…')
      expect(text).toContain(locale === 'en' ? 'Still to do · 2' : 'Ancora da fare · 2') // F-OO-205: the group's head
    }
    expect(draw('f-sa-243-band')).toMatch(/href="[^"]*\?tab=changes&amp;open=/)
    // Only while a row asks THIS reader (Your turn / Needs a decision) the band says a step needs a decision (R-5).
    expect(textOf(draw('f-sa-243-band'))).toMatch(/1 step needs a decision/)
    expect(textOf(draw('f-sa-243-nothing-mine'))).not.toMatch(/needs? a decision/)
  })

  it('Changes: Answer… on each waiting request (no more "Answer in Approvals ›"), Still to do under its change with state, owner and door', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('f-sa-243-changes', locale))
      // F-OC-104: each row says who does it (the team's words) beside "Your turn" — the old state pill went.
      for (const words of locale === 'en' ? ['Still to do · 2', 'Your turn', 'Planning', 'WO-00021: make 50 6 → 4'] : ['Ancora da fare · 2', 'Tocca a te', 'Pianificazione']) expect(text, words).toContain(words)
      expect(text).not.toContain(locale === 'en' ? 'Answer in Approvals' : 'Rispondi in Approvazioni')
    }
    const html = draw('f-sa-243-changes')
    expect(html).toContain('id="still-to-do"')
    // op-fx1: F-OP-116 — the work-order change is decided in place (the ONE decide window on this page), no longer a link to Home ›
    // Approvals. F-OC-104 (L1): ONE Decide… for who may decide (the same door as Production's strip); the scrap's link stays.
    expect(textOf(html).match(/Decide…/g)).toHaveLength(1)
    expect(textOf(html)).not.toMatch(/Apply…|Leave as is…/)
    expect(html).not.toContain('/home/approvals?open=0190f0e2-9090-7000-8000-000000000001')
    expect(textOf(draw('f-sa-243-nothing-mine'))).toContain('1 work order not shown')
  })

  it('the pure parts: the request in words, the band only for rows that ask me, rows grouped under their change, each row’s door', async () => {
    const { askingOf, askWordsOf, decisionBandOf, stillDoorOf, stillGroupsOf } = await import('./changes/model')
    const say = (key: string, params?: Record<string, string | number>) => `${key}:${JSON.stringify(params ?? {})}`
    const request = { kind: 'CHANGE' as const, wholeOrder: false, requestedDate: null, cells: [1, 2, 3, 4].map((seq) => ({ lineId: `l${seq}`, seq, style: null, colourway: null, size: 'M', before: 4, asked: 2, askedColourway: null })) }
    // fx6 (walk 5): each line once with its sizes — the kind, three lines (line + size), "…"; a date alone is the date asked.
    expect(askWordsOf(request, { kind: 'Change', say, day: String }).split(' · ')).toHaveLength(8)
    expect(askWordsOf({ kind: 'CHANGE', wholeOrder: false, requestedDate: '2026-12-22', cells: [] }, { kind: 'Change', say, day: String })).toBe('changesTab.request.date:{"date":"2026-12-22"}')
    expect(askingOf([])).toBeNull()
    const rows = [
      { kind: 'WORK_ORDER_CHANGE', ref: { type: 'WorkOrderChange', id: 'c1', number: null }, words: { en: 'a', it: 'a' }, since: '2026-11-17T13:02:00Z', waitingOn: 'PLANNER', mayAct: false, requestId: 'r1' },
      { kind: 'REPROMISE', ref: { type: 'RePromise', id: 'p1', number: null }, words: { en: 'b', it: 'b' }, since: '2026-11-17T14:00:00Z', waitingOn: 'SALES', mayAct: true, requestId: null },
    ]
    expect(decisionBandOf(rows)).toEqual({ count: 1, since: '2026-11-17T14:00:00Z', requestId: null })
    expect(decisionBandOf(rows.map((row) => ({ ...row, mayAct: false })))).toBeNull()
    expect(stillGroupsOf(rows, []).map((group) => group.requestId)).toEqual(['r1', null])
    const place = { prefix: '/w/DEMO', record: '/w/DEMO/sales/orders/o1', address: (ref: { type: string; id: string }) => `/records/${ref.type}/${ref.id}` }
    expect(stillDoorOf(rows[0]!, place)).toBe('/w/DEMO/home/approvals?open=c1')
    expect(stillDoorOf(rows[1]!, place)).toBe('/w/DEMO/sales/orders/o1?tab=overview')
    expect(stillDoorOf({ kind: 'TELL_WORKSHOP', ref: null }, place)).toBeNull()
  })

  it('the page mounts the door (?open= in its own address, the tab kept: Esc returns to the same tab and scroll), the window and Decide for <customer>', async () => {
    const page = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain('useRequestReviewDoor({')
    expect(page).toContain('orderId: readyId,')
    expect(page).toContain('<CustomerOverrideProvider')
    const view = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<RequestDoorWindow door={model.requestDoor.parts} />')
    expect(view).toContain('<RequestBandNotices order={order} model={model} />')
    const { doorAddress } = await import('../../../home/approvals/requests/model')
    expect(doorAddress('?tab=changes', 'r1')).toBe('?tab=changes&open=r1')
    expect(doorAddress('?tab=changes&open=r1', null)).toBe('?tab=changes')
    const section = readFileSync(new URL('./view/RequestsSection.tsx', import.meta.url), 'utf8')
    expect(section).not.toContain('/home/approvals`}>{t(\'changes.onUs.answer\')}')
  })

  it('every new word in it + en (the band, Still to do, the amend review tick)', async () => {
    const { CATALOGUE, placeholdersOf } = await import('../../../../lib/i18n/messages')
    const keys = ['band.asks', 'band.answer', 'band.answerNone', 'changesTab.request.size', 'changesTab.request.date', 'band.askLine', 'band.askWhole', 'band.moreRequests_one', 'band.moreRequests_other', 'band.decision_one', 'band.decision_other', 'band.open', /* F-OC-304: the old Still to do card's title, Open and Made extra went */ 'changes.still.since', 'changes.still.none', 'changes.still.changeOf', 'changes.still.office', 'changes.still.leftOut_one', 'changes.still.leftOut_other', 'overview.requests.still', 'amend.tell.words', 'amend.tell.hint', /* F-OP-106: the told notice names the work orders */ 'edit.done.plainTold', 'notice.amendedNotTold', 'notice.amendedNotReached']
    for (const key of keys) {
      expect(CATALOGUE.en.orders?.[key]?.trim(), `en ${key}`).toBeTruthy()
      expect(CATALOGUE.it.orders?.[key]?.trim(), `it ${key}`).toBeTruthy()
      expect(placeholdersOf(CATALOGUE.it.orders?.[key] ?? ''), key).toEqual(placeholdersOf(CATALOGUE.en.orders?.[key] ?? ''))
    }
    expect(CATALOGUE.en.orders?.['changes.onUs.answer']).toBeUndefined()
  })
})
// ── end F-SA-243 ──

// ---- F-SA-263 (sales page plan N6, P11; 10-order-page §5): the order's dock, each tab its own default width ----------------------
describe('F-SA-263 — the order’s dock: each tab its own default width, the person’s choice kept per tab', () => {
  // F-OP-301 (walk #5): ONE dock width per viewport — the dock never changes its width when the page tab changes.
  it('F-OP-301: one width per viewport on every tab — a third under 1600 px, 40 % from 1600 (the grid rule)', () => {
    expect(Object.keys(DOCK_DEFAULTS).sort()).toEqual([...RECORD_TABS].sort())
    const at = (viewport: number) => new Set(RECORD_TABS.map((tab) => defaultWidthAt(DOCK_DEFAULTS[tab], viewport)))
    for (const viewport of [1280, 1440, 1599]) expect([...at(viewport)], String(viewport)).toEqual(['third'])
    for (const viewport of [1600, 1920]) expect([...at(viewport)], String(viewport)).toEqual(['forty'])
  })

  it('F-OP-301: the page draws every tab at the same width (nothing chosen yet): Production, Changes and Money a third at 1440', () => {
    expect(draw('thread-docked')).toContain('data-width="third"')
    expect(draw('documents')).toContain('data-width="third"')
    expect(draw('money-new')).toContain('data-width="third"')
  })

  it('the order names its tab to the frame (the width kept per tab, "hidden" per person on every order)', () => {
    const view = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('defaultWidth={DOCK_DEFAULTS[model.tab]}')
    expect(view).toContain('dockTab={model.tab}')
    expect(view).not.toContain('isWideTab')
  })
})
// ---- end F-SA-263

// ---- F-SA-262 (sales page plan N4; picks P9, P9', R4, R9; 10-order-page §6.1; review C-13): the order dock's scope picker
describe('F-SA-262 — the order dock picks ONE conversation, the scope in the address', () => {
  const P = '22222222-2222-4222-8222-222222222222'
  const W = '33333333-3333-4333-8333-333333333333'
  it('?thread=general|project:<id>|wo:<id>|all; none, `open`, `new` or a made-up value: this order\'s own', () => {
    expect(SCOPE_PARAM).toBe('thread')
    expect(scopeOfParam('general')).toEqual({ kind: 'general' })
    expect(scopeOfParam('all')).toEqual({ kind: 'all' })
    expect(scopeOfParam(`project:${P}`)).toEqual({ kind: 'project', id: P })
    expect(scopeOfParam(`wo:${W}`)).toEqual({ kind: 'wo', id: W })
    for (const value of [null, '', 'open', 'new', 'wo:not-an-id', 'project:', 'Party']) expect(scopeOfParam(value), String(value)).toEqual(ORDER_SCOPE)
    expect(scopeParamOf(ORDER_SCOPE)).toBeNull()
    expect(scopeParamOf({ kind: 'wo', id: W })).toBe(`wo:${W}`)
    expect(scopeParamOf({ kind: 'project', id: P })).toBe(`project:${P}`)
  })
  // F-OP-209: the address is the frame's ONE writer's (rf/address.ts withThread); the dock gives it the scope's value.
  it('a replace keeps every other term; the narrow view stays open (`open` for this order); a line of All of opens at its message', () => {
    const base = '/w/DEMO/sales/orders/o1'
    const at = (search: string, scope: Parameters<typeof scopeValueOf>[0], narrow: boolean, message: string | null = null) => withThread(`${base}${search}`, scopeValueOf(scope, narrow), { message })
    expect(at('?tab=lines', { kind: 'general' }, false)).toBe(`${base}?tab=lines&thread=general`)
    expect(at('?tab=lines&thread=general', ORDER_SCOPE, false)).toBe(`${base}?tab=lines`)
    expect(at('?tab=lines&thread=general', ORDER_SCOPE, true)).toBe(`${base}?tab=lines&thread=open`)
    expect(at('?tab=lines&thread=all&message=m1', { kind: 'wo', id: W }, false)).toBe(`${base}?tab=lines&thread=wo%3A${W}`)
    expect(at('?thread=all', ORDER_SCOPE, false, 'm7')).toBe(`${base}?message=m7`)
  })
  it('the frame keeps the narrow view open while a scope is in the address (Back keeps the scope)', () => {
    expect(viewOpenOf('open')).toBe(true)
    expect(viewOpenOf('general')).toBe(true)
    expect(viewOpenOf(`wo:${W}`)).toBe(true)
    expect(viewOpenOf('new')).toBe(false)
    expect(viewOpenOf(null)).toBe(false)
  })
  it('only what the reader may read is offered; a scope not offered shows this order\'s own, with no word that it existed', () => {
    const offer = { general: true, all: true, projects: [P], workOrders: [W] }
    expect(choicesOffered(offer)).toEqual(['order', 'general', 'projects', 'workOrders', 'all'])
    // Without workorders.view (no work orders given) and no project: no such segment.
    expect(choicesOffered({ ...offer, projects: [], workOrders: [] })).toEqual(['order', 'general', 'all'])
    expect(scopeShown({ kind: 'wo', id: W }, offer)).toEqual({ kind: 'wo', id: W })
    expect(scopeShown({ kind: 'wo', id: 'another-customers-work-order' }, offer)).toEqual(ORDER_SCOPE)
    expect(scopeShown({ kind: 'wo', id: W }, { ...offer, workOrders: [] })).toEqual(ORDER_SCOPE)
    expect(scopeShown({ kind: 'project', id: 'not-linked' }, offer)).toEqual(ORDER_SCOPE)
    expect(scopeShown({ kind: 'general' }, { ...offer, general: false })).toEqual(ORDER_SCOPE)
    expect(choiceOfScope({ kind: 'project', id: P })).toBe('projects')
    expect(choiceOfScope({ kind: 'wo', id: W })).toBe('workOrders')
    expect(choiceOfScope(ORDER_SCOPE)).toBe('order')
  })
  it('a segment picks the project or work order last shown, else the first', () => {
    const offer = { general: true, all: true, projects: ['p1', 'p2'], workOrders: ['w1', 'w2'] }
    expect(scopeOfChoice('projects', offer, { project: null, wo: null })).toEqual({ kind: 'project', id: 'p1' })
    expect(scopeOfChoice('projects', offer, { project: 'p2', wo: null })).toEqual({ kind: 'project', id: 'p2' })
    expect(scopeOfChoice('workOrders', offer, { project: null, wo: 'w2' })).toEqual({ kind: 'wo', id: 'w2' })
    expect(scopeOfChoice('workOrders', offer, { project: null, wo: 'gone' })).toEqual({ kind: 'wo', id: 'w1' })
    expect(scopeOfChoice('all', offer, { project: null, wo: null })).toEqual({ kind: 'all' })
    expect(scopeOfChoice('order', offer, { project: null, wo: null })).toEqual(ORDER_SCOPE)
  })
  it('made-to-measure units: the work orders grouped per style × colourway (R9)', () => {
    const groups = workOrderGroups([
      { id: 'w1', number: 'WO-1', style: 'JKT-01 · Rider jacket', colourway: 'Black' },
      { id: 'w2', number: 'WO-2', style: 'JKT-01 · Rider jacket', colourway: 'Red' },
      { id: 'w3', number: 'WO-3', style: 'JKT-01 · Rider jacket', colourway: 'Black' },
    ])
    expect(groups.map((group) => [group.label, group.items.map((item) => item.number)])).toEqual([
      ['JKT-01 · Rider jacket · Black', ['WO-1', 'WO-3']],
      ['JKT-01 · Rider jacket · Red', ['WO-2']],
    ])
    // The units of a made-to-measure line: their own group (never mixed with the line's grid work orders).
    const units = workOrderGroups([
      { id: 'w1', number: 'WO-1', style: 'SUIT-01', colourway: 'Black' },
      { id: 'u1', number: 'WO-7', style: 'SUIT-01', colourway: 'Black', mtm: true },
      { id: 'u2', number: 'WO-8', style: 'SUIT-01', colourway: 'Black', mtm: true },
    ])
    expect(units.map((group) => group.items.map((item) => item.number))).toEqual([['WO-1'], ['WO-7', 'WO-8']])
    // The units come from the order's chain only when the read left no work order out (a unit is never told from one out of reach).
    const page = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain('work.workOrdersLeftOut === 0 && unitCount > 0')
  })
  it('the dock: ThreadPick, the work order\'s notes office only (no party: never shared, the floor tick), drafts per conversation', () => {
    const dock = readFileSync(new URL('./dock/OrderDock.tsx', import.meta.url), 'utf8')
    expect(dock).toContain('<ThreadPick label={t(\'record.dock.label\')}')
    // Each conversation is its own thread (its own key: its own server draft and this device's), the box on Office note (rule 34).
    for (const key of ['key="order"', 'key="general"', 'key={`project-${project.id}`}', 'key={`wo-${workOrder.id}`}']) expect(dock).toContain(key)
    const wo = dock.slice(dock.indexOf("scope.kind === 'wo' && workOrder"), dock.indexOf("scope.kind === 'all'", dock.indexOf("scope.kind === 'wo' && workOrder")))
    expect(wo).toContain("record={{ type: 'WorkOrder'")
    expect(wo).toContain('party={null}')
    // Work orders only with workorders.view, from the production read (this reader's wall).
    expect(dock).toContain("const seesWork = held.includes('workorders.view')")
    // All of <customer>: read only, "Write in: This order · General".
    expect(dock).toContain('<AllOfCustomerDock') // F-OP-204: the card with its Head
    expect(dock).toContain('actions={{ ...feed.actions, onAnswer, writeFirst, canAnswer, ...(frame?.compose ? { onCompose: frame.compose } : {}) /* F-OP-207 */ }}')
    expect(dock).toContain("t('record.dock.writeIn')")
    // F-OP-209: the scope is written by the frame's ONE writer (a history replace: Back keeps it; no router.replace).
    expect(dock).toContain('frame?.setThread?.(scopeValueOf(next, narrow), { message: messageId })')
    expect(dock).not.toContain('router.replace')
    const page = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain('<OrderDock')
  })
  it('ONE set of choice words with the customer page (C-13), in both languages, the catalogue\'s "conversazione" (R9)', () => {
    for (const locale of LOCALES) {
      const o = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const p = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      for (const [order, party] of [
        ['record.dock.label', 'customers.work.dock.label'],
        ['record.dock.general', 'customers.work.dock.general'],
        ['record.dock.generalLine', 'customers.work.dock.generalLine'],
        ['record.dock.all', 'customers.work.dock.all'],
        ['record.dock.readOnly', 'customers.work.dock.readOnly'],
      ] as const)
        expect(o(order, { customer: 'Brand Alpha' }), `${locale} ${order}`).toBe(p(party, { customer: 'Brand Alpha' }))
      for (const key of ['order', 'orderLine', 'projects', 'projectLine', 'projectPick', 'workOrders', 'workOrderLine', 'workOrderPick', 'writeIn', 'writeGeneral'])
        expect(o(`record.dock.${key}`, { customer: 'Brand Alpha', project: 'PRJ-1', wo: 'WO-1' }), `${locale} ${key}`).not.toBe(`record.dock.${key}`)
      expect(o('record.dock.withNew', { label: 'This order', count: 2 }), locale).toContain('2')
    }
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it('record.dock.label')).toBe('Quale conversazione')
    expect(it('record.dock.workOrders')).toBe('Ordini di lavoro')
  })
})
// ---- end F-SA-262

// ---- F-OP-134 (N-5): the order page's acts live in one container hook per tab; the views draw what they return -------------------
describe('F-OP-134 — one acts hook per tab, mounted by the container, never by a view', () => {
  const HOOKS = ['use-band-acts', 'use-overview-acts', 'use-lines-acts', 'use-lines-draft' /* F-OL-03 */, 'use-production-acts', 'use-shipments-acts', 'use-money-acts'] as const
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  /** Every file in a `view/` folder under record/ (the views draw one model and fetch nothing). */
  const views = (dir: URL): string[] =>
    readdirSync(dir).flatMap((name) => {
      const at = new URL(name, dir)
      if (statSync(at).isDirectory()) return views(new URL(`${name}/`, dir))
      return /\.tsx?$/.test(name) && !name.includes('.vitest.') && at.pathname.includes('/view/') ? [fileURLToPath(at)] : []
    })

  it('the container mounts every tab acts hook, with the one write, and hands the view what they return', () => {
    const container = source('./OrderRecord.tsx')
    for (const hook of HOOKS) expect(container, hook).toContain(`from './${hook}'`)
    expect(container).toContain('const actsBase: RecordActsBase = { api, orderId, current, write, version, setNotice, load, loadParts }')
    for (const spread of ['...band.model', '...overview.model', '...lines.model', '...productionActs.model', '...money.model', '...band.actions', '...overview.actions', '...lines.actions', '...productionActs.actions', '...money.actions']) expect(container, spread).toContain(spread)
    // F-OS-104 (L5): the Deliveries card went — no `delivered` view prop; the tab's reads come with `...shipments.model`.
    expect(container).not.toContain('delivered={shipments.delivered')
    for (const spread of ['...shipments.model', '...shipments.actions']) expect(container, spread).toContain(spread)
    // ONE dialog slot: as a dialog opens, each hook clears what its own last dialog showed (the cancel reads its impact check).
    expect(container).toMatch(/setDialog\(next\)\s+setDialogProblem\(null\)[\s\S]{0,200}band\.opened\(next\)\s+lines\.opened\(next\)\s+money\.opened\(next\)/)
    // The tabs' acts left the container: none of their writes or act hooks is called here any more.
    for (const call of ['changePromise(', 'markReady(', 'closeOrder(', 'copyAsQuote(', 'applyAmendment(', 'previewAmendment(', 'closeLines(', 'reopenLines(', 'cancelOrder(', 'getCancelCheck(', 'sendDepositLink(', 'recordDepositPayment(', 'sendToSdi(', 'useScheduleSteps(', 'useBrandHealth(', 'useAssignSupervisor(', 'useNoteDialog(', 'openPreview(', 'postPortalReplyKeyed(']) expect(container, call).not.toContain(call)
  })

  it('each hook holds its own acts (the band: promise, ready, close, copy, portal, people; Lines: the draft\'s save, close / reopen lines, cancel; Money: deposits and payments)', () => {
    const band = source('./use-band-acts.ts')
    for (const call of ['changePromise(', 'markReady(', 'closeOrder(', 'copyAsQuote(', 'openPreview(', 'useAssignSupervisor(', 'useNoteDialog(']) expect(band, call).toContain(call)
    const lines = source('./use-lines-acts.ts')
    for (const call of ['applyAmendment(', 'closeLines(', 'reopenLines(', 'cancelOrder(', 'getCancelCheck(']) expect(lines, call).toContain(call)
    // F-OL-03: the Lines tab's draft — its preview, its save, the ask and the words to the customer — is use-lines-draft's.
    const draft = source('./use-lines-draft.ts')
    for (const call of ['previewAmendment(', 'applyAmendment(', 'applyPricedChange(', 'askRevisedOrder(', 'postPortalReplyKeyed(', 'findStylesForOrder(']) expect(draft, call).toContain(call)
    // F-OC-201 (W2): the customer's new yes is asked by the ONE helper on the revision (never on the order).
    expect(source('./revised-order-ask.ts')).toContain('askApproval(')
    const money = source('./use-money-acts.ts')
    for (const call of ['sendDepositLink(', 'recordDepositPayment(', 'sendToSdi(', 'useScheduleSteps(']) expect(money, call).toContain(call)
    expect(source('./use-production-acts.ts')).toContain('useBrandHealth(')
    expect(source('./use-overview-acts.ts')).toContain('onOpenLine: setOverviewLine')
    // F-OS-101 (L5): the deliveries READ (each row's Dates cell) and, on a Parcels (n) fold's opening, Warehouse's cartons read.
    expect(source('./use-shipments-acts.ts')).toContain('readDeliveries(api, orderId, abort.signal)')
    expect(source('./use-shipments-acts.ts')).toContain('readCartons(api, shipmentId)')
    expect(source('./use-shipments-acts.ts')).not.toContain('createElement(Deliveries')
  })

  it('no view under record/ imports a tab acts hook (they fetch: view-boundaries rule 2)', () => {
    const files = views(new URL('./', import.meta.url))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const hook of HOOKS) expect(text, `${file}: ${hook}`).not.toMatch(new RegExp(`from '[^']*/${hook}'`))
    }
  })

  it('RecordDialog is the one slot of every hook\'s dialogs; the dialogs draw by their owner', () => {
    expectTypeOf<RecordDialog>().toEqualTypeOf<BandDialog | LinesDialog | MoneyDialog | ChangesDialog | OverviewDialog | StageHandDialog>() // F-OO-210: the office note; F-MS-102 (ms-fx1): the stage set by hand
    // F-MS-102 (ms-fx1): the stage set by hand's dialogs are the Overview hook's (use-overview-acts opens them). F-SC-W2 (stage control
    // B): they draw ONCE, in the record's switch — Overview's strip and door and Production's stage bar open the same one; never in a card.
    expect(source('./use-overview-acts.ts')).toContain("act({ kind: 'stageByHand', mode: ask.mode }")
    expect(source('./use-overview-acts.ts')).toContain("act({ kind: 'stageClear' }")
    expect(source('./view/overview/WhereCard.tsx')).not.toContain('<StageHandDialogs')
    const dialogs = source('./view/Dialogs.tsx')
    const at = (words: string) => dialogs.indexOf(words)
    expect(at('// The band (use-band-acts).')).toBeLessThan(at("case 'promise':"))
    // F-OP-106: the amendment has no dialog any more (its strip is the Lines tab's): Lines' first dialog is Close remaining lines.
    expect(at('// Lines (use-lines-acts')).toBeLessThan(at("case 'closeLines':"))
    expect(dialogs).not.toContain("case 'amendReview':")
    // F-SC-W2: the stage set by hand's two cases share ONE mount, after the Overview hook's own note.
    expect(at("case 'note':")).toBeLessThan(at("case 'stageByHand':"))
    expect(at("case 'stageClear':")).toBeGreaterThan(at("case 'stageByHand':"))
    expect(dialogs).toContain("      return <StageHandDialogs order={order} model={model} actions={actions} />")
    expect(at('// Money (use-money-acts).')).toBeLessThan(at("case 'depositLink':"))
  })
})
// ---- end F-OP-134

// ---- F-OP-210 (order page plan N4; 11-dock §4; review R-19, RC4): the tabs and the page's in-page moves keep the dock's scope -------
describe('F-OP-210 — the tabs and the in-page moves keep `thread=`', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const BASE = '/w/DEMO/sales/orders/o1'
  it('the tabs: tabHref and the factory TabLink (no prefetch: a pick re-writes every tab\'s href); the band\'s Money and Changes links too', () => {
    const view = source('./view/OrderRecordView.tsx')
    expect(view).toContain('href: tabHref(recordHref, tab, search), // F-OP-210')
    expect(view).toContain('linkAs={TabLink}')
    expect(view).toContain("<TabLink href={tabHref(recordHref, 'money', search) /* F-OP-210 */}>")
    // F-OC-203 (W2): the band's "Revision N" lands on the Customer's agreement.
    expect(view).toContain("<TabLink href={`${tabHref(recordHref, 'changes', search)}#confirmation` /* F-OP-210 · F-OC-203: the Customer's agreement */}>")
    expect(view).not.toMatch(/\$\{recordHref\}\?tab=/)
    const link = readFileSync(new URL('../../../../lib/tab-link/TabLink.tsx', import.meta.url), 'utf8')
    expect(link).toContain('<NextLink href={href} prefetch={false} {...rest}>')
    // A pick in the dock is in every tab's link.
    expect(tabHref(BASE, 'production', '?tab=lines&thread=all')).toBe(`${BASE}?tab=production&thread=all`)
  })
  it('the drawn tab bar: real links, the same addresses as before while no scope is picked', () => {
    const html = draw('thread-docked')
    for (const tab of ['overview', 'lines', 'production', 'changes', 'money', 'shipments', 'files']) expect(html, tab).toMatch(new RegExp(`href="[^"]*/sales/orders/[^"?]+\\?tab=${tab}"`))
  })
  it('a door to Lines keeps the scope and every other term (no more `?tab=lines` alone); below 1280 px the full-width thread gives way', () => {
    const container = source('./OrderRecord.tsx')
    expect(container).toContain("router.replace(tabAddress(pathname, window.location.search, 'lines', { narrow: narrowNow() }))")
    expect(container).not.toContain('router.replace(`${pathname}?tab=lines`)')
    expect(tabAddress(BASE, '?tab=overview&thread=all&open=r1', 'lines')).toBe(`${BASE}?tab=lines&thread=all&open=r1`)
    expect(tabAddress(BASE, '?tab=overview&thread=all', 'lines', { narrow: true })).toBe(`${BASE}?tab=lines`)
  })
  it('Show on the page, Still to do and an old tab\'s landing through tabAddress; no move of the page writes `thread=` by hand', () => {
    const container = source('./OrderRecord.tsx')
    expect(container).toContain('router.replace(tabAddress(pathname, window.location.search, place.tab, { narrow: narrowNow(), anchor: place.anchor }), { scroll: false })')
    expect(container).toContain("router.replace(tabAddress(pathname, window.location.search, 'changes', { narrow: narrowNow(), anchor: 'still-to-do' }), { scroll: false })")
    expect(container).not.toMatch(/\.(set|delete)\('thread'/)
    expect(tabAddress(BASE, '?tab=overview&thread=general&message=m1', 'changes', { anchor: 'still-to-do' })).toBe(`${BASE}?tab=changes&thread=general#still-to-do`)
  })
})
// ---- end F-OP-210

// ---- F-OP-213 (order page plan N4; 11-dock §5, D4; B-OP-061): the dock offers only the threads the reader may read -----------------
describe('F-OP-213 — scopes by rights: General when its thread is readable, All only when General is', () => {
  const base = { canRead: true, projects: ['p1'], workOrders: ['w1'], seesWork: true }
  it('offerOf: All follows General; an unreadable Party thread offers neither; until the API says, threads.read decides', () => {
    expect(offerOf({ ...base, partyReadable: true })).toEqual({ general: true, all: true, projects: ['p1'], workOrders: ['w1'] })
    expect(offerOf({ ...base, partyReadable: false })).toEqual({ general: false, all: false, projects: ['p1'], workOrders: ['w1'] })
    expect(offerOf({ ...base, partyReadable: undefined })).toMatchObject({ general: true, all: true })
    expect(offerOf({ ...base, canRead: false, partyReadable: true })).toMatchObject({ general: false, all: false })
    // Work orders only with workorders.view; projects as useInProject gives them (the ones the reader may open).
    expect(offerOf({ ...base, partyReadable: true, seesWork: false }).workOrders).toEqual([])
    // A scope the address names that is not offered shows this order's own, with no word that it existed.
    const offer = offerOf({ ...base, partyReadable: false })
    expect(choicesOffered(offer)).toEqual(['order', 'projects', 'workOrders'])
    expect(scopeShown({ kind: 'all' }, offer)).toEqual(ORDER_SCOPE)
    expect(scopeShown({ kind: 'general' }, offer)).toEqual(ORDER_SCOPE)
  })
  it('the order dock asks readable only for the records it shows (the order, its customer, its projects, its work orders)', () => {
    const dock = readFileSync(new URL('./dock/OrderDock.tsx', import.meta.url), 'utf8')
    expect(dock).toContain("const offer: ScopeOffer = offerOf({ canRead: held.includes('threads.read'), partyReadable: unread[order.partyId]?.readable")
    expect(dock.indexOf('const unread = useUnread(')).toBeLessThan(dock.indexOf('const offer: ScopeOffer = offerOf('))
    expect(dock).not.toContain('general: true, all: true')
    const api = readFileSync(new URL('../../../../lib/last-message-cell/api.ts', import.meta.url), 'utf8')
    expect(api).toContain('readable: z.boolean().optional()')
  })
  it('the customer page: All of only when its own thread is readable; an address naming it then shows the general thread', () => {
    const page = readFileSync(new URL('../../customers/record/CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain("const allOffered = readsThreads && (named ? partyUnread[named.id]?.readable !== false : false)")
    expect(page).toContain('allOffered={allOffered}')
    const work = readFileSync(new URL('../../customers/record/view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(work).toContain("...(allOffered ? [{ value: 'all' as const")
    expect(work).toContain("const scope = dock.scope === 'all' && !allOffered ? 'general' : dock.scope")
  })
  it('a picked thread that answers forbidden says so inside the card, the pick band kept (RecordThread: the band before the forbidden feed)', () => {
    const thread = readFileSync(new URL('../../../../lib/record-thread/RecordThread.tsx', import.meta.url), 'utf8')
    expect(thread).toContain('{slots?.top ? <div className="fw-rt-top">{slots.top}</div> : null}')
    expect(thread).toContain("{model.feed.state !== 'forbidden' && slots?.head}")
  })
})
// ---- end F-OP-213

// ---- F-OP-217 (order page plan N4; 11-dock §2, §3, §7): the dock's scopes in the design screen, and the narrow-card rules ----------------
describe('F-OP-217 — every dock scope drawn in the one card (design cases), the rules of a card of 480 px or less', () => {
  const dockOf = (html: string) => html.slice(html.indexOf('class="fw-rcf-dock"'))
  it('This order, General and a work order: the pick band is the card\'s first band; the work order\'s line in the office tone', () => {
    for (const id of ['f-op-217-dock-order', 'f-op-217-dock-general', 'f-op-217-dock-work-order']) {
      const dock = dockOf(draw(id))
      expect(dock.match(/class="fw-rt-column is-docked"/g)?.length, id).toBe(1)
      expect(dock.indexOf('class="fw-rt-top"'), id).toBeGreaterThan(dock.indexOf('class="fw-rt-column is-docked"'))
      expect(dock, id).toContain('class="fw-thread-pick"')
    }
    expect(dockOf(draw('f-op-217-dock-work-order'))).toContain('class="fw-thread-pick-line is-office"')
    expect(textOf(dockOf(draw('f-op-217-dock-general')))).toContain('Moto Demo S.r.l.')
  })
  it('All of <customer>: the card with the pick band, its Head, compact lines and the foot "Read only. Write in:" — both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const dock = dockOf(draw('f-op-217-dock-all', locale))
      const at = (part: string) => dock.indexOf(part)
      expect(at('class="fw-rt-top"')).toBeGreaterThan(-1)
      expect(at('class="fw-rt-top"')).toBeLessThan(at('class="fw-rth fw-aoc-head"'))
      expect(at('class="fw-rth fw-aoc-head"')).toBeLessThan(at('class="fw-rt-scroll"'))
      expect(at('class="fw-rt-scroll"')).toBeLessThan(at('class="fw-rt-foot"'))
      expect(dock.match(/<article class="fw-aoc-line/g)?.length, locale).toBe(5)
      expect(dock).toContain('class="fw-aoc-line is-office"')
      expect(textOf(dock)).toContain(locale === 'en' ? 'Read only. Write in:' : 'Sola lettura. Scrivi in:')
      expect(leftKeys(dock, ['allOfCustomer', 'record.dock', 'width', 'more'])).toEqual([])
    }
  })
  it('the rules of a narrow card: short words, a full-width second select, the body and foot tighter, the lines and chips within the card', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    expect(read('../../../_shared/record-thread/thread-pick.css')).toMatch(/@container fw-rtcol \(max-width: 480px\) \{\s*\.fw-thread-pick-extra,\s*\.fw-thread-pick-extra select \{\s*width: 100%;/)
    expect(read('../../../../lib/record-thread/record-thread.css')).toMatch(/@container fw-rtcol \(max-width: 480px\) \{\s*\.fw-rt-scroll \{\s*padding: var\(--nds-space-10\) var\(--nds-space-12\);/)
    expect(read('../../../_shared/record-thread/all-of-customer/all-of-customer.css')).toMatch(/\.fw-aoc-chip \{\s*max-width: calc\(100% - var\(--nds-space-24\)\);/)
    // The phone: the full-width view (thread=open), ← Back above the card, no radius (record-thread.css's phone rule).
    expect(read('../../../../lib/record-thread/record-thread.css')).toMatch(/@media \(max-width: 719px\) \{\s*\.fw-rt-column \{\s*border-radius: 0;/)
  })
})
// ---- end F-OP-217

// ---- F-OP-215 (order page plan N4; 11-dock §6.2, D2; review N-1): the dock's files line on the order = the order's file set ------------
describe('F-OP-215 — the files line counts the order\'s file set (the Files tab\'s count); All files opens the Files tab', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('the order\'s set as tiles: one per listed file, the count = read.total; body data locked; what the customer sees marked theirs', async () => {
    const { stripFilesOf } = await import('../../../_shared/record-thread/use-order-files')
    const { fileSeries, filesChip } = await import('../../../../lib/record-thread/files/model')
    const { ORDER_FILES } = await import('./overview/fixtures')
    const tiles = stripFilesOf(ORDER_FILES, 'party-a')
    expect(tiles.map((tile) => tile.name)).toEqual(['Ordine firmato.pdf', 'Note ufficio.pdf', 'Logo ricamo.pdf', 'Taglio nero.jpg'])
    expect(filesChip(fileSeries(tiles)).count).toBe(ORDER_FILES.total)
    expect(tiles[0]).toMatchObject({ visibility: ['OFFICE', 'PARTNER'], partyId: 'party-a', messageId: '0190f0e2-8282-7000-8000-000000000001', status: 'AVAILABLE' })
    expect(tiles[1]).toMatchObject({ visibility: ['OFFICE'], partyId: null })
    expect(tiles[3]).toMatchObject({ kind: 'PHOTO', recordType: 'WorkOrder' })
    const body = stripFilesOf({ ...ORDER_FILES, groups: [{ ...ORDER_FILES.groups[0]!, files: [{ ...ORDER_FILES.groups[0]!.files[0]!, bodyData: true }] }], total: 1 }, null)
    expect(body[0]).toMatchObject({ locked: 'MEASUREMENTS' })
    // The strip draws "Files (4)", the Files tab's own count (model.files.read.total).
    const { render, textOf: text } = await import('../../../../lib/record-thread/parts/testing')
    const { FileStrip } = await import('../../../../lib/record-thread/files/view/FileStrip')
    expect(text(render(createElement(FileStrip, { model: { files: tiles, party: null, open: false } })))).toContain(`Files (${ORDER_FILES.total})`)
    expect(read('./view/OrderRecordView.tsx')).toContain("count: tab === 'files' ? (model.files?.read?.total ?? null)")
  })
  it('the dock reads no files of its own on the order: the page\'s ONE container, its tiles and All files to the Files tab', () => {
    const docked = read('../../../_shared/record-thread/DockedOfficeThread.tsx')
    expect(docked).toContain("const hostFiles = key.type === 'SalesOrder' ? (host.orderFiles ?? null) : null")
    expect(docked).toContain("orderId: key.type === 'SalesOrder' && !hostFiles ? key.id : null")
    expect(docked).toContain('const orderFiles = hostFiles ?? ownOrderFiles')
    expect(docked).toContain('onAllFiles: () => (hostFiles ? hostFiles.onAll() : setFilesOpen(true)),')
    expect(docked).toContain('model={{ files: stripFiles, party: filesParty')
    const page = read('./OrderRecord.tsx')
    expect(page.match(/useOrderFiles\(api, \{/g)).toHaveLength(1)
    expect(page).toContain("enabled: tab === 'files' || session.permissions.includes('files.read'),")
    expect(page).toContain("router.replace(tabAddress(pathname, window.location.search, 'files', { narrow: narrowNow() }), { scroll: false })")
    expect(page.match(/orderFiles=\{orderFilesHost \/\* F-OP-215 \*\/\}/g)).toHaveLength(2)
    const dock = read('./dock/OrderDock.tsx')
    expect(dock).toContain('{...(orderFiles ? { orderFiles } : {}) /* F-OP-215 */}')
    // Only This order's thread gets it (General, a project, a work order keep their own files).
    const order = dock.slice(dock.lastIndexOf('shown = <OfficeRecordThread key="order"'))
    expect(order).toContain('orderFiles')
    expect(dock.slice(dock.indexOf('shown = <OfficeRecordThread key="general"'), dock.indexOf('} else if (scope.kind === \'project\'')).includes('orderFiles')).toBe(false)
  })
})
// ---- end F-OP-215

// ---- F-OP-129 (order page plan N2, N5, N6; 10-order-page §13): the end's design cases draw what each reader is told ------------------
// F-OL-05 (Order LINES lane): the edit strip went with the old edit mode — what each work order does is the Review window's Production
// part now (lines-review-wo-*, lines-review-outcome*), the same words per reader.
describe('F-OP-129 — the order page at the end in the design screen: Review and save\'s production part per reader and under cut, the Shipments rows', () => {
  it('the cases are on SCR-039, each once', () => {
    const ids = designScreen.cases.map((item) => item.id).filter((id) => id.startsWith('f-op-129-') || id.startsWith('lines-review-wo-') || id.startsWith('lines-review-outcome'))
    expect(ids).toEqual(['lines-review-wo-sales', 'lines-review-wo-owner', 'lines-review-outcome', 'lines-review-outcome-none', 'f-op-129-ship-tracking', 'f-op-129-ship-tracking-sales', 'f-op-129-ship-shared', 'f-op-129-ship-elsewhere'])
  })

  it('Sales: the DRAFT follows now, the released one waits for production with its words; the Owner: both follow, the work sheet printed again (R-4)', () => {
    const sales = textOf(draw('lines-review-wo-sales'))
    expect(sales).toContain('WO-00023 2 → 1 · follows now')
    expect(sales).toContain('WO-00022 2 → 1 · waits for production — decide on this page')
    expect(sales).toContain('WO-00022 is released: production applies the change (a planner or a production manager).')
    const owner = textOf(draw('lines-review-wo-owner'))
    expect(owner).toContain('WO-00022 2 → 1 · follows now')
    expect(owner).toContain('its work sheet is printed again')
    expect(owner).not.toContain('waits for production')
    // Italian too: the same plan in the reader's language.
    expect(textOf(draw('lines-review-wo-sales', 'it'))).toContain('WO-00022 è rilasciato')
  })

  it('under cut: "Keep for this customer" picked for you (Save changes live); with nothing picked Save changes is held for it', () => {
    const held = draw('lines-review-outcome-none')
    expect(held).toContain('Choose what happens to the 1 extra piece')
    expect(textOf(held)).toContain('WO-00021')
    const chosen = draw('lines-review-outcome')
    expect(chosen).not.toContain('aria-description="Choose what happens to the 1 extra piece"')
  })

  it('Shipments: a carrier booked by hand with its typed number and "No live tracking"; labels with their parcel numbers; Sales reads the number only', () => {
    const owner = textOf(draw('f-op-129-ship-tracking'))
    expect(owner).toContain('BRT, booked by hand')
    expect(owner).toContain('0123456789')
    expect(owner).toContain('No live tracking')
    expect(owner).toContain('GLS-778899')
    // F-OS-101 (D2): Sales reads the number and no door — Tracking numbers… (F-OS-301) is hidden, never held for a right; the Owner's opens.
    const sales = draw('f-op-129-ship-tracking-sales')
    expect(textOf(sales)).toContain('0123456789')
    expect(sales).not.toContain('A warehouse person adds tracking.')
    expect(textOf(sales.slice(sales.indexOf(' id="shipments"')))).not.toContain('Tracking numbers…')
    expect(owner).toContain('Tracking numbers…')
  })

  it('a shared shipment names the other order it carries; one made elsewhere names its paper DDT (F-OP-122, F-OP-123)', () => {
    expect(textOf(draw('f-op-129-ship-shared'))).toContain('Also carries SO-2026-0151')
    expect(textOf(draw('f-op-129-ship-elsewhere'))).toContain('Made elsewhere · DDT 123/2026')
    // The typed link beside the number (F-OP-135): Track ›, https only.
    expect(draw('f-op-129-ship-tracking')).toContain('href="https://vas.brt.example.com/track?n=0123456789"')
  })
})
// ---- end F-OP-129

// ---- F-OP-305 → F-OL-02 (Order LINES lane, 18-lead-settles F6): the Lines tab for a reader without orders.manage — no box, no Add a
// style, no save bar; the production manager keeps the tab ⋯ with its own act (Make work orders…), never a held edit mode.
describe('F-OL-02: Lines for the production manager (no orders.manage) — plain numbers, no Add a style, the tab ⋯ with Make work orders', () => {
  it('drawn (en, it): no box, no Add a style, no "Amend order"; the ⋯ "More for the lines" is there', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('manager-lines', locale)
      expect(textOf(html)).not.toContain(locale === 'en' ? 'Amend order' : 'Modifica ordine')
      expect(textOf(html)).not.toContain(locale === 'en' ? 'Add a style' : 'Aggiungi un modello')
      expect(html).not.toMatch(/<input[^>]*aria-label="[^"]*, (?:size|taglia) /)
      expect(html).toContain(locale === 'en' ? 'aria-label="More for the lines"' : 'aria-label="Altro per le righe"')
    }
  })
})
// ---- end F-OP-305

// ---- F-OO-111 (10-design §1.7 BC-1, BC-2; Owner D5): on Overview the yes and deposit banners step back — section 1's strips say the
// same with the same doors; on every other tab they stay; every band tag stays. "Who answers the customer…" is held without threads.post.
describe('F-OO-111 — the yes and deposit banners step back on Overview (present on Lines); the ⋯ "Who answers the customer…" held in words', () => {
  type Case = { role: string; record: { tab: string } & Record<string, unknown> }
  const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)!.model as unknown as Case
  const onTab = (model: Case, tab: string) => ({ ...model, record: { ...model.record, tab } })
  const drawn = (model: unknown, locale: 'en' | 'it' = 'en') => renderView(view, model, locale)
  const DEPOSIT_OPEN = { en: 'Deposit open — due', it: 'Acconto aperto — scade il' } as const
  const DEPOSIT_MISSING = { en: 'Deposit not asked', it: 'Acconto non chiesto' } as const

  it('the yes banner: absent on Overview (the strip draws its doors), present on Lines — in both languages', () => {
    for (const id of ['f-op-101-approver-yes', 'f-op-101-self-asked', 'f-op-101-who-decides']) {
      for (const locale of ['en', 'it'] as const) {
        const overview = drawn(caseOf(id), locale)
        expect(overview, `${id} ${locale} overview`).not.toContain('class="fw-sod-wait"')
        // The strip is there instead, with the yes's words (one place per fact).
        expect(overview, `${id} ${locale} strip`).toContain('class="fw-so-strips"')
        expect(drawn(onTab(caseOf(id), 'lines'), locale), `${id} ${locale} lines`).toContain('class="fw-sod-wait"')
      }
    }
  })

  // F-OM-fx3 (W-04): absent on Money too — the tab's head is its one answer there.
  it('the deposit banners (open, overdue, not asked): absent on Overview and Money, present on Lines', () => {
    const open = caseOf('f-oo-105-deposit')
    const record = open.record as unknown as { order: { value: ReturnType<typeof order> } }
    const value = record.order.value
    const overdue = { ...open, record: { ...open.record, order: { status: 'ready', value: { ...value, chain: { ...value.chain, depositRequests: value.chain.depositRequests.map((request) => ({ ...request, dueDate: '2020-01-02' })) } } } } }
    const missing = { ...base('owner', order('CONFIRMED', { chain: { ...order().chain, depositRequests: [] } }), { tab: 'overview' }) } as unknown as Case
    for (const locale of ['en', 'it'] as const) {
      for (const [model, words] of [[open, DEPOSIT_OPEN], [overdue, DEPOSIT_OPEN], [missing, DEPOSIT_MISSING]] as const) {
        expect(textOf(drawn(model, locale)), `${words.en} ${locale} overview`).not.toContain(words[locale])
        expect(textOf(drawn(onTab(model as Case, 'lines'), locale)), `${words.en} ${locale} lines`).toContain(words[locale])
        expect(textOf(drawn(onTab(model as Case, 'money'), locale)), `${words.en} ${locale} money`).not.toContain(words[locale])
      }
    }
  })

  it('only the yes and deposit banners step back: every band tag stays on Overview (D5), the other notices keep their place', () => {
    const view_ = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view_).toContain("const notOverview = model.tab !== 'overview'")
    // Its declaration and exactly four banners that read it: the deposit open (overdue, waiting), the deposit not asked, the yes.
    expect(view_.match(/notOverview/g)?.length).toBe(5)
    // F-OM-fx3 (W-04): the deposit (3), cancelled and closed notices step back on Money (its head says them): its declaration + 5.
    expect(view_).toContain("const notMoney = model.tab !== 'money'")
    expect(view_.match(/notMoney/g)?.length).toBe(6)
    for (const kept of ["{order.customerRef && <Tag tone=\"neutral\">{t('record.customerRef', { ref: order.customerRef })}</Tag>}", "{!order.chain.quote && !model.madeFrom && !model.madeFromReading && <Tag tone=\"neutral\">{t('record.typed')}</Tag>}", '{model.depth && <DepthPills model={model.depth} />}', '{model.reviewBanner}', '<RequestBandNotices order={order} model={model} />']) expect(view_, kept).toContain(kept)
    // The customer PO tag still drawn on Overview (the band serves every tab).
    expect(textOf(draw('overview'))).toContain('Customer PO PO-ESEMPIO-88')
  })

  it('W07\'s follow-up: "Record a shipment made elsewhere…" is mounted ONCE, by the page — the band\'s ⋯ opens it on every tab', () => {
    const dialogOn = (file: string) => (readFileSync(new URL(file, import.meta.url), 'utf8').match(/model\.elsewhere\?\.dialog\b/g) ?? []).length
    expect(dialogOn('./view/OrderRecordView.tsx')).toBe(1)
    for (const tab of ['./view/overview/WhereCard.tsx', './view/ShipmentsTab.tsx', './view/OverviewTab.tsx', './view/LinesTab.tsx', './view/ProductionTab.tsx', /* F-OM-101: Money's layout and its section files */ './money/view/MoneyTab.tsx', './money/view/TotalsSection.tsx', './money/view/PaymentsSection.tsx', './money/view/PlanRow.tsx', './money/view/InvoicesSection.tsx', './money/view/PriceCheckSection.tsx', './money/view/MarginSection.tsx' /* F-OM-303: the list final */, './view/FilesTab.tsx', './changes/view/ChangesTab.tsx', /* F-OC-101: its section files */ './changes/view/WaitingSection.tsx', './changes/view/FreezeSection.tsx', './changes/view/HistorySection.tsx', './changes/view/AgreementSection.tsx', /* F-OS-101: the Shipments tab's section files */ './shipments/view/WhereSection.tsx', './shipments/view/ShipmentsSection.tsx', './shipments/view/ShipmentRow.tsx', './shipments/view/AfterSalesSection.tsx']) expect(dialogOn(tab), tab).toBe(0)
    // Outside the tabs' bodies: beside the page's other dialogs.
    const view_ = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view_.indexOf('{model.elsewhere?.dialog}')).toBeGreaterThan(view_.indexOf('<OrderDialogs order={order} model={model} actions={actions} />'))
    // Its doors stay: the band's ⋯ item, Overview's More ▾ and the Shipments card head all call the same act.
    expect(view_).toContain("onSelect: () => actions?.onRecordElsewhere?.()")
    // F-OS-101: the Shipments head's door is in its section file now.
    expect(readFileSync(new URL('./shipments/view/ShipmentsSection.tsx', import.meta.url), 'utf8')).toContain('onClick={() => actions?.onRecordElsewhere?.()}')
  })

  it('BC-2: "Who answers the customer…" is held without threads.post, in the People card\'s own words for the same door (en + it)', () => {
    expect(answerHeldOf({ thread: true, mayWrite: false })).toEqual({ ns: OWNER_WORDS_NS, key: 'held.noRight', params: { right: rightRef('threads.post') } })
    expect(answerHeldOf({ thread: true, mayWrite: true })).toBeNull()
    expect(answerHeldOf({ thread: true, mayWrite: null })).toBeNull()
    for (const locale of LOCALES) {
      const head = createTranslator(locale, messagesFor(locale, [OWNER_WORDS_NS])[OWNER_WORDS_NS]!)
      const words = head('held.noRight', { right: rightRef('threads.post') })
      expect(words, locale).not.toBe('held.noRight')
      expect(words, locale).not.toContain('threads.post')
      expect(words, locale).not.toContain('{right}')
    }
    const view_ = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view_).toContain('const answerWait = answerHeldOf({ thread: !!thread, mayWrite: people ? people.mayNote : null })')
    expect(view_).toContain("{ id: 'whoAnswers', label: t('bandMenu.whoAnswers'), disabled: !!answerWait /* F-OO-111 */, description: answerWords, onSelect: () => frameRef.current?.openDoor?.('owner') }")
    // The thread head's catalogue comes with the page (its words are said in the band's ⋯).
    expect(view_).toContain('OWNER_WORDS_NS /* F-OO-111 */]')
    // The People card holds its Change… by the same rule (one rule, two doors).
    expect(readFileSync(new URL('./view/overview/PeopleCard.tsx', import.meta.url), 'utf8')).toContain('answerHeldOf({ thread:')
  })
})
// ---- end F-OO-111

// ---- Z02 cleanups (lead notes 7, 8; nothing unused may stay) -------------------------------------------------------------------------
describe('Z02 cleanups — the waiting call reads the open yeses only; no date row opens Changes; the credit Check dialog holds nothing typed', () => {
  it('orderWaitingOf takes the order\'s open yeses only (the amendments left the card with F-OO-205)', () => {
    expectTypeOf<Parameters<typeof orderWaitingOf>[0]>().toEqualTypeOf<Pick<Order, 'openApprovals'>>()
  })

  it('a Next dates wait opens Production or Money, never Changes (no DATE row makes it since W08)', () => {
    expectTypeOf<WaitDate['door']['tab']>().toEqualTypeOf<'production' | 'money'>()
  })

  it('a live change reads the order under the credit\'s Check again dialog (nothing typed in it), as under the deposit\'s and Before → after', () => {
    const container = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("open.kind !== 'depositLink' && open.kind !== 'depositPayment' && open.kind !== 'compare' && open.kind !== 'creditCheck'")
    // Ask for a yes… keeps the typed-work guard (its note is typed).
    expect(container).not.toContain("open.kind !== 'creditAsk'")
  })
})
// ---- end Z02 cleanups

// ---- F-OS T.1 (order SHIPMENTS tab; 15-steps T.1): the gallery's Shipments cases draw what each state says, in both languages ----
describe('F-OS T.1 — the Shipments tab\'s design cases (the states the seed lacks)', () => {
  const shipmentsOf = (id: string, locale: 'en' | 'it' = 'en') => {
    const html = draw(id, locale)
    return textOf(html.slice(html.indexOf(' id="left"')))
  }
  it('split: the DDT chip, the tracking problem, "Split from", the packed one\'s next step into Warehouse', () => {
    const text = shipmentsOf('os-split')
    for (const words of ['DDT 144/2026', '1 tracking problem', 'Split from SH-2026-0072', 'Next: buy the labels ›', 'Tracking numbers…']) expect(text, words).toContain(words)
  })

  it('delivered: from the carrier with its proof; set by hand with its reason', () => {
    const text = shipmentsOf('os-delivered')
    for (const words of ['signed by M. Rossi', 'Set by hand', 'the carrier never scanned it']) expect(text, words).toContain(words)
  })

  it('Seed Karachi Mills: one travelled without a DDT (Set by hand); the packed one says the DDT choice — no country read', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = shipmentsOf('os-pakistan', locale)
      expect(text).toContain(locale === 'en' ? 'Travels without a DDT · Set by hand' : 'Viaggia senza DDT · Impostata a mano')
      expect(text).toContain(locale === 'en' ? 'A Nexus shipment leaves with a DDT.' : 'Una spedizione Nexus parte con un DDT.')
    }
  })

  it('the after-sales doors on the head; Read-only reads every cell and finds no act; a failed part says so', () => {
    const after = shipmentsOf('os-after')
    for (const words of ['Open a return…', 'Log a complaint…']) expect(after, words).toContain(words)
    const reader = shipmentsOf('os-role-readonly')
    for (const words of ['Tracking numbers…', 'Create shipment…', 'Open a return…']) expect(reader, words).not.toContain(words)
    expect(reader).toContain('SH-2026-0071')
    expect(shipmentsOf('os-failed')).toContain('the deliveries')
  })
})
// ---- end F-OS T.1
