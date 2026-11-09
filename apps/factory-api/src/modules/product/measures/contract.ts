import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  addSpecPointsBody,
  createPomBody,
  listPomsQuery,
  measurementSpecView,
  pomPictureBody,
  pomRow,
  pomStatusBody,
  pomVersionQuery,
  pomView,
  specCellsBody,
  specMoveBody,
  specPointsBody,
  startSpecBody,
  updatePomBody,
  updateSpecBody,
} from '@nexus/factory-domain/product/measures/contracts'
import { fileView, presignedView } from '../../../platform/files/contract'

/** The points of measure and the measurement spec's routes' contracts: the bodies and answers are factory-domain's product/measures/contracts. No money. */

const point = input({ pomId: id() })
const revision = input({ styleId: id(), revisionId: id() })
const spec = { 200: output({ spec: measurementSpecView }) }
const upload = output({ file: fileView, upload: presignedView })

export const listPomsContract = defineContract({ querystring: listPomsQuery, response: { 200: output({ points: z.array(pomRow), nextCursor: z.string().nullable(), count: z.number().int() }) } })
export const createPomContract = defineContract({ body: createPomBody, response: { 201: output({ point: pomView }) } })
export const getPomContract = defineContract({ params: point, response: { 200: output({ point: pomView }) } })
export const updatePomContract = defineContract({ params: point, body: updatePomBody, response: { 200: output({ point: pomView }) } })
export const pomStatusContract = defineContract({ body: pomStatusBody, response: { 200: output({ points: z.array(pomRow) }) } })
export const announcePictureContract = defineContract({ params: point, body: pomPictureBody, response: { 201: upload } })
export const completePictureContract = defineContract({
  params: input({ pomId: id(), fileId: id() }),
  response: { 200: output({ point: pomView, picture: output({ fileId: id(), status: z.string(), current: z.boolean() }) }) },
})
export const lookAtPictureContract = defineContract({ params: point, response: { 200: output({ download: presignedView }) } })
export const clearPictureContract = defineContract({ params: point, querystring: pomVersionQuery, response: { 200: output({ point: pomView }) } })

export const getSpecContract = defineContract({ params: revision, response: spec })
export const startSpecContract = defineContract({ params: revision, body: startSpecBody, response: { 201: output({ spec: measurementSpecView }) } })
export const updateSpecContract = defineContract({ params: revision, body: updateSpecBody, response: spec })
export const specCellsContract = defineContract({ params: revision, body: specCellsBody, response: spec })
export const addSpecPointsContract = defineContract({ params: revision, body: addSpecPointsBody, response: spec })
export const specPointsContract = defineContract({ params: revision, body: specPointsBody, response: spec })
export const specMoveContract = defineContract({ params: revision, body: specMoveBody, response: spec })
