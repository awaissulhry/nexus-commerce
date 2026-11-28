import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { designScreen, ORDER_BY_HAND, ORDER_MANY_PRINTED, ORDER_ONE, RULES, STRUCTURES } from './fixtures'
import {
  aboveIds,
  CATEGORIES,
  fromWordsOf,
  headOf,
  moveRuleIds,
  newRuleDraftOf,
  newStructureDraftOf,
  orderDraftOf,
  orderHeldOf,
  orderPartOf,
  placeOf,
  ruleBodyOf,
  ruleDraftOf,
  ruleHeldOf,
  ruleMarkOf,
  ruleNoOf,
  rulesOf,
  sameRuleOf,
  sentenceOf,
  structureBodyOf,
  structureDraftOf,
  structureHeldOf,
  teamsNoteOf,
  togglePerson,
  toggleTeam,
} from './model'
import { CustomerStructurePartView, OrderStructurePartView } from './view/Parts'
import { OrderStructuresView } from './view/OrderStructuresView'

/**
 * owb-ss8 (S3 web B; design plan § 5zj C) — Production › Order structures (8.3) and the order's and the customer's parts (8.4). Written,
 * not run (Owner rule: checks at the end). Made-up data (fixtures.ts).
 */

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const { open, closed } = rulesOf(RULES)

describe('8.3 the rules — one list read from the top', () => {
  it('open rules in their order, closed ones kept apart; a rule\'s number is its place', () => {
    expect(open.map((rule) => rule.id)).toEqual(['r-gloves', 'r-alpha', 'r-alpha-suits', 'r-any-gloves'])
    expect(closed.map((rule) => rule.id)).toEqual(['r-closed'])
    expect(ruleNoOf(open, 'r-alpha')).toBe(2)
    expect(ruleNoOf(open, 'r-closed')).toBe(0)
  })

  it('the sentence words: its customer (or any), its category (or any), its structure', () => {
    expect(sentenceOf(open[0]!)).toEqual({ customer: 'Brand Alpha', category: 'GLOVES', structure: 'Gloves · short way' })
    expect(sentenceOf(open[3]!)).toEqual({ customer: null, category: 'GLOVES', structure: 'Gloves · short way' })
    expect(CATEGORIES).toContain('SUIT') // S4 ProductType: one marked place
  })

  it('marks: never used (with the rule above that takes it), a closed structure, the open orders it fits now', () => {
    expect(ruleMarkOf(open, open[2]!)).toEqual({ kind: 'dead', above: 2 })
    expect(ruleMarkOf(open, open[1]!)).toEqual({ kind: 'fits', count: 2 })
    expect(ruleMarkOf(open, { ...open[1]!, structure: { ...open[1]!.structure, closed: true } })).toEqual({ kind: 'closedStructure' })
    expect(headOf(STRUCTURES, RULES, 1)).toEqual({ structures: 2, rules: 4, neverUsed: 1 })
  })

  it('arrows: up and down swap with the neighbour; none past an end; "Move it up" goes right above the rule that takes it', () => {
    expect(moveRuleIds(open, 'r-alpha', -1)).toEqual(['r-alpha', 'r-gloves', 'r-alpha-suits', 'r-any-gloves'])
    expect(moveRuleIds(open, 'r-alpha', 1)).toEqual(['r-gloves', 'r-alpha-suits', 'r-alpha', 'r-any-gloves'])
    expect(moveRuleIds(open, 'r-gloves', -1)).toBeNull()
    expect(moveRuleIds(open, 'r-any-gloves', 1)).toBeNull()
    expect(aboveIds(open, 'r-alpha-suits', 'r-alpha')).toEqual(['r-gloves', 'r-alpha-suits', 'r-alpha', 'r-any-gloves'])
    expect(aboveIds(open, 'r-alpha-suits', 'r-gone')).toBeNull()
  })

  it('a new rule is placed above the first rule that would take all its orders, else last', () => {
    expect(placeOf(open, { partyId: 'party-alpha', category: 'SUIT' })).toBe(2) // Brand Alpha · any takes it
    expect(placeOf(open, { partyId: null, category: 'JACKET' })).toBe(5) // nobody takes every customer's jackets
    expect(placeOf(open, { partyId: 'party-beta', category: 'GLOVES' })).toBe(4) // any customer · gloves takes it
  })

  it('two rules for exactly the same orders are refused, with the number of the other rule', () => {
    expect(sameRuleOf(open, { id: null, partyId: 'party-alpha', category: null })?.id).toBe('r-alpha')
    expect(sameRuleOf(open, { id: 'r-alpha', partyId: 'party-alpha', category: null })).toBeNull()
    expect(ruleHeldOf({ ...newRuleDraftOf({ partyId: 'party-alpha' }), structureId: 's-race' }, open, STRUCTURES)).toEqual({ key: 'rule.held.same', params: { n: 2 } })
  })

  it('the rule window: a structure is needed (an open one), a note at most 120; the body', () => {
    const draft = newRuleDraftOf({ partyId: 'party-beta', category: 'JACKET' })
    expect(ruleHeldOf(draft, open, STRUCTURES)).toEqual({ key: 'rule.held.structure' })
    expect(ruleHeldOf({ ...draft, structureId: 's-old' }, open, STRUCTURES)).toEqual({ key: 'rule.held.closed' })
    expect(ruleHeldOf({ ...draft, structureId: 's-race', note: 'x'.repeat(121) }, open, STRUCTURES)).toEqual({ key: 'held.long', params: { count: 120 } })
    expect(ruleHeldOf({ ...draft, structureId: 's-race' }, open, STRUCTURES)).toBeNull()
    expect(ruleBodyOf({ ...draft, structureId: 's-race', note: ' agreed in March ' })).toEqual({ partyId: 'party-beta', category: 'JACKET', structureId: 's-race', note: 'agreed in March' })
    expect(ruleDraftOf(open[1]!)).toEqual({ id: 'r-alpha', version: 1, partyId: 'party-alpha', category: null, structureId: 's-race', note: '' })
  })
})

