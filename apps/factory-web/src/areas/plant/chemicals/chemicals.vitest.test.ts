import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { cabinetAddress, CHEMICAL_REFUSALS, CHEMICAL_USES, GHS_PICTOGRAMS, QUANTITY_UNITS, SIGNAL_WORDS } from '@nexus/factory-domain/safety/chemicals/rules'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor, WINDOW_PAGES } from '../../../shell/nav/office-nav'
import { designScreen as floorScreen } from '../../../floor/tasks/sds/fixtures'
import type { SdsPack } from '../../../floor/tasks/sds/api'
import { memoryKeeper } from '../../../floor/tasks/sds/keep'
import { CABINET_PATH, cabinetIn, cabinetsOf, filesToDrop, firstSheetOf, sheetsToFetch, cabinetOfScan } from '../../../floor/tasks/sds/model'
import { refreshKept } from '../../../floor/tasks/sds/refresh'
import { GLUE, PAINT } from './_demo/fixtures'
import { designScreen as cabinetScreen } from './cabinet/fixtures'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressText,
  bodyOf,
  chemicalsCan,
  draftChanged,
  draftOf,
  draftProblems,
  EMPTY_ADDRESS,
  EMPTY_DRAFT,
  problemOf,
  replaceHeld,
  replaceWords,
  sheetHeld,
  tilesOf,
  withAddress,
} from './model'
import { designScreen as sdsScreen } from './sds/fixtures'

const params = (text: string) => new URLSearchParams(text)

describe('chemicals: the address and the tiles', () => {
  it('keeps the filters and every dialog in the address, the API’s own terms', () => {
    const address = addressOf(params('tile=withoutSds&status=all&use=GLUE&cabinet=CAB-1&q=colla&open=abc&do=replace&sheet=s1&qr=1'))
    expect(address).toMatchObject({ tile: 'withoutSds', status: 'all', use: 'GLUE', cabinet: 'CAB-1', q: 'colla', open: 'abc', mode: 'replace', sheet: 's1', add: false, qr: true })
    expect(addressOf(params(addressText(address).slice(1)))).toEqual(address)
    expect(addressOf(params('tile=x&status=y&use=GLITTER&do=delete'))).toEqual(EMPTY_ADDRESS)
    // Another chemical starts on its facts; closing the window clears its mode and sheet.
    expect(withAddress(address, { open: 'other' }).mode).toBe('view')
    expect(withAddress(address, { open: null })).toMatchObject({ mode: 'view', sheet: null })
    expect(tilesOf({ active: 4, withoutSds: 1, toRequest: 2, cabinets: 3 }).map((tile) => tile.value)).toEqual([4, 1, 2, 3])
    expect(tilesOf(null).every((tile) => tile.value === null)).toBe(true)
  })

  it('gives the register to every safety reader and keeping it to the safety officer only', () => {
    const can = (key: string) => chemicalsCan(templateOf(key)!.permissions)
    expect(can('safety_officer')).toEqual({ view: true, manage: true })
    expect(can('production_manager')).toEqual({ view: true, manage: false })
    expect(can('read_only')).toEqual({ view: true, manage: false })
    expect(can('sales').view).toBe(false)
    const rows = (key: string) => officeNavFor(permissionCheck(templateOf(key)!.permissions)).areas.flatMap((area) => (area.sections ?? []).flatMap((entry) => entry.items.map((row) => row.href)))
    expect(rows('safety_officer')).toContain('/plant/chemicals')
    expect(rows('sales')).not.toContain('/plant/chemicals')
    expect([...OFFICE_PAGES]).toEqual(expect.arrayContaining(['/plant/chemicals', '/plant/chemicals/sds', '/plant/chemicals/cabinet']))
    expect([...WINDOW_PAGES]).toEqual(expect.arrayContaining(['/plant/chemicals/sds', '/plant/chemicals/cabinet']))
    expect(recordAddress({ type: 'Chemical', id: 'c-1' }, OFFICE_PAGES)).toBe('/plant/chemicals?open=c-1')
    expect(LIST_PAGES['/safety/chemicals']).toBe('/plant/chemicals')
  })
})

