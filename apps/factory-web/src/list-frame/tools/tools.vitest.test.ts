import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ColDef } from '@nexus/ui/grid'
import { ApiError } from '../../lib/api/errors'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { toolsProblemOf } from '../../areas/_shared/list-tools/api'
import { designScreen } from '../../areas/_shared/list-tools/fixtures'
import { memoryStore, memoryTransport } from '../../areas/_shared/list-tools/memory'
import { columnsMenuItems, exportMenuItems, sharingWords } from './ListToolsBar'
import { applyLayout, exportColumnsOf, failureKey, layoutOfPreferences, preferencesOf, recentJobs, screenState, showsView, sizeText, toolColumnsOf } from './model'
import type { ExportJob, SavedView, ViewsAnswer } from './transport'

/**
 * The list tools (B-W2a-23; PLT-163, PLT-179): the layout rules every list frame applies, the menus' items in both
 * languages, the in-memory tools the gallery runs on, the API's errors in the tools' words, and SCR-232's cases drawn
 * with no key left on screen.
 */

type Row = { id: string }
const COLUMNS: ColDef<Row>[] = [
  { colId: 'number', headerName: 'Number', pinned: 'left' },
  { colId: 'customer', headerName: 'Customer' },
  { field: 'status' as never, headerName: 'Status' },
  { colId: 'net', headerName: 'Net' },
  { headerName: 'No id' },
  { colId: 'more', headerName: '', pinned: 'right' },
]

describe('the layout on screen (model)', () => {
  it('knows the columns with an id; the first always shown, a trailing ⋯ fixed', () => {
    expect(toolColumnsOf(COLUMNS as ColDef<unknown>[]).map((column) => [column.id, column.label, column.fixed])).toEqual([
      ['number', 'Number', 'first'],
      ['customer', 'Customer', null],
      ['status', 'Status', null],
      ['net', 'Net', null],
      ['more', 'more', 'end'],
    ])
  })

  it('applies an order, hidden columns and frozen ones; the row name and ⋯ are never hidden; unknown ids are ignored', () => {
    const shown = applyLayout(COLUMNS, { order: ['customer', 'gone', 'number'], hidden: ['net', 'number', 'more'], pinned: ['customer'] })
    expect(shown.map((column) => column.colId ?? column.field ?? column.headerName)).toEqual(['customer', 'number', 'status', 'net', 'No id', 'more'])
    expect(shown.find((column) => column.colId === 'net')?.hide).toBe(true)
    expect(shown.find((column) => column.colId === 'number')?.hide).toBeUndefined()
    expect(shown.find((column) => column.colId === 'customer')?.pinned).toBe('left')
    // The list's own left pin gives way to the layout's.
    expect(shown.find((column) => column.colId === 'number')?.pinned).toBeNull()
    expect(shown.find((column) => column.colId === 'more')?.pinned).toBe('right')
    expect(applyLayout(COLUMNS, undefined)).toEqual(COLUMNS)
  })

  it('the Customise dialog’s value both ways; only what differs from the list as built is kept', () => {
    const tools = toolColumnsOf(COLUMNS as ColDef<unknown>[])
    const value = preferencesOf(tools, { order: [], hidden: ['net'], pinned: [] })
    expect(value.visibleColumns).toEqual(['number', 'customer', 'status', 'more'])
    expect(layoutOfPreferences(tools, value)).toEqual({ order: [], hidden: ['net'], pinned: [] })
    expect(layoutOfPreferences(tools, preferencesOf(tools, undefined))).toBeUndefined()
    const moved = { ...value, visibleColumns: ['customer', 'number', 'status', 'more'], columnOrder: ['customer', 'number', 'status', 'net', 'more'], lockedColumns: ['customer'] }
    expect(layoutOfPreferences(tools, moved)).toEqual({ order: ['customer', 'number', 'status', 'net'], hidden: ['net'], pinned: ['customer'] })
  })

  it('an export writes the visible columns as the screen names them, never ⋯', () => {
    const shown = applyLayout(COLUMNS, { order: [], hidden: ['customer'], pinned: [] })
    expect(exportColumnsOf(shown as ColDef<unknown>[])).toEqual([
      { key: 'number', label: 'Number' },
      { key: 'status', label: 'Status' },
      { key: 'net', label: 'Net' },
    ])
  })

  it('a view keeps the screen’s terms and layout; Update only when the screen differs', () => {
    const view = { state: { query: 'late=true', density: 'compact' as const } } as SavedView
    expect(showsView(view, 'late=true', { density: 'compact' })).toBe(true)
    expect(showsView(view, 'late=true&q=x', { density: 'compact' })).toBe(false)
    expect(showsView(view, 'late=true', {})).toBe(false)
    expect(screenState('open=1&late=true', {})).toEqual({ query: 'late=true' })
  })

  it('a failed job in the screen’s words; sizes; the running jobs first', () => {
    expect(failureKey('This view has more than 50,000 rows: narrow it.')).toBe('tools.job.why.tooMany')
    expect(failureKey('Your rights changed since you asked: export the list again.')).toBe('tools.job.why.rightsChanged')
    expect(failureKey('You no longer have the right to see or export this list: nothing was exported.')).toBe('tools.job.why.noRight')
    expect(failureKey('The file would be larger than 25 MB')).toBe('tools.job.why.tooLarge')
    expect(failureKey('The export stopped half way: export the list again.')).toBe('tools.job.why.stopped')
    expect(failureKey(null)).toBe('tools.job.why.other')
    expect(sizeText(512, 'en')).toBe('512 B')
    expect(sizeText(106_640, 'it')).toBe('104 KB')
    expect(sizeText(2_516_582, 'en')).toBe('2.4 MB')
    const jobs = [{ id: 'a', status: 'DONE', createdAt: '2026-10-30T10:00:00Z' }, { id: 'b', status: 'RUNNING', createdAt: '2026-10-29T10:00:00Z' }, { id: 'c', status: 'FAILED', createdAt: '2026-10-30T11:00:00Z' }] as ExportJob[]
    expect(recentJobs(jobs, 2).map((job) => job.id)).toEqual(['b', 'c'])
  })
})

