import { z } from 'zod'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * A hide's grade, shade group, thickness, defects and measures (B-W2b-94's routes; design warehouse.hides record tabs
 * "Measurements & grade" and "Defects & photos"), with the answer's shape checked (zod; unknown fields dropped). The shapes
 * mirror apps/factory-api modules/inventory/hides/contract.ts (gradingView, measuresContract, recordMeasureContract). The
 * API's English (`readOnly`, `measureRefusal`, refusal messages) is never drawn: the screens say their own words from the
 * hide's state and the refusal's path.
 */

const seg = (value: string) => encodeURIComponent(value)

export const AREA_UNITS = ['M2', 'DM2', 'FT2'] as const
const areaUom = z.enum(AREA_UNITS)
export type AreaUnit = z.infer<typeof areaUom>
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const shareSource = z.enum(['RULE', 'GRADE'])
const gradeRef = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() })
const HIDE_STATES = ['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED', 'RETURNED'] as const
export type GradingHideState = (typeof HIDE_STATES)[number]

const measureSchema = z.object({
  id: z.string(),
  measuredAt: z.string(),
  declaredArea: z.string().nullable(),
  declared: z.string(),
  declaredFrom: z.enum(['TANNERY', 'RECEIPT']),
  measuredArea: z.string(),
  areaUom,
  difference: z.string(),
  differencePercent: z.string(),
  outcome: z.enum(['WITHIN', 'SHORT', 'OVER']),
  incomingInspectionId: z.string().nullable(),
  by: z.object({ audience: z.enum(['OFFICE', 'FLOOR']), id: z.string().nullable(), name: z.string().nullable(), hidden: z.boolean() }),
  note: z.string().nullable(),
  latest: z.boolean(),
})
export type MeasureView = z.infer<typeof measureSchema>
export type MeasureOutcome = MeasureView['outcome']

const hideHead = z.object({
  id: z.string(),
  code: z.string(),
  state: z.enum(HIDE_STATES),
  version: z.number().int(),
  siteId: z.string(),
  companyId: z.string(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) }),
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string(), dyeBatch: z.string().nullable() }),
  area: z.object({ uom: areaUom, quantity: z.string(), other: z.object({ uom: areaUom, quantity: z.string() }) }),
  baseArea: z.string(),
  onHand: z.string(),
})

const shadeChoice = z.object({ id: z.string(), label: z.string(), outOfShade: z.boolean(), swatchRef: z.string().nullable(), lotId: z.string().nullable() })
export type ShadeChoice = z.infer<typeof shadeChoice>
const gradeChoice = gradeRef.extend({ share: z.string(), source: shareSource, panels: z.array(z.string()) })
export type GradeChoice = z.infer<typeof gradeChoice>

const gradingSchema = z.object({
  hide: hideHead.extend({ supplierCode: z.string().nullable(), thicknessMm: z.string().nullable(), defects: z.string().nullable() }),
  grade: gradeRef.extend({ byText: z.boolean() }).nullable(),
  gradeText: z.string().nullable(),
  shade: shadeChoice.nullable(),
  shadeText: z.string().nullable(),
  usable: z.object({ share: z.string(), source: shareSource, panels: z.array(z.string()), measured: z.string(), left: z.string() }).nullable(),
  estimates: z.array(z.object({ gradeId: z.string(), code: z.string(), share: z.string(), source: shareSource, usable: z.string(), current: z.boolean() })),
  choices: z.object({ grades: z.array(gradeChoice), shadeGroups: z.array(shadeChoice) }),
  lastMeasure: measureSchema.nullable(),
  readOnly: z.string().nullable(),
  reasonRequired: z.boolean(),
  canEdit: z.boolean(),
  changes: z.array(
    z.object({
      at: z.string(),
      actorId: z.string(),
      audience: z.string(),
      from: z.record(z.string(), z.string().nullable()),
      to: z.record(z.string(), z.string().nullable()),
      reason: z.string().nullable(),
    }),
  ),
})
export type GradingView = z.infer<typeof gradingSchema>
export type GradingChange = GradingView['changes'][number]

const measuresSchema = z.object({
  hide: hideHead,
  tolerancePercent: z.string(),
  toleranceFrom: z.enum(['ORDER_LINE', 'DEFAULT']),
  measures: z.array(measureSchema),
  latest: measureSchema.nullable(),
  measureRefusal: z.string().nullable(),
  canMeasure: z.boolean(),
  canCorrectStock: z.boolean(),
})
export type MeasuresView = z.infer<typeof measuresSchema>

const recordedSchema = z.object({
  measure: measureSchema,
  move: z.object({ id: z.string(), direction: z.enum(['IN', 'OUT']), quantity: z.string(), uom: z.enum(UOMS) }).nullable(),
})
export type MeasureRecorded = z.infer<typeof recordedSchema>

/** The body of a correction: only what changes (null clears a record and its text); `reason` once the hide was cut. */
export interface GradingPatch {
  version: number
  gradeId?: string | null
  shadeGroupId?: string | null
  thicknessMm?: string | null
  defects?: string | null
  reason?: string | null
}

export interface MeasureBody {
  measuredArea: string
  areaUom: AreaUnit
  declaredArea?: string | null
  note?: string | null
  correctStock?: { note?: string | null }
}

/** GET /inventory/hides/:hideId/grading. */
export const readGrading = (api: ApiClient, hideId: string, signal?: AbortSignal) => api.get(`/inventory/hides/${seg(hideId)}/grading`, { schema: gradingSchema, signal })

/** PATCH /inventory/hides/:hideId/grading (inventory.hides.manage): at the version read, one key per Apply. */
export const correctGrading = (api: ApiClient, hideId: string, body: GradingPatch, idempotencyKey: string) =>
  api.request('PATCH', `/inventory/hides/${seg(hideId)}/grading`, { body, schema: gradingSchema, idempotencyKey })

/** GET /inventory/hides/:hideId/measures. */
export const readMeasures = (api: ApiClient, hideId: string, signal?: AbortSignal) => api.get(`/inventory/hides/${seg(hideId)}/measures`, { schema: measuresSchema, signal })

/** POST /inventory/hides/:hideId/measures (inventory.hides.manage; `correctStock` also inventory.adjust): one key per dialog. */
export const recordMeasure = (api: ApiClient, hideId: string, body: MeasureBody, idempotencyKey: string) =>
  api.post(`/inventory/hides/${seg(hideId)}/measures`, { body, schema: recordedSchema, idempotencyKey })
