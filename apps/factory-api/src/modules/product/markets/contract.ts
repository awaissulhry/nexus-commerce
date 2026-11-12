import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import { setStyleMarketsBody, styleMarketsParams, styleMarketsView } from '@nexus/factory-domain/product/markets/contracts'

/** The style markets routes' contracts (B-W2b-283): the bodies and answers are factory-domain's product/markets/contracts. */

const markets = { 200: output({ markets: styleMarketsView }) }

export const readStyleMarketsContract = defineContract({ params: styleMarketsParams, response: markets })
export const setStyleMarketsContract = defineContract({ params: styleMarketsParams, body: setStyleMarketsBody, response: markets })
