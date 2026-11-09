import { z } from 'zod'
import { id, input, output } from '../../core/contracts'
import { WHERE_USED_KINDS } from './rules'

/**
 * Where a style is used (B-W2b-227; PRD-021): GET /product/styles/:styleId/where-used. Per kind: whether the person may read
 * it (`allowed`; false: nothing else is said, not even a count), how many records name the style and how many are still
 * open, and the rows (open first, then the newest; at most 50, `more` when there are others). No money.
 */

export const styleParams = input({ styleId: id() })

const party = output({ id: id(), code: z.string(), name: z.string() })

export const whereUsedRow = output({
  id: id(),
  /** The record's number or code ("Q-2026-0004", "WO-…", a price list's code, a certificate's number, a SKU for stock). */
  number: z.string(),
  /** The record's state code (status, stage; for stock: the place). */
  state: z.string(),
  open: z.boolean(),
  /** Its date: issued, ordered, due, valid to (YYYY-MM-DD; null: none). */
  at: z.string().nullable(),
  party: party.nullable(),
  companyId: id().nullable(),
  siteId: id().nullable(),
  /** A few words on what of the style it names (colourways, sizes, garments, a list version). */
  detail: z.string().nullable(),
  /** Garments (work orders: planned; stock: on hand); null where it is not a count of garments. */
  pieces: z.number().int().nullable(),
})

export const whereUsedGroup = output({
  kind: z.enum(WHERE_USED_KINDS),
  allowed: z.boolean(),
  count: z.number().int(),
  open: z.number().int(),
  rows: z.array(whereUsedRow),
  more: z.boolean(),
  /** Stock only: finished garments on hand, every SKU of the style (null: not stock, or not allowed). */
  onHand: z.number().int().nullable(),
})

export const whereUsedView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), brand: party.nullable() }),
  groups: z.array(whereUsedGroup),
})
export type WhereUsedView = z.infer<typeof whereUsedView>
export type WhereUsedGroup = z.infer<typeof whereUsedGroup>
export type WhereUsedRow = z.infer<typeof whereUsedRow>
