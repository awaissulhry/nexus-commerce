import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { TASK_STATUSES, TASK_TILES } from '../../../record-panels/tasks/model'
import { designScreen } from './fixtures'
import { actionHeld, bulkRows, pageKey, reassignChanges, scopeOf, selectHeld, TASK_SCOPES, tasksAddress, tasksKeys, tileOf, tileValue, updatesBetween } from './model'

/** Home › My tasks (SCR-233): the page's rules, its words in it and en, and every design case drawn with no key on screen. */

const HERE = fileURLToPath(new URL('.', import.meta.url))

describe('My tasks’ rules', () => {
  it('the address: whose (Mine unless Created by me), the tile, the search, the open task, New task', () => {
    expect(scopeOf(null)).toBe('MINE')
    expect(scopeOf('CREATED')).toBe('CREATED')
    expect(scopeOf('TEAM')).toBe('MINE')
    expect(tileOf('DONE_7D')).toBe('DONE_7D')
    expect(tileOf('LATER')).toBeNull()
    expect(tasksAddress({ scope: 'MINE', tile: null, q: '', open: null })).toBe('')
    expect(tasksAddress({ scope: 'CREATED', tile: 'OVERDUE', q: ' lot ', open: 't1', newTask: true })).toBe('?scope=CREATED&tile=OVERDUE&q=lot&open=t1&new=1')
  })

  it('a bulk action changes only open tasks the person may change; each held row says why', () => {
    const rows = [
      { id: 'a', canChange: true, status: 'OPEN' as const },
      { id: 'b', canChange: false, status: 'OPEN' as const },
      { id: 'c', canChange: true, status: 'DONE' as const },
    ]
    expect(bulkRows(rows, ['a', 'b', 'c']).map((row) => row.id)).toEqual(['a'])
    expect(selectHeld(rows[1]!)).toBe('held.rowReadOnly')
    expect(selectHeld(rows[2]!)).toBe('held.rowClosed')
    expect(actionHeld({ canManage: false, live: 'live', busy: false })).toBe('held.noManage')
    expect(actionHeld({ canManage: true, live: 'offline', busy: false })).toBe('held.offline')
    expect(actionHeld({ canManage: true, live: 'live', busy: true })).toBe('held.busy')
    expect(actionHeld({ canManage: true, live: 'connecting', busy: false })).toBeNull()
  })

  it('Reassign lists each task with whose it is now and whose it becomes', () => {
    const rows = [
      { id: 'a', title: 'A', assignee: { id: 'p1', name: 'Bea', me: false } },
      { id: 'b', title: 'B', assignee: null },
    ]
    expect(reassignChanges(rows, { id: 'p1', name: 'Bea' }, 'Nobody')).toEqual([
      { id: 'a', title: 'A', from: 'Bea', to: 'Bea', same: true },
      { id: 'b', title: 'B', from: 'Nobody', to: 'Bea', same: false },
    ])
  })

  it('live: a fresh read waits behind "N updates" when rows are new, changed or gone', () => {
    expect(updatesBetween([{ id: 'a', version: 1 }], [{ id: 'a', version: 1 }])).toBe(0)
    expect(updatesBetween([{ id: 'a', version: 1 }, { id: 'b', version: 1 }], [{ id: 'a', version: 2 }, { id: 'c', version: 1 }])).toBe(3)
    expect(tileValue(3, true)).toEqual({ key: 'tile.count', count: 3 })
    expect(tileValue(500, false)).toEqual({ key: 'tile.atLeast', count: 500 })
    expect(pageKey('c')).toBe('new')
    expect(pageKey('e')).toBe('done')
    expect(pageKey('x')).toBeNull()
  })

  it('its keys live in the list footer’s info icon: c new, e done (the frame adds the rest)', () => {
    const en = createTranslator('en', CATALOGUE.en['home-tasks']!)
    expect(tasksKeys(en)).toEqual([
      { keys: ['c'], does: 'New task' },
      { keys: ['e'], does: 'Mark the task done (in the list or its popup)' },
    ])
  })
})

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
}
const PREFIXES = ['refused', 'band', 'live', 'tile', 'scope', 'table', 'col', 'row', 'status', 'bulk', 'held', 'more', 'empty', 'error', 'keys', 'popup', 'reassign', 'due', 'notice']
const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale]['home-tasks'] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('every string of My tasks exists in it and en', () => {
  it('the same keys and placeholders in both languages, no empty text', () => {
    const en = CATALOGUE.en['home-tasks'] ?? {}
    const itc = CATALOGUE.it['home-tasks'] ?? {}
    expect(Object.keys(en).length).toBeGreaterThan(100)
    expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
      expect(placeholdersOf(itc[key] ?? ''), key).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })

  it('every key the page names exists (literally or built from the API’s codes)', () => {
    const pattern = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
    const keys = new Set<string>()
    for (const file of sources(HERE)) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
    for (const tile of TASK_TILES) keys.add(`tile.${tile}.label`).add(`tile.${tile}.hint`)
    for (const status of TASK_STATUSES) keys.add(`status.${status}`)
    for (const scope of TASK_SCOPES) keys.add(`scope.${scope}`)
    for (const state of ['connecting', 'live', 'offline']) keys.add(`live.${state}`)
    expect(keys.size).toBeGreaterThan(80)
    expect([...keys].filter((key) => !has(key))).toEqual([])
  })
})

const LEFT_KEY = /\b(?:refused|band|live|tile|scope|table|col|row|status|bulk|held|more|empty|error|keys|popup|reassign|due|notice|tasks|followers)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*/

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (model: unknown, locale: (typeof LOCALES)[number]) =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model })))
  for (const locale of LOCALES) {
    it(`SCR-233 in ${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of (designScreen as DesignScreen<unknown>).cases) {
        const html = render(item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-233/${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('the states the design names, made-up data only, no amount and no address', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const wanted of ['mine', 'tile-overdue', 'done-7d', 'created', 'selected', 'popup', 'new-task', 'reassign', 'set-due', 'done-undo', 'updates', 'read-only', 'offline', 'empty', 'loading', 'error', 'no-permission']) expect(ids).toContain(wanted)
    const text = JSON.stringify(designScreen.cases)
    expect(text).not.toMatch(/@[a-z0-9-]+\.(com|it|net)/i)
    expect(text).not.toMatch(/€|EUR/)
  })

  it('no key hint above the list: the footer holds the keys icon; My team’s is drawn and held with its reason', () => {
    const html = render(designScreen.cases.find((entry) => entry.id === 'mine')!.model, 'en')
    expect(html.slice(0, html.indexOf('fw-list'))).not.toMatch(/<kbd/i)
    expect(html).toContain('My team&#x27;s')
    expect(html).toContain('Keyboard keys of this list')
  })

  it('a read-only person sees why New task is held', () => {
    const html = render(designScreen.cases.find((entry) => entry.id === 'read-only')!.model, 'en')
    expect(html).toContain('Your roles do not let you make or change tasks.')
  })
})
