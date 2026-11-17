import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GRAINS } from '@nexus/factory-domain/auth/grains/grains'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { FIELD_AUDIENCES, FIELD_TYPES, OPTION_ICONS } from '@nexus/factory-domain/fields/rules'
import { SWATCHES } from '@nexus/ui/primitives'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as recordScreen } from '../../../record-panels/custom-fields/fixtures'
import { RECORD_KEYS } from './api'
import { DEMO_BOX, DEMO_ORDER_FIELDS, DEMO_PICKLISTS } from './demo'
import { designScreen } from './fixtures'
import {
  addressOf,
  codeFrom,
  draftHeld,
  draftOfField,
  faultOf,
  fieldChangeOf,
  fieldsQuery,
  moveHeld,
  moveOf,
  newDraft,
  newFieldBody,
  portalHeld,
  previewSections,
  sectionsOf,
  sectionText,
  shownFields,
  TABS,
  typedCode,
  valueDraftHeld,
  valueMoveOf,
  withDraft,
  type DraftContext,
} from './model'

/**
 * Admin › Fields & lists (B-W2b-431, SCR-164) and the record's custom-fields section (SCR-520): the address, the field
 * draft and what it sends, why a button waits, the API's refusals in words, the order of a section, the preview, and the
 * `admin-fields` words — the same keys in it and en, every key the code names, and every design case drawn in both
 * languages with no key on screen. AG Grid draws its cells only in a browser: the live check covers them.
 */

const grains = new Set(['price', 'cost'] as const)
const search = (query: string) => new URLSearchParams(query)
const context = (overrides: Partial<DraftContext> = {}): DraftContext => ({ editing: null, codes: DEMO_ORDER_FIELDS.map((field) => field.code), grains, picklists: DEMO_PICKLISTS, busy: false, ...overrides })

describe('the address', () => {
  it('reads the record type, the tab, the list, the field and archived; leaves the defaults out', () => {
    expect(addressOf(search('type=ORDER&tab=picklists&list=L1&field=new&archived=1'))).toEqual({ type: 'ORDER', tab: 'picklists', list: 'L1', field: 'new', archived: true })
    expect(addressOf(search('type=INVOICE&tab=statuses'))).toEqual({ type: null, tab: 'fields', list: null, field: null, archived: false })
    expect(fieldsQuery({ type: 'ORDER', tab: 'fields', list: 'L1', field: null, archived: false })).toBe('?type=ORDER')
    expect(fieldsQuery({ type: null, tab: 'fields', list: null, field: null, archived: false })).toBe('')
    expect(fieldsQuery({ type: 'LOT', tab: 'picklists', list: 'L2', field: null, archived: true })).toBe('?type=LOT&tab=picklists&list=L2&archived=1')
  })

  it('names the design tabs; Statuses, Tags and Validation come later', () => {
    expect(TABS).toEqual(['fields', 'picklists', 'statuses', 'tags', 'validation'])
  })
})

