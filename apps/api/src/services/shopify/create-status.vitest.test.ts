/**
 * Wave 2 D4 (Owner decisions 9, 10) — the ONE rule for a product Shopify does not hold yet: it is created with the
 * Status column's choice of its main row on that store (Active → ACTIVE, Inactive → DRAFT, Not listed → nothing). The
 * sheet's "Shopify status" cell, Publish and the Media tab read it. Pure here: no database, no channel call.
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))
import { shopifyCreateChoiceOf } from './create-status.js'

const products = [{ id: 'family', parentId: null }, { id: 'child', parentId: 'family' }]
const row = (productId: string, extra: Record<string, unknown> = {}) => ({ id: `listing-${productId}`, productId, externalListingId: null, listingStatus: 'DRAFT', isPublished: false, ...extra })
const choice = (listings: ReturnType<typeof row>[], deletions?: Map<string, any>) => shopifyCreateChoiceOf({ familyId: 'family', aliasKey: '', products, listings, deletions })

describe('the status a new Shopify product is created with', () => {
  it('the main row\'s own Status: Active creates it ACTIVE, Inactive as a DRAFT, Not listed creates nothing', () => {
    expect(choice([row('family', { sellingTarget: 'ACTIVE' })])).toEqual({ onShopify: false, target: 'active', status: 'ACTIVE' })
    expect(choice([row('family', { sellingTarget: 'INACTIVE' })])).toEqual({ onShopify: false, target: 'inactive', status: 'DRAFT' })
    expect(choice([row('family', { sellingTarget: 'NOT_LISTED' })])).toEqual({ onShopify: false, target: 'not_listed', status: null })
  })
  it('nobody chose: a Draft — unless the family\'s stored Shopify status is ACTIVE (the Status column\'s default, ND2 A)', () => {
    expect(choice([row('family')])).toMatchObject({ target: 'inactive', status: 'DRAFT' })
    expect(choice([])).toMatchObject({ onShopify: false, target: 'inactive', status: 'DRAFT' })
    expect(choice([row('family', { platformAttributes: { status: 'ACTIVE' } })])).toMatchObject({ target: 'active', status: 'ACTIVE' })
    // An ARCHIVED (or UNLISTED) stored status creates no such product: the Status column offers Active, Inactive, Not listed.
    expect(choice([row('family', { platformAttributes: { status: 'ARCHIVED' } })])).toMatchObject({ target: 'inactive', status: 'DRAFT' })
  })
  it('a variation\'s own choice never decides: Shopify creates the whole product from its main row', () => {
    expect(choice([row('family', { sellingTarget: 'INACTIVE' }), row('child', { sellingTarget: 'ACTIVE' })])).toMatchObject({ status: 'DRAFT' })
  })
  it('a product Nexus deleted from this store: Not listed by default (nothing is created again unasked)', () => {
    const deleted = new Map([['listing-family', { at: '2026-10-04T10:00:00.000Z', where: 'Shopify · GLOBAL', oldReference: '10' }]])
    expect(choice([row('family')], deleted)).toMatchObject({ target: 'not_listed', status: null })
  })
  it('the main product is on Shopify here: nothing to create', () => {
    expect(choice([row('family', { externalListingId: '10', listingStatus: 'ACTIVE', isPublished: true })])).toEqual({ onShopify: true, target: null, status: null })
  })
})
