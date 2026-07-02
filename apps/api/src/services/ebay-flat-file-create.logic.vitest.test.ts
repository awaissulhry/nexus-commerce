/**
 * P1.1 — eBay flat-file create/reparent pure logic tests (TDD)
 *
 * Tests cover the 10 cases from the task brief. All logic is pure —
 * no prisma, no I/O. The module under test is the decision planner
 * that a later task (P1.2) will wire to the PATCH route + DB.
 */
import { describe, it, expect } from 'vitest'
import {
  extractVariantAttributes,
  buildEbayProductCreateInput,
  planEbayFamilyCreates,
} from './ebay-flat-file-create.logic.js'

// ──────────────────────────────────────────────────────────────────────
// extractVariantAttributes
// ──────────────────────────────────────────────────────────────────────
describe('extractVariantAttributes', () => {
  it('case 9: extracts axes via canonical key logic, dedupes aspect_Colore/aspect_colore', () => {
    const row = {
      aspect_Colore: 'Nero',
      aspect_colore: 'Nero', // duplicate lower-cased key — must not produce a second entry
      aspect_Taglia: 'M',
    }
    const result = extractVariantAttributes(row, ['Colore', 'Taglia'])
    expect(result).toEqual({ Colore: 'Nero', Taglia: 'M' })
  })

  it('omits axes that have no value in the row', () => {
    const row = { aspect_Colore: 'Rosso' }
    const result = extractVariantAttributes(row, ['Colore', 'Taglia'])
    expect(result).toEqual({ Colore: 'Rosso' })
  })

  it('reads lowercase variant when uppercase key is absent', () => {
    const row = { aspect_colore: 'Bianco' }
    const result = extractVariantAttributes(row, ['Colore'])
    expect(result).toEqual({ Colore: 'Bianco' })
  })

  it('handles axis names with spaces via underscore replacement', () => {
    // spec.name = "Color Name" → key1 = "aspect_Color_Name", key2 = "aspect_color_name"
    const row = { aspect_Color_Name: 'Blue' }
    const result = extractVariantAttributes(row, ['Color Name'])
    expect(result).toEqual({ 'Color Name': 'Blue' })
  })
})

// ──────────────────────────────────────────────────────────────────────
// buildEbayProductCreateInput
// ──────────────────────────────────────────────────────────────────────
describe('buildEbayProductCreateInput', () => {
  it('case 10: child — isParent false, parentId set, variantAttributes mirrors categoryAttributes.variations, basePrice from it_price, name falls back to sku', () => {
    const row = {
      sku: 'CHILD-1',
      title: '',          // empty → name should fall back to sku
      it_price: '29.99',
      aspect_Colore: 'Nero',
      aspect_Taglia: 'M',
    }
    const result = buildEbayProductCreateInput(row, {
      parentId: 'P_PARENT',
      variationTheme: 'Colore,Taglia',
      isParent: false,
    })
    expect(result.isParent).toBe(false)
    expect(result.parentId).toBe('P_PARENT')
    expect(result.variantAttributes).toEqual({ Colore: 'Nero', Taglia: 'M' })
    expect(result.categoryAttributes).toEqual({ variations: { Colore: 'Nero', Taglia: 'M' } })
    expect(result.basePrice).toBe(29.99)
    expect(result.name).toBe('CHILD-1')
    expect(result.syncChannels).toEqual(['EBAY'])
    expect(result.importSource).toBe('EBAY_FLAT_FILE')
    expect(result.totalStock).toBe(0)
    expect(result.status).toBe('ACTIVE')
  })

  it('case 8 partial: parent — isParent true, variationAxes split from variationTheme, no parentId key', () => {
    const row = {
      sku: 'PARENT-1',
      title: 'Parent Product',
      variation_theme: 'Colore,Taglia',
    }
    const result = buildEbayProductCreateInput(row, {
      parentId: null,
      variationTheme: 'Colore,Taglia',
      isParent: true,
    })
    expect(result.isParent).toBe(true)
    expect(result.parentId).toBeUndefined()
    expect(result.variationTheme).toBe('Colore,Taglia')
    expect(result.variationAxes).toEqual(['Colore', 'Taglia'])
    expect(result.name).toBe('Parent Product')
  })

  it('basePrice falls back through price fields in order', () => {
    // no it_price, has fr_price
    const row = { sku: 'X', fr_price: '15.00' }
    const result = buildEbayProductCreateInput(row, { parentId: null, variationTheme: null, isParent: true })
    expect(result.basePrice).toBe(15)
  })

  it('basePrice falls back to 0 when no price field present', () => {
    const row = { sku: 'X' }
    const result = buildEbayProductCreateInput(row, { parentId: null, variationTheme: null, isParent: true })
    expect(result.basePrice).toBe(0)
  })

  it('child with no variantAttributes (no matching aspect keys) omits both variantAttributes and categoryAttributes', () => {
    const row = { sku: 'C', title: 'Child' }
    const result = buildEbayProductCreateInput(row, {
      parentId: 'P',
      variationTheme: 'Colore,Taglia',
      isParent: false,
    })
    expect(result.variantAttributes).toBeUndefined()
    expect(result.categoryAttributes).toBeUndefined()
  })

  it('seeds localizedContent minimally', () => {
    const row = { sku: 'X' }
    const result = buildEbayProductCreateInput(row, { parentId: null, variationTheme: null, isParent: true })
    expect(result.localizedContent).toBeDefined()
    expect(typeof result.localizedContent).toBe('object')
  })
})

