import { z } from 'zod'

/**
 * owb-po3 (design § 5zi B + C; owb-po-server § Shape) — the shapes of the ONE lines table that come from the API: a customer's own
 * columns, a line's own values, the columns a record uses, a line taken out. The web parses them with its OWN zod: every field a
 * newer server adds is read as optional or with a safe default, so this web never waits for the server PR (an older answer: no own
 * column, no line taken out). No price in any of them, ever.
 */

export const OWN_COLUMN_KINDS = ['TEXT', 'YES_NO', 'CHOICE', 'NUMBER', 'DATE'] as const
export type OwnColumnKind = (typeof OWN_COLUMN_KINDS)[number]

/** A column of the customer's own (the customer's, not the order's: each order says which it uses). Closed = kept, never deleted. */
export const ownColumnSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(OWN_COLUMN_KINDS),
  choices: z.array(z.string()).default([]),
  closed: z.boolean().default(false),
  version: z.number().default(0),
})
export type OwnColumn = z.infer<typeof ownColumnSchema>

/** A line's value in one own column. DATE = 'YYYY-MM-DD'; YES_NO = true / false; NUMBER = a number; null = empty. */
export const ownValueSchema = z.object({
  columnId: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  version: z.number().default(0),
})
export type OwnValue = z.infer<typeof ownValueSchema>

/** The columns a record (a draft or an order) uses, in their order, and every line's values (line id → column id → value). */
export const recordOwnColumnsSchema = z.object({
  used: z.array(ownColumnSchema).default([]),
  values: z.record(z.string(), z.record(z.string(), ownValueSchema)).default({}),
})
export type RecordOwnColumns = z.infer<typeof recordOwnColumnsSchema>

export const NO_OWN_COLUMNS: RecordOwnColumns = Object.freeze({ used: [], values: {} }) as RecordOwnColumns

/** A draft's line taken out (it comes back with "Put it back": its options, people and files stayed). DRAFT only, else []. */
export const removedLineSchema = z.object({ id: z.string(), seq: z.number(), words: z.string().default(''), removedAt: z.string() })
export type RemovedLine = z.infer<typeof removedLineSchema>

/** GET /portal/own-columns (and the office twin `GET /sales/own-columns?partyId=`). */
export const ownColumnsListSchema = z.object({ columns: z.array(ownColumnSchema) })
