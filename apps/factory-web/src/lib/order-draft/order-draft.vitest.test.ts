import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { holdsSend, PROBLEM_CODES } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { CATALOGUE, createTranslator, messagesFor } from '../i18n/messages'
import { I18nProvider } from '../i18n/provider'
import { draftRecord, kindsRecord, describedLine, mtmLine, TODAY } from '../../portal/customer/neworder/design-data'
import { draftSendHeld } from '../../portal/customer/neworder/model'
import { choiceWords, draftViewOf, headerDraftOf, productRowsOf, rowProductOf, savedByWords } from './model'
import { DRAFT_NS, draftWordsFor } from './words'
import { DraftPage, type DraftPageModel } from './view/DraftPage'
import { PiecesBody, piecesOpenOf } from './view/RowWindows'

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
    expect(td('it')('head.savedByFactory', { when: 'alle 10:42' })).not.toContain('da la')
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
    expect(productRowsOf(record.request).some((entry) => entry.choices.some((choice) => choice.picked === null))).toBe(true)
    expect(page('portal', { draft: draftViewOf(record) })).toContain(td('en')('state.OPEN'))
    // The Options window (a DS Modal: it draws only once hydrated, so pinned in its source): "Not decided yet" is the LAST choice.
    expect(readFileSync(new URL('./view/RowWindows.tsx', import.meta.url), 'utf8')).toMatch(/\[\.\.\.choice\.options\.map\([^\n]*\), \{ value: OPEN, label: t\('state\.OPEN'\)/)
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

describe('od-fx8 — the walk of the shared part (W-01, W-09, W-10, W-15, W-21, W-25, looks)', () => {
  const at = { updatedAt: '2026-11-12T09:40:00Z', lastEditedAt: null }
  const time = () => '10:40'
  const day = () => '12/11/2026'
  const office = (locale: 'it' | 'en') => draftWordsFor(td(locale), locale, 'office').t

  it('W-09: the office names the person — a colleague by name, a customer’s person with the customer; the portal keeps "the factory"', () => {
    const today = '2026-11-12'
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'FACTORY', name: 'Sam Sales' } }, office('en'), { time, day, today, door: 'office' })).toBe('Saved 10:40 by Sam Sales')
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'COLLEAGUE', name: 'Bianca Brand' } }, office('en'), { time, day, today, door: 'office', customer: 'Seed Racing' })).toBe('Saved 10:40 by Bianca Brand (Seed Racing)')
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'COLLEAGUE', name: 'Bianca Brand' } }, office('it'), { time, day, today, door: 'office', customer: 'Seed Racing' })).toBe('Salvata alle 10:40 da Bianca Brand (Seed Racing)')
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'FACTORY', name: 'Sam Sales' } }, td('en'), { time, day, today, door: 'portal' })).toBe('Saved 10:40 by the factory')
    // Drawn: the office page passes its customer.
    expect(page('office', { draft: draftViewOf(kindsRecord({ request: { savedBy: { who: 'COLLEAGUE', name: 'Bianca Brand' } } })), customer: 'Seed Racing' })).toContain('Bianca Brand (Seed Racing)')
  })

  it('W-21: a save of another day says its day too ("Saved 12/11/2026, 10:40 by …")', () => {
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'COLLEAGUE', name: 'Bianca Brand' } }, td('en'), { time, day, today: '2026-11-25' })).toBe('Saved 12/11/2026, 10:40 by Bianca Brand')
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'FACTORY', name: null } }, td('it'), { time, day, today: '2026-11-25' })).toBe('Salvata il 12/11/2026 alle 10:40 dalla fabbrica')
    expect(savedByWords({ ...at, lastEditedBy: null }, td('en'), { time, day, today: '2026-11-12' })).toBe('Draft saved 10:40')
  })

  it('W-01: "Add from" says its three ways in words (it, en)', () => {
    for (const locale of ['it', 'en'] as const) for (const key of ['add.from', 'add.catalogue', 'add.pastOrder', 'add.sheet']) expect(td(locale)(key), `${key} ${locale}`).not.toBe(key)
  })

  it('W-25: ONE name for a product — the customer’s words, else the style’s name (its code beside it in the table)', () => {
    expect(rowProductOf({ words: null, style: { id: 's', code: 'SEED-JKT-02', name: 'Seed production jacket' } })).toBe('Seed production jacket')
    expect(rowProductOf({ words: 'Team gloves', style: null })).toBe('Team gloves')
  })

  it('W-15: the Pieces window opens on what the row holds — "Not decided yet" for a row with no pieces', () => {
    const rows = productRowsOf(kindsRecord({ custom: [describedLine({ quantity: null, pieces: 0 })] }).request)
    const own = rows.find((row) => !row.catalogue)!
    expect(own.pieces.mode).toBe('NONE')
    expect(piecesOpenOf(own).mode).toBe('NONE')
    const catalogue = rows.find((row) => row.catalogue)!
    expect(piecesOpenOf(catalogue)).toMatchObject({ mode: 'SIZES' })
    expect(piecesOpenOf({ ...own, sizing: 'MADE_TO_MEASURE' }).mode).toBe('PEOPLE')
  })

  it('W-10: a reader’s Pieces window reads — no field, no size grid to type in', () => {
    const rows = productRowsOf(kindsRecord().request)
    const catalogue = rows.find((row) => row.catalogue)!
    const record = kindsRecord()
    const view = draftViewOf(record)
    const model = { row: catalogue, ...piecesOpenOf(catalogue), roster: { draft: view, writeHeld: 'You can read, not change: your role does not manage orders.', uploadsOpen: true, addHeld: null, draftName: '' }, rosterLine: null, busy: false, failed: null, writeHeld: 'You can read, not change: your role does not manage orders.' }
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', [DRAFT_NS, 'ds-words']) }, createElement(PiecesBody, { model })))
    expect(html).toContain('You can read, not change')
    expect(html).not.toContain('<input')
    expect(html).toContain('data-mode="view"')
  })

  it('looks (W-07, W-11, W-16, W-18): the phone bar above the bottom bars, boxes in their tracks, Still open fills its row, a card’s number', () => {
    const css = readFileSync(new URL('./order-draft.css', import.meta.url), 'utf8')
    expect(css).toContain('.fw-portal .fw-od-actionbar {\n    bottom: calc(56px + env(safe-area-inset-bottom));')
    expect(css).toContain('.fw-office-main .fw-od-actionbar {\n    bottom: calc(64px + env(safe-area-inset-bottom));')
    expect(css).toMatch(/\.fw-od-trow input,\n\.fw-od-trow select \{\n  width: 100%;\n  min-width: 0;/)
    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));')
    expect(css).toContain("'n product product more'")
  })
})

