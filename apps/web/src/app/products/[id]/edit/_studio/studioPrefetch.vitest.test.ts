/**
 * P2 (2026-09-30, I4-2) — the studio's destination check and sheet read start from the URL at page load, and the hooks
 * adopt them only when they would have made exactly the same read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adoptPrefetch, clearPrefetches, PREFETCH_TTL_MS, prefetchKind, startPrefetch } from './prefetchStore'
import { studioPrefetchPlan } from './studioPrefetch'
import { fetchStudioRead } from './studio-read'
import { channelScopeUrl } from './sheet/channel/useChannelSheet'
import { compactSheetUrl, familyOrderUrl, masterSheetUrl } from './sheetUrls'

const ID = 'prod-family-1'
const ACCOUNT = 'acct-ebay-1'
const params = (query: string) => new URLSearchParams(query)

afterEach(() => { clearPrefetches(); vi.unstubAllGlobals() })

describe('studioPrefetchPlan', () => {
  it('names the channel sheet the hook reads, and the destination it checks', () => {
    const plan = studioPrefetchPlan(ID, params(`scope=EBAY&market=IT&account=${ACCOUNT}&locale=it&tab=sheet`))
    // The very URL `useChannelSheet` builds for this coordinate — anything else would never be adopted.
    // The compact form the hook reads (P2): a prefetch of any other bytes would never be adopted.
    expect(plan.sheet).toBe(compactSheetUrl(channelScopeUrl({ productId: ID, channel: 'EBAY', marketplace: 'IT', accountId: ACCOUNT, locale: 'it', locales: null })))
    expect(plan.destination).toMatch(new RegExp(`/api/products/${ID}/studio/destination\\?channel=EBAY&market=IT&accountId=${ACCOUNT}$`))
  })

  it('prefetches the pooled compact read the hooks make, so it is adopted once and read only once', async () => {
    const plan = studioPrefetchPlan(ID, params(`scope=EBAY&market=IT&account=${ACCOUNT}&locale=it&tab=sheet`))
    expect(new URL(plan.sheet!).searchParams.get('cells')).toBe('compact')
    expect(new URL(plan.sheet!).searchParams.get('patches')).toBe('pooled')
    expect(new URL(studioPrefetchPlan(ID, params('scope=master&market=IT&locale=it')).sheet!).searchParams.get('patches')).toBe('pooled')
    const network = vi.fn(() => Promise.resolve(new Response('network')))
    vi.stubGlobal('fetch', network)
    startPrefetch(plan.sheet!, () => Promise.resolve(new Response('prefetched')))
    // The URL `useChannelSheet` fetches for the same coordinate.
    const hookRead = compactSheetUrl(channelScopeUrl({ productId: ID, channel: 'EBAY', marketplace: 'IT', accountId: ACCOUNT, locale: 'it', locales: null }))
    await expect((await fetchStudioRead(hookRead)).text()).resolves.toBe('prefetched')
    expect(network).not.toHaveBeenCalled()
  })

  it('names the master sheet on the Shared scope, with no destination', () => {
    expect(studioPrefetchPlan(ID, params('scope=master&market=IT&locale=it'))).toEqual({ destination: null, sheet: compactSheetUrl(masterSheetUrl(ID, 'IT', 'it', null)), familyOrder: familyOrderUrl(ID, 'IT', 'it') })
    expect(studioPrefetchPlan(ID, params('market=IT&locales=it,de'))).toEqual({ destination: null, sheet: compactSheetUrl(masterSheetUrl(ID, 'IT', 'it', ['it', 'de'])), familyOrder: familyOrderUrl(ID, 'IT', 'it') })
  })

  it('guesses nothing the URL does not state', () => {
    // No account: the frame picks the primary one from the accounts it reads first. The family order needs no account.
    expect(studioPrefetchPlan(ID, params('scope=EBAY&market=IT&locale=it'))).toEqual({ destination: null, sheet: null, familyOrder: familyOrderUrl(ID, 'IT', 'it') })
    // No language: the frame picks the scope's first language.
    expect(studioPrefetchPlan(ID, params(`scope=EBAY&market=IT&account=${ACCOUNT}`)).sheet).toBeNull()
    // Another tab: no sheet, but the channel tab still waits for its destination.
    const images = studioPrefetchPlan(ID, params(`scope=EBAY&market=IT&account=${ACCOUNT}&locale=it&tab=images`))
    expect(images.sheet).toBeNull()
    expect(images.familyOrder).toBeNull()
    expect(images.destination).not.toBeNull()
    expect(studioPrefetchPlan(ID, params('scope=EBAY&locale=it'))).toEqual({ destination: null, sheet: null, familyOrder: null })
  })
})

describe('the family order read (Owner 2026-10-07) starts with the Information page\'s sheet', () => {
  it('names the order view on the Information tab only — the Matrix reads the full family read itself', () => {
    expect(studioPrefetchPlan(ID, params(`scope=EBAY&market=IT&account=${ACCOUNT}&locale=it&tab=sheet`)).familyOrder).toBe(familyOrderUrl(ID, 'IT', 'it'))
    expect(studioPrefetchPlan(ID, params('scope=master&market=IT&locale=it&tab=matrix')).familyOrder).toBeNull()
    expect(new URL(familyOrderUrl(ID, 'IT', 'it')).searchParams.get('view')).toBe('order')
  })

  it('prefetches only the order view, never the full family read', () => {
    expect(prefetchKind(familyOrderUrl(ID, 'IT', 'it'))).toBe('family')
    expect(prefetchKind(familyOrderUrl(ID, 'IT', 'it').replace('&view=order', ''))).toBeNull()
  })

  it('the order read adopts the prefetch once, and a reload reads again', async () => {
    const url = familyOrderUrl(ID, 'IT', 'it')
    startPrefetch(url, () => Promise.resolve(new Response('prefetched')))
    const network = vi.fn(() => Promise.resolve(new Response('network')))
    vi.stubGlobal('fetch', network)
    await expect((await fetchStudioRead(url)).text()).resolves.toBe('prefetched')
    await expect((await fetchStudioRead(url)).text()).resolves.toBe('network')
    expect(network).toHaveBeenCalledTimes(1)
  })
})

describe('the prefetch store', () => {
  const answer = (body: string) => () => Promise.resolve(new Response(body))

  it('fetchStudioRead adopts the prefetched read instead of reading again', async () => {
    const url = channelScopeUrl({ productId: ID, channel: 'EBAY', marketplace: 'IT', accountId: ACCOUNT, locale: 'it' })
    startPrefetch(url, answer('prefetched'))
    const network = vi.fn(() => Promise.resolve(new Response('network')))
    vi.stubGlobal('fetch', network)
    await expect((await fetchStudioRead(url)).text()).resolves.toBe('prefetched')
    expect(network).not.toHaveBeenCalled()
    // Used once: the next read of the same URL (a refresh) goes to the network.
    await expect((await fetchStudioRead(url)).text()).resolves.toBe('network')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('a different read of the same kind drops the prefetch: the frame resolved another coordinate', async () => {
    const prefetched = channelScopeUrl({ productId: ID, channel: 'EBAY', marketplace: 'IT', accountId: ACCOUNT, locale: 'it' })
    startPrefetch(prefetched, answer('prefetched'))
    expect(adoptPrefetch(channelScopeUrl({ productId: ID, channel: 'EBAY', marketplace: 'IT', accountId: 'other', locale: 'it' }))).toBeNull()
    expect(adoptPrefetch(prefetched)).toBeNull()
  })

  it('a cancelled adopter (a StrictMode remount) leaves the read for the next one', async () => {
    const url = masterSheetUrl(ID, 'IT', 'it')
    startPrefetch(url, answer('prefetched'))
    const cancelled = new AbortController()
    const first = adoptPrefetch(url, cancelled.signal)
    cancelled.abort()
    await first
    const second = adoptPrefetch(url)
    expect(second).not.toBeNull()
    await expect((await second!).text()).resolves.toBe('prefetched')
    expect(adoptPrefetch(url)).toBeNull()
  })

  it('a failed prefetch falls back to the normal read', async () => {
    const url = masterSheetUrl(ID, 'IT', 'it')
    startPrefetch(url, () => Promise.reject(new TypeError('offline')))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('network'))))
    await expect((await fetchStudioRead(url)).text()).resolves.toBe('network')
  })

  it('the same URL started twice is one request', () => {
    const doFetch = vi.fn(() => Promise.resolve(new Response('x')))
    const url = masterSheetUrl(ID, 'IT', 'it')
    startPrefetch(url, doFetch)
    startPrefetch(url, doFetch)
    expect(doFetch).toHaveBeenCalledTimes(1)
  })
})

describe('the page-load prefetch reads the URL once', () => {
  it('StudioLoader does not subscribe to the search params (every URL change re-rendered the whole studio)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(`${__dirname}/StudioLoader.tsx`, 'utf8')
    expect(src).not.toMatch(/useSearchParams\(|import \{[^}]*useSearchParams/)
    expect(src).toContain('new URLSearchParams(window.location.search)')
  })
})

describe('review 5 — an adopted prefetch is never aborted by its unadopted-expiry timer', () => {
  it('a read the hook adopted and that takes longer than the expiry still completes', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      let answer: (r: Response) => void = () => {}
      startPrefetch(masterSheetUrl(ID, 'IT', 'it'), (_url, init) => { signal = init?.signal ?? undefined; return new Promise((resolve) => { answer = resolve }) })
      const adopted = adoptPrefetch(masterSheetUrl(ID, 'IT', 'it'))
      expect(adopted).not.toBeNull()
      vi.advanceTimersByTime(PREFETCH_TTL_MS + 1_000)
      expect(signal?.aborted).toBe(false)
      answer(new Response('slow but whole'))
      await expect((await adopted!).text()).resolves.toBe('slow but whole')
    } finally { vi.useRealTimers() }
  })
  it('a prefetch nobody adopted is still dropped at the expiry', () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      startPrefetch(masterSheetUrl(ID, 'IT', 'it'), (_url, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}) })
      vi.advanceTimersByTime(PREFETCH_TTL_MS + 1)
      expect(signal?.aborted).toBe(true)
      expect(adoptPrefetch(masterSheetUrl(ID, 'IT', 'it'))).toBeNull()
    } finally { vi.useRealTimers() }
  })
})

describe('review 10 — the prefetch adds nothing the fetch patch owns', () => {
  it('sends no credentials (or headers) of its own: install-fetch adds credentials, CSRF and the workspace', () => {
    let init: RequestInit | undefined
    startPrefetch(masterSheetUrl(ID, 'IT', 'it'), (_url, i) => { init = i; return Promise.resolve(new Response('x')) })
    expect(init).toBeDefined()
    expect(init).not.toHaveProperty('credentials')
    expect(init).not.toHaveProperty('headers')
  })
})
