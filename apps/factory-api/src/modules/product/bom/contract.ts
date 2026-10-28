import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  addLineBody,
  bomDiffView,
  bomView,
  compareQuery,
  copyRevisionBody,
  obsoleteBody,
  releaseBody,
  removeLineQuery,
  setColoursBody,
  setSizesBody,
  updateLineBody,
  updateRevisionBody,
} from '@nexus/factory-domain/product/bom/contracts'

/** The BOM routes' contracts (A2 SCR-042, SCR-046): the bodies and answers are factory-domain's product/bom/contracts. No money. */

const revision = input({ styleId: id(), revisionId: id() })
const line = input({ styleId: id(), revisionId: id(), lineId: id() })
const one = { 200: output({ bom: bomView }) }

export const getBomContract = defineContract({ params: revision, response: one })
export const updateRevisionContract = defineContract({ params: revision, body: updateRevisionBody, response: one })
export const addLineContract = defineContract({ params: revision, body: addLineBody, response: { 201: output({ bom: bomView }) } })
export const updateLineContract = defineContract({ params: line, body: updateLineBody, response: one })
export const removeLineContract = defineContract({ params: line, querystring: removeLineQuery, response: one })
export const setSizesContract = defineContract({ params: line, body: setSizesBody, response: one })
export const setColoursContract = defineContract({ params: line, body: setColoursBody, response: one })
export const copyRevisionContract = defineContract({ params: revision, body: copyRevisionBody, response: { 201: output({ bom: bomView }) } })
export const compareContract = defineContract({ params: input({ styleId: id() }), querystring: compareQuery, response: { 200: output({ diff: bomDiffView }) } })
export const releaseContract = defineContract({ params: revision, body: releaseBody, response: one })
export const obsoleteContract = defineContract({ params: revision, body: obsoleteBody, response: one })
