// apps/web/src/app/products/next/inventoryEditor.logic.vitest.test.ts
import { describe, it, expect } from 'vitest'
import {
  isLocationEditable, buildListModel, buildMatrixModel, editorModeForRow,
  REASON_OPTIONS, DEFAULT_REASON,
} from './inventoryEditor.logic'

describe('isLocationEditable', () => {
  it('warehouse and channel-reserved are editable', () => {
    expect(isLocationEditable('WAREHOUSE')).toBe(true)
    expect(isLocationEditable('CHANNEL_RESERVED')).toBe(true)
  })
  it('FBA and Shopify are not editable', () => {
    expect(isLocationEditable('AMAZON_FBA')).toBe(false)
    expect(isLocationEditable('SHOPIFY_LOCATION')).toBe(false)
  })
})

describe('reason options', () => {
  it('exposes exactly the three canonical reasons with a sane default', () => {
    expect(REASON_OPTIONS.map((r) => r.value)).toEqual(['MANUAL_ADJUSTMENT', 'INVENTORY_COUNT', 'WRITE_OFF'])
    expect(DEFAULT_REASON).toBe('MANUAL_ADJUSTMENT')
  })
})

describe('buildListModel', () => {
  const locations = [
    { id: 'L1', code: 'IT-MAIN', name: 'Italy Main', type: 'WAREHOUSE' },
    { id: 'L2', code: 'AMZ-FBA', name: 'Amazon FBA', type: 'AMAZON_FBA' },
    { id: 'L3', code: 'SHOP', name: 'Shopify', type: 'SHOPIFY_LOCATION' },
  ]
  it('merges existing levels and fills missing locations with editable 0-rows', () => {
    const levels = [{ location: locations[0], quantity: 8, reserved: 2, available: 6 }]
    const model = buildListModel(levels, locations)
    expect(model).toHaveLength(3)
    expect(model[0]).toMatchObject({ locationId: 'L1', quantity: 8, reserved: 2, available: 6, editable: true })
    expect(model[1]).toMatchObject({ locationId: 'L2', quantity: 0, editable: false }) // FBA, no level
    expect(model[2]).toMatchObject({ locationId: 'L3', quantity: 0, editable: false }) // Shopify
  })
})

describe('buildMatrixModel', () => {
  const locations = [
    { id: 'L1', code: 'IT-MAIN', name: 'Italy Main', type: 'WAREHOUSE' },
    { id: 'L2', code: 'AMZ-FBA', name: 'Amazon FBA', type: 'AMAZON_FBA' },
  ]
  const children = [
    { id: 'C1', sku: 'JKT-RED-M', name: 'Red / M', thumbnailUrl: null, stockLevels: [
      { locationId: 'L1', locationCode: 'IT-MAIN', locationType: 'WAREHOUSE', quantity: 6, reserved: 1, available: 5 },
      { locationId: 'L2', locationCode: 'AMZ-FBA', locationType: 'AMAZON_FBA', quantity: 8, reserved: 0, available: 8 },
    ] },
    { id: 'C2', sku: 'JKT-RED-L', name: 'Red / L', thumbnailUrl: null, stockLevels: [] },
  ]
  it('builds columns from locations and cells keyed by locationId', () => {
    const m = buildMatrixModel(locations, children)
    expect(m.columns.map((c) => c.locationId)).toEqual(['L1', 'L2'])
    expect(m.columns[1]).toMatchObject({ locationType: 'AMAZON_FBA', editable: false })
    expect(m.rows[0].cells['L1']).toEqual({ quantity: 6, reserved: 1, available: 5 })
    expect(m.rows[1].cells['L1']).toBeUndefined() // C2 has no level at L1 yet
  })
})

describe('editorModeForRow', () => {
  it('parents → matrix, leaves → list', () => {
    expect(editorModeForRow({ isParent: true })).toBe('matrix')
    expect(editorModeForRow({ isParent: false })).toBe('list')
  })
})
