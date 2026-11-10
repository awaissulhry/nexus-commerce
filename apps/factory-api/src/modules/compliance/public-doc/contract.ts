import { z } from 'zod'
import { addressQuery, addressView, lookupBody, publicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'

/**
 * The public DoC's routes (B-W2b-166; factory-domain compliance/public-doc/contracts.ts): the lookup a page makes for its
 * code, the PDFs it shows, and the office's address of a style or a batch. Codes, numbers and days only; no price, no person.
 */

export const lookupContract = defineContract({ body: lookupBody, response: { 200: output({ page: publicDocPage }) } })

/** The PDF's bytes (application/pdf), inline; `?download=1` saves it under its own name. */
export const fileContract = defineContract({
  params: input({ code: z.string().min(1).max(64), fileId: id() }),
  querystring: input({ download: z.enum(['0', '1']).optional() }),
  response: {},
})

/** B-W2b-236 (SY3:03): the main picture's stripped copy (its own type), inline. */
export const pictureContract = defineContract({ params: input({ code: z.string().min(1).max(64), fileId: id() }), response: {} })

export const addressContract = defineContract({ querystring: addressQuery, response: { 200: output({ address: addressView }) } })