describe('the field draft', () => {
  it('a key from the English label until one is typed', () => {
    expect(codeFrom('Heat number')).toBe('heat_number')
    expect(codeFrom('  Città di consegna! ')).toBe('citta_di_consegna')
    expect(codeFrom('2nd fitting')).toBe('nd_fitting')
    expect(typedCode('Fit Notes-2')).toBe('fit_notes2')
    const named = withDraft(newDraft(), { labelEn: 'Fair stand' }, grains)
    expect(named.code).toBe('fair_stand')
    const typed = withDraft(named, { code: 'stand' }, grains)
    expect(withDraft(typed, { labelEn: 'Fair stand number' }, grains).code).toBe('stand')
  })

  it('a money type is seen with a grain the person holds; another type drops the grain, the unit, the list and the link', () => {
    const money = withDraft(newDraft(), { type: 'MONEY' }, grains)
    expect([money.audience, money.grain]).toEqual(['MONEY', 'price'])
    const text = withDraft({ ...money, unit: 'kg', picklistId: 'L1', linkTo: 'STYLE' }, { type: 'TEXT' }, grains)
    expect([text.audience, text.grain, text.unit, text.picklistId, text.linkTo]).toEqual(['INTERNAL', null, '', null, null])
    expect(withDraft(newDraft(), { type: null }, grains).picklistId).toBeNull()
  })

  it('the portal only for an internal field or a price, on a record partners read', () => {
    expect(portalHeld({ audience: 'INTERNAL', grain: null }, true)).toBeNull()
    expect(portalHeld({ audience: 'MONEY', grain: 'price' }, true)).toBeNull()
    expect(portalHeld({ audience: 'MONEY', grain: 'cost' }, true)).toBe('wait.portalMoney')
    expect(portalHeld({ audience: 'PERSONAL', grain: null }, true)).toBe('wait.portalPersonal')
    expect(portalHeld({ audience: 'INTERNAL', grain: null }, false)).toBe('wait.portalRecord')
    const personal = withDraft({ ...newDraft(), shownInPortal: true }, { audience: 'PERSONAL' }, grains)
    expect(personal.shownInPortal).toBe(false)
  })

  it('Add field waits, in order, for what is missing', () => {
    let draft = newDraft()
    expect(draftHeld(draft, context({ busy: true }))).toBe('wait.busy')
    expect(draftHeld(draft, context())).toBe('wait.type')
    draft = withDraft(draft, { type: 'SELECT' }, grains)
    expect(draftHeld(draft, context())).toBe('wait.code')
    draft = withDraft(draft, { labelEn: 'Box type' }, grains)
    expect(draftHeld(draft, context())).toBe('wait.codeTaken')
    draft = withDraft(draft, { code: 'box_size' }, grains)
    expect(draftHeld(draft, context())).toBe('wait.labelIt')
    draft = withDraft(draft, { labelIt: 'Misura scatola' }, grains)
    expect(draftHeld(draft, context())).toBe('wait.list')
    expect(draftHeld(draft, context({ picklists: [] }))).toBe('wait.noList')
    draft = withDraft(draft, { picklistId: DEMO_BOX.id }, grains)
    expect(draftHeld(draft, context())).toBeNull()
    const link = withDraft(withDraft(newDraft(), { type: 'LINK', labelEn: 'Style', labelIt: 'Modello' }, grains), { code: 'style_ref' }, grains)
    expect(draftHeld(link, context())).toBe('wait.linkTo')
    const money = withDraft(withDraft(newDraft(), { type: 'MONEY', labelEn: 'Fee', labelIt: 'Quota' }, new Set()), { code: 'fee' }, new Set())
    expect(draftHeld(money, context({ grains: new Set() }))).toBe('wait.noGrain')
    expect(draftHeld({ ...money, grain: 'margin' }, context())).toBe('wait.grainNotHeld')
  })

  it('a field being changed waits until something changed, and sends only that', () => {
    const box = DEMO_ORDER_FIELDS[0]!
    const draft = draftOfField(box)
    expect(draftHeld(draft, context({ editing: box }))).toBe('wait.nothingChanged')
    expect(fieldChangeOf(box, draft)).toBeNull()
    expect(fieldChangeOf(box, { ...draft, labelEn: ' Box  ', required: false })).toEqual({ version: box.version, labelEn: 'Box', required: false })
  })

  it('POST /fields sends what the type takes', () => {
    const select = { ...withDraft(newDraft('packing'), { type: 'SELECT', labelEn: 'Box size ', labelIt: 'Misura' }, grains), picklistId: DEMO_BOX.id, unit: 'kg', linkTo: 'STYLE' as const }
    expect(newFieldBody('ORDER', select)).toMatchObject({ recordType: 'ORDER', code: 'box_size', type: 'SELECT', labelEn: 'Box size', section: 'packing', unit: null, picklistId: DEMO_BOX.id, linkTo: null, grain: null, audience: 'INTERNAL' })
    const money = withDraft(newDraft(), { type: 'MONEY', labelEn: 'Agreed price', labelIt: 'Prezzo' }, grains)
    expect(newFieldBody('QUOTE', money)).toMatchObject({ type: 'MONEY', audience: 'MONEY', grain: 'price', picklistId: null })
    const number = withDraft(newDraft(), { type: 'NUMBER', labelEn: 'Weight', labelIt: 'Peso', unit: ' kg ' }, grains)
    expect(newFieldBody('LOT', number).unit).toBe('kg')
  })
})

