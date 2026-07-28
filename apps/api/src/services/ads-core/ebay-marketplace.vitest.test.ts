/** D3 — one marketplace map, and no silent defaults. */
import { describe, it, expect } from 'vitest'
import {
  marketplaceShort, marketplaceShortOrNull, isKnownEbayMarketplace,
  EBAY_MARKETPLACE_SHORT, UnknownEbayMarketplaceError,
} from './ebay-marketplace.js'

describe('marketplaceShort', () => {
  it('maps every marketplace the ads layer accepts, GB included', () => {
    expect(marketplaceShort('EBAY_IT')).toBe('IT')
    expect(marketplaceShort('EBAY_DE')).toBe('DE')
    expect(marketplaceShort('EBAY_FR')).toBe('FR')
    expect(marketplaceShort('EBAY_ES')).toBe('ES')
    // The whole defect: four of seven maps omitted this one.
    expect(marketplaceShort('EBAY_GB')).toBe('UK')
  })

  it('THROWS on unknown rather than returning undefined', () => {
    // routes:633 returned undefined, which dropped the marketplace predicate in
    // getLiveEbayItemIds and could resolve Italian item IDs into a GB campaign.
    expect(() => marketplaceShort('EBAY_XX')).toThrow(UnknownEbayMarketplaceError)
    expect(() => marketplaceShort('EBAY_XX')).toThrow(/Refusing rather than defaulting/)
  })

  it('THROWS on absent rather than defaulting to IT', () => {
    // Three sites used `?? 'IT'`, silently writing GB intent to Italy.
    expect(() => marketplaceShort(undefined)).toThrow(UnknownEbayMarketplaceError)
    expect(() => marketplaceShort(null)).toThrow()
    expect(() => marketplaceShort('')).toThrow()
  })

  it('the error names the marketplace and the known set, so a 400 is readable', () => {
    try { marketplaceShort('EBAY_JP'); expect.unreachable() }
    catch (e) {
      expect((e as Error).message).toContain('EBAY_JP')
      expect((e as Error).message).toContain('EBAY_GB')
    }
  })
})

describe('non-throwing helpers', () => {
  it('marketplaceShortOrNull is null-safe for read paths', () => {
    expect(marketplaceShortOrNull('EBAY_GB')).toBe('UK')
    expect(marketplaceShortOrNull('EBAY_XX')).toBeNull()
    expect(marketplaceShortOrNull(null)).toBeNull()
  })
  it('isKnownEbayMarketplace guards the API boundary', () => {
    expect(isKnownEbayMarketplace('EBAY_GB')).toBe(true)
    expect(isKnownEbayMarketplace('EBAY_XX')).toBe(false)
    expect(isKnownEbayMarketplace(undefined)).toBe(false)
  })
})

describe('D3 ratchet — no inline marketplace maps', () => {
  it('nothing outside this module declares its own EBAY_IT mapping', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const offenders: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        if (e === 'node_modules' || e === 'dist') continue
        const p = join(d, e)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('ebay-marketplace.ts')) continue
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/EBAY_IT:\s*'IT'/.test(line)) offenders.push(`${p.replace(root, 'src')}:${i + 1}`)
        })
      }
    }
    walk(root)
    expect(offenders, `import EBAY_MARKETPLACE_SHORT instead:\n${offenders.join('\n')}`).toEqual([])
  })
})
