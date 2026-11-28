import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE, createTranslator } from '../i18n/messages'
import { render, textOf } from '../record-thread/parts/testing'
import { roomOf } from '../window-shell/model'
import { draftRecord, describedLine, kindsRecord } from '../../portal/customer/neworder/design-data'
import { COLUMNS, ROWS, designScreen } from './fixtures'
import { lineRowsOfDraft, modelChoiceOf, modelFields, modelGroupsOf, modelValueOf, nextLineFields, piecesTyped, priceHintOf, type LineRow } from './model'
import { cellEscape, cellFocus, cellLeave, cellOnModel, cellStart, cellType, heldHold, heldModel, heldRelease, heldStart } from './redraw'
import { OwnColumnsBody, type OwnColumnsWindowModel } from './own-columns/OwnColumnsWindow'
import { ownChipsOf } from './own-columns/OwnChips'
import { choicesOf, cleanOwnValue, newColumnProblem, OWN_COLUMNS_MAX, switchOff, toggledColumns } from './own-columns/rules'
import { OrderLinesTable, type OrderLinesModel } from './view/OrderLinesTable'
import { ORDER_LINES_NS } from './words'

/**
 * owb-po3.2 + po3.3 — THE ONE LINES TABLE and "Columns of your own": a new line copies the model and the material of the line above;
 * copy, take out, put back; phone cards; the trap "type then click" (every editable cell TYPES first, then clicks or tabs, and the
 * click does its work); no price key without money; the own-column rules and refusals; chips 2 + "+ n"; every word in en AND it.
 */

const t = (locale: 'en' | 'it') => createTranslator(locale, CATALOGUE[locale][ORDER_LINES_NS] ?? {})
const MONEY = /price|amount|net|currency|cost|margin/i
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out)
  else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) {
      out.push(key)
      keysOf(inner, out)
    }
  return out
}
const model = (over: Partial<OrderLinesModel> = {}): OrderLinesModel => ({ ...designScreen.cases[0]!.model, ...over })
const ACTS = { onCopy: () => undefined, onTakeOut: () => undefined, onPutBack: () => undefined }
const table = (over: Partial<OrderLinesModel> = {}, locale: 'en' | 'it' = 'en', actions: object = ACTS) => render(createElement(OrderLinesTable, { model: model(over), actions }), locale)

describe('a new line, copy, take out, put back', () => {
  it('a new line takes the model and the material of the line above; the first line takes nothing (Choose the model…)', () => {
    const above = ROWS[0]!
    expect(nextLineFields(above)).toEqual({ styleId: 's-1', colourwayId: 'cw-black' })
    expect(nextLineFields(ROWS[1]!)).toEqual({ garmentType: 'JACKET' })
    expect(nextLineFields(undefined)).toBeNull()
    const choiceAbove: LineRow = { ...ROWS[2]!, model: { ...ROWS[2]!.model, kind: 'NEW', value: 'new:GLOVES', garmentType: 'GLOVES' }, material: { how: 'CHOICE', words: 'Kangaroo', value: 'Kangaroo', options: [{ value: 'Cowhide', words: 'Cowhide' }, { value: 'Kangaroo', words: 'Kangaroo' }], topic: 'Leather' } }
    expect(nextLineFields(choiceAbove)).toEqual({ garmentType: 'GLOVES', choices: [{ topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: 'Kangaroo' }] })
    expect(nextLineFields({ ...ROWS[2]!, model: { ...ROWS[2]!.model, value: '' } })).toBeNull()
    expect(textOf(table({ rows: [], pending: true, columns: [] }))).toContain('Choose the model…')
  })

  it('the model choices: Your designs · The factory’s range · A new design · As in my message; a pick writes only its own fields', () => {
    const groups = modelGroupsOf(model().styles, model().kinds)
    expect(groups.map((group) => group.kind)).toEqual(['OWN', 'RANGE', 'NEW', 'TEXT'])
    expect(modelChoiceOf(modelValueOf({ kind: 'STYLE', styleId: 'x' }))).toEqual({ kind: 'STYLE', styleId: 'x' })
    expect(modelChoiceOf('')).toBeNull()
    expect(modelFields({ kind: 'NEW', garmentType: 'JACKET' })).toEqual({ garmentType: 'JACKET', styleId: null, colourwayId: null })
    expect(modelFields({ kind: 'TEXT' })).toEqual({ styleId: null, colourwayId: null, garmentType: null })
  })

  it('every line has Copy and Take out in a draft; a line taken out says so with Put it back; a sent order has neither', () => {
    const html = table({ removed: [{ id: 'l-9', seq: 4, words: 'Track gloves', removedAt: '2026-11-28T09:00:00Z' }] })
    for (const seq of [1, 2, 3]) {
      expect(html).toContain(`aria-label="Copy line ${seq}"`)
      expect(html).toContain(`aria-label="Take line ${seq} out"`)
    }
    expect(textOf(html)).toContain('Line 4 is taken out: Track gloves. Put it back')
    // a host that gives no copy / put-back command (the office twin before it wires them) shows neither door
    const bare = table({ removed: [{ id: 'l-9', seq: 4, words: 'Track gloves', removedAt: '2026-11-28T09:00:00Z' }] }, 'en', { onTakeOut: () => undefined })
    expect(bare).not.toContain('Copy line 1')
    expect(textOf(bare)).not.toContain('Put it back')
    const sent = table({ mode: 'sent', removed: [{ id: 'l-9', seq: 4, words: 'Track gloves', removedAt: '2026-11-28T09:00:00Z' }] })
    expect(sent).not.toContain('Copy line 1')
    expect(textOf(sent)).not.toContain('Put it back')
    expect(textOf(sent)).toContain('Sent to the factory: take it back to change the lines.')
    expect(textOf(table({ mode: 'shipped' }))).toContain('It left the factory. A change now is a return.')
  })

  it('a draft’s rows by seq, catalogue and its own lines together; the model of a line in words with nothing chosen reads empty', () => {
    const record = kindsRecord({ custom: [describedLine({ seq: 2, description: null, quantity: 4, pieces: 4 })] })
    const rows = lineRowsOfDraft(record.request)
    expect(rows.map((row) => row.seq)).toEqual([...rows.map((row) => row.seq)].sort((a, b) => a - b))
    const own = rows.find((row) => row.seq === 2)!
    expect(own.model.value).toBe('')
    expect(own.pieces).toEqual({ count: 4, typed: true })
  })
})