describe('the API refusals in our words', () => {
  const error = (kind: 'conflict' | 'invalid' | 'forbidden' | 'unavailable', path: string, message = 'x', code: string = kind) => new ApiError(kind, kind === 'conflict' ? 409 : kind === 'invalid' ? 400 : kind === 'forbidden' ? 403 : 0, code, 'x', null, [{ path, message }])
  it('says each conflict, each refused field, and when a write may have landed', () => {
    expect(faultOf(error('conflict', 'body/code', 'taken, inactive'))).toEqual({ key: 'fault.valueTakenInactive', unknown: false })
    expect(faultOf(error('conflict', 'body/code', 'full')).key).toBe('fault.listFull')
    expect(faultOf(error('conflict', 'body/code')).key).toBe('fault.codeTaken')
    expect(faultOf(error('conflict', 'body/status', 'in use')).key).toBe('fault.listInUse')
    expect(faultOf(error('conflict', 'version')).key).toBe('fault.stale')
    expect(faultOf(error('invalid', 'body/grain')).key).toBe('fault.grain')
    expect(faultOf(error('invalid', 'body/whatever')).key).toBe('fault.invalid')
    expect(faultOf(error('forbidden', '')).key).toBe('fault.forbidden')
    expect(faultOf(error('unavailable', '', 'x', 'network'))).toEqual({ key: 'fault.offline', unknown: true })
    expect(faultOf(new Error('boom')).key).toBe('fault.failed')
  })
})

describe('the fields grid and the preview', () => {
  it('sorts by section, then place; hides archived fields unless asked; searches key, labels and section', () => {
    expect(shownFields(DEMO_ORDER_FIELDS, { archived: false, query: '' }).map((field) => field.section)).toEqual(['packing', 'packing', 'packing', 'packing', 'terms', 'terms', 'terms', 'custom', 'custom', 'custom'])
    expect(shownFields(DEMO_ORDER_FIELDS, { archived: true, query: 'route' }).map((field) => field.code)).toEqual(['old_route'])
    expect(shownFields(DEMO_ORDER_FIELDS, { archived: false, query: 'route' })).toEqual([])
    expect(sectionsOf(DEMO_ORDER_FIELDS)).toEqual(['custom', 'packing', 'terms'])
    expect(sectionText('fit_notes')).toBe('Fit notes')
    expect(sectionText('custom')).toBeNull()
  })

  it('moves the picked fields one place within their section, and says why it waits', () => {
    const [, note, weight, lining, fair] = DEMO_ORDER_FIELDS
    expect(moveOf(DEMO_ORDER_FIELDS, [weight!.id], -1)).toEqual({ section: 'packing', fields: [DEMO_ORDER_FIELDS[0]!, weight!, note!, lining!].map((field) => ({ id: field.id, version: field.version })) })
    expect(moveOf(DEMO_ORDER_FIELDS, [DEMO_ORDER_FIELDS[0]!.id], -1)).toBeNull()
    expect(moveHeld(DEMO_ORDER_FIELDS, [DEMO_ORDER_FIELDS[0]!.id], -1, false, false)).toBe('wait.moveTop')
    expect(moveHeld(DEMO_ORDER_FIELDS, [note!.id, fair!.id], 1, false, false)).toBe('wait.moveSections')
    expect(moveHeld(DEMO_ORDER_FIELDS, [note!.id], 1, false, true)).toBe('wait.moveSearching')
    expect(moveHeld(DEMO_ORDER_FIELDS, [DEMO_ORDER_FIELDS[10]!.id], 1, false, false)).toBe('wait.moveArchived')
    expect(moveHeld(DEMO_ORDER_FIELDS, [], 1, false, false)).toBe('wait.pick')
    expect(moveHeld(DEMO_ORDER_FIELDS, [note!.id], 1, false, false)).toBeNull()
  })

  it('the preview draws the active fields by section, in order', () => {
    expect(previewSections(DEMO_ORDER_FIELDS).map((section) => [section.section, section.fields.length])).toEqual([
      ['packing', 4],
      ['terms', 3],
      ['custom', 3],
    ])
  })

  it('a list value waits for its code and labels; values move one place', () => {
    const draft = { code: 'PLAIN', codeTyped: true, labelIt: 'x', labelEn: 'y', colour: null, icon: null, description: '' }
    expect(valueDraftHeld(draft, DEMO_BOX, false)).toBe('wait.valueCodeTaken')
    expect(valueDraftHeld({ ...draft, code: 'lower' }, DEMO_BOX, false)).toBe('wait.valueCode')
    expect(valueDraftHeld({ ...draft, code: 'TALL' }, { ...DEMO_BOX, status: 'ARCHIVED' }, false)).toBe('wait.listArchived')
    expect(valueDraftHeld({ ...draft, code: 'TALL' }, DEMO_BOX, false)).toBeNull()
    const [plain, wooden, gift] = DEMO_BOX.values
    expect(valueMoveOf(DEMO_BOX.values, [gift!.id], -1)?.map((entry) => entry.id)).toEqual([plain!.id, gift!.id, wooden!.id])
    expect(valueMoveOf(DEMO_BOX.values, [plain!.id], -1)).toBeNull()
  })
})

