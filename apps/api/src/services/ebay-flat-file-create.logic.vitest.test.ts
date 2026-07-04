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

  it('case 5b: _isParent hint contradicting inference → inference wins + one warning', () => {
    // Row claims _isParent:true but platformProductId points to another product → inferred child.
    const row = {
      sku: 'CONTRA-1',
      _rowId: 'x1',
      _isParent: true,
      platformProductId: 'P_parent', // points elsewhere → inferred child
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map(),
      existingParentById: new Map([
        ['P_parent', { id: 'P_parent', variationTheme: 'Colore', isParent: true }],
      ]),
    })

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].sku).toBe('CONTRA-1')
    expect(result.childCreates).toHaveLength(1)
    expect(result.childCreates[0].parentRef).toEqual({ kind: 'existing', productId: 'P_parent' })
    expect(result.parentCreates).toHaveLength(0)
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

  // ── P1.2 regression: existing parent row present in payload with its REAL id ────────────────
  it('regression: existing parent row in payload (real id) alongside new child → child resolves to kind:existing, NOT unresolved', () => {
    // buildFlatRow sets _rowId = _productId = product.id for real products.
    // If that real id is also a platformProductId for a new child, the old
    // tempRowIdsInPayload filter would exclude it from candidateParentIds,
    // causing "unresolved parent". This test locks the fix.
    const parentRow = {
      sku: 'P_PARENT',
      _rowId: 'P_real',
      _productId: 'P_real',
      platformProductId: 'P_real', // points to self → inferred parent
      variation_theme: 'Colore',
    }
    const newChild = {
      sku: 'NEW_CHILD',
      _rowId: 'c-temp-1',
      platformProductId: 'P_real', // points to the existing parent's real id
    }

    const result = planEbayFamilyCreates({
      rows: [parentRow, newChild],
      existingBySku: new Map([
        // The parent ALREADY EXISTS in the DB
        ['P_PARENT', { id: 'P_real', parentId: null, variationTheme: 'Colore', isParent: true }],
      ]),
      existingParentById: new Map([
        ['P_real', { id: 'P_real', variationTheme: 'Colore', isParent: true }],
      ]),
    })

    expect(result.errors).toHaveLength(0)
    // Child must be created under the existing parent (not error as unresolved)
    expect(result.childCreates).toHaveLength(1)
    expect(result.childCreates[0].parentRef).toEqual({ kind: 'existing', productId: 'P_real' })
    expect(result.childCreates[0].sku).toBe('NEW_CHILD')
    // Parent already exists — must NOT be in parentCreates
    expect(result.parentCreates).toHaveLength(0)
  })

  // ── Shared-family reparent suppression ────────────────────────────────
  it('shared-skip: child reparent suppressed when platformProductId is a sharedFamilyKey', () => {
    const row = {
      sku: 'C1',
      _productId: 'idC1',
      platformProductId: 'B', // new parent candidate — in sharedFamilyKeys
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'A', variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
      sharedFamilyKeys: new Set(['B']),
    })

    expect(result.reparents).toHaveLength(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].sku).toBe('C1')
    expect(result.warnings[0].reason).toMatch(/reparent suppressed.*shared family/)
    expect(result.errors).toHaveLength(0)
  })

  it('shared-skip CONTROL: same input WITHOUT sharedFamilyKeys still reparents (regression guard)', () => {
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
      // sharedFamilyKeys intentionally omitted
    })

    expect(result.reparents).toHaveLength(1)
    expect(result.reparents[0]).toEqual({ productId: 'idC1', sku: 'C1', newParentId: 'B' })
    expect(result.warnings).toHaveLength(0)
  })

  // ── I3: shared-aware create dedup ─────────────────────────────────────
  it('I3: same NEW child SKU under two SHARED parents → exactly ONE create, NO duplicate-SKU error', () => {
    const parentA = { sku: 'PARENT-A', _rowId: 'pa', _isParent: true, platformProductId: 'pa', variation_theme: 'Colore' }
    const parentB = { sku: 'PARENT-B', _rowId: 'pb', _isParent: true, platformProductId: 'pb', variation_theme: 'Colore' }
    const childUnderA = { sku: 'SHARED-CHILD', _rowId: 'ca', platformProductId: 'pa', aspect_Colore: 'Nero' }
    const childUnderB = { sku: 'SHARED-CHILD', _rowId: 'cb', platformProductId: 'pb', aspect_Colore: 'Nero' }

    const result = planEbayFamilyCreates({
      rows: [parentA, parentB, childUnderA, childUnderB],
      existingBySku: new Map(),
      existingParentById: new Map(),
      // Both family keys are shared (server derives these from shared_sku_listing parents)
      sharedFamilyKeys: new Set(['pa', 'pb']),
    })

    // No duplicate-SKU error for the shared child
    expect(result.errors.filter(e => e.reason === 'duplicate SKU in payload')).toHaveLength(0)
    // Collapsed to exactly ONE create for SHARED-CHILD (membership fan-out serves parent-B)
    const childCreatesForSku = result.childCreates.filter(c => c.sku === 'SHARED-CHILD')
    expect(childCreatesForSku).toHaveLength(1)
    // The single create keeps the FIRST occurrence → under parent-A
    expect(childCreatesForSku[0].parentRef).toEqual({ kind: 'temp', tempRowId: 'pa' })
    // Both parents still created
    expect(result.parentCreates).toHaveLength(2)
  })

  // ── Detach-to-standalone (null-reparent) ────────────────────────────
  it('detach: existing child with parentId set, ppid cleared → reparents entry with newParentId:null', () => {
    const row = {
      sku: 'C1',
      _productId: 'idC1',
      platformProductId: '', // cleared
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'A', variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.reparents).toHaveLength(1)
    expect(result.reparents[0]).toEqual({ productId: 'idC1', sku: 'C1', newParentId: null })
  })

  it('detach suppressed: existing child, ppid cleared, but current parentId is a sharedFamilyKey → warning, no reparent', () => {
    const row = {
      sku: 'C1',
      _productId: 'idC1',
      platformProductId: '', // cleared
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'A', variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
      sharedFamilyKeys: new Set(['A']), // current parent is shared
    })

    expect(result.reparents).toHaveLength(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].sku).toBe('C1')
    expect(result.warnings[0].reason).toMatch(/detach suppressed.*shared family/)
    expect(result.errors).toHaveLength(0)
  })

  it('detach no-op: existing STANDALONE (parentId null), ppid cleared → no reparent', () => {
    const row = {
      sku: 'SA1',
      _productId: 'idSA1',
      platformProductId: '', // cleared
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['SA1', { id: 'idSA1', parentId: null, variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
    })

    expect(result.reparents).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  it('detach no-op: existing PARENT row (parentId null, isParent true), ppid cleared → no reparent', () => {
    const row = {
      sku: 'PAR1',
      _productId: 'idPAR1',
      platformProductId: '', // cleared
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['PAR1', { id: 'idPAR1', parentId: null, variationTheme: 'Colore', isParent: true }],
      ]),
      existingParentById: new Map(),
    })

    expect(result.reparents).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  it('I3 CONTROL: same NEW child SKU under two NON-shared parents → still ONE duplicate-SKU error, both dropped', () => {
    const parentA = { sku: 'PARENT-A', _rowId: 'pa', _isParent: true, platformProductId: 'pa', variation_theme: 'Colore' }
    const parentB = { sku: 'PARENT-B', _rowId: 'pb', _isParent: true, platformProductId: 'pb', variation_theme: 'Colore' }
    const childUnderA = { sku: 'DUP-CHILD', _rowId: 'ca', platformProductId: 'pa', aspect_Colore: 'Nero' }
    const childUnderB = { sku: 'DUP-CHILD', _rowId: 'cb', platformProductId: 'pb', aspect_Colore: 'Nero' }

    const result = planEbayFamilyCreates({
      rows: [parentA, parentB, childUnderA, childUnderB],
      existingBySku: new Map(),
      existingParentById: new Map(),
      // sharedFamilyKeys omitted → neither family is shared → real duplicate
    })

    const dupErrors = result.errors.filter(e => e.reason === 'duplicate SKU in payload')
    expect(dupErrors).toHaveLength(1)
    expect(dupErrors[0].sku).toBe('DUP-CHILD')
    // Both occurrences dropped — no child create for the duped SKU
    expect(result.childCreates.filter(c => c.sku === 'DUP-CHILD')).toHaveLength(0)
  })

  // ── P2.A: explicit parentage + parent_sku columns ──────────────────────

  it('P2.A — new family: parentage:parent row + parentage:child+parent_sku rows → temp-id resolution', () => {
    // Parent row uses explicit parentage='parent' (no platformProductId needed)
    const parentRow = {
      sku: 'EXP-PARENT',
      _rowId: 'ep-temp',
      parentage: 'parent',
      variation_theme: 'Colore,Taglia',
    }
    // Children use explicit parentage='child' + parent_sku pointing to parent's SKU
    const child1 = {
      sku: 'EXP-CHILD-1',
      _rowId: 'ec1-temp',
      parentage: 'child',
      parent_sku: 'EXP-PARENT',
      aspect_Colore: 'Nero',
      aspect_Taglia: 'M',
    }
    const child2 = {
      sku: 'EXP-CHILD-2',
      _rowId: 'ec2-temp',
      parentage: 'child',
      parent_sku: 'EXP-PARENT',
      aspect_Colore: 'Rosso',
      aspect_Taglia: 'L',
    }

    const result = planEbayFamilyCreates({
      rows: [parentRow, child1, child2],
      existingBySku: new Map(),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    // Parent created with correct tempRowId and variationTheme
    expect(result.parentCreates).toHaveLength(1)
    expect(result.parentCreates[0].sku).toBe('EXP-PARENT')
    expect(result.parentCreates[0].tempRowId).toBe('ep-temp')
    expect(result.parentCreates[0].variationTheme).toBe('Colore,Taglia')
    // Both children created with kind:temp pointing to parent's tempRowId
    expect(result.childCreates).toHaveLength(2)
    expect(result.childCreates[0].parentRef).toEqual({ kind: 'temp', tempRowId: 'ep-temp' })
    expect(result.childCreates[0].variationTheme).toBe('Colore,Taglia')
    expect(result.childCreates[1].parentRef).toEqual({ kind: 'temp', tempRowId: 'ep-temp' })
  })

  it('P2.A — child via parent_sku resolved to EXISTING parent (existingBySku)', () => {
    // Child row references an existing parent by SKU (no platformProductId needed)
    const childRow = {
      sku: 'NEW-CHILD-SKU',
      _rowId: 'nc-temp',
      parentage: 'child',
      parent_sku: 'EXIST-PARENT-SKU',
    }

    const result = planEbayFamilyCreates({
      rows: [childRow],
      existingBySku: new Map([
        ['EXIST-PARENT-SKU', { id: 'exist-parent-id', parentId: null, variationTheme: 'Colore', isParent: true }],
      ]),
      existingParentById: new Map([
        ['exist-parent-id', { id: 'exist-parent-id', variationTheme: 'Colore', isParent: true }],
      ]),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(0)
    expect(result.childCreates).toHaveLength(1)
    expect(result.childCreates[0].sku).toBe('NEW-CHILD-SKU')
    // Resolved to kind:existing using the parent's real DB id
    expect(result.childCreates[0].parentRef).toEqual({ kind: 'existing', productId: 'exist-parent-id' })
    expect(result.childCreates[0].variationTheme).toBe('Colore')
  })

  it('P2.A — reparent: existing child, parent_sku points to different existing parent → 1 reparent', () => {
    const row = {
      sku: 'C1',
      _productId: 'idC1',
      parentage: 'child',
      parent_sku: 'NEW-PARENT-SKU',
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'old-parent-id', variationTheme: null, isParent: false }],
        ['NEW-PARENT-SKU', { id: 'new-parent-id', parentId: null, variationTheme: 'Colore', isParent: true }],
      ]),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(0)
    expect(result.childCreates).toHaveLength(0)
    expect(result.reparents).toHaveLength(1)
    expect(result.reparents[0]).toEqual({ productId: 'idC1', sku: 'C1', newParentId: 'new-parent-id' })
  })

  it('P2.A — detach: existing child with parentage:parent → reparent to null', () => {
    const row = {
      sku: 'C1',
      _productId: 'idC1',
      parentage: 'parent',  // was a child, now explicitly declared as parent
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'A', variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.reparents).toHaveLength(1)
    expect(result.reparents[0]).toEqual({ productId: 'idC1', sku: 'C1', newParentId: null })
    expect(result.parentCreates).toHaveLength(0)
    expect(result.childCreates).toHaveLength(0)
  })

  it('P2.A — detach: existing child with parentage:\'\' (blank) → reparent to null', () => {
    const row = {
      sku: 'C1',
      _productId: 'idC1',
      parentage: '',  // explicitly blank = no longer a child
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'A', variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.reparents).toHaveLength(1)
    expect(result.reparents[0]).toEqual({ productId: 'idC1', sku: 'C1', newParentId: null })
  })

  it('P2.A — back-compat: row with NO parentage/parent_sku (only platformProductId) → same plan as ppid path', () => {
    // Identical to case 3 — existing child reparented via ppid — no explicit columns.
    // Proves that omitting parentage/parent_sku leaves behavior exactly unchanged.
    const row = {
      sku: 'C1',
      _productId: 'idC1',
      platformProductId: 'B',
      // parentage and parent_sku intentionally absent
    }

    const result = planEbayFamilyCreates({
      rows: [row],
      existingBySku: new Map([
        ['C1', { id: 'idC1', parentId: 'A', variationTheme: null, isParent: false }],
      ]),
      existingParentById: new Map(),
    })

    // Must produce the identical result as the ppid-based case 3 test
    expect(result.errors).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(0)
    expect(result.childCreates).toHaveLength(0)
    expect(result.reparents).toHaveLength(1)
    expect(result.reparents[0]).toEqual({ productId: 'idC1', sku: 'C1', newParentId: 'B' })
  })

  it('P2.A — orphan: parent_sku matching no batch/existing parent → unresolved parent error', () => {
    const childRow = {
      sku: 'ORPHAN-CHILD',
      _rowId: 'oc-temp',
      parentage: 'child',
      parent_sku: 'NONEXISTENT-PARENT',
    }

    const result = planEbayFamilyCreates({
      rows: [childRow],
      existingBySku: new Map(),
      existingParentById: new Map(),
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].sku).toBe('ORPHAN-CHILD')
    expect(result.errors[0].reason).toMatch(/unresolved parent/)
    expect(result.childCreates).toHaveLength(0)
    expect(result.parentCreates).toHaveLength(0)
  })
})
