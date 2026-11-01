import { createElement, type ComponentType } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as scr074, FLOOR, COUPONS, FULL } from './fixtures'
import { designScreen as scr088 } from './codes/fixtures'
import { CODES, designScreen as offstd } from './offstd/fixtures'
import { designScreen as calls } from './routing/fixtures'
import { addFullLists, changeBundleRules, changeFloorRules, editOffCode, editRoute } from './w2b-api'
import {
  checksChange,
  checksDraftOf,
  checksHeld,
  couponsChange,
  couponsDraftOf,
  couponsHeld,
  escalationEdit,
  freeHelpCodes,
  fullMissing,
  kindOfCode,
  offDraftHeld,
  offWithEdit,
  offWordEdit,
  routeDraftHeld,
  routeWithEdit,
  typedCode,
  w2bProblem,
} from './w2b-model'

/**
 * Floor rules & codes, the W2b sections (B-W2b-58; design production.settings fr-rules, fr-bundle, fr-offstd, fr-calls,
 * fr-reasons): the forms' drafts and what Apply sends (only what changed, with the ONE version the site's floor rules
 * share), why each is held, a grid cell typed → the one field it saves (or why it is refused before anything is sent),
 * the API's refusals in our words, the calls as the API takes them, and the design screens SCR-074, SCR-088,
 * SCR-074-offstd and SCR-074-calls drawn in both languages with no key or placeholder left on screen.
 */

describe('Floor rules per site (fr-rules)', () => {
  it('sends only what changed, with the version and the reason; nothing changed: nothing to apply', () => {
    const draft = checksDraftOf(FLOOR)
    expect(checksChange(FLOOR, draft)).toEqual({ body: {}, count: 0 })
    expect(checksChange(FLOOR, { ...draft, skippedOperationRule: 'STRICT', reason: ' too many skips ' })).toEqual({ body: { skippedOperationRule: 'STRICT', reason: 'too many skips', version: 3 }, count: 1 })
    expect(checksChange(FLOOR, { ...draft, limitOn: true, limit: 5 }).body).toEqual({ scrapApprovalLimit: 5, version: 3 })
    expect(checksChange({ ...FLOOR, checks: { ...FLOOR.checks, scrapApprovalLimit: 5 } }, { ...draft, limitOn: false }).body).toEqual({ scrapApprovalLimit: null, version: 3 })
    expect(checksChange({ ...FLOOR, version: null }, { ...draft, quantityGuard: 'WARN' }).body).toEqual({ quantityGuard: 'WARN' })
  })

  it('a limit switched on needs 1 to 500 whole pieces', () => {
    const draft = checksDraftOf(FLOOR)
    expect(checksHeld({ ...draft, limitOn: true, limit: '' }, false)).toBe('fr.checks.limitRange')
    expect(checksHeld({ ...draft, limitOn: true, limit: 501 }, false)).toBe('fr.checks.limitRange')
    expect(checksHeld({ ...draft, limitOn: true, limit: 500 }, false)).toBeNull()
    expect(checksHeld({ ...draft, limitOn: false, limit: '' }, false)).toBeNull()
    expect(checksHeld(draft, true)).toBe('fr.busy')
  })
})

describe('Bundle codes (fr-bundle)', () => {
  it('sends the mode and the stuck hours that changed; 1 to 720 working hours', () => {
    const draft = couponsDraftOf(COUPONS)
    expect(couponsChange(COUPONS, draft).count).toBe(0)
    expect(couponsChange(COUPONS, { mode: 'COUPON_PER_OPERATION', stuckHours: 6 })).toEqual({ body: { bundleCodeMode: 'COUPON_PER_OPERATION', stuckBundleHours: 6, version: 3 }, count: 2 })
    expect(couponsHeld({ ...draft, stuckHours: 0 }, false)).toBe('fr.coupons.stuckRange')
    expect(couponsHeld({ ...draft, stuckHours: '' }, false)).toBe('fr.coupons.stuckRange')
    expect(couponsHeld({ ...draft, stuckHours: 720 }, false)).toBeNull()
  })
})