describe('chemicals: the dialogs', () => {
  it('sends what the domain takes: statements in CLP writing, the cabinet in capitals, a comma decimal as a point', () => {
    const body = bodyOf({ ...EMPTY_DRAFT, name: ' Colla ', use: 'GLUE', hazards: 'h225, H319', precautions: 'p305 + p351 + p338', storagePlace: 'Armadio', cabinetCode: ' cab-1 ', maxQuantity: '2,5', maxQuantityUnit: 'L', supplierName: '  ' })
    expect(body).toMatchObject({ name: 'Colla', hazardStatements: ['H225', 'H319'], precautionStatements: ['P305+P351+P338'], cabinetCode: 'CAB-1', maxQuantity: '2.5', supplierName: null, supplierPartyId: null })
    expect(draftProblems(EMPTY_DRAFT, true).map((problem) => problem.key)).toEqual(['held.site', 'held.use', 'held.name', 'held.storagePlace'])
    expect(draftProblems({ ...EMPTY_DRAFT, siteId: 's', name: 'x', use: 'OIL', storagePlace: 'y', maxQuantity: '3' }, true).map((problem) => problem.key)).toEqual(['held.maxQuantityUnit'])
    expect(draftChanged(GLUE, draftOf(GLUE))).toBe(false)
    expect(draftChanged(GLUE, { ...draftOf(GLUE), cabinetCode: 'CAB-2' })).toBe(true)
  })

  it('holds a sheet until it is a PDF with its version, a past day and a language; a replacement only when newer', () => {
    const file = { name: 'sds.pdf', type: 'application/pdf', size: 10 }
    expect(sheetHeld({ file: null, versionLabel: '', revisedOn: '', language: 'it' }, '2026-11-03')).toBe('held.file')
    expect(sheetHeld({ file: { ...file, type: 'image/png' }, versionLabel: '1', revisedOn: '2026-01-01', language: 'it' }, '2026-11-03')).toBe('held.pdf')
    expect(sheetHeld({ file, versionLabel: '1', revisedOn: '2026-11-04', language: 'it' }, '2026-11-03')).toBe('held.revisedFuture')
    expect(sheetHeld({ file, versionLabel: '1', revisedOn: '2026-11-03', language: 'it' }, '2026-11-03')).toBeNull()
    const draft = { file, versionLabel: '3.2', revisedOn: '2026-10-01', language: 'it' }
    expect(replaceWords(GLUE, draft)).toEqual({ key: 'replace.supersedes', params: { version: '3.1', language: 'it' } })
    expect(replaceWords(GLUE, { ...draft, language: 'de' }).key).toBe('replace.first')
    expect(replaceHeld(GLUE, { ...draft, revisedOn: '2020-01-01' }, '2026-11-03')).toBe('refusal.OLDER_THAN_CURRENT')
    expect(replaceHeld(GLUE, { ...draft, versionLabel: '3.1' }, '2026-11-03')).toBe('refusal.SAME_VERSION')
    expect(replaceHeld({ ...GLUE, status: 'ARCHIVED' }, draft, '2026-11-03')).toBe('held.archived')
    expect(replaceHeld(PAINT, draft, '2026-11-03')).toBeNull()
  })

  it('says the API’s refusal in our words, at its field', () => {
    const error = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/ROLE_OTHER_SITE' }, { path: 'body/roleSheetIds' }])
    expect(problemOf(error)).toEqual({ key: 'refusal.ROLE_OTHER_SITE', field: 'roleSheetIds' })
    expect(problemOf(new Error('x')).key).toBe('problem.unavailable')
  })
})

