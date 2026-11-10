import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  addAlternateBody,
  bomDepthView,
  changeSupplyBody,
  orderAlternatesBody,
  removeAlternateQuery,
  setOutputBody,
  setSupplyBody,
  updateAlternateBody,
} from '@nexus/factory-domain/product/bom-lines/contracts'

/** The routes of BOM lines in depth: the bodies and answers are factory-domain's product/bom-lines/contracts. No money. */

const revision = input({ styleId: id(), revisionId: id() })
const line = input({ styleId: id(), revisionId: id(), lineId: id() })
const alternate = input({ styleId: id(), revisionId: id(), lineId: id(), alternateId: id() })
const depth = { 200: output({ depth: bomDepthView }) }

export const getDepthContract = defineContract({ params: revision, response: depth })
export const addAlternateContract = defineContract({ params: line, body: addAlternateBody, response: { 201: output({ depth: bomDepthView }) } })
export const updateAlternateContract = defineContract({ params: alternate, body: updateAlternateBody, response: depth })
export const removeAlternateContract = defineContract({ params: alternate, querystring: removeAlternateQuery, response: depth })
export const orderAlternatesContract = defineContract({ params: line, body: orderAlternatesBody, response: depth })
export const setSupplyContract = defineContract({ params: line, body: setSupplyBody, response: depth })
export const changeSupplyContract = defineContract({ params: revision, body: changeSupplyBody, response: depth })
export const setOutputContract = defineContract({ params: revision, body: setOutputBody, response: depth })