describe('the full lists and the grids', () => {
  it('counts what the full floor lists lack, per list', () => {
    expect(fullMissing(FULL)).toEqual({ total: 10, lists: [{ list: 'PAUSE', count: 2 }, { list: 'SCRAP', count: 3 }, { list: 'DOWNTIME', count: 5 }] })
    expect(fullMissing(null).total).toBe(0)
  })

  it('an off-standard word cell saves one field; blank Italian or English is refused; a language emptied is taken out', () => {
    const row = CODES[0]!
    expect(offWordEdit(row, 'labelIt', row.labelIt)).toBeNull()
    expect(offWordEdit(row, 'labelIt', ' ')).toEqual({ problem: 'fr.cells.needIt' })
    expect(offWordEdit(row, 'labelEn', 'x'.repeat(81))).toEqual({ problem: 'fr.cells.tooLong' })
    expect(offWordEdit(row, 'labelEn', ' Waiting ')).toEqual({ edit: { labelEn: 'Waiting' } })
    expect(offWordEdit(row, 'lang:ro', '')).toEqual({ edit: { labelI18n: { ro: null } } })
    expect(offWithEdit(row, { labelI18n: { ro: null } }).labelI18n).toEqual({})
    expect(offWithEdit(row, { payRule: 'UNPAID', active: false })).toMatchObject({ payRule: 'UNPAID', active: false, labelIt: row.labelIt })
  })

  it('escalation: blank is never, else 1 to 240 whole minutes; a team or waiting code picked shows at once', () => {
    const route = calls.cases[0]!.model.editor.routes![0]!
    expect(escalationEdit(route, '5')).toBeNull()
    expect(escalationEdit(route, '')).toEqual({ edit: { escalateAfterMinutes: null } })
    expect(escalationEdit(route, '241')).toEqual({ problem: 'fr.route.escalateRange' })
    expect(escalationEdit(route, '2.5')).toEqual({ problem: 'fr.route.escalateRange' })
    expect(escalationEdit(route, 15)).toEqual({ edit: { escalateAfterMinutes: 15 } })
    const teams = calls.cases[0]!.model.editor.teams!
    expect(routeWithEdit(route, { responderTeamId: null }, teams, CODES).responder).toEqual({ kind: 'TEAM_LEADERS', team: null, members: route.responder.members })
    expect(routeWithEdit(route, { responderTeamId: teams[0]!.id }, teams, CODES).responder.team?.name).toBe(teams[0]!.name)
    expect(routeWithEdit(route, { offStandardCodeId: null }, teams, CODES).waitingCode).toBeNull()
  })

  it('new rows: a code’s shape and uniqueness, a help-call code not yet a type, a kind guessed from the code', () => {
    expect(typedCode('wait for-help')).toBe('WAIT_FOR_HELP')
    const draft = { code: 'MEETING', kind: 'INDIRECT' as const, payRule: 'BASE' as const, needsApproval: true, labelIt: 'Riunione', labelEn: 'Meeting' }
    expect(offDraftHeld(draft, ['CLEANING'], false)).toBeNull()
    expect(offDraftHeld({ ...draft, code: 'CLEANING' }, ['CLEANING'], false)).toBe('fr.off.new.codeTaken')
    expect(offDraftHeld({ ...draft, code: 'x' }, [], false)).toBe('fr.off.new.codeShape')
    const editor = calls.cases[0]!.model.editor
    const free = freeHelpCodes(editor.helpCodes!, editor.routes!)
    expect(free.map((code) => code.code)).toEqual(['NEEDLE_BREAK'])
    expect(routeDraftHeld({ code: 'NEEDLE_BREAK', kind: 'MACHINE', teamId: '', escalate: '' }, free, false)).toBeNull()
    expect(routeDraftHeld({ code: 'MACHINE_STOP', kind: 'MACHINE', teamId: '', escalate: '' }, free, false)).toBe('fr.route.new.pickCode')
    expect(routeDraftHeld({ code: 'NEEDLE_BREAK', kind: 'MACHINE', teamId: '', escalate: 300 }, free, false)).toBe('fr.route.escalateRange')
    expect(kindOfCode('NEEDLE_BREAK')).toBe('MACHINE')
    expect(kindOfCode('MATERIAL_SHORT')).toBe('MATERIAL')
    expect(kindOfCode('ASK')).toBe('OTHER')
  })

  it('refusals in our words; a moved version is a conflict; a lost answer is not known', () => {
    expect(w2bProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/BOOKED_BY_CALLS', message: 'x' }]))).toEqual({ key: 'fr.refusal.BOOKED_BY_CALLS', unknown: false })
    expect(w2bProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'fr.problem.changed', unknown: false, conflict: true })
    expect(w2bProblem(new ApiError('unavailable', 503, 'network', 'x'))).toEqual({ key: 'fr.problem.offline', unknown: true })
    expect(w2bProblem(new Error('x')).unknown).toBe(true)
  })
})

describe('the calls', () => {
  function recorder(answer: unknown) {
    const sent: Array<{ method: string; path: string; body: unknown; key: string | null }> = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ method: init?.method ?? 'GET', path: new URL(String(input), 'http://x').pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get('idempotency-key') })
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    return { api, sent }
  }

  it('each write goes to its API with the version and its own key', async () => {
    const floor = recorder({ ...FLOOR, changed: true })
    await changeFloorRules(floor.api, 's1', { skippedOperationRule: 'STRICT', version: 3 }, 'k1')
    expect(floor.sent[0]).toEqual({ method: 'POST', path: '/api/production/settings/s1/floor-rules', body: { skippedOperationRule: 'STRICT', version: 3 }, key: 'k1' })
    const bundles = recorder(COUPONS)
    await changeBundleRules(bundles.api, 's1', { bundleCodeMode: 'COUPON_PER_OPERATION', version: 4 }, 'k2')
    expect(bundles.sent[0]).toMatchObject({ path: '/api/production/bundles/sites/s1/rules', key: 'k2' })
    const full = recorder({ ...FULL, added: [] })
    await addFullLists(full.api, 'k3')
    expect(full.sent[0]).toMatchObject({ method: 'POST', path: '/api/production/settings/reasons/full', key: 'k3' })
    const code = recorder({ code: CODES[0] })
    await editOffCode(code.api, 'o1', { payRule: 'BASE', version: 2 }, 'k4')
    expect(code.sent[0]).toEqual({ method: 'PATCH', path: '/api/production/offstandard/codes/o1', body: { payRule: 'BASE', version: 2 }, key: 'k4' })
    const route = recorder({ type: calls.cases[0]!.model.editor.routes![0] })
    await editRoute(route.api, 't1', { escalateAfterMinutes: null, version: 5 }, 'k5')
    expect(route.sent[0]).toEqual({ method: 'PATCH', path: '/api/production/calls/types/t1', body: { escalateAfterMinutes: null, version: 5 }, key: 'k5' })
  })
})

