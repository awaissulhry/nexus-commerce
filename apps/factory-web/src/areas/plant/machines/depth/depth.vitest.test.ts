import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MACHINE_DEPTH_REFUSALS } from '@nexus/factory-domain/plant/machines/status'
import { MACHINE_STATUSES } from '@nexus/factory-domain/plant/rules'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES, WINDOW_PAGES } from '../../../../shell/nav/office-nav'
import { MACHINES } from '../../_shared/fixtures'
import { designScreen as machinesScreen } from '../fixtures'
import { designScreen as machineScreen } from '../record/fixtures'
import { MACHINE_TABS } from '../view-model'
import { designScreen as wallScreen } from '../wall/fixtures'
import { changeStatus, kindFor, printTags, readDepth, readHistory, readNeeding, readTagJobs, SETTABLE } from './api'
import { FACTS, HISTORY, MONDAY, WALL } from './fixtures'
import { addDays, depthAddressOf, depthProblemOf, DUE_TONE, groupHeld, historyOf, nextCheckWords, releases, statusHeld, tagLayout, tagWords, wallTilesOf, weekStart, withDepthTerms } from './model'
import { printable, tagsHeld } from './view/TagsDialog'

/**
 * Machines in depth (B-W2b-136): the pure rules (the page's own address terms, a next check's and a tag's words, when Change
 * status is held, the week cut day by day, the wall's filter, a refusal in words, the tag to scale), the calls as the API
 * takes them, and every design case of SCR-150, SCR-150-record and SCR-150-wall drawn in Italian and English with no key and
 * no placeholder left on screen.
 */

const t = createTranslator('en', messagesFor('en', ['plant-machines'])['plant-machines']!)
const params = (text: string) => new URLSearchParams(text)

