import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { rollupQuery, rollupView } from '@nexus/factory-domain/costing/rollup/contracts'

/** The route contract of the multi-level roll-up: the shapes are factory-domain's costing/rollup/contracts (costs money.cost). */
export const rollupContract = defineContract({ params: input({ styleId: id(), revisionId: id() }), querystring: rollupQuery, response: { 200: rollupView } })
