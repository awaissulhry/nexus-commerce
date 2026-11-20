import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
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
    expect(factsDoorsOf(open, { can: sales, readOnly: false, busy: false })).toEqual({ customerRef: null, shipTo: null, priority: null, season: null })
    const noManage = { key: 'held.noManage' }
    expect(factsDoorsOf(open, { can: planner, readOnly: false, busy: false, depthCan: depthCanOf(rolePermissions('planner')) })).toEqual({ customerRef: noManage, shipTo: noManage, priority: noManage, season: noManage })
    const final = { key: 'held.final' }
    for (const status of ['CLOSED', 'CANCELLED'] as const) expect(factsDoorsOf(withFacts(status), { can: sales, readOnly: false, busy: false })).toEqual({ customerRef: final, shipTo: final, priority: final, season: final })
    expect(factsDoorsOf(open, { can: sales, readOnly: false, busy: true })).toEqual({ customerRef: { key: 'held.busy' }, shipTo: { key: 'held.busy' }, priority: { key: 'held.busy' }, season: { key: 'held.busy' } })
    // Shipped: the PO and Ship to follow the amendment's rule (a later change is a return); the priority and season still change.
    expect(factsDoorsOf(withFacts('SHIPPED'), { can: sales, readOnly: false, busy: false })).toEqual({ customerRef: { key: 'held.amendShipped' }, shipTo: { key: 'held.amendShipped' }, priority: null, season: null })
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
