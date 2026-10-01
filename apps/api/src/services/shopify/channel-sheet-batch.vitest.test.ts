import { describe, expect, it } from 'vitest'
import { shopifySheetChangesSchema } from './channel-sheet.service.js'

const cell = (owner: number, extra: Record<string, unknown> = {}) => ({ ownerId: `gid://shopify/Product/${owner}`, fieldId: 'vendor',
  colId: 'brand', token: `owner-${owner}`, baseline: 'Before', value: 'After', intent: 'set', ...extra })

describe('Shopify batch cell identities', () => {
  it('addresses the same physical column on different owners with separate receipts', () => {
    const input = { cells: [cell(10, { receiptKey: 'a' }), cell(20, { receiptKey: 'b' })] }
    expect(shopifySheetChangesSchema.parse(input)).toEqual(input)
  })
  it('retains the existing single-row wire format', () => {
    const input = { cells: [cell(10)] }
    expect(shopifySheetChangesSchema.parse(input)).toEqual(input)
  })
  it('accepts a separate stable column-action ID and bounds client correlation text', () => {
    const input = { operationId: 'column-action-a', cells: [cell(10, { receiptKey: 'row-a' })] }
    expect(shopifySheetChangesSchema.parse(input)).toEqual(input)
    for (const receiptKey of ['', 'r'.repeat(201)]) expect(shopifySheetChangesSchema.safeParse({ cells: [cell(10, { receiptKey })] }).success).toBe(false)
    for (const operationId of ['', 'a'.repeat(129)]) expect(shopifySheetChangesSchema.safeParse({ cells: [cell(10)], operationId }).success).toBe(false)
  })
  it('refuses duplicate receipt keys and collisions with legacy column keys', () => {
    for (const second of [cell(20, { colId: 'productType', receiptKey: 'a' }), cell(20, { colId: 'a' })]) {
      expect(shopifySheetChangesSchema.safeParse({ cells: [cell(10, { receiptKey: 'a' }), second] }).success).toBe(false)
    }
  })
  it('still refuses competing changes for the same logical owner and field', () => {
    expect(shopifySheetChangesSchema.safeParse({ cells: [cell(10, { receiptKey: 'a' }), cell(10, { receiptKey: 'b', value: 'Competing' })] }).success).toBe(false)
  })
  it('keeps the existing 1000-cell request bound', () => {
    expect(shopifySheetChangesSchema.safeParse({ cells: Array.from({ length: 1001 }, (_, index) => cell(index + 10, { colId: `c${index}`, receiptKey: `r${index}` })) }).success).toBe(false)
  })
})
