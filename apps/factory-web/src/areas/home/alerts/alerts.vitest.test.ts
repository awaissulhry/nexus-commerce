import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ALERT_TEMPLATES, ALERT_TILES } from '@nexus/factory-domain/alerts/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as automationScreen } from '../../admin/automation/fixtures'
import { MODULE_TIMERS, viewOf, viewOfKey, automationAddress } from '../../admin/automation/model'
import { designScreen } from './fixtures'
import { actionHeld, alertSentence, alertsAddress, alertsKeys, bulkRows, controlsOf, historyWords, noteHeld, refusalOf, selectHeld, stateWords, updatesBetween, verbHeld } from './model'

/** Home › Alerts (SCR-234) and Admin › Approvals, automation & AI (SCR-167): the rules, the words, every design case. */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const en = createTranslator('en', CATALOGUE.en['home-alerts'] ?? {})
const it_ = createTranslator('it', CATALOGUE.it['home-alerts'] ?? {})
const params = (pairs: Record<string, string>) => ({ get: (name: string) => pairs[name] ?? null })

describe('Alerts’ rules', () => {
  it('the address: tile, severity, kind (or the API’s ruleKind), search, the open alert, the rule dialog', () => {
    expect(controlsOf(params({}))).toEqual({ tile: null, severity: null, kind: null, q: '', open: null, rule: null })
    expect(controlsOf(params({ tile: 'CRITICAL', severity: 'INFO', ruleKind: 'HOLD_TOO_LONG', q: 'SO', open: 'a1', rule: 'new' }))).toEqual({ tile: 'CRITICAL', severity: 'INFO', kind: 'HOLD_TOO_LONG', q: 'SO', open: 'a1', rule: 'new' })
    expect(controlsOf(params({ tile: 'LATER', severity: 'LOUD', kind: 'NOPE' }))).toMatchObject({ tile: null, severity: null, kind: null })
    expect(alertsAddress({ tile: 'OPEN_FOR_ME', severity: null, kind: 'MATERIAL_SHORT', q: ' wo ', open: 'a1', rule: null })).toBe('?tile=OPEN_FOR_ME&kind=MATERIAL_SHORT&q=wo&open=a1')
    expect(alertsAddress({ tile: null, severity: null, kind: null, q: '', open: null, rule: null })).toBe('')
  })

  it('Acknowledge N reaches only open alerts the person may handle; each held row and verb says why', () => {
    const rows = [
      { id: 'a', state: 'OPEN' as const, verbs: ['ACKNOWLEDGE', 'ASSIGN', 'SNOOZE', 'RESOLVE'] as const },
      { id: 'b', state: 'ACKNOWLEDGED' as const, verbs: ['ASSIGN', 'SNOOZE', 'RESOLVE'] as const },
      { id: 'c', state: 'RESOLVED' as const, verbs: [] as const },
      { id: 'd', state: 'OPEN' as const, verbs: [] as const },
    ].map((row) => ({ ...row, verbs: [...row.verbs] }))
    expect(bulkRows(rows, ['a', 'b', 'c', 'd']).map((row) => row.id)).toEqual(['a'])
    expect(rows.map(selectHeld)).toEqual([null, 'held.rowAcknowledged', 'held.rowResolved', 'held.rowReadOnly'])
    expect(verbHeld(rows[1]!, 'ACKNOWLEDGE', null)).toBe('held.acknowledged')
    expect(verbHeld(rows[2]!, 'RESOLVE', null)).toBe('held.resolved')
    expect(verbHeld(rows[3]!, 'ASSIGN', null)).toBe('held.noHandleHere')
    expect(verbHeld(rows[0]!, 'ASSIGN', 'held.offline')).toBe('held.offline')
    expect(actionHeld({ can: { handle: false }, live: 'live', busy: false })).toBe('held.noHandle')
    expect(actionHeld({ can: { handle: true }, live: 'offline', busy: false })).toBe('held.offline')
    expect(actionHeld({ can: { handle: true }, live: 'live', busy: true })).toBe('held.busy')
    expect(actionHeld({ can: { handle: true }, live: 'live', busy: false })).toBeNull()
  })

  it('live: a fresh read waits behind "N updates" when rows are new, changed or gone', () => {
    expect(updatesBetween([{ id: 'a', version: 1 }, { id: 'b', version: 1 }], [{ id: 'a', version: 2 }, { id: 'c', version: 1 }])).toBe(3)
    expect(updatesBetween([{ id: 'a', version: 1 }], [{ id: 'a', version: 1 }])).toBe(0)
  })

  it('a refusal in words, and whether the list is read again', () => {
    const error = (kind: ApiError['kind'], status: number, path?: string) => new ApiError(kind, status, 'x', 'x', null, path ? [{ path }] : [])
    expect(refusalOf(error('conflict', 409, 'alert/RESOLVED'))).toEqual({ key: 'refusal.RESOLVED', reload: true })
    expect(refusalOf(error('conflict', 409, 'body/items/1/ALREADY_ACKNOWLEDGED'))).toEqual({ key: 'refusal.ALREADY_ACKNOWLEDGED', reload: true })
    expect(refusalOf(error('conflict', 409, 'version'))).toEqual({ key: 'refusal.changed', reload: true })
    expect(refusalOf(error('invalid', 400, 'body/assigneeId'))).toEqual({ key: 'refusal.assignee', reload: false })
    expect(refusalOf(error('invalid', 400, 'body/until'))).toEqual({ key: 'refusal.until', reload: false })
    expect(refusalOf(error('invalid', 400, 'body/note'))).toEqual({ key: 'refusal.note', reload: false })
    expect(refusalOf(error('forbidden', 403))).toEqual({ key: 'refusal.forbidden', reload: false })
    expect(refusalOf(error('not_found', 404))).toEqual({ key: 'refusal.gone', reload: true })
    expect(noteHeld('  ')).toBe('resolve.noteEmpty')
    expect(noteHeld('x'.repeat(1001))).toBe('resolve.noteLong')
    expect(noteHeld('Called the supplier.')).toBeNull()
  })

  it('its keys live in the list footer’s info icon: d acknowledges (the frame adds the rest)', () => {
    expect(alertsKeys(en)).toEqual([{ keys: ['d'], does: 'Acknowledge the alert' }])
  })
})

