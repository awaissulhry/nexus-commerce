import type { LineDraft } from '../pricing'

/**
 * An amendment of an order with a made-to-measure unit (B-W2b-368, XF1:01; W2a refused the whole order: "made-to-measure comes
 * later"). The unit is a line of the amendment like any other: named by its id it is kept, and it stays as it was sold —
 * factory-domain sales/amendments: its one piece, its price and its garment never change through an amendment, and it is never
 * left out (close it short, or a remake through a return); its words may change. The order's size-grid lines change as on any
 * order. A unit has no size rows (the database's size guard), so its money is its one piece: without it the order's totals and
 * the snapshot after would read 0 pieces and the database would refuse the line.
 */

/** A line's pieces for the money when it has no size rows: a made-to-measure unit's one piece (else its size rows count). */
export const unitPiece = (line: Pick<LineDraft, 'kind'>): { readonly quantity?: number } => (line.kind === 'MADE_TO_MEASURE' ? { quantity: 1 } : {})