describe('8.3 the structures', () => {
  it('the window: teams (the first in charge when several), office people, a name once among the open ones, a note at most 140', () => {
    let draft = toggleTeam(toggleTeam(newStructureDraftOf(), 'team-kian'), 'team-noor')
    expect(draft.teamIds).toEqual(['team-kian', 'team-noor'])
    expect(teamsNoteOf(draft)).toEqual({ key: 'structure.teams.many' })
    expect(teamsNoteOf(toggleTeam(draft, 'team-noor'))).toEqual({ key: 'structure.teams.one' })
    expect(teamsNoteOf(newStructureDraftOf())).toEqual({ key: 'structure.teams.none' })
    draft = togglePerson(draft, 'user-sam')
    expect(structureHeldOf(draft, STRUCTURES)).toEqual({ key: 'structure.held.name' })
    expect(structureHeldOf({ ...draft, name: 'gloves · SHORT way' }, STRUCTURES)).toEqual({ key: 'structure.held.taken' })
    expect(structureHeldOf({ ...draft, name: 'Old way' }, STRUCTURES)).toBeNull() // a closed one keeps its name, a new one may take it
    expect(structureBodyOf({ ...draft, name: ' Club jackets ' })).toEqual({ name: 'Club jackets', teamIds: ['team-kian', 'team-noor'], peopleUserIds: ['user-sam'] })
    expect(structureDraftOf(STRUCTURES[1]!, true)).toMatchObject({ id: null, version: 0, name: 'Gloves · short way', teamIds: ['team-kian', 'team-lia'] })
  })
})

describe('8.4 the order\'s part and the customer\'s part — per right and after the print', () => {
  it('one structure for every line: one sentence with its source; Another structure… before the print with the right', () => {
    const part = orderPartOf(ORDER_ONE)
    expect(part).toMatchObject({ one: true, answer: { key: 'order.one', params: { name: 'Brand Alpha · race team' } }, button: 'CHANGE', back: false })
    expect(fromWordsOf(ORDER_ONE.lines[0]!, 2)).toEqual({ key: 'from.ruleN', params: { n: 2 } })
    expect(orderPartOf({ ...ORDER_ONE, may: { change: false } }).button).toBeNull()
  })

  it('after the first print: kept, no button, each line its own structure', () => {
    const part = orderPartOf(ORDER_MANY_PRINTED)
    expect(part).toMatchObject({ one: false, printed: true, button: null, back: false, answer: { key: 'order.manyKept', params: { count: 2 } } })
  })

  it('by hand: "Back to the rules" is offered; the source says why; the normal way said in words', () => {
    const part = orderPartOf(ORDER_BY_HAND)
    expect(part).toMatchObject({ one: true, back: true, answer: { key: 'order.normal' } })
    expect(fromWordsOf(ORDER_BY_HAND.lines[0]!, 0)).toEqual({ key: 'from.orderWhy', params: { why: 'A show piece' } })
    expect(fromWordsOf({ from: 'NORMAL', why: '' }, 0)).toEqual({ key: 'from.normal' })
  })

  it('the order window: a structure or the normal way, and why (needed); it starts from the by-hand choice', () => {
    expect(orderDraftOf(ORDER_ONE)).toEqual({ structureId: undefined, why: '' })
    expect(orderDraftOf(ORDER_BY_HAND)).toEqual({ structureId: null, why: 'A show piece' })
    expect(orderHeldOf({ structureId: undefined, why: 'x' }, STRUCTURES)).toEqual({ key: 'order.held.pick' })
    expect(orderHeldOf({ structureId: 's-old', why: 'x' }, STRUCTURES)).toEqual({ key: 'rule.held.closed' })
    expect(orderHeldOf({ structureId: 's-race', why: ' ' }, STRUCTURES)).toEqual({ key: 'order.held.why' })
    expect(orderHeldOf({ structureId: null, why: 'A show piece' }, STRUCTURES)).toBeNull()
  })

  it('the parts as drawn, in both languages, no key left', () => {
    const ruleNo = (id: string) => ruleNoOf(open, id)
    for (const locale of ['en', 'it'] as const) {
      const one = textOf(render(createElement(OrderStructurePartView, { model: { state: 'ready', problem: null, part: orderPartOf(ORDER_ONE), ruleNo, pageHref: '/w/demo/production/order-structures' } }), locale))
      expect(one, locale).not.toMatch(/\b(order|from|rules|rule|common|error)\.[A-Za-z]/)
      const customer = textOf(render(createElement(CustomerStructurePartView, { model: { state: 'ready', problem: null, rules: [open[0]!, open[1]!], ruleNo, write: true, pageHref: '/w/demo/production/order-structures' } }), locale))
      expect(customer, locale).not.toMatch(/\b(customer|rules|rule|category|common|error)\.[A-Za-z]/)
    }
    const en = textOf(render(createElement(OrderStructurePartView, { model: { state: 'ready', problem: null, part: orderPartOf(ORDER_ONE), ruleNo, pageHref: '/w/demo/production/order-structures' } })))
    expect(en).toContain('Brand Alpha · race team. By rule 2')
    expect(en).toContain('Another structure for this order…')
    const printed = textOf(render(createElement(OrderStructurePartView, { model: { state: 'ready', problem: null, part: orderPartOf(ORDER_MANY_PRINTED), ruleNo, pageHref: '/w/demo/production/order-structures' } })))
    expect(printed).not.toContain('Another structure for this order…')
    expect(printed).toContain('Line 2 · Gloves')
  })
})

