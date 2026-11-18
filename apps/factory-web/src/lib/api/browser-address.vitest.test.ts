import { describe, expect, it } from 'vitest'
import { browserAddress } from './browser-address'

describe('a stored file address as the browser opens it (end check)', () => {
  it("the local store's path goes through this app's /api proxy", () => {
    expect(browserAddress('/local-files?token=abc')).toBe('/api/local-files?token=abc')
  })
  it('an absolute or protocol-relative address is used as it is', () => {
    expect(browserAddress('https://store.example.com/k?sig=1')).toBe('https://store.example.com/k?sig=1')
    expect(browserAddress('//store.example.com/k')).toBe('//store.example.com/k')
  })
})