describe('machines in depth: the rules', () => {
  it('reads and writes the section and the tile filters beside the W2a terms', () => {
    expect(depthAddressOf(params('section=wall&need=ce'))).toEqual({ section: 'wall', need: 'ce' })
    expect(depthAddressOf(params('section=nonsense&need=x'))).toEqual({ section: 'machines', need: null })
    expect(withDepthTerms('?view=down', { section: 'dies', need: null })).toBe('?view=down&section=dies')
    expect(withDepthTerms('', { section: 'machines', need: 'checks' })).toBe('?need=checks')
    expect(withDepthTerms('', { section: 'machines', need: null })).toBe('')
  })

  it('says a next check with its state, a tag with its print state', () => {
    const day = (value: string) => value
    const label = (worded: { labelEn: string }) => worded.labelEn
    expect(nextCheckWords(t, FACTS[MACHINES.press.id], day, label)).toEqual({ text: 'Press guards · due 2026-10-20, 10 days ago', state: 'OVERDUE' })
    expect(nextCheckWords(t, FACTS[MACHINES.heat.id], day, label).text).toBe('Pressure vessel · 2026-11-12, in 13 days')
    expect(nextCheckWords(t, FACTS[MACHINES.sew1.id], day, label)).toEqual({ text: 'No check planned', state: null })
    expect(DUE_TONE.OVERDUE).toBe('danger')
    expect(tagWords(t, FACTS[MACHINES.sew1.id], (value) => value.slice(0, 10))).toEqual({ text: 'Printed 2026-10-03', tone: 'success' })
    expect(tagWords(t, FACTS[MACHINES.sew2.id], day)).toEqual({ text: 'Not printed', tone: 'danger' })
    expect(tagWords(t, FACTS[MACHINES.sew3.id], day).text).toBe('Never on a label printer')
  })

  it('holds Change status with its reason, a locked machine first (H1), a release for a technician only', () => {
    const can = { manage: true, signSafe: true }
    expect(statusHeld(MACHINES.sew2, { to: 'RUNNING', reason: 'Fixed it' }, can, false)).toBe('held.locked')
    expect(statusHeld(MACHINES.retired, { to: 'RUNNING', reason: 'Fixed it' }, can, false)).toBe('held.retired')
    expect(statusHeld(MACHINES.sew1, { to: null, reason: '' }, can, false)).toBe('held.pickStatus')
    expect(statusHeld(MACHINES.sew1, { to: 'RUNNING', reason: 'x' }, can, false)).toBe('held.sameStatus')
    expect(statusHeld(MACHINES.sew1, { to: 'DOWN', reason: 'ok' }, can, false)).toBe('held.reason')
    expect(statusHeld(MACHINES.sew1, { to: 'DOWN', reason: 'Motor hot' }, { manage: false, signSafe: false }, false)).toBe('held.noManage')
    const dnu = { ...MACHINES.sew1, status: 'DO_NOT_USE' as const }
    expect(releases('DO_NOT_USE', 'RUNNING')).toBe(true)
    expect(releases('RUNNING', 'DO_NOT_USE')).toBe(false)
    expect(statusHeld(dnu, { to: 'RUNNING', reason: 'Part fitted' }, { manage: true, signSafe: false }, false)).toBe('held.technician')
    expect(statusHeld(dnu, { to: 'RUNNING', reason: 'Part fitted' }, can, false)).toBeNull()
    expect(statusHeld(dnu, { to: 'RUNNING', reason: 'Part fitted' }, can, true)).toBe('held.busy')
  })

  it('cuts the week day by day in Rome and counts the time in each status', () => {
    expect(weekStart('2026-10-30')).toBe('2026-10-26')
    expect(weekStart('2026-10-26')).toBe('2026-10-26')
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    const { days, minutes } = historyOf(HISTORY, MONDAY, 7, 'Europe/Rome')
    expect(days.map((day) => day.date)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
    expect(days[0]!.spans.map((span) => span.status)).toEqual(['RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'RUNNING'])
    expect(days[2]!.spans.at(-1)).toMatchObject({ status: 'DO_NOT_USE', reason: 'Protezione incrinata: in attesa del ricambio (dato di prova)' })
    expect(days[5]!.spans).toEqual([])
    expect(minutes.DOWN).toBe(30)
    expect(minutes.DO_NOT_USE).toBe(20 * 60 + 40)
  })

  it('filters the wall by status and keeps only lines with a tile', () => {
    // B-W2b-F17: the fixture is the API's shape — one group per line and ONE line-less group per site (StatusWall's key).
    const keys = WALL.lines.map((line) => line.line?.id ?? `site-${line.siteCode}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const line of WALL.lines) expect(line.machines.map((tile) => tile.assetNumber)).toEqual(line.machines.map((tile) => tile.assetNumber).sort())
    expect(wallTilesOf(WALL.lines, 'ALL').flatMap((line) => line.machines)).toHaveLength(8)
    const down = wallTilesOf(WALL.lines, 'NOT_RUNNING')
    expect(down.flatMap((line) => line.machines.map((tile) => tile.status))).toEqual(['DO_NOT_USE', 'DOWN', 'UNDER_MAINTENANCE'])
    expect(down).toHaveLength(1)
    expect(wallTilesOf(WALL.lines, 'DOWN')[0]!.machines[0]!.assetNumber).toBe(MACHINES.sew3.assetNumber)
  })

  it('files a picked file by its group, and says this step\'s refusals in its own words', () => {
    expect(groupHeld('MANUAL', 'image/jpeg')).toBe('docs.held.manualPdf')
    expect(groupHeld('PHOTO', 'application/pdf')).toBe('docs.held.photoImage')
    expect(groupHeld('MACHINE_CE', 'image/png')).toBeNull()
    expect(kindFor('MACHINE_CE', 'image/png')).toBe('CERTIFICATE')
    expect(kindFor('OTHER', 'image/png')).toBe('PHOTO')
    expect(kindFor('MANUAL', 'application/pdf')).toBe('DOCUMENT')
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/LOCKED_UNSAFE', message: 'English' }, { path: 'fix', message: 'English' }])
    expect(depthProblemOf(refused)).toEqual({ key: 'depth:refusal.LOCKED_UNSAFE' })
    expect(depthProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'problem.forbidden' })
  })

  it('prints only the machines in use at the printer\'s site, and says why Print waits', () => {
    const machines = [
      { id: 'a', assetNumber: 'A', typeWords: 'x', placeWords: 'y', siteId: 's1', retired: false },
      { id: 'b', assetNumber: 'B', typeWords: 'x', placeWords: 'y', siteId: 's2', retired: false },
      { id: 'c', assetNumber: 'C', typeWords: 'x', placeWords: 'y', siteId: 's1', retired: true },
    ]
    const printers = { status: 'ready' as const, value: [{ id: 'p1', code: 'LBL-01', name: 'L', siteId: 's1', siteCode: 'S1', labelWidthMm: 100, labelHeightMm: 50, dpi: 203 }] }
    const state = { machines, printers, printerId: 'p1', copies: 1, busy: false, problem: null, result: null, retrying: null }
    expect(printable(state).map((machine) => machine.id)).toEqual(['a'])
    expect(tagsHeld(state, true)).toBeNull()
    expect(tagsHeld(state, false)).toBe('tags.held.noRight')
    expect(tagsHeld({ ...state, printerId: null }, true)).toBe('tags.held.pickPrinter')
    expect(tagsHeld({ ...state, printers: { status: 'ready', value: [] } }, true)).toBe('tags.held.noPrinter')
    expect(tagsHeld({ ...state, machines: [machines[2]!] }, true)).toBe('tags.held.none')
    const layout = tagLayout(t, { assetNumber: 'DEMO-SEW-01', typeWords: 'Lockstitch', placeWords: 'STAB-N · SEW-02' }, { widthMm: 76, heightMm: 51 })
    expect(layout).toMatchObject({ widthMm: 76, heightMm: 51 })
    expect(JSON.stringify(layout)).toContain('"kind":"qr","value":"DEMO-SEW-01"')
    expect(JSON.stringify(layout)).toContain('Scan to report a problem')
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

describe('machines in depth: the calls as the API takes them', () => {
  it('reads the depth, a tile\'s machines, the history and the tag jobs with the API\'s own terms', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { tiles: { checksOverdue: 1, noCe: 3 }, machines: Object.values(FACTS), today: '2026-10-30' } },
      { status: 200, body: { machines: [MACHINES.press], nextCursor: null } },
      { status: 200, body: HISTORY },
      { status: 200, body: { jobs: [] } },
    ])
    const depth = await readDepth(api, 's1', ['a', 'b'])
    expect(depth.tiles).toEqual({ checksOverdue: 1, noCe: 3 })
    expect(calls[0]!.url).toBe('/api/plant/machines/depth?siteId=s1&ids=a%2Cb')
    await readNeeding(api, { siteId: null, need: 'CHECKS', limit: 50 })
    expect(calls[1]!.url).toBe('/api/plant/machines/attention?need=CHECKS&limit=50')
    await readHistory(api, 'm1', '2026-10-26', 7)
    expect(calls[2]!.url).toBe('/api/plant/machines/m1/status-history?from=2026-10-26&days=7')
    expect(await readTagJobs(api, [])).toEqual([])
    await readTagJobs(api, ['m1'])
    expect(calls[3]!.url).toBe('/api/plant/machines/tags/jobs?ids=m1')
  })

  it('changes a status and prints tags as commands with their key', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { machine: { ...MACHINES.sew1, status: 'DOWN' }, replayed: false } },
      { status: 200, body: { jobs: [], refused: [] } },
    ])
    expect((await changeStatus(api, MACHINES.sew1.id, { version: 3, to: 'DOWN', reason: 'Motor hot' }, 'key-1')).status).toBe('DOWN')
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/plant/machines/${MACHINES.sew1.id}/status`, body: { version: 3, to: 'DOWN', reason: 'Motor hot' } })
    expect(calls[0]!.headers.get('idempotency-key')).toBe('key-1')
    await printTags(api, { printerId: 'p1', machineIds: ['a', 'b'], copies: 2, language: 'it' }, 'key-2')
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/api/plant/machines/tags/print', body: { printerId: 'p1', machineIds: ['a', 'b'], copies: 2, language: 'it' } })
    expect(calls[1]!.headers.get('idempotency-key')).toBe('key-2')
    expect([...SETTABLE]).toEqual(['RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE'])
  })
})

const LEFT_KEY = /\b(?:common|section|tab|tile|tileHint|need|col|due|depth|printState|held|keys|wall|status|stepUp|refusal|docs|history|tag|tags|machineStatus|machineTab|machines|machine|record|problem)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose; file names and domains are not keys. */
const SAID = /\b(?:plant\.[a-zA-Z.]+|[a-z0-9-]+\.(?:pdf|jpg|png))\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'plant']) }, createElement(View, { model })))
}

