import { z } from 'zod'
import { pomRow, pomView, type CreatePomBody, type PomRow, type PomView, type UpdatePomBody } from '@nexus/factory-domain/product/measures/contracts'
import { ruleRow, ruleView, type CreateRuleBody, type RuleRow, type RuleView, type UpdateRuleBody } from '@nexus/factory-domain/product/grading/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { presignedSchema } from '../../../../record-panels/api'
import { putToStore, sha256Hex, storeUrl } from '../../../../record-panels/store'

/**
 * Every call of Sizes & measurements in depth (B-W2b-240 on B-W2b-224's API; design products.sizes "Points of measure",
 * "Grade rules", the Grade rule pop-up, the size scale's Grade rules tab): the point of measure library (list, one point,
 * a change of one cell at the point's version, the selection archived or restored, the how-to picture: announced, sent to
 * the store, completed, looked at) and the grade rules (list, one rule with its steps per point, a change, the pop-up's
 * Save of every step, the selection, a scale's rules). Each answer is checked against factory-domain's own contracts.
 */

export type { PomRow, PomView, RuleRow, RuleView }
export type RuleStep = RuleView['byPoint'][number]['steps'][number]
export type RulePoint = RuleView['byPoint'][number]
export type StepInput = { pointOfMeasureId: string; fromSize: string | null; toSize: string | null; increment: string }

const enc = encodeURIComponent
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export interface PomQuery {
  q?: string
  kind?: 'BODY' | 'GARMENT'
  status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'
  limit?: number
  cursor?: string | null
}

const pomPage = z.object({ points: z.array(pomRow), nextCursor: z.string().nullable(), count: z.number().int() })
export type PomPage = z.infer<typeof pomPage>
const onePom = z.object({ point: pomView })

export const listPoms = (api: ApiClient, query: PomQuery): Promise<PomPage> =>
  api.get('/product/points-of-measure', { query: { q: query.q?.trim() || undefined, kind: query.kind, status: query.status ?? 'ACTIVE', limit: query.limit ?? 100, cursor: query.cursor ?? undefined }, schema: pomPage })

export const getPom = (api: ApiClient, id: string): Promise<PomView> => api.get(`/product/points-of-measure/${enc(id)}`, { schema: onePom }).then((answer) => answer.point)

export const createPom = (api: ApiClient, body: CreatePomBody): Promise<PomView> => api.post('/product/points-of-measure', { body, schema: onePom, ...key() }).then((answer) => answer.point)

/** One cell (or the edit dialog's fields) at the point's version. */
export const updatePom = (api: ApiClient, point: Pick<PomRow, 'id' | 'version'>, patch: Omit<UpdatePomBody, 'version'>): Promise<PomView> =>
  api.request('PATCH', `/product/points-of-measure/${enc(point.id)}`, { body: { ...patch, version: point.version }, schema: onePom, ...key() }).then((answer) => answer.point)

export const setPomStatus = (api: ApiClient, points: ReadonlyArray<Pick<PomRow, 'id' | 'version'>>, status: 'ACTIVE' | 'ARCHIVED'): Promise<PomRow[]> =>
  api.post('/product/points-of-measure/status', { body: { points: points.map((point) => ({ id: point.id, version: point.version })), status }, schema: z.object({ points: z.array(pomRow) }), ...key() }).then((answer) => answer.points)

/**
 * The how-to picture: announced at the point's version, PUT to the store, completed. `current` false: the scan holds it
 * (it shows once clean). The answer is the point as it is now.
 */
