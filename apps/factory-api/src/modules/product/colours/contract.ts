import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  colourCountsView,
  colourLibraryQuery,
  colourLibraryRow,
  colourLibraryView,
  colourParams,
  colourStatusBody,
  createColourBody,
  updateColourBody,
} from '@nexus/factory-domain/product/colours/contracts'

/** The colour library's routes' contracts (B-W2b-247): the bodies and answers are factory-domain's product/colours/contracts. No money. */

const colour = { 200: output({ colour: colourLibraryRow }) }

export const listLibraryContract = defineContract({ querystring: colourLibraryQuery, response: { 200: colourLibraryView } })
export const countsContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: colourCountsView } })
export const createColourContract = defineContract({ body: createColourBody, response: { 201: output({ colour: colourLibraryRow }) } })
export const updateColourContract = defineContract({ params: colourParams, body: updateColourBody, response: colour })
export const colourStatusContract = defineContract({ params: colourParams, body: colourStatusBody, response: colour })
/** A colour's photo or a branding set's picture (its own type), inline. */
export const libraryPictureContract = defineContract({ params: input({ fileId: id() }), response: {} })
