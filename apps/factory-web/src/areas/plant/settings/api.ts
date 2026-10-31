import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Plant settings › Symptoms on the floor (SCR-241; B-W2a-73 on the API of B-W2a-35, apps/factory-api
 * modules/plant lists): the group's machine classes and the symptoms a station reports, with the answer's shape checked
 * (zod; unknown fields are dropped). The lists are the whole group's (tenant-wide): reading needs plant.view, every write
 * plant.machines.manage over every company (`canManage` says whether this person has it). Every write carries the
 * version read and its own Idempotency-Key; a symptom's code and its class never change once added.
 */

const words = z.record(z.string(), z.string())

export const classRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: words,
  icon: z.string().nullable(),
  sortOrder: z.number(),
  active: z.boolean(),
  machines: z.number(),
  version: z.number(),
  updatedAt: z.string(),
})
export type ClassRow = z.infer<typeof classRowSchema>

export const symptomRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  classId: z.string().nullable(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: words,
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  unsafe: z.boolean(),
  needsDetail: z.boolean(),
  active: z.boolean(),
  sortOrder: z.number(),
  /** How many requests named it (a used symptom is taken off the floor, never deleted). */
  requests: z.number(),
  version: z.number(),
  updatedAt: z.string(),
})
export type SymptomRow = z.infer<typeof symptomRowSchema>

const classesAnswer = z.object({ classes: z.array(classRowSchema), starterMissing: z.array(z.string()), canManage: z.boolean() })
export type ClassesAnswer = z.infer<typeof classesAnswer>
const symptomsAnswer = z.object({ symptoms: z.array(symptomRowSchema), canManage: z.boolean() })
export type SymptomsAnswer = z.infer<typeof symptomsAnswer>

const seg = (value: string) => encodeURIComponent(value)

/** GET /plant/classes (plant.view): every class (active or retired), the starter codes the group lacks, canManage. */
export const readClasses = (api: ApiClient, signal?: AbortSignal) => api.get('/plant/classes', { schema: classesAnswer, signal })

/** GET /plant/symptoms (plant.view): every symptom of the group (no class asked: all), each with its requests. */
export const readSymptoms = (api: ApiClient, signal?: AbortSignal) => api.get('/plant/symptoms', { schema: symptomsAnswer, signal })

export interface NewSymptomBody {
  code: string
  /** The class it is for; null: every machine. */
  classId: string | null
  labelIt: string
  labelEn: string
  icon: string | null
  unsafe: boolean
  needsDetail: boolean
}

/** POST /plant/symptoms (plant.machines.manage): a new symptom at the end of the list. */
export const createSymptom = async (api: ApiClient, body: NewSymptomBody, idempotencyKey: string) =>
  (await api.post('/plant/symptoms', { body, schema: z.object({ symptom: symptomRowSchema }), idempotencyKey })).symptom

export interface SymptomEdit {
  version: number
  labelIt?: string
  labelEn?: string
  icon?: string | null
  unsafe?: boolean
  needsDetail?: boolean
  sortOrder?: number
  active?: boolean
}

/** PATCH /plant/symptoms/:id (plant.machines.manage): one cell (or the order) of one symptom, at the version read. */
export const editSymptom = async (api: ApiClient, id: string, body: SymptomEdit, idempotencyKey: string) =>
  (await api.request('PATCH', `/plant/symptoms/${seg(id)}`, { body, schema: z.object({ symptom: symptomRowSchema }), idempotencyKey })).symptom

/** POST /plant/starter (plant.machines.manage): the starter set's missing classes and symptoms (a repeat adds nothing). */
export const addStarter = async (api: ApiClient, idempotencyKey: string) =>
  (await api.post('/plant/starter', { body: {}, schema: z.object({ added: z.object({ classes: z.array(z.string()), symptoms: z.array(z.string()) }) }), idempotencyKey })).added
