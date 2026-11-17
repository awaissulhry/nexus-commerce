import { defineContract } from '@nexus/factory-domain/core/contracts'
import { incomingList, incomingListQuery } from '@nexus/factory-domain/sales/incoming/contracts'

/** Sales › Incoming's contracts (B-TH-039): factory-domain's sales/incoming/contracts. */
export const listIncomingContract = defineContract({ querystring: incomingListQuery, response: { 200: incomingList } })
