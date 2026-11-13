import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COUNT_ITEM_KINDS } from '@nexus/factory-domain/inventory/counts/rules'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as countsScreen } from '../list/fixtures'
import { designScreen as countScreen } from '../record/fixtures'
import { countsCan } from '../model'
import { canAs } from '../demo/fixtures'
import { dueCounts, startSchedule } from './api'
import { BAD_FORM, BLOCKED, EDIT_FORM, NEW_FORM, RETIRED, SCHEDULES } from './demo/fixtures'
import { countBlocked, DEPTH_NAMESPACE, dueWords, placesOfCount, scheduleBodyOf, scheduleChangeOf, scheduleFormProblems, scheduleProblem, scheduleSaveHeld, scopeParts, startHeld, startProblem } from './model'

/**
 * B-W2b-320 — the W2b parts of Warehouse › Counts: a schedule's due words and scope, the Count schedule form (the domain's
 * own check), why Start waits, the places a count blocks, the calls (each write with its Idempotency-Key, the freeze on by
 * default), and every W2b design case drawn in Italian and English with no key left.
 */

describe('counts depth: schedules', () => {
  it('says how due a schedule is and what it counts, in parts', () => {
    expect(dueWords(SCHEDULES[0]!)).toEqual({ key: 'cd.due.OVERDUE', params: { count: 3 } })
    expect(dueWords(SCHEDULES[1]!)).toEqual({ key: 'cd.due.DUE_TODAY' })
    expect(scopeParts(SCHEDULES[0]!).map((part) => part.key)).toEqual(['cd.scope.location'])
    expect(scopeParts({ location: null, abcClass: 'A', itemKind: 'LEATHER' }).map((part) => part.key)).toEqual(['cd.scope.class', 'cd.scope.kind.LEATHER'])
  })

  it('holds Start count without the right, for a retired schedule, while busy', () => {
    const warehouse = canAs('warehouse')
    expect(warehouse.manage).toBe(true)
    expect(startHeld(SCHEDULES[0]!, warehouse, false)).toBeNull()
    expect(startHeld(SCHEDULES[0]!, canAs('readOnly'), false)!.key).toBe('cd.held.noManage')
    expect(startHeld(RETIRED, warehouse, false)!.key).toBe('cd.held.retired')
    expect(startHeld(SCHEDULES[0]!, warehouse, true)!.key).toBe('cd.held.busy')
  })

  it('checks the form as the domain does and sends what the API takes', () => {
    expect(scheduleFormProblems(NEW_FORM)).toEqual({})
    expect(Object.keys(scheduleFormProblems(BAD_FORM)).sort()).toEqual(['everyDays', 'scope'])
    expect(scheduleFormProblems({ ...NEW_FORM, siteId: null }).site!.key).toBe('cd.form.problem.site')
    expect(scheduleSaveHeld(NEW_FORM, countsCan(['inventory.counts.manage']), false)).toBeNull()
    expect(scheduleSaveHeld(NEW_FORM, countsCan([]), false)!.key).toBe('cd.held.noManage')
    expect(scheduleBodyOf(NEW_FORM)).toEqual({ siteId: NEW_FORM.siteId, name: 'Ripiano A1 ogni 10 giorni', locationId: NEW_FORM.locationId, abcClass: null, itemKind: null, everyDays: 10, nextDueOn: NEW_FORM.nextDueOn, note: null })
    expect(scheduleChangeOf(EDIT_FORM)).toMatchObject({ version: SCHEDULES[1]!.version, abcClass: 'A', everyDays: 14 })
    expect(scheduleChangeOf(EDIT_FORM)).not.toHaveProperty('siteId')
  })

  it('says a refused write in our words', () => {
    expect(scheduleProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/locationId' }])).key).toBe('cd.form.problem.place')
    expect(scheduleProblem(new ApiError('conflict', 409, 'conflict', 'x')).key).toBe('cd.form.changed')
    expect(startProblem(new ApiError('conflict', 409, 'conflict', 'x'), 'A').key).toBe('cd.start.conflict')
    expect(startProblem(new Error('x'), 'A').key).toBe('cd.start.failed')
  })

  it('finds the places one count blocks, and how many counts block now', () => {
    expect(placesOfCount(BLOCKED, 'CNT-D-0001').map((place) => place.code)).toEqual(['N-MAG-A-01', 'N-MAG-A-02'])
    expect(placesOfCount(BLOCKED, 'CNT-D-0002')).toEqual([])
    expect(countBlocked(BLOCKED)).toBe(2)
    expect(countBlocked(null)).toBe(0)
  })

  it('reads the due counts of the site and starts a schedule frozen, with its own Idempotency-Key', async () => {
    const calls: { url: string; method: string; body: unknown; key: string | null }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get('idempotency-key') })
      const body = url.includes('/due') ? { today: '2026-10-30', tiles: { overdue: 1, dueToday: 1, dueThisWeek: 3 }, rows: SCHEDULES } : { countId: 'c1', number: 'CNT-D-0010', lines: 4 }
      return new Response(JSON.stringify(body), { status: url.includes('/start') ? 201 : 200, headers: { 'content-type': 'application/json' } })
    }
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' })
    expect((await dueCounts(api, 's1')).tiles.dueThisWeek).toBe(3)
    expect((await startSchedule(api, SCHEDULES[0]!.id)).number).toBe('CNT-D-0010')
    expect(calls[0]!.url).toContain('/inventory/count-schedules/due?siteId=s1')
    expect(calls[1]).toMatchObject({ method: 'POST', body: { freeze: true } })
    expect(calls[1]!.key).toBeTruthy()
  })
})

const LEFT_KEY = /\b(?:cd|ld|sb)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const PERMISSIONS = /\b(?:inventory\.[a-z]+\.[a-z]+|inventory\.adjust)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'stock', 'lists', 'warehouse-counts', DEPTH_NAMESPACE]) }, createElement(View, { model })))
}

describe('counts depth: every W2b design case draws in both languages with no key left', () => {
  for (const screen of [countsScreen, countScreen] as unknown as DesignScreen<unknown>[]) {
    const cases = screen.cases.filter((item) => item.id.startsWith('w2b-'))
    it(`${screen.screen}: ${cases.length} W2b cases × it, en`, () => {
      expect(cases.length).toBeGreaterThan(2)
      for (const item of cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(PERMISSIONS, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('every due state and kind of material has words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [DEPTH_NAMESPACE])[DEPTH_NAMESPACE]!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const state of ['DUE_TODAY', 'DUE_SOON', 'LATER', 'RETIRED']) has(`cd.due.${state}`)
      has('cd.due.OVERDUE', { count: 2 })
      for (const kind of COUNT_ITEM_KINDS) has(`cd.scope.kind.${kind}`)
      for (const field of ['site', 'name', 'scope', 'everyDays', 'nextDueOn', 'note']) has(`cd.form.problem.${field}`, { min: 1, max: 366 })
    }
  })
})