// ──────────────────────────────────────────────────────────────────────
// planEbayFamilyCreates
// ──────────────────────────────────────────────────────────────────────
describe('planEbayFamilyCreates', () => {
  it('case 1: new family — 1 parent + 2 children → 1 parentCreate, 2 childCreates (kind:temp), variationTheme inherited', () => {
    const parentRow = {
      sku: 'PARENT-1',
      _rowId: 't1',
      _isParent: true,
      variation_theme: 'Colore,Taglia',
      platformProductId: 't1', // points to self → inferred parent
    }
    const child1 = {
      sku: 'CHILD-1',
      _rowId: 'c1',
      _isParent: false,
      platformProductId: 't1',
      aspect_Colore: 'Nero',
      aspect_Taglia: 'M',
    }
    const child2 = {
      sku: 'CHILD-2',
      _rowId: 'c2',
      _isParent: false,
      platformProductId: 't1',
      aspect_Colore: 'Rosso',
      aspect_Taglia: 'L',
    }

    const result = planEbayFamilyCreates({
      rows: [parentRow, child1, child2],
      existingBySku: new Map(),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(1)
    expect(result.parentCreates[0].tempRowId).toBe('t1')
    expect(result.parentCreates[0].sku).toBe('PARENT-1')
    expect(result.parentCreates[0].variationTheme).toBe('Colore,Taglia')
    expect(result.childCreates).toHaveLength(2)
    expect(result.childCreates[0].parentRef).toEqual({ kind: 'temp', tempRowId: 't1' })
    expect(result.childCreates[0].variationTheme).toBe('Colore,Taglia')
    expect(result.childCreates[1].parentRef).toEqual({ kind: 'temp', tempRowId: 't1' })
    expect(result.childCreates[1].variationTheme).toBe('Colore,Taglia')
  })

  it('case 2: add variant to existing family → 1 childCreate (kind:existing), no parentCreate', () => {
    const newChild = {
      sku: 'NEW-1',
      _rowId: 'nc1',
      platformProductId: 'P_parent',
    }

    const result = planEbayFamilyCreates({
      rows: [newChild],
      existingBySku: new Map(),
      existingParentById: new Map([
        ['P_parent', { id: 'P_parent', variationTheme: 'Colore,Taglia', isParent: true }],
      ]),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(0)
    expect(result.childCreates).toHaveLength(1)
    expect(result.childCreates[0].parentRef).toEqual({ kind: 'existing', productId: 'P_parent' })
    expect(result.childCreates[0].variationTheme).toBe('Colore,Taglia')
    expect(result.childCreates[0].sku).toBe('NEW-1')
  })

  it('case 3: reparent — existing child with different platformProductId → 1 reparent, no creates', () => {
    const row = {
      sku: 'C1',
      _productId: 'idC1',
      platformProductId: 'B',
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'A', variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(0)
    expect(result.childCreates).toHaveLength(0)
    expect(result.reparents).toHaveLength(1)
    expect(result.reparents[0]).toEqual({ productId: 'idC1', sku: 'C1', newParentId: 'B' })
  })

  it('case 4: no-op — existing child whose platformProductId already matches parentId', () => {
    const row = {
      sku: 'C1',
      _productId: 'idC1',
      platformProductId: 'A', // same as existing.parentId
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'A', variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.reparents).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(0)
    expect(result.childCreates).toHaveLength(0)
  })

  it('case 5: duplicate SKU in payload → exactly one error entry with both dropped', () => {
    const row1 = { sku: 'DUP', _rowId: 'r1', platformProductId: 'r1' }
    const row2 = { sku: 'DUP', _rowId: 'r2', platformProductId: 'r2' }

    const result = planEbayFamilyCreates({
      rows: [row1, row2],
      existingBySku: new Map(),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].sku).toBe('DUP')
    expect(result.errors[0].reason).toBe('duplicate SKU in payload')
    expect(result.parentCreates).toHaveLength(0)
    expect(result.childCreates).toHaveLength(0)
  })

  it('case 6: unresolved parent ref → one error, child dropped from plan', () => {
    const child = {
      sku: 'CHILD-X',
      _rowId: 'cx',
      platformProductId: 'UNKNOWN_PARENT',
    }

    const result = planEbayFamilyCreates({
      rows: [child],
      existingBySku: new Map(),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].sku).toBe('CHILD-X')
    expect(result.errors[0].reason).toMatch(/unresolved parent/)
    expect(result.childCreates).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(0)
  })

  it('case 7: self-parent guard — existing child whose platformProductId === existing.id → error, no reparent', () => {
    // Row has _rowId (not _productId), so selfId = 'temp_c1' != 'idC1'
    // → classified as child; but ppid === existing.id → self-parent guard fires
    const row = {
      sku: 'C1',
      _rowId: 'temp_c1',
      platformProductId: 'idC1', // points to its own existing DB id → self-parent
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'A', variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].sku).toBe('C1')
    expect(result.errors[0].reason).toMatch(/self-parent/)
    expect(result.reparents).toHaveLength(0)
  })

  it('case 8: standalone new row → parentCreate with variationTheme, no childCreates', () => {
    const row = {
      sku: 'STANDALONE-1',
      _rowId: 's1',
      _isParent: true,
      platformProductId: 's1', // points to self → parent
      variation_theme: 'Colore',
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map(),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(1)
    expect(result.parentCreates[0].sku).toBe('STANDALONE-1')
    expect(result.parentCreates[0].tempRowId).toBe('s1')
    expect(result.parentCreates[0].variationTheme).toBe('Colore')
    expect(result.childCreates).toHaveLength(0)
    expect(result.reparents).toHaveLength(0)
  })
})