// ---- the menus' words --------------------------------------------------------------------------------------------------

const translators = LOCALES.map((locale) => [locale, createTranslator(locale, CATALOGUE[locale].lists ?? {})] as const)
const KEY = /\btools\.[a-zA-Z_.]+/
const view = (over: Partial<SavedView>): SavedView => ({ id: 'v', listKey: 'sales.orders', name: 'Late', ownerId: 'me', ownerName: 'Demo Owner', mine: true, audience: 'ONLY_ME', roleId: null, roleName: null, roleDefault: false, state: { query: '' }, changeHeld: null, version: 1, ...over })
const ANSWER: ViewsAnswer = {
  views: [view({ id: 'mine' }), view({ id: 'shared', mine: false, ownerName: 'Demo Bianchi', audience: 'ROLE', roleId: 'r', roleName: 'Demo sales', roleDefault: true, changeHeld: 'no' })],
  roleDefaultId: 'shared',
  roles: [{ id: 'r', name: 'Demo sales' }],
  allRoles: [],
  can: { save: true, manage: false, export: true },
  exports: { formats: ['CSV', 'XLSX'] },
}
const noop = () => undefined
const ACT = { apply: noop, reload: noop, save: noop, update: noop, edit: noop, copy: noop, remove: noop, customise: noop }
const words = (items: { label?: unknown; description?: unknown }[]) => items.flatMap((item) => [item.label, item.description]).filter((text): text is string => typeof text === 'string')

