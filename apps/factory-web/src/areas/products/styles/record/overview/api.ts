import { z } from 'zod'
import { assignView, rangesView, type AssignView, type RangesView } from '@nexus/factory-domain/product/gtin/contracts'
import { lifecycleView, type LifecycleView } from '@nexus/factory-domain/product/lifecycle/contracts'
import { summaryView, type SummaryView } from '@nexus/factory-domain/product/release/contracts'
import { privateLabelView, textsView, type PrivateLabelView, type TextsView } from '@nexus/factory-domain/product/style-texts/contracts'
import { styleTypeView, typeView, type StyleTypeView, type TypeView } from '@nexus/factory-domain/product/types/contracts'
import { whereUsedView, type WhereUsedView } from '@nexus/factory-domain/product/where-used/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * Every call of the Style studio's depth (B-W2b-237), on the merged API of B-W2b-221 (the lifecycle and the type), B-W2b-227
 * (names per language, the private label, GTINs from a range, where-used) and B-W2b-231 (the completeness of the release gate).
 * Each answer is checked against the API's own contract (factory-domain). Every write sends the version it was made on and an
 * idempotency key.
 */

export type { AssignView, LifecycleView, PrivateLabelView, RangesView, StyleTypeView, SummaryView, TextsView, TypeView, WhereUsedView }
export type GateSummaryRow = SummaryView['styles'][number]
export type GtinRange = RangesView['ranges'][number]

