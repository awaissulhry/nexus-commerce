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
import { FIT_ROWS, FRAME_KEYS, gridLayout, isListKey, listKeys, nextRowIndex, ownsKeys, rangeIds, sameIds, selectAllState, toggleAll, toggleId } from './model'

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

describe('the grid takes its rows\' height up to one page (no dead space under a short list)', () => {
  it('fits 1 to 50 rows, keeps AG\'s minimum with none, scrolls inside with more', () => {
    expect(FIT_ROWS).toBe(50)
    expect(gridLayout(0)).toEqual({ domLayout: 'autoHeight', fit: false })
    expect(gridLayout(2)).toEqual({ domLayout: 'autoHeight', fit: true })
    expect(gridLayout(50)).toEqual({ domLayout: 'autoHeight', fit: true })
    expect(gridLayout(51)).toEqual({ domLayout: 'normal', fit: false })
  })

  it('the lab shows a short list and a long one', () => {
    const ids = designScreen.cases.map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining(['short', 'long']))
  })
})

// ── B-TH-241 (threads plan TH-4, SHEET-G04, SHEET-G08; wall W17): custom columns and group rows ─────────────────────────────
import { readFileSync } from 'node:fs'
import { cellWords, CUSTOM_BATCH, fieldOnRow, idsToRead, isCustomColumnId, shownCustomIds, withCustomColumns } from './custom/model'
import { groupedRows, initiallyCollapsed, isGroupMarker, markerId, toggleGroup, type GroupMarker } from './groups/model'
import type { ListField } from './tools/transport'

const FIELD = (over: Partial<ListField> = {}): ListField => ({ code: 'heat', columnId: 'cf:heat', type: 'TEXT', labelIt: 'Colata', labelEn: 'Heat number', unit: null, companyId: null, partyId: null, options: [], ...over })
const ALPHA = '0190f0e2-aaaa-7000-8000-000000000001'
const BETA = '0190f0e2-bbbb-7000-8000-000000000002'

describe('custom columns (B-TH-241)', () => {
  it('a custom column is known by the API\'s column id (cf:<code>, cf:<grain>:<code>)', () => {
    expect(isCustomColumnId('cf:heat')).toBe(true)
    expect(isCustomColumnId('cf:price:target')).toBe(true)
    expect(isCustomColumnId('number')).toBe(false)
  })

  it('W17: a field for one customer shows its value only on that customer\'s rows; a field for every customer on all', () => {
    expect(fieldOnRow(FIELD({ partyId: ALPHA }), ALPHA)).toBe(true)
    expect(fieldOnRow(FIELD({ partyId: ALPHA }), BETA)).toBe(false)
    expect(fieldOnRow(FIELD({ partyId: ALPHA }), null)).toBe(false)
    expect(fieldOnRow(FIELD(), BETA)).toBe(true)
    // Without the row's customer, the API's answer stands (it sends a customer's values on its records only).
    expect(fieldOnRow(FIELD({ partyId: ALPHA }), undefined)).toBe(true)
  })

  it('a value in words: a select\'s label, a number with its unit, yes / no said by the frame, nothing as nothing', () => {
    const select = FIELD({ type: 'SELECT', options: [{ code: 'RUSH', labelIt: 'Urgente', labelEn: 'Rush', active: true }] })
    expect(cellWords(select, { value: 'RUSH', wordsIt: null, wordsEn: null }, 'en').text).toBe('Rush')
    expect(cellWords(select, { value: 'RUSH', wordsIt: null, wordsEn: null }, 'it').text).toBe('Urgente')
    expect(cellWords(FIELD({ type: 'NUMBER', unit: 'mm' }), { value: 12, wordsIt: null, wordsEn: null }, 'en').text).toBe('12 mm')
    expect(cellWords(FIELD({ type: 'YES_NO' }), { value: true, wordsIt: null, wordsEn: null }, 'en')).toEqual({ text: null, yesNo: 'yes' })
    expect(cellWords(FIELD(), undefined, 'en').text).toBeNull()
    expect(cellWords(FIELD({ type: 'LINK' }), { value: 'x', wordsIt: null, wordsEn: null }, 'en').text).toBeNull()
  })

  it('the values are read for the loaded rows not yet read, 200 ids a read', () => {
    const ids = Array.from({ length: 450 }, (_, index) => `r${index}`)
    const chunks = idsToRead(ids, new Set(['r0']), new Set(['r1']))
    expect(CUSTOM_BATCH).toBe(200)
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 48])
    expect(chunks.flat()).not.toContain('r0')
    expect(chunks.flat()).not.toContain('r1')
    expect(idsToRead(['a', 'a'], new Set(), new Set())).toEqual([['a']])
  })

  it('custom columns go before the trailing ⋯ (it stays last); only shown ones count as wanted', () => {
    const own = [{ colId: 'number' }, { colId: 'more', pinned: 'right' as const }]
    const custom = [{ colId: 'cf:heat', hide: true }]
    expect(withCustomColumns(own, custom).map((column) => column.colId)).toEqual(['number', 'cf:heat', 'more'])
    expect(withCustomColumns([{ colId: 'a' }], custom).map((column) => column.colId)).toEqual(['a', 'cf:heat'])
    expect(withCustomColumns(own, []).map((column) => column.colId)).toEqual(['number', 'more'])
    expect(shownCustomIds([{ colId: 'cf:heat', hide: true }, { colId: 'cf:lot', hide: false }, { colId: 'number' }])).toEqual(['cf:lot'])
  })
})