// ── the words ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const NS = 'admin-fields'
const SRC = fileURLToPath(new URL('../../../', import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' && entry.name !== 'demo.ts' ? [path] : []
  })
const FILES = [...sources(join(SRC, 'areas/admin/fields')), ...sources(join(SRC, 'record-panels/custom-fields'))]
const PREFIXES = ['band', 'live', 'later', 'pick', 'tabs', 'recordType', 'shared', 'readOnly', 'refused', 'error', 'state', 'fields', 'col', 'section', 'type', 'typeHint', 'grain', 'audience', 'audienceHint', 'move', 'preview', 'fieldDialog', 'whose', 'lists', 'values', 'listDialog', 'renameDialog', 'valueDialog', 'look', 'mark', 'keys', 'wait', 'fault', 'done', 'cf', /* B-TH-242 */ 'customer', 'portalLine']
/** Strings shaped like keys that are not ours: the permissions the code names, and the list frame's own `keys.click`. */
const NOT_KEYS: ReadonlySet<string> = new Set<string>([...FACTORY_PERMISSIONS.assignable.map((definition) => definition.name), 'keys.click'])
const own = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale][NS] ?? {}
const has = (key: string) => LOCALES.every((locale) => key in own(locale) || (`${key}_one` in own(locale) && `${key}_other` in own(locale)))

describe('the admin-fields words', () => {
  it('the same keys and placeholders in it and en, no empty text', () => {
    const en = own('en')
    const it_ = own('it')
    expect(Object.keys(en).length).toBeGreaterThan(300)
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(it_[key]?.trim(), key).not.toBe('')
      expect(placeholdersOf(it_[key] ?? ''), key).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })

  it('every key the code names exists (literally, or built from a closed set)', () => {
    const pattern = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
    const literal = new Set<string>()
    for (const file of FILES) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) if (!NOT_KEYS.has(match[1]!)) literal.add(match[1]!)
    const built = [
      ...RECORD_KEYS.map((key) => `recordType.${key}`),
      ...FIELD_TYPES.flatMap((type) => [`type.${type}`, `typeHint.${type}`]),
      ...FIELD_AUDIENCES.flatMap((audience) => [`audience.${audience}`, `audienceHint.${audience}`]),
      ...GRAINS.map((grain) => `grain.${grain}`),
      ...TABS.map((tab) => `tabs.${tab}`),
      ...['connecting', 'live', 'offline'].map((state) => `live.${state}`),
      ...['saving', 'saved'].map((state) => `mark.${state}`),
      ...['ACTIVE', 'ARCHIVED'].map((state) => `state.${state}`),
      'cf.yes',
      'cf.no',
    ]
    const missing = [...literal, ...built].filter((key) => !has(key))
    expect(missing).toEqual([])
    expect(literal.size).toBeGreaterThan(200)
  })

  it('the icons and colours of list values have their names (the shared reason lists’ words)', () => {
    for (const locale of LOCALES) {
      const reasons = CATALOGUE[locale].reasons ?? {}
      for (const icon of OPTION_ICONS) expect(reasons[`icon.${icon}`], `${locale} icon.${icon}`).toBeTruthy()
      for (const swatch of SWATCHES) expect(reasons[`colour.${swatch.name}`], `${locale} colour.${swatch.name}`).toBeTruthy()
    }
  })
})

