import { z } from 'zod'
import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import {
  createTemplateBody,
  fromQuoteBody,
  leftOutView,
  replaceLinesBody,
  startQuoteBody,
  templateAnswer,
  templateListQuery,
  templateListView,
  templateParams,
  templateVersionBody,
  updateTemplateBody,
} from '@nexus/factory-domain/sales/quote-templates/contracts'
import { quoteView } from '../quotes/contract'

/** Quote templates' contracts (B-W2b-294): the bodies and answers are factory-domain's sales/quote-templates/contracts. */

const answer = { 200: templateAnswer }

export const listTemplatesContract = defineContract({ querystring: templateListQuery, response: { 200: templateListView } })
export const getTemplateContract = defineContract({ params: templateParams, response: answer })
export const createTemplateContract = defineContract({ body: createTemplateBody, response: { 201: templateAnswer } })
export const updateTemplateContract = defineContract({ params: templateParams, body: updateTemplateBody, response: answer })
export const replaceLinesContract = defineContract({ params: templateParams, body: replaceLinesBody, response: answer })
export const archiveTemplateContract = defineContract({ params: templateParams, body: templateVersionBody, response: answer })
export const restoreTemplateContract = defineContract({ params: templateParams, body: templateVersionBody, response: answer })
export const fromQuoteContract = defineContract({ body: fromQuoteBody, response: { 201: templateAnswer } })
export const startQuoteContract = defineContract({
  params: templateParams,
  body: startQuoteBody,
  response: {
    201: output({
      quote: quoteView,
      /** What the template had that the quote did not take, in words (a line without its colourway or pieces, a fee line, a size not offered, a refused line). */
      leftOut: z.array(leftOutView),
      warnings: z.array(z.string()),
    }),
  },
})
