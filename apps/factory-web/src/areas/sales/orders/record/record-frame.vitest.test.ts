import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url' // F-OP-134
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { canOf } from '../_demo/fixtures'
import { groupedMenu, landingOf, MENU_GROUPS, MERGED_TABS, recordTabs, tabOf } from '../model'
import { DOCK_DEFAULTS, RECORD_TABS } from '../model' // F-SA-263
import { defaultWidthAt } from '../../../_shared/record-frame/model' // F-SA-263
import { designScreen } from './fixtures'
// F-SA-262: the order dock's scope (the pick of ONE conversation)
import { choiceOfScope, choicesOffered, ORDER_SCOPE, SCOPE_PARAM, scopeAddress, scopeOfChoice, scopeOfParam, scopeParamOf, scopeShown, workOrderGroups } from './dock/model'
import { viewOpenOf } from '../../../_shared/record-frame/model'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import type { BandDialog, ChangesDialog, LinesDialog, MoneyDialog, RecordDialog } from './record-model' // F-OP-134

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

// ── F-SA-243 (sales page plan P5, R1; 14-change-flow §3.1, §3.4; review R-5): the order page's doors to the ONE review window ──
describe('F-SA-243: the order page opens the same review window as Home › Approvals, and keeps Still to do', () => {
  it('the band: "<Customer> asks: … · Answer…" (the oldest waiting on us, "1 more request"), a real link to ?open= on this page', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('f-sa-243-band', locale)
      const text = textOf(html)
      expect(text).toContain(locale === 'en' ? 'asks: Change · line 10 · 50 6 → 4' : 'chiede: Modifica · riga 10 · 50 6 → 4')
      expect(text).toContain(locale === 'en' ? '1 more request' : '1 altra richiesta')
      expect(text).toContain(locale === 'en' ? 'Answer…' : 'Rispondi…')
      expect(text).toContain(locale === 'en' ? 'Still to do: 2' : 'Ancora da fare: 2')
    }
    expect(draw('f-sa-243-band')).toMatch(/href="[^"]*\?tab=changes&amp;open=/)
    // Only while a row asks THIS reader (Your turn / Needs a decision) the band says a step needs a decision (R-5).
    expect(textOf(draw('f-sa-243-band'))).toMatch(/1 step needs a decision/)
    expect(textOf(draw('f-sa-243-nothing-mine'))).not.toMatch(/needs? a decision/)
  })

  it('Changes: Answer… on each waiting request (no more "Answer in Approvals ›"), Still to do under its change with state, owner and door', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('f-sa-243-changes', locale))
      for (const words of locale === 'en' ? ['Still to do', 'Your turn', 'Waiting for planning', 'Planning', 'WO-00021: make 50 6 → 4'] : ['Ancora da fare', 'Tocca a te', 'Aspetta la pianificazione', 'Pianificazione']) expect(text, words).toContain(words)
      expect(text).not.toContain(locale === 'en' ? 'Answer in Approvals' : 'Rispondi in Approvazioni')
    }
    const html = draw('f-sa-243-changes')
    expect(html).toContain('id="still-to-do"')
    // The work-order change opens Home › Approvals' window on it; the extra pieces' row its work order's page.
    expect(html).toContain('/home/approvals?open=0190f0e2-9090-7000-8000-000000000001')
    expect(textOf(draw('f-sa-243-nothing-mine'))).toContain('1 work order not shown')
  })

  it('the pure parts: the request in words, the band only for rows that ask me, rows grouped under their change, each row’s door', async () => {
    const { askingOf, askWordsOf, decisionBandOf, stillDoorOf, stillGroupsOf } = await import('./changes/model')
    const say = (key: string, params?: Record<string, string | number>) => `${key}:${JSON.stringify(params ?? {})}`
    const request = { kind: 'CHANGE' as const, wholeOrder: false, requestedDate: null, cells: [1, 2, 3, 4].map((seq) => ({ lineId: `l${seq}`, seq, style: null, colourway: null, size: 'M', before: 4, asked: 2, askedColourway: null })) }
    expect(askWordsOf(request, { kind: 'Change', say, day: String }).split(' · ')).toHaveLength(5) // the kind, three cells, "…"
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
    const keys = ['band.asks', 'band.answer', 'band.answerNone', 'band.askCell', 'band.askLine', 'band.askWhole', 'band.moreRequests_one', 'band.moreRequests_other', 'band.decision_one', 'band.decision_other', 'band.open', 'changes.onUs.count_one', 'changes.still.title', 'changes.still.since', 'changes.still.open', 'changes.still.none', 'changes.still.changeOf', 'changes.still.office', 'changes.still.madeExtra', 'changes.still.extraLine', 'changes.still.leftOut_one', 'changes.still.leftOut_other', 'overview.requests.still', 'amend.tell.words', 'amend.tell.hint', 'notice.amendedTold', 'notice.amendedNotTold', 'notice.amendedNotReached']
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
  it('Overview and Money 40 %; Lines, Production, Shipments, Files a third under 1600 px (40 % from 1600); Changes half', () => {
    expect(Object.keys(DOCK_DEFAULTS).sort()).toEqual([...RECORD_TABS].sort())
    const at = (viewport: number) => Object.fromEntries(RECORD_TABS.map((tab) => [tab, defaultWidthAt(DOCK_DEFAULTS[tab], viewport)]))
    expect(at(1440)).toEqual({ overview: 'forty', lines: 'third', production: 'third', changes: 'half', money: 'forty', shipments: 'third', files: 'third' })
    expect(at(1920)).toEqual({ overview: 'forty', lines: 'forty', production: 'forty', changes: 'half', money: 'forty', shipments: 'forty', files: 'forty' })
  })

  it('the page draws each tab at its default (nothing chosen yet): Production a third at 1440, Changes half, Money 40 %', () => {
    expect(draw('thread-docked')).toContain('data-width="third"')
    expect(draw('documents')).toContain('data-width="half"')
    expect(draw('money-new')).toContain('data-width="forty"')
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
  it('a replace keeps every other term; the narrow view stays open (`open` for this order); a line of All of opens at its message', () => {
    const base = '/w/DEMO/sales/orders/o1'
    expect(scopeAddress(base, '?tab=lines', { kind: 'general' }, false)).toBe(`${base}?tab=lines&thread=general`)
    expect(scopeAddress(base, '?tab=lines&thread=general', ORDER_SCOPE, false)).toBe(`${base}?tab=lines`)
    expect(scopeAddress(base, '?tab=lines&thread=general', ORDER_SCOPE, true)).toBe(`${base}?tab=lines&thread=open`)
    expect(scopeAddress(base, '?tab=lines&thread=all&message=m1', { kind: 'wo', id: W }, false)).toBe(`${base}?tab=lines&thread=wo%3A${W}`)
    expect(scopeAddress(base, '?thread=all', ORDER_SCOPE, false, 'm7')).toBe(`${base}?message=m7`)
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
    expect(dock).toContain('<AllOfCustomerFeed model={feed.model} actions={{ ...feed.actions, onAnswer }} />')
    expect(dock).toContain("t('record.dock.writeIn')")
    // The scope is written by a replace (Back keeps it).
    expect(dock).toContain('router.replace(address, { scroll: false })')
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
  const HOOKS = ['use-band-acts', 'use-overview-acts', 'use-lines-acts', 'use-production-acts', 'use-shipments-acts', 'use-money-acts'] as const
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
    expect(container).toContain('delivered={shipments.delivered')
    // ONE dialog slot: as a dialog opens, each hook clears what its own last dialog showed (the cancel reads its impact check).
    expect(container).toMatch(/setDialog\(next\)\s+setDialogProblem\(null\)[\s\S]{0,200}band\.opened\(next\)\s+lines\.opened\(next\)\s+money\.opened\(next\)/)
    // The tabs' acts left the container: none of their writes or act hooks is called here any more.
    for (const call of ['changePromise(', 'markReady(', 'closeOrder(', 'copyAsQuote(', 'applyAmendment(', 'previewAmendment(', 'closeLines(', 'reopenLines(', 'cancelOrder(', 'getCancelCheck(', 'sendDepositLink(', 'recordDepositPayment(', 'sendToSdi(', 'useScheduleSteps(', 'useBrandHealth(', 'useAssignSupervisor(', 'useNoteDialog(', 'openPreview(', 'postPortalReplyKeyed(']) expect(container, call).not.toContain(call)
  })

  it('each hook holds its own acts (the band: promise, ready, close, copy, portal, people; Lines: amend, close / reopen lines, cancel; Money: deposits and payments)', () => {
    const band = source('./use-band-acts.ts')
    for (const call of ['changePromise(', 'markReady(', 'closeOrder(', 'copyAsQuote(', 'openPreview(', 'useAssignSupervisor(', 'useNoteDialog(']) expect(band, call).toContain(call)
    const lines = source('./use-lines-acts.ts')
    for (const call of ['applyAmendment(', 'previewAmendment(', 'closeLines(', 'reopenLines(', 'cancelOrder(', 'getCancelCheck(', 'postPortalReplyKeyed(']) expect(lines, call).toContain(call)
    const money = source('./use-money-acts.ts')
    for (const call of ['sendDepositLink(', 'recordDepositPayment(', 'sendToSdi(', 'useScheduleSteps(']) expect(money, call).toContain(call)
    expect(source('./use-production-acts.ts')).toContain('useBrandHealth(')
    expect(source('./use-overview-acts.ts')).toContain('onOpenLine: setOverviewLine')
    expect(source('./use-shipments-acts.ts')).toContain('createElement(Deliveries, { orderId: order.id, prefix })')
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
    expectTypeOf<RecordDialog>().toEqualTypeOf<BandDialog | LinesDialog | MoneyDialog | ChangesDialog>()
    const dialogs = source('./view/Dialogs.tsx')
    const at = (words: string) => dialogs.indexOf(words)
    expect(at('// The band (use-band-acts).')).toBeLessThan(at("case 'promise':"))
    expect(at('// Lines (use-lines-acts).')).toBeLessThan(at("case 'amendReview':"))
    expect(at('// Money (use-money-acts).')).toBeLessThan(at("case 'depositLink':"))
  })
})
// ---- end F-OP-134
