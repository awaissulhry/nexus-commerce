import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { ACCOUNT_CODE, MAPPING_KEY_MAX, MAPPING_KINDS, MAPPING_NOTE_MAX } from './keys'

/**
 * The contracts of the account mapping and the journals switch (B-W2b-408; FIN-151, FIN-152; design finance.accounting
 * "Account mapping (W2b)", Finance › Settings "Account mapping"). No money: keys, accounts and days. Words are English
 * (the screens say the keys in their own words by their codes).
 */

const companyRef = output({ id: id(), code: z.string(), name: z.string() })
const personRef = output({ id: id(), name: z.string().nullable() })
const keyWordsView = output({ en: z.string(), it: z.string() })

export const MAPPING_REFUSALS = ['FIXED', 'BACKDATED', 'SAME_DAY', 'UNKNOWN_KEY', 'NOTHING_CHANGES'] as const
export type MappingRefusal = (typeof MAPPING_REFUSALS)[number]

export const mappingQuery = input({ companyId: id(), kind: z.enum(MAPPING_KINDS).optional() })
export type MappingQuery = z.infer<typeof mappingQuery>

const keyText = z
  .string()
  .trim()
  .min(1)
  .max(MAPPING_KEY_MAX)
  .regex(/^[^\r\n]+$/, 'One line.')
const accountCode = z.string().trim().regex(ACCOUNT_CODE, 'An account is 1 to 40 letters, digits and . _ / -, starting with a letter or digit.')
const note = z.string().trim().min(1).max(MAPPING_NOTE_MAX)

export const addMappingBody = input({
  companyId: id(),
  kind: z.enum(MAPPING_KINDS),
  key: keyText,
  accountCode,
  /** The first day it applies (Europe/Rome): today or later, except a key's first row. */
  validFrom: businessDate(),
  note: note.optional(),
})
export type AddMappingBody = z.infer<typeof addMappingBody>

export const mappingParams = input({ mappingId: id() })

export const changeMappingBody = input({ version: z.number().int().min(1), accountCode: accountCode.optional(), note: note.nullable().optional() })
export type ChangeMappingBody = z.infer<typeof changeMappingBody>

export const removeMappingQuery = input({ version: z.coerce.number().int().min(1) })

export const mappingRowView = output({
  id: id(),
  kind: z.enum(MAPPING_KINDS),
  key: z.string(),
  accountCode: z.string(),
  validFrom: businessDate(),
  note: z.string().nullable(),
  /** From its first day it is fixed: a change is a new row from a later day. */
  fixed: z.boolean(),
  createdAt: instant(),
  createdBy: personRef.nullable(),
  version: z.number().int(),
})
export type MappingRowView = z.infer<typeof mappingRowView>

export const mappingKeyView = output({
  kind: z.enum(MAPPING_KINDS),
  key: z.string(),
  /** What the key is, in words; null: Nexus posts no such key (a row kept from before, or a code no longer used). */
  words: keyWordsView.nullable(),
  /** Nexus posts this key (the journals use it). */
  posted: z.boolean(),
  /** The row in force today, or null: not mapped today. */
  current: mappingRowView.nullable(),
  /** Rows from a later day (each still changed or removed before its day). */
  upcoming: z.array(mappingRowView),
  /** Rows that applied before the current one. */
  earlier: z.array(mappingRowView),
})

export const settingsView = output({
  companyId: id(),
  /** The company's own row (null: it follows the tenant-wide row, or the default: off). */
  settingsId: id().nullable(),
  version: z.number().int().nullable(),
  journalsOn: z.boolean(),
  from: z.enum(['COMPANY', 'TENANT', 'DEFAULT']),
  words: z.string(),
  can: output({ switch: z.boolean() }),
})
export type SettingsView = z.infer<typeof settingsView>

export const mappingAnswer = output({
  company: companyRef,
  today: businessDate(),
  keys: z.array(mappingKeyView),
  /** Keys posted with no account in force today. */
  unmapped: z.number().int(),
  journals: settingsView,
  can: output({ manage: z.boolean() }),
  words: z.string(),
})
export type MappingAnswer = z.infer<typeof mappingAnswer>

export const mappingRowAnswer = output({ row: mappingRowView })
export const removedAnswer = output({ removed: id() })

export const settingsQuery = input({ companyId: id() })
export const settingsBody = input({
  companyId: id(),
  journalsOn: z.boolean(),
  /** The company's row when it has one. */
  version: z.number().int().min(1).optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
})
export type SettingsBody = z.infer<typeof settingsBody>
export const settingsAnswer = output({ settings: settingsView })
