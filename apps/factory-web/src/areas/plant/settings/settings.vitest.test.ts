import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { STARTER_SYMPTOMS, STARTER_CLASSES } from '@nexus/factory-domain/plant/starter'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { SYMPTOM_ICON_IDS } from '../../../lib/plant/symptom-icons'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { officeArea } from '../nav'
import { addStarter, createSymptom, editSymptom, type ClassRow, type SymptomRow } from './api'
import { designScreen } from './fixtures'
import {
  activeHeld,
  ALL,
  classFilterOf,
  classWords,
  draftBody,
  draftHeld,
  EMPTY_DRAFT,
  EVERY,
  fieldOfEdit,
  inOrder,
  moveHeld,
  moveOf,
  offeredFor,
  orderWrites,
  problemOf,
  readProblemOf,
  reverseOf,
  typedCode,
  visibleRows,
  withEdit,
  wordEdit,
} from './model'

const row = (code: string, patch: Partial<SymptomRow> = {}): SymptomRow => ({
  id: `id-${code}`,
  code,
  classId: null,
  labelIt: `${code} it`,
  labelEn: `${code} en`,
  labelI18n: {},
  icon: null,
  colour: null,
  unsafe: false,
  needsDetail: false,
  active: true,
  sortOrder: 10,
  requests: 0,
  version: 2,
  updatedAt: '2026-10-30T08:00:00.000Z',
  ...patch,
})
const cls = (id: string, active = true): ClassRow => ({ id, code: id.toUpperCase(), labelIt: `${id} it`, labelEn: `${id} en`, labelI18n: {}, icon: null, sortOrder: 0, active, machines: 0, version: 1, updatedAt: '2026-10-30T08:00:00.000Z' })
const refusal = (status: number, kind: ApiError['kind'], issues: Array<{ path: string; message?: string }> = [], message = 'x') => new ApiError(kind, status, 'x', message, null, issues)

