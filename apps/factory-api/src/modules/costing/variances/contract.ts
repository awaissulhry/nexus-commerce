import { defineContract } from '@nexus/factory-domain/core/contracts'
import { variancesAnswer, variancesQuery } from '@nexus/factory-domain/costing/variances/contracts'

/** The route contract of the variances per work order (B-W2b-411; FIN-030): factory-domain's costing/variances shapes. */
export const variancesContract = defineContract({ querystring: variancesQuery, response: { 200: variancesAnswer } })
