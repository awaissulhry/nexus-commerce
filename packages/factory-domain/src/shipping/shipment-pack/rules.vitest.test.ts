import { describe, expect, it } from 'vitest'
import { inPackOrder, mayHave, packFingerprint, packProblems, type PackPartFacts } from './rules'

const part = (kind: PackPartFacts['kind'], state: PackPartFacts['state'], sha = 'a'.repeat(64), words: string | null = null): PackPartFacts => ({
  kind,
  state,
  number: null,
  words,
  files: state === 'READY' ? [{ fileId: kind, sha256: sha }] : [],
})

describe('one PDF per shipment (LOG-031)', () => {
  it('merges the parts in their order: labels, packing list, DDT, commercial invoice, proforma', () => {
    expect(inPackOrder([part('DDT', 'READY'), part('PROFORMA', 'NONE'), part('LABELS', 'READY'), part('PACKING_LIST', 'READY')]).map((entry) => entry.kind)).toEqual(['LABELS', 'PACKING_LIST', 'DDT', 'PROFORMA'])
  })

  it('gives the priced parts only to someone who sees prices', () => {
    expect(mayHave('PROFORMA', false)).toBe(false)
    expect(mayHave('COMMERCIAL_INVOICE', false)).toBe(false)
    expect(mayHave('DDT', false)).toBe(true)
    expect(mayHave('PROFORMA', true)).toBe(true)
  })

  it('fingerprints the ready parts by their contents only', () => {
    const one = packFingerprint([part('LABELS', 'READY'), part('DDT', 'READY', 'b'.repeat(64)), part('PACKING_LIST', 'MISSING')])
    expect(packFingerprint([part('LABELS', 'READY'), part('DDT', 'READY', 'b'.repeat(64)), part('PACKING_LIST', 'NONE')])).toBe(one)
    expect(packFingerprint([part('LABELS', 'READY'), part('DDT', 'READY', 'c'.repeat(64))])).not.toBe(one)
  })

  it('refuses a pack with nothing ready, in the words of what is missing, and a cancelled shipment', () => {
    expect(packProblems('PACKED', [part('LABELS', 'MISSING', undefined, 'Buy the carrier labels first.'), part('DDT', 'MISSING', undefined, 'Issue the DDT first.')])).toEqual(['Nothing to print yet. Buy the carrier labels first. Issue the DDT first.'])
    expect(packProblems('CANCELLED', [part('DDT', 'READY')])).toEqual(['The shipment is cancelled: it has no papers to print.'])
    expect(packProblems('PACKED', [part('DDT', 'READY')])).toEqual([])
  })
})
