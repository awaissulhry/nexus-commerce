import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ColDef } from '@nexus/ui/grid'
import { BULK_LIMITS, BULK_REFUSALS, type BulkPreviewRow } from '@nexus/factory-domain/views/bulk/rules'
import { RELATIVE_DAYS } from '@nexus/factory-domain/views/quick/relative'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { DEMO_BULK, designScreen } from '../../areas/_shared/list-tools/fixtures'
import { memoryStore, memoryTransport } from '../../areas/_shared/list-tools/memory'
import { columnsMenuItems } from '../tools/ListToolsBar'
import { failureKey } from '../tools/model'
import {
  activeQuick,
  boardCardOf,
  bulkHeldKey,
  calendarDaysOf,
  calendarMonthOf,
  conflictsOf,
  exportSelectedHeldKey,
  modeOfAddress,
  offeredModes,
  quickValueOf,
  resultsByLine,
  reviewLinesOf,
  toggledQuick,
  typedValue,
  valueProblemKey,
  valueText,
  withMode,
  type ListEditField,
  type ListQuick,
} from './model'
import { quickMenuItems } from './quick'

/**
 * The W2b list frame (B-W2b-13; PLT-164 modes, PLT-165 freeze and density, PLT-166 inline edit, PLT-167 quick filters,
 * PLT-170 phone cards, PLT-182 bulk edit with preview, Z16:01/02): its pure rules, the menus in both languages, the
 * bulk edit through the in-memory tools (preview → save → undo), and SCR-232's W2b cases drawn with no key on screen.
 */

type Row = { id: string; number: string; customer: string; status: string; due: string | null; priority: number; version: number }
const ROWS: Row[] = [
  { id: 'a', number: 'WO-1', customer: 'Demo Alfa', status: 'DRAFT', due: '2026-11-03', priority: 0, version: 1 },
  { id: 'b', number: 'WO-2', customer: 'Demo Beta', status: 'RELEASED', due: '2026-11-03', priority: 1, version: 4 },
  { id: 'c', number: 'WO-3', customer: 'Demo Gamma', status: 'CLOSED', due: null, priority: 2, version: 2 },
]
const COLUMNS: ColDef<Row>[] = [
  { colId: 'number', headerName: 'Number', field: 'number' },
  { colId: 'customer', headerName: 'Customer', field: 'customer' },
  { colId: 'status', headerName: 'Status', field: 'status' },
  { colId: 'due', headerName: 'Due', field: 'due' },
  { colId: 'priority', headerName: 'Priority', field: 'priority' },
  { colId: 'more', headerName: '', pinned: 'right' },
]
const translators = LOCALES.map((locale) => [locale, createTranslator(locale, CATALOGUE[locale].lists ?? {})] as const)
const KEY = /\b(modes|quick|edit|bulk|exportSelected|calendarMode|tools)\.[a-zA-Z-]+/

describe('view modes (PLT-164, Z16:01)', () => {
  it('the mode is the address term, only among the modes offered; the table drops the term', () => {
    const params = (query: string) => new URLSearchParams(query)
    expect(modeOfAddress(params('mode=board'), ['table', 'board'])).toBe('board')
    expect(modeOfAddress(params('mode=calendar'), ['table', 'board'])).toBe('table')
    expect(modeOfAddress(params('mode=nonsense'), ['table', 'board'])).toBe('table')
    expect(modeOfAddress(null, ['table'])).toBe('table')
    expect(withMode('view=late&mode=board', 'table')).toBe('view=late')
    expect(withMode('?view=late', 'calendar')).toBe('view=late&mode=calendar')
    expect(offeredModes(null, true)).toEqual(['table'])
    expect(offeredModes({ board: {}, calendar: {} }, true)).toEqual(['table', 'board', 'calendar', 'cards'])
    expect(offeredModes({ board: {} }, false)).toEqual(['table', 'board'])
  })

  it('a board card from the list’s columns: name, title, three fields; never the ⋯ column', () => {
    expect(boardCardOf(ROWS[1]!, 'b', 'RELEASED', COLUMNS)).toEqual({
      id: 'b',
      laneId: 'RELEASED',
      label: 'WO-2',
      title: 'Demo Beta',
      fields: [
        { label: 'Status', value: 'RELEASED' },
        { label: 'Due', value: '2026-11-03' },
        { label: 'Priority', value: '1' },
      ],
    })
    expect(boardCardOf(ROWS[0]!, 'a', 'DRAFT', COLUMNS, { held: 'Closed' }).held).toBe('Closed')
  })

  it('the calendar counts rows per day, keeps the rows without one, opens on a month with rows', () => {
    const { days, undated } = calendarDaysOf(ROWS, (row) => row.due)
    expect([...days].map(([day, list]) => [day, list.map((row) => row.id)])).toEqual([['2026-11-03', ['a', 'b']]])
    expect(undated.map((row) => row.id)).toEqual(['c'])
    expect(calendarMonthOf(days, '2026-10-31')).toBe('2026-11')
    expect(calendarMonthOf(days, '2026-11-20')).toBe('2026-11')
    expect(calendarMonthOf(new Map(), '2026-10-31')).toBe('2026-10')
  })
})

