/**
 * PES.1 — the scope derivation, tested against the shape prod actually returns.
 *
 * The fixture below is the REAL marketplace table, read from
 * `GET /api/marketplaces/grouped` on 2026-09-01: eleven country markets plus the webstore's
 * `GLOBAL` pseudo-market, five of them (DE/ES/FR/IT/UK) served by exactly two channels. That
 * five-way tie is the reason `defaultMarket` is documented as a fallback rather than an answer,
 * and it is asserted here so nobody "fixes" the tiebreak believing it was ever meaningful.
 *
 * Owner D20, 2026-09-13: retain WooCommerce as a visible, read-only Presence scope.
 * Channel/market/tab membership below is navigation availability, not a selling fact or
 * permission to write. The fixture predates the containment ruling and cannot grant either.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import {
  channelLabel,
  channelServesMarket,
  defaultLocaleFor,
  defaultMarket,
  historyStateIsInternal,
  deriveScopeOptions,
  flattenGrouped,
  primaryLanguageFrom,
  scopeLanguages,
  localeLabel,
  marketLabel,
  tabAvailable,
  visibleTabs,
} from './scopes'
import { STUDIO_TABS } from './types'

const AMAZON = ['DE', 'ES', 'FR', 'IT', 'UK', 'BE', 'IE', 'NL', 'PL', 'SE', 'TR']
const EBAY = ['DE', 'ES', 'FR', 'IT', 'UK']
const LANG: Record<string, string> = {
  DE: 'de', ES: 'es', FR: 'fr', IT: 'it', UK: 'en', BE: 'nl', IE: 'en',
  NL: 'nl', PL: 'pl', SE: 'sv', TR: 'tr', GLOBAL: 'en',
}

const GROUPED = {
  AMAZON: AMAZON.map((code) => ({ id: `a-${code}`, channel: 'AMAZON', code, name: `Amazon ${code}`, language: LANG[code], languages: [LANG[code]] })),
  EBAY: EBAY.map((code) => ({ id: `e-${code}`, channel: 'EBAY', code, name: `eBay ${code}`, language: LANG[code], languages: [LANG[code]] })),
  SHOPIFY: [{ id: 's-g', channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', language: 'en', languages: ['en'] }],
  WOOCOMMERCE: [{ id: 'w-g', channel: 'WOOCOMMERCE', code: 'GLOBAL', name: 'Woo', language: 'en', languages: ['en'] }],
  ETSY: [{ id: 't-g', channel: 'ETSY', code: 'GLOBAL', name: 'Etsy', language: 'en', languages: ['en'] }],
}

const rows = flattenGrouped(GROUPED)
const options = deriveScopeOptions(rows)

it('mirrors the optional ordered language array on every SheetCoordinate wire type', () => {
  const root = new URL('../../../../../../../../', import.meta.url)
  const paths = ['apps/api/src/services/pim/sheet-columns.service.ts',
    'apps/web/src/app/products/_sheet/types.ts',
    'apps/web/src/app/products/[id]/edit/_studio/sheet/master/types.ts',
    'apps/web/src/app/products/[id]/edit/_studio/drawer/types.ts']
  for (const path of paths) {
    const file = ts.createSourceFile(path, readFileSync(new URL(path, root), 'utf8'), ts.ScriptTarget.Latest, true)
    const coordinate = file.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'SheetCoordinate')!
    const property = coordinate.members.find(node => node.name?.getText(file) === 'languages') as ts.PropertySignature
    expect(property, path).toBeDefined()
    expect(property.questionToken, path).toBeDefined()
    expect(property.type?.getText(file), path).toBe('string[]')
  }
})

it('mirrors the wizard language metadata from its payload producer', () => {
  const root = new URL('../../../../../../../../', import.meta.url)
  for (const path of ['apps/api/src/services/listing-wizard/submission.service.ts', 'apps/web/src/app/products/[id]/list-wizard/steps/Step9Review.tsx']) {
    const file = ts.createSourceFile(path, readFileSync(new URL(path, root), 'utf8'), ts.ScriptTarget.Latest, true)
    const declaration = file.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'ChannelPayloadEntry')!
    const property = declaration.members.find(node => node.name?.getText(file) === 'language') as ts.PropertySignature
    expect(property.questionToken, path).toBeDefined()
    expect(property.type?.getText(file), path).toBe('string')
  }
})

describe('flattenGrouped', () => {
  it('reads every row out of the grouped shape', () => {
    expect(rows).toHaveLength(AMAZON.length + EBAY.length + 3)
  })

  it('survives a malformed group instead of emptying the bar', () => {
    // One bad key must not cost the operator the channels that ARE readable — this is the whole
    // reason the parser is defensive rather than a cast.
    const out = flattenGrouped({
      AMAZON: [{ id: 'a', channel: 'AMAZON', code: 'IT', name: 'Amazon IT', language: 'it' }],
      // A STRING is iterable, so `for...of` walks its characters and the per-row object check
      // absorbs it. A plain object is NOT iterable and throws outright — which is the case only
      // `Array.isArray` can catch, and the reason that line is not redundant.
      EBAY: 'not-an-array',
      ETSY: {},
      SHOPIFY: [null, { code: null }, { id: 's', channel: 'SHOPIFY', code: 'GLOBAL', name: 'S', language: 'en', languages: ['en'] }],
    })
    expect(out.map((r) => `${r.channel}:${r.code}`)).toEqual(['AMAZON:IT', 'SHOPIFY:GLOBAL'])
  })

  it('returns nothing rather than throwing on a non-object', () => {
    expect(flattenGrouped(null)).toEqual([])
    expect(flattenGrouped('nope')).toEqual([])
  })
})

describe('deriveScopeOptions', () => {
  it('orders channels by the console\'s own order, not alphabetically', () => {
    expect(options.channels.map((c) => c.id)).toEqual(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
  })

  it('records which markets each channel actually serves', () => {
    expect(options.channels.find((c) => c.id === 'EBAY')!.markets).toEqual([...EBAY].sort())
    expect(options.channels.find((c) => c.id === 'ETSY')!.markets).toEqual(['GLOBAL'])
  })

  it('collects content locales from the marketplace rows, deduplicated', () => {
    expect(options.locales.map((l) => l.code)).toEqual(['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'sv', 'tr'])
  })
})

describe('defaultMarket', () => {
  it('never lands on GLOBAL, even though it has the most channels', () => {
    // GLOBAL has three; every real market has at most two. Without the guard it wins every time.
    expect(options.markets.some((m) => m.code === 'GLOBAL')).toBe(true)
    expect(defaultMarket(options)).not.toBe('GLOBAL')
  })

  it('is a five-way tie in prod, broken alphabetically — a deterministic answer, not a meaningful one', () => {
    const twoChannel = options.markets.filter((m) => m.channels.length === 2).map((m) => m.code)
    expect(twoChannel).toEqual(['DE', 'ES', 'FR', 'IT', 'UK'])
    expect(defaultMarket(options)).toBe('DE')
  })

  it('is INVARIANT to the order the marketplaces API returns rows in', () => {
    /*
     * ⚠ This test PASSES on the pre-fix implementation too, and that is the point of keeping it.
     *
     * A review lane read `pool.reduce((best, m) => m.channels.length > best.channels.length …)` —
     * strict `>`, no tiebreak, `reduce` keeps the first element — and concluded the landing market
     * followed the API's row order, which would make an unpinned deep link resolve differently per
     * load. Mutation-tested here: restoring that exact implementation leaves all of these green,
     * because `deriveScopeOptions` sorts the market keys before `defaultMarket` ever sees them.
     * The tiebreak was real; it just lived in the caller.
     *
     * So this pins the PROPERTY (order in must not change market out) rather than the fix, and it
     * now holds without depending on another function to hold it up.
     */
    const forward = defaultMarket(deriveScopeOptions(rows))
    const reversed = defaultMarket(deriveScopeOptions([...rows].reverse()))
    const rotated = defaultMarket(deriveScopeOptions([...rows.slice(7), ...rows.slice(0, 7)]))
    const shuffled = defaultMarket(
      deriveScopeOptions([...rows].sort((a, b) => a.id.localeCompare(b.id))),
    )
    expect([forward, reversed, rotated, shuffled]).toEqual(['DE', 'DE', 'DE', 'DE'])
  })

  it('cannot return a single-channel market — so PL was never reachable from here', () => {
    /*
     * The concrete half of the same correction. An unpinned deep link was observed resolving to DE
     * on one load and PL on the next, and this function was named as the cause. PL is served by one
     * channel and DE by two, so PL loses on count before any tiebreak is consulted: no ordering of
     * the input can produce it. Whatever varies that link, it is not this.
     */
    expect(options.markets.find((m) => m.code === 'PL')!.channels).toEqual(['AMAZON'])
    const winner = defaultMarket(options)!
    const winnerChannels = options.markets.find((m) => m.code === winner)!.channels.length
    const maxChannels = Math.max(
      ...options.markets.filter((m) => m.code !== 'GLOBAL').map((m) => m.channels.length),
    )
    expect(winnerChannels).toBe(maxChannels)
    expect(winner).not.toBe('PL')
  })

  it('lets channel count win over the alphabet — the tiebreak is only a tiebreak', () => {
    // ZZ sells on three channels, AA on one. Alphabetical order must not override the real signal.
    const opts = {
      channels: [],
      locales: [],
      markets: [
        { code: 'AA', label: 'AA', channels: ['AMAZON'] },
        { code: 'ZZ', label: 'ZZ', channels: ['AMAZON', 'EBAY', 'SHOPIFY'] },
      ],
    }
    expect(defaultMarket(opts)).toBe('ZZ')
    expect(defaultMarket({ ...opts, markets: [...opts.markets].reverse() })).toBe('ZZ')
  })

  it('does not reorder the caller\'s own market list', () => {
    // `pool` IS `options.markets` in the GLOBAL-only branch, so an in-place sort would reorder the
    // scope bar's chips as a side effect of asking what the default is.
    const o = deriveScopeOptions(rows)
    const before = o.markets.map((m) => m.code)
    defaultMarket(o)
    expect(o.markets.map((m) => m.code)).toEqual(before)
  })

  it('opens the store-wide market when only Shopify is configured', () => {
    const only = deriveScopeOptions(flattenGrouped({ SHOPIFY: GROUPED.SHOPIFY }))
    expect(defaultMarket(only)).toBe('GLOBAL')
  })

  it('returns null rather than inventing a market when there are none', () => {
    expect(defaultMarket(deriveScopeOptions([]))).toBeNull()
  })
})

