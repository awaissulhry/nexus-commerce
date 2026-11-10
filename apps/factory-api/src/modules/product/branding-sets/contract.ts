import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { addSetFileBody, brandingSetsQuery, brandingSetsView, brandingSetView, createSetBody, setParams, setStatusBody, updateSetBody } from '@nexus/factory-domain/product/branding-sets/contracts'

/** The branding sets' routes' contracts (B-W2b-247): the bodies and answers are factory-domain's product/branding-sets/contracts. No money. */

const set = { 200: output({ set: brandingSetView }) }

/** A customer or brand a set may be started for, with the sets it has in use. */
const brandsView = output({
  brands: z.array(output({ id: id(), code: z.string(), name: z.string(), active: z.array(output({ id: id(), code: z.string(), name: z.string(), companyId: id() })) })),
})

export const listSetsContract = defineContract({ querystring: brandingSetsQuery, response: { 200: brandingSetsView } })
export const brandsContract = defineContract({ querystring: input({ q: z.string().trim().max(100).optional(), companyId: id().optional() }), response: { 200: brandsView } })
export const getSetContract = defineContract({ params: setParams, response: set })
export const createSetContract = defineContract({ body: createSetBody, response: { 201: output({ set: brandingSetView }) } })
export const updateSetContract = defineContract({ params: setParams, body: updateSetBody, response: set })
export const addSetFileContract = defineContract({ params: setParams, body: addSetFileBody, response: set })
export const setStatusContract = defineContract({ params: setParams, body: setStatusBody, response: set })