describe('quick filters (PLT-167)', () => {
  const quick = (values: Record<string, string | null>): ListQuick => ({
    filters: [
      { id: 'owner', kind: 'me', label: 'Mine' },
      { id: 'due', kind: 'date', label: 'Due', choices: ['this-week', 'overdue'] },
      { id: 'late', kind: 'flag', label: 'Late', value: 'true' },
    ],
    values,
    onChange: () => undefined,
  })

  it('takes only the words a filter knows; a press turns it on or off', () => {
    const filters = quick({}).filters
    expect(quickValueOf(filters[0]!, 'me')).toBe('me')
    expect(quickValueOf(filters[0]!, 'u-1')).toBeNull()
    expect(quickValueOf(filters[1]!, 'this-week')).toBe('this-week')
    expect(quickValueOf(filters[1]!, 'today')).toBeNull()
    expect(quickValueOf(filters[2]!, 'true')).toBe('true')
    expect(activeQuick(quick({ owner: 'me', due: 'nonsense', late: 'true' })).map((entry) => entry.filter.id)).toEqual(['owner', 'late'])
    expect(toggledQuick(filters[0]!, null)).toBe('me')
    expect(toggledQuick(filters[0]!, 'me')).toBeNull()
    expect(toggledQuick(filters[1]!, 'this-week', 'overdue')).toBe('overdue')
    expect(toggledQuick(filters[1]!, 'overdue', 'overdue')).toBeNull()
  })

  it('the menu in both languages: each filter, each relative day, Clear when one is on', () => {
    for (const [locale, t] of translators) {
      const items = quickMenuItems(quick({ due: 'overdue' }), t)
      expect(items.map((item) => item.id)).toEqual(['owner', 's-due', 'h-due', 'due:this-week', 'due:overdue', 's-late', 'late', 's-clear', 'clear'])
      expect(items.find((item) => item.id === 'due:overdue')?.checked).toBe(true)
      for (const item of items) if (typeof item.label === 'string') expect(item.label, locale).not.toMatch(KEY)
      for (const day of RELATIVE_DAYS) expect(t(`quick.day.${day}`), `${locale} ${day}`).not.toMatch(KEY)
    }
  })
})

