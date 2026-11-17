import { z } from 'zod'
import { GRAINS } from '@nexus/factory-domain/auth/grains/grains'
import { FIELD_AUDIENCES, FIELD_STATUSES, FIELD_TYPES } from '@nexus/factory-domain/fields/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Admin › Fields & lists (B-W2b-431, SCR-164) on B-W2b-421's API (apps/factory-api platform/fields), with
 * the answer's shape checked (zod; unknown fields are dropped). The shapes mirror its contract.ts. Writes carry the
 * version read and an Idempotency-Key per attempt; the API says its refusals at `body/<field>` (model.ts says them in
 * our words).
 */

/** The record types that take custom fields, in the API's order (platform/fields/records.ts CUSTOM_RECORD_KEYS). */
export const RECORD_KEYS = ['CUSTOMER', 'SUPPLIER', 'QUOTE', 'ORDER', 'STYLE', 'MATERIAL', 'PURCHASE_ORDER', 'LOT', 'WORK_ORDER'] as const
export type RecordKey = (typeof RECORD_KEYS)[number]

const recordKey = z.enum(RECORD_KEYS)

export const optionSchema = z.object({
  id: z.string(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  colour: z.string().nullable(),
  icon: z.string().nullable(),
  sortOrder: z.number(),
  description: z.string().nullable(),
  active: z.boolean(),
  version: z.number(),
})
export type ListValue = z.infer<typeof optionSchema>

export const picklistSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  status: z.enum(FIELD_STATUSES),
  version: z.number(),
  values: z.array(optionSchema),
  fieldCount: z.number(),
})
export type Picklist = z.infer<typeof picklistSchema>

export const fieldSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  columnId: z.string(),
  type: z.enum(FIELD_TYPES),
  labelIt: z.string(),
  labelEn: z.string(),
  section: z.string(),
  sortOrder: z.number(),
  required: z.boolean(),
  unit: z.string().nullable(),
  audience: z.enum(FIELD_AUDIENCES),
  grain: z.enum(GRAINS).nullable(),
  shownInPortal: z.boolean(),
  status: z.enum(FIELD_STATUSES),
  version: z.number(),
  picklist: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), values: z.array(optionSchema) }).nullable(),
  linkTo: z.string().nullable(),
  linkRecordType: recordKey.nullable(),
  /** B-TH-056 / B-TH-242: the one customer the field is for (null: every customer); it never changes. */
  partyId: z.string().nullable().default(null),
})
export type Field = z.infer<typeof fieldSchema>

export const editorFieldSchema = fieldSchema.extend({
  valueCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // B-TH-242: the customer's name on the field's line; EVERY_CUSTOMER: shown in every customer's portal (its name reaches them all).
  partyName: z.string().nullable().default(null),
  portalNotice: z.enum(['EVERY_CUSTOMER']).nullable().default(null),
})
export type EditorField = z.infer<typeof editorFieldSchema>

export const recordTypeSchema = z.object({
  key: recordKey,
  model: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  fieldCount: z.number(),
  sharedWith: z.array(recordKey),
  listKey: z.string(),
  importer: z.string(),
})
export type RecordType = z.infer<typeof recordTypeSchema>

const editorSchema = z.object({
  records: z.array(recordTypeSchema),
  recordType: recordKey,
  fields: z.array(editorFieldSchema),
  picklists: z.array(picklistSchema),
  canManage: z.boolean(),
})
export type Editor = z.infer<typeof editorSchema>

const seg = (value: string) => encodeURIComponent(value)
const fieldAnswer = z.object({ field: fieldSchema })
const listAnswer = z.object({ picklist: picklistSchema })

/** fields.view: the record types, the chosen one's fields (archived too, with how many records hold a value), every list. */
export const readEditor = (api: ApiClient, recordType: RecordKey | null, signal?: AbortSignal) => api.get('/fields/editor', { query: { recordType: recordType ?? undefined }, schema: editorSchema, signal })