describe('group rows (B-TH-241)', () => {
  type Row = { id: string; party: string }
  const rows: Row[] = [
    { id: '1', party: 'A' },
    { id: '2', party: 'B' },
    { id: '3', party: 'A' },
    { id: '4', party: 'Z' },
  ]
  const group = (key: string, over: Record<string, unknown> = {}) => ({ key, name: key, label: key, summary: null, ...over })
  const shape = (out: Array<Row | GroupMarker>) => out.map((entry) => (isGroupMarker(entry) ? `${entry.fwGroup}:${entry.key}` : entry.id))

  it('a header per group, its rows under it in the list\'s order, its more / reading line; a row of no group last', () => {
    const out = groupedRows(rows, { keyOf: (row) => row.party, groups: [group('A', { more: { label: 'Show more of A', onMore: () => undefined } }), group('B', { state: { kind: 'reading' } }), group('C')], collapsed: [] })
    expect(shape(out)).toEqual(['header:A', '1', '3', 'more:A', 'header:B', '2', 'state:B', 'header:C', '4'])
  })

  it('a folded group shows its header only; groups fold all when there are more than ten', () => {
    const out = groupedRows(rows, { keyOf: (row) => row.party, groups: [group('A'), group('B')], collapsed: ['A'] })
    expect(shape(out)).toEqual(['header:A', 'header:B', '2', '4'])
    expect(initiallyCollapsed(['a', 'b'])).toEqual([])
    const eleven = Array.from({ length: 11 }, (_, index) => `g${index}`)
    expect(initiallyCollapsed(eleven)).toEqual(eleven)
    expect(toggleGroup(['a'], 'a')).toEqual([])
    expect(toggleGroup([], 'a')).toEqual(['a'])
  })

  it('a group\'s line has an id of its own, never one of the list\'s rows', () => {
    expect(markerId({ fwGroup: 'header', key: 'A' })).toBe('fw-group:header:A')
    expect(isGroupMarker({ id: '1' })).toBe(false)
    expect(isGroupMarker({ fwGroup: 'more', key: 'A' })).toBe(true)
  })

  it('the totals are never the frame\'s: a header\'s figures are what the list gives (the server\'s), not a count of loaded rows', () => {
    const source = readFileSync(new URL('./groups/model.ts', import.meta.url), 'utf8') + readFileSync(new URL('./groups/GroupLine.tsx', import.meta.url), 'utf8')
    // The group parts read no row's value and sum nothing: no reduce, no length of a group's rows drawn as its count.
    expect(source).not.toMatch(/\.reduce\(/)
    expect(source).not.toMatch(/rows\.length/)
  })

  it('groups draw only when a list asks: the lab\'s plain cases have no group line, the grouped case has its total', () => {
    for (const locale of LOCALES) {
      const View = designScreen.view as ComponentType<{ model: unknown }>
      const plain = designScreen.cases.find((item) => item.id === 'none-selected')!
      const grouped = designScreen.cases.find((item) => item.id === 'th4-grouped')!
      const render = (model: unknown) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
      expect(render(plain.model)).not.toContain('fw-list-total')
      expect(render(grouped.model)).toContain('fw-list-total')
    }
  })
})
// ── end B-TH-241 ──
