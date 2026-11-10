import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { createPrepackBody, prepackStatusBody, prepackView, stylePrepacksView, updatePrepackBody } from '@nexus/factory-domain/product/prepacks/contracts'

/** The prepacks' routes' contracts: the bodies and answers are factory-domain's product/prepacks/contracts. No money. */

const prepack = input({ prepackId: id() })

export const getStylePrepacksContract = defineContract({ params: input({ styleId: id() }), response: { 200: output({ prepacks: stylePrepacksView }) } })
export const createPrepackContract = defineContract({ params: input({ styleId: id() }), body: createPrepackBody, response: { 201: output({ prepack: prepackView }) } })
export const getPrepackContract = defineContract({ params: prepack, response: { 200: output({ prepack: prepackView }) } })
export const updatePrepackContract = defineContract({ params: prepack, body: updatePrepackBody, response: { 200: output({ prepack: prepackView }) } })
export const prepackStatusContract = defineContract({ body: prepackStatusBody, response: { 200: output({ prepacks: z.array(prepackView) }) } })
