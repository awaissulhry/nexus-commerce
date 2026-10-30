import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import {
  colourBody,
  createMaterialBody,
  listMaterialsQuery,
  materialRow,
  materialView,
  standardCostBody,
  statusBody,
  updateColourBody,
  updateMaterialBody,
} from '@nexus/factory-domain/product/materials/contracts'

/**
 * The material routes' contracts (A2 SCR-047, SCR-048): the bodies and answers are factory-domain's
 * product/materials/contracts; the standard cost and the per-unit costs are marked money.cost there.
 */

const one = { 200: output({ material: materialView }) }
const material = input({ materialId: id() })
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')

/**
 * The list's filters: factory-domain's, plus the two the Materials & trims tiles count (SCR-047): PPE components
 * (`ppeComponent`), and the materials without a standard purchase price (`missingCost`: a yes/no filter, not an amount —
 * notMoney — that listMaterials refuses to a caller without the cost grain, since the answer tells which have a price).
 */
export const listMaterialsFilters = listMaterialsQuery.extend({ ppeComponent: flag().optional(), missingCost: notMoney(flag().optional()) })
export type ListMaterialsFilters = z.output<typeof listMaterialsFilters>

export const listMaterialsContract = defineContract({
  querystring: listMaterialsFilters,
  response: { 200: output({ materials: z.array(materialRow), nextCursor: z.string().nullable(), count: z.number().int() }) },
})

export const getMaterialContract = defineContract({ params: material, response: one })

export const createMaterialContract = defineContract({ body: createMaterialBody, response: { 201: output({ material: materialView }) } })

export const updateMaterialContract = defineContract({ params: material, body: updateMaterialBody, response: one })

export const archiveMaterialContract = defineContract({ params: material, body: statusBody, response: one })

export const reactivateMaterialContract = defineContract({ params: material, body: statusBody, response: one })

export const standardCostContract = defineContract({ params: material, body: standardCostBody, response: one })

export const addColourContract = defineContract({ params: material, body: colourBody, response: { 201: output({ material: materialView }) } })

export const updateColourContract = defineContract({ params: input({ materialId: id(), colourId: id() }), body: updateColourBody, response: one })
