import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { hasOwnWords, importerStem, KNOWN_IMPORTERS } from '../model'

/**
 * B-W2b-382 (follow-up XF7:07; B-W2b-311, -323, -325 notes): Admin's words say what is true now — every office importer the
 * API lists has its own words in Italian and English (none falls back to the API's English label), the first load no longer
 * says open orders have no import, the "later" line names no import that exists, and the price lists permissions name the
 * breaks, size surcharges and minimum order quantities they cover.
 */

/** Every importer key factory-domain defines (its `…IMPORT…_KEY` constants, and `key:` inside a defineImporter file). */
function domainImporterKeys(): string[] {
  const root = fileURLToPath(new URL('../../../../../../../packages/factory-domain/src', import.meta.url))
  const keys = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts') && !entry.name.includes('vitest')) {
        const source = readFileSync(path, 'utf8')
        for (const match of source.matchAll(/^export const [A-Z_]*IMPORT[A-Z_]*_KEY = '([a-z]+\.[A-Za-z]+)'/gm)) keys.add(match[1]!)
        if (source.includes('defineImporter(')) for (const match of source.matchAll(/^\s+key: '([a-z]+\.[A-Za-z]+)'/gm)) keys.add(match[1]!)
      }
    }
  }
  walk(root)
  keys.delete('product.items')
  // The portal's order sheet is read by the portal's dry run only (B-W2b-190): never a job of Admin › Import.
  keys.delete('sales.portalOrderLines')
  return [...keys].sort()
}

describe('Admin › Import says every importer in both languages', () => {
  const keys = domainImporterKeys()
  it('finds the importers (the scan works)', () => {
    expect(keys).toEqual(expect.arrayContaining(['purchasing.supplierPrices', 'sales.orders', 'sales.priceLists', 'product.commerceStyles', 'compliance.substances']))
  })
  it.each(keys)('%s has its own name and words', (key) => {
    expect(hasOwnWords(key)).toBe(true)
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['admin-import']!
      expect(words[`${importerStem(key)}.name`]).toBeTruthy()
      expect(words[`${importerStem(key)}.fills`]).toBeTruthy()
    }
  })
  it('lists no importer twice', () => expect(new Set(KNOWN_IMPORTERS).size).toBe(KNOWN_IMPORTERS.length))
})

describe('no stale admin words are left', () => {
  const en = CATALOGUE.en['admin-import']!
  const it_ = CATALOGUE.it['admin-import']!
  it('the first load points open orders to the sales orders import', () => {
    for (const key of ['imp.first.step.openOrders.what', 'imp.first.held.noImporter', 'imp.first.held.noImporterDone']) {
      expect(en[key]).not.toMatch(/have no import yet/)
      expect(it_[key]).not.toMatch(/non hanno ancora un'importazione/)
    }
    expect(en['imp.first.held.noImporter']).toContain('Sales orders')
    expect(it_['imp.first.held.noImporter']).toContain('Ordini di vendita')
    expect(en['imp.first.state.held']).not.toBe('No import yet')
  })
  it('the "later" line names no import that exists today', () => {
    expect(en['imp.what.later']).not.toMatch(/get their imports with their own areas/)
    expect(it_['imp.what.later']).not.toMatch(/avranno le loro importazioni/)
  })
  it('the price lists permissions name breaks, size surcharges and minimums', () => {
    for (const key of ['perm.pricelists_view', 'perm.pricelists_manage']) {
      expect(CATALOGUE.en.admin![key]).toMatch(/quantity breaks.*size surcharges.*minimum order quantities/)
      expect(CATALOGUE.it.admin![key]).toMatch(/scaglioni di quantità.*maggiorazioni per taglia.*minimi d’ordine/)
    }
  })
})
