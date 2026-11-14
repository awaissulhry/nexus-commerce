import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { closeCheckView, closeRecordView, reopenBody, undoBody, workOrderClosesView } from '@nexus/factory-domain/costing/close/contracts'
import { scrapReworkView } from '@nexus/factory-domain/costing/variances/contracts'
import { workOrderSchema } from '../../production/work-orders/contract'

/**
 * The route contracts of the work order close (B-W2b-411): factory-domain's costing/close and costing/variances shapes. The
 * close itself is POST /production/work-orders/:workOrderId/close (modules/production/work-orders/close.ts).
 */

const params = input({ workOrderId: id() })
const takenBack = output({ workOrder: workOrderSchema, close: closeRecordView })

export const closeCheckContract = defineContract({ params, response: { 200: closeCheckView } })
export const undoContract = defineContract({ params, body: undoBody, response: { 200: takenBack } })
export const reopenContract = defineContract({ params, body: reopenBody, response: { 200: takenBack } })
export const closesContract = defineContract({ params, response: { 200: workOrderClosesView } })
export const scrapReworkContract = defineContract({ params, response: { 200: scrapReworkView } })
