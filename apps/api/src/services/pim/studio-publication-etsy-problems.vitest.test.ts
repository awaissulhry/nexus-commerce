import { describe, expect, it } from 'vitest'

/**
 * E1 (Etsy publisher) — the collector, and every problem the pure builder names, word for word: E1–E12, E14–E17, E21
 * and the notes W1, W2, W6, W10. The problems that need the account, the variation projection or the live read (E13,
 * E18–E20, E22, E24, W3–W5, W7–W9) are named by `prepareEtsyPublication` and tested in studio-publication-etsy.vitest.test.ts.
 */
import { EtsyPublicationProblems, etsyFieldLabel, etsyProblems, stripNothingSent } from './studio-publication-etsy-problems.js'
import { buildEtsyListing, ETSY_ZERO_STOCK_NOTE, etsyListingChecks, etsyListingValues, type EtsyBuildAxis, type EtsyBuildInput, type EtsyBuildRow } from './studio-publication-etsy-build.js'

const cells = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, status: 'mapped' }]))
const MAIN = { title: 'Leather knee slider', description: 'A hand-stitched knee slider.', taxonomy_id: '1234', who_made: 'i_did', when_made: '2020_2026', is_supply: 'false',
  shipping_profile_id: '7001', readiness_state_id: '5001' }
const OWNER = { productId: 'p', sku: 'FAKE-SKU-1' }
const COLOR: EtsyBuildAxis = { familyKey: 'color', label: 'Color', channelName: 'Primary color', target: 'property_200', custom: false }
const SIZE: EtsyBuildAxis = { familyKey: 'size', label: 'Size', channelName: 'Size', target: 'Size', custom: true }
const COLOR_FIELD = { fieldKey: 'property_200', label: 'Primary color', validation: { etsyValues: [{ code: '1', label: 'Black', scaleId: null }, { code: '2', label: 'Red', scaleId: null }] } }
const row = (productId: string, sku: string, extra: Partial<EtsyBuildRow> = {}): EtsyBuildRow => ({ productId, sku, cells: {}, price: 25, quantity: 2, axisValues: {}, ...extra })

/** The messages `etsyListingChecks` names for these main-row cells (`create`: a new listing). */
function listingProblems(values: Record<string, unknown>, create = true) {
  const problems = etsyProblems()
  etsyListingChecks(etsyListingValues(cells(values), problems, OWNER), { create, owner: OWNER }, problems)
  return problems
}
const messages = (values: Record<string, unknown>, create = true) => listingProblems(values, create).issues.map(issue => issue.message)
/** The problems of a whole build. */
function built(extra: Partial<EtsyBuildInput>) {
  const problems = etsyProblems()
  buildEtsyListing({ owner: row('p', 'FAKE-SKU-1', { cells: cells(MAIN), price: null, quantity: 0 }), rows: [], axes: [], fields: [COLOR_FIELD], translations: [],
    createState: 'draft', listingId: null, ...extra }, problems)
  return problems
}

