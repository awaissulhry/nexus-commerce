import { describe, expect, it } from 'vitest'
import { createPresetRequestGate, displayPresetValue, productPresetDraftHref, productPresetStudioHref, productPresetScopeKey } from './product-preset-contract'
const scope = { productId: 'product/one', channel: 'AMAZON' as const, accountId: 'a/one', market: 'IT', listingId: 'listing/one', aliasKey: '' }
describe('product preset review lifetime', () => {
  it.each(['productId', 'channel', 'accountId', 'market', 'listingId', 'aliasKey'])('invalidates the feature for a changed %s', key => {
    expect(productPresetScopeKey({ ...scope, [key]: 'different' })).not.toBe(productPresetScopeKey(scope))
  })
  it('ignores late previews and applies after cancel, a newer selection or scope unmount, even when transport ignores abort', async () => {
    for (const event of ['cancel', 'replace', 'unmount']) {
      const gate = createPresetRequestGate()
      let finish!: (value: string) => void
      const delayed = new Promise<string>(resolve => { finish = resolve })
      const request = gate.begin(), results: string[] = []
      const continuation = delayed.then(value => { if (request.current()) results.push(value) })
      if (event === 'replace') gate.begin(); else gate.cancel()
      finish('Old account preview / apply receipt')
      await continuation
      expect(request.signal.aborted).toBe(true)
      expect(results).toEqual([])
      const current = gate.begin(); expect(current.current()).toBe(true)
    }
  })
  it('retains every reviewed coordinate in a resume URL, including explicit primary alias and listing absence', () => {
    const url = new URL(productPresetDraftHref('wizard/a', scope), 'https://fixture.test')
    expect(url.pathname).toBe('/products/product%2Fone/list-wizard')
    expect(Object.fromEntries(url.searchParams)).toEqual({ wizard: 'wizard/a', channel: 'AMAZON', accountId: 'a/one', marketplace: 'IT', listingId: 'listing/one', aliasKey: '' })
    expect(new URL(productPresetDraftHref('wizard', { ...scope, listingId: null }), url).searchParams.has('listingId')).toBe(true)
  })
  it('distinguishes absent, blank, null and false in review', () => {
    expect(new Set([{ absent: true }, { value: '' }, { value: null }, { value: false }].map(displayPresetValue)).size).toBe(4)
  })
  it('returns to Information with the reviewed market, account and exact listing', () => {
    const url = new URL(productPresetStudioHref(scope), 'https://fixture.test')
    expect(url.pathname).toBe('/products/product%2Fone/edit')
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'AMAZON', account: 'a/one', market: 'IT', listing: 'listing/one' })
  })
})
