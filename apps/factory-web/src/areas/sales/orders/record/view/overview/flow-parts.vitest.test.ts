import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ORDER_LIFE } from '@nexus/factory-domain/sales/order-life'
import { I18nProvider } from '../../../../../../lib/i18n/provider'
import { LOCALES } from '../../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../../lib/i18n/messages'
import { ORDER_FLOW_NS } from '../../flow-words'
import { mayRestrict, textCardOf } from '../../band/model'
import { FloorFact, NextBox, OrderTextCard } from './FlowParts'

/**
 * owb-of5 step 2 — the Overview's new parts in the section kit (design plan § 5i, § 5g): Restrict on the floor is drawn for sales
 * (orders.manage), never for the designer; a text order shows "The order as it was written", a catalogue order does not; the next box
 * says each life in words. Written, not run (Owner rule).
 */

const html = (node: ReactElement): string => renderToString(createElement(I18nProvider, { locale: 'en', messages: {} }, node))
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

const SALES = ['orders.view', 'orders.manage', 'workorders.view']
const DESIGNER = ['orders.view.own', 'files.read', 'files.upload', 'threads.read', 'threads.post', 'product.drafts.edit']

describe('owb-of5 step 2: Restrict on the floor', () => {
  it('drawn for sales (orders.manage), not for the designer (orders.view.own)', () => {
    expect(mayRestrict(SALES)).toBe(true)
    expect(mayRestrict(DESIGNER)).toBe(false)
    const forSales = html(createElement(FloorFact, { restricted: null, may: mayRestrict(SALES), busy: false, problem: null }))
    expect(forSales).toContain('Restrict on the floor')
    expect(forSales).toContain('The department sees it')
    const forDesigner = html(createElement(FloorFact, { restricted: null, may: mayRestrict(DESIGNER), busy: false, problem: null }))
    expect(forDesigner).not.toContain('Restrict on the floor')
    expect(forDesigner).toContain('The department sees it')
  })
  it('a restricted order says who and offers Open it to the department; a refusal is said in words', () => {
    const restricted = html(createElement(FloorFact, { restricted: { by: 'Bea Esempio', at: '2026-11-28T09:00:00Z' }, may: true, busy: false, problem: 'restrict.failed' }))
    expect(restricted).toContain('Only named workers')
    expect(restricted).toContain('Bea Esempio')
    expect(restricted).toContain('Open it to the department')
    expect(restricted).toContain('The floor setting could not be saved')
  })
  it('Order facts mounts it for the page, held to who may and to an order that is not final', () => {
    const facts = read('./FactsCard.tsx')
    expect(facts).toContain('<FloorFact restricted={model.flow.restrict.now} may={model.flow.restrict.may && !readOnly && !isFinal(order)}')
  })
})

describe('owb-of5 step 2: "The order as it was written"', () => {
  const textOrder = { subject: 'Team jackets 2027', note: 'Ten jackets like last year,\nlogo on the back.', customLines: [{ seq: 1, kind: 'DESCRIBED', description: 'Jacket, black, with our logo' }], files: { references: [{ id: 'file-1', originalName: 'logo.pdf' }, { id: 'file-2', originalName: null }] } }
  it('a text order shows the text card: the subject, the words, its lines in the customer words, its files (a locked name left out)', () => {
    const card = textCardOf(textOrder)
    expect(card).toEqual({ subject: 'Team jackets 2027', text: 'Ten jackets like last year,\nlogo on the back.', lines: [{ seq: 1, words: 'Jacket, black, with our logo' }], files: [{ id: 'file-1', name: 'logo.pdf' }] })
    const drawn = html(createElement(OrderTextCard, { card: card! }))
    expect(drawn).toContain('The order as it was written')
    expect(drawn).toContain('Team jackets 2027')
    expect(drawn).toContain('Jacket, black, with our logo')
    expect(drawn).toContain('logo.pdf')
  })
  it('an order typed from the catalogue (no words, no line in the customer words) has no card', () => {
    expect(textCardOf({ subject: 'Repeat', note: null, customLines: [{ seq: 1, kind: 'MADE_TO_MEASURE', description: null }] })).toBeNull()
    expect(textCardOf({ note: '   ', customLines: [] })).toBeNull()
    expect(textCardOf(null)).toBeNull()
  })
  it('the Overview draws it after the cards, only when the order came as text; the draft page says the ONE text notice', () => {
    expect(read('../OverviewTab.tsx')).toContain('{model.flow?.text ? <OrderTextCard card={model.flow.text} /> : null}')
    expect(read('../../../draft/view/OfficeDraftView.tsx')).toContain("<Banner tone=\"info\" title={f('text.notice')} />")
  })
})

describe('owb-of5 step 2: Where it is now — the mockup, the next box, the departments; People\'s doors; the words', () => {
  it('the next box says every life in words', () => {
    for (const life of ORDER_LIFE) expect(html(createElement(NextBox, { life })), life).toContain('What happens next')
    expect(html(createElement(NextBox, { life: 'CONFIRMED' }))).toContain('Confirmed: waits for the print')
  })
  it('the cards mount the parts: Where it is now (the hero), People (Add people, the designer), Linked records (Customer)', () => {
    expect(read('./WhereCard.tsx')).toContain('<WhereHero orderId={order.id}')
    expect(read('./PeopleCard.tsx')).toContain("<PeopleDoors onFollowers={() => frame.openDoor?.('followers')}")
    expect(read('./LinkedCard.tsx')).toContain("<Row label={f('linked.customer')}>")
  })
  it('every new word in English and Italian', () => {
    const keys = ['mockup.alt', 'mockup.none', 'next.title', 'next.yours', ...ORDER_LIFE.map((life) => `next.${life}`), 'floor.label', 'floor.open', 'floor.restricted', 'floor.by', 'floor.restrict', 'floor.lift', 'floor.busy', 'floor.failed', 'people.add', 'people.designer', 'text.title', 'text.lines', 'text.line', 'text.files', 'text.notice', 'linked.customer']
    for (const locale of LOCALES) for (const key of keys) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
