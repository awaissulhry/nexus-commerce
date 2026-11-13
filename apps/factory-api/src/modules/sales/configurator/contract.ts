
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  artworkBody,
  checkLineBody,
  checkLineView,
  configuratorStyleView,
  lineConfiguratorView,
  orderLineParams,
  quoteLineParams,
  saveOrderOptionsBody,
  saveQuoteOptionsBody,
  styleParams,
} from '@nexus/factory-domain/sales/configurator/contracts'
import { fileView, presignedView } from '../../../platform/files/contract'
import { quoteView } from '../quotes/contract'

/**
 * The configurator's contracts (B-W2b-340): the shapes are factory-domain sales/configurator/contracts (money marked by grain:
 * a caller without the grain gets no figure, and a request that sends one is refused). A quote write answers the quote (the
 * record follows it) and the line's configurator; an order write the line's configurator (the order's version moved).
 */

export const styleConfiguratorContract = defineContract({ params: styleParams, querystring: input({ colourwayId: id().optional() }), response: { 200: configuratorStyleView } })

export const quoteLineConfiguratorContract = defineContract({ params: quoteLineParams, response: { 200: lineConfiguratorView } })
export const checkQuoteLineContract = defineContract({ params: quoteLineParams, body: checkLineBody, response: { 200: checkLineView } })
export const saveQuoteOptionsContract = defineContract({ params: quoteLineParams, body: saveQuoteOptionsBody, response: { 200: output({ quote: quoteView, line: lineConfiguratorView }) } })
export const quoteArtworkContract = defineContract({ params: quoteLineParams, body: artworkBody, response: { 201: output({ file: fileView, upload: presignedView }) } })

export const orderLineConfiguratorContract = defineContract({ params: orderLineParams, response: { 200: lineConfiguratorView } })
export const checkOrderLineContract = defineContract({ params: orderLineParams, body: checkLineBody, response: { 200: checkLineView } })
export const saveOrderOptionsContract = defineContract({ params: orderLineParams, body: saveOrderOptionsBody, response: { 200: output({ line: lineConfiguratorView }) } })
export const orderArtworkContract = defineContract({ params: orderLineParams, body: artworkBody, response: { 201: output({ file: fileView, upload: presignedView }) } })

