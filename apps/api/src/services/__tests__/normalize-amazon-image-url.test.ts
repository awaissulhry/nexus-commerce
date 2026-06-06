/**
 * Image URL normalizer verifier — strips Amazon size modifiers → full-res.
 */

import { describe, it, expect } from 'vitest'
import { normalizeAmazonImageUrl } from '../images/normalize-amazon-image-url.js'

describe('normalizeAmazonImageUrl', () => {
  it('strips a size modifier to full-res', () => {
    expect(normalizeAmazonImageUrl('https://m.media-amazon.com/images/I/41rem1s06zL._SL75_.jpg')).toBe(
      'https://m.media-amazon.com/images/I/41rem1s06zL.jpg',
    )
  })
  it('strips compound modifiers (_AC_SX466_)', () => {
    expect(normalizeAmazonImageUrl('https://m.media-amazon.com/images/I/71xyz._AC_SX466_.jpg')).toBe(
      'https://m.media-amazon.com/images/I/71xyz.jpg',
    )
  })
  it('leaves already-clean full-res URLs unchanged', () => {
    const u = 'https://m.media-amazon.com/images/I/811HWZOl7TL.jpg'
    expect(normalizeAmazonImageUrl(u)).toBe(u)
  })
  it('preserves ids containing +', () => {
    const u = 'https://m.media-amazon.com/images/I/91+TNBtqhhL.jpg'
    expect(normalizeAmazonImageUrl(u)).toBe(u)
  })
  it('preserves a query string', () => {
    expect(normalizeAmazonImageUrl('https://m.media-amazon.com/images/I/41rem1s06zL._SL75_.jpg?v=2')).toBe(
      'https://m.media-amazon.com/images/I/41rem1s06zL.jpg?v=2',
    )
  })
  it('handles the ssl-images-amazon host', () => {
    expect(normalizeAmazonImageUrl('https://images-na.ssl-images-amazon.com/images/I/abc._SS40_.png')).toBe(
      'https://images-na.ssl-images-amazon.com/images/I/abc.png',
    )
  })
  it('no-ops non-Amazon URLs (Cloudinary etc.)', () => {
    const u = 'https://res.cloudinary.com/demo/image/upload/v1/x._SL75_.jpg'
    expect(normalizeAmazonImageUrl(u)).toBe(u)
  })
  it('no-ops empty / non-string', () => {
    expect(normalizeAmazonImageUrl('')).toBe('')
    expect(normalizeAmazonImageUrl(null as any)).toBe(null)
  })
})
