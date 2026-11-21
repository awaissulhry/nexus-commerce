import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FREEZE_CUT, FREEZE_FINISHED, FREEZE_NONE } from '../../depth/demo/fixtures'
import { FREEZE_PARTS, FREEZE_WORD, freezePartsOf, freezeVerdictOf, isFinalVerdict, linesDoorOf } from './freeze'

// F-OC-202 (order CHANGES tab, W2; 10-design §4; 13-backend R13a, B-OC-017; L3): Can it still change? — ONE sentence, the order's
// state first; each part in three words; the door to the Lines tab.

const ready = (value: typeof FREEZE_CUT) => ({ value, problem: null })
const waiting = { waitingForYes: { taskId: 't-yes', since: '2026-11-18T15:05:00Z' }, changes: [{ revision: 2, yes: { taskId: 't-yes' } }] } as never
const none = { waitingForYes: null, changes: [] } as never

describe('F-OC-202: the verdict — the first rule that applies', () => {
  it('the order\'s own state first: cancelled, closed, goods left (partly shipped too), waiting for its first yes — whatever the rules say', () => {
    expect(freezeVerdictOf({ status: 'CANCELLED', changes: none, freeze: ready(FREEZE_NONE) })).toEqual({ kind: 'cancelled' })
    expect(freezeVerdictOf({ status: 'CLOSED', changes: none, freeze: ready(FREEZE_NONE) })).toEqual({ kind: 'closed' })
    // The old panel said "everything is open" on a partly shipped order (C6-B1): goods have left.
    for (const status of ['PARTLY_SHIPPED', 'SHIPPED', 'DELIVERED'] as const) expect(freezeVerdictOf({ status, changes: none, freeze: ready(FREEZE_NONE) }).kind, status).toBe('goodsLeft')
    expect(freezeVerdictOf({ status: 'PENDING_APPROVAL', changes: waiting, freeze: ready(FREEZE_CUT) })).toEqual({ kind: 'firstYes' })
  })

  it('our approval of an old change blocks every other change: "Blocked: revision 2 waits for approval since …" (C6-B2)', () => {
    expect(freezeVerdictOf({ status: 'IN_PRODUCTION', changes: waiting, freeze: ready(FREEZE_CUT) })).toEqual({ kind: 'blocked', revision: 2, since: '2026-11-18T15:05:00Z' })
    expect(freezeVerdictOf({ status: 'IN_PRODUCTION', changes: { waitingForYes: { taskId: 't-other', since: '2026-11-18T15:05:00Z' }, changes: [] } as never, freeze: ready(FREEZE_CUT) })).toMatchObject({ kind: 'blocked', revision: null })
  })

  it('then the rules: some parts locked (needs a yes / can\'t change); nothing on the floor; all open; reading and failed never claim either', () => {
    expect(freezeVerdictOf({ status: 'IN_PRODUCTION', changes: none, freeze: ready(FREEZE_CUT) })).toEqual({ kind: 'locked', needsYes: ['SIZE_QUANTITY', 'COLOURWAY', 'PRICE'], cantChange: [] })
    expect(freezeVerdictOf({ status: 'CONFIRMED', changes: none, freeze: ready(FREEZE_NONE) })).toEqual({ kind: 'nothingOnFloor' })
    const allOpen = { ...FREEZE_CUT, lines: FREEZE_CUT.lines.map((line) => ({ ...line, fields: line.fields.map((field) => ({ ...field, state: 'OPEN' as const })), sizes: line.sizes.map((size) => ({ ...size, state: 'OPEN' as const })) })) }
    expect(freezeVerdictOf({ status: 'IN_PRODUCTION', changes: none, freeze: ready(allOpen) })).toEqual({ kind: 'allOpen' })
    expect(freezeVerdictOf({ status: 'IN_PRODUCTION', changes: none, freeze: { value: null, problem: null } })).toEqual({ kind: 'reading' })
    expect(freezeVerdictOf({ status: 'IN_PRODUCTION', changes: none, freeze: { value: null, problem: 'problem.read.unavailable' } })).toEqual({ kind: 'failed' })
    // A failed changes read: the rules' verdict (the view says it could not read whether an approval waits).
    expect(freezeVerdictOf({ status: 'IN_PRODUCTION', changes: null, freeze: ready(FREEZE_CUT) }).kind).toBe('locked')
  })
})