describe('Columns ▾ and Export ▾ (items in both languages, no key on screen)', () => {
  it('lists my views, then the shared ones with who shared them; the active view’s verbs; Customise last', () => {
    for (const [locale, t] of translators) {
      const items = columnsMenuItems(t, { answer: ANSWER, problem: null, active: ANSWER.views[0]!, changed: true, asBuilt: false }, ACT)
      expect(items.map((item) => item.id)).toEqual(['h-views', 'built', 'v-mine', 'h-shared', 'v-shared', 's-views', 'save', 'update', 'edit', 'link', 'remove', 's-customise', 'customise'])
      expect(items.find((item) => item.id === 'v-mine')?.checked).toBe(true)
      for (const text of words(items)) expect(text, locale).not.toMatch(KEY)
      expect(sharingWords(t, ANSWER.views[1]!)).toContain('Demo Bianchi')
    }
  })

  it('a shared view: Copy link only, its edit held with the reason; a reader without views.save: Save held', () => {
    const [, t] = translators[0]!
    const shared = columnsMenuItems(t, { answer: ANSWER, problem: null, active: ANSWER.views[1]!, changed: false, asBuilt: false }, ACT)
    expect(shared.filter((item) => ['update', 'remove'].includes(item.id))).toEqual([])
    expect(shared.find((item) => item.id === 'edit')).toMatchObject({ disabled: true, description: expect.any(String) })
    const reader = columnsMenuItems(t, { answer: { ...ANSWER, can: { save: false, manage: false, export: false } }, problem: null, active: null, changed: false, asBuilt: true }, ACT)
    expect(reader.find((item) => item.id === 'save')).toMatchObject({ disabled: true, description: expect.any(String) })
    expect(reader.find((item) => item.id === 'built')?.checked).toBe(true)
  })

  it('while the views are read, and when they could not be', () => {
    for (const [locale, t] of translators) {
      const loading = columnsMenuItems(t, { answer: null, problem: null, active: null, changed: false, asBuilt: true }, ACT)
      expect(loading.map((item) => item.id)).toContain('loading')
      const failed = columnsMenuItems(t, { answer: null, problem: 'offline', active: null, changed: false, asBuilt: true }, ACT)
      expect(failed.map((item) => item.id)).toContain('retry')
      for (const text of [...words(loading), ...words(failed)]) expect(text, locale).not.toMatch(KEY)
    }
  })

  it('Export ▾: the formats, then my recent exports with their state', () => {
    const jobs = [
      { id: 'a', status: 'DONE', format: 'CSV', rowCount: 1240, rowsDone: 1240, createdAt: '2026-10-30T09:00:00Z' },
      { id: 'b', status: 'RUNNING', format: 'XLSX', rowCount: null, rowsDone: 300, createdAt: '2026-10-30T09:10:00Z' },
      { id: 'c', status: 'EXPIRED', format: 'XLSX_REIMPORT', rowCount: 4, rowsDone: 4, createdAt: '2026-10-20T09:10:00Z' },
    ] as ExportJob[]
    for (const [locale, t] of translators) {
      const items = exportMenuItems(t, ['CSV', 'XLSX', 'XLSX_REIMPORT'], jobs, () => '10:42', { start: noop, open: noop })
      expect(items.map((item) => item.id)).toEqual(['f-CSV', 'f-XLSX', 'f-XLSX_REIMPORT', 's-recent', 'h-recent', 'j-b', 'j-a', 'j-c'])
      for (const text of words(items)) expect(text, locale).not.toMatch(KEY)
    }
  })

  it('every literal key of the tools exists in it and en', () => {
    const files = ['ListToolsBar.tsx', 'dialogs.tsx', '../ListFrame.tsx', '../../areas/_shared/list-tools/view/ListToolsView.tsx'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
    const keys = new Set(files.flatMap((text) => [...text.matchAll(/t\('(tools\.[a-zA-Z_.]+)'/g)].map((match) => match[1]!)))
    expect(keys.size).toBeGreaterThan(60)
    const dynamic = ['problem', 'density', 'format', 'exportAs', 'status', 'job.why', 'demo.status', 'demo.rows']
    for (const locale of LOCALES) {
      const catalogue = CATALOGUE[locale].lists ?? {}
      const has = (key: string) => key in catalogue || (`${key}_one` in catalogue && `${key}_other` in catalogue)
      expect([...keys].filter((key) => !has(key)), locale).toEqual([])
      for (const prefix of dynamic) expect(Object.keys(catalogue).some((key) => key.startsWith(`tools.${prefix}.`)), `${locale} tools.${prefix}`).toBe(true)
      for (const problem of ['nameTaken', 'tooMany', 'busy', 'stale', 'forbidden', 'notFound', 'invalid', 'sharing', 'offline', 'failed']) expect(has(`tools.problem.${problem}`), problem).toBe(true)
      for (const why of ['rightsChanged', 'noRight', 'tooMany', 'tooLarge', 'stopped', 'other']) expect(has(`tools.job.why.${why}`), why).toBe(true)
    }
  })
})

describe('the API’s errors in the tools’ words', () => {
  const error = (kind: ConstructorParameters<typeof ApiError>[0], status: number, message: string, issues: { path: string }[] = []) => new ApiError(kind, status, kind, message, null, issues)
  it('a 409 by what it refuses, a 400 on the sharing, the rest by kind', () => {
    expect(toolsProblemOf(error('conflict', 409, 'You already have a view named “X” on this list.'))).toBe('nameTaken')
    expect(toolsProblemOf(error('conflict', 409, 'You keep 50 views of this list already: remove one first.'))).toBe('tooMany')
    expect(toolsProblemOf(error('conflict', 409, 'version'))).toBe('stale')
    expect(toolsProblemOf(error('conflict', 409, 'You have 3 exports running: wait for one to finish.'), 'export')).toBe('busy')
    expect(toolsProblemOf(error('invalid', 400, 'x', [{ path: 'body/roleId' }]))).toBe('sharing')
    expect(toolsProblemOf(error('invalid', 400, 'x', [{ path: 'body/name' }]))).toBe('invalid')
    expect(toolsProblemOf(error('forbidden', 403, 'x'))).toBe('forbidden')
    expect(toolsProblemOf(error('not_found', 404, 'x'))).toBe('notFound')
    expect(toolsProblemOf(error('unavailable', 503, 'x'))).toBe('offline')
    expect(toolsProblemOf(new Error('boom'))).toBe('failed')
  })
})

describe('the tools in memory (the gallery’s)', () => {
  it('saves, updates and removes a view; exports with its progress to a file', async () => {
    const model = { pageKey: 'sales.orders', locale: 'en' as const, answer: { ...ANSWER, views: [] }, jobs: [], exportRows: 900 }
    const store = memoryStore(model)
    let address = ''
    const transport = () => memoryTransport(model, store, address, (next) => (address = next))
    const saved = await transport().createView('sales.orders', { name: 'Late', audience: 'ROLE', roleId: 'r', roleDefault: false, state: { query: 'q=x&late=true&open=1' } }, 'k')
    expect(saved).toMatchObject({ roleName: 'Demo sales', state: { query: 'late=true&q=x' } })
    await expect(transport().createView('sales.orders', { name: 'late', audience: 'ONLY_ME', roleId: null, roleDefault: false, state: { query: '' } }, 'k')).rejects.toMatchObject({ problem: 'nameTaken' })
    const updated = await transport().updateView(saved, { name: 'Late (all)' }, 'k')
    expect(updated).toMatchObject({ name: 'Late (all)', version: 2 })
    await transport().removeView(updated)
    expect((await transport().listViews('sales.orders')).views).toEqual([])
    transport().goTo('late=true')
    expect(address).toBe('late=true')

    const job = await transport().startExport({ listKey: 'sales.orders', format: 'CSV', query: address, columns: [{ key: 'number', label: 'Number' }], title: 'Orders' }, 'k')
    let state = job
    for (let step = 0; step < 6 && state.status !== 'DONE'; step++) state = await transport().readExport(job.id)
    expect(state).toMatchObject({ status: 'DONE', rowCount: 900, file: { name: expect.stringMatching(/\.csv$/) } })
    expect((await transport().listExports('sales.orders')).map((entry) => entry.id)).toEqual([job.id])
  })
})

describe('SCR-232 — every case draws in both languages with no key left on screen', () => {
  it('has the cases the design names (views, customise, save, export job, held, loading, failed)', () => {
    expect(designScreen.screen).toBe('SCR-232')
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const id of ['toolbar', 'columns-menu', 'customise', 'save-view', 'save-view-sales', 'edit-view', 'remove-view', 'export-menu', 'export-running', 'export-done', 'export-failed', 'export-expired', 'read-only', 'no-export', 'views-loading', 'views-failed', 'link-not-shared', 'empty']) {
      expect(ids, id).toContain(id)
    }
  })

  it('renders each case', () => {
    const View = designScreen.view as ComponentType<{ model: unknown }>
    for (const locale of LOCALES) {
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html, `${locale} ${item.id}`).not.toMatch(/\b(tools|lab|keys)\.[a-zA-Z]+\.[a-zA-Z]/)
      }
    }
  })
})
