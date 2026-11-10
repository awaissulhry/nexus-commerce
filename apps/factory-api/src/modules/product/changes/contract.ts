import { z } from 'zod'
import { defineContract, id, output } from '@nexus/factory-domain/core/contracts'
import {
  addLineBody,
  approversBody,
  cancelBody,
  createOrderBody,
  createRequestBody,
  decideBody,
  draftRevisionBody,
  floorRequestBody,
  lineParams,
  moveRequestBody,
  orderList,
  orderListQuery,
  orderParams,
  orderRequestsBody,
  orderView,
  photoBody,
  photoParams,
  releaseOrderBody,
  removeLineQuery,
  requestList,
  requestListQuery,
  requestParams,
  requestView,
  updateLineBody,
  updateOrderBody,
  updateRequestBody,
  versionBody,
  workInProgressBody,
  workOrderChangesView,
  workOrderParams,
} from '@nexus/factory-domain/product/changes/contracts'
import { approverOptionsView, releasedList, releasedQuery } from '@nexus/factory-domain/product/changes/screens'
import { fileView, presignedView } from '../../../platform/files/contract'

/** The change requests' and change orders' contracts (B-W2b-226): the bodies and answers are factory-domain's product/changes/contracts. */

const request = { 200: output({ changeRequest: requestView }) }
const order = { 200: output({ changeOrder: orderView }) }

export const listRequestsContract = defineContract({ querystring: requestListQuery, response: { 200: requestList } })
export const readRequestContract = defineContract({ params: requestParams, response: request })
export const createRequestContract = defineContract({ body: createRequestBody, response: { 201: output({ changeRequest: requestView }) } })
export const updateRequestContract = defineContract({ params: requestParams, body: updateRequestBody, response: request })
export const moveRequestContract = defineContract({ params: requestParams, body: moveRequestBody, response: request })
export const workOrderChangesContract = defineContract({ params: workOrderParams, response: { 200: workOrderChangesView } })

export const floorRequestContract = defineContract({ body: floorRequestBody, response: { 201: output({ changeRequest: output({ id: id() }), replayed: z.boolean() }) } })
export const floorPhotoContract = defineContract({ params: requestParams, body: photoBody, response: { 201: output({ file: fileView, upload: presignedView }) } })
export const floorPhotoCompleteContract = defineContract({ params: photoParams, response: { 200: output({ file: fileView }) } })

export const listOrdersContract = defineContract({ querystring: orderListQuery, response: { 200: orderList } })
export const readOrderContract = defineContract({ params: orderParams, response: order })
export const createOrderContract = defineContract({ body: createOrderBody, response: { 201: output({ changeOrder: orderView }) } })
export const updateOrderContract = defineContract({ params: orderParams, body: updateOrderBody, response: order })
export const orderRequestsContract = defineContract({ params: orderParams, body: orderRequestsBody, response: order })
export const addLineContract = defineContract({ params: orderParams, body: addLineBody, response: order })
export const updateLineContract = defineContract({ params: lineParams, body: updateLineBody, response: order })
export const removeLineContract = defineContract({ params: lineParams, querystring: removeLineQuery, response: order })
export const workInProgressContract = defineContract({ params: orderParams, body: workInProgressBody, response: order })
export const approversContract = defineContract({ params: orderParams, body: approversBody, response: order })
export const draftRevisionContract = defineContract({ params: orderParams, body: draftRevisionBody, response: order })
export const submitContract = defineContract({ params: orderParams, body: versionBody, response: order })
export const decideContract = defineContract({ params: orderParams, body: decideBody, response: order })
export const cancelContract = defineContract({ params: orderParams, body: cancelBody, response: order })
export const releaseContract = defineContract({ params: orderParams, body: releaseOrderBody, response: order })

// B-W2b-244 (Changes & versions): the released versions list and the approver picker (./screens.ts).
export const releasedContract = defineContract({ querystring: releasedQuery, response: { 200: releasedList } })
export const approverOptionsContract = defineContract({ params: orderParams, response: { 200: approverOptionsView } })
