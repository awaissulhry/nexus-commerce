import { whereUsedView, type WhereUsedView } from '@nexus/factory-domain/sales/mtm/where-used'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * Where a measurement template is used, beyond counts (B-W2b-371, XF2:04): the styles measured with it and the open orders whose
 * made-to-measure units it serves (GET /product/measurement-templates/:id/where-used; orders only for a reader of orders, a rider
 * only for a reader of measurements). Checked against factory-domain's contract.
 */
export type { WhereUsedView }

export function readWhereUsed(api: ApiClient, templateId: string, signal?: AbortSignal): Promise<WhereUsedView> {
  return api.get(`/product/measurement-templates/${encodeURIComponent(templateId)}/where-used`, { schema: whereUsedView, signal })
}
