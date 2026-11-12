import type { Issue } from '../../core/errors'

/**
 * Partial returns by bundle (B-W2b-331; SCM-145; design floor.kits "Receive back": "Bundle by bundle: out, back, rejected";
 * factory-db subcontract.prisma SubcontractBundle, SubcontractReceiptLine, B-W2b-01/-10). Pure. A bundle of cut pieces goes
 * out with the order's kit (one SubcontractBundle row: the garments it carried) and comes back in one receipt or several,
 * per operation of the order that sends its cell: good, defective, scrapped there. Per bundle and operation:
 * back = good + defective + scrapped over every receipt; still out = garments sent − back. A bundle is OUT until some of
 * it is back, PARTLY_BACK while some is still out, BACK once every operation has all of it.
 *
 * Once an order recorded the bundles it sent, a receipt names only those (a bundle that never left with the order cannot
 * come back from the workshop) and never more of one than it carried out; an order that sent no bundle on record (its
 * pieces counted by hand, or sent before W2b) keeps W2a's rule: a bundle of its work order's cells, at most its garments.
 */

export const BUNDLE_STATES = ['OUT', 'PARTLY_BACK', 'BACK'] as const
export type BundleState = (typeof BUNDLE_STATES)[number]

export interface BundleBack {
  readonly good: number
  readonly defective: number
  readonly scrapped: number
}

export const backTotal = (back: BundleBack): number => back.good + back.defective + back.scrapped

/** A bundle's state from its garments out and what came back per operation it goes through (one entry per operation). */
export function bundleStateOf(garments: number, perOperation: readonly BundleBack[]): BundleState {
  if (perOperation.length === 0 || perOperation.every((back) => backTotal(back) === 0)) return 'OUT'
  return perOperation.every((back) => backTotal(back) >= garments) ? 'BACK' : 'PARTLY_BACK'
}

/**
 * Why a receipt line may not name this bundle (path `<at>/bundleId` or `<at>/good`): it did not go out with the order
 * (when the order's bundles are on record), or more of it would be back on the operation than it carried out.
 */
export function bundleBackProblems(
  at: string,
  bundle: { readonly code: string; readonly garments: number },
  facts: { readonly onRecord: boolean; readonly sent: boolean; readonly earlier: number; readonly now: number; readonly operationSeq: number },
): Issue[] {
  if (facts.onRecord && !facts.sent) return [{ path: `${at}/bundleId`, message: `Bundle ${bundle.code} did not go out with this order: only the bundles it sent come back from the workshop.` }]
  if (facts.earlier + facts.now > bundle.garments) {
    return [{ path: `${at}/good`, message: `Bundle ${bundle.code} went out with ${bundle.garments} garment(s); ${facts.earlier} came back already on line ${facts.operationSeq}, so at most ${Math.max(0, bundle.garments - facts.earlier)} more.` }]
  }
  return []
}