describe('Plant settings › Symptoms on the floor (SCR-241): the rules', () => {
  it('a class shows its own symptoms and those for every machine; "every" only the latter; the search reads code and words', () => {
    const rows = [row('NOISE'), row('THREAD', { classId: 'lock' }), row('TWO_HAND', { classId: 'press', labelIt: 'Comando a due mani' })]
    expect(visibleRows(rows, ALL, '').map((entry) => entry.code)).toEqual(['NOISE', 'THREAD', 'TWO_HAND'])
    expect(visibleRows(rows, 'lock', '').map((entry) => entry.code)).toEqual(['NOISE', 'THREAD'])
    expect(visibleRows(rows, EVERY, '').map((entry) => entry.code)).toEqual(['NOISE'])
    expect(visibleRows(rows, ALL, 'comando').map((entry) => entry.code)).toEqual(['TWO_HAND'])
    expect(classFilterOf('lock', [cls('lock')])).toBe('lock')
    expect(classFilterOf('gone', [cls('lock')])).toBe(ALL)
    expect(classFilterOf(EVERY, [])).toBe(EVERY)
    expect(classFilterOf(null, [])).toBe(ALL)
    expect(offeredFor([...rows, row('OFF', { active: false })], 'lock')).toBe(2)
    expect(classWords(null, [], 'en')).toEqual({ key: 'for.every' })
    expect(classWords('lock', [cls('lock', false)], 'it')).toEqual({ key: 'for.retired', words: 'lock it' })
    expect(classWords('nope', [], 'it')).toEqual({ key: 'for.unknown' })
  })

  it('sends one word cell at the version read, never blank; the switches and the icon go back when refused', () => {
    const symptom = row('NOISE')
    expect(wordEdit(symptom, 'labelIt', ' Rumore forte ')).toEqual({ edit: { version: 2, labelIt: 'Rumore forte' } })
    expect(wordEdit(symptom, 'labelEn', '  ')).toEqual({ problem: 'problem.labelEn' })
    expect(wordEdit(symptom, 'labelIt', 'NOISE it')).toBeNull()
    expect(wordEdit(symptom, 'labelEn', 'x'.repeat(81))).toEqual({ problem: 'problem.tooLong' })
    expect(withEdit(symptom, { unsafe: true, icon: 'zap' })).toMatchObject({ unsafe: true, icon: 'zap', labelIt: 'NOISE it' })
    expect(reverseOf(row('NOISE', { unsafe: true }), { unsafe: false })).toEqual({ unsafe: true })
    expect(fieldOfEdit({ icon: null })).toBe('icon')
    expect(fieldOfEdit({ active: false })).toBe('active')
    expect(fieldOfEdit({ unsafe: true })).toBe('unsafe')
  })

  it('holds "Add symptom" until it is a free code with words in both languages, and sends it trimmed', () => {
    expect(draftHeld(EMPTY_DRAFT, [], false)).toBe('held.noCode')
    expect(draftHeld({ ...EMPTY_DRAFT, code: '1X' }, [], false)).toBe('held.badCode')
    expect(draftHeld({ ...EMPTY_DRAFT, code: 'NOISE' }, ['NOISE'], false)).toBe('held.codeTaken')
    expect(draftHeld({ ...EMPTY_DRAFT, code: 'BELT', labelIt: 'Cinghia' }, [], false)).toBe('held.noWords')
    expect(draftHeld({ ...EMPTY_DRAFT, code: 'BELT', labelIt: 'Cinghia', labelEn: 'Belt' }, [], true)).toBe('held.busy')
    expect(draftHeld({ ...EMPTY_DRAFT, code: 'BELT', labelIt: 'Cinghia', labelEn: 'Belt' }, [], false)).toBeNull()
    expect(typedCode('belt slips-now')).toBe('BELT_SLIPS_NOW')
    expect(draftBody({ code: ' BELT ', classId: 'lock', labelIt: ' Cinghia', labelEn: 'Belt ', icon: 'activity', unsafe: true, needsDetail: false })).toEqual({ code: 'BELT', classId: 'lock', labelIt: 'Cinghia', labelEn: 'Belt', icon: 'activity', unsafe: true, needsDetail: false })
  })

  it("says the API's refusals in its own words; a lost answer is 'not known', never 'saved'", () => {
    expect(problemOf(refusal(409, 'conflict', [], 'Symptom BELT is taken.'), 'create')).toEqual({ key: 'problem.codeTaken', unknown: false })
    expect(problemOf(refusal(409, 'conflict', [], 'Symptom BELT is taken by a retired symptom.'), 'create').key).toBe('problem.codeTakenRetired')
    expect(problemOf(refusal(409, 'conflict', [], 'At most 300 symptoms: retire some first.'), 'create').key).toBe('problem.tooMany')
    expect(problemOf(refusal(409, 'conflict', [], 'This symptom changed since you read it.')).key).toBe('problem.stale')
    expect(problemOf(refusal(400, 'invalid', [{ path: 'body/labelIt' }])).key).toBe('problem.labelIt')
    expect(problemOf(refusal(400, 'invalid', [{ path: 'body.classId' }]), 'create').key).toBe('problem.classId')
    expect(problemOf(refusal(400, 'invalid', [{ path: 'body/sortOrder' }])).key).toBe('problem.invalid')
    expect(problemOf(refusal(403, 'forbidden')).key).toBe('problem.forbidden')
    expect(problemOf(refusal(0, 'unavailable'))).toEqual({ key: 'problem.offline', unknown: true })
    expect(problemOf(new Error('boom'))).toEqual({ key: 'problem.failed', unknown: true })
    expect(readProblemOf(refusal(403, 'forbidden'))).toBe('problem.readForbidden')
    expect(readProblemOf(refusal(500, 'internal'))).toBe('problem.read')
  })

  it('moves a selection one place in the whole list with the fewest writes; held while narrowed, at the ends', () => {
    const rows = [row('A', { sortOrder: 0 }), row('B', { sortOrder: 10, version: 3 }), row('C', { sortOrder: 20 })]
    expect(moveOf(rows, ['id-C'], -1)).toEqual(['id-A', 'id-C', 'id-B'])
    expect(moveOf(rows, ['id-A'], -1)).toBeNull()
    expect(orderWrites(rows, ['id-A', 'id-C', 'id-B'])).toEqual([
      { id: 'id-C', version: 2, sortOrder: 10 },
      { id: 'id-B', version: 3, sortOrder: 20 },
    ])
    // Tied values (two at 10): numbered again in tens; a row already on its new value is not written.
    const tied = [row('A', { sortOrder: 10 }), row('B', { sortOrder: 10 }), row('C', { sortOrder: 30 })]
    expect(orderWrites(tied, ['id-B', 'id-A', 'id-C'])).toEqual([{ id: 'id-A', version: 2, sortOrder: 20 }])
    expect(inOrder([row('Z', { sortOrder: 5 }), row('Y', { sortOrder: 5 }), row('X', { sortOrder: 1 })]).map((entry) => entry.code)).toEqual(['X', 'Y', 'Z'])
    expect(moveHeld(rows, ['id-A'], -1, false, false)).toBe('held.atTop')
    expect(moveHeld(rows, ['id-C'], 1, false, false)).toBe('held.atBottom')
    expect(moveHeld(rows, ['id-C'], -1, false, true)).toBe('held.narrowed')
    expect(moveHeld(rows, ['id-C'], -1, true, false)).toBe('held.busy')
    expect(activeHeld([rows[0]!], true, false)).toBe('held.allOffered')
    expect(activeHeld([row('X', { active: false })], false, false)).toBe('held.noneOffered')
    expect(activeHeld(rows, false, false)).toBeNull()
  })

  it('every icon of the starter set draws, and the icon picker offers each with its words', () => {
    for (const entry of [...STARTER_CLASSES, ...STARTER_SYMPTOMS]) if (entry.icon) expect(SYMPTOM_ICON_IDS, entry.code).toContain(entry.icon)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['plant-settings'] ?? {}
      for (const id of SYMPTOM_ICON_IDS) expect(words[`icon.${id}`], `${locale} icon.${id}`).toBeTruthy()
    }
  })
})