describe('defaultLocaleFor', () => {
  it('uses Belgium’s ordered array and keeps channels separate when codes collide', () => {
    const configured = flattenGrouped({
      AMAZON: [{ id: 'be-a', channel: 'AMAZON', code: 'BE', name: 'Belgium', language: 'nl', languages: ['nl', 'fr'] }],
      EBAY: [{ id: 'be-e', channel: 'EBAY', code: 'BE', name: 'Belgium', language: 'en', languages: ['en'] }],
    })
    expect(defaultLocaleFor('BE', configured, 'AMAZON')).toBe('nl')
    expect(defaultLocaleFor('BE', configured, 'EBAY')).toBe('en')
    expect(defaultLocaleFor('BE', [...configured].reverse(), 'AMAZON')).toBe('nl')
    expect(deriveScopeOptions(configured).locales.map(l => l.code)).toEqual(['en', 'fr', 'nl'])
    const reordered = configured.map(row => row.channel === 'AMAZON' ? { ...row, languages: ['fr', 'nl'] } : row)
    expect(defaultLocaleFor('BE', reordered, 'AMAZON')).toBe('fr')
    expect(defaultLocaleFor('BE', configured, 'ETSY')).toBeNull()
  })

  it('takes the market\'s own configured language', () => {
    expect(defaultLocaleFor('IT', rows, 'AMAZON')).toBe('it')
    expect(defaultLocaleFor('DE', rows, 'AMAZON')).toBe('de')
  })

  it('is null for a market nobody sells in — not a guessed "en"', () => {
    expect(defaultLocaleFor('ZZ', rows, 'AMAZON')).toBeNull()
  })
})