/** A key left on screen: one of this catalogue's. */
const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)*\\b`)

describe('every design case draws in both languages with no key on screen', () => {
  for (const screen of [designScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}`, () => {
        const View = screen.view as ComponentType<{ model: unknown }>
        for (const item of screen.cases) {
          const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
          expect(html.replace(/https?:\/\/\S+|[\w-]+\.(?:pdf|png|jpg)/g, '').match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
          if (screen.screen === 'SCR-164' && item.id === 'orders') {
            expect(html).toContain(locale === 'it' ? 'Anteprima del modulo' : 'Form preview')
            expect(html).toContain(locale === 'it' ? 'Peso del cartone' : 'Carton weight')
          }
          if (screen.screen === 'SCR-520' && item.id === 'values') {
            expect(html).toContain(locale === 'it' ? 'Non più offerto' : 'No longer offered')
            expect(html).toContain('STY-DEMO-0108')
          }
        }
      })
    }
  }

  it('the design names its states', () => {
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['orders', 'add-field', 'add-money', 'edit-field', 'selected', 'picklists', 'empty', 'read-only', 'loading', 'slow', 'error', 'offline', 'no-permission']))
    expect(recordScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['values', 'reader', 'editing', 'editing-problems', 'link-picker', 'loading', 'error']))
  })
})

// ── B-TH-242 (threads plan TH-4, SHEET-G06 / WALL-G08; X-ADM-FIELDS.dialog-F01, -F02; wall W17): a column for one customer ──
import { customerChoiceOn, customerLineOf, customerSearchFault, portalLineOf, whereLineOf } from './model'
import { DEMO_ALPHA_FIELD, DEMO_FIELD_CUSTOMERS } from './demo'