describe('Plant settings: the calls and the place', () => {
  it('each write carries an Idempotency-Key, the CSRF token and the version read', async () => {
    const calls: { url: string; method: string; body: unknown; headers: Headers }[] = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) })
      const symptom = row('BELT')
      const body = url.endsWith('/plant/starter') ? { added: { classes: [], symptoms: ['ELECTRICAL_FAULT'] } } : { symptom }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' })
    await createSymptom(api, { code: 'BELT', classId: null, labelIt: 'Cinghia', labelEn: 'Belt', icon: null, unsafe: false, needsDetail: false }, 'k1')
    await editSymptom(api, 'id-BELT', { version: 2, unsafe: true }, 'k2')
    expect(await addStarter(api, 'k3')).toEqual({ classes: [], symptoms: ['ELECTRICAL_FAULT'] })
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/plant/symptoms', 'PATCH /api/plant/symptoms/id-BELT', 'POST /api/plant/starter'])
    expect(calls[1]!.body).toEqual({ version: 2, unsafe: true })
    for (const call of calls) {
      expect(call.headers.get('idempotency-key'), call.url).toBeTruthy()
      expect(call.headers.get('x-csrf-token'), call.url).toBe('csrf-demo')
    }
  })

  it('a Settings group in the Plant area asks plant.view; the page is built; sales sees no Plant', () => {
    expect(officeArea.area.sections?.map((section) => section.id)).toEqual(['plant-maintenance', 'plant-settings'])
    expect(officeArea.area.sections?.[1]?.items.map((item) => [item.href, item.permission])).toEqual([['/plant/settings', 'plant.view']])
    expect(OFFICE_PAGES.has('/plant/settings')).toBe(true)
    const supervisor = officeNavFor(permissionCheck(templateOf('floor_supervisor')!.permissions))
    expect(supervisor.areas.find((area) => area.id === 'plant')?.sections?.some((section) => section.id === 'plant-settings')).toBe(true)
    expect(officeNavFor(permissionCheck(templateOf('sales')!.permissions)).areas.map((area) => area.id)).not.toContain('plant')
  })
})

// ---- every design case ------------------------------------------------------------------------------------------------------

const TOP = [...new Set(Object.keys(CATALOGUE.en['plant-settings'] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, '')))]
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("plant.view"). */
const SAID = /\bplant\.[a-zA-Z.]+/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  it('the catalogue has the same keys in it and en, and every word the page names', () => {
    const it = Object.keys(CATALOGUE.it['plant-settings'] ?? {}).sort()
    const en = Object.keys(CATALOGUE.en['plant-settings'] ?? {}).sort()
    expect(it.length).toBeGreaterThan(100)
    expect(it).toEqual(en)
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:problem|held|done|state|mark|for)\.[a-zA-Z]+)'/g)].map((match) => match[1]!)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['plant-settings'] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
    }
  })

  it(`SCR-241: ${designScreen.cases.length} cases × it, en`, () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['list', 'class', 'saving', 'refused', 'selected', 'new', 'code-taken', 'icon', 'unsafe-off', 'starter', 'empty', 'read-only', 'no-permission', 'changed-elsewhere', 'offline', 'loading', 'error', 'keys']),
    )
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = render(designScreen as unknown as DesignScreen<unknown>, item.model, locale).replace(SAID, '')
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })
})