describe('an alert in the reader’s words', () => {
  it('every phrase factory-domain raises has its words here, in English exactly the domain’s, in Italian with the same places', () => {
    for (const [key, words] of Object.entries(ALERT_TEMPLATES)) {
      expect(CATALOGUE.en['home-alerts']?.[`w.${key}`], key).toBe(words.en)
      expect(CATALOGUE.it['home-alerts']?.[`w.${key}`], key).toBe(words.it)
    }
  })

  it('dates the reader’s way; an unknown phrase still says which record', () => {
    const alert = { record: { type: 'Certificate', id: 'c', label: 'CERT-1' }, words: { key: 'alerts.CERTIFICATE_EXPIRING', params: { label: 'CERT-1', dueDate: '2026-11-20', days: 20 } } }
    expect(alertSentence(alert, en, 'en')).toMatch(/^Certificate CERT-1 expires on .*20.*\(20 days left\)\.$/)
    expect(alertSentence(alert, it_, 'it')).toBe('Il certificato CERT-1 scade il 20/11/2026 (mancano 20 giorni).')
    expect(alertSentence({ ...alert, words: { key: 'alerts.SOMETHING_NEW', params: {} } }, en, 'en')).toBe('Alert on CERT-1.')
  })

  it('the history names the actor inside the one alert; the system says it plainly', () => {
    const me = { id: 'm', name: 'Alex', me: true }
    const bea = { id: 'b', name: 'Bea', me: false }
    const at = '2026-10-30T09:00:00.000Z'
    expect(historyWords({ verb: 'RAISED', at, actor: null, assignee: null, snoozedUntil: null, note: null }, en, 'en')).toBe('Raised by its rule')
    expect(historyWords({ verb: 'ASSIGNED', at, actor: me, assignee: bea, snoozedUntil: null, note: null }, en, 'en')).toBe('Given to Bea by you')
    expect(historyWords({ verb: 'RESOLVED', at, actor: null, assignee: null, snoozedUntil: null, note: null }, it_, 'it')).toBe('Chiuso da Nexus: la condizione non c’è più'.replace('’', "'"))
    expect(historyWords({ verb: 'ACKNOWLEDGED', at, actor: me, assignee: null, snoozedUntil: null, note: null }, it_, 'it')).toBe('Preso in carico da te')
    expect(stateWords({ state: 'RESOLVED', snoozed: null, resolved: { at, resolution: 'CLEARED', by: null, note: null } }, en, 'en')).toBe('Cleared')
  })
})

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
}
const PREFIXES = ['refused', 'band', 'live', 'tile', 'filter', 'table', 'col', 'row', 'place', 'person', 'age', 'state', 'bulk', 'more', 'empty', 'error', 'keys', 'popup', 'history', 'assign', 'resolve', 'notice', 'held', 'refusal', 'problem', 'rules']
const has = (namespace: string, key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale][namespace] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('every string exists in it and en', () => {
  for (const namespace of ['home-alerts', 'admin-automation']) {
    it(`${namespace}: the same keys and placeholders in both languages, no empty text`, () => {
      const enc = CATALOGUE.en[namespace] ?? {}
      const itc = CATALOGUE.it[namespace] ?? {}
      expect(Object.keys(enc).length).toBeGreaterThan(30)
      expect(Object.keys(itc).sort()).toEqual(Object.keys(enc).sort())
      for (const key of Object.keys(enc)) {
        expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
        expect(placeholdersOf(itc[key] ?? ''), key).toEqual(placeholdersOf(enc[key] ?? ''))
      }
    })
  }

  it('every key the Alerts page names exists (literally or built from the API’s codes)', () => {
    const pattern = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
    const keys = new Set<string>()
    for (const file of sources(HERE)) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
    for (const tile of ALERT_TILES) keys.add(`tile.${tile}.label`).add(`tile.${tile}.hint`)
    for (const code of ['RESOLVED', 'ALREADY_ACKNOWLEDGED', 'ALREADY_ASSIGNED', 'NOT_ASSIGNED']) keys.add(`refusal.${code}`)
    for (const state of ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLEARED']) keys.add(`state.${state}`)
    expect(keys.size).toBeGreaterThan(60)
    expect([...keys].filter((key) => !has('home-alerts', key))).toEqual([])
  })
})

const LEFT_KEY = /\b(?:refused|band|live|tile|filter|table|col|row|place|person|age|state|bulk|held|more|empty|error|keys|popup|history|assign|resolve|notice|refusal|problem|rules|views|timers|module|later|kind|when|sentence|unit|unitWord|field|severity|goesTo|dialog|test|list|recipient|channels|w)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*/

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model })))
  for (const screen of [designScreen as DesignScreen<unknown>, automationScreen as DesignScreen<unknown>]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the states the design names, made-up data only, no amount and no address', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const wanted of ['open', 'tile-for-me', 'selected', 'popup', 'assign', 'resolve', 'snooze', 'rule', 'rule-date', 'rule-new', 'updates', 'read-only', 'offline', 'empty', 'loading', 'error', 'no-permission']) expect(ids).toContain(wanted)
    const admin = automationScreen.cases.map((entry) => entry.id)
    for (const wanted of ['timers', 'rule', 'rule-new', 'read-only', 'offline', 'empty', 'loading', 'error', 'no-permission']) expect(admin).toContain(wanted)
    const text = JSON.stringify([designScreen.cases, automationScreen.cases])
    expect(text).not.toMatch(/@[a-z0-9-]+\.(com|it|net)/i)
    expect(text).not.toMatch(/€|EUR/)
  })

  it('no key hint above the list; the rules list follows the open alerts', () => {
    const html = render(designScreen as DesignScreen<unknown>, designScreen.cases.find((entry) => entry.id === 'open')!.model, 'en')
    expect(html.slice(0, html.indexOf('fw-list'))).not.toMatch(/<kbd/i)
    expect(html).toContain('Keyboard keys of this list')
    // The rule dialog draws in a portal (not in a server render): RuleSentence is tested on its own (rules.vitest).
    expect(html).toContain('Exception rules')
  })
})

describe('Admin › Approvals, automation & AI', () => {
  it('only Reminders & timers is built: the other lists never open; keys 1–5 switch only to a built one', () => {
    expect([viewOf(null), viewOf('approvals'), viewOf('ai'), viewOf('timers')]).toEqual(['timers', 'timers', 'timers', 'timers'])
    expect([viewOfKey('1'), viewOfKey('2'), viewOfKey('5'), viewOfKey('9')]).toEqual([null, 'timers', null, null])
    expect(automationAddress({ view: 'timers', rule: 'new' })).toBe('?rule=new')
  })

  it('the reminders the modules keep: the payment ladder (the rules’ own timer kinds are not listed twice)', () => {
    expect(MODULE_TIMERS).toContain('PAYMENT_REMINDER')
    expect(MODULE_TIMERS).not.toContain('CERTIFICATE_EXPIRY')
    expect(MODULE_TIMERS).not.toContain('INVOICE_DEADLINE')
  })
})
