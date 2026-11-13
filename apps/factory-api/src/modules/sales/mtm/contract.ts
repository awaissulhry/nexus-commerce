import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  documentUnitsView,
  mtmLineBody,
  mtmLineEditBody,
  newProfileBody,
  newRevisionBody,
  outOfChartBody,
  profileRecordView,
  profilesQuery,
  profilesView,
  recordedView,
  repeatBody,
  repeatView,
  reviewBody,
  reviewedView,
  worksheetBody,
  worksheetVersionView,
} from '@nexus/factory-domain/sales/mtm/contracts'
import { quoteView } from '../quotes/contract'

/**
 * The made-to-measure office's contracts (B-W2b-358): the bodies and answers are factory-domain's sales/mtm/contracts; the quote
 * line routes (quotes/routes.ts, one block) answer the quote as W1's line routes do. Money: only a quote line's typed price.
 */

const profile = input({ profileId: id() })

export const listProfilesContract = defineContract({ querystring: profilesQuery, response: { 200: profilesView } })
export const getProfileContract = defineContract({ params: profile, response: { 200: output({ profile: profileRecordView }) } })
export const newProfileContract = defineContract({ body: newProfileBody, response: { 201: recordedView } })
export const newRevisionContract = defineContract({ params: profile, body: newRevisionBody, response: { 201: recordedView } })
export const reviewContract = defineContract({ params: profile, body: reviewBody, response: { 200: reviewedView } })
export const repeatReadContract = defineContract({ params: profile, response: { 200: output({ repeat: repeatView }) } })
export const repeatContract = defineContract({ params: profile, body: repeatBody, response: { 201: output({ quote: quoteView, lineId: id() }) } })
export const listWorksheetsContract = defineContract({ params: profile, response: { 200: output({ worksheets: z.array(worksheetVersionView) }) } })
export const makeWorksheetContract = defineContract({
  params: profile,
  body: worksheetBody,
  response: { 200: output({ worksheet: output({ id: id(), version: z.number().int(), fileId: id(), made: z.boolean() }), worksheets: z.array(worksheetVersionView) }) },
})
export const openWorksheetContract = defineContract({
  params: input({ profileId: id(), documentId: id() }),
  response: { 200: output({ worksheet: output({ id: id(), version: z.number().int(), fileId: id() }), download: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }) }) },
})
export const orderUnitsContract = defineContract({ params: input({ orderId: id() }), response: { 200: output({ made: documentUnitsView }) } })

// ---- the quote's made-to-measure lines (routes in quotes/routes.ts) -----------------------------------------------------

const quoteParams = input({ quoteId: id() })
const lineParams = input({ quoteId: id(), lineId: id() })
const one = output({ quote: quoteView })

export const mtmLineContract = defineContract({ params: quoteParams, body: mtmLineBody, response: { 201: one } })
export const mtmLineEditContract = defineContract({ params: lineParams, body: mtmLineEditBody, response: { 200: one } })
export const outOfChartContract = defineContract({ params: lineParams, body: outOfChartBody, response: { 201: one } })
export const quoteUnitsContract = defineContract({ params: quoteParams, response: { 200: output({ made: documentUnitsView }) } })
