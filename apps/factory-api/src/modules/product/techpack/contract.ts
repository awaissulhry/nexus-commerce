import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { makePdfBody, scanParams, scanView, techPackPdfView, techPackQuery, techPackView, versionsView } from '@nexus/factory-domain/product/techpack/contracts'

/** The tech pack routes' contracts: the bodies and answers are factory-domain's product/techpack/contracts. */

const revision = input({ styleId: id(), revisionId: id() })

export const techPackContract = defineContract({ params: revision, querystring: techPackQuery, response: { 200: output({ techPack: techPackView }) } })
export const makePdfContract = defineContract({ params: revision, body: makePdfBody, response: { 200: output({ pdf: techPackPdfView }), 201: output({ pdf: techPackPdfView }) } })
export const versionsContract = defineContract({ params: revision, response: { 200: versionsView } })
/** One stored version's PDF (application/pdf, inline). */
export const versionPdfContract = defineContract({ params: input({ styleId: id(), revisionId: id(), documentId: id() }), response: {} })
export const scanContract = defineContract({ params: scanParams, response: { 200: output({ scan: scanView }) } })
