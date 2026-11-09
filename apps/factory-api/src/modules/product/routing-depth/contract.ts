import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  effectivityQuery,
  effectivityView,
  floorSettingsView,
  librarySettingsBody,
  librarySettingsView,
  routingDepthView,
  stepCheckpointBody,
  stepSettingsBody,
  stepVariantsBody,
  workOrderRoutingView,
} from '@nexus/factory-domain/product/routing-depth/contracts'

/** A routing in depth (B-W2b-225): the bodies and answers are factory-domain's product/routing-depth/contracts. No money. */

const revision = input({ styleId: id(), revisionId: id() })
const step = input({ styleId: id(), revisionId: id(), stepId: id() })
const depth = { 200: output({ routing: routingDepthView }) }
const settings = { 200: output({ operation: librarySettingsView }) }

export const getDepthContract = defineContract({ params: revision, response: depth })
export const stepVariantsContract = defineContract({ params: step, body: stepVariantsBody, response: depth })
export const stepCheckpointContract = defineContract({ params: step, body: stepCheckpointBody, response: depth })
export const stepSettingsContract = defineContract({ params: step, body: stepSettingsBody, response: depth })
export const effectivityContract = defineContract({ params: input({ styleId: id() }), querystring: effectivityQuery, response: { 200: output({ effectivity: effectivityView }) } })
export const getLibrarySettingsContract = defineContract({ params: input({ operationId: id() }), response: settings })
export const setLibrarySettingsContract = defineContract({ params: input({ operationId: id() }), body: librarySettingsBody, response: settings })
export const workOrderRoutingContract = defineContract({ params: input({ workOrderId: id() }), response: { 200: output({ routing: workOrderRoutingView }) } })
export const floorSettingsContract = defineContract({ params: input({ workOrderId: id(), operationId: id() }), response: { 200: output({ settings: floorSettingsView }) } })
