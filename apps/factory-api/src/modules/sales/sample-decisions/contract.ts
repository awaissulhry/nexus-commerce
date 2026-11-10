import { z } from 'zod'
import { defineContract, id, output } from '@nexus/factory-domain/core/contracts'
import {
  approvalView,
  commentBody,
  commentParams,
  commentView,
  createSwatchBody,
  decisionBody,
  fitSaveBody,
  fitView,
  nextRoundBody,
  roundParams,
  swatchList,
  swatchListQuery,
  swatchParams,
  swatchView,
  testResultBody,
  updateCommentBody,
  updateSwatchBody,
  versionQuery,
} from '@nexus/factory-domain/sales/sample-decisions/contracts'
import { roundView } from '@nexus/factory-domain/sales/samples/contracts'

/** Sample decisions' contracts (B-W2b-252): the bodies and answers are factory-domain's sales/sample-decisions/contracts. */

const approval = { 200: approvalView }
const removed = { 200: output({ id: id(), removed: z.literal(true) }) }

export const readApprovalContract = defineContract({ params: roundParams, response: approval })
export const decideRoundContract = defineContract({ params: roundParams, body: decisionBody, response: approval })
export const nextRoundContract = defineContract({ params: roundParams, body: nextRoundBody, response: { 201: output({ round: roundView }) } })
export const testResultContract = defineContract({ params: roundParams, body: testResultBody, response: approval })
export const readFitContract = defineContract({ params: roundParams, response: { 200: fitView } })
export const saveFitContract = defineContract({ params: roundParams, body: fitSaveBody, response: { 200: fitView } })
export const addCommentContract = defineContract({ params: roundParams, body: commentBody, response: { 201: output({ comment: commentView }) } })
export const updateCommentContract = defineContract({ params: commentParams, body: updateCommentBody, response: { 200: output({ comment: commentView }) } })
export const removeCommentContract = defineContract({ params: commentParams, querystring: versionQuery, response: removed })
export const listSwatchesContract = defineContract({ querystring: swatchListQuery, response: { 200: swatchList } })
export const createSwatchContract = defineContract({ body: createSwatchBody, response: { 201: output({ swatch: swatchView }) } })
export const updateSwatchContract = defineContract({ params: swatchParams, body: updateSwatchBody, response: { 200: output({ swatch: swatchView }) } })
export const removeSwatchContract = defineContract({ params: swatchParams, querystring: versionQuery, response: removed })
export const decideSwatchContract = defineContract({ params: swatchParams, body: decisionBody, response: { 200: output({ swatch: swatchView }) } })
