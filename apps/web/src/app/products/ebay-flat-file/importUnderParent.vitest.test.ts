import { describe, it, expect } from 'vitest'
import { stampUnderParent } from './importUnderParent'

describe('stampUnderParent', () => {
  it('stamps platformProductId and _isParent=false onto the row', () => {
    const row = { sku: 'XAVIA-S-RED', price: '49.99', _isNew: true, _dirty: true }
    const result = stampUnderParent(row, 'parent-abc-123')
    expect(result).toMatchObject({
      sku: 'XAVIA-S-RED',
      price: '49.99',
      _isNew: true,
      _dirty: true,
      platformProductId: 'parent-abc-123',
      _isParent: false,
    })
  })

  it('overwrites any existing platformProductId and _isParent values', () => {
    const row = { sku: 'XAVIA-M-BLU', platformProductId: 'old-id', _isParent: true }
    const result = stampUnderParent(row, 'new-parent-id')
    expect(result.platformProductId).toBe('new-parent-id')
    expect(result._isParent).toBe(false)
  })

  it('preserves all other fields on the row unchanged', () => {
    const row = {
      sku: 'TEST-001',
      title: 'Test item',
      aspect_Size: 'M',
      aspect_Color: 'Black',
      _rowId: 'row-99',
    }
    const result = stampUnderParent(row, 'parent-xyz')
    expect(result.title).toBe('Test item')
    expect(result.aspect_Size).toBe('M')
    expect(result.aspect_Color).toBe('Black')
    expect(result._rowId).toBe('row-99')
  })

  it('does not mutate the original row', () => {
    const row = { sku: 'ORIG-001' }
    const before = { ...row }
    stampUnderParent(row, 'some-parent')
    expect(row).toEqual(before)
  })
})