describe('channelServesMarket', () => {
  it('distinguishes an available scope chip from a disabled one', () => {
    expect(channelServesMarket('EBAY', 'IT', options)).toBe(true)
    // eBay is not configured for Poland — its chip must be disabled, not silently clickable.
    expect(channelServesMarket('EBAY', 'PL', options)).toBe(false)
    expect(channelServesMarket('AMAZON', 'PL', options)).toBe(true)
    expect(channelServesMarket('NOPE', 'IT', options)).toBe(false)
  })
})

describe('labels', () => {
  it('spells channels the way the company does, and title-cases anything unknown', () => {
    expect(channelLabel('EBAY')).toBe('eBay')
    expect(channelLabel('WOOCOMMERCE')).toBe('WooCommerce')
    expect(channelLabel('TIKTOK')).toBe('Tiktok')
  })

  it('names a country from its code, and leaves GLOBAL alone instead of throwing', () => {
    expect(marketLabel('IT')).toBe('IT · Italy')
    // `Intl.DisplayNames#of` throws on a malformed code; GLOBAL is exactly that case, and the
    // switcher must still render it.
    expect(marketLabel('GLOBAL')).toBe('GLOBAL')
  })

  it('names a language, and passes through one it has no entry for', () => {
    expect(localeLabel('it')).toBe('Italian (it)')
    expect(localeLabel('zz')).toBe('zz')
  })
})

