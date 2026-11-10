import { z } from 'zod'
import { styleOptionsView, type StyleOptionsView } from '@nexus/factory-domain/product/options/contracts'
import { routingTimesView, type RoutingTimesView } from '@nexus/factory-domain/product/minutes/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { settingSchema, type SettingBody } from '../../../operations/depth/api'
import { FREQUENCIES, PLAN_STAGES, RECORD_KINDS } from '../../../../quality/plans/constants'
import { readPlans, type PlanRow } from '../../../../quality/plans/api'

/**
 * Every call of the Routing tab in depth (B-W2b-235 on B-W2b-215's and B-W2b-225's API; design products.styles › Operations
 * (routing): "Quality checkpoint", "Setup / run / wait / move", "Only for sizes, colours or options", "Extra minutes for
 * big sizes or options", the operation drawer's "Sizes, colours, options it runs for"): the routing in depth and its times,
 * a draft step's variants, checkpoint, settings and minutes — each write at the REVISION's version (a revision's BOM and
 * routing are one versioned record: every write moves it by one) — and the pickers: the inspection plans a checkpoint may be
 * (Quality's plans read, quality.plans.view) and the options the style offers (B-W2b-229). The times answers are checked
 * against factory-domain product/minutes; the depth answers against the shapes below, written here because factory-domain
 * product/routing-depth/contracts reaches `node:crypto` through quality's rules — routing-depth.vitest.test.ts holds them
 * equal to the domain's. No money.
 */

export type { RoutingTimesView, StyleOptionsView, PlanRow }

