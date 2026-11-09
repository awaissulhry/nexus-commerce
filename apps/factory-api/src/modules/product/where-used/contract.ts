import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import { styleParams, whereUsedView } from '@nexus/factory-domain/product/where-used/contracts'

/** The where-used route's contract (B-W2b-227): factory-domain's product/where-used/contracts. */
export const whereUsedContract = defineContract({ params: styleParams, response: { 200: output({ whereUsed: whereUsedView }) } })
