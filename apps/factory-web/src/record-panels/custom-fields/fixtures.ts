import { defineDesignScreen } from '../../lib/design/design-screen'
import type { Field } from '../../areas/admin/fields/api'
import { DEMO_ORDER_FIELDS } from '../../areas/admin/fields/demo'
import type { RecordValue } from './api'
import { draftOf } from './model'
import { CustomFieldsPanel, type CustomFieldsModel } from './view/CustomFieldsPanel'

/**
 * SCR-520 — the custom-fields section of a record (B-W2b-431; design admin.fields "The record panels show a
 * custom-fields section"), at the end of the first tab of every record page that takes custom fields (B-TH-280: the
 * record frame's `fields` slot) — made-up data only (PLAN §3.1). Cases: an order's values by section, a reader without
 * the right to change the order or the price grain (the money field is absent, Edit says why), Edit with one control
 * per type, a refusal at its field, the link picker with what search found, someone saved first, loading and an error.
 * A record type without custom fields, or a record the person may not see, has no section at all.
 */

const ACTIVE: Field[] = DEMO_ORDER_FIELDS.filter((field) => field.status === 'ACTIVE').map(({ valueCount: _count, createdAt: _created, updatedAt: _updated, ...field }) => field)
const PERSON = '0190f0e2-4310-7000-8000-000000000301'
const STYLE = '0190f0e2-4310-7000-8000-000000000302'
const FILE = '0190f0e2-4310-7000-8000-000000000303'

const row = (code: string, value: unknown, words: string | null = null, version = 1): RecordValue => ({ code, value, wordsIt: words, wordsEn: words, version, changedAt: '2026-11-12T10:15:00Z', changedById: PERSON })

const VALUES: RecordValue[] = [
  row('box_type', 'GIFT', 'Gift', 2),
  row('gift_note', 'Happy anniversary, from the whole team.'),
  row('carton_weight', 4.25),
  row('lining_wanted', true),
  row('fair_date', '2026-12-03'),
  row('agreed_discount', { amount: 12500, currency: 'EUR' }),
  row('delivery_windows', ['MORNING', 'AFTERNOON']),
  row('reference_style', STYLE, 'STY-DEMO-0108'),
  row('signed_copy', FILE, 'signed-order-demo.pdf'),
  row('buyer_mobile', '+39 000 000 0000'),
]

const files = [
  { id: FILE, name: 'signed-order-demo.pdf' },
  { id: '0190f0e2-4310-7000-8000-000000000304', name: 'packing-list-demo.pdf' },
]
const people = [
  { id: PERSON, name: 'Giulia Demo' },
  { id: '0190f0e2-4310-7000-8000-000000000305', name: 'Marco Esempio' },
]

function model(overrides: Partial<CustomFieldsModel> = {}): CustomFieldsModel {
  return {
    recordLabel: 'SO-DEMO-0042',
    state: 'ready',
    fault: null,
    fields: ACTIVE,
    values: VALUES,
    canEdit: true,
    editing: false,
    draft: draftOf(ACTIVE, VALUES),
    problems: {},
    saving: false,
    saveFault: null,
    changedElsewhere: false,
    people,
    files,
    link: null,
    ...overrides,
  }
}

const READER_FIELDS = ACTIVE.filter((field) => field.audience === 'INTERNAL')
const READER_VALUES = VALUES.filter((value) => READER_FIELDS.some((field) => field.code === value.code)).map((value) => (value.code === 'reference_style' ? { ...value, wordsIt: null, wordsEn: null } : value))

export const designScreen = defineDesignScreen<CustomFieldsModel>({
  screen: 'SCR-520',
  title: 'A record’s custom fields: the section at the end of the record’s first tab (Admin › Fields & lists)',
  view: CustomFieldsPanel,
  cases: [
    { id: 'values', label: 'An order’s custom fields', model: model(), note: 'By section, in the reader’s language: a value the list no longer offers stays, marked; the money field carries its grain; the personal one is marked.' },
    {
      id: 'reader',
      label: 'A reader: no orders.manage, no price grain, no personal data',
      model: model({ canEdit: false, fields: READER_FIELDS, values: READER_VALUES, draft: draftOf(READER_FIELDS, READER_VALUES) }),
      note: 'The money and personal fields are absent (the API leaves them out); the linked style is one the reader may not open; Edit says why it waits.',
    },
    { id: 'editing', label: 'Edit: one control per type', model: model({ editing: true, draft: { ...draftOf(ACTIVE, VALUES), gift_note: 'Happy anniversary!', carton_weight: '4,5' } }), note: '⌘S saves every change at once; the bar counts them; Discard leaves the values as they were.' },
    {
      id: 'editing-problems',
      label: 'Edit: a value to fix and a refusal',
      model: model({ editing: true, draft: { ...draftOf(ACTIVE, VALUES), carton_weight: 'four', box_type: '' }, problems: { carton_weight: 'cf.check.number', box_type: 'cf.check.required' }, saveFault: 'cf.fault.value' }),
    },
    {
      id: 'link-picker',
      label: 'Edit: finding the style to link',
      model: model({
        editing: true,
        link: { code: 'reference_style', query: 'tote', loading: false, error: null, options: [{ value: STYLE, label: 'STY-DEMO-0108 · Tote bag demo' }, { value: '0190f0e2-4310-7000-8000-000000000306', label: 'STY-DEMO-0115 · Tote mini demo' }] },
      }),
    },
    { id: 'changed', label: 'Someone saved first', model: model({ editing: true, changedElsewhere: true }), note: 'The draft stays until Read again.' },
    { id: 'saving', label: 'Saving', model: model({ editing: true, saving: true, draft: { ...draftOf(ACTIVE, VALUES), gift_note: 'Thanks!' } }) },
    { id: 'empty-values', label: 'No value filled yet', model: model({ values: [], draft: draftOf(ACTIVE, []) }) },
    { id: 'loading', label: 'Loading', model: model({ state: 'loading', fields: [], values: [], draft: {} }) },
    { id: 'error', label: 'The custom fields could not be read', model: model({ state: 'error', fault: 'cf.fault.offline', fields: [], values: [], draft: {} }) },
  ],
})
