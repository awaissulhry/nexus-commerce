import { describe, expect, it } from 'vitest'
import { scopeMenuOptions } from '@/design-system/patterns/ScopeBar'
import { connectionHealth } from './presence/connection'
import { parseReadinessResponse } from './readiness'
import { measuredNonParticipation, participationSuffix, scopeItems, type ScopeItemsInput } from './scopeItems'
import { deriveScopeOptions, flattenGrouped } from './scopes'
import type { MarketplaceLite, ScopeReadinessQuery } from './types'

/**
 * A-55 (SR1) — the scope dropdown said "Not set up" for almost every channel.
 *
 * Every fixture takes the path production takes. The Marketplace rows are a `GET /marketplaces/grouped` payload read
 * through `flattenGrouped` and `deriveScopeOptions`. The readiness is a `GET /products/:id/readiness` body read through
 * `parseReadinessResponse`. The words asserted are the ones the menu prints (`scopeMenuOptions`, the function the open
 * panel renders).
 *
 * Production facts copied into the fixtures (read-only read, 2026-09-24):
 * - `isParticipating` is only ever written by the Amazon participation refresher, together with
 *   `participationStatus` and `participationCheckedAt`. eBay/Shopify/Etsy rows keep the column DEFAULT `false` with
 *   both of those NULL.
 * - Xavia GALE-JACKET index: Amazon·DE `de` 284/590 = 48 % blocked; eBay·DE `de` blocked, no %; eBay·IT `it` blocked
 *   100 %; Shopify·GLOBAL `en` blocked, no %.
 * - Motovento has no channel index rows yet.
 */

const CHECKED = '2026-09-08T13:15:00.000Z'
const measured = { isParticipating: true, participationStatus: 'PARTICIPATING', participationCheckedAt: CHECKED }
/** The column default, as production holds it on every eBay / Shopify / Etsy / WooCommerce row. */
const unmeasured = { isParticipating: false, participationStatus: null, participationCheckedAt: null }
const row = (channel: string, code: string, languages: string[], participation: object) =>
  ({ id: `${channel}:${code}`, channel, code, name: `${channel} ${code}`, language: languages[0], languages, isActive: true, ...participation })

const health = connectionHealth({ isActive: true, authStatus: 'connected' }, Date.parse('2026-09-24T16:00:00Z'))
/** `studio-data.ts` attaches the business's accounts; a channel with none is not offered (Motovento's Amazon). */
function marketplacesOf(grouped: Record<string, unknown>, withAccounts: string[]): MarketplaceLite[] {
  return flattenGrouped(grouped).map(m => withAccounts.includes(m.channel)
    ? { ...m, connected: true, connectionHealth: health, accounts: [{ id: `acct-${m.channel}`, label: m.channel, primary: true, health }] }
    : { ...m, connected: false, connectionHealth: null, accounts: [] })
}

const xavia = marketplacesOf({
  AMAZON: [row('AMAZON', 'DE', ['de'], measured), row('AMAZON', 'IT', ['it'], measured), row('AMAZON', 'BE', ['fr', 'nl'], measured)],
  EBAY: [row('EBAY', 'DE', ['de'], unmeasured), row('EBAY', 'IT', ['it'], unmeasured)],
  SHOPIFY: [row('SHOPIFY', 'GLOBAL', ['en'], unmeasured)],
  _meta: { primaryLanguage: 'it' },
}, ['AMAZON', 'EBAY', 'SHOPIFY'])

const motovento = marketplacesOf({
  AMAZON: [row('AMAZON', 'DE', ['de'], unmeasured)],
  EBAY: [row('EBAY', 'DE', ['de'], unmeasured)],
  ETSY: [row('ETSY', 'GLOBAL', ['en'], unmeasured)],
  _meta: { primaryLanguage: 'it' },
}, ['EBAY', 'ETSY'])

const NOT_COMPUTED = 'Readiness has not been computed for this language.'
const ready = (scopes: unknown[]): ScopeReadinessQuery => ({ status: 'ready', byScope: parseReadinessResponse({ scopes }), matrix: [], at: 0, coordinate: 'c' })
const input = (over: Partial<ScopeItemsInput> & Pick<ScopeItemsInput, 'marketplaces' | 'market' | 'scope' | 'locale' | 'readiness'>): ScopeItemsInput => ({
  channels: deriveScopeOptions(over.marketplaces, 'it').channels, save: { kind: 'idle' }, discoveryFailed: false, destination: over.scope === 'master' ? 'idle' : 'ready', ...over,
})
const menu = (i: ScopeItemsInput) => scopeMenuOptions(scopeItems(i)).map(o => o.trailing)
const item = (i: ScopeItemsInput, id: string) => scopeItems(i).find(x => x.id === id)
const title = (i: ScopeItemsInput, id: string) => scopeMenuOptions(scopeItems(i)).find(o => o.value === id)?.title

