import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { holdsSend, PROBLEM_CODES } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { CATALOGUE, createTranslator, messagesFor } from '../i18n/messages'
import { I18nProvider } from '../i18n/provider'
import { draftRecord, kindsRecord, describedLine, mtmLine, TODAY } from '../../portal/customer/neworder/design-data'
import { draftSendHeld } from '../../portal/customer/neworder/model'
import { choiceWords, draftViewOf, headerDraftOf, productRowsOf, savedByWords } from './model'
import { DRAFT_NS } from './words'
import { DraftPage, type DraftPageModel } from './view/DraftPage'
import { OptionsWindow } from './view/RowWindows'

/**
 * THE SIMPLE ORDER START (od-tw t.2) — the ONE draft order's pins, for both doors:
 * 1. the money wall: the shared view model and every products-table row carry NO price key (prices live only in the hosts' cards);
 * 2. "saved by": the portal never names a factory worker — any office save reads "the factory" (own Italian form);
 * 3. "Not decided yet" is an ANSWER: an option's last choice, a row's open cell, the words of an open option;
 * 4. Send is never held by a missing cell — only by an invalid value (the domain's own `holdsSend`).
 */

const td = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][DRAFT_NS] ?? {})

/** Every key of a value, deep (objects and arrays). */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out)
  else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) {
      out.push(key)
      keysOf(inner, out)
    }
  return out
}
const MONEY = /price|amount|net|currency|cost|margin/i

function page(door: 'portal' | 'office', over: Partial<DraftPageModel> = {}, locale: 'it' | 'en' = 'en'): string {
  const record = kindsRecord({ request: { subject: 'Race team kit for 2027' } })
  const model: DraftPageModel = {
    draft: draftViewOf(record),
    today: TODAY,
    header: headerDraftOf(record.request),
    headerErrors: {},
    save: { kind: 'idle' },
    writeHeld: null,
    addAddressHeld: null,
    problem: null,
    stale: false,
    notice: null,
    offlineSince: null,
    pending: false,
    styles: [],
    saving: [],
    uploads: [],
    keys: [],
    ...over,
  }
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, [DRAFT_NS, 'ds-words']) }, createElement(DraftPage, { kind: door, model })))
}

describe('the money wall: the shared part never gets a price', () => {
  it('the view model and the table rows hold no price key — the record they come from does (a price holder’s)', () => {
    for (const record of [draftRecord(), kindsRecord(), kindsRecord({ custom: [describedLine({ brandUnitPrice: '18.50' }), mtmLine({ brandUnitPrice: '420.00' })] })]) {
      expect(keysOf(record).some((key) => MONEY.test(key))).toBe(true)
      expect(keysOf(draftViewOf(record)).filter((key) => MONEY.test(key))).toEqual([])
      expect(keysOf(productRowsOf(draftViewOf(record).request)).filter((key) => MONEY.test(key))).toEqual([])
    }
  })

  it('the page draws no money in either door (no € and no price word)', () => {
    for (const door of ['portal', 'office'] as const) for (const locale of ['it', 'en'] as const) expect(page(door, {}, locale), `${door} ${locale}`).not.toMatch(/€|EUR/)
  })
})

describe('"saved by": the portal never names a factory worker', () => {
  const at = { updatedAt: '2026-11-25T09:42:00Z', lastEditedAt: null }
  it('any office save reads "the factory" (own Italian form), even when a name came along', () => {
    const time = () => '10:42'
    expect(savedByWords({ ...at, lastEditedBy: 'Sam Example', savedBy: { who: 'FACTORY', name: 'Sam Example' } }, td('en'), time)).toBe('Saved 10:42 by the factory')
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'FACTORY', name: null } }, td('it'), time)).toBe('Salvata alle 10:42 dalla fabbrica')
    expect(td('it')('head.savedByFactory', { time: '10:42' })).not.toContain('da la')
  })

  it('drawn: the portal head and a 409 say "the factory", never the worker; the office names its colleague', () => {
    const factory = { who: 'FACTORY' as const, name: 'Sam Example' }
    const record = kindsRecord({ request: { savedBy: factory, lastEditedBy: 'Sam Example' } })
    const portal = page('portal', { draft: draftViewOf(record), stale: true, staleBy: factory })
    expect(portal).not.toContain('Sam Example')
    expect(portal).toContain('by the factory')
    expect(portal).toContain(td('en')('save.changedByFactory'))
    expect(page('office', { draft: draftViewOf(kindsRecord({ request: { savedBy: { who: 'COLLEAGUE', name: 'Sam Example' } } })) })).toContain('Sam Example')
  })
})

describe('"Not decided yet" is an answer', () => {
  it('an open option reads "Not decided yet"; it is always the last choice of the option; an empty cell says it', () => {
    expect(choiceWords({ topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: null }, td('en'))).toBe('Leather: Not decided yet')
    expect(choiceWords({ topic: 'Pelle', options: ['Vacchetta', 'Canguro'], picked: null }, td('it'))).toBe('Pelle: Non ancora deciso')
    const record = kindsRecord({ custom: [describedLine({ choices: [{ topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: null }], description: null, colourText: null, quantity: null, pieces: 0 })] })
    const row = productRowsOf(record.request).find((entry) => entry.choices.length > 0)!
    const window = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', [DRAFT_NS, 'ds-words']) }, createElement(OptionsWindow, { model: { row, topic: '', typed: '', addHeld: null, busy: false, failed: null, writeHeld: null } })))
    const cowhide = window.indexOf('Cowhide')
    const open = window.indexOf(td('en')('state.OPEN'), cowhide)
    expect(cowhide).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(window.indexOf('Kangaroo'))
    expect(page('portal', { draft: draftViewOf(record) })).toContain(td('en')('state.OPEN'))
  })
})

describe('Send is never held by a missing cell', () => {
  it('a missing count or line never holds it; an invalid value does (the domain’s holdsSend, one rule)', () => {
    const facts = { preview: false, offline: false, busy: false }
    const missing = PROBLEM_CODES.filter((code) => !holdsSend(code))
    expect(missing).toEqual(expect.arrayContaining(['NO_LINES', 'NO_SIZES', 'NO_TOTAL', 'NO_PEOPLE']))
    const nothing = draftRecord({ lines: [], request: { problems: missing.map((code) => ({ code, lineId: null, size: null })) } })
    expect(draftSendHeld(nothing.request, facts, [])).toBeNull()
    expect(draftSendHeld(draftRecord({ request: { problems: [{ code: 'DATE_PAST', lineId: null, size: null }] } }).request, facts, [])).toEqual({ key: 'held.problems', count: 1 })
  })
})
