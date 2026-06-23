/**
 * ALA Phase 8 — Pre-Flight aggregator pure functions. The orchestration
 * (SP-API, DB) is integration-tested on prod; here we lock the issue-collection
 * (union of all detectors with correct sources/severities) and the diff.
 */
import { describe, it, expect } from 'vitest'
import { collectLocalIssues, buildDiff } from './preflight-report.service.js'

describe('collectLocalIssues — unions every local detector with its source', () => {
  const schemaDef = {
    allOf: [
      {
        if: { required: ['parentage_level'], properties: { parentage_level: { items: { required: ['value'] } } } },
        then: { required: ['variation_theme'] },
      },
    ],
  }
  const issues = collectLocalIssues(
    { item_name: 'àà', parentage_level: 'child' }, // item_name 4 bytes; brand empty; variation_theme empty (triggered)
    {
      byteLimits: { item_name: 3 },
      requiredCols: [{ id: 'brand', label: 'Brand' }],
      schemaDef,
      labelOf: (id) => id,
    },
  )

  it('flags the byte-length overflow as an error', () => {
    expect(issues.find((i) => i.source === 'byte-length' && i.field === 'item_name' && i.severity === 'error')).toBeTruthy()
  })
  it('flags the missing required attribute as an error', () => {
    expect(issues.find((i) => i.source === 'required' && i.field === 'brand' && i.severity === 'error')).toBeTruthy()
  })
  it('flags the conditional requirement as a warning (advisory)', () => {
    expect(issues.find((i) => i.source === 'conditional' && i.field === 'variation_theme' && i.severity === 'warning')).toBeTruthy()
  })
  it('a clean row produces no local issues', () => {
    const clean = collectLocalIssues(
      { item_name: 'OK', brand: 'Xavia', parentage_level: 'standalone', variation_theme: 'SIZE' },
      { byteLimits: { item_name: 100 }, requiredCols: [{ id: 'brand', label: 'Brand' }], schemaDef: {}, labelOf: (id) => id },
    )
    expect(clean).toEqual([])
  })
})

describe('buildDiff — pending vs live Amazon state', () => {
  it('marks changed attributes', () => {
    const diff = buildDiff(
      { title: 'Old', price: 19.9, quantity: 5 },
      { item_name: 'New', purchasable_offer__our_price: '17.90', fulfillment_availability__quantity: 3 },
    )
    const byField = Object.fromEntries(diff.map((d) => [d.field, d]))
    expect(byField.item_name).toMatchObject({ live: 'Old', pending: 'New', changed: true })
    expect(byField.price).toMatchObject({ changed: true })
    expect(byField.quantity).toMatchObject({ live: '5', pending: '3', changed: true })
  })
  it('unchanged attribute → changed:false', () => {
    const diff = buildDiff({ title: 'Same' }, { item_name: 'Same' })
    expect(diff.find((d) => d.field === 'item_name')?.changed).toBe(false)
  })
  it('no live state → empty diff', () => {
    expect(buildDiff(null, { item_name: 'X' })).toEqual([])
  })
})