describe('the collector', () => {
  it('names a problem once per SKU and message, and a note once', () => {
    const problems = etsyProblems()
    problems.add('Price: set a price above 0.', { sku: 'FAKE-SKU-2', field: 'price' })
    problems.add('Price: set a price above 0.', { sku: 'FAKE-SKU-2', field: 'price' })
    problems.add('Price: set a price above 0.', { sku: 'FAKE-SKU-3', field: 'price' })
    problems.note('Photos are not sent to Etsy yet; they come in a later Nexus update.')
    problems.note('Photos are not sent to Etsy yet; they come in a later Nexus update.')
    problems.note('stock 1200 is sent as 999, the most Etsy takes for one variation.', { sku: 'FAKE-SKU-2' })
    expect(problems.issues).toEqual([
      { sku: 'FAKE-SKU-2', field: 'price', severity: 'error', message: 'Price: set a price above 0.' },
      { sku: 'FAKE-SKU-3', field: 'price', severity: 'error', message: 'Price: set a price above 0.' },
    ])
    expect(problems.notes).toEqual(['Photos are not sent to Etsy yet; they come in a later Nexus update.', 'FAKE-SKU-2: stock 1200 is sent as 999, the most Etsy takes for one variation.'])
  })

  it('attempt: a refusal becomes one problem (SKU and "nothing was sent" dropped) and the review goes on', () => {
    const problems = etsyProblems()
    expect(problems.attempt(() => 7)).toBe(7)
    expect(problems.attempt(() => { throw new Error('FAKE-SKU-1: Etsy does not allow the character «#» in a title; nothing was sent.') }, { sku: 'FAKE-SKU-1', field: 'title' })).toBeUndefined()
    problems.attempt(() => { throw new EtsyPublicationProblems([{ sku: 'FAKE-SKU-2', severity: 'error', message: 'Inner problem.' }]) })
    expect(problems.issues).toEqual([
      { sku: 'FAKE-SKU-1', field: 'title', severity: 'error', message: 'Etsy does not allow the character «#» in a title.' },
      { sku: 'FAKE-SKU-2', severity: 'error', message: 'Inner problem.' },
    ])
  })

  it('throwIfAny: nothing to throw without a problem; else every problem and every note, one line each', () => {
    const problems = etsyProblems()
    problems.note('A note.')
    expect(() => problems.throwIfAny()).not.toThrow()
    problems.add('Title is empty. Fill it in on the main row.', { sku: 'FAKE-SKU-1', field: 'title' })
    problems.add('Nexus does not know this Etsy shop\'s currency. Reconnect the Etsy account, then review again.')
    const error = (() => { try { problems.throwIfAny() } catch (e) { return e } })() as EtsyPublicationProblems
    expect(error).toBeInstanceOf(EtsyPublicationProblems)
    expect(error.issues).toHaveLength(2)
    expect(error.notes).toEqual(['A note.'])
    expect(error.message).toBe('FAKE-SKU-1: Title is empty. Fill it in on the main row.\nNexus does not know this Etsy shop\'s currency. Reconnect the Etsy account, then review again.')
  })

  it('stripNothingSent and the sheet\'s labels', () => {
    expect(stripNothingSent('Etsy allows the character «&» only once in a title, and this one has 2; nothing was sent.')).toBe('Etsy allows the character «&» only once in a title, and this one has 2.')
    expect(stripNothingSent('Etsy publishing is turned off. Nothing was sent to Etsy.')).toBe('Etsy publishing is turned off. Nothing was sent to Etsy.')
    expect(stripNothingSent('Sending to Etsy comes in the next Nexus update. Nothing was sent.')).toBe('Sending to Etsy comes in the next Nexus update.')
    expect([etsyFieldLabel('taxonomy_id'), etsyFieldLabel('readiness_state_id'), etsyFieldLabel('classification'), etsyFieldLabel('inventory'), etsyFieldLabel('sku'), etsyFieldLabel('unknown_key')])
      .toEqual(['Category', 'Processing profile', 'Who made, when made, craft supply', 'Variations, SKUs and processing profile', 'Seller SKU', 'unknown_key'])
  })
})