describe('the room and the money wall', () => {
  it('a phone (375 px) gets one card per line, no grid; a wide room the grid', () => {
    expect(roomOf(375)).toBe('narrow')
    const phone = table({ room: 'narrow' })
    expect(phone).toContain('fw-ol-cards')
    expect(phone).not.toContain('role="grid"')
    expect(phone.match(/class="fw-ol-card[ "]/g)?.length).toBe(3)
    expect(table()).toContain('role="grid"')
  })

  it('no money: no Your price column, no hint, and no price key in any row or the model', () => {
    const html = textOf(table({ prices: null }))
    expect(html).not.toContain('Your price')
    expect(html).not.toContain('agreed')
    expect(html).not.toContain('the factory answers')
    expect(keysOf(ROWS).filter((key) => MONEY.test(key))).toEqual([])
    expect(keysOf(lineRowsOfDraft(draftRecord().request)).filter((key) => MONEY.test(key))).toEqual([])
    expect(keysOf(model({ prices: null })).filter((key) => MONEY.test(key))).toEqual(['prices'])
  })

  it('with money: "agreed € 45" from today’s list price · "choose the material" · "the factory answers"', () => {
    const html = textOf(table())
    expect(html).toContain('Your price')
    expect(html).toContain('agreed €45.00')
    expect(html).toContain('the factory answers')
    expect(priceHintOf({ ...ROWS[0]!, material: { ...ROWS[0]!.material, value: '' } }, { list: null })).toEqual({ kind: 'MATERIAL' })
    expect(priceHintOf(ROWS[1]!, undefined)).toEqual({ kind: 'FACTORY' })
  })
})

describe('the trap "type then click": what you type is never lost', () => {
  it('type, then click Send: the model that comes back while the pointer is down WAITS; the click lands, then it is drawn', () => {
    let shown = heldStart({ pieces: '3' })
    let sent = 0
    let saved: string | null = null
    // 1. type in the Pieces cell
    let cell = cellType(cellFocus(cellStart('3')), '12')
    // 2. the pointer goes down on Send → the field is left (its save goes out) → the answer comes back DURING the press
    shown = heldHold(shown)
    const left = cellLeave(cell)
    cell = left.state
    saved = left.save
    shown = heldModel(shown, { pieces: '12' })
    expect(shown.shown).toEqual({ pieces: '3' }) // nothing moved under the pointer
    // 3. the click runs on what was pressed, then the pointer is up and the new model is drawn
    sent += 1
    shown = heldRelease(shown)
    expect(sent).toBe(1)
    expect(saved).toBe('12')
    expect(shown.shown).toEqual({ pieces: '12' })
    expect(cell.text).toBe('12')
  })

  it('type, then Tab: the next field keeps the keys typed in it while the first one’s answer comes back', () => {
    let first = cellType(cellFocus(cellStart('3')), '12')
    const left = cellLeave(first)
    first = left.state
    let next = cellType(cellFocus(cellStart('')), 'Rider 19')
    // the first field's save answers while the person types in the next one: the next field is NOT overwritten
    next = cellOnModel(next, '')
    first = cellOnModel(first, '12')
    expect(left.save).toBe('12')
    expect(next.text).toBe('Rider 19')
    expect(first.text).toBe('12')
    // Esc puts back what was there when the person came in; leaving with nothing changed saves nothing
    expect(cellLeave(cellEscape(next)).save).toBeNull()
  })

  it('a refused value says what to type and the value from before comes back (pieces, own number)', () => {
    expect(piecesTyped('2.5')).toEqual({ problem: 'pieces.refused' })
    expect(piecesTyped('')).toEqual({ count: null })
    expect(piecesTyped('12')).toEqual({ count: 12 })
    expect(cleanOwnValue({ kind: 'NUMBER', choices: [] }, 'ten')).toEqual({ problem: 'own.refused.number' })
    expect(cleanOwnValue({ kind: 'NUMBER', choices: [] }, '1,5')).toEqual({ value: 1.5 })
  })
})

