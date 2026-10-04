import { describe, expect, it } from 'vitest'
import type { PublicationBatchChild } from '@nexus/shared/studio-publication'
import { publicationScopeKey, type PublicationDestinationOption } from './model'
import { publishButtonText, publishPlan, MAX_BATCH_DESTINATIONS, type DestinationState } from './destinations'
import {
  activeTab, changeAccount, changeChannel, changeMarkets, childMarketKey, familySummary, initialChoice, listedMarkets, manySummary, manyTabWords, marketOptionLabel,
  marketTabLabel, pickerAccounts, pickerChannels, pickerMarkets, refillChoice, removeMarket, reviewTabWords,
} from './pickers'

const option = (channel: string, marketplace: string, accountId: string, marketName: string, accountLabel = 'Main'): PublicationDestinationOption => {
  const scope = { channel, marketplace, accountId }
  return { key: publicationScopeKey(scope), scope, label: `${marketName} · ${accountLabel}`, marketName, accountLabel }
}
const amazonIT = option('AMAZON', 'IT', 'a1', 'Amazon Italy')
const amazonDE = option('AMAZON', 'DE', 'a1', 'Amazon Germany')
const amazonFR = option('AMAZON', 'FR', 'a1', 'Amazon France')
const amazonIT2 = option('AMAZON', 'IT', 'a2', 'Amazon Italy', 'Second')
const ebayIT = option('EBAY', 'IT', 'e1', 'eBay Italy')
const ebayDE = option('EBAY', 'DE', 'e1', 'eBay Germany')
const options = [amazonIT, amazonDE, amazonFR, amazonIT2, ebayIT, ebayDE]

