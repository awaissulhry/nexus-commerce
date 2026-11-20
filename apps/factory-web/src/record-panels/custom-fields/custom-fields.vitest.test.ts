import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api/errors'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES } from '../../lib/i18n/locales'
import { render, textOf } from '../../lib/record-thread/parts/testing'
import type { Field } from '../../areas/admin/fields/api'
import { DEMO_ORDER_FIELDS } from '../../areas/admin/fields/demo'
import type { RecordValue } from './api'
import { changedCount, changesOf, draftOf, fieldsRecordOf, inputOf, readNumber, saveFaultOf, valueWords } from './model'
import { foldedRead, portalTagOf } from './model' // F-OO-212
import { designScreen } from './fixtures' // F-OO-212
import { CustomFieldsPanel, type CustomFieldsModel } from './view/CustomFieldsPanel' // F-OO-212

/**
 * The custom-fields section of a record (B-W2b-431, SCR-520), pure: which panels have one, a typed number in either
 * language, what each type's draft sends (money in minor units of its currency, a multi-select in its list's order), only
 * the changed values with the version read, a value in words, and a refused save said at its field.
 */

const field = (code: string): Field => {
  const found = DEMO_ORDER_FIELDS.find((entry) => entry.code === code)!
  const { valueCount: _count, createdAt: _created, updatedAt: _updated, ...rest } = found
  return rest
}
const row = (code: string, value: unknown, version = 1, words: string | null = null): RecordValue => ({ code, value, wordsIt: words, wordsEn: words, version, changedAt: '2026-11-12T10:15:00Z', changedById: '0190f0e2-4310-7000-8000-000000000301' })

describe('which records have the section', () => {
  it('maps a panel’s model to its record type; a party is the customer’s (and the supplier’s) fields', () => {
    expect(fieldsRecordOf('SalesOrder')).toBe('ORDER')
    expect(fieldsRecordOf('Party')).toBe('CUSTOMER')
    expect(fieldsRecordOf('Item')).toBe('MATERIAL')
    expect(fieldsRecordOf('Invoice')).toBeNull()
  })
})

describe('what a draft sends', () => {
  it('reads a number typed in either language', () => {
    expect(readNumber('1.234,5')).toBe(1234.5)
    expect(readNumber('1,234.5')).toBe(1234.5)
    expect(readNumber(' 4,25 ')).toBe(4.25)
    expect(readNumber('-7')).toBe(-7)
    expect(readNumber('four')).toBeNull()
    expect(readNumber('')).toBeNull()
  })

  it('each type: text, number, money in minor units, a day, codes in the list’s order, a reference, yes/no', () => {
    expect(inputOf(field('gift_note'), '  Thanks ')).toEqual({ value: 'Thanks' })
    expect(inputOf(field('carton_weight'), '4,5')).toEqual({ value: 4.5 })
    expect(inputOf(field('carton_weight'), 'x')).toEqual({ problem: 'cf.check.number' })
    expect(inputOf(field('agreed_discount'), { amount: '125,50', currency: 'eur' })).toEqual({ value: { amount: 12550, currency: 'EUR' } })
    expect(inputOf(field('agreed_discount'), { amount: '1234', currency: 'JPY' })).toEqual({ value: { amount: 1234, currency: 'JPY' } })
    expect(inputOf(field('agreed_discount'), { amount: '1,005', currency: 'EUR' })).toEqual({ problem: 'cf.check.places' })
    expect(inputOf(field('agreed_discount'), { amount: '5', currency: 'EU' })).toEqual({ problem: 'cf.check.currency' })
    expect(inputOf(field('fair_date'), '2026-02-30')).toEqual({ problem: 'cf.check.date' })
    expect(inputOf(field('fair_date'), '2026-12-03')).toEqual({ value: '2026-12-03' })
    expect(inputOf(field('delivery_windows'), ['AFTERNOON', 'MORNING'])).toEqual({ value: ['MORNING', 'AFTERNOON'] })
    expect(inputOf(field('reference_style'), { id: 'abc', words: 'STY' })).toEqual({ value: 'abc' })
    expect(inputOf(field('lining_wanted'), 'no')).toEqual({ value: false })
    expect(inputOf(field('box_type'), '')).toEqual({ problem: 'cf.check.required' })
    expect(inputOf(field('gift_note'), '')).toEqual({ value: null })
  })

  it('sends only the changed values, each at the version read (null when it had none); a cleared one as null', () => {
    const fields = [field('box_type'), field('gift_note'), field('carton_weight'), field('agreed_discount')]
    const values = [row('box_type', 'PLAIN', 3), row('gift_note', 'Hi', 2), row('agreed_discount', { amount: 5000, currency: 'EUR' }, 4)]
    const draft = draftOf(fields, values)
    expect(draft.agreed_discount).toEqual({ amount: '50.00', currency: 'EUR' })
    expect(changesOf(fields, values, draft)).toEqual({ entries: [], problems: {} })
    const changed = { ...draft, gift_note: '', carton_weight: '2', agreed_discount: { amount: '50', currency: 'EUR' } }
    expect(changesOf(fields, values, changed)).toEqual({ entries: [{ code: 'gift_note', value: null, version: 2 }, { code: 'carton_weight', value: 2, version: null }], problems: {} })
    expect(changedCount(fields, values, { ...changed, box_type: '' })).toBe(3)
  })

  it('a required field the record never had is not this edit’s problem', () => {
    const fields = [field('box_type')]
    expect(changesOf(fields, [], draftOf(fields, []))).toEqual({ entries: [], problems: {} })
  })
})

