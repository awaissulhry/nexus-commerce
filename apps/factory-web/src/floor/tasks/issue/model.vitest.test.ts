import { describe, expect, it } from 'vitest'
import { REFUSALS } from '@nexus/factory-domain/inventory/issue/rules'
import { UNUSABLE_REASONS } from '@nexus/factory-domain/planning/usable'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { readScan } from '../../scan/scan-model'
import { designScreen } from './fixtures'
import { comesBackAs, remnantLabel, returnBody, returnBounds, returnOfScan, returnRows, tagPrinterOf } from './returns'
import { coveredCount, decimalsOf, HELD_REASONS, hideChoices, hideProgress, ISSUE_REFUSAL_WORDS, otherShadeHides, padBounds, quantityText, SCREEN_REFUSALS, shadeOfLine, stockOfScan, undoStock, UNIT_KEYS, withLine, type PickLine, type PickList } from './model'

/**
 * Pick & issue's rules (SCR-093): what a scan is on the pick list (a hide is issued at once, a lot or material asks its
 * quantity, anything else goes to the API as scanned), the pad's bounds (never more than on hand or still needed: an
 * over-issue is the office's), the undo strip's stock, and the words for every refusal code the screen names.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const HIDE = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 4211 })
const OTHER_HIDE = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 9999 })

const line = (extra: Partial<PickLine>): PickLine => ({
  key: 'k',
  itemId: 'i',
  itemColourId: null,
  itemCode: 'ITEM',
  itemName: 'Item',
  colourCode: null,
  colourName: null,
  tracking: 'LOT',
  baseUom: 'M',
  planned: '10.0000',
  issued: '0.0000',
  toIssue: '10.0000',
  covered: false,
  usable: { onHand: '0.0000', candidates: [], more: 0 },
  held: [],
  atWorkOrder: [],
  ...extra,
})

const leather = line({
  key: 'leather',
  itemId: 'leather',
  tracking: 'HIDE',
  baseUom: 'FT2',
  usable: { onHand: '52.4000', candidates: [{ lotId: 'l7', lotCode: 'LOT-7', hideId: 'h1', hideCode: HIDE, hideState: 'FULL', grade: 'A', locationCode: 'A1', onHand: '52.4000' }], more: 0 },
  atWorkOrder: [{ lotId: 'l7', lotCode: 'LOT-7', hideId: 'h1', hideCode: HIDE, quantity: '52.4000', cut: '0.0000', returnable: '52.4000' }],
})
const lining = line({ key: 'lining', itemId: 'lining', usable: { onHand: '30.0000', candidates: [{ lotId: 'l31', lotCode: 'LOT-31', hideId: null, hideCode: null, hideState: null, grade: null, locationCode: 'A2', onHand: '30.0000' }], more: 0 } })
const thread = line({ key: 'thread', itemId: 'thread', itemCode: 'FIL-40', tracking: 'NONE', baseUom: 'CONE', planned: '12.0000', issued: '12.0000', toIssue: '0.0000', covered: true, usable: { onHand: '30.0000', candidates: [], more: 0 } })

const list: PickList = {
  workOrder: { id: 'wo', number: 'WO-1', batchNumber: null, status: 'IN_PROGRESS', dueDate: null, issuable: true, style: { code: 'S', name: 'Style' } },
  lines: [leather, lining, thread],
  undo: null,
}

describe('what a scan is on the pick list', () => {
  it('a hide label is issued at once, even one the list does not show (the API decides)', () => {
    expect(stockOfScan(list, readScan(HIDE, TAG))).toMatchObject({ kind: 'hide', code: HIDE, line: { key: 'leather' } })
    expect(stockOfScan(list, readScan(OTHER_HIDE, TAG))).toMatchObject({ kind: 'hide', line: null })
  })

  it('a lot of the list and a material by its code ask their quantity; anything else goes to the API', () => {
    expect(stockOfScan(list, readScan('lot-31', TAG))).toMatchObject({ kind: 'quantity', code: 'LOT-31', onHand: 30, line: { key: 'lining' } })
    expect(stockOfScan(list, readScan('FIL-40', TAG))).toMatchObject({ kind: 'quantity', code: 'FIL-40', line: { key: 'thread' } })
    expect(stockOfScan(list, readScan('LOT-HELD', TAG))).toEqual({ kind: 'ask', code: 'LOT-HELD' })
  })
})

describe('the quantity pad', () => {
  it('defaults to what is still needed, up to what is on hand, and never past either', () => {
    expect(padBounds(lining, 30)).toEqual({ min: 0.01, max: 10, decimals: 2, suggested: 10, covered: false })
    expect(padBounds(line({ toIssue: '96.0000' }), 8)).toMatchObject({ max: 8, suggested: 8 })
  })

  it('a covered line issues nothing more on the floor (an over-issue is the office\'s)', () => {
    expect(padBounds(thread, 30)).toMatchObject({ max: 0, covered: true, decimals: 0 })
  })

  it('sends the API\'s decimal string, whole for counted units', () => {
    expect(decimalsOf('PCS')).toBe(0)
    expect(decimalsOf('FT2')).toBe(2)
    expect(quantityText(12.5, 2)).toBe('12.50')
    expect(quantityText(3, 0)).toBe('3')
  })
})

describe('the pick list\'s words', () => {
  it('counts the covered lines and updates a line from an issue\'s answer', () => {
    expect(coveredCount(list)).toEqual({ covered: 1, total: 3 })
    const after = withLine(list, 'lining', { planned: '10.0000', issued: '10.0000', toIssue: '0.0000' })
    expect(coveredCount(after)).toEqual({ covered: 2, total: 3 })
  })

  it('names the undo strip\'s stock by its hide (or lot) code', () => {
    expect(undoStock(list)).toBeNull()
    expect(undoStock({ ...list, undo: { issueId: 'x', itemId: 'leather', itemColourId: null, lotId: 'l7', hideId: 'h1', baseQuantity: '52.4000', occurredAt: '2026-10-29T08:00:00Z' } })).toMatchObject({ code: HIDE, quantity: 52.4, line: { key: 'leather' } })
  })

  it('has words in it and en for every refusal it names, every held reason and every unit', () => {
    for (const code of ISSUE_REFUSAL_WORDS) expect(REFUSALS as readonly string[]).toContain(code)
    expect([...HELD_REASONS].sort()).toEqual([...UNUSABLE_REASONS].sort())
    expect([...UNIT_KEYS].sort()).toEqual([...UOMS].sort())
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['floor-issue'] ?? {}
      for (const code of [...ISSUE_REFUSAL_WORDS, ...SCREEN_REFUSALS, 'NOT_STOCK']) {
        const key = code === 'NOT_STOCK' ? 'notStock' : `refusal.${code}`
        expect(words[`${key}.message`], `${locale} ${code}`).toBeTruthy()
        expect(words[`${key}.fix`], `${locale} ${code}`).toBeTruthy()
      }
      for (const reason of HELD_REASONS) expect(words[`held.reason.${reason}`], `${locale} ${reason}`).toBeTruthy()
      for (const unit of UNIT_KEYS) expect(words[`unit.${unit}`], `${locale} ${unit}`).toBeTruthy()
    }
  })

  it('has the design cases the step asks for', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['choose', 'choose-empty', 'pick-list', 'issued-hide', 'pad-lot', 'pad-on-hand', 'refused-already-issued', 'refused-cr-vi', 'refused-quality-hold', 'not-open', 'offline-list', 'offline-nothing', 'error', 'no-permission', 'undone']) expect(ids).toContain(id)
  })
})

describe('Return unused (B-W2a-75; design floor.pick sec "return"; SCM-216)', () => {
  const line = (key: string, extra: Partial<PickLine>): PickLine => ({
    key,
    itemId: `item-${key}`,
    itemColourId: null,
    itemCode: key.toUpperCase(),
    itemName: key,
    colourCode: null,
    colourName: null,
    tracking: 'LOT',
    baseUom: 'M',
    planned: '10.0000',
    issued: '10.0000',
    toIssue: '0.0000',
    covered: true,
    usable: { onHand: '0.0000', candidates: [], more: 0 },
    held: [],
    atWorkOrder: [],
    ...extra,
  })
  const withHeld: Pick<PickList, 'lines'> = {
    lines: [
      line('leather', {
        tracking: 'HIDE',
        baseUom: 'FT2',
        atWorkOrder: [
          { lotId: 'l7', lotCode: 'LOT-7', hideId: 'h0', hideCode: HIDE, quantity: '51.1000', cut: '32.5000', returnable: '18.6000' },
          { lotId: 'l7', lotCode: 'LOT-7', hideId: 'h9', hideCode: 'OLD-9', quantity: '40.0000', cut: '40.0000', returnable: '0.0000' },
        ],
      }),
      line('lining', { atWorkOrder: [{ lotId: 'l31', lotCode: 'LOT-31', hideId: null, hideCode: null, quantity: '96.0000', cut: '0.0000', returnable: '12.0000' }] }),
      line('thread', { tracking: 'NONE', baseUom: 'CONE', atWorkOrder: [{ lotId: null, lotCode: null, hideId: null, hideCode: null, quantity: '3.0000', cut: '0.0000', returnable: '3.0000' }] }),
    ],
  }

  it('lists what the work order holds less what was cut: a cut hide, a lot, a material; a used-up hide not at all', () => {
    const rows = returnRows(withHeld)
    expect(rows.map((row) => [row.kind, row.code, row.returnable])).toEqual([
      ['hide', HIDE, 18.6],
      ['lot', 'LOT-31', 12],
      ['material', 'THREAD', 3],
    ])
    expect(rows[0]!.stock).toEqual({ hideId: 'h0' })
    expect(rows[1]!.stock).toEqual({ lotId: 'l31' })
    expect(rows[2]!.stock).toEqual({ itemId: 'item-thread', itemColourId: null })
  })

  it('a scan picks the row by its tag, lot or material code (any case); anything else is not held', () => {
    const rows = returnRows(withHeld)
    expect(returnOfScan(rows, { kind: 'free', code: 'lot-31' })?.kind).toBe('lot')
    expect(returnOfScan(rows, { kind: 'free', code: HIDE.toLowerCase() })?.kind).toBe('hide')
    expect(returnOfScan(rows, { kind: 'free', code: 'NOPE' })).toBeNull()
  })

  it('the pad: never more than may come back; a hide by its area (two decimals), a count unit whole', () => {
    const [hideRow, lotRow, threadRow] = returnRows(withHeld)
    expect(returnBounds(hideRow!)).toEqual({ min: 0.01, max: 18.6, decimals: 2, suggested: 18.6 })
    expect(returnBounds(threadRow!)).toEqual({ min: 1, max: 3, decimals: 0, suggested: 3 })
    expect(returnBounds(lotRow!).max).toBe(12)
  })

  it('a hide cut from comes back as a remnant; one never cut, whole, comes back whole', () => {
    expect(comesBackAs({ kind: 'hide', cut: 32.5, held: 51.1 }, 18.6)).toBe('remnant')
    expect(comesBackAs({ kind: 'hide', cut: 0, held: 52.4 }, 52.4)).toBe('whole')
    expect(comesBackAs({ kind: 'hide', cut: 0, held: 52.4 }, 30)).toBe('remnant')
    expect(comesBackAs({ kind: 'lot', cut: 0, held: 96 }, 12)).toBe('part')
  })

  it('the body names the stock by id, the measured quantity and where it goes', () => {
    const [hideRow] = returnRows(withHeld)
    expect(returnBody(hideRow!, 18.6, 2, 'loc-1', '2026-10-31T08:00:00.000Z')).toEqual({ hideId: 'h0', quantity: '18.60', toLocationId: 'loc-1', occurredAt: '2026-10-31T08:00:00.000Z' })
  })

  it('the remnant\'s tag prints on the station\'s printer, else the site\'s only one, else the one picked', () => {
    const printers = [
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
    ]
    expect(tagPrinterOf(printers, 'p2')).toEqual({ kind: 'station', id: 'p2', name: 'Two' })
    expect(tagPrinterOf(printers.slice(0, 1), null)).toEqual({ kind: 'site', id: 'p1', name: 'One' })
    expect(tagPrinterOf(printers, null)).toEqual({ kind: 'choose', printers })
    expect(tagPrinterOf([], null)).toEqual({ kind: 'none' })
    const [hideRow] = returnRows(withHeld)
    expect(remnantLabel(hideRow!, '18,6 ft²', 'it')).toEqual({ kind: 'HIDE', language: 'it', scanId: HIDE, title: 'LEATHER · leather', fields: { article: 'LEATHER', colour: null, area: '18,6 ft²', lot: 'LOT-7' } })
  })
})

// ---- B-W2b-100: choose hides at the pick (SCM-214), one shade lot per order (SCM-206), a remnant's own tag (SCM-254) ----

describe('choose hides: the running area against the need', () => {
  const RM = formatScanId({ type: 'REMNANT', tenantTag: TAG, ref: 118 })
  const candidate = (id: string, onHand: string, extra: Partial<PickLine['usable']['candidates'][number]> = {}) => ({ lotId: 'l7', lotCode: 'LOT-7', hideId: id, hideCode: `HD-${id}`, hideState: 'FULL', grade: 'A', locationCode: 'A1', onHand, shadeLabel: '2', outOfShade: false, remnant: null, sameShade: true, ...extra })
  const hides = line({
    key: 'hides',
    itemId: 'leather',
    tracking: 'HIDE',
    baseUom: 'FT2',
    planned: '110.0000',
    issued: '96.2000',
    toIssue: '13.8000',
    hides: { count: 4 },
    shadeLots: [{ key: 'l7|g:2', lotCode: 'LOT-7', shadeLabel: '2' }],
    usable: {
      onHand: '200.0000',
      candidates: [
        candidate('a', '10.0000', { remnant: { id: 'rm', code: RM }, hideState: 'REMNANT' }),
        candidate('b', '50.0000'),
        candidate('c', '45.0000'),
        candidate('x', '55.0000', { lotId: 'l8', lotCode: 'LOT-8', shadeLabel: '1', sameShade: false }),
        candidate('o', '40.0000', { outOfShade: true, sameShade: false }),
      ],
      more: 0,
    },
  })

  it('says a leather line\'s hides beside its area against the need ("4 hides · 96.2 of 110 ft²"); nothing for other lines', () => {
    expect(hideProgress(hides)).toEqual({ count: 4, issued: 96.2, planned: 110, covers: false })
    expect(hideProgress(lining)).toBeNull()
    // An older answer without `hides`: counted from what the work order holds.
    expect(hideProgress(leather)?.count).toBe(1)
  })

  it('suggests hides in the API\'s order until the need is reached, each with the running area, a remnant by its own tag', () => {
    const choices = hideChoices(hides)
    expect(choices.map((choice) => choice.code)).toEqual([RM, 'HD-b'])
    expect(choices[0]).toMatchObject({ remnantCode: RM, hideCode: 'HD-a', runningCount: 5, runningArea: 106.2, covers: false, sameShade: true })
    expect(choices[1]).toMatchObject({ runningCount: 6, runningArea: 156.2, covers: true })
  })

  it('leaves out, under one shade lot per order, the hides the scan would refuse; counts them; offers them with the rule off', () => {
    const short = { ...hides, issued: '0.0000', toIssue: '110.0000', hides: { count: 0 } }
    expect(hideChoices(short).map((choice) => choice.hideCode)).toEqual(['HD-a', 'HD-b', 'HD-c'])
    expect(otherShadeHides(short)).toBe(2)
    expect(hideChoices(short, false).map((choice) => choice.hideCode)).toEqual(['HD-a', 'HD-b', 'HD-c', 'HD-x'])
    // Nothing held yet: the first hide suggested sets the shade lot; another lot is not suggested beside it.
    const fresh = { ...short, shadeLots: [], usable: { ...short.usable, candidates: short.usable.candidates.map((row) => ({ ...row, sameShade: null })) }, planned: '400.0000' }
    expect(hideChoices(fresh).map((choice) => choice.hideCode)).toEqual(['HD-a', 'HD-b', 'HD-c'])
    expect(otherShadeHides(fresh)).toBe(2)
    expect(otherShadeHides(short, false)).toBe(0)
    expect(hideChoices({ ...short, planned: '400.0000' }, false).map((choice) => choice.hideCode)).toEqual(['HD-a', 'HD-b', 'HD-c', 'HD-x', 'HD-o'])
    expect(hideChoices({ ...hides, covered: true })).toEqual([])
  })

  it('names the shade lot the work order is cut from, and says when it is mixed', () => {
    expect(shadeOfLine(hides)).toEqual({ lots: [{ key: 'l7|g:2', lotCode: 'LOT-7', shadeLabel: '2' }], mixed: false })
    expect(shadeOfLine({ ...hides, shadeLots: [...hides.shadeLots!, { key: 'l8|g:1', lotCode: 'LOT-8', shadeLabel: '1' }] })?.mixed).toBe(true)
    expect(shadeOfLine(lining)).toBeNull()
  })

  it('issues a remnant by its own tag like its hide\'s (a scanned RM label, or the code typed)', () => {
    const withRemnant: PickList = { ...list, lines: [hides] }
    expect(stockOfScan(withRemnant, readScan(RM, TAG))).toEqual({ kind: 'hide', code: RM, line: hides })
    expect(stockOfScan(withRemnant, { kind: 'free', code: RM })).toMatchObject({ kind: 'hide', line: hides })
  })

  it('has words for the shade and remnant refusals in every language', () => {
    for (const code of ['SHADE_LOT', 'OUT_OF_SHADE', 'REMNANT_TOO_SMALL', 'REMNANT_GONE_ON'] as const) {
      expect(ISSUE_REFUSAL_WORDS).toContain(code)
      expect(REFUSALS).toContain(code)
    }
  })
})
