import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { bomLineScaleBody, bomLineScaleView, mtmCheckBody, mtmCheckView, putRulesBody, switchRulesBody, templateRulesView } from '@nexus/factory-domain/product/mtm-rules/contracts'

/** Made-to-measure rules' contracts: the bodies and answers are factory-domain's product/mtm-rules/contracts. No money. */

const template = input({ templateId: id() })
const rules = { 200: output({ rules: templateRulesView }) }

export const getRulesContract = defineContract({ params: template, response: rules })
export const putRulesContract = defineContract({ params: template, body: putRulesBody, response: rules })
export const switchRulesContract = defineContract({ params: template, body: switchRulesBody, response: rules })
export const checkContract = defineContract({ body: mtmCheckBody, response: { 200: output({ check: mtmCheckView }) } })
export const lineScaleContract = defineContract({ params: input({ styleId: id(), revisionId: id(), lineId: id() }), body: bomLineScaleBody, response: { 200: bomLineScaleView } })
