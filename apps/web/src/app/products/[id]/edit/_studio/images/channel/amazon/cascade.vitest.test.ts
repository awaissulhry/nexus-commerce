/**
 * PES.7 — the Amazon cascade. The order encoded here is the publisher's order; a matrix that
 * resolved differently would be a picture of a listing nobody is going to get.
 *
 * The fixtures mirror GALE-JACKET's real shape: PLATFORM rows with a null marketplace, MARKETPLACE
 * rows per market, buckets stored under `Color` while the resolved axis is called `Colore`.
 */
import { describe, expect, it } from 'vitest'

import { bucketValues, resolveCell, type CascadeRow } from './cascade'

const row = (p: Partial<CascadeRow> & { id: string; url: string }): CascadeRow => ({
  scope: 'PLATFORM', platform: 'AMAZON', marketplace: null, amazonSlot: 'MAIN',
  variantGroupKey: null, variantGroupValue: null, ...p,
})

const ROWS: CascadeRow[] = [
  row({ id: 'shared-main', url: 'shared/MAIN' }),
  row({ id: 'giallo-main', url: 'giallo/MAIN', variantGroupKey: 'Color', variantGroupValue: 'Giallo' }),
  row({ id: 'giallo-main-es', url: 'giallo/MAIN/ES', variantGroupKey: 'Color', variantGroupValue: 'Giallo',
        scope: 'MARKETPLACE', marketplace: 'ES' }),
  row({ id: 'shared-pt01', url: 'shared/PT01', amazonSlot: 'PT01' }),
]

describe('resolveCell — the four layers, in the publisher’s order', () => {
  it("prefers this market's own row over the all-markets row", () => {
    const r = resolveCell({ rows: ROWS, slot: 'MAIN', market: 'ES', groupValue: 'Giallo' })
    expect(r.origin).toBe('market')
    expect(r.url).toBe('giallo/MAIN/ES')
    expect(r.inheritedFrom).toBe('Amazon · ES')
  })

  it('falls to the all-markets row in a market that has no row of its own', () => {
    const r = resolveCell({ rows: ROWS, slot: 'MAIN', market: 'IT', groupValue: 'Giallo' })
    expect(r.origin).toBe('platform')
    expect(r.url).toBe('giallo/MAIN')
  })

  it('inherits the shared bucket when a colour has nothing at that slot', () => {
    const r = resolveCell({ rows: ROWS, slot: 'PT01', market: 'IT', groupValue: 'Giallo' })
    expect(r.origin).toBe('shared')
    expect(r.url).toBe('shared/PT01')
    expect(r.inheritedFrom).toBe('all colours')
  })

  it('does NOT let the shared row inherit from itself — it goes straight to master', () => {
    // The shared row IS the shared bucket; treating its own miss as inheritance would report a
    // picture as inherited from the place it already is.
    const r = resolveCell({ rows: ROWS, slot: 'PT02', market: 'IT', groupValue: null,
                            masterFallbackUrl: 'master/PT02' })
    expect(r.origin).toBe('master')
    expect(r.inheritedFrom).toBe('master gallery')
  })

  it('reports master fallback when the channel has nothing at all', () => {
    const r = resolveCell({ rows: ROWS, slot: 'PT08', market: 'IT', groupValue: 'Nero',
                            masterFallbackUrl: 'master/PT08' })
    expect(r.origin).toBe('master')
    expect(r.url).toBe('master/PT08')
  })

  it('is empty when neither the channel nor master has anything', () => {
    const r = resolveCell({ rows: ROWS, slot: 'PT08', market: 'IT', groupValue: 'Nero' })
    expect(r).toEqual({ origin: 'empty', url: null, row: null, inheritedFrom: null })
  })

  it('never lets one market’s row leak into another market', () => {
    // giallo-main-es is MARKETPLACE/ES. Asking for DE must not return it.
    const de = resolveCell({ rows: ROWS, slot: 'MAIN', market: 'DE', groupValue: 'Giallo' })
    expect(de.row?.id).toBe('giallo-main')
    expect(de.origin).toBe('platform')
  })

  it('ignores the market layer entirely when no market is selected', () => {
    const r = resolveCell({ rows: ROWS, slot: 'MAIN', market: null, groupValue: 'Giallo' })
    expect(r.origin).toBe('platform')
    expect(r.url).toBe('giallo/MAIN')
  })

  it('keeps buckets separate — Nero does not see Giallo’s picture', () => {
    const r = resolveCell({ rows: ROWS, slot: 'MAIN', market: 'ES', groupValue: 'Nero' })
    // Nero has nothing of its own, so it inherits the SHARED row, not Giallo's.
    expect(r.origin).toBe('shared')
    expect(r.url).toBe('shared/MAIN')
  })
})

