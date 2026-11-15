import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DUPLICATE_REASONS, MERGE_REFUSALS, USE_GROUPS } from '@nexus/factory-domain/imports/duplicates/rules'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { checkMaterial, checkParty, importDuplicates, mergeRecords, previewMerge, scanDuplicates } from './api'
import { ASK, IMPORT_CHECK, IMPORT_RESULT, PARTY_PAIRS, PREVIEW_IN_USE, PREVIEW_OK, ROSSI } from './demo'
import { designScreen as sectionScreen } from './fixtures'
import { designScreen as mergeScreen } from './design/merge/fixtures'
import { designScreen as checkScreen } from './design/check/fixtures'
import { designScreen as createScreen } from './design/create/fixtures'
import { MergeDialogInline } from './view/MergeDialog'
import type { MergeDialogModel } from './model'
import { askOfPair, askOfRow, mergeHeld, mergeNotice, moveLines, NAMESPACE, openHref, pairHeld, reasonWords, refusalWords, shownRows, statusKey } from './model'

/**
 * Likely duplicates on screen (B-W2b-427; SCR-620 … SCR-623): the words of every reason, refusal and use in both languages,
 * where a record opens, which pairs may be ticked, when Merge is held, the calls against a mocked API (the versions and the
 * reason sent, an Idempotency-Key on the merge), and every design case drawn in Italian and English with no key on screen.
 */

const own = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale][NAMESPACE] ?? {}
const has = (key: string) => LOCALES.every((locale) => key in own(locale) || (`${key}_one` in own(locale) && `${key}_other` in own(locale)))