describe('every design case of machines in depth draws in both languages with no key left on screen', () => {
  for (const screen of [machinesScreen, machineScreen, wallScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages (statuses, groups, print states, refusals)', () => {
    for (const locale of LOCALES) {
      const words = createTranslator(locale, messagesFor(locale, ['plant-machines'])['plant-machines']!)
      const has = (key: string) => expect(words(key), `${locale}: ${key}`).not.toBe(key)
      for (const code of MACHINE_DEPTH_REFUSALS) has(`refusal.${code}`)
      for (const status of SETTABLE) {
        has(`status.choice.${status}`)
        has(`status.choiceHint.${status}`)
      }
      for (const state of ['QUEUED', 'SENT', 'PRINTED', 'FAILED']) has(`printState.${state}`)
      for (const group of ['MACHINE_CE', 'MANUAL', 'PHOTO', 'OTHER']) has(`docs.group.${group}`)
      for (const tab of MACHINE_TABS.filter((entry) => entry !== 'overview' && entry !== 'history')) has(`tab.${tab}`)
      expect(MACHINE_STATUSES).toContain('DO_NOT_USE')
    }
  })

  it('the wall\'s own tab is a built window page', () => {
    expect(OFFICE_PAGES.has('/plant/machines/wall')).toBe(true)
    expect(WINDOW_PAGES.has('/plant/machines/wall')).toBe(true)
  })
})
