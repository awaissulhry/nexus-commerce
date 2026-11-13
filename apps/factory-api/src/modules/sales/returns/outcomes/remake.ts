import type { Prisma } from '@nexus/factory-db'
import { unitOfLine } from '../../fittings/remake'
import type { LineRow, Reader } from '../store'

/**
 * A remake as a return outcome (B-W2b-368, XF1:03). W2a's decision took REMAKE from B-W2b-360 on, but left it out of its preview
 * (`options`), and the customer's wish to have a unit made again was only an audit row (B-W2b-346); wave 45 (B-W2b-363) added
 * ReturnOutcomeWanted REMAKE:
 *
 *   remakeChoicesOf   the decision preview offers REMAKE for a line that takes back a made-to-measure unit (its order line's, or
 *                     its invoice line's order line's), with the unit's outcomes (scrapped, or held in quarantine: factory-domain
 *                     OUTCOMES_BY_DISPOSITION.REMAKE), each held with GATE-MTM's words while made-to-measure is off for the
 *                     unit's template; any other line is not offered a remake
 *   REMAKE_WISH       what a remake writes on the RMA: the customer's wish REMAKE — at the insert for a remake asked through the
 *                     portal or a claim link, and in the office's mark (POST /sales/returns/:id/remake, while REQUESTED,
 *                     AUTHORISED or RECEIVED: the …_followups_sales_w2b5_guards rule, once, never changed after)
 */

/** The RMA's columns a remake sets: the customer would like the unit made again. */
export const REMAKE_WISH = { outcomeWanted: 'REMAKE' } as const satisfies Prisma.ReturnAuthorisationUncheckedUpdateInput

/** A line the preview may offer REMAKE: why not now (GATE-MTM's words) or null. */
export interface RemakeChoice {
  readonly refusal: string | null
}

/** The lines that take back a made-to-measure unit (line id → its choice); a line missing here is offered no remake. */
export async function remakeChoicesOf(db: Reader, lines: readonly Pick<LineRow, 'id' | 'salesOrderLineId' | 'invoiceLineId'>[]): Promise<Map<string, RemakeChoice>> {
  const out = new Map<string, RemakeChoice>()
  for (const line of lines) {
    const unit = await unitOfLine(db, line)
    if (unit) out.set(line.id, { refusal: unit.refusal })
  }
  return out
}
