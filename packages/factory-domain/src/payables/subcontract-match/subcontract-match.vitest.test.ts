import { describe, expect, it } from 'vitest'
import { liveEntries, subcontractLineMatch, subcontractMatchWords, suggestionAmount, type OperationFacts } from './rules'

/** B-W2b-403 (FIN-138, PQ1:03): a subcontractor's invoice against the operations done, the pieces back and the FEE entries. */
describe('the subcontractor invoice match', () => {
  const sewing: OperationFacts = { id: 'op-1', seq: 10, pricePerPiece: '4.500000', pieces: 10, piecesBackGood: 8, piecesDefective: 1, piecesScrapped: 1, waiting: 2, bookedByFee: 0, bookable: 6, earned: 2700 }
  const base = { currency: 'EUR', billedElsewhere: '0', operations: [sewing], entries: [] }

  it('the pieces owed at the order price: matched through the earned fee', () => {
    const match = subcontractLineMatch({ ...base, invoicedPieces: '6', net: 2700 })
    expect(match).toMatchObject({ verdict: 'MATCHED', price: 'SAME', piecesOwed: 6, piecesWaiting: 2, piecesAtInvoicedPrice: 6, invoicedUnitPrice: '4.500000', orderUnitPrice: '4.500000', suggestions: [] })
    expect(match.cost).toEqual({ earnedFee: 2700, fees: 0, charges: 0, total: 2700 })
    expect(subcontractMatchWords(match, { prices: true }).en).toBe('Matched: 6 pieces billed, 6 pieces back good (2 more wait for inspection), carried on the work order at the invoiced price.')
  })

  it('more pieces than came back good (other invoices count): not owed yet', () => {
    const match = subcontractLineMatch({ ...base, invoicedPieces: '4', billedElsewhere: '3', net: 1800 })
    expect(match).toMatchObject({ verdict: 'MORE_THAN_RETURNED', invoicedTotal: '7.0000', suggestions: [] })
  })

  it('a higher price: book the pieces at the invoiced price, never more than bookable; a FEE entry at that price matches them', () => {
    const match = subcontractLineMatch({ ...base, invoicedPieces: '6', net: 3000 })
    expect(match).toMatchObject({ verdict: 'BOOK_FEE', price: 'HIGHER', invoicedUnitPrice: '5.000000', piecesAtInvoicedPrice: 0, suggestions: [{ subcontractOperationId: 'op-1', seq: 10, quantity: 6, unitPrice: '5.000000' }] })
    expect(suggestionAmount(match.suggestions[0]!, 'EUR')).toBe(3000)
    expect(subcontractMatchWords(match, { prices: false }).en).toBe('The price differs from the order\'s: book 6 pieces on the work order so its cost carries what is paid (6 pieces back good (2 more wait for inspection)).')
    const booked = { ...sewing, bookedByFee: 6, bookable: 0, earned: 0 }
    const fee = { id: 'e-1', kind: 'FEE' as const, subcontractOperationId: 'op-1', quantity: '6', unitPrice: '5.000000', amount: 3000, reversalOfId: null }
    const after = subcontractLineMatch({ ...base, operations: [booked], entries: [fee], invoicedPieces: '6', net: 3000 })
    expect(after).toMatchObject({ verdict: 'MATCHED', matchedEntryIds: ['e-1'], piecesAtInvoicedPrice: 6 })
    expect(after.cost).toEqual({ earnedFee: 0, fees: 3000, charges: 0, total: 3000 })
  })

  it('a reversed entry and its reversal stand no more; charges count in the cost', () => {
    const entries = [
      { id: 'e-1', kind: 'FEE' as const, subcontractOperationId: 'op-1', quantity: '2', unitPrice: '5.000000', amount: 1000, reversalOfId: null },
      { id: 'e-2', kind: 'FEE' as const, subcontractOperationId: 'op-1', quantity: '2', unitPrice: '5.000000', amount: -1000, reversalOfId: 'e-1' },
      { id: 'e-3', kind: 'TRANSPORT' as const, subcontractOperationId: null, quantity: '1', unitPrice: '35.000000', amount: 3500, reversalOfId: null },
    ]
    expect(liveEntries(entries).map((entry) => entry.id)).toEqual(['e-3'])
    const match = subcontractLineMatch({ ...base, entries, invoicedPieces: '6', net: 2700 })
    expect(match.cost).toEqual({ earnedFee: 2700, fees: 0, charges: 3500, total: 6200 })
  })

  it('no pieces named: read against the order as a whole', () => {
    const match = subcontractLineMatch({ ...base, invoicedPieces: null, net: 2700 })
    expect(match).toMatchObject({ verdict: 'NO_QUANTITY', invoicedUnitPrice: null })
    expect(subcontractMatchWords(match, { prices: true }).it).toBe("La riga non indica i pezzi: si controlla sull'ordine intero; 6 pezzi rientrati buoni (altri 2 attendono il controllo).")
  })
})