describe('inline edit and bulk edit (PLT-166, PLT-182)', () => {
  const due: ListEditField<Row> = { kind: 'date', nullable: true, valueOf: (row) => row.due, held: (row) => (row.status === 'CLOSED' ? 'Closed' : null) }
  const priority: ListEditField<Row> = { kind: 'integer', min: -1000, max: 1000, valueOf: (row) => row.priority }

  it('reads a typed day as YYYY-MM-DD; says why a value cannot be saved, by key', () => {
    expect(typedValue(due, '5/11/2026')).toBe('2026-11-05')
    expect(typedValue(due, '05.11.2026')).toBe('2026-11-05')
    expect(typedValue(due, '2026-11-05T00:00:00.000Z')).toBe('2026-11-05')
    expect(typedValue(due, '')).toBeNull()
    expect(typedValue(priority, ' 7 ')).toBe(7)
    expect(valueProblemKey(due, '2026-02-30')).toBe('edit.problem.date')
    expect(valueProblemKey(priority, null)).toBe('edit.problem.required')
    expect(valueProblemKey(priority, 'x')).toBe('edit.problem.integer')
    expect(valueProblemKey(priority, 2000)).toBe('edit.problem.max')
    expect(valueProblemKey(priority, -2000)).toBe('edit.problem.min')
    expect(valueProblemKey(due, null)).toBeNull()
    expect(valueText(due, '2026-11-05', () => '05/11/2026', String)).toBe('05/11/2026')
    expect(valueText(due, null, () => '', String)).toBe('—')
    expect(valueText({ kind: 'choice', choiceLabels: { A1: 'Shelf A1' } }, 'A1', () => '', String)).toBe('Shelf A1')
  })

  it('one review line per field that changes; conflicts where the list showed another value; results per line', () => {
    const preview: BulkPreviewRow[] = [
      { id: 'a', label: 'WO-1', version: 1, changes: [{ field: 'due', now: '2026-11-04', next: '2026-11-10' }], refusal: null },
      { id: 'b', label: 'WO-2', version: 4, changes: [], refusal: null },
      { id: 'c', label: 'WO-3', version: 2, changes: [{ field: 'due', now: null, next: '2026-11-10' }], refusal: { code: 'held', status: 'CLOSED' } },
    ]
    const lines = reviewLinesOf(preview)
    expect(lines).toEqual([{ id: 'a::due', rowId: 'a', field: 'due', label: 'WO-1', now: '2026-11-04', next: '2026-11-10' }])
    expect(conflictsOf(preview, new Map(ROWS.map((row) => [row.id, row])), { due, priority })).toEqual([{ rowId: 'a', field: 'due', label: 'WO-1', was: '2026-11-03', now: '2026-11-04' }])
    const results = resultsByLine(lines, [{ id: 'a', label: 'WO-1', ok: true, refusal: null, before: { due: '2026-11-04' }, after: { due: '2026-11-10' }, version: 2 }])
    expect(results.get('a::due')?.ok).toBe(true)
  })

  it('Edit N and Export N are held over the limit', () => {
    expect(bulkHeldKey(BULK_LIMITS.rows, null)).toBeNull()
    expect(bulkHeldKey(BULK_LIMITS.rows + 1, null)).toEqual({ key: 'bulk.heldTooMany', params: { max: BULK_LIMITS.rows } })
    expect(exportSelectedHeldKey(BULK_LIMITS.rows + 1)?.key).toBe('exportSelected.heldTooMany')
    expect(exportSelectedHeldKey(3)).toBeNull()
  })

  it('every refusal code and value problem has words in both languages; a selection export that matched nothing has its own', () => {
    for (const [locale, t] of translators) {
      for (const code of BULK_REFUSALS) expect(t(`edit.refusal.${code}`), `${locale} ${code}`).not.toMatch(KEY)
      for (const problem of ['required', 'date', 'integer', 'min', 'max', 'long', 'choice']) expect(t(`edit.problem.${problem}`, { min: 1, max: 2 }), problem).not.toMatch(KEY)
      expect(t(failureKey('None of the selected rows is in this view any more: export the view instead.'))).not.toMatch(KEY)
    }
    expect(failureKey('None of the selected rows is in this view any more')).toBe('tools.job.why.selected')
  })

  it('the in-memory tools preview, save and undo a bulk edit; a stale version is refused, never overwritten', async () => {
    const model = { pageKey: 'sales.orders', locale: 'en' as const, answer: 'loading' as const, jobs: [], bulk: DEMO_BULK }
    const store = memoryStore(model)
    const transport = memoryTransport(model, store, '', () => undefined)
    const open = DEMO_BULK.filter((row) => row.held.promised === null).slice(0, 2)
    const shipped = DEMO_BULK.find((row) => row.held.promised !== null)!
    const preview = await transport.bulkPreview({ listKey: 'sales.orders', ids: [...open.map((row) => row.id), shipped.id, 'nope'], changes: { priority: 9 } })
    expect(preview.map((row) => row.refusal?.code ?? 'ok')).toEqual(['ok', 'ok', 'held', 'missing'])
    const saved = await transport.bulkApply({ listKey: 'sales.orders', rows: open.map((row) => ({ id: row.id, version: row.version, changes: { priority: 9 } })) }, 'k1')
    expect(saved.every((result) => result.ok && result.version === 2)).toBe(true)
    const stale = await transport.bulkApply({ listKey: 'sales.orders', rows: [{ id: open[0]!.id, version: 1, changes: { priority: 1 } }] }, 'k2')
    expect(stale[0]!.refusal).toEqual({ code: 'stale' })
    const undone = await transport.bulkApply({ listKey: 'sales.orders', rows: saved.map((result) => ({ id: result.id, version: result.version, changes: { priority: result.before.priority ?? null } })), undo: true }, 'k3')
    expect(undone.map((result) => result.after.priority)).toEqual(open.map((row) => row.values.priority))
  })
})

