import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { orderDocumentsView } from '@nexus/factory-domain/costing/profitability/contracts'

/** The route contract of the order profitability report's documents: the shape is factory-domain's costing/profitability/contracts. */

export const orderDocumentsContract = defineContract({ params: input({ orderId: id() }), response: { 200: orderDocumentsView } })
