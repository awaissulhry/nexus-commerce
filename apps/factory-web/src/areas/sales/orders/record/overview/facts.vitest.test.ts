import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { rolePermissions } from '../../../../../shell/design-data'
import { forRole, order, PEOPLE } from '../../_demo/fixtures'
import type { Order } from '../../api'
import { abilitiesOf } from '../../model'
import { depthCanOf } from '../../depth/model'
import type { OrderDepthModel } from '../../depth/use-order-depth'
import { base } from '../fixtures'
import type { OrderRecordModel } from '../record-model'
import { CUSTOMER_REF_FIELD_ID } from '../record-model'
import { useOverviewActs } from '../use-overview-acts'
import { FactsCard } from '../view/overview/FactsCard'
import { factsDoorsOf, incotermOf, languageOf, madeOf, shipToOf } from './facts'
// ---- F-OO-210: the office note — its rules, its dialog, the sheet's own write ----
import type { ApiClient } from '../../../../../lib/api/client'
import { ApiError } from '../../../../../lib/api/errors'
import { NOTE_MAX, noteBodyOf, noteFailureOf, noteHeldOf, noteProblem, noteRefusalOf } from './facts'
import { OrderNoteDialog } from '../view/OrderNoteDialog'
import type { RecordActsBase, RecordDialog } from '../record-model'

