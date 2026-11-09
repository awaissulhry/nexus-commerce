import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import { privateLabelBody, privateLabelView, putTextBody, removeTextBody, styleLanguageParams, styleParams, textsQuery, textsView } from '@nexus/factory-domain/product/style-texts/contracts'

/** The texts and private-label routes' contracts (B-W2b-227): the bodies and answers are factory-domain's product/style-texts/contracts. */

const texts = { 200: output({ texts: textsView }) }
const privateLabel = { 200: output({ privateLabel: privateLabelView }) }

export const readTextsContract = defineContract({ params: styleParams, querystring: textsQuery, response: texts })
export const putTextContract = defineContract({ params: styleLanguageParams, body: putTextBody, response: texts })
export const removeTextContract = defineContract({ params: styleLanguageParams, body: removeTextBody, response: texts })
export const readPrivateLabelContract = defineContract({ params: styleParams, response: privateLabel })
export const setPrivateLabelContract = defineContract({ params: styleParams, body: privateLabelBody, response: privateLabel })
