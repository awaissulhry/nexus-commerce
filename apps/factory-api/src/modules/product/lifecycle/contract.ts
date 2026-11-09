import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import { lifecycleView, moveLifecycleBody, replacementBody, styleParams } from '@nexus/factory-domain/product/lifecycle/contracts'

/** The lifecycle routes' contracts (B-W2b-221): the bodies and answers are factory-domain's product/lifecycle/contracts. */

const one = { 200: output({ lifecycle: lifecycleView }) }

export const readLifecycleContract = defineContract({ params: styleParams, response: one })
export const moveLifecycleContract = defineContract({ params: styleParams, body: moveLifecycleBody, response: one })
export const replacementContract = defineContract({ params: styleParams, body: replacementBody, response: one })
