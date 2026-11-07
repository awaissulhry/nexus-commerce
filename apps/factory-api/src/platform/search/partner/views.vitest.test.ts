import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GROUPS_OF_KIND } from '@nexus/factory-domain/search/partner/contracts'
import { THREAD_RECORDS } from '../../threads/records'
import { indexerFiles } from '../indexer-files'
import { definePartnerView, PartnerViewConfigError } from './view'
import { partnerViewOf, PARTNER_VIEWS, viewFits } from './views'

/**
 * The partner views (B-W2b-168) against the rest of the platform, without a database: each names a record the partner
 * role reads (factory-db ownership: a select grant for factory_partner_runtime), a record that has a thread, and — when
 * it is searched — a record the office index holds and a group its partner kinds' portals show.
 */

const OWNERSHIP = fileURLToPath(new URL('../../../../../../packages/factory-db/ownership/', import.meta.url))
const SRC = fileURLToPath(new URL('../../..', import.meta.url))

function partnerReadable(): Set<string> {
  const models = new Set<string>()
  for (const file of readdirSync(OWNERSHIP).filter((name) => name.endsWith('.json'))) {
    const json = JSON.parse(readFileSync(`${OWNERSHIP}${file}`, 'utf8')) as { models?: Record<string, { access?: Record<string, { privileges?: string[] }> }> }
    for (const [model, spec] of Object.entries(json.models ?? {})) if (spec.access?.factory_partner_runtime?.privileges?.includes('select')) models.add(model)
  }
  return models
}

const indexedTypes = (): Set<string> => new Set(indexerFiles(SRC).map((file) => readFileSync(file, 'utf8').match(/recordType: '([A-Za-z]+)'/)?.[1] ?? ''))

describe('the partner views', () => {
  it('name only records the partner role reads and that have a thread', () => {
    const readable = partnerReadable()
    for (const view of PARTNER_VIEWS) {
      expect(readable.has(view.recordType), `${view.recordType}: the partner role reads it`).toBe(true)
      expect(Object.hasOwn(THREAD_RECORDS, view.recordType), `${view.recordType}: it has a thread`).toBe(true)
    }
  })

  it('a searched view is in the office index and in a group of each of its kinds’ portals', () => {
    const indexed = indexedTypes()
    for (const view of PARTNER_VIEWS.filter((entry) => entry.group !== null)) {
      expect(indexed.has(view.recordType), `${view.recordType}: an indexer holds it`).toBe(true)
      for (const kind of view.kinds) expect(GROUPS_OF_KIND[kind], `${view.recordType} for ${kind}`).toContain(view.group)
    }
  })

  it('finds a view by type and fits it to the person’s kinds (fail closed)', () => {
    expect(partnerViewOf('PurchaseOrder')?.group).toBe('pos')
    expect(partnerViewOf('WorkOrder')).toBeUndefined()
    expect(viewFits(partnerViewOf('PurchaseOrder')!, ['CUSTOMER'])).toBe(false)
    expect(viewFits(partnerViewOf('Ddt')!, ['SUBCONTRACTOR'])).toBe(true)
    expect(viewFits(partnerViewOf('Party')!, [])).toBe(false)
    // An invoice is found only with the price grain; no supplier or workshop view asks one (Owner answer C2).
    expect(partnerViewOf('Invoice')?.grain).toBe('price')
    for (const view of PARTNER_VIEWS.filter((entry) => entry.kinds.includes('SUPPLIER') || entry.kinds.includes('SUBCONTRACTOR'))) expect(view.grain).toBeUndefined()
  })

  it('refuses a view without a model name or a partner kind', () => {
    const read = async () => []
    expect(() => definePartnerView({ recordType: 'sales order', group: 'orders', kinds: ['CUSTOMER'], read })).toThrow(PartnerViewConfigError)
    expect(() => definePartnerView({ recordType: 'SalesOrder', group: 'orders', kinds: [], read })).toThrow(PartnerViewConfigError)
  })
})
