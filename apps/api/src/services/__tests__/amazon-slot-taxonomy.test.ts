/**
 * M1 verifier — schema-driven Amazon image-slot taxonomy.
 */

import { describe, it, expect } from 'vitest'
import { buildSlotTaxonomy, fallbackTaxonomy } from '../images/amazon-slot-taxonomy.service.js'

describe('buildSlotTaxonomy', () => {
  it('discovers MAIN, uncapped PT (>8), and SWCH from schema properties', () => {
    const props: Record<string, unknown> = {
      main_product_image_locator: {},
      swatch_product_image_locator: {},
      brand: {}, // non-image — ignored
    }
    for (let n = 1; n <= 12; n++) props[`other_product_image_locator_${n}`] = {}
    const tax = buildSlotTaxonomy(props)
    expect(tax.source).toBe('schema')
    const codes = tax.slots.map((s) => s.slot)
    expect(codes[0]).toBe('MAIN')
    expect(codes).toContain('PT09') // uncapped beyond 8
    expect(codes).toContain('PT12')
    expect(codes[codes.length - 1]).toBe('SWCH') // swatch last
    expect(tax.slotToAttribute.PT12).toBe('other_product_image_locator_12')
  })

  it('skips B2B offer image locators', () => {
    const tax = buildSlotTaxonomy({
      main_product_image_locator: {},
      main_offer_image_locator: {},
      other_offer_image_locator_1: {},
    })
    expect(tax.slots.map((s) => s.slot)).toEqual(['MAIN'])
  })

  it('maps product-safety locators to PS slots', () => {
    const tax = buildSlotTaxonomy({
      main_product_image_locator: {},
      product_safety_image_locator_1: {},
      product_safety_image_locator_2: {},
    })
    expect(tax.slots.filter((s) => s.kind === 'SAFETY').map((s) => s.slot)).toEqual(['PS01', 'PS02'])
  })

  it('maps Amazon live image_locator_psNN naming to PS slots, ordered after PT, before SWCH', () => {
    // Confirmed live on IT/DE OUTERWEAR: image_locator_ps01..ps06.
    const tax = buildSlotTaxonomy({
      main_product_image_locator: {},
      other_product_image_locator_1: {},
      swatch_product_image_locator: {},
      image_locator_ps01: {},
      image_locator_ps02: {},
      image_locator_ps06: {},
    })
    expect(tax.slots.map((s) => s.slot)).toEqual(['MAIN', 'PT01', 'PS01', 'PS02', 'PS06', 'SWCH'])
    expect(tax.slotToAttribute.PS06).toBe('image_locator_ps06')
    expect(tax.slots.find((s) => s.slot === 'PS01')?.kind).toBe('SAFETY')
  })

  it('flags read-only locators as not writable', () => {
    const tax = buildSlotTaxonomy({
      main_product_image_locator: {},
      other_product_image_locator_1: { readOnly: true },
    })
    expect(tax.slots.find((s) => s.slot === 'PT01')?.writable).toBe(false)
    expect(tax.slots.find((s) => s.slot === 'MAIN')?.writable).toBe(true)
  })

  it('sorts PT slots numerically (PT02 before PT10)', () => {
    const props: Record<string, unknown> = { main_product_image_locator: {} }
    for (const n of [10, 2, 1]) props[`other_product_image_locator_${n}`] = {}
    expect(buildSlotTaxonomy(props).slots.map((s) => s.slot)).toEqual(['MAIN', 'PT01', 'PT02', 'PT10'])
  })

  it('fallbackTaxonomy returns the legacy 10 slots', () => {
    const fb = fallbackTaxonomy()
    expect(fb.source).toBe('fallback')
    expect(fb.slots).toHaveLength(10)
    expect(fb.slotToAttribute.MAIN).toBe('main_product_image_locator')
    expect(fb.slotToAttribute.PT08).toBe('other_product_image_locator_8')
  })
})