describe('which tabs a scope offers', () => {
  it('offers linked families and metafields only for Shopify, including direct URLs', () => {
    for (const tab of ['shopify-family', 'shopify-metafields'] as const) {
      expect(visibleTabs('SHOPIFY')).toContain(tab)
      expect(tabAvailable(tab, 'SHOPIFY')).toBe(true)
      for (const scope of ['master', 'EBAY', 'AMAZON', 'ETSY']) expect(tabAvailable(tab, scope)).toBe(false)
    }
  })
  it('offers Errors & Sync on master too — the strip is the same on every scope (CH.1, 2026-09-05); the tab itself says master holds no queue', () => {
    expect(visibleTabs('master')).toEqual(['sheet', 'matrix', 'variants', 'images', 'errors', 'analytics', 'activity'])
    expect(tabAvailable('errors', 'master')).toBe(true)
  })

  it('offers it on any channel scope', () => {
    expect(visibleTabs('EBAY')).toEqual(['sheet', 'matrix', 'variants', 'images', 'presentation', 'variation-order', 'errors', 'analytics', 'activity'])
    expect(tabAvailable('errors', 'AMAZON')).toBe(true)
  })

  it('leaves every unconditional tab in both', () => {
    for (const t of ['sheet', 'images', 'analytics', 'activity'] as const) {
      expect(tabAvailable(t, 'master')).toBe(true)
      expect(tabAvailable(t, 'EBAY')).toBe(true)
    }
  })

  it('🔴 keeps the strip and the URL reader on ONE answer', () => {
    // Both call `visibleTabs`. Whatever the strip renders, the reader accepts — and nothing else —
    // otherwise the session could sit on a tab the strip does not render, with no way back to it.
    expect(tabAvailable('presentation', 'master')).toBe(false)
    expect(tabAvailable('presentation', 'AMAZON')).toBe(false)
    expect(tabAvailable('presentation', 'EBAY')).toBe(true)
    for (const t of visibleTabs('master')) expect(tabAvailable(t, 'master')).toBe(true)
  })

  it('🔴 offers Variants on EVERY scope, directly after Information — one page, re-projected', () => {
    // Rescued verbatim from the deleted `variants/variants.vitest.test.ts` (variants spec §6). It is the IA
    // assertion of the whole page: a channel reaches its projection through the SCOPE BAR, so if a scope ever
    // stopped offering `variants` that channel would have no way to its own projection at all (§1.1/§1.2).
    for (const scope of ['master', 'AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE']) {
      expect(visibleTabs(scope).slice(0, 3)).toEqual(['sheet', 'matrix', 'variants'])
    }
  })

  it('🔴 MX.P — offers Matrix on EVERY scope, DIRECTLY under Information, and never as a channel-only item', () => {
    // `docs/2026-09-13-matrix-page-design.md` Revision: ONE Matrix page showing every coordinate at once;
    // the scope bar's chips FILTER its groups. A scope that stopped offering it would have no route to its
    // own coordinate's offer cells — the same IA failure the Variants assertion above exists to catch.
    for (const scope of ['master', 'AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE']) {
      expect(tabAvailable('matrix', scope)).toBe(true)
      expect(visibleTabs(scope)[1]).toBe('matrix')
    }
    // And it is its OWN tab id, not a rename of `variants`: both are in the list, in this order.
    expect(STUDIO_TABS.indexOf('matrix')).toBe(1)
    expect(STUDIO_TABS.indexOf('variants')).toBe(2)
  })

  it('🔴 Relationships stays removed from navigation and URL availability', () => {
    // Removed on the Owner's call (2026-09-12); stale links fall back to Information.
    for (const scope of ['master', 'AMAZON', 'EBAY', 'SHOPIFY']) {
      expect(tabAvailable('relationships' as never, scope)).toBe(false)
      expect(visibleTabs(scope)).not.toContain('relationships')
    }
    expect(STUDIO_TABS).not.toContain('relationships')
  })

  it('restores Variation order for eBay navigation and bookmarked URLs only', () => {
    expect(STUDIO_TABS).toContain('variation-order')
    expect(tabAvailable('variation-order', 'EBAY')).toBe(true)
    expect(visibleTabs('EBAY')).toContain('variation-order')
    for (const scope of ['master', 'AMAZON', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE']) {
      expect(tabAvailable('variation-order', scope)).toBe(false)
      expect(visibleTabs(scope)).not.toContain('variation-order')
    }
  })
})

describe('historyStateIsInternal — the form that silently stopped every studio URL write', () => {
  it('flags the state Next actually puts on every entry it writes', () => {
    // This is what `window.history.state` looks like after any Next navigation. Passing it to
    // pushState takes the early return, skips the URL apply, and nothing re-renders.
    expect(historyStateIsInternal({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ['x'] })).toBe(true)
  })

  it('flags the legacy pages-router marker too', () => {
    expect(historyStateIsInternal({ _N: true })).toBe(true)
  })

  it('passes the fresh object the flush actually uses', () => {
    // `{}` falls through to copyNextJsInternalHistoryState, which puts __NA and the internals tree
    // back — so the entry keeps Next's state AND the router's canonical URL is updated.
    expect(historyStateIsInternal({})).toBe(false)
  })

  it('treats null/undefined as not-internal rather than throwing on them', () => {
    // It guards a value handed over by the browser, so it must survive every shape of it.
    expect(historyStateIsInternal(null)).toBe(false)
    expect(historyStateIsInternal(undefined)).toBe(false)
    expect(historyStateIsInternal('__NA')).toBe(false)
    expect(historyStateIsInternal(0)).toBe(false)
  })

  it('does not fire on a falsy __NA — the marker must be truthy, as Next tests it', () => {
    expect(historyStateIsInternal({ __NA: false })).toBe(false)
  })
})


describe('language chips use server metadata on every scope', () => {
  const markets = flattenGrouped({
    AMAZON: [{ code: 'BE', language: 'nl', languages: ['nl', 'fr'] }, { code: 'DE', languages: ['de'] }],
    EBAY: [{ code: 'IT', languages: ['it'] }],
    SHOPIFY: [{ code: 'GLOBAL', languages: ['fr', 'en'] }],
    ETSY: [{ code: 'GLOBAL', languages: ['es'] }],
    _meta: { primaryLanguage: 'it' },
  })
  it('keeps the configured source first in the shared union independently of the market', () => {
    expect(scopeLanguages('master', 'BE', markets, 'it')).toEqual(['it', 'de', 'en', 'es', 'fr', 'nl'])
    expect(scopeLanguages('master', 'DE', markets, 'it')).toEqual(scopeLanguages('master', 'BE', markets, 'it'))
    expect(primaryLanguageFrom({ _meta: { primaryLanguage: 'fr' } })).toBe('fr')
    expect(primaryLanguageFrom({})).toBeNull()
  })
  it.each([['AMAZON', 'BE', ['nl', 'fr']], ['AMAZON', 'DE', ['de']], ['EBAY', 'IT', ['it']], ['SHOPIFY', 'GLOBAL', ['fr', 'en']], ['ETSY', 'GLOBAL', ['es']]])('projects %s %s without a channel-specific list', (scope, market, languages) => {
    expect(scopeLanguages(scope as string, market as string, markets, 'it')).toEqual(languages)
  })
  it('does not infer a language from another channel or the legacy scalar', () => {
    expect(scopeLanguages('EBAY', 'BE', markets, 'it')).toEqual([])
    expect(flattenGrouped({ AMAZON: [{ code: 'IT', language: 'it' }] })[0].languages).toEqual([])
  })
})
