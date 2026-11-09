import { z } from 'zod'
import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import { createTypeBody, listTypesQuery, setStyleTypeBody, styleTypeParams, styleTypeView, typeParams, typeStatusBody, typeView, updateTypeBody } from '@nexus/factory-domain/product/types/contracts'

/** The product types' contracts (B-W2b-221): factory-domain's product/types/contracts. */

const one = { 200: output({ type: typeView }) }

export const listTypesContract = defineContract({ querystring: listTypesQuery, response: { 200: output({ types: z.array(typeView) }) } })
export const getTypeContract = defineContract({ params: typeParams, response: one })
export const createTypeContract = defineContract({ body: createTypeBody, response: { 201: output({ type: typeView }) } })
export const updateTypeContract = defineContract({ params: typeParams, body: updateTypeBody, response: one })
export const typeStatusContract = defineContract({ params: typeParams, body: typeStatusBody, response: one })
export const readStyleTypeContract = defineContract({ params: styleTypeParams, response: { 200: output({ styleType: styleTypeView }) } })
export const setStyleTypeContract = defineContract({ params: styleTypeParams, body: setStyleTypeBody, response: { 200: output({ styleType: styleTypeView }) } })
