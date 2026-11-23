import { defineContract } from '@nexus/factory-domain/core/contracts'
import { beforeOrderCountsAnswer, beforeOrderCountsQuery } from '@nexus/factory-domain/sales/before-order/contracts'

/** B-CQ-002: GET /sales/before-order/counts (factory-domain sales/before-order/contracts: the shape the web reads too). */
export const beforeOrderCountsContract = defineContract({
  querystring: beforeOrderCountsQuery,
  response: { 200: beforeOrderCountsAnswer },
})