describe('columns of your own', () => {
  const open = (name: string, over: Partial<(typeof COLUMNS)[number]> = {}) => ({ id: name, name, kind: 'TEXT' as const, choices: [], closed: false, version: 1, ...over })

  it('the rules, in words: a name · ≤ 40 · a fixed column’s name (EN + IT) · the same name twice (case-free) · a choice needs two', () => {
    expect(newColumnProblem({ name: ' ', kind: 'TEXT', choices: '' }, COLUMNS)).toBe('own.refused.name')
    expect(newColumnProblem({ name: 'x'.repeat(41), kind: 'TEXT', choices: '' }, COLUMNS)).toBe('own.refused.long')
    expect(newColumnProblem({ name: 'Material', kind: 'TEXT', choices: '' }, COLUMNS)).toBe('own.refused.fixed')
    expect(newColumnProblem({ name: 'Taglie', kind: 'TEXT', choices: '' }, COLUMNS)).toBe('own.refused.fixed')
    expect(newColumnProblem({ name: 'sizing', kind: 'TEXT', choices: '' }, COLUMNS)).toBe('own.refused.twice')
    expect(newColumnProblem({ name: 'sizing', kind: 'TEXT', choices: '' }, [open('Sizing', { closed: true })])).toBeNull()
    expect(newColumnProblem({ name: 'Team', kind: 'CHOICE', choices: 'Home, home' }, COLUMNS)).toBe('own.refused.choices')
    expect(choicesOf('Home, Away, home, , Third')).toEqual(['Home', 'Away', 'Third'])
  })

  it('at most 8 on one order; a column with a value asks before it goes off; the others go at once', () => {
    const eight = Array.from({ length: OWN_COLUMNS_MAX }, (_, index) => `c${index}`)
    expect(toggledColumns(eight, 'c9')).toBeNull()
    expect(toggledColumns(eight, 'c3')).toHaveLength(7)
    expect(switchOff('c-comment', { 'l-1': { 'c-comment': { value: 'Lower collar' } } })).toBe('ask')
    expect(switchOff('c-comment', { 'l-1': { 'c-comment': { value: null } } })).toBe('go')
  })

  it('chips: two, then "+ n" with the rest in the tip; a Yes reads the column’s name; a text its name; the same fact once', () => {
    const tr = t('en')
    const { chips, more } = ownChipsOf(COLUMNS, [ROWS[0]!.own, ROWS[0]!.own], tr, 'en')
    expect(chips.map((chip) => chip.words)).toEqual(['Made to measure', 'Remake'])
    expect(more).toEqual({ count: 1, tip: 'Comment: Rider 19 wants the collar 1 cm lower.' })
    expect(ownChipsOf(COLUMNS, [{ 'c-remake': false }], tr, 'en').chips).toEqual([])
  })

  it('the window: your columns on or off, the quick ones, a new one with its kinds; the office reads the customer’s words', () => {
    const win: OwnColumnsWindowModel = { open: true, door: 'portal', columns: COLUMNS, used: ['c-sizing'], values: {}, busy: false, refused: null, writeHeld: null }
    const html = textOf(render(createElement(OwnColumnsBody, { model: win, actions: { onClose: () => undefined } })))
    expect(html).toContain('Your columns — switch one on for this order')
    expect(html).toContain('Name on the piece')
    expect(html).not.toMatch(/Often used.*\bSizing\b.*A new column/) // a quick one the customer already has is not offered again
    for (const kind of ['Text', 'Yes / No', 'Choice', 'Number', 'Date']) expect(html).toContain(kind)
    const office = textOf(render(createElement(OwnColumnsBody, { model: { ...win, door: 'office' }, actions: { onClose: () => undefined } }), 'it'))
    expect(office).toContain('Le colonne del cliente — attivane una per questo ordine')
  })

  it('every word in en AND it, with the same placeholders; the design cases draw in both languages with no key left', () => {
    const flat = (value: unknown, prefix = ''): Record<string, string> =>
      Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => (typeof inner === 'string' ? [[`${prefix}${key}`, inner]] : Object.entries(flat(inner, `${prefix}${key}.`)))))
    const en = flat(CATALOGUE.en[ORDER_LINES_NS])
    const it = flat(CATALOGUE.it[ORDER_LINES_NS])
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) expect((it[key]!.match(/\{\w+\}/g) ?? []).sort()).toEqual((en[key]!.match(/\{\w+\}/g) ?? []).sort())
    for (const locale of ['en', 'it'] as const)
      for (const item of designScreen.cases) expect(textOf(render(createElement(OrderLinesTable, { model: item.model }), locale))).not.toMatch(/\b(col|own|model|mode|price|sizes|material|pieces|removed|columns)\.[a-zA-Z]/)
  })
})