describe('a value in words', () => {
  it('a value the list no longer offers is marked; a record the reader may not open has no words', () => {
    expect(valueWords(field('box_type'), row('box_type', 'GIFT'), 'en')).toEqual({ text: 'Gift', inactive: true })
    expect(valueWords(field('box_type'), row('box_type', 'PLAIN'), 'it')).toEqual({ text: 'Semplice', inactive: false })
    expect(valueWords(field('delivery_windows'), row('delivery_windows', ['MORNING', 'AFTERNOON']), 'en').text).toBe('Morning, Afternoon')
    expect(valueWords(field('reference_style'), row('reference_style', 'abc'), 'en')).toEqual({ text: null, hidden: true })
    expect(valueWords(field('carton_weight'), row('carton_weight', 4.25), 'en').text).toBe('4.25 kg')
    expect(valueWords(field('agreed_discount'), row('agreed_discount', { amount: 12500, currency: 'EUR' }), 'en').text).toContain('125.00')
    expect(valueWords(field('gift_note'), undefined, 'en')).toEqual({ text: null })
  })
})

describe('a refused save', () => {
  const sent = [
    { code: 'gift_note', value: 'x', version: 2 },
    { code: 'box_type', value: 'GIFT', version: 3 },
  ]
  it('points at the field of the entry the API names', () => {
    expect(saveFaultOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/values/1/value', message: 'GIFT is no longer offered: pick an active value.' }]), sent)).toEqual({ key: 'cf.fault.value', code: 'box_type' })
    expect(saveFaultOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: ['body', 'values', '0', 'version'] }]), sent)).toEqual({ key: 'cf.fault.stale', code: 'gift_note' })
    expect(saveFaultOf(new ApiError('forbidden', 403, 'forbidden', 'x'), sent)).toEqual({ key: 'cf.fault.forbidden', code: null })
    expect(saveFaultOf(new Error('boom'), sent)).toEqual({ key: 'cf.fault.failed', code: null })
  })
})