describe('the listing values (E1–E12, W10)', () => {
  it('a complete listing names nothing', () => {
    expect(listingProblems(MAIN).issues).toEqual([])
  })

  it('E1 / E4 / E5 — a new listing needs a title, a description and a category; a listing that exists keeps Etsy\'s', () => {
    const empty = { ...MAIN, title: '', description: ' ', taxonomy_id: null }
    expect(listingProblems(empty).issues).toEqual([
      { ...OWNER, field: 'title', severity: 'error', message: 'Title is empty. Fill it in on the main row.' },
      { ...OWNER, field: 'description', severity: 'error', message: 'Description is empty. Fill it in on the main row.' },
      { ...OWNER, field: 'taxonomy_id', severity: 'error', message: 'Category is empty. Choose an Etsy category on the main row.' },
    ])
    expect(messages(empty, false)).toEqual([])
  })

  it('E2 / E3 — the title: 140 characters, Etsy\'s characters, and %, :, & and + once each', () => {
    expect(messages({ ...MAIN, title: 'x'.repeat(141) })).toEqual(['Title has 141 characters; Etsy takes at most 140.'])
    expect(messages({ ...MAIN, title: 'Slider & guard & strap' })).toEqual(['Etsy allows the character «&» only once in a title, and this one has 2.'])
    expect(messages({ ...MAIN, title: 'Slider 🙂' }, false)).toEqual(['Etsy does not allow the character «🙂» in a title.'])
  })

  it('E6 — Who made it, When made and Craft supply go together', () => {
    expect(listingProblems({ ...MAIN, is_supply: null }).issues).toEqual([{ ...OWNER, field: 'is_supply', severity: 'error',
      message: 'Etsy takes Who made it, When made and Craft supply together: fill in Craft supply.' }])
    const partial = { ...MAIN, when_made: null, is_supply: null }
    expect(listingProblems(partial, false).issues).toEqual([{ ...OWNER, field: 'when_made', severity: 'error',
      message: 'Etsy takes Who made it, When made and Craft supply together: fill in When made and Craft supply.' }])
    expect(messages({ ...MAIN, who_made: null, when_made: null, is_supply: null }, false)).toEqual([])
    expect(messages({ ...MAIN, who_made: null, when_made: null, is_supply: null })).toEqual(['Etsy takes Who made it, When made and Craft supply together: fill in Who made it, When made and Craft supply.'])
  })

  it('E7 — a value Etsy no longer takes (When made turns over every year)', () => {
    expect(messages({ ...MAIN, when_made: '2020_2025' })).toEqual(['When made "2020_2025" is not one of Etsy\'s values today (Etsy changes them every year). Choose it again on the main row.'])
    expect(messages({ ...MAIN, who_made: 'robot' })).toEqual(['Who made it "robot" is not one of Etsy\'s values. Choose it again on the main row.'])
  })

  it('E8 — physical listings only', () => {
    expect(messages({ ...MAIN, type: 'download' })).toEqual(['Listing type "download": Nexus publishes physical Etsy listings only.'])
    expect(messages({ ...MAIN, type: 'physical' })).toEqual([])
  })

  it('E9 / E10 — tags and materials', () => {
    const tags = Array.from({ length: 14 }, (_, i) => `tag ${i}`)
    expect(messages({ ...MAIN, tags })).toEqual(['Tags: Etsy takes at most 13; this listing has 14.'])
    expect(messages({ ...MAIN, tags: ['a very long tag text x'] })).toEqual(['Tag "a very long tag text x" has 22 characters; Etsy takes at most 20.'])
    expect(messages({ ...MAIN, tags: ['moto!'] })).toEqual(['Etsy does not allow the character «!» in a tag.'])
    expect(messages({ ...MAIN, materials: ['leather/cotton'] }, false)).toEqual(['Etsy does not allow the character «/» in a material.'])
  })

  it('E11 — styles, only for a new listing (Etsy takes them only when a listing is created)', () => {
    expect(messages({ ...MAIN, styles: ['Racing', 'Classic', 'Retro'] })).toEqual(['Styles: Etsy takes at most 2.'])
    expect(messages({ ...MAIN, styles: ['x'.repeat(46)] })).toEqual([`Style "${'x'.repeat(46)}" is longer than 45 characters.`])
    expect(messages({ ...MAIN, styles: ['Rock & Roll'] })).toEqual(['Style "Rock & Roll": use letters, numbers and spaces only.'])
    expect(messages({ ...MAIN, styles: ['Racing', 'Classic', 'Retro'] }, false)).toEqual([])
  })

  it('E12 — weight and size above 0, each with its unit', () => {
    expect(messages({ ...MAIN, item_weight: '0', item_weight_unit: 'g' })).toEqual(['Item weight must be above 0.'])
    expect(messages({ ...MAIN, item_length: '-1', item_width: '10', item_height: '2', item_dimensions_unit: 'cm' })).toEqual(['Item length must be above 0.'])
    expect(listingProblems({ ...MAIN, item_weight: '120' }).issues).toEqual([{ ...OWNER, field: 'item_weight_unit', severity: 'error', message: 'Item weight needs a unit (Weight unit).' }])
    expect(messages({ ...MAIN, item_width: '10' })).toEqual(['Item size needs a unit (Dimension unit).'])
  })

  it('a value the cell cannot hold is named by its column', () => {
    expect(messages({ ...MAIN, taxonomy_id: 'jackets', is_taxable: 'maybe' }, false)).toEqual(['Category is not a number.', 'Taxable must be Yes or No.'])
  })

  it('W10 — automatic renewal on a new listing costs a renewal fee', () => {
    expect(listingProblems({ ...MAIN, should_auto_renew: true }).notes).toEqual(['Automatic renewal is on: Etsy renews the listing every 4 months and charges a renewal fee.'])
    expect(listingProblems({ ...MAIN, should_auto_renew: true }, false).notes).toEqual([])
  })
})

