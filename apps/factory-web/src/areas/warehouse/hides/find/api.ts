import { z } from 'zod'
import { AREA_UOMS } from '@nexus/factory-domain/inventory/hides/area'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Find hides for a job (B-W2b-131 on B-W2b-100's API; SCM-257, SCM-206; design warehouse.hides pop-up hd-find):
 *   GET  /inventory/reservations/find-hides   by a work order (its leather, its need, its shade lot) or by an article and an
 *                                             area; shade group and minimum grade; ONE shade lot proposed (the order's own
 *                                             first), largest hides first with the running area; other lots with the shade
 *                                             warning; out-of-shade hides apart (inventory.stock.view)
 *   POST /inventory/reservations              the hides chosen, whole, for the work order (inventory.reserve; the shade rule
 *                                             is checked again: a refusal names each line; `shadeOverrideReason` with
 *                                             inventory.shade.override)
 *   GET  /product/materials/:id/grades        the article's grades for the minimum grade (product.materials.view)
 * The API's English (`words`) is never drawn.
 */

const clean = (query: Record<string, string | null | undefined>) => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ''))

const foundHide = z.object({
  hideId: z.string(),
  hideCode: z.string(),
  lotId: z.string(),
  lotCode: z.string(),
  shadeGroupId: z.string().nullable(),
  shadeLabel: z.string().nullable(),
  outOfShade: z.boolean(),
  grade: z.string().nullable(),
  state: z.string(),
  left: z.string(),
  running: z.string(),
  proposed: z.boolean(),
  locationCodes: z.array(z.string()),
  remnant: z.object({ id: z.string(), code: z.string() }).nullable(),
})
export type FoundHide = z.infer<typeof foundHide>

const foundLot = z.object({
  key: z.string(),
  lotId: z.string(),
  lotCode: z.string(),
  shadeGroupId: z.string().nullable(),
  shadeLabel: z.string().nullable(),
  count: z.number(),
  total: z.string(),
  covers: z.boolean(),
  ordersOwn: z.boolean(),
  shadeWarning: z.boolean(),
  hides: z.array(foundHide),
})
export type FoundLot = z.infer<typeof foundLot>

const findSchema = z.object({
  site: z.object({ id: z.string() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }),
  colour: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  workOrder: z.object({ id: z.string(), number: z.string(), planned: z.string().nullable(), issued: z.string().nullable(), reserved: z.string().nullable() }).nullable(),
  leathers: z.array(z.object({ itemId: z.string(), itemColourId: z.string().nullable() })),
  need: z.object({ baseArea: z.string().nullable(), source: z.enum(['ASKED', 'WORK_ORDER']).nullable() }),
  rule: z.string(),
  ordersShadeLots: z.array(z.object({ lotCode: z.string(), shadeLabel: z.string().nullable() })),
  lots: z.array(foundLot),
  outOfShade: z.array(foundHide),
  proposal: z.object({ lotKey: z.string(), hideIds: z.array(z.string()), count: z.number(), area: z.string(), covers: z.boolean() }).nullable(),
})
export type FindAnswer = z.infer<typeof findSchema>

export interface FindQuery {
  siteId: string | null
  workOrderId: string | null
  itemId: string | null
  itemColourId: string | null
  shadeGroupId: string | null
  minGradeId: string | null
  area: string | null
  uom: (typeof AREA_UOMS)[number] | null
}

export const findHides = (api: ApiClient, query: FindQuery, signal?: AbortSignal) =>
  api.get('/inventory/reservations/find-hides', {
    query: clean({ siteId: query.siteId, workOrderId: query.workOrderId, itemId: query.itemId, itemColourId: query.itemColourId, shadeGroupId: query.shadeGroupId, minGradeId: query.minGradeId, area: query.area, uom: query.area ? query.uom : null }),
    schema: findSchema,
    signal,
  })

const reservationSchema = z.object({ id: z.string() })
export const reserveFound = (api: ApiClient, body: { siteId: string; workOrderId: string; note: string; shadeOverrideReason: string | null; hideIds: readonly string[] }, idempotencyKey: string) =>
  api.post('/inventory/reservations', {
    body: {
      siteId: body.siteId,
      workOrderId: body.workOrderId,
      note: body.note.trim() || null,
      ...(body.shadeOverrideReason ? { shadeOverrideReason: body.shadeOverrideReason.trim() } : {}),
      lines: body.hideIds.map((hideId) => ({ hideId })),
    },
    schema: z.object({ reservations: z.array(reservationSchema) }),
    idempotencyKey,
  })

const gradeRow = z.object({ grade: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() }) })
export type ArticleGrade = z.infer<typeof gradeRow>['grade']
export const articleGrades = (api: ApiClient, materialId: string, signal?: AbortSignal) =>
  api.get(`/product/materials/${encodeURIComponent(materialId)}/grades`, { schema: z.object({ grades: z.array(gradeRow) }), signal }).then((answer) => answer.grades.map((row) => row.grade).filter((grade) => grade.active))
