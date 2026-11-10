import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { addPlacementBody, orderPlacementsBody, protectorPlacementView, removePlacementsBody, updatePlacementBody } from '@nexus/factory-domain/product/protectors/contracts'

/** Protector placement's routes' contracts: the bodies and answers are factory-domain's product/protectors/contracts. No money. */

const revision = input({ styleId: id(), revisionId: id() })
const answer = { 200: output({ protectors: protectorPlacementView }) }

export const getPlacementsContract = defineContract({ params: revision, response: answer })
export const addPlacementContract = defineContract({ params: revision, body: addPlacementBody, response: { 201: output({ protectors: protectorPlacementView }) } })
export const updatePlacementContract = defineContract({ params: input({ styleId: id(), revisionId: id(), placementId: id() }), body: updatePlacementBody, response: answer })
export const removePlacementsContract = defineContract({ params: revision, body: removePlacementsBody, response: answer })
export const orderPlacementsContract = defineContract({ params: revision, body: orderPlacementsBody, response: answer })
