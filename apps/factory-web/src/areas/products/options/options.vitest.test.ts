import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OPTION_EFFECT_KINDS, OPTION_GROUP_KINDS } from '@nexus/factory-domain/product/options/rules'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { ROLE_PERMISSIONS } from '../library/demo'
import { EFFECTS, GROUP, ROWS, STYLE_OPTIONS, VALUES, withoutPrices } from './demo'
import { designScreen as listScreen } from './fixtures'
import {
  addValueBodyOf,
  createGroupBodyOf,
  decimalOf,
  effectBodyOf,
  effectDraftFrom,
  effectDraftOf,
  effectDraftProblems,
  effectPatchOf,
  effectsInOrder,
  filtersOf,
  groupDraftOf,
  groupDraftProblems,
  isFiltered,
  listQueryOf,
  moveHeldKey,
  movedSeq,
  newRuleItem,
  NO_FILTERS,
  noticesOf,
  offerPicksProblemKey,
  optionsCan,
  parseSurcharge,
  patternProblemKey,
  ruleItemsOf,
  ruleProblems,
  rulesBodyOf,
  rulesChangeCount,
  searchOf,
  shownRows,
  surchargeOf,
  surchargeText,
  tabOf,
  updateGroupBodyOf,
  valueDraftOf,
  valueDraftProblems,
  withKind,
  withSizeQuantity,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

describe('Options & rules, the list (B-W2b-242, SCR-114)', () => {
  it('keeps the filters and New option group in the address; a word that is no kind is not sent, and said', () => {
    const filters = filtersOf(new URLSearchParams('view=all&q=perf&kind=MULTI&outside=1&style=S1'))
    expect(filters).toEqual({ view: 'all', q: 'perf', kind: 'MULTI', outside: true, style: 'S1' })
    expect(searchOf(filters, { new: true })).toBe('?view=all&q=perf&kind=MULTI&outside=1&style=S1&new=1')
    expect(filtersOf(new URLSearchParams('view=gone'))).toEqual(NO_FILTERS)
    expect(isFiltered(NO_FILTERS)).toBe(false)
    expect(listQueryOf(filters)).toEqual({ query: { status: 'ALL', kind: 'MULTI', q: 'perf', outsideCertificate: 'true' }, ignored: [] })
    expect(listQueryOf({ ...NO_FILTERS, kind: 'HUMP' })).toEqual({ query: { status: 'ACTIVE', kind: undefined, q: undefined, outsideCertificate: undefined }, ignored: ['kind=HUMP'] })
  })

  it('reads the rights from the permissions and grains: the library, the surcharge, offers', () => {
    expect(optionsCan(ROLE_PERMISSIONS.developer)).toMatchObject({ view: true, manage: true, price: false, seesPrice: false, offer: true })
    expect(optionsCan(ROLE_PERMISSIONS.sales)).toMatchObject({ view: true, manage: false, price: true, seesPrice: true })
    expect(optionsCan(['product.options.price'])).toMatchObject({ price: false })
    expect(moveHeldKey([ROWS[0]!], { manage: false }, 'archive')).toBe('held.noManage')
    expect(moveHeldKey([ROWS[0]!], { manage: true }, 'restore')).toBe('held.noneArchived')
    expect(moveHeldKey([ROWS[7]!], { manage: true }, 'restore')).toBeNull()
  })

  it('the notices, the most serious first; a dismissed fact stays away until it changes', () => {
    const rows = ROWS
    expect(noticesOf({ ignored: ['kind=HUMP'], styleUnread: 'S1', rows }, new Set()).map((notice) => notice.kind)).toEqual(['IGNORED_FILTER', 'STYLE_UNREAD', 'NO_OPTIONS', 'NOT_OFFERED'])
    const empty = noticesOf({ ignored: [], styleUnread: null, rows }, new Set())[0]!
    expect(empty).toMatchObject({ kind: 'NO_OPTIONS', value: 'DEMO-HUMP', count: 1 })
    expect(noticesOf({ ignored: [], styleUnread: null, rows }, new Set(['NO_OPTIONS:DEMO-HUMP'])).map((notice) => notice.kind)).toEqual(['NOT_OFFERED'])
    expect(noticesOf({ ignored: ['kind=X'], styleUnread: null, rows: null }, new Set(['IGNORED_FILTER:kind=X']))).toHaveLength(1)
  })

  it("narrows the rows to a style's offers once they are read", () => {
    expect(shownRows(ROWS, null)).toHaveLength(ROWS.length)
    expect(shownRows(ROWS, { options: null, problem: null })).toBeNull()
    expect(shownRows(ROWS, { options: null, problem: 'problem.read.forbidden' })).toHaveLength(ROWS.length)
    expect(shownRows(ROWS, { options: STYLE_OPTIONS, problem: null })!.map((row) => row.code)).toEqual(['DEMO-ARMOUR', 'DEMO-PERF'])
  })

  it('New option group: the picks follow the kind, the rules in words, the body; Edit sends only what changed', () => {
    const draft = groupDraftOf(null, 'C1')
    expect(draft).toMatchObject({ companyId: 'C1', kind: 'SINGLE', minPicks: '0', maxPicks: '1' })
    expect(withKind(draft, 'MULTI')).toMatchObject({ minPicks: '0', maxPicks: '' })
    expect(withKind({ ...draft, minPicks: '1' }, 'MULTI')).toMatchObject({ minPicks: '1', maxPicks: '1' })
    expect(groupDraftProblems({ ...draft, code: 'demo patch', name: 'X', minPicks: '2', maxPicks: '' }).map((problem) => problem.key)).toEqual(['group.problem.codeForm', 'group.problem.singleMax', 'group.problem.singleMin'])
    expect(groupDraftProblems({ ...draft, kind: 'MULTI', code: 'P', name: 'X', minPicks: '3', maxPicks: '2' }).map((problem) => problem.key)).toEqual(['group.problem.maxBelow'])
    expect(createGroupBodyOf({ ...draft, companyId: '', code: ' DEMO-P ', name: 'Toppe', kind: 'MULTI', maxPicks: '' })).toEqual({ companyId: null, code: 'DEMO-P', name: 'Toppe', description: null, kind: 'MULTI', minPicks: 0, maxPicks: null })
    expect(updateGroupBodyOf(GROUP, groupDraftOf(GROUP, null))).toBeNull()
    expect(updateGroupBodyOf(GROUP, { ...groupDraftOf(GROUP, null), name: 'Foratura', maxPicks: '1' })).toEqual({ version: GROUP.version, name: 'Foratura' })
  })
})

describe('Options & rules, the record (SCR-114-record)', () => {
  it('options: a free text wants a length and a pattern that means the same everywhere; moves keep the order', () => {
    expect(valueDraftProblems({ ...valueDraftOf('SINGLE'), code: 'PERF-FULL', name: 'x' }, 'SINGLE', VALUES).map((problem) => problem.key)).toEqual(['value.problem.codeTaken'])
    expect(valueDraftProblems({ ...valueDraftOf('FREE_TEXT'), code: 'N', name: 'Nome', freeText: false }, 'FREE_TEXT', []).map((problem) => problem.key)).toEqual(['value.problem.freeTextGroup'])
    expect(valueDraftProblems({ code: 'N', name: 'Nome', freeText: true, maxLength: '600', pattern: '[[:alpha:]]' }, 'MULTI', []).map((problem) => problem.key)).toEqual(['value.problem.maxLength', 'value.problem.patternClass'])
    expect(patternProblemKey('^[A-Z')).toBe('value.problem.pattern')
    expect(patternProblemKey('\\p{L}+')).toBe('value.problem.patternUnicode')
    expect(patternProblemKey('^[A-Za-z ]{1,12}$')).toBeNull()
    expect(addValueBodyOf({ code: 'N', name: 'Nome', freeText: true, maxLength: '', pattern: '' })).toEqual({ code: 'N', name: 'Nome', freeText: true, freeTextMaxLength: 30, freeTextPattern: null })
    expect(movedSeq(VALUES, VALUES[1]!.id, -1)).toBe(0)
    expect(movedSeq(VALUES, VALUES[0]!.id, 1)).toBe(25)
    expect(movedSeq(VALUES, VALUES[2]!.id, 1)).toBeNull()
  })

  it('the surcharge: typed as an amount or a percent, never 0; read without the grain is not "none"', () => {
    expect(parseSurcharge('35')).toEqual({ ok: true, body: { priceDelta: '35', currency: 'EUR' } })
    expect(parseSurcharge('-25,5 usd')).toEqual({ ok: true, body: { priceDelta: '-25.5', currency: 'USD' } })
    expect(parseSurcharge('EUR 12')).toEqual({ ok: true, body: { priceDelta: '12', currency: 'EUR' } })
    expect(parseSurcharge('10 %')).toEqual({ ok: true, body: { pricePct: '10' } })
    expect(parseSurcharge('')).toEqual({ ok: true, body: {} })
    expect(parseSurcharge('0')).toEqual({ ok: false, key: 'price.problem.zero' })
    expect(parseSurcharge('2000%')).toEqual({ ok: false, key: 'price.problem.percent' })
    expect(parseSurcharge('cheap')).toEqual({ ok: false, key: 'price.problem.form' })
    expect(surchargeText(surchargeOf(GROUP.effects, VALUES[1]!.id), 'it-IT')).toBe('+15,00 EUR')
    expect(surchargeText(surchargeOf(GROUP.effects, VALUES[2]!.id), 'en-GB')).toBe('+10 %')
    expect(surchargeOf(GROUP.effects, VALUES[0]!.id)).toBeNull()
    expect(surchargeOf(withoutPrices(GROUP).effects, VALUES[1]!.id)).toBeUndefined()
    expect(decimalOf('1,50')).toBe('1.50')
    expect(decimalOf('abc')).toBeUndefined()
  })

  it('rules: the RuleBuilder draft and the outcome become the set, problems in words, changes counted', () => {
    const saved = ruleItemsOf(GROUP)
    expect(saved).toHaveLength(2)
    expect(rulesChangeCount(GROUP, saved)).toBe(0)
    const body = rulesBodyOf(GROUP, saved)
    expect(body.version).toBe(GROUP.version)
    expect(body.rules[0]).toMatchObject({ id: GROUP.rules[0]!.id, kind: 'EXCLUDES', severity: 'BLOCK', status: 'ACTIVE', when: { combinator: 'and', rows: [{ field: 'option', operator: 'eq', value: VALUES[2]!.id }] } })
    expect(body.rules[1]!.when.rows[0]!.value).toBe('*')
    const fresh = newRuleItem('n1', GROUP.id)
    const groupOf = (valueId: string) => (VALUES.some((value) => value.id === valueId) ? GROUP.id : 'OTHER')
    expect(ruleProblems([...saved, fresh], GROUP.id, groupOf)).toEqual([{ index: 2, key: 'rules.problem.subject' }])
    const twice = { ...saved[0]!, key: 'n2', id: null }
    expect(ruleProblems([...saved, twice], GROUP.id, groupOf)).toEqual([{ index: 2, key: 'rules.problem.twice', params: { other: 1 } }])
    const anyOwn = { ...saved[1]!, otherValueId: VALUES[0]!.id }
    expect(ruleProblems([anyOwn], GROUP.id, groupOf)).toEqual([{ index: 0, key: 'rules.problem.anyOwn' }])
    expect(rulesChangeCount(GROUP, [saved[0]!, { ...saved[1]!, active: false }])).toBe(1)
    expect(rulesChangeCount(GROUP, [saved[0]!])).toBe(1)
    // A saved message cleared is sent as null; a new rule without one sends none.
    expect(rulesBodyOf(GROUP, [{ ...saved[0]!, messageIt: '', messageEn: '' }]).rules[0]!.message).toBeNull()
    expect('message' in rulesBodyOf(GROUP, [saved[1]!]).rules[0]!).toBe(false)
  })

  it('effects: each kind fills its fields, decimals as the API takes them, per size, only what changed', () => {
    expect(effectDraftProblems(effectDraftOf('V1', 'BOM_ADD')).map((problem) => problem.key)).toEqual(['effect.problem.item', 'effect.problem.uom', 'effect.problem.qtyNeeded'])
    expect(effectDraftProblems({ ...effectDraftOf('V1', 'MINUTES'), minutes: '0' }).map((problem) => problem.key)).toEqual(['effect.problem.minutesNotZero'])
    expect(effectDraftProblems(effectDraftOf('V1', 'CERTIFICATE')).map((problem) => problem.key)).toEqual(['effect.problem.certificate'])
    const mesh = { id: 'I1', code: 'M', name: 'Mesh' }
    expect(effectBodyOf({ ...effectDraftOf('V1', 'BOM_ADD'), item: mesh, qty: '0,25', uom: 'M2', section: 'LINING', minutes: '5' }, 4)).toEqual({ version: 4, kind: 'BOM_ADD', itemId: 'I1', qty: '0.25', uom: 'M2', section: 'LINING' })
    const added = EFFECTS[3]!
    expect(effectPatchOf(added, effectDraftFrom(added), 3)).toBeNull()
    expect(effectPatchOf(added, { ...effectDraftFrom(added), qty: '0,3', note: 'Solo sul dorso' }, 3)).toEqual({ version: 3, qty: '0.3', note: 'Solo sul dorso' })
    expect(withSizeQuantity({ '48': '0.2' }, '50', '0.22')).toEqual({ '48': '0.2', '50': '0.22' })
    expect(withSizeQuantity({ '48': '0.2' }, '48', null)).toBeNull()
    expect(effectsInOrder(GROUP).map((effect) => effect.kind)).toEqual(['OPERATION_ADD', 'BOM_ADD', 'BOM_REMOVE', 'OPERATION_ADD', 'CERTIFICATE'])
  })

  it("styles: a style's own picks against the group, in words", () => {
    expect(offerPicksProblemKey('SINGLE', { minPicks: 0, maxPicks: 1 }, null, 2)).toBe('styles.problem.single')
    expect(offerPicksProblemKey('MULTI', { minPicks: 0, maxPicks: 2 }, 3, null)).toBe('styles.problem.contradicts')
    expect(offerPicksProblemKey('MULTI', { minPicks: 0, maxPicks: null }, 1, 3)).toBeNull()
    expect(tabOf('rules')).toBe('rules')
    expect(tabOf('nope')).toBe('options')
  })

  it('every kind, effect and section has words in both languages', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['products-options']!
      for (const kind of OPTION_GROUP_KINDS) expect(words[`kind.${kind}`], `${locale} kind.${kind}`).toBeTruthy()
      for (const kind of OPTION_EFFECT_KINDS) expect(words[`effectKind.${kind}`], `${locale} effectKind.${kind}`).toBeTruthy()
    }
  })

  it('the pages are built and in the navigation of the roles that read styles; an OptionGroup opens its record', () => {
    expect(OFFICE_PAGES.has('/products/options')).toBe(true)
    expect(recordAddress({ type: 'OptionGroup', id: 'g1' }, OFFICE_PAGES)).toBe('/products/options/g1')
    expect(listAddress('/product/option-groups', { outside: '1' }, OFFICE_PAGES)).toBe('/products/options?outside=1')
    const rows = (permissions: readonly string[]) => officeNavFor(permissionCheck([...permissions])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
    expect(rows(ROLE_PERMISSIONS.developer)).toContain('/products/options')
    expect(rows(['home.view'])).not.toContain('/products/options')
  })

  it('the design cases are made-up and cover every state the design names', () => {
    const list = listScreen.cases.map((entry) => entry.id)
    for (const id of ['owner', 'loading', 'error', 'empty', 'no-match', 'no-permission', 'offline', 'new', 'tile-outside', 'notices-open', 'style-link']) expect(list).toContain(id)
    const record = recordScreen.cases.map((entry) => entry.id)
    for (const id of ['options', 'rules', 'rules-dirty', 'effects', 'styles', 'add-styles', 'archived', 'offline', 'loading', 'not-found', 'error', 'no-permission']) expect(record).toContain(id)
    expect(JSON.stringify([listScreen.cases, recordScreen.cases])).not.toMatch(/@(?!example)[a-z]+\.[a-z]/)
  })
})

const LEFT_KEY = /\b(?:page|keys|kind|kindHint|view|col|list|filter|tile|notice|bulk|held|archive|restore|empty|forbidden|offline|style|revisionStatus|styleStatus|group|form|record|tab|refused|options|value|price|certificate|rules|effectKind|effectHint|section|effects|effect|styles|common|problem|status|dialog|uom)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/\b(?:product|products|files|example)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