const enc = encodeURIComponent
const revisionPath = (styleId: string, revisionId: string) => `/product/styles/${enc(styleId)}/revisions/${enc(revisionId)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })
const words = z.object({ it: z.string(), en: z.string() })
const ref = z.object({ code: z.string(), label: z.string() })

export const checkpointSchema = z.object({
  plan: z.object({ id: z.string(), code: z.string(), name: z.string(), stage: z.enum(PLAN_STAGES), companyId: z.string() }),
  approvedVersion: z.object({ id: z.string(), number: z.number().int(), frequency: z.enum(FREQUENCIES).nullable(), frequencyValue: z.number().int().nullable() }).nullable(),
  kind: z.enum(RECORD_KINDS).nullable(),
  does: words,
  warning: words.nullable(),
})
export type Checkpoint = z.infer<typeof checkpointSchema>

export const stepDepthSchema = z.object({
  stepId: z.string(),
  seq: z.number().int(),
  operationId: z.string(),
  code: z.string(),
  name: z.string(),
  workCentreKind: z.string(),
  scanRequired: z.boolean(),
  variants: z.object({
    sizes: z.array(ref),
    colourways: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
    optionValueIds: z.array(z.string()),
    words: words.nullable(),
  }),
  checkpoint: checkpointSchema.nullable(),
  settings: z.array(settingSchema),
  librarySettings: z.number().int(),
  version: z.number().int(),
  updatedAt: z.string(),
})
export type StepDepth = z.infer<typeof stepDepthSchema>

const revisionDays = z.object({
  id: z.string(),
  revision: z.number().int(),
  status: z.enum(['DRAFT', 'RELEASED', 'OBSOLETE']),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  fromSource: z.enum(['RELEASE', 'RELEASED_BEFORE']).nullable(),
})

export const routingDepthSchema = z.object({
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), status: z.string() }),
  revision: revisionDays,
  sizes: z.array(ref),
  colourways: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  steps: z.array(stepDepthSchema),
  options: z.object({ available: z.boolean(), words }),
  editable: z.boolean(),
})
export type RoutingDepth = z.infer<typeof routingDepthSchema>

export type RevisionRef = { id: string; version: number }

const depthAnswer = z.object({ routing: routingDepthSchema })
const timesAnswer = z.object({ times: routingTimesView })

/** GET …/routing/depth (product.routing.view). */
export const getDepth = (api: ApiClient, styleId: string, revisionId: string): Promise<RoutingDepth> =>
  api.get(`${revisionPath(styleId, revisionId)}/routing/depth`, { schema: depthAnswer }).then((answer) => answer.routing)

/** GET …/routing/times (product.routing.view): every step's run, set-up, wait, move and extra minutes per size. */
export const getTimes = (api: ApiClient, styleId: string, revisionId: string): Promise<RoutingTimesView> =>
  api.get(`${revisionPath(styleId, revisionId)}/routing/times`, { schema: timesAnswer }).then((answer) => answer.times)

const stepPath = (styleId: string, revisionId: string, stepId: string) => `${revisionPath(styleId, revisionId)}/routing/steps/${enc(stepId)}`

/** PUT …/steps/:stepId/variants (product.routing.manage): the sizes, colourways and options it is for; all empty: every cell. */
export const setVariants = (api: ApiClient, styleId: string, revision: RevisionRef, stepId: string, body: { sizes: string[]; colourwayIds: string[]; optionValueIds: string[] }): Promise<RoutingDepth> =>
  api.request('PUT', `${stepPath(styleId, revision.id, stepId)}/variants`, { body: { version: revision.version, ...body }, schema: depthAnswer, ...key() }).then((answer) => answer.routing)

/** PUT …/steps/:stepId/checkpoint (product.routing.manage): a cutting, in-line or end-of-line plan, or none. */
export const setCheckpoint = (api: ApiClient, styleId: string, revision: RevisionRef, stepId: string, inspectionPlanId: string | null): Promise<RoutingDepth> =>
  api.request('PUT', `${stepPath(styleId, revision.id, stepId)}/checkpoint`, { body: { version: revision.version, inspectionPlanId }, schema: depthAnswer, ...key() }).then((answer) => answer.routing)

/** PUT …/steps/:stepId/settings (product.routing.manage): the whole list, or a copy of the library operation's now. */
export const setStepSettings = (api: ApiClient, styleId: string, revision: RevisionRef, stepId: string, change: { settings: SettingBody[] } | { fromLibrary: true }): Promise<RoutingDepth> =>
  api.request('PUT', `${stepPath(styleId, revision.id, stepId)}/settings`, { body: { version: revision.version, ...change }, schema: depthAnswer, ...key() }).then((answer) => answer.routing)

/** A step's run: an approved version of its library operation, its own allowances, or a typed SMV. */
export type RunBody = { from: 'VERSION'; timeVersionId?: string } | { from: 'ALLOWANCES'; basicMinutes: string; personalPct: string; fatiguePct: string; delayPct: string } | { from: 'TYPED'; standardMinutes: string }

export interface StepMinutesBody {
  run?: RunBody
  setupMinutes?: string | null
  waitMinutes?: string | null
  moveMinutes?: string | null
  sizeTimes?: Array<{ size: string; extraMinutes: string }>
}

/** PUT …/steps/:stepId/minutes (product.routing.manage): what is sent changes; `sizeTimes` replaces the step's whole list. */
export const setStepMinutes = (api: ApiClient, styleId: string, revision: RevisionRef, stepId: string, body: StepMinutesBody): Promise<RoutingTimesView> =>
  api.request('PUT', `${stepPath(styleId, revision.id, stepId)}/minutes`, { body: { version: revision.version, ...body }, schema: timesAnswer, ...key() }).then((answer) => answer.times)

/** GET /product/styles/:styleId/options (product.styles.view): the options the style offers (their values a step may be for). */
export const getStyleOptions = (api: ApiClient, styleId: string): Promise<StyleOptionsView> =>
  api.get(`/product/styles/${enc(styleId)}/options`, { schema: z.object({ options: styleOptionsView }) }).then((answer) => answer.options)

/** The inspection plans of a company a step's checkpoint may be (Quality's plans read; the API refuses the other stages in words). */
export const listCheckpointPlans = (api: ApiClient, companyId: string): Promise<PlanRow[]> => readPlans(api, { companyId }).then((answer) => answer.plans)