describe('pickers', () => {
  it('prefills the sheet’s own channel, account and market', () => {
    expect(initialChoice(options, [amazonDE.key])).toEqual({ channel: 'AMAZON', accountId: 'a1', keys: [amazonDE.key] })
    expect(initialChoice(options, [ebayIT.key])).toEqual({ channel: 'EBAY', accountId: 'e1', keys: [ebayIT.key] })
  })

  it('opens with no market chosen when nothing is asked for, and with the only destination when there is one', () => {
    expect(initialChoice(options, [])).toEqual({ channel: 'AMAZON', accountId: 'a1', keys: [] })
    expect(initialChoice([ebayDE], [])).toEqual({ channel: 'EBAY', accountId: 'e1', keys: [ebayDE.key] })
    expect(initialChoice([], [])).toEqual({ channel: null, accountId: null, keys: [] })
  })

  it('shows the Account picker only when the channel has two or more accounts', () => {
    expect(pickerChannels(options).map(c => c.value)).toEqual(['AMAZON', 'EBAY'])
    expect(pickerAccounts(options, 'AMAZON')).toHaveLength(2)
    expect(pickerAccounts(options, 'EBAY')).toHaveLength(1)
    expect(pickerMarkets(options, 'AMAZON', 'a1').map(o => o.scope.marketplace)).toEqual(['IT', 'DE', 'FR'])
  })

  it('keeps the same market codes when the channel or account changes', () => {
    const start = { channel: 'AMAZON', accountId: 'a1', keys: [amazonIT.key, amazonFR.key] }
    expect(changeChannel(options, start, 'EBAY')).toEqual({ channel: 'EBAY', accountId: 'e1', keys: [ebayIT.key] })
    expect(changeAccount(options, start, 'a2')).toEqual({ channel: 'AMAZON', accountId: 'a2', keys: [amazonIT2.key] })
    expect(changeChannel(options, start, 'AMAZON')).toBe(start)
  })

  it('keeps the chosen markets in the market list’s order and only of this account', () => {
    const start = { channel: 'AMAZON', accountId: 'a1', keys: [] }
    expect(changeMarkets(options, start, [amazonFR.key, amazonIT.key, ebayIT.key]).keys).toEqual([amazonIT.key, amazonFR.key])
    const many = Array.from({ length: MAX_BATCH_DESTINATIONS + 3 }, (_, i) => option('AMAZON', `M${i}`, 'a1', `Amazon M${i}`))
    expect(changeMarkets(many, start, many.map(o => o.key)).keys).toHaveLength(MAX_BATCH_DESTINATIONS)
  })

  it('removing a chip removes the market and its tab', () => {
    const choice = { channel: 'AMAZON', accountId: 'a1', keys: [amazonIT.key, amazonDE.key] }
    const next = removeMarket(choice, amazonDE.key)
    expect(next.keys).toEqual([amazonIT.key])
    expect(activeTab(next.keys, amazonDE.key)).toBe(amazonIT.key)
    expect(activeTab([], amazonDE.key)).toBeNull()
    expect(activeTab(choice.keys, amazonDE.key)).toBe(amazonDE.key)
  })

  it('names a market by its code first, as the sheet does', () => {
    expect(marketOptionLabel(amazonIT)).toBe('IT · Italy')
    expect(marketOptionLabel(option('EBAY', 'GLOBAL', 'e1', 'GLOBAL'))).toBe('GLOBAL')
    const listing = { ...amazonIT, scope: { ...amazonIT.scope, listingId: 'l1' } }
    expect(marketOptionLabel(listing)).toBe('IT · Italy · selected listing')
  })

  it('writes a tab label for every review state', () => {
    const cases: Array<[DestinationState, string]> = [
      [{ kind: 'not_checked' }, 'IT · not checked'],
      [{ kind: 'checking' }, 'IT · checking…'],
      [{ kind: 'error', message: 'x' }, 'IT · could not check'],
      [{ kind: 'earlier', publicationId: 'p' }, 'IT · earlier publish waiting'],
      [{ kind: 'blocked', problems: 2, reason: null }, 'IT · 2 problems'],
      [{ kind: 'blocked', problems: 0, reason: 'r' }, 'IT · cannot be sent'],
      [{ kind: 'expired' }, 'IT · review expired'],
      [{ kind: 'nothing', reason: 'none' }, 'IT · nothing to send'],
      [{ kind: 'nothing', reason: 'unticked' }, 'IT · no fields ticked'],
      [{ kind: 'input', needs: 'location' }, 'IT · choose a location'],
      [{ kind: 'ready', changes: 12, whole: false, requestReady: false }, 'IT · 12 changes'],
      [{ kind: 'ready', changes: 1, whole: false, requestReady: true }, 'IT · 1 change'],
      [{ kind: 'ready', changes: 0, whole: true, requestReady: true }, 'IT · new product'],
    ]
    for (const [state, label] of cases) expect(marketTabLabel(amazonIT, state)).toBe(label)
    expect(marketTabLabel(amazonIT, { kind: 'checking' }, 'Waiting for channel')).toBe('IT · Waiting for channel')
    expect(reviewTabWords({ kind: 'input', needs: 'overwrite' })).toBe('confirm the overwrite')
  })

  it('leaves the counted Publish button exactly as it was', () => {
    const states: Record<string, DestinationState> = {
      [amazonIT.key]: { kind: 'ready', changes: 12, whole: false, requestReady: true },
      [amazonDE.key]: { kind: 'ready', changes: 9, whole: false, requestReady: true },
      [amazonFR.key]: { kind: 'blocked', problems: 2, reason: null },
    }
    const plan = publishPlan([amazonIT.key, amazonDE.key, amazonFR.key], key => states[key])
    const scopeOf = (key: string) => options.find(o => o.key === key)?.scope
    expect(publishButtonText(plan, scopeOf)).toBe('Publish 21 changes to 2 markets · skip 1 with problems')
    expect(familySummary(3, plan)).toBe('3 markets · 21 changes · 1 with problems')
  })

  it('labels a many-product market tab from its rows', () => {
    const child = (status: string, extra: Partial<PublicationBatchChild> = {}): PublicationBatchChild => ({ publicationId: `p${Math.random()}`, productId: 'x', channel: 'AMAZON',
      marketplace: 'IT', accountId: 'a1', aliasKey: '', status, terminal: false, checked: false, message: null, summary: null, ...extra })
    const ready = child('PREVIEW', { selectedCount: 5, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const blocked = child('BLOCKED', { problems: { errors: 2, warnings: 0, messages: [] } })
    expect(childMarketKey(ready)).toBe(amazonIT.key)
    expect(manyTabWords([ready, blocked], 'reviewing')).toBe('checking…')
    expect(manyTabWords([ready, ready, blocked], 'reviewed')).toBe('10 changes')
    expect(manyTabWords([blocked], 'reviewed')).toBe('1 with problems')
    expect(manyTabWords([], 'reviewed')).toBe('no products')
    expect(manyTabWords([{ ...ready, terminal: true }, blocked], 'sending')).toBe('1 of 2 done')
    expect(manyTabWords([{ ...ready, terminal: true }], 'sending')).toBe('done')
    expect(manySummary({ listings: 12, changes: 214, problems: 3, expired: 0, nothing: 1 })).toBe('12 listings ready · 214 changes · 3 with problems · 1 with nothing to send')
  })
})

describe('one-click publish — the listed markets start chosen (OD1 A, OD2 A)', () => {
  const shopify = option('SHOPIFY', 'GLOBAL', 's1', 'Shopify')
  const all = [...options, shopify]
  const listed = new Set([amazonFR.key, amazonDE.key, ebayDE.key])

  it('the sheet’s market plus every listed market of its channel and account, in the market list’s order', () => {
    expect(initialChoice(all, [amazonIT.key], listed)).toEqual({ channel: 'AMAZON', accountId: 'a1', keys: [amazonIT.key, amazonDE.key, amazonFR.key] })
    // The other Amazon account is listed nowhere: only the sheet's market.
    expect(initialChoice(all, [amazonIT2.key], listed)).toEqual({ channel: 'AMAZON', accountId: 'a2', keys: [amazonIT2.key] })
    // Without the listed read (a retry, an Undo review): only the asked-for destination, as before.
    expect(initialChoice(all, [amazonIT.key], null)).toEqual({ channel: 'AMAZON', accountId: 'a1', keys: [amazonIT.key] })
  })

  it('the Shared tab opens with the first channel where the family is listed — Amazon, eBay, Shopify — and all its listed markets', () => {
    expect(initialChoice(all, [], listed)).toEqual({ channel: 'AMAZON', accountId: 'a1', keys: [amazonDE.key, amazonFR.key] })
    expect(initialChoice(all, [], new Set([ebayIT.key, shopify.key]))).toEqual({ channel: 'EBAY', accountId: 'e1', keys: [ebayIT.key] })
    // Shopify before a channel that is not in the order, whatever the list order.
    const etsy = option('ETSY', 'GLOBAL', 'x1', 'Etsy')
    expect(initialChoice([etsy, ...all], [], new Set([etsy.key, shopify.key]))).toEqual({ channel: 'SHOPIFY', accountId: 's1', keys: [shopify.key] })
    // On the second account when only it is listed.
    expect(initialChoice(all, [], new Set([amazonIT2.key]))).toEqual({ channel: 'AMAZON', accountId: 'a2', keys: [amazonIT2.key] })
    // Listed nowhere: today's opening (no market chosen).
    expect(initialChoice(all, [], new Set())).toEqual({ channel: 'AMAZON', accountId: 'a1', keys: [] })
  })

  it('keeps a market the sheet shows on a second listing, and never adds another listing’s option by itself', () => {
    const alias = { ...amazonDE, key: publicationScopeKey({ ...amazonDE.scope, listingId: 'second' }), scope: { ...amazonDE.scope, listingId: 'second' } }
    const withAlias = [amazonIT, alias, amazonFR]
    expect(listedMarkets(withAlias, new Set([amazonDE.key, amazonFR.key]), 'AMAZON', 'a1', [alias.key])).toEqual([alias.key, amazonFR.key])
    expect(listedMarkets(withAlias, new Set([amazonDE.key]), 'AMAZON', 'a1')).toEqual([])
  })

  it('switching channel or account refills with its listed markets (plus the sheet’s market there); listed nowhere keeps the pickers’ choice', () => {
    const start = initialChoice(all, [amazonIT.key], listed)
    const toEbay = changeChannel(all, start, 'EBAY')
    expect(refillChoice(all, start, toEbay, listed, [amazonIT.key])).toEqual({ channel: 'EBAY', accountId: 'e1', keys: [ebayDE.key] })
    const back = refillChoice(all, toEbay, changeChannel(all, toEbay, 'AMAZON'), listed, [amazonIT.key])
    expect(back.keys).toEqual([amazonIT.key, amazonDE.key, amazonFR.key])
    const toShopify = changeChannel(all, start, 'SHOPIFY')
    expect(refillChoice(all, start, toShopify, listed, [amazonIT.key])).toEqual(toShopify)
    // Removing a market on the same channel is the person's choice: never refilled.
    const removed = removeMarket(start, amazonDE.key)
    expect(refillChoice(all, start, removed, listed, [amazonIT.key])).toEqual(removed)
  })

  it('a market skipped because its request could not be built reads "skipped" on its tab', () => {
    expect(reviewTabWords({ kind: 'blocked', problems: 0, reason: 'x', request: true })).toBe('skipped')
  })
})
