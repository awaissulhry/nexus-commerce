/**
 * Audit B03 — the app's own links into the studio name nothing (`/products/<id>/edit/studio` from the product list,
 * the catalog, the listings and search), so the page-load prefetch used to start nothing on the most common way in.
 * It now completes such a URL from the business's choices, remembered by the provider, exactly as the provider
 * resolves it — and a read is still adopted only for the same product, scope, market, languages, account, business
 * and signed-in user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { adoptPrefetch, clearPrefetches } from './prefetchStore'
import { prefetchStudio, rememberStudioEntry, studioEntryChoices, studioEntrySearch, studioPrefetchPlan, type StudioEntryChoices } from './studioPrefetch'
import { channelScopeUrl, compactSheetUrl, destinationUrl, masterSheetUrl } from './sheetUrls'
import { writeLastLanguages } from './lastLanguages'
import { writeLastMarket } from './lastMarket'
import { defaultMarket, deriveScopeOptions } from './scopes'
import { setBrowserUserId } from '@/lib/workspaces/browser-identity'
import type { MarketplaceLite } from './types'

const ID = 'prod-family-1'
const account = (id: string, primary = true) => ({ id, label: id, primary })
const MARKETPLACES: MarketplaceLite[] = [
  { id: 'm1', channel: 'AMAZON', code: 'IT', name: 'Amazon IT', language: 'it', languages: ['it'], accounts: [account('amz-1')] },
  { id: 'm2', channel: 'AMAZON', code: 'DE', name: 'Amazon DE', language: 'de', languages: ['de'], accounts: [account('amz-1')] },
  { id: 'm3', channel: 'AMAZON', code: 'BE', name: 'Amazon BE', language: 'nl', languages: ['nl', 'fr'], accounts: [account('amz-1')] },
  { id: 'm4', channel: 'EBAY', code: 'IT', name: 'eBay IT', language: 'it', languages: ['it'], accounts: [account('ebay-a', false), account('ebay-b', false)] },
  { id: 'm5', channel: 'SHOPIFY', code: 'IT', name: 'Shopify IT', language: 'it', languages: ['it'], accounts: [account('shop-1')] },
]
const CHOICES = studioEntryChoices(MARKETPLACES, 'it')
const none = { market: null, languages: () => null }
const params = (query: string) => new URLSearchParams(query)
const plan = (query: string, remembered = none as Parameters<typeof studioEntrySearch>[2], choices: StudioEntryChoices | null = CHOICES) =>
  studioPrefetchPlan(ID, studioEntrySearch(params(query), choices, remembered))

let storage: Map<string, string>
let pathname: string
beforeEach(() => {
  storage = new Map()
  pathname = `/w/business-a/products/${ID}/edit/studio`
  vi.stubGlobal('window', {
    get location() { return { pathname, search: '' } },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } },
  })
})
afterEach(() => { clearPrefetches(); setBrowserUserId(null); vi.unstubAllGlobals() })

describe('a link that names nothing', () => {
  it('prefetches the Shared sheet the provider opens: the default market and the primary language', () => {
    expect(CHOICES.market).toBe(defaultMarket(deriveScopeOptions(MARKETPLACES, 'it')))
    expect(plan('')).toEqual({ destination: null, sheet: compactSheetUrl(masterSheetUrl(ID, 'IT', 'it', null)) })
  })

  it('opens where this operator last worked: the remembered market and languages, when the business offers them', () => {
    const languages = (key: string, supported: readonly string[]) => (key === 'master' ? supported.filter((c) => ['de', 'fr'].includes(c)) : null)
    expect(plan('', { market: 'DE', languages })).toEqual({ destination: null, sheet: compactSheetUrl(masterSheetUrl(ID, 'DE', 'de', ['de', 'fr'])) })
    // A market this business does not offer is not the provider's choice either: the default.
    expect(plan('', { market: 'PL', languages: () => null }).sheet).toBe(compactSheetUrl(masterSheetUrl(ID, 'IT', 'it', null)))
  })

  it('completes a listing link: the channel market\'s language', () => {
    const listing = plan(`scope=AMAZON&market=BE&account=amz-1&listing=l-1&rec=primary:${ID}`)
    expect(listing.sheet).toBe(compactSheetUrl(channelScopeUrl({ productId: ID, channel: 'AMAZON', marketplace: 'BE', accountId: 'amz-1', locale: 'nl', locales: null })))
    expect(listing.destination).toBe(destinationUrl(ID, 'AMAZON', 'BE', 'amz-1', 'l-1'))
  })

  it('a channel link without an account takes the primary account, and none when the channel has two', () => {
    expect(plan('scope=AMAZON&market=DE').sheet).toBe(compactSheetUrl(channelScopeUrl({ productId: ID, channel: 'AMAZON', marketplace: 'DE', accountId: 'amz-1', locale: 'de', locales: null })))
    expect(plan('scope=EBAY&market=IT')).toEqual({ destination: null, sheet: null })
  })

  it('guesses nothing without the business\'s choices, or for a channel the market does not serve', () => {
    expect(plan('', none, null)).toEqual({ destination: null, sheet: null })
    expect(plan('scope=EBAY&market=BE&account=ebay-a&locale=nl').sheet).toBe(studioPrefetchPlan(ID, params('scope=EBAY&market=BE&account=ebay-a&locale=nl')).sheet)
    expect(plan('scope=EBAY&market=BE').sheet).toBeNull()
  })
})

describe('prefetchStudio on the product list\'s link', () => {
  it('starts the Shared sheet read at page load, and the frame\'s read adopts it', async () => {
    rememberStudioEntry('business-a', CHOICES)
    writeLastMarket('DE')
    const network = vi.fn(() => Promise.resolve(new Response('prefetched')))
    vi.stubGlobal('fetch', network)
    const started = prefetchStudio(ID, params(''))
    // Shared's language is the business's primary one in every market.
    const url = compactSheetUrl(masterSheetUrl(ID, 'DE', 'it', null))
    expect(started.sheet).toBe(url)
    expect(network).toHaveBeenCalledTimes(1)
    await expect((await adoptPrefetch(url))!.text()).resolves.toBe('prefetched')
  })

  it('never uses another business\'s choices', () => {
    rememberStudioEntry('business-b', CHOICES)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(''))))
    expect(prefetchStudio(ID, params(''))).toEqual({ destination: null, sheet: null })
  })

  it('remembers the last languages per scope, the way the provider reads them', () => {
    rememberStudioEntry('business-a', CHOICES)
    writeLastLanguages('AMAZON:BE', ['fr'])
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(''))))
    expect(prefetchStudio(ID, params('scope=AMAZON&market=BE')).sheet)
      .toBe(compactSheetUrl(channelScopeUrl({ productId: ID, channel: 'AMAZON', marketplace: 'BE', accountId: 'amz-1', locale: 'fr', locales: null })))
  })
})

describe('a prefetch is adopted only by who started it', () => {
  const url = compactSheetUrl(masterSheetUrl(ID, 'IT', 'it', null))
  const start = () => {
    rememberStudioEntry('business-a', CHOICES)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('prefetched'))))
    prefetchStudio(ID, params(''))
  }

  it('not in another business', () => {
    start()
    pathname = `/w/business-b/products/${ID}/edit/studio`
    expect(adoptPrefetch(url)).toBeNull()
  })

  it('not by another signed-in user; a session still loading at start is the same browser session', async () => {
    setBrowserUserId('user-1')
    start()
    setBrowserUserId('user-2')
    expect(adoptPrefetch(url)).toBeNull()
    setBrowserUserId(null)
    start()
    setBrowserUserId('user-1')
    await expect((await adoptPrefetch(url))!.text()).resolves.toBe('prefetched')
  })
})

describe('the provider resolves a silent URL the same way, from its first render', () => {
  const contracts = readFileSync(path.join(__dirname, 'contracts.tsx'), 'utf8')

  it('reads the remembered market and languages in render and remembers the business\'s choices', () => {
    expect(contracts).toMatch(/const rememberedMarket = useMemo\(\(\) => \(marketParam \? null : readLastMarket\(\)\), \[marketParam\]\)/)
    expect(contracts).toMatch(/if \(!marketParam && rememberedMarket && baseOptions\.markets\.some\(\(m\) => m\.code === rememberedMarket\)\) return rememberedMarket/)
    expect(contracts).toMatch(/readLastLanguages\(languagesKey\(scope, market\), supportedLanguages\)\),/)
    expect(contracts).toMatch(/locale = locales\?\.\[0\] \?\? localeParam \?\? rememberedLanguages\?\.\[0\] \?\? \(scope === MASTER_SCOPE \? primaryLanguage : supportedLanguages\[0\] \?\? null\)/)
    expect(contracts).toMatch(/rememberStudioEntry\(browserWorkspaceId\(\), studioEntryChoices\(marketplaces, primaryLanguage\)\)/)
  })
})