/** Shared product · DE — the landing screen (a two-channel tie broken alphabetically). The Shared language is Italian. */
const xaviaSharedDE = input({ marketplaces: xavia, market: 'DE', scope: 'master', locale: 'it', readiness: ready([
  { id: 'master', pct: 100, state: 'warn', note: '1 of 1 required values filled across this scope.' },
  { id: 'AMAZON', pct: null, state: 'notComputed', note: NOT_COMPUTED, languages: [{ language: 'de', pct: 48, state: 'blocked' }] },
  { id: 'EBAY', pct: null, state: 'notComputed', note: NOT_COMPUTED, languages: [{ language: 'de', pct: null, state: 'blocked' }] },
  { id: 'SHOPIFY', pct: null, state: 'notComputed', note: NOT_COMPUTED, languages: [{ language: 'en', pct: null, state: 'blocked' }] },
]) })
const xaviaEbayIT = input({ marketplaces: xavia, market: 'IT', scope: 'EBAY', locale: 'it', readiness: ready([
  { id: 'master', pct: 100, state: 'warn' },
  { id: 'AMAZON', pct: 100, state: 'blocked', note: '630 of 630 required values filled across this scope.', languages: [{ language: 'it', pct: 100, state: 'blocked' }] },
  { id: 'EBAY', pct: 100, state: 'blocked', note: '126 of 126 required values filled across this scope.', languages: [{ language: 'it', pct: 100, state: 'blocked' }] },
  { id: 'SHOPIFY', pct: null, state: 'blocked', note: 'Category metadata is incomplete: SHOPIFY:*', languages: [{ language: 'en', pct: null, state: 'blocked' }] },
]) })
const xaviaShopifyGlobal = input({ marketplaces: xavia, market: 'GLOBAL', scope: 'SHOPIFY', locale: 'en', readiness: ready([
  { id: 'master', pct: 100, state: 'blocked' },
  { id: 'SHOPIFY', pct: null, state: 'blocked', note: 'Category metadata is incomplete: SHOPIFY:*', languages: [{ language: 'en', pct: null, state: 'blocked' }] },
]) })
const motoventoEbayDE = input({ marketplaces: motovento, market: 'DE', scope: 'EBAY', locale: 'de', readiness: ready([
  { id: 'master', pct: null, state: 'absent', note: 'No content languages configured.' },
  { id: 'EBAY', pct: null, state: 'notComputed', note: NOT_COMPUTED, languages: [] },
  { id: 'ETSY', pct: null, state: 'notComputed', note: NOT_COMPUTED, languages: [] },
]) })

/** One Amazon·DE row with a given participation, the server answering Blocked 48 %. */
const amazonDE = (participation: object) => input({
  marketplaces: xavia.map(m => m.channel === 'AMAZON' && m.code === 'DE' ? { ...m, ...participation } : m),
  market: 'DE', scope: 'AMAZON', locale: 'de', readiness: ready([
    { id: 'master', pct: 100, state: 'warn' },
    { id: 'AMAZON', pct: 48, state: 'blocked', note: '284 of 590 required values filled across this scope.', languages: [{ language: 'de', pct: 48, state: 'blocked' }] },
    { id: 'EBAY', pct: null, state: 'blocked', note: 'Category metadata is incomplete: EBAY:*', languages: [{ language: 'de', pct: null, state: 'blocked' }] },
  ]),
})

describe('A-55 arm A — participation is a measurement, not a column default', () => {
  it('T1: eBay·IT with the production default (false, never checked) shows the server verdict, not "Not set up"', () => {
    const r = item(xaviaEbayIT, 'EBAY')?.readiness
    expect(r).toMatchObject({ state: 'blocked', pct: 100 })
  })
  it('T2: a MEASURED non-participation (Amazon said so) still reads "Not set up", and the hover says when it was checked', () => {
    const i = amazonDE({ isParticipating: false, participationStatus: 'NOT_PARTICIPATING', participationCheckedAt: CHECKED })
    expect(menu(i)[1]).toBe('Not set up')
    expect(title(i, 'AMAZON')).toContain('not participating')
    expect(title(i, 'AMAZON')).toContain('2026-09-08')
  })
  it('T3: an UNKNOWN status is not a measurement of non-participation — the server verdict stands', () => {
    const i = amazonDE({ isParticipating: false, participationStatus: 'UNKNOWN', participationCheckedAt: CHECKED })
    expect(menu(i)[1]).toBe('Blocked · 48%')
  })
  it('T4: the Market list says "(not participating)" only for a measured non-participation', () => {
    const ebayIT = xavia.find(m => m.channel === 'EBAY' && m.code === 'IT')
    expect(ebayIT).toMatchObject(unmeasured)
    expect(participationSuffix(ebayIT)).toBe('')
    expect(participationSuffix({ isParticipating: false, participationStatus: 'NOT_PARTICIPATING', participationCheckedAt: CHECKED })).toBe(' (not participating)')
    expect(measuredNonParticipation(undefined)).toBe(false)
  })
})

