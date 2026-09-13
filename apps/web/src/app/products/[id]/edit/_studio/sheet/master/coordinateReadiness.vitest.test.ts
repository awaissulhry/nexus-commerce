import { describe, expect, it } from 'vitest'
import { coordinateReadinessColumns } from './useMasterSheetAdapter'

/**
 * LX.FIN (R-LX-22, design §8 LX.15) — the master sheet's per-coordinate readiness COLUMN SET.
 *
 * 🔴 What this replaces. LX.F2's version tested `hasCoordinateReadiness`, a guard over
 * `sheet.coordinates` + `row.readinessByCoordinate` — the ROW-vocabulary pair the live studio payload
 * does not carry at all (measured through the producer on 2026-09-13: the payload's keys are
 * `aliases · columns · counts · family · groups · meta · rows · schema · scope`, and
 * `/usr/bin/grep -rc readinessByCoordinate apps/api/src` matched zero files). R-LX-22 rules the columns
 * are fed from `ReadinessIndex` in the SCOPE vocabulary, so the guard's whole subject is gone and both
 * the field and its only producer are deleted.
 *
 * The arms here are the ones that would put a wrong verdict on screen:
 *  - a per-ROW lookup, not the coordinate summary (measured on GALE-JACKET: eBay·IT·xaviaracing·it is
 *    `blocked` as a coordinate while its 21 rows are 1 `ready` + 20 `blocked`);
 *  - the SHARED coordinate excluded, because the sheet's own `ready:scope` column answers for it in the
 *    other vocabulary;
 *  - only the PRESSED language;
 *  - a missing product key is `Not computed` at the call site, never a score (R-LX-9) — asserted here as
 *    "the key is absent", which is what the column's valueGetter turns into `notComputed`.
 *
 * `apps/web` vitest is node-only, so this tests the pure derivation and not the rendered cell.
 */

const entry = (over: Partial<NonNullable<Parameters<typeof coordinateReadinessColumns>[0]>[number]> = {}) => ({
  channel: 'AMAZON', market: 'IT', accountId: null, aliasId: null,
  coordinateKey: JSON.stringify(['AMAZON', 'IT', null, null]),
  language: 'it', label: 'Amazon · IT', computedAt: '2026-09-13T09:00:00.000Z',
  byProduct: { p1: { state: 'ready' as const, pct: 100 } },
  ...over,
})

describe('coordinateReadinessColumns', () => {
  it('makes one column per CHANNEL coordinate in the pressed language', () => {
    const columns = coordinateReadinessColumns([
      entry(),
      entry({ channel: 'EBAY', label: 'eBay · IT · xaviaracing', accountId: 'acc1' }),
    ], 'it')
    expect(columns.map(c => c.label)).toEqual(['Amazon · IT', 'eBay · IT · xaviaracing'])
    // The account is part of the id, so two accounts on one channel+market are two columns, not one.
    expect(columns.map(c => c.colId)).toEqual(['ready:AMAZON:IT:it', 'ready:EBAY:IT:acc1:it'])
  })

  it('excludes the SHARED coordinate — the ready:scope column already answers for it', () => {
    expect(coordinateReadinessColumns([entry({ channel: null, market: null, label: 'Shared product' })], 'it')).toEqual([])
    // POSITIVE CONTROL, same shape, same run: a channel coordinate IS included.
    expect(coordinateReadinessColumns([entry()], 'it')).toHaveLength(1)
  })

  it('takes only the pressed language, case-insensitively', () => {
    const matrix = [entry({ language: 'it' }), entry({ language: 'de', label: 'Amazon · DE', market: 'DE' })]
    expect(coordinateReadinessColumns(matrix, 'DE').map(c => c.label)).toEqual(['Amazon · DE'])
    expect(coordinateReadinessColumns(matrix, 'it-IT'.slice(0, 2)).map(c => c.label)).toEqual(['Amazon · IT'])
  })

  it('carries the PER-PRODUCT verdicts, so a row is not painted with the coordinate summary', () => {
    const [column] = coordinateReadinessColumns([entry({
      byProduct: { parent: { state: 'ready', pct: 100 }, child: { state: 'blocked', pct: 100 } },
    })], 'it')
    expect(column.byProduct.parent.state).toBe('ready')
    expect(column.byProduct.child.state).toBe('blocked')
    // 🔴 The arm that matters: a product with no index row is ABSENT, not `ready` and not 0%.
    expect(column.byProduct.other).toBeUndefined()
  })

  it('an entry with no byProduct at all is a column of “Not computed”, never a column of scores', () => {
    const [column] = coordinateReadinessColumns([{ ...entry(), byProduct: undefined }], 'it')
    expect(column.byProduct).toEqual({})
  })

  it('produces nothing when there is no matrix or no language — never a blank column set', () => {
    expect(coordinateReadinessColumns(undefined, 'it')).toEqual([])
    expect(coordinateReadinessColumns([], 'it')).toEqual([])
    expect(coordinateReadinessColumns([entry()], null)).toEqual([])
    expect(coordinateReadinessColumns([entry()], '')).toEqual([])
  })

  it('keeps computedAt verbatim for the header tooltip — a null is “not stated”, not “now”', () => {
    expect(coordinateReadinessColumns([entry()], 'it')[0].computedAt).toBe('2026-09-13T09:00:00.000Z')
    expect(coordinateReadinessColumns([entry({ computedAt: null })], 'it')[0].computedAt).toBeNull()
  })
})
