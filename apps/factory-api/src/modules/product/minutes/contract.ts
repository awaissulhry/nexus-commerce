import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  approveBody,
  operationMinutesView,
  proposeBody,
  rejectBody,
  routingTimesQuery,
  routingTimesView,
  stepMinutesBody,
  waitingQuery,
  waitingView,
} from '@nexus/factory-domain/product/minutes/contracts'

/** SMV governance and the routing's times (B-W2b-215): the bodies and answers are factory-domain's product/minutes/contracts. No money. */

const operation = input({ operationId: id() })
const version = input({ operationId: id(), versionId: id() })
const revision = input({ styleId: id(), revisionId: id() })
const step = input({ styleId: id(), revisionId: id(), stepId: id() })

export const getOperationMinutesContract = defineContract({ params: operation, response: { 200: output({ minutes: operationMinutesView }) } })
export const proposeContract = defineContract({ params: operation, body: proposeBody, response: { 201: output({ minutes: operationMinutesView, versionId: id() }) } })
export const approveContract = defineContract({ params: version, body: approveBody, response: { 200: output({ minutes: operationMinutesView, tookEffect: z.boolean() }) } })
export const rejectContract = defineContract({ params: version, body: rejectBody, response: { 200: output({ minutes: operationMinutesView }) } })
export const waitingContract = defineContract({ querystring: waitingQuery, response: { 200: waitingView } })
export const routingTimesContract = defineContract({ params: revision, querystring: routingTimesQuery, response: { 200: output({ times: routingTimesView }) } })
export const stepMinutesContract = defineContract({ params: step, body: stepMinutesBody, response: { 200: output({ times: routingTimesView }) } })