const enc = encodeURIComponent
const stylePath = (styleId: string) => `/product/styles/${enc(styleId)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })

// ---- the lifecycle (B-W2b-221) ------------------------------------------------------------------------------------------

const lifecycleAnswer = z.object({ lifecycle: lifecycleView })

export const readLifecycle = (api: ApiClient, styleId: string): Promise<LifecycleView> => api.get(`${stylePath(styleId)}/lifecycle`, { schema: lifecycleAnswer }).then((answer) => answer.lifecycle)

export interface MoveInput {
  to: LifecycleView['style']['lifecycle']
  reason?: string
  /** Into PHASE_OUT or DISCONTINUED: the replacing style (null: none); left out, the one named stays. */
  replacedById?: string | null
}

export const moveLifecycle = (api: ApiClient, styleId: string, version: number, input: MoveInput): Promise<LifecycleView> =>
  api.post(`${stylePath(styleId)}/lifecycle`, { body: { version, ...input }, schema: lifecycleAnswer, ...key() }).then((answer) => answer.lifecycle)

export const setReplacement = (api: ApiClient, styleId: string, version: number, replacedById: string | null, reason?: string): Promise<LifecycleView> =>
  api.request('PUT', `${stylePath(styleId)}/replaced-by`, { body: { version, replacedById, ...(reason ? { reason } : {}) }, schema: lifecycleAnswer, ...key() }).then((answer) => answer.lifecycle)

// ---- the product type (B-W2b-221) ---------------------------------------------------------------------------------------

const styleTypeAnswer = z.object({ styleType: styleTypeView })

export const readStyleType = (api: ApiClient, styleId: string): Promise<StyleTypeView> => api.get(`${stylePath(styleId)}/type`, { schema: styleTypeAnswer }).then((answer) => answer.styleType)

export const setStyleType = (api: ApiClient, styleId: string, version: number, typeId: string | null): Promise<StyleTypeView> =>
  api.request('PUT', `${stylePath(styleId)}/type`, { body: { version, typeId }, schema: styleTypeAnswer, ...key() }).then((answer) => answer.styleType)

/** The active types a style of this company may take (its own and every company's), of one kind of garment. */
export const listTypes = (api: ApiClient, query: { productType: string; companyId: string | null }): Promise<TypeView[]> =>
  api.get('/product/types', { query: { productType: query.productType, status: 'ACTIVE', companyId: query.companyId ?? undefined }, schema: z.object({ types: z.array(typeView) }) }).then((answer) => answer.types)

// ---- names per language and the private label (B-W2b-227) --------------------------------------------------------------

const textsAnswer = z.object({ texts: textsView })

export const readTexts = (api: ApiClient, styleId: string): Promise<TextsView> => api.get(`${stylePath(styleId)}/texts`, { schema: textsAnswer }).then((answer) => answer.texts)

export interface TextInput {
  name: string
  shortDescription: string | null
  longDescription: string | null
}

/** A language written: `version` of its row to change it, none for a new language. */
export const putText = (api: ApiClient, styleId: string, language: string, input: TextInput, version: number | null): Promise<TextsView> =>
  api
    .request('PUT', `${stylePath(styleId)}/texts/${enc(language)}`, { body: { ...(version === null ? {} : { version }), ...input }, schema: textsAnswer, ...key() })
    .then((answer) => answer.texts)

export const removeText = (api: ApiClient, styleId: string, language: string, version: number): Promise<TextsView> =>
  api.post(`${stylePath(styleId)}/texts/${enc(language)}/remove`, { body: { version }, schema: textsAnswer, ...key() }).then((answer) => answer.texts)

const privateLabelAnswer = z.object({ privateLabel: privateLabelView })

export const readPrivateLabel = (api: ApiClient, styleId: string): Promise<PrivateLabelView> =>
  api.get(`${stylePath(styleId)}/private-label`, { schema: privateLabelAnswer }).then((answer) => answer.privateLabel)

export const setPrivateLabel = (api: ApiClient, styleId: string, body: { version: number; brandPartyId: string | null; soldUnderOurName: boolean; reason?: string }): Promise<PrivateLabelView> =>
  api.request('PUT', `${stylePath(styleId)}/private-label`, { body, schema: privateLabelAnswer, ...key() }).then((answer) => answer.privateLabel)

// ---- where-used (B-W2b-227) ---------------------------------------------------------------------------------------------

export const readWhereUsed = (api: ApiClient, styleId: string): Promise<WhereUsedView> =>
  api.get(`${stylePath(styleId)}/where-used`, { schema: z.object({ whereUsed: whereUsedView }) }).then((answer) => answer.whereUsed)

// ---- completeness (B-W2b-231) -------------------------------------------------------------------------------------------

/** The release gate summed up for at most 25 styles (the list's column, the side panel). */
export const readGateSummary = (api: ApiClient, styleIds: readonly string[], signal?: AbortSignal): Promise<SummaryView> =>
  api.get('/product/release-gate', { query: { styleIds: styleIds.join(',') }, schema: summaryView, signal })

/** Every style's summary, 25 at a time (the API's limit), one call after another. */
export async function readGateSummaries(api: ApiClient, styleIds: readonly string[], signal?: AbortSignal): Promise<GateSummaryRow[]> {
  const rows: GateSummaryRow[] = []
  for (let at = 0; at < styleIds.length; at += 25) {
    const answer = await readGateSummary(api, styleIds.slice(at, at + 25), signal)
    rows.push(...answer.styles)
  }
  return rows
}

// ---- GTINs from a range (B-W2b-227) -------------------------------------------------------------------------------------

export const listGtinRanges = (api: ApiClient, companyId: string | null): Promise<RangesView> =>
  api.get('/product/gtin-ranges', { query: { companyId: companyId ?? undefined, status: 'ACTIVE' }, schema: rangesView })

export interface AssignInput {
  rangeId: string
  /** Left out: every SKU switched on without a GTIN. */
  skuIds?: string[]
  dryRun: boolean
  /** The confirm: the preview's range version and count (the API refuses other numbers than shown). */
  rangeVersion?: number
  count?: number
}

export const assignGtins = (api: ApiClient, styleId: string, input: AssignInput): Promise<AssignView> =>
  api.post(`${stylePath(styleId)}/gtins/assign`, { body: input, schema: z.object({ assignment: assignView }), ...key() }).then((answer) => answer.assignment)