// F-OO-210: the DS Modal draws into a portal once hydrated, never on the server: here it draws in place, so the dialog can be read
// (the card draws no Modal: unchanged by it).
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-OO-209 (order overview 11-design §7; Owner §7) — Order facts: two columns of the facts found nowhere else; Customer PO and Ship
 * to with Change… (the ONE edit path), Priority and Season with Set… (the depth's dialogs), the rest Fixed, Made derived. Held with
 * words (amendHeld, depthEditHeld): Sales sees the doors live, the Planner held, a closed order all held; read-only sees no door.
 * Every name and number is made up.
 */

const SHIP_TO = { name: 'Brand Alpha', line1: 'Via Esempio 1', postalCode: '59100', city: 'Prato' }
const DEPTH_VALUE = {
  orderId: 'o-1',
  number: 'SO-2026-0088',
  status: 'IN_PRODUCTION',
  priority: { level: 'HIGH' as const, urgentReason: null, number: 2 },
  season: { id: 's-1', code: 'FW27', name: 'Fall-Winter 2027', status: 'OPEN' as const },
  waiting: null,
  confirmation: { versions: 0, sentAt: null, sentVersion: null },
  sameQuote: [],
}
/** The depth part the card reads (its rights and its read), as the page's useOrderDepth holds it. */
const depthOf = (permissions: readonly string[], depth: OrderDepthModel['depth'] = { value: DEPTH_VALUE, problem: null }) => ({ can: depthCanOf(permissions), depth }) as unknown as OrderDepthModel
const withFacts = (status: Order['status'] = 'IN_PRODUCTION', over: Partial<Order> = {}): Order => ({ ...order(status), shipTo: SHIP_TO, createdById: PEOPLE.sales, ...over })

/** A reader's record model: a role's rights (the design data's real role templates) and the depth read. */
function modelOf(role: 'sales' | 'planner' | 'read_only', value: Order, over: Partial<OrderRecordModel> = {}): OrderRecordModel {
  const permissions = rolePermissions(role)
  return { ...base('sales', value).record, order: { status: 'ready', value: forRole(value, 'sales') }, tab: 'overview', can: abilitiesOf(permissions), depth: depthOf(permissions), ...over }
}
const draw = (value: Order, model: OrderRecordModel, locale: (typeof LOCALES)[number] = 'en') => render(createElement(FactsCard, { order: value, model }), locale)
/** The opening tags of the buttons with these words. */
const buttons = (html: string, label: string) => [...html.matchAll(new RegExp(`<button[^>]*>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</button>`, 'g'))].map((match) => match[0])

describe('F-OO-209: Order facts\' rules', () => {
  it('the language in the reader\'s words (Intl): de reads German / Tedesco, it Italian / Italiano; an unknown code stays the code', () => {
    expect(languageOf({ language: 'de' }, 'en')).toBe('German')
    expect(languageOf({ language: 'de' }, 'it')).toBe('Tedesco')
    expect(languageOf({ language: 'it' }, 'en')).toBe('Italian')
    expect(languageOf({ language: 'it' }, 'it')).toBe('Italiano')
    expect(languageOf({ language: 'en' }, 'it')).toBe('Inglese')
    expect(languageOf({ language: '12' }, 'en')).toBe('12')
  })

  it('the doors: Sales live; the Planner held (no orders.manage); a closed order all held.final; busy; read-only: no door at all', () => {
    const sales = abilitiesOf(rolePermissions('sales'))
    const planner = abilitiesOf(rolePermissions('planner'))
    const open = withFacts()
    // F-OO-210: + the office note's door (the sheet's write's own rule).
    expect(factsDoorsOf(open, { can: sales, readOnly: false, busy: false })).toEqual({ customerRef: null, shipTo: null, priority: null, season: null, note: null })
    const noManage = { key: 'held.noManage' }
    expect(factsDoorsOf(open, { can: planner, readOnly: false, busy: false, depthCan: depthCanOf(rolePermissions('planner')) })).toEqual({ customerRef: noManage, shipTo: noManage, priority: noManage, season: noManage, note: noManage })
    const final = { key: 'held.final' }
    for (const status of ['CLOSED', 'CANCELLED'] as const) expect(factsDoorsOf(withFacts(status), { can: sales, readOnly: false, busy: false })).toEqual({ customerRef: final, shipTo: final, priority: final, season: final, note: final })
    const busy = { key: 'held.busy' }
    expect(factsDoorsOf(open, { can: sales, readOnly: false, busy: true })).toEqual({ customerRef: busy, shipTo: busy, priority: busy, season: busy, note: busy })
    // Shipped: the PO and Ship to follow the amendment's rule (a later change is a return); the priority, season and note still change.
    expect(factsDoorsOf(withFacts('SHIPPED'), { can: sales, readOnly: false, busy: false })).toEqual({ customerRef: { key: 'held.amendShipped' }, shipTo: { key: 'held.amendShipped' }, priority: null, season: null, note: null })
    expect(factsDoorsOf(open, { can: abilitiesOf(rolePermissions('read_only')), readOnly: true, busy: false })).toBeNull()
  })

  it('Made names the office person who made it and the order date only when it is another day; Ship to as one line; the delivery terms', () => {
    expect(madeOf(withFacts())).toEqual({ by: 'Sara Vendite', ordered: null })
    expect(madeOf(withFacts('IN_PRODUCTION', { createdById: null }))).toEqual({ by: null, ordered: null })
    expect(madeOf(withFacts('IN_PRODUCTION', { orderDate: '2026-10-27' }))).toEqual({ by: 'Sara Vendite', ordered: '2026-10-27' })
    expect(shipToOf(withFacts())).toBe('Brand Alpha · Via Esempio 1 · 59100 Prato')
    expect(shipToOf(order('IN_PRODUCTION'))).toBeNull()
    // Not sent (an older answer, B-OO-013 not there yet): the row is left out; sent: what it says, "as ready" / "complete".
    expect(incotermOf(order('IN_PRODUCTION'))).toBeNull()
    expect(incotermOf(withFacts('IN_PRODUCTION', { incoterm: 'EXW', incotermPlace: ' Prato ', shipComplete: false }))).toEqual({ code: 'EXW', place: 'Prato', ship: 'asReady' })
    expect(incotermOf(withFacts('IN_PRODUCTION', { incoterm: null, incotermPlace: null, shipComplete: true }))).toEqual({ code: null, place: null, ship: 'complete' })
  })
})

describe('F-OO-209: Order facts drawn', () => {
  it('as Sales: Change… (Customer PO, Ship to) and Set… (Priority, Season) live; the fixed facts say Fixed with no button (en, it)', () => {
    const value = withFacts('IN_PRODUCTION', { incoterm: 'EXW', incotermPlace: 'Prato', shipComplete: false })
    for (const locale of LOCALES) {
      const html = draw(value, modelOf('sales', value), locale)
      const change = buttons(html, locale === 'en' ? 'Change…' : 'Cambia…')
      const set = buttons(html, locale === 'en' ? 'Set…' : 'Imposta…')
      expect(change, locale).toHaveLength(2)
      expect(set, locale).toHaveLength(2)
      for (const tag of [...change, ...set]) expect(tag, locale).not.toContain('aria-disabled')
      // Fixed: payment · currency, language · tax mode, the Incoterm — quiet words, never a control.
      expect(html.match(locale === 'en' ? />Fixed<\/span>/g : />Fisso<\/span>/g), locale).toHaveLength(3)
      expect(buttons(html, locale === 'en' ? 'Fixed' : 'Fisso'), locale).toHaveLength(0)
      expect(html).toContain(locale === 'en' ? 'title="Set when the order was made; it does not change."' : 'title="Fissato quando l&#x27;ordine è stato creato; non cambia."')
      const text = textOf(html)
      for (const words of locale === 'en'
        ? ['Order facts', 'Customer PO', 'PO-ESEMPIO-88', 'Ship to', 'Brand Alpha · Via Esempio 1 · 59100 Prato', 'Priority', 'High', 'Season', 'FW27 · Fall-Winter 2027', 'Payment · currency', 'Bonifico 30 gg d.f. · EUR', 'Language · tax mode', 'Italian · Italian business', 'Incoterm', 'EXW · Ex Works · Prato · Ship as ready', 'Made', '28/10/2026 by Sara Vendite · changed 29/10/2026']
        : ["Dati dell'ordine", 'Ordine del cliente', 'Spedire a', 'Priorità', 'Alta', 'Stagione', 'Pagamento · valuta', 'Lingua · regime fiscale', 'Italiano · Impresa italiana', 'EXW · Franco fabbrica · Prato · Spedizione appena pronto', 'Creato', '28/10/2026 da Sara Vendite · modificato il 29/10/2026'])
        expect(text, `${locale}: ${words}`).toContain(words)
      expect(html).not.toMatch(/\bfacts\.[a-zA-Z.]+|\boverview\.facts\.[a-zA-Z.]+|\bterms\.[a-zA-Z.]+|\bincoterm\.[A-Z]+/)
    }
  })

  it('as the Planner: every door held with the sales right\'s words (en, it)', () => {
    const value = withFacts()
    for (const locale of LOCALES) {
      const html = draw(value, modelOf('planner', value), locale)
      const doors = [...buttons(html, locale === 'en' ? 'Change…' : 'Cambia…'), ...buttons(html, locale === 'en' ? 'Set…' : 'Imposta…')]
      expect(doors, locale).toHaveLength(4)
      for (const tag of doors) expect(tag, locale).toContain(`aria-description="${locale === 'en' ? 'Changing an order needs the sales right to manage orders' : 'Cambiare un ordine richiede il diritto vendite di gestire gli ordini'}"`)
    }
  })

  it('a CLOSED (or cancelled) order: every door held with held.final', () => {
    for (const status of ['CLOSED', 'CANCELLED'] as const) {
      const value = withFacts(status)
      const html = draw(value, modelOf('sales', value))
      const doors = [...buttons(html, 'Change…'), ...buttons(html, 'Set…')]
      expect(doors, status).toHaveLength(4)
      for (const tag of doors) expect(tag, status).toContain('aria-description="A closed or cancelled order never changes"')
    }
  })

  it('read-only: the facts and Fixed, no button at all', () => {
    const value = withFacts()
    const html = draw(value, modelOf('read_only', value))
    expect(html).not.toContain('<button')
    expect(textOf(html)).toContain('PO-ESEMPIO-88')
    expect(html).toContain('>Fixed</span>')
  })

  it('the order\'s language in words: de reads German / Tedesco (not "Italian" for every code but en)', () => {
    const value = withFacts('IN_PRODUCTION', { language: 'de' })
    expect(textOf(draw(value, modelOf('sales', value), 'en'))).toContain('German · Italian business')
    expect(textOf(draw(value, modelOf('sales', value), 'it'))).toContain('Tedesco · Impresa italiana')
  })

  it('the depth while it reads (a Skeleton, no Set… yet) and when it failed ("—" and could not be read); without the terms no Incoterm row', () => {
    const value = withFacts()
    const permissions = rolePermissions('sales')
    const reading = draw(value, modelOf('sales', value, { depth: depthOf(permissions, { value: null, problem: null }) }))
    expect(reading).toContain('nds-skeleton')
    expect(buttons(reading, 'Set…')).toHaveLength(0)
    const failed = draw(value, modelOf('sales', value, { depth: depthOf(permissions, { value: null, problem: 'x' }) }))
    expect(textOf(failed)).toContain('— · Could not be read')
    expect(buttons(failed, 'Set…')).toHaveLength(0)
    expect(textOf(failed)).not.toContain('Incoterm')
    // An order date of another day than the day it was made is said; a maker not named reads the dates only.
    expect(textOf(draw({ ...value, orderDate: '2026-10-27', createdById: null }, modelOf('sales', value)))).toContain('28/10/2026 · changed 29/10/2026 · ordered 27/10/2026')
  })

  it('one place per fact: Made lives here (People\'s Made by words went), the requested date is Next dates\' (no Requested row here)', () => {
    const value = withFacts()
    for (const locale of LOCALES) {
      const text = textOf(draw(value, modelOf('sales', value), locale))
      expect(text, locale).toContain(locale === 'en' ? 'Made 28/10/2026 by Sara Vendite' : 'Creato 28/10/2026 da Sara Vendite')
      expect(text, locale).not.toContain(locale === 'en' ? 'Requested' : 'Richiest')
      const catalogue = JSON.parse(readFileSync(new URL(`../../../../../../messages/${locale}/orders.json`, import.meta.url), 'utf8')) as { overview: { people: Record<string, unknown> } }
      expect(Object.keys(catalogue.overview.people), locale).not.toContain('madeBy')
      expect(Object.keys(catalogue.overview.people), locale).not.toContain('madeByOn')
    }
    expect(readFileSync(new URL('../view/overview/FactsCard.tsx', import.meta.url), 'utf8')).not.toMatch(/requestedDate|dates\.requested/)
  })

  it('the one edit path: Customer PO\'s Change… starts (or keeps) edit mode and focuses the PO field, which carries the id', () => {
    const calls: string[] = []
    function Harness() {
      const acts = useOverviewActs({ startAmend: () => calls.push('edit mode'), focus: (id) => calls.push(`focus ${id}`) })
      acts.actions.onCustomerRefChange?.()
      return null
    }
    render(createElement(Harness), 'en')
    expect(calls).toEqual(['edit mode', `focus ${CUSTOMER_REF_FIELD_ID}`])
    const lines = readFileSync(new URL('../view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(lines).toContain('<Input id={CUSTOMER_REF_FIELD_ID} value={amend.customerRef}')
    const card = readFileSync(new URL('../view/overview/FactsCard.tsx', import.meta.url), 'utf8')
    expect(card).toContain('onClick={() => actions?.onCustomerRefChange?.()}')
    expect(card).toContain('onClick={() => actions?.onChangeShipTo?.()}')
    expect(card).toContain("actions?.depth?.onDialog?.({ kind: 'priority'")
    expect(card).toContain("actions?.depth?.onDialog?.({ kind: 'season'")
    expect(readFileSync(new URL('../view/OverviewTab.tsx', import.meta.url), 'utf8')).toContain('<FactsCard order={order} model={model} actions={actions')
  })
})

// ---- F-OO-210 (order overview 11-design §7.3; Owner D4): the office note — one row of Order facts, the Orders sheet's own write ----
describe('F-OO-210: the office note', () => {
  const NOTE = 'Chiama prima della consegna: il magazzino chiude alle 16.'
  const noted = (status: Order['status'] = 'IN_PRODUCTION', internalNote: string | null = NOTE) => withFacts(status, { internalNote })
  const drawNote = (value: Order, model: OrderRecordModel, locale: (typeof LOCALES)[number] = 'en', dialog: RecordDialog = { kind: 'note' }) => render(createElement(OrderNoteDialog, { order: value, model: { ...model, dialog } }), locale)

  it('the body: the sheet\'s list, one row — the order, its version as read, the note (trimmed; empty: none)', () => {
    const value = noted()
    expect(noteBodyOf(value, `  ${NOTE}  `)).toEqual({ listKey: 'sales.orders', rows: [{ id: value.id, version: value.version, changes: { note: NOTE } }] })
    expect(noteBodyOf(value, '   ')).toEqual({ listKey: 'sales.orders', rows: [{ id: value.id, version: value.version, changes: { note: null } }] })
    // The cell's limit: the API's NOTE_MAX (the order's note within the bulk text limit).
    expect(NOTE_MAX).toBe(2000)
  })

  it('held / stale / forbidden in words: the rule, the dialog\'s problems, each refusal of the write', () => {
    expect(noteHeldOf(noted(), abilitiesOf(rolePermissions('sales')), false)).toBeNull()
    expect(noteHeldOf(noted(), abilitiesOf(rolePermissions('planner')), false)).toEqual({ key: 'held.noManage' })
    expect(noteHeldOf(noted('CLOSED'), abilitiesOf(rolePermissions('sales')), false)).toEqual({ key: 'held.final' })
    expect(noteHeldOf(noted('CANCELLED'), abilitiesOf(rolePermissions('sales')), false)).toEqual({ key: 'held.final' })
    expect(noteHeldOf(noted(), abilitiesOf(rolePermissions('sales')), true)).toEqual({ key: 'held.busy' })
    expect(noteProblem(` ${NOTE} `, NOTE)).toEqual({ key: 'facts.note.same' })
    expect(noteProblem('', null)).toEqual({ key: 'facts.note.same' })
    expect(noteProblem('x'.repeat(NOTE_MAX + 1), null)).toEqual({ key: 'facts.note.long', params: { max: NOTE_MAX } })
    expect(noteProblem('', NOTE)).toBeNull()
    // The row's answer: taken; stale (someone changed it first: read again); held (closed or cancelled); forbidden (the right).
    expect(noteRefusalOf({ ok: true, refusal: null })).toBeNull()
    expect(noteRefusalOf({ ok: false, refusal: { code: 'stale' } })).toEqual({ key: 'problem.write.moved' })
    expect(noteRefusalOf({ ok: false, refusal: { code: 'held' } })).toEqual({ key: 'held.final' })
    expect(noteRefusalOf({ ok: false, refusal: { code: 'forbidden' } })).toEqual({ key: 'held.noManage' })
    expect(noteRefusalOf({ ok: false, refusal: { code: 'failed' } })).toEqual({ key: 'problem.write.internal' })
    expect(noteRefusalOf(undefined)).toEqual({ key: 'problem.write.internal' })
    // The write refused as a whole (the list tools' problem).
    expect(noteFailureOf('forbidden')).toEqual({ key: 'held.noManage' })
    expect(noteFailureOf('stale')).toEqual({ key: 'problem.write.moved' })
    expect(noteFailureOf('offline')).toEqual({ key: 'problem.write.unavailable' })
    expect(noteFailureOf('failed')).toEqual({ key: 'problem.write.internal' })
  })

  it('the row: "Office note · Only the office sees it", the note, Change… live for Sales; "No note" when empty; absent when not read', () => {
    for (const locale of LOCALES) {
      const html = draw(noted(), modelOf('sales', noted()), locale)
      const text = textOf(html)
      for (const words of locale === 'en' ? ['Office note', 'Only the office sees it', NOTE] : ["Nota dell'ufficio", "Solo l'ufficio la vede", NOTE]) expect(text, `${locale}: ${words}`).toContain(words)
      const change = buttons(html, locale === 'en' ? 'Change…' : 'Cambia…')
      expect(change, locale).toHaveLength(3) // Customer PO, Ship to, the note
      for (const tag of change) expect(tag, locale).not.toContain('aria-disabled')
      expect(html).toContain('fw-so-fact-note')
    }
    expect(textOf(draw(noted('IN_PRODUCTION', null), modelOf('sales', noted())))).toContain('No note')
    expect(textOf(draw(withFacts(), modelOf('sales', withFacts())))).not.toContain('Office note')
  })

  it('the row\'s Change…: held for the Planner and on a closed order; read-only: no Change… at all', () => {
    const planner = draw(noted(), modelOf('planner', noted()))
    expect(buttons(planner, 'Change…')).toHaveLength(3)
    for (const tag of buttons(planner, 'Change…')) expect(tag).toContain('aria-description="Changing an order needs the sales right to manage orders"')
    const closed = draw(noted('CLOSED'), modelOf('sales', noted('CLOSED')))
    for (const tag of buttons(closed, 'Change…')) expect(tag).toContain('aria-description="A closed or cancelled order never changes"')
    const readOnly = draw(noted(), modelOf('read_only', noted()))
    expect(readOnly).not.toContain('<button')
    expect(textOf(readOnly)).toContain(NOTE)
  })

  it('the dialog (en, it): title, hint, the counter\'s limit; Save note held until the note changes; a refusal said in words', () => {
    const value = noted()
    const sales = modelOf('sales', value)
    const goTag = (html: string, label: string) => {
      const at = html.indexOf(`>${label}</button>`)
      expect(at, label).toBeGreaterThan(-1)
      return html.slice(html.lastIndexOf('<button', at), at)
    }
    const en = drawNote(value, sales)
    for (const words of ['Office note · SO-2026-0088', 'Only the office reads it; the customer never does.', NOTE]) expect(textOf(en), words).toContain(words)
    expect(goTag(en, 'Save note')).toContain('aria-description="It is the note already"')
    const it = drawNote(value, sales, 'it')
    for (const words of ["Nota dell'ufficio · SO-2026-0088", "La legge solo l'ufficio; il cliente mai."]) expect(textOf(it), words).toContain(words)
    expect(goTag(it, 'Salva la nota')).toContain('aria-description="È già questa la nota"')
    // Typed: live.
    expect(goTag(drawNote(value, { ...sales, draft: { message: 'Consegna solo al mattino.' } }), 'Save note')).not.toContain('aria-disabled')
    // The refusals of the write, in the dialog (what was typed stays: the dialog is the same).
    expect(textOf(drawNote(value, sales, 'en', { kind: 'note', refused: { key: 'problem.write.moved' } }))).toContain('Someone changed this order meanwhile: it was read again, check it and try once more.')
    expect(textOf(drawNote(value, sales, 'en', { kind: 'note', refused: { key: 'held.final' } }))).toContain('A closed or cancelled order never changes')
    expect(textOf(drawNote(value, sales, 'it', { kind: 'note', refused: { key: 'held.noManage' } }))).toContain('Cambiare un ordine richiede il diritto vendite di gestire gli ordini')
    // Held before the click: the Planner, a closed order.
    expect(goTag(drawNote(value, { ...modelOf('planner', value), draft: { message: 'x' } }), 'Save note')).toContain('aria-description="Changing an order needs the sales right to manage orders"')
    expect(goTag(drawNote(noted('CLOSED'), { ...sales, draft: { message: 'x' } }), 'Save note')).toContain('aria-description="A closed or cancelled order never changes"')
    for (const locale of LOCALES) expect(drawNote(value, sales, locale)).not.toMatch(/\bfacts\.note\.[a-zA-Z]+/)
  })

  it('the write: the sheet\'s own bulk apply with the version; taken: the dialog closes, the notice; refused: said in the dialog; then read again', async () => {
    const value = noted()
    const run = async (answer: () => Promise<unknown>) => {
      const posts: { path: string; body: unknown; key: unknown }[] = []
      const dialogs: (RecordDialog | null)[] = []
      const notices: unknown[] = []
      const writes: { success: unknown; keep: unknown; answered?: unknown }[] = []
      const api = { post: (path: string, options: { body: unknown; idempotencyKey?: unknown }) => (posts.push({ path, body: options.body, key: options.idempotencyKey }), answer()) } as unknown as ApiClient
      const base = {
        api,
        orderId: value.id,
        current: { current: value },
        version: () => value.version,
        setNotice: (notice: unknown) => notices.push(notice),
        load: async () => undefined,
        loadParts: () => undefined,
        write: async (task: () => Promise<Order | null>, success: string | null, keep?: boolean) => {
          const entry: { success: unknown; keep: unknown; answered?: unknown } = { success, keep }
          writes.push(entry)
          entry.answered = await task()
        },
      } as unknown as RecordActsBase
      let save: ((note: string) => void) | undefined
      function Harness() {
        save = useOverviewActs({ setDialog: (dialog) => dialogs.push(dialog), base }).actions.onNoteSave
        return null
      }
      render(createElement(Harness), 'en')
      save!(`  ${NOTE} (2)  `)
      for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
      return { posts, dialogs, notices, writes }
    }
    const took = await run(async () => ({ results: [{ id: value.id, label: value.number, ok: true, refusal: null, before: { note: NOTE }, after: { note: `${NOTE} (2)` }, version: value.version + 1 }] }))
    expect(took.posts).toEqual([{ path: '/views/bulk/apply', body: { listKey: 'sales.orders', rows: [{ id: value.id, version: value.version, changes: { note: `${NOTE} (2)` } }] }, key: expect.any(String) }])
    // The page's one write, the dialog kept by it (closed here on success); null answered: the page reads the order again.
    expect(took.writes).toEqual([{ success: null, keep: true, answered: null }])
    expect(took.dialogs).toEqual([{ kind: 'note' }, null])
    expect(took.notices).toEqual([{ tone: 'success', words: { key: 'facts.note.saved' } }])
    const stale = await run(async () => ({ results: [{ id: value.id, label: value.number, ok: false, refusal: { code: 'stale' }, before: {}, after: {}, version: value.version + 1 }] }))
    expect(stale.dialogs).toEqual([{ kind: 'note' }, { kind: 'note', refused: { key: 'problem.write.moved' } }])
    expect(stale.notices).toEqual([])
    const closed = await run(async () => ({ results: [{ id: value.id, label: value.number, ok: false, refusal: { code: 'held', status: 'CLOSED' }, before: {}, after: {}, version: value.version }] }))
    expect(closed.dialogs.at(-1)).toEqual({ kind: 'note', refused: { key: 'held.final' } })
    const forbidden = await run(async () => Promise.reject(new ApiError('forbidden', 403, 'forbidden', 'You may not change the records of this list.')))
    expect(forbidden.dialogs.at(-1)).toEqual({ kind: 'note', refused: { key: 'held.noManage' } })
  })

  it('the wiring: the page\'s one slot, the container\'s acts base; the customer never reads the note (no portal-orders read carries it)', () => {
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    // F-OO-106: the line goes on after the base (F-OO-145's gates, F-OO-106's credit): the pin reads up to the base.
    expect(container).toContain('setDialog /* F-OO-144 */, base: actsBase /* F-OO-210 */')
    const dialogs = readFileSync(new URL('../view/Dialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain("case 'note':\n      return <OrderNoteDialog order={order} model={model} actions={actions} />")
    expect(readFileSync(new URL('../view/overview/FactsCard.tsx', import.meta.url), 'utf8')).toContain("onClick={() => actions?.onDialog?.({ kind: 'note' })}")
    /** Every source file (no test) under a folder. */
    const sources = (dir: URL): string[] =>
      readdirSync(dir).flatMap((name) => {
        const at = new URL(name, dir)
        if (statSync(at).isDirectory()) return sources(new URL(`${name}/`, dir))
        return /\.tsx?$/.test(name) && !/\.(?:vitest\.)?test\.tsx?$/.test(name) ? [fileURLToPath(at)] : []
      })
    const portal = [
      ...sources(new URL('../../../../../../../factory-api/src/modules/sales/portal-orders/', import.meta.url)),
      ...sources(new URL('../../../../../../../../packages/factory-domain/src/sales/portal-orders/', import.meta.url)),
      ...sources(new URL('../../../../../portal/customer/', import.meta.url)),
    ]
    expect(portal.length).toBeGreaterThan(10)
    for (const file of portal) expect(readFileSync(file, 'utf8'), file).not.toContain('internalNote')
  })
})
// ---- end F-OO-210
