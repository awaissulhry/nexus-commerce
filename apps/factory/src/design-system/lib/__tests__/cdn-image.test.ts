import { describe, expect, it } from 'vitest'
import { cdnFit, cdnSquare } from '../cdn-image'

describe('Shopify CDN renditions', () => {
  it('preserves the version while replacing square dimensions with an uncropped preview', () => {
    const original = 'https://cdn.shopify.com/s/files/1/front.jpg?v=123'
    const square = new URL(cdnSquare(original, 160))
    expect(Object.fromEntries(square.searchParams)).toEqual({ v: '123', width: '160', height: '160', crop: 'center' })
    const preview = new URL(cdnFit(square.href, 800))
    expect(Object.fromEntries(preview.searchParams)).toEqual({ v: '123', width: '800' })
  })
  it('leaves files, videos, unknown hosts and malformed URLs untouched', () => {
    for (const url of ['https://cdn.shopify.com/files/manual.pdf', 'https://cdn.shopify.com/videos/demo.mp4', 'https://cdn.shopify.com.evil.example/front.jpg', '/local.jpg']) {
      expect(cdnFit(url, 800)).toBe(url)
      expect(cdnSquare(url, 160)).toBe(url)
    }
  })
})