describe('the cabinet QR on the floor (what the tablet keeps, how a QR finds it)', () => {
  const pack = (fileSha = 'a'.repeat(64)): SdsPack => ({
    siteId: 'site-1',
    site: { code: 'S1', name: 'Sede 1' },
    language: 'it',
    at: '2026-11-03T08:00:00.000Z',
    chemicals: [
      { id: 'c1', name: 'Colla', supplier: null, use: 'GLUE', ghsPictograms: [], signalWord: null, hazardStatements: [], precautionStatements: [], storagePlace: 'A', cabinetCode: 'CAB-1', maxQuantity: null, maxQuantityUnit: null, ppe: [], current: [{ id: 's1', versionLabel: '1', revisedOn: '2026-01-01', language: 'en', fileId: 'f1', sizeBytes: 3, sha256: fileSha }, { id: 's2', versionLabel: '1', revisedOn: '2026-01-01', language: 'it', fileId: 'f2', sizeBytes: 3, sha256: fileSha }] },
      { id: 'c2', name: 'Olio', supplier: null, use: 'OIL', ghsPictograms: [], signalWord: null, hazardStatements: [], precautionStatements: [], storagePlace: 'B', cabinetCode: null, maxQuantity: null, maxQuantityUnit: null, ppe: [], current: [] },
    ],
  })

  it('finds the cabinet from its QR, groups the pack by cabinet, opens the reader’s language first', () => {
    expect(cabinetOfScan(cabinetAddress('https://factory.example.com', 'CAB-1'))).toBe('CAB-1')
    expect(CABINET_PATH).toBe('/floor/sds')
    expect(cabinetsOf(pack()).map((group) => group.code)).toEqual(['CAB-1', null])
    expect(cabinetIn(pack(), 'cab-1')?.chemicals.map((chemical) => chemical.id)).toEqual(['c1'])
    expect(cabinetIn(pack(), 'CAB-9')).toBeNull()
    expect(firstSheetOf(pack().chemicals[0]!, 'en', 'it')?.id).toBe('s1')
    expect(firstSheetOf(pack().chemicals[0]!, 'fr', 'it')?.id).toBe('s2')
    expect(sheetsToFetch(pack(), new Map([['f1', 'a'.repeat(64)]])).map((sheet) => sheet.fileId)).toEqual(['f2'])
    expect(filesToDrop(pack(), ['f1', 'old'])).toEqual(['old'])
  })

  afterEach(() => vi.unstubAllGlobals())

  it('keeps the pack and the PDFs whose bytes match their SHA-256, and drops what is no longer current', async () => {
    const bytes = new TextEncoder().encode('%PDF')
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const served = pack(digest)
    served.chemicals[0]!.current[1] = { ...served.chemicals[0]!.current[1]!, sha256: 'b'.repeat(64) }
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('/safety/floor/chemicals')) return new Response(JSON.stringify(served), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/safety/floor/data-sheets/')) return new Response(JSON.stringify({ download: { method: 'GET', url: '/local-files?token=x', headers: {}, expiresAt: '2026-11-03T08:01:00.000Z' }, sha256: digest, sizeBytes: 4 }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/local-files')) return new Response(bytes, { status: 200 })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchStub)
    const keeper = memoryKeeper()
    await keeper.saveFile({ fileId: 'old', sha256: 'c'.repeat(64), bytes })
    const result = await refreshKept(createApiClient({ baseUrl: '/api', fetch: fetchStub as unknown as typeof fetch }), keeper)
    expect(result.missing).toBe(1)
    expect([...(await keeper.files()).keys()]).toEqual(['f1'])
    expect((await keeper.pack('site-1'))?.chemicals).toHaveLength(2)
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const NAMESPACES = ['plant-chemicals', 'floor-sds']
const TOP = [...new Set(NAMESPACES.flatMap((ns) => Object.keys(CATALOGUE.en[ns] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, ''))))].filter((key) => !['actions', 'back', 'home', 'ppe', 'most', 'empty', 'reading', 'opening', 'fresh', 'partial', 'offline', 'refreshing'].includes(key))
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("safety.chemicals.manage"); addresses and file names are not keys. */
const SAID = /\b(?:safety\.[a-zA-Z.]+|[a-z-]+\.example\.com[^\s"<]*|[\w .-]+\.pdf)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'floor']) }, createElement(View, { model })))
}

describe('chemicals: the words', () => {
  it('every key in it and en; every word the screens name exists; every code has its words', () => {
    for (const ns of NAMESPACES) expect(Object.keys(CATALOGUE.it[ns] ?? {}).sort(), ns).toEqual(Object.keys(CATALOGUE.en[ns] ?? {}).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:held|refusal|problem|saved|notice|replace|bulk)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['plant-chemicals'] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      for (const code of CHEMICAL_REFUSALS) expect(has(`refusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of GHS_PICTOGRAMS) expect(has(`ghs.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of CHEMICAL_USES) expect(has(`use.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of QUANTITY_UNITS) expect(has(`unit.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of SIGNAL_WORDS) expect(has(`signal.${code}`), `${locale} ${code}`).toBe(true)
      for (const field of ['name', 'supplierName', 'ghsPictograms', 'hazardStatements', 'precautionStatements', 'signalWord', 'storagePlace', 'cabinetCode', 'maxQuantity', 'maxQuantityUnit', 'roleSheetIds', 'ppeItemIds', 'note', 'versionLabel', 'revisedOn', 'language', 'fileId', 'siteId']) expect(has(`held.${field}`), `${locale} held.${field}`).toBe(true)
      expect(CATALOGUE[locale].floor?.['tile.sds'], `${locale} floor tile.sds`).toBeTruthy()
    }
  })

  for (const screen of [designScreen, sdsScreen, cabinetScreen, floorScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en with no key or placeholder left`, () => {
      for (const entry of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, entry.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${entry.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('SCR-213 names every state and role case the design asks for', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['normal', 'all-sites', 'loading', 'error', 'empty', 'no-permission', 'read-only', 'add', 'chemical', 'chemical-replace', 'qr', 'archive-many', 'keys']),
    )
    expect(floorScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['cabinet', 'offline', 'nothing-kept', 'open', 'open-missing']))
  })
})