describe('a field for one customer (B-TH-242)', () => {
  const alpha = DEMO_FIELD_CUSTOMERS[0]
  const named = (patch: Parameters<typeof withDraft>[1]) => withDraft(withDraft(newDraft('custom'), { type: 'TEXT', labelEn: 'Hang tag', labelIt: 'Cartellino' }, grains), patch, grains)

  it('"For" is offered on customers, quotes and orders only (their records name their customer)', () => {
    expect(customerChoiceOn('ORDER')).toBe(true)
    expect(customerChoiceOn('QUOTE')).toBe(true)
    expect(customerChoiceOn('CUSTOMER')).toBe(true)
    expect(customerChoiceOn('MATERIAL')).toBe(false)
    expect(customerChoiceOn('SUPPLIER')).toBe(false)
  })

  it('one customer kept: POST /fields sends it for an order; every customer sends none; never on a record type that takes none', () => {
    const one = named({ forCustomer: 'one', partyId: alpha.id, partyName: alpha.legalName })
    expect(newFieldBody('ORDER', one).partyId).toBe(alpha.id)
    expect(newFieldBody('ORDER', named({})).partyId).toBeNull()
    expect(newFieldBody('MATERIAL', one).partyId).toBeNull()
    // The name is the dialog's own: never sent.
    expect(JSON.stringify(newFieldBody('ORDER', one))).not.toContain(alpha.legalName)
  })

  it('"One customer" waits for the customer; back to every customer drops it', () => {
    const waiting = named({ forCustomer: 'one' })
    expect(draftHeld(waiting, context())).toBe('wait.customer')
    expect(draftHeld(named({ forCustomer: 'one', partyId: alpha.id, partyName: alpha.legalName }), context())).toBeNull()
    const back = withDraft(named({ forCustomer: 'one', partyId: alpha.id, partyName: alpha.legalName }), { forCustomer: 'every' }, grains)
    expect(back.partyId).toBeNull()
    expect(back.partyName).toBeNull()
  })

  it('a field\'s customer never changes: its dialog keeps it fixed and its change sends no customer', () => {
    const draft = draftOfField(DEMO_ALPHA_FIELD)
    expect(draft.forCustomer).toBe('one')
    expect(draft.partyId).toBe(alpha.id)
    expect(draft.partyName).toBe(alpha.legalName)
    expect(fieldChangeOf(DEMO_ALPHA_FIELD, { ...draft, labelEn: 'Alpha tag' })).toEqual({ version: DEMO_ALPHA_FIELD.version, labelEn: 'Alpha tag' })
  })

  it('the preview line: a field for every customer shown in the portal tells that every customer sees its name; one customer\'s never', () => {
    expect(portalLineOf({ shownInPortal: true, forCustomer: 'every', audience: 'INTERNAL', grain: null }, true)).toBe('portalLine.every')
    expect(portalLineOf({ shownInPortal: true, forCustomer: 'one', audience: 'INTERNAL', grain: null }, true)).toBeNull()
    expect(portalLineOf({ shownInPortal: false, forCustomer: 'every', audience: 'INTERNAL', grain: null }, true)).toBeNull()
    // Personal data never goes to the portal: no line.
    expect(portalLineOf({ shownInPortal: true, forCustomer: 'every', audience: 'PERSONAL', grain: null }, true)).toBeNull()
    expect(CATALOGUE.en[NS]?.['portalLine.every']).toBe('Every customer will see this column name in its portal.')
  })

  it('where it shows, and the field\'s line in the grid', () => {
    expect(whereLineOf({ forCustomer: 'every', partyId: null, partyName: null }).key).toBe('customer.previewEvery')
    expect(whereLineOf({ forCustomer: 'one', partyId: null, partyName: null }).key).toBe('customer.previewPick')
    expect(whereLineOf({ forCustomer: 'one', partyId: alpha.id, partyName: alpha.legalName })).toEqual({ key: 'customer.previewOne', params: { customer: alpha.legalName } })
    expect(customerLineOf(DEMO_ALPHA_FIELD)).toEqual({ key: 'customer.lineOne', params: { customer: alpha.legalName } })
    expect(customerLineOf(DEMO_ORDER_FIELDS[0]!)).toEqual({ key: 'customer.lineEvery' })
  })

  it('the customer picker\'s refusal in our words', () => {
    expect(customerSearchFault(new ApiError('forbidden', 403, 'forbidden', 'no', null, []))).toBe('customer.cannotSearch')
    expect(customerSearchFault(new ApiError('unavailable', 0, 'network', 'no', null, []))).toBe('fault.offline')
    expect(customerSearchFault(new Error('x'))).toBe('customer.searchFailed')
  })

  it('the design shows the customer column, the picker, the portal line and a fixed customer', () => {
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['th4-for-customer', 'th4-add-one-customer', 'th4-add-one-customer-picked', 'th4-add-every-portal', 'th4-edit-one-customer', 'th4-customers-refused']))
    const View = designScreen.view as ComponentType<{ model: unknown }>
    for (const locale of LOCALES) {
      const html = (id: string) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: designScreen.cases.find((item) => item.id === id)!.model })))
      const line = CATALOGUE[locale][NS]?.['portalLine.every'] ?? ''
      expect(html('th4-add-every-portal')).toContain(line.replace(/'/g, '&#x27;'))
      expect(html('th4-add-one-customer-picked')).not.toContain(line.replace(/'/g, '&#x27;'))
    }
  })
})
// ── end B-TH-242 ──