const TOP = /(?:^|[\s>"])fr\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*/
const PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:production\.[a-z.]+|people\.[a-z.]+|reasons\.[a-z.]+|money\.cost)\b/g

function draw(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'floor-rules', 'lists', 'reasons', 'ds-words']) }, createElement(View, { model })))
}

describe('the design screens draw in both languages with no key left on screen', () => {
  for (const screen of [scr074, scr088, offstd, calls] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = draw(screen, item.model, locale).replace(SAID, '')
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(TOP)?.[0] ?? null, `${screen.screen} ${item.id} (${locale})`).toBeNull()
          expect(html.match(PLACEHOLDER)?.[0] ?? null, `${screen.screen} ${item.id} (${locale}) placeholder`).toBeNull()
          if (locale === 'it') expect(/>(Discard|Apply|Save|Cancel)</.test(html), `${screen.screen} ${item.id}`).toBe(false)
        }
      }
    })
  }

  it('a viewer of the W2b cards reads the rules as text: no field to change', () => {
    const html = draw(scr074 as unknown as DesignScreen<unknown>, scr074.cases.find((item) => item.id === 'supervisor')!.model, 'en')
    expect(html).toContain('Sequence of operations: Warn')
    expect(html).toContain('One bundle code')
    expect(html).not.toContain('<select')
  })

  it('every literal key of the W2b sections exists in both catalogues (the dialogs draw only in a browser)', () => {
    const files = ['w2b-model.ts', 'FloorRulesPage.tsx', 'OffStandardEditor.tsx', 'RoutingEditor.tsx', 'view/W2bCards.tsx', 'view/OffStandardView.tsx', 'view/RoutingView.tsx', 'view/cells.tsx', 'view/FloorRulesView.tsx']
    const keys = new Set<string>()
    for (const file of files) {
      const source = readFileSync(join(__dirname, file), 'utf8')
      for (const match of source.matchAll(/'(fr\.[A-Za-z_.]+[A-Za-z_])'/g)) keys.add(match[1]!)
    }
    expect(keys.size).toBeGreaterThan(100)
    // The keys built from a value (grid cells draw only in a browser).
    for (const mode of ['FREE', 'WARN', 'STRICT']) for (const rule of ['sequence', 'quantity']) for (const part of ['label', 'body']) keys.add(`fr.checks.${rule}.${mode}.${part}`)
    for (const mode of ['ONE_CODE', 'COUPON_PER_OPERATION']) for (const part of ['title', 'body']) keys.add(`fr.coupons.${mode}.${part}`)
    for (const list of ['PAUSE', 'SCRAP', 'REWORK', 'DOWNTIME', 'HELP_CALL', 'ADJUSTMENT', 'HOLD', 'CANCEL']) keys.add(`fr.full.list.${list}`)
    for (const kind of ['OFF_STANDARD', 'INDIRECT']) keys.add(`fr.off.kind.${kind}`).add(`fr.off.kindHint.${kind}`)
    for (const rule of ['AVERAGE', 'BASE', 'UNPAID']) keys.add(`fr.off.pay.${rule}`).add(`fr.off.payHint.${rule}`)
    for (const field of ['needsApproval', 'active']) for (const part of ['on', 'off', 'label']) keys.add(`fr.off.${field}.${part}`).add(`fr.off.col.${field}`)
    for (const kind of ['MACHINE', 'MATERIAL', 'QUALITY', 'SUPERVISOR', 'MAINTENANCE', 'OTHER']) keys.add(`fr.route.kind.${kind}`)
    for (const tab of ['rules', 'codes', 'offstd', 'calls']) keys.add(`fr.tab.${tab}`)
    for (const code of ['KIND_FIXED', 'BOOKED_BY_CALLS', 'CODE_TAKEN', 'CODE_NOT_LISTED', 'TEAM_NOT_ACTIVE', 'WAITING_CODE']) keys.add(`fr.refusal.${code}`)
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['floor-rules'])['floor-rules'] ?? {})
      for (const key of keys) expect(t(key, { count: 2 }), `${locale}: ${key}`).not.toBe(key)
    }
  })
})
