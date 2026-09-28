import { describe, expect, it } from 'vitest'
import { accountOptions, contentNoteWords, hereWords, madeWords, makeWords, shareLayoutRowWords, shareMadeWords, slotsWords, sourcePlaceWords, toFill, toMake } from './layoutWords'

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
    expect(words).toEqual({ text: 'Made 1 main listing and 1 alias as drafts. A draft sends nothing until you publish it.', notes: [], refused: ['eBay DE: eBay DE is not a market of this business.'] })
    expect(madeWords([{ key: 'k', listings: 0, aliases: 0, refused: null }], () => '').text).toBe('Nothing new was needed: what you chose is already here.')
  })

  it('Settings: one row per channel and account of the other business, and the result for the whole share', () => {
    expect(shareLayoutRowWords({ key: 'EBAY|2', channel: 'EBAY', sourceAccount: 2, sourceAccounts: 2, products: 3, markets: ['DE', 'IT'], aliases: 4, suggestedAccountId: null }, 'Business A'))
      .toEqual({ place: 'eBay · Business A’s account 2 of 2', detail: '3 products · DE, IT · 4 aliases' })
    expect(shareMadeWords({ products: 2, listings: 6, aliases: 1, refused: [{ sku: 'JKT', reason: 'No market.' }] }))
      .toEqual({ text: 'Made drafts for 2 products: 6 listing rows and 1 alias. A draft sends nothing until you publish it.', notes: [], refused: ['JKT: No market.'] })
  })

  it('the account list offers this business’s accounts and “Don’t make it here”', () => {
    const own = { sharedBy: null, markets: [] }
    const shared = { id: 'a1', label: 'A store', primary: false, sharedBy: 'Business A', markets: ['IT'] }
    expect(accountOptions([{ id: 'b1', label: 'B store', primary: true, ...own }, { id: 'b2', label: 'B outlet', primary: false, ...own }, shared], 'IT'))
      .toEqual([{ value: 'b1', label: 'B store (primary)' }, { value: 'b2', label: 'B outlet' }, { value: 'a1', label: 'A store · shared by Business A' }, { value: '', label: 'Don’t make it here' }])
    // A shared account limited to Italy is not offered for Germany.
    expect(accountOptions([shared], 'DE')).toEqual([{ value: '', label: 'Don’t make it here' }])
  })

  it('listing content: what a copy would fill, the here cell and the button', () => {
    // Offered: the listings made now, and the drafts here with no content yet — where the other business has content.
    const [m, w, s] = [{ ...main, content: true }, { ...winter, content: true }, { ...summer, content: true }]
    expect(toFill([m, w], undefined, true)).toBe(2)
    expect(toFill([m, w, s], { main: true, aliases: ['Winter'], blank: { main: false, aliases: ['winter'] } }, true)).toBe(2)
    expect(toFill([m, w], undefined, false)).toBe(0)
    // Nothing to copy from: the other business's alias only follows the product.
    expect(toFill([m, { ...winter, content: false }], undefined, true)).toBe(1)
    expect(hereWords([m, w], { main: true, aliases: ['Winter'], blank: { main: true, aliases: [] } }, true)).toBe('All here · content to copy into 1 draft')
    expect(hereWords([m, w], { main: true, aliases: ['Winter'], blank: { main: false, aliases: [] } }, true)).toBe('All here')
    expect(hereWords([{ ...main, content: false }, w], { main: true, aliases: ['Winter'], blank: { main: true, aliases: [] } }, true)).toBe('All here')
    expect(makeWords({ main: 1, aliases: 1, fill: 2 })).toBe('Make 1 main listing and 1 alias and copy content into 2 listings')
    expect(makeWords({ main: 0, aliases: 0, fill: 1 })).toBe('Copy content into 1 listing')
    expect(makeWords({ main: 0, aliases: 0, fill: 0 })).toBeNull()
    expect(contentNoteWords('Business A')).toBe('Business A also shares listing content: each draft that has no content of its own gets Business A’s title, description, item specifics and category for that listing, once. Prices, stock, shipping and policies stay yours.')
  })

  it('listing content: after making, what was copied, what was left as it is, and each field refused', () => {
    const content = { listings: 2, copied: 14, notShared: 6, refused: [{ listing: 'main listing', field: 'Brand', message: 'The value is too long.' }, { listing: 'Autumn', field: null, message: 'The category is closed.' }],
      noCategory: ['Spring'], onChannel: ['Summer'], ownContent: ['main listing', 'Winter'], otherLanguages: ['de'] }
    expect(madeWords([{ key: 'EBAY|IT|1', listings: 0, aliases: 1, refused: null, content }], () => 'eBay IT')).toEqual({
      text: 'Made 1 alias as drafts. Copied listing content into 2 drafts. A draft sends nothing until you publish it.',
      notes: [
        'eBay IT: The main listing and “Winter” already have content of their own, so they were left as they are.',
        'eBay IT: “Summer” is already on the channel, so it was not changed.',
        'eBay IT: Text in German was not copied. This business does not use this language on that market.',
      ],
      refused: [
        'eBay IT: The content of “Spring” was not copied: it has no category in either business. Choose one on the listing, then copy again.',
        'eBay IT: “Brand” of the main listing was not copied. The value is too long.',
        'eBay IT: The content of “Autumn” was not copied. The category is closed.',
      ],
    })
    const none = { listings: 0, copied: 0, notShared: 0, refused: [], onChannel: [], ownContent: [] }
    expect(madeWords([{ key: 'k', listings: 0, aliases: 0, refused: null, content: none }], () => '').text).toBe('No new drafts were needed. No listing content was copied.')
    // The drafts stand when the copy cannot be made, and the reason is said.
    expect(madeWords([{ key: 'k', listings: 1, aliases: 0, refused: null, content: { ...none, error: 'No content languages configured for EBAY/IT.' } }], () => 'eBay IT'))
      .toEqual({ text: 'Made 1 main listing as drafts. No listing content was copied. A draft sends nothing until you publish it.', notes: [], refused: ['eBay IT: The listing content was not copied. No content languages configured for EBAY/IT.'] })
    expect(shareMadeWords({ products: 1, listings: 0, aliases: 0, content: { listings: 3, copied: 20, ownContent: 1, onChannel: 2 }, refused: [] })).toEqual({
      text: 'No new drafts were needed. Copied listing content into 3 drafts. A draft sends nothing until you publish it.',
      notes: ['1 draft already had content of its own, so it was left as it is.', '2 listings are already on a channel, so they were not changed.'],
      refused: [],
    })
  })
})