describe('F-OC-202: each part in three words', () => {
  it('L3: no Options row; sizes count how many of them are held, a line field how many lines', () => {
    expect(FREEZE_PARTS).toEqual(['SIZE_QUANTITY', 'COLOURWAY', 'DELIVERY_DATE', 'SHIP_TO', 'PRICE'])
    const parts = Object.fromEntries(freezePartsOf(FREEZE_CUT).map((part) => [part.field, part]))
    expect(parts.SIZE_QUANTITY).toMatchObject({ word: 'needsYes', of: { count: 2, total: 7, unit: 'sizes' } })
    expect(parts.COLOURWAY).toMatchObject({ word: 'needsYes', of: { count: 1, total: 2, unit: 'lines' } })
    expect(parts.DELIVERY_DATE).toMatchObject({ word: 'canChange', of: null, words: null })
    expect(parts.OPTION).toBeUndefined()
    expect(freezePartsOf(FREEZE_FINISHED).find((part) => part.field === 'SIZE_QUANTITY')?.word).toBe('cantChange')
    expect(FREEZE_WORD).toEqual({ OPEN: 'canChange', CHANGE_REQUEST: 'needsYes', BLOCKED: 'cantChange' })
  })

  it('B-OC-017 (S2, optional): what freezes next and whose rule — said only once the read sends them; the rule\'s own words', () => {
    const later = {
      ...FREEZE_CUT,
      order: { ...FREEZE_CUT.order, fields: [{ field: 'DELIVERY_DATE' as const, state: 'OPEN' as const, frozenFrom: null, next: { stage: 'SHIPPED' as const, action: 'BLOCKED' as const }, customerRule: true }, ...FREEZE_CUT.order.fields.slice(1)] },
      lines: FREEZE_CUT.lines.map((line) => ({ ...line, fields: line.fields.map((field) => (field.field === 'COLOURWAY' && field.state !== 'OPEN' ? { ...field, words: { en: 'The leather is cut in this colour.', it: 'La pelle è tagliata in questo colore.' } } : field)) })),
    }
    const parts = Object.fromEntries(freezePartsOf(later).map((part) => [part.field, part]))
    expect(parts.DELIVERY_DATE).toMatchObject({ word: 'canChange', next: { stage: 'SHIPPED', word: 'cantChange' }, customerRule: true })
    expect(parts.COLOURWAY!.words?.en).toBe('The leather is cut in this colour.')
    // Not sent yet (before S2): no next, never the customer's rule.
    expect(freezePartsOf(FREEZE_CUT).every((part) => part.next === null && part.customerRule === false)).toBe(true)
  })
})

describe('F-OC-202: "Change the lines ›" — orders.manage on an order that can still change; held in words while our approval waits', () => {
  it('shown, held, hidden', () => {
    expect(linesDoorOf({ kind: 'allOpen' }, { manage: true })).toEqual({ held: null })
    expect(linesDoorOf({ kind: 'firstYes' }, { manage: true })).toEqual({ held: null })
    expect(linesDoorOf({ kind: 'blocked', revision: 2, since: 'x' }, { manage: true })).toEqual({ held: { revision: 2 } })
    expect(linesDoorOf({ kind: 'allOpen' }, { manage: false })).toBeNull()
    for (const kind of ['cancelled', 'closed', 'goodsLeft'] as const) {
      expect(isFinalVerdict({ kind }), kind).toBe(true)
      expect(linesDoorOf({ kind }, { manage: true }), kind).toBeNull()
    }
  })

  it('the three words are the Lines cells\' titles too (one word per meaning), in both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const words = JSON.parse(readFileSync(new URL(`../../../../../../messages/${locale}/orders.json`, import.meta.url), 'utf8')) as { lines: { cell: Record<string, string> }; changesTab: { freeze: { word: Record<string, string> } } }
      expect(words.lines.cell.locked.startsWith(words.changesTab.freeze.word.needsYes), locale).toBe(true)
      expect(words.lines.cell.lockedForGood.startsWith(words.changesTab.freeze.word.cantChange), locale).toBe(true)
    }
  })

  it('the view: the kit\'s section, the parts table, the old freeze panel gone (one path per job)', () => {
    const view = readFileSync(new URL('./view/FreezeSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<Section id="freeze"')
    expect(view).toContain("{part.field === 'SHIP_TO' && <span className=\"fw-pt-sub\">{t('changesTab.freeze.shipToChecked')}</span>}")
    expect(view).not.toContain('ChangesDepth')
  })
})
