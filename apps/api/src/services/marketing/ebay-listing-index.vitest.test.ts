import { describe, it, expect } from 'vitest'
import { parseActiveList, parseItemDetail } from './ebay-listing-index.service.js'

// EV2 — protects the image-URL extraction (GalleryURL in the ActiveList sweep,
// PictureURL[0] in GetItem) including entity decoding.

describe('EV2 — parseActiveList galleryUrl', () => {
  const xml = `<Item><ItemID>256550369887</ItemID><Title>Giacca Moto</Title>
    <SellingStatus><CurrentPrice currencyID="EUR">109.99</CurrentPrice></SellingStatus>
    <PictureDetails><GalleryURL>https://i.ebayimg.com/images/g/abc/s-l140.jpg?ver=1&amp;x=2</GalleryURL></PictureDetails>
    <QuantityAvailable>7</QuantityAvailable></Item>`
  it('extracts and entity-decodes the gallery URL', () => {
    const items = parseActiveList(xml)
    expect(items).toHaveLength(1)
    expect(items[0].galleryUrl).toBe('https://i.ebayimg.com/images/g/abc/s-l140.jpg?ver=1&x=2')
    expect(items[0].priceValue).toBe(109.99)
  })
  it('absent gallery ⇒ undefined (no fake)', () => {
    expect(parseActiveList('<Item><ItemID>1</ItemID></Item>')[0].galleryUrl).toBeUndefined()
  })
})

describe('EV2 — parseItemDetail pictureUrl', () => {
  it('takes the FIRST PictureURL inside PictureDetails', () => {
    const d = parseItemDetail(`<Item><Site>Italy</Site>
      <PictureDetails><PictureURL>https://i.ebayimg.com/00/first.jpg</PictureURL><PictureURL>https://i.ebayimg.com/00/second.jpg</PictureURL></PictureDetails>
      <ItemSpecifics></ItemSpecifics></Item>`)
    expect(d.pictureUrl).toBe('https://i.ebayimg.com/00/first.jpg')
    expect(d.site).toBe('Italy')
  })
  it('no pictures ⇒ undefined', () => {
    expect(parseItemDetail('<Item><Site>Italy</Site></Item>').pictureUrl).toBeUndefined()
  })
})