describe('Columns ▾ quick parts (PLT-165): freeze the first column, the density, the columns hidden by rights', () => {
  it('in both languages, with the held reason said', () => {
    const noop = () => undefined
    for (const [locale, t] of translators) {
      const items = columnsMenuItems(
        t,
        { answer: null, problem: null, active: null, changed: false, asBuilt: true },
        { apply: noop, reload: noop, save: noop, update: noop, edit: noop, copy: noop, remove: noop, customise: noop },
        { density: 'compact', onDensity: noop, first: { label: 'Number', frozen: true }, onFreeze: noop, withheld: [{ label: 'Net', reason: 'needs price rights' }] },
      )
      const ids = items.map((item) => item.id)
      expect(ids.slice(-7)).toEqual(['freeze', 'h-density', 'd-compact', 'd-cozy', 'd-spacious', 'h-withheld', 'w-Net'])
      expect(items.find((item) => item.id === 'freeze')?.checked).toBe(true)
      expect(items.find((item) => item.id === 'd-compact')?.checked).toBe(true)
      expect(items.find((item) => item.id === 'w-Net')).toMatchObject({ disabled: true })
      for (const item of items) {
        if (typeof item.label === 'string') expect(item.label, locale).not.toMatch(KEY)
        if (typeof item.description === 'string') expect(item.description, locale).not.toMatch(KEY)
      }
    }
  })
})

describe('the frame’s words', () => {
  it('every literal key of the W2b parts exists in it and en', () => {
    const files = ['../ListFrame.tsx', 'bulk.tsx', 'edit.tsx', 'modes.tsx', 'quick.tsx', 'model.ts', '../tools/ListToolsBar.tsx', '../tools/dialogs.tsx'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
    const keys = new Set(files.flatMap((text) => [...text.matchAll(/['`]((?:modes|quick|edit|bulk|exportSelected|calendarMode|keys)\.[a-zA-Z.-]+)['`]/g)].map((match) => match[1]!)).filter((key) => !key.endsWith('.') && key !== 'edit.onSaved'))
    expect(keys.size).toBeGreaterThan(40)
    for (const locale of LOCALES) {
      const catalogue = CATALOGUE[locale].lists ?? {}
      const has = (key: string) => key in catalogue || (`${key}_one` in catalogue && `${key}_other` in catalogue)
      expect([...keys].filter((key) => !has(key)), locale).toEqual([])
      for (const key of ['tools.freezeFirst', 'tools.withheld', 'tools.withheldItem', 'tools.job.selected', 'tools.job.why.selected']) expect(has(key), `${locale} ${key}`).toBe(true)
    }
  })
})

describe('SCR-232 — the W2b cases draw in both languages with no key left on screen', () => {
  it('has the W2b cases (modes, quick filters, edit, bulk review, held, failed, export of the selection, no price, loading)', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const id of ['w2b-table', 'w2b-board', 'w2b-calendar', 'w2b-cards', 'w2b-quick', 'w2b-quick-none', 'w2b-selected', 'w2b-bulk-form', 'w2b-bulk-held', 'w2b-bulk-review', 'w2b-bulk-failed', 'w2b-bulk-offline', 'w2b-edit-held', 'w2b-export-selected', 'w2b-no-price', 'w2b-loading']) expect(ids, id).toContain(id)
  })

  it('renders each W2b case', () => {
    const View = designScreen.view as ComponentType<{ model: unknown }>
    for (const locale of LOCALES) {
      for (const item of designScreen.cases.filter((entry) => entry.id.startsWith('w2b-'))) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html, `${locale} ${item.id}`).not.toMatch(KEY)
      }
    }
  })
})
