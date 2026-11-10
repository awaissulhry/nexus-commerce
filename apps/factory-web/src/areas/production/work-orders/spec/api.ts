import { z } from 'zod'
import { workOrderChangesView } from '@nexus/factory-domain/product/changes/contracts'
import { workOrderSpecView, type WorkOrderSpecView } from '@nexus/factory-domain/product/versions/contracts'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The work order's spec against the master (B-W2b-220) and its change requests (B-W2b-226), each answer checked against
 * factory-domain's contracts. The compare (Spec differences) and raising a request are Changes & versions' calls
 * (areas/products/changes/api.ts: readCompare, createRequest), never copied here.
 */

export type { WorkOrderSpecView }
export type WorkOrderChangesView = z.infer<typeof workOrderChangesView>

const enc = encodeURIComponent

/** The work order's revision, the released one now, whether a newer spec is due (and what was decided), how they differ. */
export function readWorkOrderSpec(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderSpecView> {
  return api.get(`/production/work-orders/${enc(workOrderId)}/spec/versions`, { schema: z.object({ spec: workOrderSpecView }), signal }).then((answer) => answer.spec)
}

/** The "Change request" pop-up (MES-006): what of the work order is made, and the requests already about it. */
export function readWorkOrderChanges(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderChangesView> {
  return api.get(`/product/change-requests/work-orders/${enc(workOrderId)}`, { schema: workOrderChangesView, signal })
}
