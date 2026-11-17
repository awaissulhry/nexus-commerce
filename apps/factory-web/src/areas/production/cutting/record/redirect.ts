import { companyPrefix } from '../../../../lib/session/session'

/**
 * F-PR-06 (06-tree A.4, O-CUT-rec) — the Cut record `/w/<company>/production/cutting/<work order>` was the same fact twice: one
 * work order's leather cut, beside the work order's own Cutting tab. It merged into the work order's "Cutting & bundles" tab;
 * its address stays and opens that tab. Every old `?tab=` of the Cut record (Lay or hides, Pieces, Yield, Tickets) maps to the
 * one tab, and the record read no other term, so nothing else is carried. The work order's own read checks who may open it.
 */

/** Where an old Cut record address goes: its work order's Cutting & bundles tab (`company` as the route segment gives it). */
export function cutRecordAddress(company: string, workOrderId: string): string {
  return `${companyPrefix(decodeURIComponent(company))}/production/work-orders/${encodeURIComponent(decodeURIComponent(workOrderId))}?tab=cutting`
}
