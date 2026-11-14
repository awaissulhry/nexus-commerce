import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MAPPING_REFUSALS as DOMAIN_REFUSALS } from '@nexus/factory-domain/accounting/mapping/contracts'
import { ACCOUNT_CODE as DOMAIN_ACCOUNT, MAPPING_KINDS as DOMAIN_KINDS, MAPPING_NOTE_MAX as DOMAIN_NOTE_MAX } from '@nexus/factory-domain/accounting/mapping/keys'
import { createApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { ACCOUNT_CODE, addMapping, changeMapping, getMapping, MAPPING_KINDS, MAPPING_NOTE_MAX, MAPPING_REFUSALS, removeMapping, saveSettings } from './api'
import { JOURNALS_ON, LEATHER, MAPPING_ANSWER, MAPPING_TODAY, OLD_RATE, SALES_FREIGHT } from './demo/fixtures'
import { designScreen } from './fixtures'
import {
  accountHeld,
  addBody,
  addHeld,
  bulkHeld,
  changeHeld,
  keyId,
  keyOfOpen,
  keysOf,
  mappingAddressOf,
  mappingCanOf,
  mappingCsv,
  mappingHref,
  mappingTouches,
  removeHeld,
  switchBody,
  switchConsequences,
  switchHeld,
  viewCounts,
  writeProblem,
} from './model'

/**
 * B-W2b-426 — Account mapping (SCR-480): the lists equal factory-domain's, the pure rules (rights, the address, the views
 * and their counts, what holds a new row, a change, a removal, Map N keys and the switch; the CSV; refusals as words; live),
 * the calls as the API takes them, the page and record links, and every design case drawn in Italian and English with no
 * message key or placeholder left on screen.
 */

const can = { manage: true }
const facts = { today: MAPPING_TODAY, can, busy: false }

describe('the lists mirror factory-domain', () => {
  it('kinds, refusals, the account shape, the note', () => {
    expect(MAPPING_KINDS).toEqual(DOMAIN_KINDS)
    expect(MAPPING_REFUSALS).toEqual(DOMAIN_REFUSALS)
    expect(ACCOUNT_CODE.source).toBe(DOMAIN_ACCOUNT.source)
    expect(MAPPING_NOTE_MAX).toBe(DOMAIN_NOTE_MAX)
  })
})

describe('who may do what', () => {
  it('reads with accounting.view; the API’s answer decides managing and switching once read', () => {
    expect(mappingCanOf(['accounting.view'])).toEqual({ view: true, manage: false, switch: false })
    expect(mappingCanOf(['accounting.view', 'accounting.mapping.manage', 'accounting.journals.switch'])).toEqual({ view: true, manage: true, switch: true })
    expect(mappingCanOf(['accounting.view', 'accounting.mapping.manage'], { can: { manage: false }, journals: { ...JOURNALS_ON, can: { switch: true } } })).toEqual({ view: true, manage: false, switch: true })
  })
})

describe('the address and the views', () => {
  it('kind, view, search and the key open; bad values fall back', () => {
    expect(mappingAddressOf(null)).toEqual({ kind: null, view: 'all', q: '', open: null })
    expect(mappingAddressOf(new URLSearchParams('kind=TAX_CODE&view=unmapped&q=iva&open=TAX_CODE%2F22'))).toEqual({ kind: 'TAX_CODE', view: 'unmapped', q: 'iva', open: 'TAX_CODE/22' })
    expect(mappingAddressOf(new URLSearchParams('kind=NOPE&view=everything'))).toMatchObject({ kind: null, view: 'all' })
    expect(mappingHref('/w/DEMO', { kind: 'ITEM_GROUP', view: 'all', open: 'ITEM_GROUP/LEATHER' })).toBe('/w/DEMO/finance/accounting/mapping?kind=ITEM_GROUP&open=ITEM_GROUP%2FLEATHER')
    expect(mappingHref('/w/DEMO')).toBe('/w/DEMO/finance/accounting/mapping')
  })

  it('the key open: by KIND/KEY (a check’s fix) or by a row’s id (an audit row)', () => {
    expect(keyOfOpen(MAPPING_ANSWER.keys, 'ITEM_GROUP/LEATHER')).toBe(LEATHER)
    expect(keyOfOpen(MAPPING_ANSWER.keys, LEATHER.upcoming[0]!.id)).toBe(LEATHER)
    expect(keyOfOpen(MAPPING_ANSWER.keys, 'ITEM_GROUP/NOPE')).toBeNull()
  })

  it('views: keys Nexus posts, without an account, changing soon, and the rows kept apart; counts within a kind', () => {
    expect(viewCounts(MAPPING_ANSWER.keys, null)).toEqual({ all: 23, unmapped: 4, upcoming: 2, other: 1 })
    expect(viewCounts(MAPPING_ANSWER.keys, 'TAX_CODE')).toEqual({ all: 4, unmapped: 1, upcoming: 0, other: 1 })
    expect(keysOf(MAPPING_ANSWER.keys, { kind: null, view: 'other', q: '' })).toEqual([OLD_RATE])
    expect(keysOf(MAPPING_ANSWER.keys, { kind: null, view: 'all', q: 'pelli' }).map(keyId)).toEqual(['ITEM_GROUP/LEATHER'])
    expect(keysOf(MAPPING_ANSWER.keys, { kind: null, view: 'all', q: '6105' }).map(keyId)).toEqual(['ITEM_GROUP/LEATHER'])
  })
})

describe('what holds a change (held, never greyed out)', () => {
  const draft = (over = {}) => ({ accountCode: '6107', validFrom: '2026-12-15', note: '', ...over })
  it('a new row: the permission, a key Nexus does not post, the account, the day, a backdated change, a second row on a day', () => {
    expect(addHeld(LEATHER, draft(), facts)).toBeNull()
    expect(addHeld(LEATHER, draft(), { ...facts, can: { manage: false } })).toEqual({ key: 'mapping.held.noManage' })
    expect(addHeld(OLD_RATE, draft(), facts)).toEqual({ key: 'mapping.held.notPosted' })
    expect(addHeld(LEATHER, draft({ accountCode: ' ' }), facts)).toEqual({ key: 'mapping.held.account' })
    expect(addHeld(LEATHER, draft({ accountCode: '-60 01' }), facts)).toEqual({ key: 'mapping.held.accountShape' })
    expect(addHeld(LEATHER, draft({ validFrom: '2026-13-01' }), facts)).toEqual({ key: 'mapping.held.day' })
    expect(addHeld(LEATHER, draft({ validFrom: '2026-10-01' }), facts)).toEqual({ key: 'mapping.held.backdated' })
    expect(addHeld(LEATHER, draft({ validFrom: '2026-12-01' }), facts)).toEqual({ key: 'mapping.held.sameDay' })
    expect(addHeld(LEATHER, draft({ validFrom: MAPPING_TODAY }), facts)).toBeNull()
    // A key's first row may start earlier: it fills what had no account.
    expect(addHeld(SALES_FREIGHT, draft({ validFrom: '2026-01-01' }), facts)).toBeNull()
    expect(addHeld(SALES_FREIGHT, draft({ note: 'x'.repeat(501) }), facts)).toEqual({ key: 'mapping.held.note', params: { max: 500 } })
    expect(addBody('c1', SALES_FREIGHT, { accountCode: ' 4005 ', validFrom: '2026-01-01', note: '  ' })).toEqual({ companyId: 'c1', kind: 'ITEM_GROUP', key: 'SALES_FREIGHT', accountCode: '4005', validFrom: '2026-01-01' })
    expect(accountHeld('60.01/02_a')).toBeNull()
  })

  it('an upcoming row is changed or removed before its day; a row in force is fixed', () => {
    const upcoming = LEATHER.upcoming[0]!
    const current = LEATHER.current!
    expect(changeHeld(upcoming, { accountCode: '6106', note: '' }, { can, busy: false })).toBeNull()
    expect(changeHeld(upcoming, { accountCode: upcoming.accountCode, note: upcoming.note ?? '' }, { can, busy: false })).toEqual({ key: 'mapping.held.nothingChanges' })
    expect(changeHeld(current, { accountCode: '6106', note: '' }, { can, busy: false })).toEqual({ key: 'mapping.held.fixed', params: { day: current.validFrom } })
    expect(removeHeld(upcoming, { can, busy: false })).toBeNull()
    expect(removeHeld(current, { can, busy: false })).toEqual({ key: 'mapping.held.fixed', params: { day: current.validFrom } })
    expect(removeHeld(upcoming, { can: { manage: false }, busy: false })).toEqual({ key: 'mapping.held.noManage' })
  })

  it('Map N keys: the keys Nexus does not post left out, keys mapped already from today or later, one row a day', () => {
    const three = MAPPING_ANSWER.keys.filter((entry) => ['TEXTILE', 'LINING', 'HARDWARE'].includes(entry.key))
    expect(bulkHeld(three, draft({ validFrom: '2026-11-01' }), facts)).toBeNull()
    expect(bulkHeld([], draft(), facts)).toEqual({ key: 'mapping.held.noneChosen' })
    expect(bulkHeld([...three, OLD_RATE], draft(), facts)).toEqual({ key: 'mapping.held.bulkNotPosted', params: { count: 1 } })
    expect(bulkHeld(three, draft({ validFrom: '2026-10-01' }), facts)).toEqual({ key: 'mapping.held.bulkBackdated', params: { count: 3 } })
    expect(bulkHeld([SALES_FREIGHT], draft({ validFrom: '2026-10-01' }), facts)).toBeNull()
    expect(bulkHeld(three, draft({ validFrom: '2026-01-01' }), facts)).toEqual({ key: 'mapping.held.bulkBackdated', params: { count: 3 } })
    expect(bulkHeld([LEATHER], draft({ validFrom: '2026-12-01' }), facts)).toEqual({ key: 'mapping.held.bulkSameDay', params: { count: 1 } })
  })

  it('the journals switch: its permission, what it does, the body (the company row’s version only)', () => {
    expect(switchHeld({ reason: '', busy: false }, { switch: true })).toBeNull()
    expect(switchHeld({ reason: '', busy: false }, { switch: false })).toEqual({ key: 'journals.held.noSwitch' })
    expect(switchConsequences(MAPPING_ANSWER.journals, 4).map((entry) => entry.key)).toEqual(['journals.on.what', 'journals.on.checks', 'journals.on.unmapped', 'journals.on.gate'])
    expect(switchConsequences(JOURNALS_ON, 4).map((entry) => entry.key)).toEqual(['journals.off.what', 'journals.off.handedOver'])
    expect(switchBody('c1', MAPPING_ANSWER.journals, '  confermata ')).toEqual({ companyId: 'c1', journalsOn: true, reason: 'confermata' })
    expect(switchBody('c1', JOURNALS_ON, '')).toEqual({ companyId: 'c1', journalsOn: false, version: 2 })
  })
})

describe('the CSV for the accountant (a file a person downloads)', () => {
  it('semicolons, headers in words, the account today and the next one', () => {
    const csv = mappingCsv([LEATHER, OLD_RATE], { headers: ['Kind', 'Key', 'What', 'Account', 'Since', 'Next', 'From', 'Note'], kind: (kind) => kind.toLowerCase(), notPosted: 'not posted' }, 'it')
    expect(csv.split('\r\n')).toEqual([
      'Kind;Key;What;Account;Since;Next;From;Note',
      'item_group;LEATHER;Acquisto pelli;6101;2026-04-01;6105;2026-12-01;Conto unico pelli dal secondo trimestre.',
      'tax_code;22;not posted;2201;2026-01-01;;;',
      '',
    ])
  })
})

describe('the API’s refusals in words; live', () => {
  const refused = (kind: ConstructorParameters<typeof ApiError>[0], status: number, path: string) => new ApiError(kind, status, 'x', 'x', null, [{ path, message: 'English words the screen never shows' }])
  it('fixed, backdated, same day, a key no longer posted, a moved row, the step-up', () => {
    expect(writeProblem(refused('conflict', 409, 'problem/BACKDATED'))).toEqual({ key: 'mapping.refusal.BACKDATED', reload: true })
    expect(writeProblem(refused('conflict', 409, 'problem/NOTHING_CHANGES'))).toEqual({ key: 'mapping.refusal.NOTHING_CHANGES', reload: false })
    expect(writeProblem(refused('invalid', 400, 'body/key'))).toEqual({ key: 'mapping.refusal.UNKNOWN_KEY', reload: true })
    expect(writeProblem(refused('invalid', 400, 'body/accountCode'))).toEqual({ key: 'mapping.held.accountShape', reload: false })
    expect(writeProblem(refused('conflict', 409, 'body/version'))).toEqual({ key: 'problem.write.moved', reload: true })
    expect(writeProblem(new ApiError('step_up', 403, 'forbidden', 'x'))).toEqual({ key: 'problem.write.step_up', reload: false })
    expect(mappingTouches({ type: 'account_mapping.changed' })).toBe(true)
    expect(mappingTouches({ type: 'accounting_settings.changed' })).toBe(true)
    expect(mappingTouches({ type: 'accounting_export.exported' })).toBe(false)
  })
})

describe('the calls', () => {
  const recording = (answer: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      csrfToken: () => 'csrf',
    })
    return { api, calls }
  }

  it('reads the mapping, adds, changes and removes a row, switches the journals — each write with its Idempotency-Key', async () => {
    const read = recording(MAPPING_ANSWER)
    await getMapping(read.api, 'c1')
    expect(read.calls[0]!.url).toBe('http://api.test/accounting/mapping?companyId=c1')
    const added = recording({ row: LEATHER.upcoming[0] })
    await addMapping(added.api, { companyId: 'c1', kind: 'ITEM_GROUP', key: 'LEATHER', accountCode: '6105', validFrom: '2026-12-01' }, 'key-1')
    expect(added.calls[0]!.init.method).toBe('POST')
    expect(new Headers(added.calls[0]!.init.headers).get('idempotency-key')).toBe('key-1')
    const changed = recording({ row: LEATHER.upcoming[0] })
    await changeMapping(changed.api, 'r1', { version: 1, accountCode: '6106', note: null }, 'key-2')
    expect([changed.calls[0]!.init.method, changed.calls[0]!.url, JSON.parse(String(changed.calls[0]!.init.body))]).toEqual(['PATCH', 'http://api.test/accounting/mapping/r1', { version: 1, accountCode: '6106', note: null }])
    const removed = recording({ removed: 'r1' })
    expect(await removeMapping(removed.api, 'r1', 3, 'key-3')).toBe('r1')
    expect([removed.calls[0]!.init.method, removed.calls[0]!.url]).toEqual(['DELETE', 'http://api.test/accounting/mapping/r1?version=3'])
    const switched = recording({ settings: { ...JOURNALS_ON, words: 'English' } })
    const settings = await saveSettings(switched.api, { companyId: 'c1', journalsOn: true, reason: 'r' }, 'key-4')
    expect(settings.journalsOn).toBe(true)
    expect([switched.calls[0]!.init.method, switched.calls[0]!.url]).toEqual(['PUT', 'http://api.test/accounting/settings'])
  })
})

describe('the page and record links', () => {
  it('the page is built; a key a check names and a mapping row open it (no list page: the mapping has no navigation row)', () => {
    expect(OFFICE_PAGES.has('/finance/accounting/mapping')).toBe(true)
    expect(recordAddress({ type: 'AccountMapping', id: 'ITEM_GROUP/LEATHER' }, OFFICE_PAGES)).toBe('/finance/accounting/mapping?open=ITEM_GROUP%2FLEATHER')
    expect(recordAddress({ type: 'AccountingSettings', id: 'c1' }, OFFICE_PAGES)).toBe('/finance/accounting/mapping')
  })
})

const LEFT_KEY = /\b(?:mapping|journals|hard|integrity|common|band|live|keys|stepUp|problem|sum|fix)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs accounting.mapping.manage"). */
const SAID = /\b(?:accounting\.(?:view|export|close|unlock|mapping\.manage|journals\.switch))\b/g

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  it(`SCR-480: ${screen.cases.length} cases × it, en`, () => {
    const View = screen.view as ComponentType<{ model: unknown }>
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model }))).replace(SAID, '')
        expect(html.length, `SCR-480/${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-480/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `SCR-480/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })
})
