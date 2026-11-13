import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { SIZE_CURVE_LIMITS } from '@nexus/factory-domain/sales/size-curves/rules'

/** Size curves (B-W2b-302; SAL-269): shares in percent per size code of the scale ("40.0000"), totalling exactly 100. No money. */

const shares = z.record(z.string().trim().min(1).max(40), z.string().trim().max(12))
const status = z.enum(['ACTIVE', 'ARCHIVED'])

export const curveView = output({
  id: id(),
  companyId: id().nullable(),
  company: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  sizeScale: output({ id: id(), code: z.string(), name: z.string(), sizes: z.array(z.string()) }),
  name: z.string(),
  /** Size code → percent (4 places), in the scale's order. */
  shares: z.record(z.string(), z.string()),
  /** "50 20 % · 52 40 % · 54 25 %". */
  words: z.string(),
  status,
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

const one = { 200: output({ curve: curveView }) }

export const listCurvesContract = defineContract({
  querystring: input({ companyId: id().optional(), sizeScaleId: id().optional(), status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE') }),
  response: { 200: output({ curves: z.array(curveView) }) },
})

export const getCurveContract = defineContract({ params: input({ curveId: id() }), response: one })

export const createCurveContract = defineContract({
  body: input({
    /** The company whose curve it is; null or left out: every company (a grant over every company). */
    companyId: id().nullish(),
    sizeScaleId: id(),
    name: z.string().max(SIZE_CURVE_LIMITS.name + 20),
    shares,
  }),
  response: { 201: output({ curve: curveView }) },
})

export const updateCurveContract = defineContract({
  params: input({ curveId: id() }),
  body: input({ version: z.number().int().min(1), name: z.string().max(SIZE_CURVE_LIMITS.name + 20).optional(), shares: shares.optional() }),
  response: one,
})

export const curveStatusContract = defineContract({
  body: input({ curves: z.array(input({ id: id(), version: z.number().int().min(1) })).min(1).max(100), status }),
  response: { 200: output({ curves: z.array(curveView) }) },
})
