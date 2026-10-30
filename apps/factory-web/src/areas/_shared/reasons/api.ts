import { z } from 'zod'
import { REASON_LISTS, REASON_SOURCES, type ReasonList } from '@nexus/factory-domain/reasons/lists'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of the shared reason list editor (B-W2a-18; SCR-242) and of the pickers, with the answer's shape checked
 * (zod; unknown fields are dropped). The shapes mirror apps/factory-api platform/reasons/contract.ts. One route family
 * for every list, whatever table keeps it; writes carry the version read and an Idempotency-Key per attempt.
 */

const list = z.enum(REASON_LISTS)

export const reasonSchema = z.object({
  id: z.string(),
  list,
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  needsDetail: z.boolean(),
  sortOrder: z.number(),
  active: z.boolean(),
  usedCount: z.number(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Reason = z.infer<typeof reasonSchema>

export const listSchema = z.object({
  list,
  source: z.enum(REASON_SOURCES),
  fields: z.object({ icon: z.boolean(), colour: z.boolean(), languages: z.boolean(), needsDetail: z.boolean() }),
  active: z.number(),
  inactive: z.number(),
  standardMissing: z.array(z.string()),
  reasons: z.array(reasonSchema),
})
export type ReasonListView = z.infer<typeof listSchema>

const editorSchema = z.object({ lists: z.array(listSchema), languages: z.array(z.string()), canManage: z.boolean() })
export type EditorAnswer = z.infer<typeof editorSchema>

const seg = (value: string) => encodeURIComponent(value)

/** The editor's read (reasons.view): the lists asked, every reason with how often it is used. */
export const readLists = (api: ApiClient, lists: readonly ReasonList[], signal?: AbortSignal) => api.get('/reasons/lists', { query: { list: lists.join(',') }, schema: editorSchema, signal })

export interface NewReasonBody {
  code: string
  labelIt: string
  labelEn: string
  labelI18n?: Record<string, string>
  icon?: string | null
  colour?: string | null
  needsDetail?: boolean
}

/** reasons.manage: a new reason at the list's end. */
export const createReason = async (api: ApiClient, listName: ReasonList, body: NewReasonBody, idempotencyKey: string) =>
  (await api.post(`/reasons/${seg(listName)}`, { body, schema: z.object({ reason: reasonSchema }), idempotencyKey })).reason

export interface ReasonEdit {
  version: number
  labelIt?: string
  labelEn?: string
  /** The languages changed: words replace, null takes a language out. */
  labelI18n?: Record<string, string | null>
  icon?: string | null
  colour?: string | null
  needsDetail?: boolean
  active?: boolean
}

/** reasons.manage: one cell (or a few fields) of one reason, at the version read. */
export const editReason = async (api: ApiClient, listName: ReasonList, id: string, body: ReasonEdit, idempotencyKey: string) =>
  (await api.request('PATCH', `/reasons/${seg(listName)}/${seg(id)}`, { body, schema: z.object({ reason: reasonSchema }), idempotencyKey })).reason

type Versioned = ReadonlyArray<{ id: string; version: number }>

/** reasons.manage: many set inactive (or active again) at once. */
export const setActive = (api: ApiClient, listName: ReasonList, active: boolean, reasons: Versioned, idempotencyKey: string) =>
  api.post(`/reasons/${seg(listName)}/active`, { body: { active, reasons }, schema: z.object({ list: listSchema, changed: z.array(z.string()) }), idempotencyKey })

/** reasons.manage: the list's tile order (every reason once). */
export const reorder = async (api: ApiClient, listName: ReasonList, reasons: Versioned, idempotencyKey: string) =>
  (await api.post(`/reasons/${seg(listName)}/order`, { body: { reasons }, schema: z.object({ list: listSchema }), idempotencyKey })).list

/** reasons.manage: the standard reasons the list is missing. */
export const addStandard = (api: ApiClient, listName: ReasonList, idempotencyKey: string) =>
  api.post(`/reasons/${seg(listName)}/standard`, { body: {}, schema: z.object({ list: listSchema, added: z.array(z.string()) }), idempotencyKey })

export const pickerReasonSchema = reasonSchema.pick({ id: true, list: true, code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true, needsDetail: true, sortOrder: true })
export type PickerReason = z.infer<typeof pickerReasonSchema>

/**
 * The pickers' read (any office session; the floor reads the same route): the ACTIVE reasons of the lists asked, in tile
 * order. A screen that asks for a reason (write-off, count line, hold, return, rework) offers these.
 */
export const pickerReasons = async (api: ApiClient, lists: readonly ReasonList[], signal?: AbortSignal) =>
  (await api.get('/reasons', { query: { list: lists.join(',') }, schema: z.object({ reasons: z.array(pickerReasonSchema) }), signal })).reasons