describe('the words', () => {
  it('has every literal key of these screens in Italian and English (the dialogs too, drawn only in a browser)', () => {
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') ? [join(dir, entry.name)] : []))
    const keys = new Set(files(folder).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/['`](dup\.[a-zA-Z.]+[a-zA-Z])['`]/g)].map((match) => match[1]!)))
    expect(keys.size).toBeGreaterThan(40)
    expect([...keys].filter((key) => !has(key))).toEqual([])
  })

  it('has every reason, refusal, use group and status in Italian and English', () => {
    for (const code of DUPLICATE_REASONS) expect(has(`dup.reason.${code}`), code).toBe(true)
    for (const code of MERGE_REFUSALS) expect(has(`dup.refusal.${code}`), code).toBe(true)
    for (const group of USE_GROUPS) expect(has(`dup.use.${group}`), group).toBe(true)
    for (const status of ['PROSPECT', 'ACTIVE', 'BLOCKED', 'ARCHIVED', 'SOMETHING']) expect(has(statusKey(status))).toBe(true)
  })

  it('says a reason with its domain or score, and a refusal with both codes', () => {
    expect(reasonWords({ code: 'SAME_EMAIL_DOMAIN', detail: 'rossi.example', score: null })).toEqual({ key: 'dup.reason.SAME_EMAIL_DOMAIN', params: { detail: 'rossi.example', score: 0 } })
    expect(reasonWords({ code: 'SIMILAR_NAME', detail: null, score: 91 }).params.score).toBe(91)
    expect(refusalWords('IN_USE', PREVIEW_IN_USE)).toEqual({ key: 'dup.refusal.IN_USE', params: { kept: 'C-0001', dropped: 'C-0102', what: 'party' } })
  })
})

describe('the rules on screen', () => {
  it('opens a party on its customer page and a material on its record page', () => {
    expect(openHref('/w/DEMO', ROSSI)).toBe(`/w/DEMO/sales/customers/${ROSSI.id}`)
    expect(openHref('/w/DEMO', { recordType: 'MATERIAL', id: 'm1', code: 'PEL-1', companyId: null })).toBe('/w/DEMO/products/materials/m1')
  })

  it('keeps the older record by default, or the other one when swapped; a row merges into its candidate after the apply only', () => {
    const pair = PARTY_PAIRS[0]!
    expect(askOfPair('PARTY', pair)).toEqual({ recordType: 'PARTY', kept: { id: pair.a.id, code: pair.a.code }, dropped: { id: pair.b.id, code: pair.b.code } })
    expect(askOfPair('PARTY', pair, true).kept.id).toBe(pair.b.id)
    expect(askOfRow('PARTY', IMPORT_CHECK.rows[0]!, ROSSI)).toBeNull()
    expect(askOfRow('PARTY', IMPORT_RESULT.rows[0]!, ROSSI)).toEqual({ recordType: 'PARTY', kept: { id: ROSSI.id, code: 'C-0001' }, dropped: { id: IMPORT_RESULT.rows[0]!.recordId, code: 'C-0102' } })
  })

  it('ticks only pairs that can merge, and holds Merge until it may go ahead', () => {
    expect(pairHeld(PARTY_PAIRS[0]!, true)).toBeNull()
    expect(pairHeld(PARTY_PAIRS[0]!, false)).toBe('dup.held.noRight')
    expect(pairHeld(PARTY_PAIRS[3]!, true)).toBe('dup.held.blocked')
    const dialog = { preview: PREVIEW_OK, busy: false, canMerge: true }
    expect(mergeHeld(dialog, 'Same customer twice')).toBeNull()
    expect(mergeHeld(dialog, 'no')).toBe('dup.held.reason')
    expect(mergeHeld({ ...dialog, preview: null }, 'Same customer twice')).toBe('dup.held.loading')
    expect(mergeHeld({ ...dialog, preview: PREVIEW_IN_USE }, 'Same customer twice')).toBe('dup.held.refused')
    expect(mergeHeld({ ...dialog, canMerge: false }, 'Same customer twice')).toBe('dup.held.noRight')
    expect(mergeHeld({ ...dialog, busy: true }, 'Same customer twice')).toBe('dup.held.busy')
  })

  it('lists only what moves and what stays, and shows only rows with something alike', () => {
    expect(moveLines(PREVIEW_OK, 'moves')).toEqual([
      { key: 'dup.moves.contacts', count: 2 },
      { key: 'dup.moves.addresses', count: 1 },
      { key: 'dup.moves.taxIdentities', count: 1 },
    ])
    expect(moveLines(PREVIEW_OK, 'stays')).toEqual([{ key: 'dup.stays.contacts', count: 1 }])
    expect(shownRows(IMPORT_CHECK)).toHaveLength(3)
    expect(shownRows({ ...IMPORT_CHECK, supported: false })).toEqual([])
    expect(shownRows(null)).toEqual([])
    expect(mergeNotice(2, 0).tone).toBe('success')
    expect(mergeNotice(1, 1).tone).toBe('warning')
    expect(mergeNotice(0, 2).tone).toBe('danger')
  })
})

function mockApi(answers: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, key: headers.get('idempotency-key') })
    const answer = answers.shift() ?? { status: 500, body: {} }
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchImpl, csrfToken: () => 'csrf' })
  return { api, calls }
}

describe('the calls', () => {
  it('checks a draft without its blank fields, reads the list, the import and the preview, and merges with both versions and a key', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { candidates: [ROSSI] } },
      { status: 200, body: { candidates: [] } },
      { status: 200, body: { recordType: 'PARTY', pairs: PARTY_PAIRS, more: false, compared: 12 } },
      { status: 200, body: IMPORT_CHECK },
      { status: 200, body: PREVIEW_OK },
      { status: 200, body: { recordType: 'PARTY', kept: PREVIEW_OK.kept, dropped: { ...PREVIEW_OK.dropped, status: 'ARCHIVED' }, moved: PREVIEW_OK.moves } },
    ])
    expect(await checkParty(api, { legalName: 'Pelletteria Demo', tradeName: '', vatNumber: null, country: 'IT' })).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/duplicates/parties/check', body: { legalName: 'Pelletteria Demo', country: 'IT' } })
    expect(await checkMaterial(api, { code: 'PEL-1', name: '' })).toEqual([])
    expect(calls[1]!.body).toEqual({ code: 'PEL-1' })
    expect((await scanDuplicates(api, 'PARTY')).pairs).toHaveLength(PARTY_PAIRS.length)
    expect(calls[2]!.url).toBe('/api/duplicates/parties')
    expect((await importDuplicates(api, 'job-1')).rows).toHaveLength(3)
    expect(calls[3]!.url).toBe('/api/imports/job-1/duplicates')
    await previewMerge(api, 'PARTY', ASK.kept.id, ASK.dropped.id)
    expect(calls[4]!.url).toBe(`/api/duplicates/PARTY/merge?keptId=${ASK.kept.id}&droppedId=${ASK.dropped.id}`)
    const merged = await mergeRecords(api, 'PARTY', { keptId: ASK.kept.id, droppedId: ASK.dropped.id, keptVersion: 7, droppedVersion: 2, reason: 'Same customer twice' })
    expect(merged.dropped.status).toBe('ARCHIVED')
    expect(calls[5]).toMatchObject({ method: 'POST', url: '/api/duplicates/PARTY/merge', body: { keptVersion: 7, droppedVersion: 2, reason: 'Same customer twice' } })
    expect(calls[5]!.key).toBeTruthy()
  })
})

describe('the design screens', () => {
  const screens = [sectionScreen, mergeScreen, checkScreen, createScreen] as unknown as DesignScreen<unknown>[]
  const draw = (screen: DesignScreen<unknown>, id: string, locale: (typeof LOCALES)[number]) =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as never, { model: screen.cases.find((item) => item.id === id)!.model }))).replace(/<!-- -->/g, '')

  it('takes the new ids SCR-620 to SCR-623', () => {
    expect(screens.map((screen) => screen.screen)).toEqual(['SCR-620', 'SCR-621', 'SCR-622', 'SCR-623'])
  })

  it('draws every case in Italian and English with no key on screen', () => {
    for (const screen of screens)
      for (const item of screen.cases)
        for (const locale of LOCALES) {
          const html = draw(screen, item.id, locale)
          expect(html, `${screen.screen}/${item.id}/${locale}`).not.toMatch(/dup\.[a-zA-Z]+\.[A-Za-z_.]+/)
        }
  })

  it('draws the merge dialog of every SCR-621 case in place, in both languages, with no key', () => {
    for (const item of (mergeScreen as unknown as DesignScreen<MergeDialogModel>).cases)
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(MergeDialogInline, { model: item.model }))).replace(/<!-- -->/g, '')
        expect(html, `${item.id}/${locale}`).not.toMatch(/dup\.[a-zA-Z]+\.[A-Za-z_.]+/)
        expect(html.length, item.id).toBeGreaterThan(100)
      }
  })

  it('says what each screen is about', () => {
    expect(draw(sectionScreen as never, 'parties', 'en')).toContain('Possible duplicates')
    expect(draw(sectionScreen as never, 'parties', 'en')).toContain('4 pairs · 248 records compared')
    expect(draw(sectionScreen as never, 'selected', 'en')).toContain('Merge 2')
    expect(draw(sectionScreen as never, 'parties', 'it')).toContain('Possibili doppioni')
    const merge = (id: string, locale: (typeof LOCALES)[number] = 'en') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(MergeDialogInline, { model: (mergeScreen as unknown as DesignScreen<MergeDialogModel>).cases.find((item) => item.id === id)!.model }))).replace(/<!-- -->/g, '')
    expect(merge('party')).toContain('Merge C-0102 into C-0001?')
    expect(merge('party')).toContain('2 contacts')
    expect(merge('party', 'it')).toContain('Unire C-0102 a C-0001?')
    expect(merge('in-use')).toContain('Keep C-0102 instead')
    expect(merge('in-use')).toContain('Sales: 3 records')
    expect(merge('both-used')).not.toContain('instead')
    expect(merge('loading')).toContain('aria-busy="true"')
    expect(draw(checkScreen as never, 'check', 'en')).toContain('Possible duplicates: 3 new rows')
    expect(draw(checkScreen as never, 'check', 'en')).toContain('Row 12 of this sheet')
    expect(draw(checkScreen as never, 'result', 'en')).toContain('Merge…')
    expect(draw(checkScreen as never, 'none', 'en')).not.toContain('Possible duplicates')
    expect(draw(createScreen as never, 'party-vat', 'en')).toContain('belongs to a party already')
    expect(draw(createScreen as never, 'party-name', 'it')).toContain('Stesso dominio e-mail rossi-demo.example')
    expect(draw(createScreen as never, 'none', 'en')).not.toContain('may exist already')
  })
})
