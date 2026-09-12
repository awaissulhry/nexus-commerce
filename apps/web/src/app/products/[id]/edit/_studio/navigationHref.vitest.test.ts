import { describe, expect, it } from 'vitest'
import { studioChannelViewHref, studioViewHref } from './navigationHref'

describe('Studio view links', () => {
  const pathname = '/products/a-product/edit/studio'

  it('preserves channel, market, language, selected record and grid context', () => {
    const original = new URLSearchParams({ scope: 'ebay', market: 'IT', locale: 'it', rec: 'sku/with spaces', cell: 'price:EUR', chip: 'required', tab: 'sheet' })
    const result = new URL(studioViewHref(pathname, original.toString(), 'images'), 'https://nexus.test')
    expect(result.pathname).toBe(pathname)
    expect(result.searchParams.get('tab')).toBe('images')
    for (const [key, value] of original) if (key !== 'tab') expect(result.searchParams.get(key)).toBe(value)
  })

  it('returns to the default Sheet without dropping context or leaving an empty query', () => {
    expect(studioViewHref(pathname, 'tab=images', 'sheet')).toBe(pathname)
    expect(studioViewHref(pathname, 'market=DE&tab=activity&scope=amazon', 'sheet')).toBe(`${pathname}?market=DE&scope=amazon`)
  })

  it('replaces an existing view instead of accumulating conflicting tab parameters', () => {
    const result = new URL(studioViewHref(pathname, 'tab=images&tab=activity', 'errors'), 'https://nexus.test')
    expect(result.searchParams.getAll('tab')).toEqual(['errors'])
  })
})

describe('product channel branch links', () => {
  const pathname = '/products/a-product/edit/studio'
  const ebay = { id: 'EBAY', label: 'eBay', markets: ['IT', 'DE'] }
  const search = 'scope=EBAY&account=store-b&market=IT&listing=b-alt&locale=it&rec=variant&cell=title&chip=required'

  it.each(['presentation', 'variation-order'] as const)('keeps the selected eBay account, listing and record when opening %s', tab => {
    const url = new URL(studioChannelViewHref(pathname, search, 'EBAY', 'IT', ebay, tab), 'https://nexus.test')
    expect(url.pathname).toBe(pathname)
    expect(url.searchParams.get('tab')).toBe(tab)
    for (const [key, value] of new URLSearchParams(search)) expect(url.searchParams.get(key)).toBe(value)
  })

  it('switches between an eBay task and the Variants page without changing the alias destination', () => {
    const variants = studioChannelViewHref(pathname, search + '&tab=variation-order', 'EBAY', 'IT', ebay, 'variants')
    const url = new URL(variants, 'https://nexus.test')
    expect(url.searchParams.get('tab')).toBe('variants')
    for (const [key, value] of new URLSearchParams(search)) expect(url.searchParams.get(key)).toBe(value)
    const order = new URL(studioViewHref(pathname, url.search, 'variation-order'), 'https://nexus.test')
    expect(order.searchParams.get('tab')).toBe('variation-order')
    expect(order.searchParams.get('listing')).toBe('b-alt')
    expect(order.searchParams.get('account')).toBe('store-b')
  })

  it('clears the previous channel’s account, listing and record when following an Amazon branch', () => {
    const amazon = { id: 'AMAZON', label: 'Amazon', markets: ['IT'] }
    const url = new URL(studioChannelViewHref(pathname, search + '&tab=presentation', 'EBAY', 'IT', amazon, 'sheet'), 'https://nexus.test')
    expect(url.pathname).toBe(pathname)
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'AMAZON', market: 'IT', locale: 'it' })
  })

  it('selects an available target market instead of carrying an unsupported market across channels', () => {
    const url = new URL(studioChannelViewHref(pathname, 'scope=AMAZON&market=US&account=amazon-store', 'AMAZON', 'US', ebay, 'presentation'), 'https://nexus.test')
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'EBAY', market: 'IT', tab: 'presentation' })
  })

  it('does not assign a primary account in a branch URL from Shared scope', () => {
    const url = new URL(studioChannelViewHref(pathname, 'market=DE', 'master', 'DE', ebay, 'presentation'), 'https://nexus.test')
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'EBAY', market: 'DE', tab: 'presentation' })
  })
})