export interface NewFieldBody {
  recordType: RecordKey
  companyId: string | null
  code: string
  type: Field['type']
  labelIt: string
  labelEn: string
  section: string
  required: boolean
  unit: string | null
  audience: Field['audience']
  grain: Field['grain']
  shownInPortal: boolean
  picklistId: string | null
  linkTo: RecordKey | null
  /** B-TH-242: "For: one customer" — the customer (customers, quotes and orders only); null: every customer. Never changes. */
  partyId: string | null
}

/** fields.manage: a field added to a record type ("Add field to …"), at the end of its section. */
export const createField = async (api: ApiClient, body: NewFieldBody, idempotencyKey: string) => (await api.post('/fields', { body, schema: fieldAnswer, idempotencyKey })).field

export interface FieldChange {
  version: number
  labelIt?: string
  labelEn?: string
  section?: string
  sortOrder?: number
  required?: boolean
  unit?: string | null
  audience?: Field['audience']
  grain?: Field['grain']
  shownInPortal?: boolean
  status?: Field['status']
}

/** fields.manage: labels, section, required, unit, who sees it, portal; archive or restore (status), at the version read. */
export const editField = async (api: ApiClient, fieldId: string, body: FieldChange, idempotencyKey: string) => (await api.request('PATCH', `/fields/${seg(fieldId)}`, { body, schema: fieldAnswer, idempotencyKey })).field

/** fields.manage: the order of one section's active fields, every one named once at its version. */
export const orderFields = async (api: ApiClient, body: { recordType: RecordKey; section: string; fields: { id: string; version: number }[] }, idempotencyKey: string) =>
  (await api.post('/fields/order', { body, schema: z.object({ fields: z.array(fieldSchema) }), idempotencyKey })).fields

/** fields.manage: a new list (of every company, or of one). */
export const createPicklist = async (api: ApiClient, body: { companyId: string | null; code: string; labelIt: string; labelEn: string }, idempotencyKey: string) =>
  (await api.post('/fields/picklists', { body, schema: listAnswer, idempotencyKey })).picklist

/** fields.manage: a list's names, or archive / restore it (refused while an active field picks from it). */
export const editPicklist = async (api: ApiClient, picklistId: string, body: { version: number; labelIt?: string; labelEn?: string; status?: Picklist['status'] }, idempotencyKey: string) =>
  (await api.request('PATCH', `/fields/picklists/${seg(picklistId)}`, { body, schema: listAnswer, idempotencyKey })).picklist

export interface NewValueBody {
  code: string
  labelIt: string
  labelEn: string
  colour: string | null
  icon: string | null
  description: string | null
}

/** fields.manage: a value at the list's end. */
export const addValue = async (api: ApiClient, picklistId: string, body: NewValueBody, idempotencyKey: string) =>
  (await api.post(`/fields/picklists/${seg(picklistId)}/values`, { body, schema: listAnswer, idempotencyKey })).picklist

export interface ValueChange {
  version: number
  labelIt?: string
  labelEn?: string
  colour?: string | null
  icon?: string | null
  description?: string | null
  active?: boolean
}

/** fields.manage: one value's cells (labels, colour, icon, description, active), at the version read. */
export const editValue = async (api: ApiClient, picklistId: string, valueId: string, body: ValueChange, idempotencyKey: string) =>
  (await api.request('PATCH', `/fields/picklists/${seg(picklistId)}/values/${seg(valueId)}`, { body, schema: listAnswer, idempotencyKey })).picklist

/** fields.manage: the list's order, every value named once at its version. */
export const orderValues = async (api: ApiClient, picklistId: string, values: { id: string; version: number }[], idempotencyKey: string) =>
  (await api.post(`/fields/picklists/${seg(picklistId)}/order`, { body: { values }, schema: listAnswer, idempotencyKey })).picklist
