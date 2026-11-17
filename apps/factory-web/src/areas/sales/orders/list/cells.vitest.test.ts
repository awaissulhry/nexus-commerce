import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { cellValueOf, editFieldOf, fieldsForList, IN_CELL_TYPES, storedOfCell } from '../../../../list-frame/custom/model'
import type { ListField } from '../../../../list-frame/tools/transport'
import { valueProblemKey } from '../../../../list-frame/w2b/model'
import { LIST_ROWS, canOf } from '../_demo/fixtures'
import type { OrderRow } from '../api'
import { NAMESPACE } from './sheet/model'
import { heldCell, orderEditOf } from './view/OrdersListView'

/**
 * B-TH-245 (threads plan TH-4, picture 27; features SHEET.brand-fields-F03 edit a custom value in a cell, -F08 Edit N,
 * O-SAL-ORD-LIST.grid-F26; wall W17, W19): the sheet's cells that edit — the order note and the custom values (TEXT, NUMBER, DATE,
 * SELECT, YES_NO) through the API's `sales.orders` bulk target, a version clash said in words, Edit N with its preview; the order's
 * lines never; a field for one customer never on another customer's row, and on a list of every customer not even a column.
 */

const t = createTranslator('en', messagesFor('en', ['orders']).orders!)
const s = createTranslator('en', messagesFor('en', [NAMESPACE])[NAMESPACE]!)
const lists = createTranslator('en', messagesFor('en', ['lists']).lists!)
const ALPHA = LIST_ROWS[0]!.partyId
const other = LIST_ROWS.find((row) => row.partyId !== ALPHA)!
const field = (over: Partial<ListField> = {}): ListField => ({ code: 'hang_tag', columnId: 'cf:hang_tag', type: 'TEXT', labelIt: 'Cartellino', labelEn: 'Hang tag', unit: null, companyId: null, partyId: null, options: [], ...over })
const words = { notThisCustomer: lists('custom.notThisCustomer'), yes: lists('custom.yes'), no: lists('custom.no') }
const spec = (over: Partial<ListField>, held?: (row: OrderRow) => string | null) =>
  editFieldOf<OrderRow>(field(over), { valueOf: () => null, partyOf: (row) => row.partyId, ...(held ? { held } : {}), label: 'x', words }, 'en')

describe('the order\'s own cells: the note — the lines never', () => {
  const edit = orderEditOf({ can: canOf('sales') }, s, (row) => heldCell(row, t, s), () => undefined)
  it('only the office note edits (no units, lines, promise or money cell)', () => {
    expect(Object.keys(edit.fields)).toEqual(['note'])
    expect(edit.fields.note).toMatchObject({ kind: 'text', nullable: true, maxLength: 2000 })
    expect(edit.bulk?.noun).toEqual({ one: 'order', other: 'orders' })
    expect(edit.versionOf(LIST_ROWS[0]!)).toBe(LIST_ROWS[0]!.version)
  })
  it('a closed or cancelled order keeps every cell, said in words; an open one edits', () => {
    const closed = LIST_ROWS.find((row) => row.status === 'CLOSED')!
    expect(edit.fields.note!.held?.(closed)).toBe('A Closed order never changes.')
    expect(edit.fields.note!.held?.(LIST_ROWS[0]!)).toBeNull()
  })
  it('without orders.manage every cell reads only (Edit N held with the reason)', () => {
    expect(orderEditOf({ can: canOf('manager') }, s, () => null, () => undefined).held).toBe('Changing the cells needs the right to change orders.')
    expect(edit.held).toBeNull()
  })
})