// ---- F-OO-212 (order overview 11-design §8.2; review F9): the shared panel — only the filled rows, the empty ones folded, who sees a
// field shown in the portal. It reaches EVERY record page (quote, style, work order …): one shared part, exactly the same.
describe('F-OO-212: only filled rows, "Not filled: …" folded, the "Customer sees it" tag; edit mode lists every field', () => {
  const caseOf = (id: string) => (designScreen as DesignScreen<CustomFieldsModel>).cases.find((entry) => entry.id === id)!.model
  const draw = (model: CustomFieldsModel, locale: (typeof LOCALES)[number]) => render(createElement(CustomFieldsPanel as ComponentType<{ model: CustomFieldsModel }>, { model }), locale)
  const count = (text: string, words: string) => text.split(words).length - 1

  it('foldedRead: a field with a value is a row (also one the reader may not see in words); one with none folds, in the sections\' order', () => {
    const fields = [field('box_type'), field('gift_note'), field('fair_date'), field('reference_style')]
    const read = foldedRead(fields, [row('gift_note', 'Hi'), row('reference_style', 'abc' /* no words: a record the reader may not open */), row('fair_date', null), row('box_type', '')])
    expect(read.sections.map((section) => [section.section, section.fields.map((entry) => entry.code)])).toEqual([
      ['packing', ['gift_note']],
      ['custom', ['reference_style']],
    ])
    expect(read.empty.map((entry) => entry.code)).toEqual(['box_type', 'fair_date'])
    // Nothing filled: no section at all, every field folded.
    expect(foldedRead(fields, [])).toEqual({ sections: [], empty: fields })
  })

  it('portalTagOf: the customer on a quote or an order, the supplier on a purchase order, the partner on a party; none elsewhere', () => {
    expect(portalTagOf('ORDER')).toBe('cf.portal.customer')
    expect(portalTagOf('QUOTE')).toBe('cf.portal.customer')
    expect(portalTagOf('PURCHASE_ORDER')).toBe('cf.portal.supplier')
    expect(portalTagOf('CUSTOMER')).toBe('cf.portal.party')
    for (const none of ['STYLE', 'MATERIAL', 'LOT', 'WORK_ORDER'] as const) expect(portalTagOf(none), none).toBeNull()
    expect(portalTagOf(null)).toBeNull()
  })

  it('draws EN + IT: the empty fields in the folded line, the required one says so; the filled rows only', () => {
    const en = textOf(draw(caseOf('f-oo-212-folded'), 'en'))
    expect(en).toContain('Not filled: Box type (required), Fair date')
    expect(count(en, 'Fair date')).toBe(1)
    expect(en).toContain('Gift note')
    const it_ = textOf(draw(caseOf('f-oo-212-folded'), 'it'))
    expect(it_).toContain('Non compilati: Tipo di scatola (obbligatorio), Data della fiera')
    expect(count(it_, 'Data della fiera')).toBe(1)
    // One empty field: the singular form.
    const one = { ...caseOf('values'), values: caseOf('values').values.filter((value) => value.code !== 'fair_date') }
    expect(textOf(draw(one, 'it'))).toContain('Non compilato: Data della fiera')
    expect(textOf(draw(one, 'en'))).toContain('Not filled: Fair date')
    // Every field filled: no folded line.
    for (const locale of LOCALES) expect(textOf(draw(caseOf('values'), locale))).not.toMatch(/Not filled:|Non compilat[oi]:/)
  })

  it('none filled yet: one line naming every field, the required one first as it comes', () => {
    expect(textOf(draw(caseOf('empty-values'), 'en'))).toContain('None filled yet: Box type (required), Gift note, Carton weight')
    expect(textOf(draw(caseOf('empty-values'), 'it'))).toContain('Nessuno ancora compilato: Tipo di scatola (obbligatorio), Biglietto')
  })

  it('"Customer sees it" on the label of a field shown in the portal (an order), in edit mode too; none where the portal reads nothing', () => {
    const values = textOf(draw(caseOf('values'), 'en'))
    // Box type and Agreed discount are shown in the portal; the other fields are not.
    expect(count(values, 'Customer sees it')).toBe(2)
    expect(count(textOf(draw(caseOf('values'), 'it')), 'Lo vede il cliente')).toBe(2)
    expect(textOf(draw(caseOf('editing'), 'en'))).toContain('Customer sees it')
    for (const locale of LOCALES) expect(textOf(draw(caseOf('f-oo-212-no-portal'), locale))).not.toMatch(/Customer sees it|Lo vede il cliente/)
    // A purchase order's fields are read by the supplier, a party's by the partner itself.
    expect(textOf(draw({ ...caseOf('values'), portalTag: 'cf.portal.supplier' }, 'en'))).toContain('Supplier sees it')
    expect(textOf(draw({ ...caseOf('values'), portalTag: 'cf.portal.party' }, 'it'))).toContain('Lo vedono nel loro portale')
  })

  it('edit mode still lists every field (an empty one too) and folds nothing; the admin hint stays as today, no "Manage fields ›"', () => {
    const editing = { ...caseOf('f-oo-212-folded'), editing: true }
    for (const locale of LOCALES) {
      const text = textOf(draw(editing, locale))
      expect(text).toContain(locale === 'en' ? 'Fair date' : 'Data della fiera')
      expect(text).toContain(locale === 'en' ? 'Box type' : 'Tipo di scatola')
      expect(text).not.toMatch(/Not filled:|Non compilat[oi]:|None filled yet|Nessuno ancora compilato/)
    }
    const read = textOf(draw(caseOf('f-oo-212-folded'), 'en'))
    expect(read).toContain('Fields added without code in Admin › Fields & lists.')
    expect(read).not.toContain('Manage fields')
    // No link to Admin › Fields & lists in the panel (dropped: review F9); the hint's words stay for every reader.
    expect(readFileSync(new URL('./view/CustomFieldsPanel.tsx', import.meta.url), 'utf8')).not.toMatch(/href=\{[^}]*admin\/fields/)
  })

  it('the panel learns who reads the portal from its record type (one line in the container hook)', () => {
    expect(readFileSync(new URL('./use-custom-fields.ts', import.meta.url), 'utf8')).toContain('portalTag: portalTagOf(recordType),')
  })
})
// ---- end F-OO-212