describe('the variations (E14–E17, E21, W1, W2) and translations (W6)', () => {
  const rows = [row('c1', 'FAKE-SKU-2', { axisValues: { color: 'Black', size: 'M' } }), row('c2', 'FAKE-SKU-3', { axisValues: { color: 'Red', size: 'M' } })]

  it('E14 — a missing value, and a value Etsy does not know', () => {
    const problems = built({ axes: [COLOR, SIZE], rows: [row('c1', 'FAKE-SKU-2', { axisValues: { color: 'Black' } }), row('c2', 'FAKE-SKU-3', { axisValues: { color: 'Sky', size: 'M' } })] })
    expect(problems.issues).toEqual([
      { productId: 'c1', sku: 'FAKE-SKU-2', field: 'size', severity: 'error', message: 'Size is empty. Fill it in on this row.' },
      { productId: 'c2', sku: 'FAKE-SKU-3', field: 'color', severity: 'error', message: '"Sky" is not one of Etsy\'s Primary color values. Choose an Etsy value on this row.' },
    ])
  })

  it('E14 — a missing value the variation check already named is not named twice', () => {
    expect(built({ axes: [COLOR, SIZE], rows: [row('c1', 'FAKE-SKU-2', { axisValues: { color: 'Black' } })], structureNamed: true }).issues).toEqual([])
  })

  it('E15 — a property measured in scales needs its scale', () => {
    const size = { fieldKey: 'property_100', label: 'Size (100)', validation: { etsyValues: [{ code: '10', label: 'M', scaleId: null }] } }
    const problems = built({ axes: [{ ...SIZE, target: 'property_100', custom: false }], fields: [size, { fieldKey: 'property_100__scale_id', label: 'Size (100) scale', validation: {} }],
      rows: [row('c1', 'FAKE-SKU-2', { axisValues: { size: 'M' } })] })
    expect(problems.issues.map(issue => issue.message)).toEqual(['Size needs a scale. Choose "Size (100) scale" on the main row.'])
  })

  it('E16 — two variations with the same values', () => {
    const problems = built({ axes: [COLOR], rows: [row('c1', 'FAKE-SKU-2', { axisValues: { color: 'Black' } }), row('c2', 'FAKE-SKU-3', { axisValues: { color: 'black' } })] })
    expect(problems.issues.map(issue => issue.message)).toEqual(['FAKE-SKU-2 and FAKE-SKU-3 have the same variation values; each Etsy variation must differ.'])
  })

  it('E17 — Etsy\'s product caps', () => {
    expect(built({ axes: [], rows }).issues.map(issue => issue.message)).toEqual(['This family has 2 variations but no Etsy variation property. Set one in Variations.'])
    const many = (count: number, axes: EtsyBuildAxis[]) => built({ axes, rows: Array.from({ length: count }, (_, i) => row(`c${i}`, `FAKE-SKU-${100 + i}`, { axisValues: { color: 'Black', size: `S${i}` } })) })
    expect(many(71, [SIZE]).issues.map(issue => issue.message)).toEqual(['Etsy takes at most 70 variations here; this listing has 71.'])
    expect(many(401, [COLOR, SIZE]).issues.map(issue => issue.message)).toEqual(['Etsy takes at most 400 variations here; this listing has 401.'])
    expect(many(400, [COLOR, SIZE]).issues).toEqual([])
  })

  it('E21 — a row not on Etsy needs a price above 0; a row on Etsy keeps its own (D3)', () => {
    const problems = built({ axes: [SIZE], rows: [
      row('c1', 'FAKE-SKU-2', { price: null, priceReason: 'This listing has no price of its own for Etsy. Set its price first.', axisValues: { size: 'S' } }),
      row('c2', 'FAKE-SKU-3', { price: 0, axisValues: { size: 'M' } }),
      row('c3', 'FAKE-SKU-4', { price: null, onEtsy: true, axisValues: { size: 'L' } }),
    ], listingId: '9000000001' })
    expect(problems.issues).toEqual([
      { productId: 'c1', sku: 'FAKE-SKU-2', field: 'price', severity: 'error', message: 'This listing has no price of its own for Etsy. Set its price first.' },
      { productId: 'c2', sku: 'FAKE-SKU-3', field: 'price', severity: 'error', message: 'Price: set a price above 0.' },
    ])
  })

  it('W1 / W2 — stock 0 waits as a draft; above 999 is sent as 999', () => {
    expect(built({ axes: [COLOR], rows: rows.map(r => ({ ...r, quantity: 0 })) }).notes).toContain(ETSY_ZERO_STOCK_NOTE)
    expect(built({ axes: [COLOR], rows: [{ ...rows[0], quantity: 1000 }] }).notes).toContain('FAKE-SKU-2: stock 1000 is sent as 999, the most Etsy takes for one variation.')
  })

  it('M1 — a new listing refuses any variation without a processing profile, on the main row', () => {
    const owner = row('p', 'FAKE-SKU-1', { cells: cells({ ...MAIN, readiness_state_id: null }), price: null, quantity: 0 })
    const problems = built({ owner, axes: [COLOR], rows: [{ ...rows[0], cells: cells({ readiness_state_id: '5002' }) }, rows[1]] })
    expect(problems.issues).toEqual([{ productId: 'p', sku: 'FAKE-SKU-1', field: 'readiness_state_id', severity: 'error',
      message: 'Processing profile is not set. Etsy needs one for every variation: choose it on the main row (or on each row).' }])
    // A listing that exists keeps Etsy's profile for a row empty in Nexus: no problem here (its inventory line says the rest).
    expect(built({ owner, axes: [COLOR], rows: rows.map(r => ({ ...r, onEtsy: true })), listingId: '9000000001' }).issues).toEqual([])
  })

  it('m4 — the values of one property in different scales', () => {
    const size = { fieldKey: 'property_100', label: 'Size (100)', validation: { etsyValues: [{ code: '10', label: 'M', scaleId: '1' }, { code: '20', label: '42', scaleId: '2' }] } }
    const axis = { ...SIZE, target: 'property_100', custom: false }
    const sized = [row('c1', 'FAKE-SKU-2', { axisValues: { size: 'M' } }), row('c2', 'FAKE-SKU-3', { axisValues: { size: '42' } })]
    expect(built({ axes: [axis], fields: [size], rows: sized }).issues).toEqual([{ field: 'variationTheme', severity: 'error',
      message: 'Size: the values of FAKE-SKU-2 and FAKE-SKU-3 are in different scales. Etsy takes one scale per property: choose values in one scale.' }])
    const owner = row('p', 'FAKE-SKU-1', { cells: cells({ ...MAIN, property_100__scale_id: '1' }), price: null, quantity: 0 })
    expect(built({ owner, axes: [axis], fields: [size], rows: sized }).issues.map(issue => issue.message))
      .toEqual(['Size: FAKE-SKU-3 has a value outside the scale chosen on the main row. Etsy takes one scale per property: choose values in that scale.'])
    const attribute = built({ owner: row('p', 'FAKE-SKU-1', { cells: cells({ ...MAIN, property_100: ['M', '42'] }), price: null, quantity: 0 }), fields: [size], axes: [COLOR], rows })
    expect(attribute.issues.map(issue => issue.message)).toEqual(['Size: the values are in more than one scale. Etsy takes one scale per property: choose values in one scale.'])
  })

  it('m5 — ( and ) in a value Nexus writes (Etsy\'s own choices are sent as Etsy names them)', () => {
    const problems = built({ axes: [SIZE], rows: [row('c1', 'FAKE-SKU-2', { axisValues: { size: 'XL (54)' } }), row('c2', 'FAKE-SKU-3', { axisValues: { size: 'L' } })] })
    expect(problems.issues).toEqual([{ productId: 'c1', sku: 'FAKE-SKU-2', field: 'size', severity: 'error', message: 'Size value "XL (54)": Etsy does not take ( or ) in variation values.' }])
    const finish = { fieldKey: 'property_300', label: 'Finish', validation: {} }
    expect(built({ owner: row('p', 'FAKE-SKU-1', { cells: cells({ ...MAIN, property_300: 'Matte (soft)' }), price: null, quantity: 0 }), fields: [finish], axes: [COLOR], rows }).issues
      .map(issue => issue.message)).toEqual(['Finish value "Matte (soft)": Etsy does not take ( or ) in property values.'])
  })

  it('W6 — a translation without a title or a description is not sent', () => {
    const problems = built({ axes: [COLOR], rows, translations: [{ language: 'de', cells: cells({ description: 'Handgenäht.' }) }] })
    expect(problems.notes).toContain('de translation: Etsy needs a title and a description, so it is not sent.')
  })
})
