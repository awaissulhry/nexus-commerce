import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { addSizesBody, createScaleBody, listScalesQuery, reorderSizesBody, scaleRow, scaleStatusBody, scaleView, updateScaleBody, updateSizeBody } from '@nexus/factory-domain/product/sizes/contracts'
import {
  colourwayBody,
  createRevisionBody,
  createStyleBody,
  generatedSkus,
  generateSkusBody,
  colourRow,
  listColoursQuery,
  listStylesQuery,
  revisionView,
  styleRow,
  styleStatusBody,
  styleView,
  updateColourwayBody,
  updateSkuBody,
  updateStyleBody,
} from '@nexus/factory-domain/product/styles/contracts'

/**
 * The style and size scale routes' contracts (A2 SCR-040, SCR-041, SCR-049): the bodies and answers are
 * factory-domain's product/styles/contracts and product/sizes/contracts. No money here.
 */

const one = { 200: output({ style: styleView }) }
const created = { 201: output({ style: styleView }) }
const style = input({ styleId: id() })
const scaleOne = { 200: output({ scale: scaleView }) }
const scale = input({ scaleId: id() })

export const listStylesContract = defineContract({
  querystring: listStylesQuery,
  response: { 200: output({ styles: z.array(styleRow), nextCursor: z.string().nullable(), count: z.number().int() }) },
})
export const getStyleContract = defineContract({ params: style, response: one })
export const createStyleContract = defineContract({ body: createStyleBody, response: created })
export const updateStyleContract = defineContract({ params: style, body: updateStyleBody, response: one })
export const styleStatusContract = defineContract({ params: style, body: styleStatusBody, response: one })

export const addColourwayContract = defineContract({ params: style, body: colourwayBody, response: created })
export const updateColourwayContract = defineContract({ params: input({ styleId: id(), colourwayId: id() }), body: updateColourwayBody, response: one })

export const generateSkusContract = defineContract({ params: style, body: generateSkusBody, response: { 200: generatedSkus } })
export const updateSkuContract = defineContract({ params: input({ styleId: id(), skuId: id() }), body: updateSkuBody, response: one })

export const listRevisionsContract = defineContract({ params: style, response: { 200: output({ revisions: z.array(revisionView) }) } })
export const createRevisionContract = defineContract({ params: style, body: createRevisionBody, response: { 201: output({ revision: revisionView }) } })

export const listColoursContract = defineContract({ querystring: listColoursQuery, response: { 200: output({ colours: z.array(colourRow) }) } })

export const listScalesContract = defineContract({
  querystring: listScalesQuery,
  response: { 200: output({ scales: z.array(scaleRow), nextCursor: z.string().nullable(), count: z.number().int() }) },
})
export const getScaleContract = defineContract({ params: scale, response: scaleOne })
export const createScaleContract = defineContract({ body: createScaleBody, response: { 201: output({ scale: scaleView }) } })
export const updateScaleContract = defineContract({ params: scale, body: updateScaleBody, response: scaleOne })
export const addSizesContract = defineContract({ params: scale, body: addSizesBody, response: { 201: output({ scale: scaleView }) } })
export const reorderSizesContract = defineContract({ params: scale, body: reorderSizesBody, response: scaleOne })
export const updateSizeContract = defineContract({ params: input({ scaleId: id(), sizeId: id() }), body: updateSizeBody, response: scaleOne })
export const scaleStatusContract = defineContract({ params: scale, body: scaleStatusBody, response: scaleOne })
