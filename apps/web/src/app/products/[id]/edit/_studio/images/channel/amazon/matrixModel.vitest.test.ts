/**
 * PES.7 — the matrix's rows, columns and cell values.
 * The column test is the one that matters: the slot set is the SERVER'S, per product type.
 */
import { describe, expect, it } from 'vitest'

import type { AmazonSlotDef } from '../../types'
import { buildCellValue, masterFallback, matrixColumns, matrixRows, picturelessCoordinates, SHARED_ROW_ID } from './matrixModel'
import type { CascadeRow } from './cascade'

const slot = (s: string, order: number, writable = true, kind: AmazonSlotDef['kind'] = 'OTHER'): AmazonSlotDef =>
  ({ slot: s, attribute: `attr_${s}`, kind, order, writable })

const row = (p: Partial<CascadeRow> & { id: string; url: string }): CascadeRow => ({
  scope: 'PLATFORM', platform: 'AMAZON', marketplace: null, amazonSlot: 'MAIN',
  variantGroupKey: null, variantGroupValue: null, ...p,
})

describe('matrixColumns', () => {
  it('uses the SERVER’s slot set, in its declared order', () => {
    const { columns, slotSetSource } = matrixColumns(
      [slot('SWCH', 3), slot('MAIN', 1, true, 'MAIN'), slot('PS01', 2, true, 'SAFETY')], 'schema')
    expect(columns.map((c) => c.slot)).toEqual(['MAIN', 'PS01', 'SWCH'])
    expect(slotSetSource).toBe('schema')
  })

  it('🔴 does NOT call a fallback "schema" just because it has slots', () => {
    // The bug this replaced: a fallback arrives as a perfectly good non-empty list of ten slots,
    // and the old inference (`length > 0 ? schema : fallback`) called it authoritative.
    const { columns, slotSetSource } = matrixColumns(
      [slot('MAIN', 1, true, 'MAIN'), slot('PT01', 2)], 'fallback')
    expect(columns).toHaveLength(2)
    expect(slotSetSource).toBe('fallback')
  })

  it('reports UNKNOWN when the server did not say, rather than assuming either way', () => {
    const { slotSetSource } = matrixColumns([slot('MAIN', 1, true, 'MAIN')], undefined)
    expect(slotSetSource).toBe('unknown')
  })

  it('carries writability through, so a read-only locator cannot be dropped on', () => {
    const { columns } = matrixColumns([slot('MAIN', 1), slot('PT01', 2, false)])
    expect(columns.find((c) => c.slot === 'PT01')!.writable).toBe(false)
  })

  it('falls back to the legacy set on an older API response, and SAYS it did', () => {
    const { columns, slotSetSource } = matrixColumns(undefined)
    expect(slotSetSource).toBe('fallback')
    // The distinction matters: 10 legacy slots vs the 16 GALE-JACKET actually resolves.
    expect(columns).toHaveLength(10)
    expect(columns.some((c) => c.slot.startsWith('PS'))).toBe(false)
  })
})

describe('matrixRows', () => {
  it('puts the shared bucket first, then the axis values in declared order', () => {
    const rows = matrixRows(['Giallo', 'Nero'], [])
    expect(rows.map((r) => r.id)).toEqual([SHARED_ROW_ID, 'Giallo', 'Nero'])
    expect(rows[0].groupValue).toBeNull()
  })

  it('surfaces a stored bucket the axis dropped, marked as orphaned', () => {
    const rows = matrixRows(['Giallo'], [row({ id: 'a', url: 'u', variantGroupValue: 'Rosso' })])
    expect(rows.map((r) => r.id)).toEqual([SHARED_ROW_ID, 'Giallo', 'Rosso'])
    expect(rows.find((r) => r.id === 'Rosso')!.orphaned).toBe(true)
  })
})

