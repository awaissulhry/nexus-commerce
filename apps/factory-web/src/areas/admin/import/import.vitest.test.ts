import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { applyImport, cancelImport, listImports, sheetContentType, uploadSheet, type ImportJob } from './api'
import { bulkHeld } from '../kit/bulk-model'
import { AdminPageMessages } from '../kit/messages'
import { designScreen } from './fixtures'
import type { ImportViewModel } from './model'
import { ImportWizardInline } from './view/ImportWizard'
import { JobCell, rowsWords } from './view/ImportView'
import {
  applicable,
  applyHeld,
  blankDraft,
  cancelReach,
  issueGroups,
  KNOWN_IMPORTERS,
  keyText,
  lastImportOf,
  leftToApply,
  phaseOf,
  refusedRowsHref,
  rowChanges,
  stepOf,
  templateHref,
  uploadProblems,
  WIZARD_STEPS,
} from './model'

/**
 * SCR-017 Import & export: the wizard's step from the job, the held reasons of Apply, the upload checks; the calls in
 * the API's order (announce → bytes to the store → confirm); every word in it and en; every design case drawn in both
 * languages with no key left on screen.
 */

const base = (extra: Partial<ImportJob> = {}): ImportJob => {
  const model = designScreen.cases.find((item) => item.id === 'checked-refused')!.model
  return { ...model.wizard!.job!, ...extra }
}

describe('the wizard follows the job', () => {
  it('derives the phase and the step from the status (a failure before the plan is not one after it)', () => {
    expect(stepOf(null)).toBe('upload')
    expect([phaseOf(base({ status: 'UPLOADED', plannedAt: null })), stepOf(base({ status: 'UPLOADED', plannedAt: null }))]).toEqual(['reading', 'check'])
    expect([phaseOf(base({ status: 'PLANNED' })), stepOf(base({ status: 'PLANNED' }))]).toEqual(['planned', 'check'])
    expect([phaseOf(base({ status: 'FAILED', plannedAt: null })), stepOf(base({ status: 'FAILED', plannedAt: null }))]).toEqual(['planFailed', 'check'])
    expect([phaseOf(base({ status: 'APPLYING' })), stepOf(base({ status: 'APPLYING' }))]).toEqual(['applying', 'apply'])
    expect([phaseOf(base({ status: 'FAILED' })), stepOf(base({ status: 'FAILED' }))]).toEqual(['applyFailed', 'apply'])
    expect([phaseOf(base({ status: 'APPLIED' })), stepOf(base({ status: 'APPLIED' }))]).toEqual(['applied', 'result'])
    expect(stepOf(base({ status: 'CANCELLED', plannedAt: null }))).toBe('check')
    expect(stepOf(base({ status: 'CANCELLED' }))).toBe('apply')
    expect(WIZARD_STEPS).toEqual(['upload', 'check', 'apply', 'result'])
  })

  it('holds Apply with its reason: not checked, no right, nothing to write, busy; never for a ready plan', () => {
    const can = { apply: true }
    expect(applyHeld(base({ status: 'UPLOADED', plannedAt: null }), can)).toBe('imp.held.notPlanned')
    expect(applyHeld(base(), { apply: false })).toBe('imp.held.noApplyRight')
    expect(applyHeld(base({ createCount: 0, updateCount: 0 }), can)).toBe('imp.held.nothing')
    expect(applyHeld(base(), can, true)).toBe('imp.held.busy')
    expect(applyHeld(base(), can)).toBeNull()
    expect(applyHeld(base({ status: 'FAILED' }), can)).toBeNull()
    expect(applyHeld(base({ status: 'APPLIED' }), can)).toBe('imp.held.notPlanned')
  })

  it('counts what an apply writes, and what a stopped apply has left', () => {
    expect(applicable(base({ createCount: 410, updateCount: 180 }))).toBe(590)
    expect(leftToApply(base({ createCount: 410, updateCount: 180, appliedCount: 200, skippedCount: 3 }))).toBe(387)
    expect(leftToApply(base({ createCount: 1, updateCount: 0, appliedCount: 1 }))).toBe(0)
  })

  it('says a money column apart from the other problems of a sheet that could not be checked', () => {
    const groups = issueGroups({ issues: [{ path: 'column/standardCost', message: 'The column "Costo" holds cost values (the cost money grain), which …' }, { path: 'header/name', message: 'No column for "Name".' }] })
    expect(groups.money).toEqual(['standardCost'])
    expect(groups.other).toEqual([{ path: 'header/name', message: 'No column for "Name".' }])
  })

  it('shows a row\'s changes under the sheet\'s own headers; a key as its values', () => {
    const layout = { format: 'csv' as const, sheet: null, sheets: [], encoding: null, delimiter: ';', headers: ['Codice', 'Nome'], columns: [{ index: 0, header: 'Codice', column: 'code' }, { index: 1, header: 'Nome', column: 'name' }], ignored: [] }
    expect(rowChanges({ action: 'UPDATE', before: { name: 'Vecchio' }, after: { name: 'Nuovo' } }, layout)).toEqual([{ column: 'name', header: 'Nome', before: 'Vecchio', after: 'Nuovo' }])
    expect(rowChanges({ action: 'CREATE', before: undefined, after: { code: 'A1', name: null } }, layout)).toEqual([
      { column: 'code', header: 'Codice', before: null, after: 'A1' },
      { column: 'name', header: 'Nome', before: null, after: '—' },
    ])
    expect(keyText('["DN1","A-01"]')).toBe('DN1 · A-01')
    expect(keyText(null)).toBe('—')
  })

  it('the cards show the newest job of an importer', () => {
    const jobs = [base({ id: 'a', createdAt: '2026-10-20T10:00:00.000Z' }), base({ id: 'b', createdAt: '2026-10-29T10:00:00.000Z' }), base({ id: 'c', importerKey: 'parties.parties', createdAt: '2026-10-30T10:00:00.000Z' })]
    expect(lastImportOf(jobs, 'inventory.opening')?.id).toBe('b')
    expect(lastImportOf(jobs, 'product.materials')).toBeNull()
  })
})