describe('8.3 what a reader sees', () => {
  const html = (id: string, locale: 'en' | 'it' = 'en') => render(createElement(OrderStructuresView, { model: designScreen.cases.find((item) => item.id === id)!.model }), locale)

  it('the owner: the rules as sentences, "Never used" with Move it up, the fixed last line, Try, the structures', () => {
    const text = textOf(html('owner'))
    expect(text).toContain('When an order line is from')
    expect(text).toContain('Never used')
    expect(text).toContain('Move it above rule 2')
    expect(text).toContain('Everything else')
    expect(text).toContain('The normal way')
    expect(text).toContain('Rule 1 wins')
    expect(text).toContain('1 rule never used')
    expect(text).toContain('Closed, and kept')
  })

  it('sales writes rules but not structures; the production manager the other way round', () => {
    expect(textOf(html('sales'))).toContain('New rule…')
    expect(textOf(html('sales'))).not.toContain('New structure…')
    expect(textOf(html('manager'))).toContain('New structure…')
    expect(textOf(html('manager'))).not.toContain('New rule…')
  })

  it('every case in Italian, no key left', () => {
    for (const item of designScreen.cases) expect(textOf(html(item.id, 'it')), item.id).not.toMatch(/\b(head|rules|rule|try|how|structures|structure|category|common|error|notice)\.[A-Za-z]/)
  })
})

describe('walls and seams', () => {
  it('the base\'s slots keep their export names, props and owner lines; no session → nothing; 403/404 → no part', () => {
    for (const [file, name] of [
      ['./parts/OrderStructurePart.tsx', 'OrderStructurePart'],
      ['./parts/CustomerStructurePart.tsx', 'CustomerStructurePart'],
    ] as const) {
      const text = source(file)
      expect(text, file).toContain('SLOT — owner: S3 (owb-ss8)')
      expect(text, file).toContain(`export function ${name}(`)
      expect(text, file).toContain(`export interface ${name}Props {`)
      expect(text, file).toContain('if (!office) return null')
      expect(text, file).toContain("hidden: problem === 'error.forbidden' || problem === 'error.notFound'")
    }
    expect(source('./parts/CustomerStructurePart.tsx')).toContain('readonly partyId: string')
  })

  it('the page replaces the base\'s stub; the fixed last line is the web\'s, never sent', () => {
    expect(source('../../../app/(office)/w/[company]/production/order-structures/page.tsx')).toContain('<OrderStructuresPage />')
    expect(source('./api.ts')).not.toMatch(/everythingElse|normalWay/)
  })

  it('the words: order-structures has the same keys in en and it', () => {
    const en = Object.keys(CATALOGUE.en['order-structures'] ?? {}).sort()
    expect(en.length).toBeGreaterThan(120)
    expect(Object.keys(CATALOGUE.it['order-structures'] ?? {}).sort()).toEqual(en)
  })
})
