import { describe, expect, it } from 'vitest'
import { chooseCategoryLink, downloadableCategory, missingRuleSentence, rulesStatus } from './rulesStatus'

/** 2026-09-27 — Amazon · BE showed "Incomplete: OUTERWEAR" with 5 fixed columns: the rules were never downloaded. */
describe('rulesStatus', () => {
  it('says plainly that Amazon rules are not downloaded, and offers the download', () => {
    const s = rulesStatus('AMAZON', 'BE', ['OUTERWEAR'])
    expect(s).toMatchObject({ tone: 'warning', label: 'Rules not downloaded', downloadable: ['OUTERWEAR'] })
    expect(s.detail).toBe("Amazon's rules for OUTERWEAR on Amazon · BE are not downloaded yet, so only the fixed columns show. Open Requirements and choose Download rules.")
  })

  it('a missing choice is not downloadable: it asks for the choice instead', () => {
    const s = rulesStatus('EBAY', 'DE', ['EBAY:*'])
    expect(s).toMatchObject({ label: 'Requirements incomplete', downloadable: [] })
    expect(s.detail).toBe('No eBay category is chosen for eBay · DE. Choose one in Categories. Readiness cannot be confirmed until these requirements are available.')
    expect(rulesStatus('AMAZON', 'IT', ['AMAZON:category not selected']).downloadable).toEqual([])
    expect(rulesStatus('SHOPIFY', 'GLOBAL', ['SHOPIFY:*']).detail).toContain('still loading')
  })

  it('eBay and Etsy category ids are downloadable without their channel prefix', () => {
    expect(downloadableCategory('EBAY:177104')).toBe('177104')
    expect(downloadableCategory('ETSY:1429')).toBe('1429')
    expect(downloadableCategory('ETSY:*')).toBeNull()
    expect(missingRuleSentence('ETSY', 'GLOBAL', 'ETSY:1429')).toBe("Etsy's rules for category 1429 are not downloaded yet.")
  })

  it('an eBay site with no category points to that site in the Categories workspace', () => {
    expect(missingRuleSentence('EBAY', 'DE', 'EBAY:*')).toBe('No eBay category is chosen for eBay · DE. Choose one in Categories.')
    expect(chooseCategoryLink('EBAY', 'DE', ['EBAY:*'])).toEqual({ href: '/catalog/categories?view=assignments&channel=EBAY&market=DE', label: 'Choose one in Categories' })
    // Every other state keeps its own words and has no pointer.
    expect(chooseCategoryLink('EBAY', 'DE', ['EBAY:177117'])).toBeNull()
    expect(chooseCategoryLink('ETSY', 'GLOBAL', ['ETSY:*'])).toBeNull()
    expect(missingRuleSentence('EBAY', 'DE', 'EBAY:177117')).toBe("eBay's rules for category 177117 are not downloaded yet.")
    expect(missingRuleSentence('ETSY', 'GLOBAL', 'ETSY:*')).toBe('No Etsy category is selected. Choose one to load its fields.')
  })

  it('nothing missing is neutral, and names no download', () => {
    expect(rulesStatus('AMAZON', 'IT', [])).toMatchObject({ tone: 'neutral', label: 'Requirements', downloadable: [] })
  })
})
