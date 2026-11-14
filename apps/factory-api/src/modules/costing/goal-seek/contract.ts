import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { goalSeekQuery, goalSeekView } from '@nexus/factory-domain/costing/goal-seek/contracts'

/** The route contract of the goal-seek: the shapes are factory-domain's costing/goal-seek/contracts. */

export const goalSeekContract = defineContract({ params: input({ sheetId: id() }), querystring: goalSeekQuery, response: { 200: goalSeekView } })