describe('cancelling several imports at once', () => {
  const reading = base({ id: 'r', status: 'UPLOADED', plannedAt: null })
  const planned = base({ id: 'p' })
  const applying = base({ id: 'a', status: 'APPLYING' })
  const stopped = base({ id: 's', status: 'FAILED' })
  const unreadable = base({ id: 'u', status: 'FAILED', plannedAt: null })
  const applied = base({ id: 'd', status: 'APPLIED' })
  const cancelled = base({ id: 'c', status: 'CANCELLED' })

  it('applies to jobs nothing was written from yet (being checked, or checked and not applied); the others are left out with the reason', () => {
    const reach = cancelReach([reading, planned, applying, stopped, unreadable, applied, cancelled])
    expect(reach.applies.map((job) => job.id)).toEqual(['r', 'p'])
    expect(reach.left.map((entry) => [entry.item.id, entry.why])).toEqual([
      ['a', 'imp.bulk.left.applying'],
      ['s', 'imp.bulk.left.applyFailed'],
      ['u', 'imp.bulk.left.planFailed'],
      ['d', 'imp.bulk.left.applied'],
      ['c', 'imp.bulk.left.cancelled'],
    ])
  })

  it('held without the rights to run imports, and when none of the selected can be cancelled', () => {
    const keys = { right: 'imp.held.noRunRight', none: 'imp.bulk.none' }
    expect(bulkHeld(cancelReach([planned]), false, keys)).toBe('imp.held.noRunRight')
    expect(bulkHeld(cancelReach([applied, stopped]), true, keys)).toBe('imp.bulk.none')
    expect(bulkHeld(cancelReach([applied, planned]), true, keys)).toBeNull()
  })
})

