import { z } from 'zod'
import { measurementSpecView, type MeasurementSpecView, type StartSpecBody } from '@nexus/factory-domain/product/measures/contracts'
import { appliedGradeView, gradePreviewView, type GradePreviewView } from '@nexus/factory-domain/product/grading/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * The style's Measurement spec (B-W2b-240 on B-W2b-224's API; design products.styles › Sizes & measurements ›
 * "Measurement spec", pop:styles.grade "Apply grade rule"): every call of the section, each answer checked against
 * factory-domain's own contracts. Every write sends the SPEC's version (not the revision's: a BOM edit of the same draft
 * does not clash with it) and answers the whole spec again.
 */

export type { GradePreviewView, MeasurementSpecView }
export type SpecPoint = MeasurementSpecView['points'][number]
export type SpecCellValue = NonNullable<SpecPoint['cells'][number]['value']>
export interface CellInput {
  pointOfMeasureId: string
  size: string
  nominal: string | null
  toleranceMinus?: string | null
  tolerancePlus?: string | null
}

const enc = encodeURIComponent
const base = (styleId: string, revisionId: string) => `/product/styles/${enc(styleId)}/revisions/${enc(revisionId)}/measurement-spec`
const one = z.object({ spec: measurementSpecView })
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export const getSpec = (api: ApiClient, styleId: string, revisionId: string): Promise<MeasurementSpecView> => api.get(base(styleId, revisionId), { schema: one }).then((answer) => answer.spec)

export const startSpec = (api: ApiClient, styleId: string, revisionId: string, body: StartSpecBody): Promise<MeasurementSpecView> =>
  api.post(base(styleId, revisionId), { body, schema: one, ...key() }).then((answer) => answer.spec)

export const updateSpec = (api: ApiClient, styleId: string, revisionId: string, version: number, patch: { baseSize?: string; gradeRuleId?: string | null }): Promise<MeasurementSpecView> =>
  api.request('PATCH', base(styleId, revisionId), { body: { ...patch, version }, schema: one, ...key() }).then((answer) => answer.spec)

/** Cells typed or pasted (TYPED: on another size than the base, a manual override); a null nominal takes the cell out. */
export const writeCells = (api: ApiClient, styleId: string, revisionId: string, version: number, cells: readonly CellInput[]): Promise<MeasurementSpecView> =>
  api.request('PUT', `${base(styleId, revisionId)}/cells`, { body: { version, cells }, schema: one, ...key() }).then((answer) => answer.spec)

export const addPoints = (api: ApiClient, styleId: string, revisionId: string, version: number, points: ReadonlyArray<{ pointOfMeasureId: string; nominal: string }>): Promise<MeasurementSpecView> =>
  api.post(`${base(styleId, revisionId)}/points`, { body: { version, points }, schema: one, ...key() }).then((answer) => answer.spec)

export const removePoints = (api: ApiClient, styleId: string, revisionId: string, version: number, ids: readonly string[]): Promise<MeasurementSpecView> =>
  api.post(`${base(styleId, revisionId)}/points/remove`, { body: { version, pointOfMeasureIds: ids }, schema: one, ...key() }).then((answer) => answer.spec)

export const orderPoints = (api: ApiClient, styleId: string, revisionId: string, version: number, ids: readonly string[]): Promise<MeasurementSpecView> =>
  api.request('PUT', `${base(styleId, revisionId)}/points/order`, { body: { version, pointOfMeasureIds: ids }, schema: one, ...key() }).then((answer) => answer.spec)

export type SpecMove = 'approve' | 'reopen' | 'archive'
export const moveSpec = (api: ApiClient, styleId: string, revisionId: string, move: SpecMove, version: number, reason?: string): Promise<MeasurementSpecView> =>
  api.post(`${base(styleId, revisionId)}/${move}`, { body: { version, ...(reason ? { reason } : {}) }, schema: one, ...key() }).then((answer) => answer.spec)

export const previewGrade = (api: ApiClient, styleId: string, revisionId: string, ruleId: string, keepOverrides: boolean): Promise<GradePreviewView> =>
  api.post(`${base(styleId, revisionId)}/grade/preview`, { body: { ruleId, keepOverrides }, schema: z.object({ preview: gradePreviewView }), ...key() }).then((answer) => answer.preview)

export const applyGrade = (api: ApiClient, styleId: string, revisionId: string, version: number, ruleId: string, keepOverrides: boolean): Promise<{ spec: MeasurementSpecView; applied: GradePreviewView }> =>
  api.post(`${base(styleId, revisionId)}/grade`, { body: { version, ruleId, keepOverrides }, schema: appliedGradeView, ...key() })