describe('A-55 arm B (Q1 (a)) — a market that does not sell the chosen language shows its own-language verdict', () => {
  it('T5: Shared · DE in Italian — Amazon shows its German verdict, and the hover names German', () => {
    expect(item(xaviaSharedDE, 'AMAZON')?.readiness).toMatchObject({ state: 'blocked', pct: 48 })
    expect(title(xaviaSharedDE, 'AMAZON')).toContain('German')
    expect(title(xaviaSharedDE, 'AMAZON')).toContain('Italian')
  })
  it('T6: a market that DOES sell the chosen language keeps the server answer, even when another language is scored', () => {
    // Amazon·BE sells French and Dutch. Dutch is chosen and has no rows; French has a verdict. "Not computed" is the truth.
    const i = input({ marketplaces: xavia, market: 'BE', scope: 'AMAZON', locale: 'nl', readiness: ready([
      { id: 'master', pct: 100, state: 'warn' },
      { id: 'AMAZON', pct: null, state: 'notComputed', note: NOT_COMPUTED, languages: [{ language: 'fr', pct: null, state: 'blocked' }] },
    ]) })
    expect(menu(i)[1]).toBe('Not computed')
  })
  it('T7: no verdict in the market\'s own language either (Motovento today) — "Not computed" with the server\'s sentence', () => {
    const i = input({ marketplaces: motovento, market: 'DE', scope: 'master', locale: 'it', readiness: ready([
      { id: 'master', pct: null, state: 'absent', note: 'No content languages configured.' },
      { id: 'EBAY', pct: null, state: 'notComputed', note: NOT_COMPUTED, languages: [] },
    ]) })
    expect(menu(i)[1]).toBe('Not computed')
    expect(title(i, 'EBAY')).toContain(NOT_COMPUTED)
  })
})

describe('A-55 arm C and cases (2)/(3) — an unmeasured scope is never "Not set up"', () => {
  it('T8: while a channel scope\'s destination loads, every row says Checking…', () => {
    const i = input({ marketplaces: xavia, market: 'DE', scope: 'EBAY', locale: 'de', destination: 'loading',
      readiness: { status: 'unavailable', reason: 'No market selected.' } })
    expect(menu(i)).toEqual(['Checking…', 'Checking…', 'Checking…', undefined])
  })
  it('T9: a failed readiness read is "Not computed", and the hover carries the failure verbatim', () => {
    const i = input({ marketplaces: xavia, market: 'DE', scope: 'master', locale: 'de', readiness: { status: 'error', message: 'Readiness request failed (500).' } })
    expect(menu(i)[1]).toBe('Not computed')
    expect(title(i, 'AMAZON')).toContain('Readiness request failed (500).')
  })
  it('T10: a channel missing from the response is "Not computed"', () => {
    const i = input({ marketplaces: xavia, market: 'DE', scope: 'master', locale: 'de', readiness: ready([{ id: 'master', pct: 100, state: 'warn' }]) })
    expect(menu(i)[1]).toBe('Not computed')
  })
})

describe('A-55 — T11: the four production screens, as the menu prints them', () => {
  it('(a) Xavia · Shared · DE (the landing screen)', () => {
    expect(menu(xaviaSharedDE)).toEqual(['See each channel', 'Blocked · 48%', 'Blocked · —', undefined])
  })
  it('(b) Xavia · eBay · IT', () => {
    expect(menu(xaviaEbayIT)).toEqual(['See each channel', 'Blocked · 100%', 'Blocked · 100%', undefined])
  })
  it('(c) Xavia · Shopify · GLOBAL', () => {
    expect(menu(xaviaShopifyGlobal)).toEqual(['See each channel', undefined, undefined, 'Blocked · —'])
  })
  it('(d) Motovento · eBay · DE', () => {
    expect(menu(motoventoEbayDE)).toEqual(['See each channel', 'Not computed', undefined])
  })
})

describe('Step 4 (D2) — "not listed here" reads the same on the chip as on the sheet', () => {
  it('the open channel with no listing and no verdict says "Not listed yet", and the hover is the sheet notice', () => {
    const i = { ...motoventoEbayDE, unlisted: true }
    expect(menu(i)).toEqual(['See each channel', 'Not listed yet', undefined])
    expect(title(i, 'EBAY')).toContain('Not listed on eBay · DE yet. Your first edit here starts a draft.')
  })
  it('a real verdict still wins: the rules are judged before the first listing exists', () => {
    expect(menu({ ...xaviaEbayIT, unlisted: true })).toEqual(['See each channel', 'Blocked · 100%', 'Blocked · 100%', undefined])
  })
  it('only the OPEN scope is known to have no listing; another channel keeps its own answer', () => {
    const i = { ...input({ marketplaces: xavia, market: 'DE', scope: 'EBAY', locale: 'de', readiness: ready([{ id: 'master', pct: 100, state: 'warn' }]) }), unlisted: true }
    expect(menu(i)).toEqual(['See each channel', 'Not computed', 'Not listed yet', undefined])
  })
  it('a channel the response did not score says so in plain words', () => {
    const i = input({ marketplaces: xavia, market: 'DE', scope: 'master', locale: 'de', readiness: ready([{ id: 'master', pct: 100, state: 'warn' }]) })
    expect(title(i, 'AMAZON')).toContain('Nexus has not checked Amazon · DE yet.')
    expect(title(i, 'AMAZON')).not.toContain('scored in this response')
  })
})
