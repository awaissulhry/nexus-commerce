import { describe, expect, it } from 'vitest'
import { accountOptions, hereWords, madeWords, makeWords, shareLayoutRowWords, shareMadeWords, slotsWords, sourcePlaceWords, toMake } from './layoutWords'

const main = { position: 0, label: null }
const winter = { position: 1, label: 'Winter' }
const summer = { position: 2, label: 'Summer' }

describe('the listing layout words', () => {
  it('names where the other business lists it, and its account only when it uses more than one', () => {
    expect(sourcePlaceWords({ channel: 'EBAY', marketplace: 'IT', sourceAccount: 1, sourceAccounts: 1 }, 'Business A')).toBe('eBay IT')
    expect(sourcePlaceWords({ channel: 'EBAY', marketplace: 'DE', sourceAccount: 2, sourceAccounts: 2 }, 'Business A')).toBe('eBay DE · Business A’s account 2 of 2')
  })

  it('says what is listed there', () => {
    expect(slotsWords([main])).toBe('Main listing')
    expect(slotsWords([main, winter, summer])).toBe('Main listing and 2 aliases: Winter, Summer')
    expect(slotsWords([winter])).toBe('1 alias: Winter')
  })

  it('makes only what is missing on the chosen account (alias names match without case)', () => {
    expect(toMake([main, winter], undefined)).toEqual({ main: true, aliases: ['Winter'] })
    expect(toMake([main, winter], { main: true, aliases: ['winter '] })).toEqual({ main: false, aliases: [] })
    expect(hereWords([main, winter], { main: true, aliases: ['Winter'] })).toBe('All here')
    expect(hereWords([main, winter], { main: false, aliases: [] })).toBe('Nothing here yet')
    expect(hereWords([main, winter, summer], { main: true, aliases: ['Winter'] })).toBe('Partly here: 1 alias to make')
  })

  it('the button counts what it will make, and there is no button when nothing is missing', () => {
    expect(makeWords({ main: 1, aliases: 2 })).toBe('Make 1 main listing and 2 aliases')
    expect(makeWords({ main: 0, aliases: 1 })).toBe('Make 1 alias')
    expect(makeWords({ main: 0, aliases: 0 })).toBeNull()
  })

  it('after making: what was made, and each refusal with its place', () => {
    const words = madeWords([
      { key: 'EBAY|IT|1', listings: 3, aliases: 1, refused: null },
      { key: 'EBAY|DE|2', listings: 0, aliases: 0, refused: 'eBay DE is not a market of this business.' },
    ], (key) => (key === 'EBAY|DE|2' ? 'eBay DE' : 'eBay IT'))
    expect(words).toEqual({ text: 'Made 1 main listing and 1 alias as drafts. A draft sends nothing until you publish it.', refused: ['eBay DE: eBay DE is not a market of this business.'] })
    expect(madeWords([{ key: 'k', listings: 0, aliases: 0, refused: null }], () => '').text).toBe('Nothing new was needed: what you chose is already here.')
  })

  it('Settings: one row per channel and account of the other business, and the result for the whole share', () => {
    expect(shareLayoutRowWords({ key: 'EBAY|2', channel: 'EBAY', sourceAccount: 2, sourceAccounts: 2, products: 3, markets: ['DE', 'IT'], aliases: 4, suggestedAccountId: null }, 'Business A'))
      .toEqual({ place: 'eBay · Business A’s account 2 of 2', detail: '3 products · DE, IT · 4 aliases' })
    expect(shareMadeWords({ products: 2, listings: 6, aliases: 1, refused: [{ sku: 'JKT', reason: 'No market.' }] }))
      .toEqual({ text: 'Made drafts for 2 products: 6 listing rows and 1 alias. A draft sends nothing until you publish it.', refused: ['JKT: No market.'] })
  })

  it('the account list offers this business’s accounts and “Don’t make it here”', () => {
    const own = { sharedBy: null, markets: [] }
    const shared = { id: 'a1', label: 'A store', primary: false, sharedBy: 'Business A', markets: ['IT'] }
    expect(accountOptions([{ id: 'b1', label: 'B store', primary: true, ...own }, { id: 'b2', label: 'B outlet', primary: false, ...own }, shared], 'IT'))
      .toEqual([{ value: 'b1', label: 'B store (primary)' }, { value: 'b2', label: 'B outlet' }, { value: 'a1', label: 'A store · shared by Business A' }, { value: '', label: 'Don’t make it here' }])
    // A shared account limited to Italy is not offered for Germany.
    expect(accountOptions([shared], 'DE')).toEqual([{ value: '', label: 'Don’t make it here' }])
  })
})
