/**
 * PES.5 — readiness delegation.
 *
 * The point of these tests is NOT that `computeReadiness` still returns what it
 * used to (pim-sheet-rows.test.ts already pins that, and it passed unchanged).
 * It is that the delegation actually ADDED the checks it claims to have added.
 * A refactor that routes through the real validators but never fires one would
 * pass every existing test and still be worthless
 * (reference_a_scanner_passing_for_the_wrong_reason).
 *
 * Expected values here are written by hand from the RULE, never by calling the
 * function under test or the helper it delegates to.
 */
import { describe, it, expect } from 'vitest'
import { computeReadiness, type SheetCellValue } from './sheet-rows.service.js'
import { buildCoordinateValidators, evaluateRow } from './readiness.service.js'
import type { SheetColumn, SheetCoordinate } from './sheet-columns.service.js'

const coord = (marketplace: string, label = `Amazon · ${marketplace}`): SheetCoordinate => ({
  channel: 'AMAZON', marketplace, label, inMarket: true,
})
const AMAZON_IT = coord('IT')
const AMAZON_US = coord('US', 'Amazon · US')
const CHILD = { isParent: false, productType: 'OUTERWEAR' }

const col = (over: Partial<SheetColumn> & Pick<SheetColumn, 'key'>): SheetColumn => ({
  writeField: `attr_${over.key}`, label: over.key, group: 'Attributes', kind: 'text',
  storage: 'categoryAttributes', scope: 'global', requiredBy: [], editable: true, ...over,
})
const val = (value: unknown): SheetCellValue => ({ value, source: 'master', inheritedFrom: null, inherited: false })
const run = (columns: SheetColumn[], values: Record<string, SheetCellValue>, coordinate = AMAZON_IT) =>
  computeReadiness({ columns, values, row: CHILD, coordinate, listing: null })

describe('optional list readiness', () => {
  const nodes = col({ key: 'recommended_browse_nodes', shape: 'list', cardinality: { min: 1, max: 2 }, validation: { minItems: 1, maxItems: 2 } })
  it('does not require an optional list merely because populated lists have a minimum', () => {
    expect(evaluateRow({ recommended_browse_nodes: [] }, buildCoordinateValidators([nodes], AMAZON_IT, CHILD))).toEqual([])
  })
  it('still requires a list declared mandatory and validates populated lists', () => {
    const required = { ...nodes, requiredBy: [AMAZON_IT.label] }
    expect(evaluateRow({ recommended_browse_nodes: [] }, buildCoordinateValidators([required], AMAZON_IT, CHILD)))
      .toContainEqual(expect.objectContaining({ field: nodes.key, severity: 'error', message: expect.stringContaining('required') }))
    expect(evaluateRow({ recommended_browse_nodes: ['1', '2', '3'] }, buildCoordinateValidators([nodes], AMAZON_IT, CHILD)))
      .toContainEqual(expect.objectContaining({ field: nodes.key, severity: 'error', message: expect.stringContaining('at most 2') }))
  })
})

describe('GTIN mod-10 — added by the delegation', () => {
  // 5012345678900 is a real, hand-verified valid EAN-13:
  //   odd  positions 5+1+3+5+7+9  = 30
  //   even positions 0+2+4+6+8+0  = 20 -> x3 = 60
  //   30 + 60 = 90 -> check digit 0. Valid.
  it('accepts a GTIN whose check digit is correct', () => {
    const r = run([col({ key: 'ean' })], { ean: val('5012345678900') })
    expect(r.issues.filter((i) => i.key === 'ean')).toEqual([])
  })

  it('ERRORS on a GTIN whose check digit is wrong — the sheet was silent before', () => {
    // Same digits, last one changed: the checksum can no longer hold.
    const r = run([col({ key: 'ean' })], { ean: val('5012345678901') })
    const hit = r.issues.find((i) => i.key === 'ean')
    expect(hit).toBeDefined()
    expect(hit!.severity).toBe('error')
    expect(r.state).toBe('errors')
  })

  it('says nothing about a blank identifier — absence is the required check job', () => {
    const r = run([col({ key: 'ean' })], { ean: val('') })
    expect(r.issues.filter((i) => i.key === 'ean' && i.message.includes('valid'))).toEqual([])
  })
})