describe('bucketValues — the axis names the rows, the rows keep their own key', () => {
  it('renders the axis values in their declared order', () => {
    const { values } = bucketValues(['Giallo', 'Nero'], ROWS)
    expect(values).toEqual(['Giallo', 'Nero'])
  })

  it('joins on the VALUE, so a Colore/Color name mismatch still resolves', () => {
    // The real case: the axis is called "Colore", every stored row says variantGroupKey "Color".
    // Matching on the name would find nothing; matching on the value finds the picture.
    const r = resolveCell({ rows: ROWS, slot: 'MAIN', market: 'ES', groupValue: 'Giallo' })
    expect(r.url).toBe('giallo/MAIN/ES')
  })

  it('reports a stored bucket the axis no longer knows rather than dropping it', () => {
    const withGhost = [...ROWS, row({ id: 'x', url: 'rosso/MAIN', variantGroupKey: 'Color', variantGroupValue: 'Rosso' })]
    const { values, orphaned } = bucketValues(['Giallo', 'Nero'], withGhost)
    expect(values).toEqual(['Giallo', 'Nero'])
    // A picture that exists on the channel must be surfaced somewhere, not silently hidden.
    expect(orphaned).toEqual(['Rosso'])
  })

  it('treats an empty-string bucket value as unbucketed, not as a bucket named ""', () => {
    const odd = [...ROWS, row({ id: 'y', url: 'z', variantGroupValue: '' })]
    expect(bucketValues(['Giallo'], odd).orphaned).toEqual([])
  })
})

describe('a row that holds no picture', () => {
  // 16 of GALE-JACKET's 65 Amazon rows are like this, one of them marked PUBLISHED.
  const pictureless: CascadeRow[] = [
    row({ id: 'shared-main', url: '', publishStatus: 'PUBLISHED' }),
    row({ id: 'shared-pt01', url: 'shared/PT01', amazonSlot: 'PT01' }),
  ]

  it('stops the cascade rather than inheriting a picture that will not publish', () => {
    const r = resolveCell({ rows: pictureless, slot: 'MAIN', market: 'IT', groupValue: 'Giallo',
                            masterFallbackUrl: 'master/MAIN' })
    // It must NOT fall through to master — that would paint something Amazon will not be sent.
    expect(r.origin).toBe('pictureless')
    expect(r.url).toBeNull()
    expect(r.row?.id).toBe('shared-main')
  })

  it('stops at the coordinate’s own empty row too, not only the shared one', () => {
    const rows = [row({ id: 'g', url: '', variantGroupValue: 'Giallo' }), ...pictureless]
    const r = resolveCell({ rows, slot: 'MAIN', market: 'IT', groupValue: 'Giallo' })
    expect(r.origin).toBe('pictureless')
    expect(r.row?.id).toBe('g')
  })

  it('leaves a genuinely absent row free to inherit as before', () => {
    const r = resolveCell({ rows: pictureless, slot: 'PT01', market: 'IT', groupValue: 'Giallo' })
    expect(r.origin).toBe('shared')
    expect(r.url).toBe('shared/PT01')
  })
})