export async function uploadPomPicture(api: ApiClient, point: Pick<PomRow, 'id' | 'version'>, file: File): Promise<{ point: PomView; current: boolean }> {
  const bytes = await file.arrayBuffer()
  const announced = await api.post(`/product/points-of-measure/${enc(point.id)}/picture`, {
    body: { originalName: file.name, contentType: file.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes), version: point.version },
    schema: z.object({ file: z.object({ id: z.string() }), upload: presignedSchema }),
    ...key(),
  })
  await putToStore(announced.upload, bytes)
  const done = await api.post(`/product/points-of-measure/${enc(point.id)}/picture/${enc(announced.file.id)}/complete`, {
    body: {},
    schema: z.object({ point: pomView, picture: z.object({ fileId: z.string(), status: z.string(), current: z.boolean() }) }),
    ...key(),
  })
  return { point: done.point, current: done.picture.current }
}

/** A look at the point's picture: an address this browser may show (a short-lived one). */
export const lookAtPomPicture = (api: ApiClient, id: string): Promise<string> =>
  api.get(`/product/points-of-measure/${enc(id)}/picture`, { schema: z.object({ download: presignedSchema }) }).then((answer) => storeUrl(answer.download.url))

export const clearPomPicture = (api: ApiClient, point: Pick<PomRow, 'id' | 'version'>): Promise<PomView> =>
  api.request('DELETE', `/product/points-of-measure/${enc(point.id)}/picture`, { query: { version: point.version }, schema: onePom, ...key() }).then((answer) => answer.point)

// ---- grade rules ------------------------------------------------------------------------------------------------------

export interface RuleQuery {
  q?: string
  scaleId?: string
  status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'
  limit?: number
  cursor?: string | null
}

const rulePage = z.object({ rules: z.array(ruleRow), nextCursor: z.string().nullable(), count: z.number().int() })
export type RulePage = z.infer<typeof rulePage>
const oneRule = z.object({ rule: ruleView })

export const listRules = (api: ApiClient, query: RuleQuery): Promise<RulePage> =>
  api.get('/product/grade-rules', { query: { q: query.q?.trim() || undefined, scaleId: query.scaleId, status: query.status ?? 'ACTIVE', limit: query.limit ?? 100, cursor: query.cursor ?? undefined }, schema: rulePage })

export const getRule = (api: ApiClient, id: string): Promise<RuleView> => api.get(`/product/grade-rules/${enc(id)}`, { schema: oneRule }).then((answer) => answer.rule)

export const createRule = (api: ApiClient, body: CreateRuleBody): Promise<RuleView> => api.post('/product/grade-rules', { body, schema: oneRule, ...key() }).then((answer) => answer.rule)

export const updateRule = (api: ApiClient, rule: Pick<RuleRow, 'id' | 'version'>, patch: Omit<UpdateRuleBody, 'version'>): Promise<RuleView> =>
  api.request('PATCH', `/product/grade-rules/${enc(rule.id)}`, { body: { ...patch, version: rule.version }, schema: oneRule, ...key() }).then((answer) => answer.rule)

/** The Grade rule pop-up's Save: every step of the rule (what is left out goes). */
export const saveRuleSteps = (api: ApiClient, rule: Pick<RuleRow, 'id' | 'version'>, steps: readonly StepInput[]): Promise<RuleView> =>
  api.request('PUT', `/product/grade-rules/${enc(rule.id)}/steps`, { body: { version: rule.version, steps }, schema: oneRule, ...key() }).then((answer) => answer.rule)

export const setRuleStatus = (api: ApiClient, rules: ReadonlyArray<Pick<RuleRow, 'id' | 'version'>>, status: 'ACTIVE' | 'ARCHIVED'): Promise<RuleRow[]> =>
  api.post('/product/grade-rules/status', { body: { rules: rules.map((rule) => ({ id: rule.id, version: rule.version })), status }, schema: z.object({ rules: z.array(ruleRow) }), ...key() }).then((answer) => answer.rules)

/** The size scale's Grade rules tab (any status). */
export const scaleRules = (api: ApiClient, scaleId: string): Promise<RuleRow[]> =>
  api.get(`/product/size-scales/${enc(scaleId)}/grade-rules`, { schema: z.object({ rules: z.array(ruleRow) }) }).then((answer) => answer.rules)