describe('GPSR — added by the delegation, and bounded honestly', () => {
  // The rule (listing-preflight): on a GPSR EU marketplace, a row with BOTH the
  // manufacturer reference AND the responsible-party contact blank is flagged.
  // Written from the rule, not by running the checker.
  const gpsrCols = [col({ key: 'dsa_responsible_party_address' }), col({ key: 'gpsr_manufacturer_reference' })]
  const blank = { dsa_responsible_party_address: val(''), gpsr_manufacturer_reference: val('') }

  it('flags a GPSR-incomplete row on IT — an EU marketplace', () => {
    const r = run(gpsrCols, blank, AMAZON_IT)
    expect(r.issues.length).toBeGreaterThan(0)
  })

  it('says NOTHING on US — GPSR is an EU regime, not a global one', () => {
    const r = run(gpsrCols, blank, AMAZON_US)
    expect(r.issues).toEqual([])
  })

  it('is silent once a responsible-party contact is present', () => {
    // Both GPSR contact fields are typed "e-mail o URL" by the Amazon schema, so
    // a POSTAL address is not an acceptable value even though it names the
    // manufacturer. Learned from the checker's own format rule, which is exactly
    // the kind of thing a sheet-local reimplementation gets wrong.
    const r = run(gpsrCols, {
      dsa_responsible_party_address: val('compliance@xavia.example'),
      gpsr_manufacturer_reference: val('https://xavia.example/compliance'),
    }, AMAZON_IT)
    expect(r.issues).toEqual([])
  })

  it('warns when a GPSR contact is filled but is not an email or URL', () => {
    const r = run(gpsrCols, {
      dsa_responsible_party_address: val('compliance@xavia.example'),
      gpsr_manufacturer_reference: val('Xavia Racing SRL, Milano'),
    }, AMAZON_IT)
    expect(r.issues.map((i) => i.severity)).toEqual(['warn'])
    expect(r.state).not.toBe('errors')
  })

  it('does not invent GPSR issues for columns this surface does not carry', () => {
    // The sheet has no compliance_media__* columns. `applicableColumns` must
    // bound the checker to what exists, or readiness reports a missing field the
    // operator has nowhere to fill in (reference_verification_probe_false_positives).
    const r = run([col({ key: 'item_name' })], { item_name: val('A jacket') }, AMAZON_IT)
    expect(r.issues.filter((i) => i.key.startsWith('compliance_media'))).toEqual([])
  })
})

describe('the severity policy the sheet keeps on purpose', () => {
  it('grades a CLOSED-list miss as warn, never error — a cached schema does not get to block', () => {
    const r = run(
      [col({ key: 'color', mode: 'strict', options: ['Nero', 'Rosso'] })],
      { color: val('Verde Militare') },
    )
    expect(r.issues[0].severity).toBe('warn')
    expect(r.state).not.toBe('errors')
  })

  it('an OPEN list accepts anything without a word', () => {
    const r = run([col({ key: 'season', options: ['SS', 'FW'] })], { season: val('Mid-season') })
    expect(r.issues).toEqual([])
  })
})

describe('validator inputs are per-coordinate work, not per-row', () => {
  it('reuses one prebuilt validator set across rows and gets the same answer', () => {
    const columns = [col({ key: 'brand', requiredBy: ['Amazon · IT'] })]
    const v = buildCoordinateValidators(columns, AMAZON_IT, CHILD)

    const withPrebuilt = computeReadiness({ columns, values: {}, row: CHILD, coordinate: AMAZON_IT, listing: null, validators: v })
    const withoutPrebuilt = computeReadiness({ columns, values: {}, row: CHILD, coordinate: AMAZON_IT, listing: null })

    expect(withPrebuilt).toEqual(withoutPrebuilt)
    expect(withPrebuilt.issues[0].message).toContain('Amazon · IT')
  })

  it('evaluateRow is pure — the same row twice gives the same issues', () => {
    const v = buildCoordinateValidators([col({ key: 'ean' })], AMAZON_IT, CHILD)
    const row = { ean: '5012345678901' }
    expect(evaluateRow(row, v)).toEqual(evaluateRow(row, v))
  })
})

describe('a null productType is a finding, not a neutral absence (hub ruling #15.3)', () => {
  // 42 products on prod carry a null productType (measured 2026-09-01). Without
  // a type no schema resolves, so `requiredBy` matches nothing and the row would
  // otherwise score a confident 100% having been validated against nothing.
  const NO_TYPE = { isParent: false, productType: null }

  it('ERRORS when the row has no product type', () => {
    const r = computeReadiness({
      columns: [col({ key: 'brand', requiredBy: ['Amazon · IT'] })],
      values: { brand: val('Xavia') },
      row: NO_TYPE, coordinate: AMAZON_IT, listing: null,
    })
    const hit = r.issues.find((i) => i.key === 'productType')
    expect(hit).toBeDefined()
    expect(hit!.severity).toBe('error')
    expect(r.state).toBe('errors')
  })

  it('a typed row with the same values is NOT flagged for product type', () => {
    const r = computeReadiness({
      columns: [col({ key: 'brand', requiredBy: ['Amazon · IT'] })],
      values: { brand: val('Xavia') },
      row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.issues.find((i) => i.key === 'productType')).toBeUndefined()
  })

  it('the untyped row does NOT silently report as ready', () => {
    // The exact failure mode, staged so `ready` is genuinely REACHABLE: a
    // listing exists (so the state is not forced to `unlisted`) and it has no
    // external id (so it is not forced to `live`). Every column here is
    // restricted to a product type this row does not have, so without the
    // productType check there are zero issues and the row reports `ready`
    // having been validated against nothing at all.
    const listing = {
      id: 'l1', listingStatus: 'DRAFT', isPublished: false, price: 10, quantity: 1,
      externalListingId: null, follows: {},
    }
    const columns = [col({ key: 'brand', requiredBy: ['Amazon · IT'], requiredForProductTypes: ['OUTERWEAR'] })]

    const untyped = computeReadiness({ columns, values: {}, row: NO_TYPE, coordinate: AMAZON_IT, listing })
    expect(untyped.state).toBe('errors')
    expect(untyped.issues.map((i) => i.key)).toContain('productType')

    // Same columns, same empty values, but WITH a type: the ordinary
    // required-field error appears instead. Proves the fixture would otherwise
    // have been silent for the untyped row rather than failing for some
    // unrelated reason.
    const typed = computeReadiness({ columns, values: {}, row: CHILD, coordinate: AMAZON_IT, listing })
    expect(typed.issues.map((i) => i.key)).toEqual(['brand'])
  })
})
