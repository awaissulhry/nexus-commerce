import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { addStepsBody, compareRoutingQuery, copyStepsBody, removeStepQuery, reorderStepsBody, routingDiffView, routingView, updateStepBody } from '@nexus/factory-domain/product/routing/contracts'

/** The routing routes' contracts (A2 SCR-043): the bodies and answers are factory-domain's product/routing/contracts. No money. */

const revision = input({ styleId: id(), revisionId: id() })
const step = input({ styleId: id(), revisionId: id(), stepId: id() })
const one = { 200: output({ routing: routingView }) }

export const getRoutingContract = defineContract({ params: revision, response: one })
export const addStepsContract = defineContract({ params: revision, body: addStepsBody, response: { 201: output({ routing: routingView }) } })
export const updateStepContract = defineContract({ params: step, body: updateStepBody, response: one })
export const removeStepContract = defineContract({ params: step, querystring: removeStepQuery, response: one })
export const reorderStepsContract = defineContract({ params: revision, body: reorderStepsBody, response: one })
export const copyStepsContract = defineContract({ params: revision, body: copyStepsBody, response: one })
export const compareRoutingContract = defineContract({ params: input({ styleId: id() }), querystring: compareRoutingQuery, response: { 200: output({ diff: routingDiffView }) } })