describe('buildCellValue', () => {
  const rows = [
    row({ id: 's', url: 'shared/MAIN' }),
    row({ id: 'g', url: 'giallo/MAIN', variantGroupValue: 'Giallo', publishStatus: 'PUBLISHED' }),
    row({ id: 'e', url: 'giallo/MAIN/ES', variantGroupValue: 'Giallo', scope: 'MARKETPLACE', marketplace: 'ES',
          publishStatus: 'ERROR', publishError: 'Amazon rejected the image' }),
  ]

  it('reads a market row as pinned and an all-markets row as own', () => {
    expect(buildCellValue({ rows, slot: 'MAIN', market: 'ES', groupValue: 'Giallo', writable: true }).provenance).toBe('pinned')
    expect(buildCellValue({ rows, slot: 'MAIN', market: 'IT', groupValue: 'Giallo', writable: true }).provenance).toBe('own')
  })

  it('reads an inherited shared picture as inheritance, in the CELL vocabulary', () => {
    const v = buildCellValue({ rows, slot: 'MAIN', market: 'IT', groupValue: 'Nero', writable: true })
    expect(v.provenance).toBe('inherited')
    expect(v.inheritedFrom).toBe('all colours')
  })

  it('carries the channel’s refusal onto the tile rather than losing it', () => {
    const v = buildCellValue({ rows, slot: 'MAIN', market: 'ES', groupValue: 'Giallo', writable: true })
    expect(v.refused).toBe('Amazon rejected the image')
    expect(v.publish).toBe('failed')
  })

  it('locks a cell whose slot Amazon marks read-only, even with a picture in it', () => {
    const v = buildCellValue({ rows, slot: 'MAIN', market: 'IT', groupValue: 'Giallo', writable: false })
    expect(v.locked).toBe(true)
    expect(v.src).toBe('giallo/MAIN')
  })

  it('is empty rather than inventing a picture when nothing resolves', () => {
    const v = buildCellValue({ rows, slot: 'PT07', market: 'IT', groupValue: 'Nero', writable: true })
    expect(v.src).toBeNull()
    expect(v.provenance).toBeUndefined()
  })
})

describe('masterFallback', () => {
  const master = [
    { id: 'a', type: 'ALT', url: 'alt', isPrimary: false },
    { id: 'm', type: 'MAIN', url: 'main', isPrimary: false },
    { id: 'h', type: 'ALT', url: 'hero', isPrimary: true },
  ] as never

  it('prefers the operator-curated hero over type MAIN', () => {
    // isPrimary is the operator's explicit choice; type is a classification.
    expect(masterFallback(master, 'MAIN')).toBe('hero')
  })

  it('offers no fallback for gallery slots — master has no opinion about PT03', () => {
    expect(masterFallback(master, 'PT03')).toBeNull()
  })
})

describe('a pictureless row is explained, not just blank', () => {
  const rows = [row({ id: 's', url: '', publishStatus: 'PUBLISHED' })]

  it('names the contradiction when the channel believes the slot is live', () => {
    const v = buildCellValue({ rows, slot: 'MAIN', market: 'IT', groupValue: null, writable: true })
    expect(v.src).toBeNull()
    expect(v.publish).toBe('live')
    expect(v.warn).toBe('This slot is marked published on Amazon but holds no image')
  })

  it('says something softer when the row is not claiming to be live', () => {
    const draft = [row({ id: 's', url: '', publishStatus: 'DRAFT' })]
    expect(buildCellValue({ rows: draft, slot: 'MAIN', market: 'IT', groupValue: null, writable: true }).warn)
      .toBe('A row claims this slot but holds no image')
  })

  it('does not warn about a slot that is simply empty', () => {
    expect(buildCellValue({ rows: [], slot: 'PT05', market: 'IT', groupValue: null, writable: true }).warn).toBeNull()
  })
})

describe('picturelessCoordinates', () => {
  const columns = matrixColumns([slot('MAIN', 1), slot('PT01', 2)]).columns

  it('counts the coordinates a pictureless row occupies, and how many claim to be live', () => {
    const rows = [row({ id: 's', url: '', publishStatus: 'PUBLISHED' })]
    const matrix = matrixRows(['Giallo', 'Nero'], rows)
    // The shared MAIN row is pictureless, and both colours resolve THROUGH it — three coordinates.
    const c = picturelessCoordinates({ rows, columns, matrix, market: 'IT' })
    expect(c.total).toBe(3)
    expect(c.claimingLive).toBe(3)
  })

  it('separates rows that are not claiming to be live', () => {
    const rows = [row({ id: 's', url: '', publishStatus: 'DRAFT' })]
    const matrix = matrixRows(['Giallo'], rows)
    const c = picturelessCoordinates({ rows, columns, matrix, market: 'IT' })
    expect(c.total).toBe(2)
    expect(c.claimingLive).toBe(0)
  })

  it('counts nothing when every row holds a picture', () => {
    const rows = [row({ id: 's', url: 'shared/MAIN' })]
    const matrix = matrixRows(['Giallo'], rows)
    expect(picturelessCoordinates({ rows, columns, matrix, market: 'IT' }).total).toBe(0)
  })
})
