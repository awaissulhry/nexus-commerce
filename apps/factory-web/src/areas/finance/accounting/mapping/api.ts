import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'

/**
 * B-W2b-426 — every call of Finance › Close › Accounting export › Account mapping (SCR-480; design finance.accounting
 * "Account mapping (W2b)", conn "Finance › Settings — Account mapping"; B-W2b-408's API): the company's mapping key by key
 * (what Nexus posts → the accountant's account, each row from a day), a row added, an upcoming row changed or removed
 * before its day, and the journals switch (whether the journal packages carry their entries with the mapped accounts;
 * PUT asks a fresh code). The answers' shapes are checked (zod; unknown fields dropped) and mirror factory-domain
 * accounting/mapping/contracts.ts; the enum lists mirror factory-domain (mapping.vitest.test.ts holds them equal). No
 * money: keys, accounts and days. The API's English sentences are never drawn: the screen says its own from the codes;
 * the key's words come from the API in both languages (`words.en` / `words.it`).
 */

export const MAPPING_KINDS = ['ITEM_GROUP', 'TAX_CODE', 'COST_CATEGORY', 'PAYMENT_METHOD', 'PARTY_GROUP'] as const
export type MappingKind = (typeof MAPPING_KINDS)[number]
export const MAPPING_REFUSALS = ['FIXED', 'BACKDATED', 'SAME_DAY', 'UNKNOWN_KEY', 'NOTHING_CHANGES'] as const
export type MappingRefusal = (typeof MAPPING_REFUSALS)[number]
export const SETTINGS_SOURCES = ['COMPANY', 'TENANT', 'DEFAULT'] as const

/** factory-domain accounting/mapping/keys: an account is 1 to 40 letters, digits and . _ / -, starting with a letter or digit. */
export const ACCOUNT_CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/
export const MAPPING_NOTE_MAX = 500
export const REASON_MAX = 1000

const person = z.object({ id: z.string(), name: z.string().nullable() })

export const mappingRowSchema = z.object({
  id: z.string(),
  kind: z.enum(MAPPING_KINDS),
  key: z.string(),
  accountCode: z.string(),
  validFrom: z.string(),
  note: z.string().nullable(),
  /** From its first day it is fixed: a change is a new row from a later day. */
  fixed: z.boolean(),
  createdAt: z.string(),
  createdBy: person.nullable(),
  version: z.number(),
})
export type MappingRow = z.infer<typeof mappingRowSchema>

export const mappingKeySchema = z.object({
  kind: z.enum(MAPPING_KINDS),
  key: z.string(),
  /** null: Nexus posts no such key (a row kept from before, or a code no longer used). */
  words: z.object({ en: z.string(), it: z.string() }).nullable(),
  posted: z.boolean(),
  current: mappingRowSchema.nullable(),
  upcoming: z.array(mappingRowSchema),
  earlier: z.array(mappingRowSchema),
})
export type MappingKey = z.infer<typeof mappingKeySchema>

export const settingsSchema = z.object({
  companyId: z.string(),
  settingsId: z.string().nullable(),
  version: z.number().nullable(),
  journalsOn: z.boolean(),
  from: z.enum(SETTINGS_SOURCES),
  can: z.object({ switch: z.boolean() }),
})
export type JournalsSettings = z.infer<typeof settingsSchema>

export const mappingAnswerSchema = z.object({
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  today: z.string(),
  keys: z.array(mappingKeySchema),
  unmapped: z.number(),
  journals: settingsSchema,
  can: z.object({ manage: z.boolean() }),
})
export type MappingAnswer = z.infer<typeof mappingAnswerSchema>

const rowAnswer = z.object({ row: mappingRowSchema })
const settingsAnswer = z.object({ settings: settingsSchema })

/** GET /accounting/mapping?companyId: every key Nexus posts (and keys a row names that it does not), the switch. */
export function getMapping(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<MappingAnswer> {
  return api.get('/accounting/mapping', { query: { companyId }, schema: mappingAnswerSchema, signal })
}

export interface AddMappingBody {
  readonly companyId: string
  readonly kind: MappingKind
  readonly key: string
  readonly accountCode: string
  /** The first day it applies (Europe/Rome): today or later, except a key's first row. */
  readonly validFrom: string
  readonly note?: string
}

/** POST /accounting/mapping: a key to an account from a day (accounting.mapping.manage). */
export function addMapping(api: ApiClient, body: AddMappingBody, idempotencyKey = newIdempotencyKey()): Promise<MappingRow> {
  return api.post('/accounting/mapping', { body, schema: rowAnswer, idempotencyKey }).then((answer) => answer.row)
}

/** PATCH /accounting/mapping/:id: an upcoming row's account or note, before its first day. */
export function changeMapping(api: ApiClient, mappingId: string, body: { version: number; accountCode?: string; note?: string | null }, idempotencyKey = newIdempotencyKey()): Promise<MappingRow> {
  return api.request('PATCH', `/accounting/mapping/${encodeURIComponent(mappingId)}`, { body, schema: rowAnswer, idempotencyKey }).then((answer) => answer.row)
}

/** DELETE /accounting/mapping/:id?version: an upcoming row removed, before its first day. */
export function removeMapping(api: ApiClient, mappingId: string, version: number, idempotencyKey = newIdempotencyKey()): Promise<string> {
  return api.request('DELETE', `/accounting/mapping/${encodeURIComponent(mappingId)}`, { query: { version }, schema: z.object({ removed: z.string() }), idempotencyKey }).then((answer) => answer.removed)
}

export interface SettingsBody {
  readonly companyId: string
  readonly journalsOn: boolean
  /** The company's row when it has one. */
  readonly version?: number
  readonly reason?: string
}

/** PUT /accounting/settings: the journals switched on or off for the company (accounting.journals.switch + a fresh code). */
export function saveSettings(api: ApiClient, body: SettingsBody, idempotencyKey = newIdempotencyKey()): Promise<JournalsSettings> {
  return api.request('PUT', '/accounting/settings', { body, schema: settingsAnswer, idempotencyKey }).then((answer) => answer.settings)
}
