import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../lib/design/design-screen'
import { LOCALES } from '../lib/i18n/locales'
import { CATALOGUE, messagesFor, placeholdersOf } from '../lib/i18n/messages'
import { I18nProvider } from '../lib/i18n/provider'
import { designScreen, LAB_ROWS } from './fixtures'
import { labRowReason } from './lab/ListFrameLab'
import { ListKeysInfo } from './ListKeysInfo'
import { FRAME_KEYS, isListKey, listKeys, nextRowIndex, ownsKeys, rangeIds, sameIds, selectAllState, toggleAll, toggleId } from './model'

/**
 * The list frame (Owner rule 2026-10-29): the selection rules every Office list shares, the keys its footer icon lists,
 * and its lab drawn in both languages with no key on screen.
 */

const ids = ['a', 'b', 'c', 'd', 'e']

describe('selection (header box, one row, a shift range, every loaded row)', () => {
  it('the header box is none, mixed (some) or all of the LOADED rows', () => {
    expect(selectAllState(ids, [])).toBe('none')
    expect(selectAllState(ids, ['b'])).toBe('some')
    expect(selectAllState(ids, ids)).toBe('all')
    // A row selected but not loaded (another page) does not make the loaded ones "all".
    expect(selectAllState(['a', 'b'], ['a', 'z'])).toBe('some')
    expect(selectAllState([], ['a'])).toBe('none')
  })

  it('x / a click toggles one row', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('shift-click gives the range between the last ticked row and this one its new state', () => {
    expect(rangeIds(ids, ['b'], 'b', 'd', true).sort()).toEqual(['b', 'c', 'd'])
    expect(rangeIds(ids, ['b'], 'd', 'b', true).sort()).toEqual(['b', 'c', 'd'])
    expect(rangeIds(ids, ['a', 'b', 'c', 'd'], 'b', 'c', false)).toEqual(['a', 'd'])
    expect(rangeIds(ids, [], null, 'c', true)).toEqual(['c'])
    expect(rangeIds(ids, ['a'], 'a', 'zz', true)).toEqual(['a'])
  })

  it('the header box ticks every loaded row, and clears them when all are ticked; other pages keep theirs', () => {
    expect(toggleAll(['a', 'b'], ['z'])).toEqual(['z', 'a', 'b'])
    expect(toggleAll(['a', 'b'], ['z', 'a', 'b'])).toEqual(['z'])
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameIds(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('keys', () => {
  it('j / k move one row, held at the ends; from no row, the first', () => {
    expect(nextRowIndex(null, 1, 5)).toBe(0)
    expect(nextRowIndex(2, 1, 5)).toBe(3)
    expect(nextRowIndex(4, 1, 5)).toBe(4)
    expect(nextRowIndex(0, -1, 5)).toBe(0)
    expect(nextRowIndex(1, -1, 0)).toBeNull()
  })

  it('never acts while typing, in a menu or a dialog, or with a modifier', () => {
    const key = { key: 'j', metaKey: false, ctrlKey: false, altKey: false }
    expect(isListKey(key, null)).toBe(true)
    expect(isListKey(key, { tagName: 'DIV', closest: () => null })).toBe(true)
    expect(isListKey(key, { tagName: 'INPUT' })).toBe(false)
    expect(isListKey(key, { tagName: 'DIV', isContentEditable: true })).toBe(false)
    expect(isListKey(key, { tagName: 'BUTTON', closest: () => ({}) })).toBe(false)
    expect(isListKey({ ...key, metaKey: true }, null)).toBe(false)
  })

  it("the list's own keys first, then the frame's; a read-only list lists no select keys", () => {
    const keys = listKeys([{ keys: ['c'], does: 'New customer' }])
    expect(keys[0]).toEqual({ keys: ['c'], does: 'New customer' })
    expect(keys.slice(1)).toEqual([...FRAME_KEYS])
    expect(listKeys([], false).map((entry) => entry.does)).not.toContain('keys.select')
    // A list that redefines a frame key keeps its own words.
    expect(listKeys([{ keys: ['/'], does: 'Search customers' }]).filter((entry) => entry.keys.join() === '/')).toEqual([{ keys: ['/'], does: 'Search customers' }])
  })
})

describe('words in it and en; no key left on screen', () => {
  it('lists: the same keys and placeholders in every language', () => {
    const en = CATALOGUE.en.lists ?? {}
    const itc = CATALOGUE.it.lists ?? {}
    expect(Object.keys(en).length).toBeGreaterThan(20)
    expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) expect(placeholdersOf(itc[key] ?? ''), key).toEqual(placeholdersOf(en[key] ?? ''))
    for (const entry of FRAME_KEYS) for (const locale of LOCALES) expect(CATALOGUE[locale].lists?.[entry.does], `${locale} ${entry.does}`).toBeTruthy()
  })

  const LEFT_KEY = /\b(?:keys|lab|selected|updates|clear|selectAll|loading)\.[a-zA-Z]+/
  const render = (node: ReturnType<typeof createElement>, locale: (typeof LOCALES)[number]) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, node))

  it('the keys icon is one button named in words (its panel opens on hover, focus or tap)', () => {
    for (const locale of LOCALES) {
      const html = render(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['lists']) }, createElement(ListKeysInfo, { keys: listKeys() })), locale)
      expect(html).toContain(`aria-label="${CATALOGUE[locale].lists?.['keys.trigger']}"`)
      expect(html.match(LEFT_KEY)).toBeNull()
    }
  })

  for (const locale of LOCALES) {
    it(`the lab's ${designScreen.cases.length} cases draw in ${locale} with no key on screen`, () => {
      const View = designScreen.view as ComponentType<{ model: unknown }>
      for (const item of designScreen.cases) {
        const html = render(createElement(View, { model: item.model }), locale)
        expect(html.length, item.id).toBeGreaterThan(300)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('the lab covers the states the rule names', () => {
    const cases = (designScreen as DesignScreen<unknown>).cases.map((item) => item.id)
    expect(cases).toEqual(expect.arrayContaining(['none-selected', 'some-selected', 'all-selected', 'keys-open', 'read-only', 'loading', 'failed', 'empty']))
    expect(LAB_ROWS.every((row) => /^Demo /.test(row.name))).toBe(true)
  })
})

describe('several frames on one page, rows that may not be selected', () => {
  it('the keys belong to the frame with the focus, else to the page\'s first frame', () => {
    expect(ownsKeys(0, null)).toBe(true)
    expect(ownsKeys(1, null)).toBe(false)
    expect(ownsKeys(1, 1)).toBe(true)
    expect(ownsKeys(0, 1)).toBe(false)
  })

  it('a lab row that may not be selected says why (blocked rows)', () => {
    const blocked = LAB_ROWS.find((row) => row.status === 'BLOCKED')!
    const active = LAB_ROWS.find((row) => row.status === 'ACTIVE')!
    expect(labRowReason(blocked, (key) => key)).toBe('lab.blockedReason')
    expect(labRowReason(active, (key) => key)).toBeNull()
  })
})
