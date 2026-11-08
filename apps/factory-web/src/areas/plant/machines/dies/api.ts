import { z } from 'zod'
import { DIE_CONDITIONS, DIE_SETTABLE_CONDITIONS, type DieCondition, type DieSettableCondition } from '@nexus/factory-domain/plant/machines/dies'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Every call of the clicking-die register (B-W2b-136; QHS-173; design plant.machines "Clicking dies") on the API of
 * apps/factory-api modules/plant/dies, with the answer's shape checked (zod; unknown fields are dropped). A die's purchase
 * cost carries the cost grain: absent (never null) without it. Every write is one command with its own Idempotency-Key
 * and the version the screen read. The API's English is never drawn: the screens say their own words from codes (a
 * refusal is `refusal/<CODE>` + `fix`).
 */

export type { DieCondition, DieSettableCondition }
export { DIE_CONDITIONS, DIE_SETTABLE_CONDITIONS }

const brief = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const dieSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  code: z.string(),
  style: brief,
  size: z.string().nullable(),
  piece: z.string(),
  patternPiece: z.object({ id: z.string(), name: z.string(), revision: z.number() }).nullable(),
  rackLocation: z.string().nullable(),
  material: z.string().nullable(),
  supplier: brief.nullable(),
  /** Minor units of the company's currency; absent without the cost grain. */
  purchaseCost: z.number().nullable().optional(),
  condition: z.enum(DIE_CONDITIONS),
  note: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Die = z.infer<typeof dieSchema>

const styleChoice = z.object({ id: z.string(), code: z.string(), name: z.string(), sizes: z.array(z.string()) })
export type StyleChoice = z.infer<typeof styleChoice>

const choicesSchema = z.object({
  style: brief,
  sizes: z.array(z.string()),
  pieces: z.array(z.object({ id: z.string(), name: z.string(), revision: z.number(), sizes: z.array(z.string()) })),
})
export type DieChoices = z.infer<typeof choicesSchema>

const seg = (value: string) => encodeURIComponent(value)
type Query = Record<string, string | number | boolean | null | undefined>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

export interface DiesQuery {
  siteId?: string | null
  styleId?: string | null
  condition?: readonly DieCondition[] | null
  q?: string | null
  cursor?: string | null
  limit?: number
}

const pageSchema = z.object({ dies: z.array(dieSchema), nextCursor: z.string().nullable(), canManage: z.boolean() })
export type DiesPage = z.infer<typeof pageSchema>

/** GET /plant/dies (plant.view): the register, number order, pages of `limit`. */
export const listDies = (api: ApiClient, query: DiesQuery, signal?: AbortSignal) =>
  api.get('/plant/dies', {
    query: clean({ siteId: query.siteId, styleId: query.styleId, condition: query.condition?.length ? query.condition.join(',') : undefined, q: query.q?.trim(), cursor: query.cursor, limit: query.limit }),
    schema: pageSchema,
    signal,
  })

/** GET /plant/dies/styles (plant.view): at most 20 styles by code or name, for the New die dialog. */
export const findDieStyles = (api: ApiClient, q: string, signal?: AbortSignal) =>
  api.get('/plant/dies/styles', { query: clean({ q: q.trim() }), schema: z.object({ styles: z.array(styleChoice) }), signal }).then((answer) => answer.styles)

/** GET /plant/dies/choices (plant.view): one style's sizes and its pattern pieces. */
export const dieChoices = (api: ApiClient, styleId: string, signal?: AbortSignal) => api.get('/plant/dies/choices', { query: { styleId }, schema: choicesSchema, signal })

export interface DieFields {
  size?: string | null
  piece?: string
  patternPieceId?: string | null
  rackLocation?: string | null
  material?: string | null
  supplierId?: string | null
  purchaseCost?: number | null
  note?: string | null
}

const oneDie = z.object({ die: dieSchema })

/** POST /plant/dies (plant.machines.manage). */
export const createDie = (api: ApiClient, body: DieFields & { siteId: string; code: string; styleId: string; piece: string }, idempotencyKey: string = newIdempotencyKey()) =>
  api.post('/plant/dies', { body, schema: oneDie, idempotencyKey }).then((answer) => answer.die)

/** PATCH /plant/dies/:id (plant.machines.manage): only what changed, with the version read. */
export const updateDie = (api: ApiClient, id: string, body: DieFields & { version: number; condition?: DieSettableCondition }) =>
  api.request('PATCH', `/plant/dies/${seg(id)}`, { body, schema: oneDie, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.die)

/** POST /plant/dies/:id/retire (plant.machines.manage). */
export const retireDie = (api: ApiClient, id: string, body: { version: number; reason: string }) =>
  api.post(`/plant/dies/${seg(id)}/retire`, { body, schema: oneDie, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.die)
