import { defineContract } from '@nexus/factory-domain/core/contracts'
import { mtmCostBody, mtmCostView } from '@nexus/factory-domain/costing/mtm-cost/contracts'

/** The route contract of a made-to-measure unit's cost: the shapes are factory-domain's costing/mtm-cost/contracts (costs money.cost). */
export const mtmCostContract = defineContract({ body: mtmCostBody, response: { 200: mtmCostView } })
