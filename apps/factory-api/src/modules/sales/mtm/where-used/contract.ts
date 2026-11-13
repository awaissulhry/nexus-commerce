import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { whereUsedView } from '@nexus/factory-domain/sales/mtm/where-used'

/** Where a measurement template is used (B-W2b-371): the answer is factory-domain's sales/mtm/where-used. */
export const whereUsedContract = defineContract({ params: input({ templateId: id() }), response: { 200: whereUsedView } })