describe('the upload step', () => {
  it('needs what the sheet holds, the company and a .csv or .xlsx file up to 10 MB', () => {
    expect(uploadProblems(blankDraft())).toEqual({ importerKey: 'imp.problem.importer', companyId: 'imp.problem.company', file: 'imp.problem.noFile' })
    const ready = { ...blankDraft('inventory.opening', 'c1'), file: { name: 'stock.XLSX', size: 2000 } }
    expect(uploadProblems(ready)).toEqual({})
    expect(uploadProblems({ ...ready, file: { name: 'stock.xls', size: 2000 } }).file).toBe('imp.problem.fileType')
    expect(uploadProblems({ ...ready, file: { name: 'stock.csv', size: 11 * 1_048_576 } }).file).toBe('imp.problem.fileSize')
    expect(uploadProblems({ ...ready, file: { name: 'stock.csv', size: 0 } }).file).toBe('imp.problem.fileEmpty')
    expect(sheetContentType('a.CSV')).toBe('text/csv')
    expect(sheetContentType('a.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(sheetContentType('a.xls')).toBeNull()
  })

  it('links the opening-stock template and the refused rows through /api (plain GETs, no header needed)', () => {
    expect(templateHref('inventory.opening', 'xlsx', 'it')).toBe('/api/inventory/opening/template?format=xlsx&numberFormat=it')
    expect(templateHref('product.materials', 'csv', 'en')).toBeNull()
    expect(refusedRowsHref('j 1')).toBe('/api/imports/j%201/errors')
  })
})

interface Call {
  method: string
  url: string
  headers: Headers
  body: unknown
}

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('the import calls (platform/imports)', () => {
  it('announces the sheet, sends its bytes to the store, then confirms it — in that order', async () => {
    const job = base({ status: 'UPLOADED', plannedAt: null })
    const { api, calls } = mockApi([
      { status: 201, body: { job, upload: { method: 'PUT', url: '/local-files?token=t', headers: { 'content-type': 'text/csv' }, expiresAt: '2026-10-29T10:05:00.000Z' } } },
      { status: 200, body: { file: { id: job.fileId, status: 'AVAILABLE' } } },
    ])
    const order: string[] = []
    const bytes = new TextEncoder().encode('Riga;Sito\nCS-0001;DN1\n')
    const sheet = { name: 'stock.csv', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
    const answer = await uploadSheet(api, { importerKey: 'inventory.opening', companyId: 'c1', numberFormat: 'it', sheetName: null }, sheet, async (presigned) => {
      order.push(`PUT ${presigned.url} after ${calls.length} call(s)`)
    })
    expect(answer.id).toBe(job.id)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/imports', `POST /api/files/${job.fileId}/complete`])
    expect(order).toEqual(['PUT /local-files?token=t after 1 call(s)'])
    expect(calls[0]!.body).toMatchObject({ importerKey: 'inventory.opening', companyId: 'c1', mode: 'DRY_RUN', numberFormat: 'it', file: { originalName: 'stock.csv', contentType: 'text/csv', sizeBytes: bytes.byteLength } })
    expect((calls[0]!.body as { file: { sha256: string } }).file.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(calls[0]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0]!.headers.get('x-csrf-token')).toBe('csrf-demo')
  })

  it('refuses a file that is not a sheet before anything is sent', async () => {
    const { api, calls } = mockApi([])
    await expect(uploadSheet(api, { importerKey: 'x.y', companyId: null, numberFormat: 'it' }, { name: 'a.pdf', size: 3, arrayBuffer: async () => new ArrayBuffer(3) })).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
  })

  it('applies with the version read; cancels; lists with the importer and status asked', async () => {
    const job = base()
    const { api, calls } = mockApi([
      { status: 200, body: { job: { ...job, status: 'APPLYING' } } },
      { status: 200, body: { job: { ...job, status: 'CANCELLED' } } },
      { status: 200, body: { jobs: [job] } },
    ])
    expect((await applyImport(api, job.id, 3)).status).toBe('APPLYING')
    expect((await cancelImport(api, job.id, { version: 4 })).status).toBe('CANCELLED')
    expect(await listImports(api, { importerKey: 'inventory.opening', status: 'APPLIED', limit: 5 })).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/imports/${job.id}/apply`, body: { version: 3 } })
    expect(calls[0]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[1]).toMatchObject({ method: 'POST', url: `/api/imports/${job.id}/cancel`, body: { version: 4 } })
    expect(calls[2]).toMatchObject({ method: 'GET', url: '/api/imports?importerKey=inventory.opening&status=APPLIED&limit=5' })
  })

  it('a job of an unknown shape is a contract error, never half-read', async () => {
    const { api } = mockApi([{ status: 200, body: { jobs: [{ id: 'x' }] } }])
    await expect(listImports(api)).rejects.toMatchObject({ kind: 'contract' })
  })
})

// ---- words ----

const SRC = fileURLToPath(new URL('.', import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
const own = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['admin-import'] ?? {}
const admin = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale].admin ?? {}
const has = (dictionary: Record<string, string>, key: string) => key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)

describe('every Import word exists in it and en', () => {
  it('every imp. key the code names, literally or built, exists in both languages; the admin keys it borrows too', () => {
    const literal = new Set<string>()
    const borrowed = new Set<string>()
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/['"`](imp\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) literal.add(match[1]!)
      for (const match of text.matchAll(/['"`]((?:common|list|problem|perm)\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) borrowed.add(match[1]!)
    }
    const built = [
      ...['reading', 'planned', 'planFailed', 'applying', 'applyFailed', 'applied', 'cancelled'].map((phase) => `imp.state.${phase}`),
      ...WIZARD_STEPS.map((step) => `imp.step.${step}`),
      ...['CREATE', 'UPDATE'].map((action) => `imp.action.${action}`),
      ...['it', 'en'].map((format) => `imp.numbers.${format}`),
      ...KNOWN_IMPORTERS.flatMap((key) => [`imp.importer.${key.replace(/\./g, '_')}.name`, `imp.importer.${key.replace(/\./g, '_')}.fills`]),
      ...['applying', 'applyFailed', 'planFailed', 'applied', 'cancelled'].map((phase) => `imp.bulk.left.${phase}`),
    ]
    expect(literal.size).toBeGreaterThan(60)
    for (const locale of LOCALES) {
      expect([...literal, ...built].filter((key) => !has(own(locale), key)), locale).toEqual([])
      expect([...borrowed].filter((key) => !has(admin(locale), key)), locale).toEqual([])
    }
  })
})

const LEFT_KEY = /\b(?:imp|common|list|problem|record|perm)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

/** The page in the shell, and the wizard drawn in place (its dialog opens only after hydration, so SSR skips it). */
function render(model: ImportViewModel, locale: (typeof LOCALES)[number]): string {
  const View = designScreen.view as ComponentType<{ model: unknown }>
  const wrap = (child: ReturnType<typeof createElement>) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, child))
  const page = wrap(createElement(View, { model }))
  const wizard = model.wizard
    ? wrap(
        createElement(AdminPageMessages, {
          namespace: 'admin-import',
          children: createElement(ImportWizardInline, { model: model.wizard, importers: model.importers.items ?? [], companies: model.companies, can: model.can }),
        }),
      )
    : ''
  return page + wizard
}

describe('SCR-017 draws every case in both languages with no key left on screen', () => {
  it('has every state the brief names', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['page', 'loading', 'error', 'no-access', 'page-recent-empty', 'page-none-open', 'upload-empty', 'upload-file', 'reading', 'checked-refused', 'checked-clean', 'checked-no-apply', 'applying', 'result', 'plan-failed', 'apply-failed', 'cancelled'])
      expect(ids).toContain(id)
  })

  for (const locale of LOCALES) {
    it(`${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        const html = render(item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('the check shows the API\'s reasons as quoted data, the money column apart, and the counts', () => {
    const draw = (id: string) => render(designScreen.cases.find((item) => item.id === id)!.model, 'en')
    const checked = draw('checked-refused')
    expect(checked).toContain('<q class="fw-adm-imp-said">The location B-09 is not a location of site DN1.</q>')
    expect(checked).toContain('Apply 12 rows')
    expect(checked).toContain('/api/imports/')
    expect(draw('plan-failed')).toContain('These columns hold money values you may not see: Costo standard')
    expect(draw('checked-no-apply')).toContain('Applying needs the right to apply imports')
    expect(draw('no-access')).toContain('See import jobs and their plans')
    expect(draw('page')).toContain('/api/inventory/opening/template?format=xlsx&amp;numberFormat=en')
  })

  it('Recent imports is the list frame: the count and the keys in the footer icon', () => {
    const html = render(designScreen.cases.find((item) => item.id === 'page')!.model, 'en')
    expect(html).toContain('5 imports')
    expect(html).toContain('aria-label="Keyboard keys of this list"')
  })

  it('selected imports: the bulk bar says its reach; the result notice names each refused sheet with the reason', () => {
    const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => render(designScreen.cases.find((item) => item.id === id)!.model, locale).replace(/<!-- -->/g, '')
    expect(draw('recent-selected')).toContain('4 selected')
    expect(draw('recent-selected')).toContain('Cancel 2 imports')
    expect(draw('recent-selected', 'it')).toContain('Annulla 2 importazioni')
    const after = draw('cancelled-many')
    expect(after).toContain('1 of 2 imports cancelled. Not cancelled:')
    expect(after).toContain('ubicazioni-demo-nord.csv: Someone else changed this meanwhile.')
  })

  it('a job\'s cell links to its wizard and offers Apply again when its apply stopped; its rows in words', () => {
    const cell = (node: ReturnType<typeof createElement>) => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(AdminPageMessages, { namespace: 'admin-import', children: node })))
    const stopped = base({ status: 'FAILED', appliedCount: 4 })
    const html = cell(createElement(JobCell, { job: stopped, href: '/w/DEMO/admin/import?job=x', canApply: true }))
    expect(html).toContain('href="/w/DEMO/admin/import?job=x"')
    expect(html).toContain('Opening stock')
    expect(html).toContain('Apply again')
    expect(cell(createElement(JobCell, { job: stopped, href: '#', canApply: false }))).not.toContain('Apply again')
    const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ''}`
    expect(rowsWords(t, base())).toMatch(/^imp\.recent\.rowsPlanned/)
    expect(rowsWords(t, base({ status: 'APPLIED' }))).toMatch(/^imp\.recent\.rowsApplied/)
    expect(rowsWords(t, base({ status: 'UPLOADED', plannedAt: null }))).toBe('—')
  })
})

describe('the fixtures stay made up', () => {
  it('only example.com addresses and Demo names', () => {
    const text = readFileSync(join(SRC, 'fixtures.ts'), 'utf8')
    expect(text).not.toMatch(/@(?!example\.com)[a-z0-9-]+\.[a-z]{2,}/i)
  })
})