describe('custom values in their cells (SHEET.brand-fields-F03, -F08)', () => {
  it('TEXT, NUMBER, DATE, SELECT and YES_NO edit in a cell; money, multi-select, person, link and file open the order', () => {
    expect([...IN_CELL_TYPES]).toEqual(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'YES_NO'])
    expect(spec({ type: 'TEXT' })?.kind).toBe('text')
    expect(spec({ type: 'NUMBER' })?.kind).toBe('number')
    expect(spec({ type: 'DATE' })?.kind).toBe('date')
    expect(spec({ type: 'YES_NO' })).toMatchObject({ kind: 'choice', choices: ['YES', 'NO'], choiceLabels: { YES: 'Yes', NO: 'No' } })
    for (const type of ['MONEY', 'MULTI_SELECT', 'PERSON', 'LINK', 'FILE']) expect(spec({ type }), type).toBeNull()
  })
  it('a select offers its active values; a deactivated one keeps its words on the rows that hold it', () => {
    const select = spec({ type: 'SELECT', options: [{ code: 'GIFT', labelIt: 'Regalo', labelEn: 'Gift box', active: true }, { code: 'OLD', labelIt: 'Vecchia', labelEn: 'Old box', active: false }] })!
    expect(select.choices).toEqual(['GIFT'])
    expect(select.choiceLabels).toEqual({ GIFT: 'Gift box', OLD: 'Old box' })
  })
  it('W17: a field for one customer is held on another customer\'s row (in words that name no one), editable on its own', () => {
    const alphaOnly = spec({ partyId: ALPHA })!
    expect(alphaOnly.held?.(other)).toBe(words.notThisCustomer)
    expect(alphaOnly.held?.(LIST_ROWS[0]!)).toBeNull()
    // The list's own reason (a closed order) comes first.
    const closed = LIST_ROWS.find((row) => row.status === 'CLOSED')!
    expect(spec({}, (row) => heldCell(row, t, s))!.held?.(closed)).toBe('A Closed order never changes.')
  })
  it('on a list of every customer a field for one customer is no column at all; on its customer\'s sheet it is', () => {
    const fields = [field(), field({ code: 'alpha_box', columnId: 'cf:alpha_box', partyId: ALPHA })]
    expect(fieldsForList(fields, null, true).map((entry) => entry.code)).toEqual(['hang_tag'])
    expect(fieldsForList(fields, ALPHA, true).map((entry) => entry.code)).toEqual(['hang_tag', 'alpha_box'])
    expect(fieldsForList(fields, null, false)).toHaveLength(2)
  })
  it('a cell holds what the target takes (YES / NO, a code, a number, a day) and gives it back as stored', () => {
    expect(cellValueOf({ type: 'YES_NO' }, { value: true, wordsIt: null, wordsEn: null })).toBe('YES')
    expect(cellValueOf({ type: 'YES_NO' }, { value: false, wordsIt: null, wordsEn: null })).toBe('NO')
    expect(cellValueOf({ type: 'SELECT' }, { value: 'GIFT', wordsIt: 'Regalo', wordsEn: 'Gift box' })).toBe('GIFT')
    expect(cellValueOf({ type: 'NUMBER' }, { value: 12.5, wordsIt: null, wordsEn: null })).toBe(12.5)
    expect(cellValueOf({ type: 'TEXT' }, undefined)).toBeNull()
    expect(storedOfCell({ type: 'YES_NO' }, 'YES')).toBe(true)
    expect(storedOfCell({ type: 'YES_NO' }, 'NO')).toBe(false)
    expect(storedOfCell({ type: 'DATE' }, '2026-12-01')).toBe('2026-12-01')
    expect(storedOfCell({ type: 'TEXT' }, null)).toBeNull()
  })
  it('a number cell says its own problem (never "not one of the choices")', () => {
    expect(valueProblemKey({ kind: 'number' }, 'abc')).toBe('edit.problem.number')
    expect(valueProblemKey({ kind: 'number' }, 12.5)).toBeNull()
  })
})

describe('the clash and the words', () => {
  it('a cell changed by someone else meanwhile: refused "changed since", in both languages (never overwritten)', () => {
    for (const locale of LOCALES) {
      expect(CATALOGUE[locale].lists?.['edit.refusal.stale'], locale).toBeTruthy()
      expect(CATALOGUE[locale].lists?.['edit.problem.number'], locale).toBeTruthy()
      expect(CATALOGUE[locale].lists?.['custom.notThisCustomer'], locale).toBeTruthy()
      for (const key of ['cells.final', 'cells.nounOne', 'cells.nounOther', 'cells.noManage']) expect(CATALOGUE[locale][NAMESPACE]?.[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})
