import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { REASON_LISTS, REASON_SOURCES } from '@nexus/factory-domain/reasons/lists'
import { REASON_LIMITS } from '@nexus/factory-domain/reasons/rules'

/**
 * The reason lists (B-W2a-18; PLT-116; design production.settings "Reason codes" with "New reason code", floor.reasons,
 * sales.settings return reasons). One route family for every list, whatever table keeps it (platform/reasons
 * sources.ts): the pickers' read, the editor's read, and the editor's writes, each write with the version it read and
 * an Idempotency-Key. Words are checked in factory-domain reasons/rules (answers in words at `body/<field>`); the lengths
 * here only stop oversized bodies.
 */

const list = z.enum(REASON_LISTS)
const version = z.number().int().min(1)
const words = () => z.string().max(REASON_LIMITS.label * 2)
/** `?list=PAUSE,HELP_CALL`: one or more lists; none: every list. */
const lists = z
  .string()
  .max(400)
  .optional()
  .refine((value) => value === undefined || value.split(',').every((entry) => (REASON_LISTS as readonly string[]).includes(entry.trim())), { message: 'Expected reason lists, comma-separated (PAUSE,HELP_CALL).' })

const fieldsView = output({ icon: z.boolean(), colour: z.boolean(), languages: z.boolean(), needsDetail: z.boolean() })

/** A reason as a picker offers it: active only, in tile order. */
export const pickerReason = output({
  id: id(),
  list,
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  needsDetail: z.boolean(),
  sortOrder: z.number().int(),
})

/** A reason as the editor shows it. */
export const reasonView = output({
  id: id(),
  list,
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  needsDetail: z.boolean(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  /** How many records name the code (a code in use is set inactive, never deleted; no reason is ever deleted). */
  usedCount: z.number().int().min(0),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type ReasonView = z.infer<typeof reasonView>

export const listView = output({
  list,
  source: z.enum(REASON_SOURCES),
  /** What this list keeps besides the code and the Italian and English words. */
  fields: fieldsView,
  active: z.number().int(),
  inactive: z.number().int(),
  /** The standard codes this list does not have yet ("Add the standard reasons"). */
  standardMissing: z.array(z.string()),
  reasons: z.array(reasonView),
})
export type ListView = z.infer<typeof listView>

export const pickerContract = defineContract({
  querystring: input({ list: lists }),
  response: { 200: output({ reasons: z.array(pickerReason) }) },
})

export const editorContract = defineContract({
  querystring: input({ list: lists }),
  response: {
    200: output({
      lists: z.array(listView),
      /** The tenant's other floor languages (its sites' floorLocales but Italian and English): the editor's word columns. */
      languages: z.array(z.string()),
      /** The caller may keep the lists (reasons.manage over every company and site). */
      canManage: z.boolean(),
    }),
  },
})

const listParams = input({ list })

export const createContract = defineContract({
  params: listParams,
  body: input({
    code: z.string().trim().max(40),
    labelIt: words(),
    labelEn: words(),
    labelI18n: z.record(z.string().max(8), words()).optional(),
    icon: z.string().max(40).nullable().optional(),
    colour: z.string().max(7).nullable().optional(),
    needsDetail: z.boolean().optional(),
  }),
  response: { 201: output({ reason: reasonView }) },
})

export const editContract = defineContract({
  params: input({ list, reasonId: id() }),
  body: input({
    version,
    labelIt: words().optional(),
    labelEn: words().optional(),
    /** The languages changed: words replace, null takes a language out; the others stay. */
    labelI18n: z.record(z.string().max(8), words().nullable()).optional(),
    icon: z.string().max(40).nullable().optional(),
    colour: z.string().max(7).nullable().optional(),
    needsDetail: z.boolean().optional(),
    active: z.boolean().optional(),
  }),
  response: { 200: output({ reason: reasonView }) },
})

const versioned = z.array(input({ id: id(), version })).min(1).max(REASON_LIMITS.perRequest)

export const activeContract = defineContract({
  params: listParams,
  body: input({ active: z.boolean(), reasons: versioned }),
  response: { 200: output({ list: listView, changed: z.array(z.string()) }) },
})

export const orderContract = defineContract({
  params: listParams,
  body: input({ reasons: versioned }),
  response: { 200: output({ list: listView }) },
})

export const standardContract = defineContract({
  params: listParams,
  body: input({}).optional(),
  response: { 200: output({ list: listView, added: z.array(z.string()) }) },
})

export type CreateBody = z.infer<typeof createContract.body>
export type EditBody = z.infer<typeof editContract.body>
