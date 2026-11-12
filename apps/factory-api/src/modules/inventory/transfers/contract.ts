import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import {
  addLineBody,
  cancelBody,
  createBody,
  ddtPdfBody,
  lineParams,
  listQuery,
  oneTransfer,
  receiveBody,
  removeLineBody,
  settleBody,
  shipAnswer,
  shipBody,
  stockList,
  stockQuery,
  transferList,
  transferOptions,
  transferParams,
  updateBody,
  updateLineBody,
} from '@nexus/factory-domain/inventory/transfers/contracts'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * Transfers between sites (B-W2b-326): the route contracts, on factory-domain inventory/transfers/contracts (which the web
 * reads too). No money, no person's figure.
 */

export const listContract = defineContract({ querystring: listQuery, response: { 200: transferList } })
export const optionsContract = defineContract({ response: { 200: transferOptions } })
export const createContract = defineContract({ body: createBody, response: { 201: oneTransfer } })
export const recordContract = defineContract({ params: transferParams, response: { 200: oneTransfer } })
export const updateContract = defineContract({ params: transferParams, body: updateBody, response: { 200: oneTransfer } })
export const stockContract = defineContract({ params: transferParams, querystring: stockQuery, response: { 200: stockList } })
export const addLineContract = defineContract({ params: transferParams, body: addLineBody, response: { 201: oneTransfer } })
export const updateLineContract = defineContract({ params: lineParams, body: updateLineBody, response: { 200: oneTransfer } })
export const removeLineContract = defineContract({ params: lineParams, body: removeLineBody, response: { 200: oneTransfer } })
export const shipContract = defineContract({ params: transferParams, body: shipBody, response: { 200: shipAnswer } })
export const receiveContract = defineContract({ params: transferParams, body: receiveBody, response: { 200: oneTransfer } })
export const settleContract = defineContract({ params: lineParams, body: settleBody, response: { 200: oneTransfer } })
export const cancelContract = defineContract({ params: transferParams, body: cancelBody, response: { 200: oneTransfer } })
export const ddtDownloadContract = defineContract({ params: transferParams, response: { 200: output({ file: fileView, download: presignedView }) } })
export const ddtPrintContract = defineContract({ params: transferParams, body: ddtPdfBody, response: { 200: output({ file: fileView }), 201: output({ file: fileView }) } })
