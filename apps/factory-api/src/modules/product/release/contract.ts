import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { gateQuery, gateView, releasedScopeView, setScopeBody, summaryQuery, summaryView } from '@nexus/factory-domain/product/release/contracts'

/** The release gate routes' contracts: the bodies and answers are factory-domain's product/release/contracts. No money. */

const revision = input({ styleId: id(), revisionId: id() })

export const getGateContract = defineContract({ params: revision, querystring: gateQuery, response: { 200: output({ gate: gateView }) } })
export const setScopeContract = defineContract({ params: revision, body: setScopeBody, response: { 200: output({ gate: gateView }) } })
export const releasedScopeContract = defineContract({ params: input({ styleId: id() }), response: { 200: output({ released: releasedScopeView }) } })
export const summaryContract = defineContract({ querystring: summaryQuery, response: { 200: summaryView } })
