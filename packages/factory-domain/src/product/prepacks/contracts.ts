import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { STYLE_STATUSES } from '../styles/rules'
import { PREPACK_LIMITS, PREPACK_SCOPES, PREPACK_STATUSES } from './rules'

/**
 * The prepacks' contracts (B-W2b-233; PRD-055; design products.styles › Sizes & measurements › Prepacks): what
 * apps/factory-api's modules/product/prepacks accepts and answers, and what the web's typed client reads. No money (a
 * prepack is pieces; its price is the order's, W2b-5). A change sends the prepack's `version` (COL-078).
 */

const version = () => z.number().int().min(1)
const sizeCode = () => z.string().trim().min(1).max(40)
const code = () => z.string().trim().min(1).max(PREPACK_LIMITS.code)
const name = () => z.string().trim().min(1).max(PREPACK_LIMITS.name)

export const prepackLineBody = input({
  size: sizeCode(),
  /** A colourway of the style (a style's prepack only); null: any colourway. */
  colourwayId: id().nullable().default(null),
  quantity: z.number().int().min(1).max(PREPACK_LIMITS.quantity),
})
export type PrepackLineBody = z.output<typeof prepackLineBody>

const lines = () => z.array(prepackLineBody).min(1).max(PREPACK_LIMITS.lines)

/** A new prepack from a style's page: of this style only (STYLE) or of every style of the style's size scale (SCALE). */
export const createPrepackBody = input({
  scope: z.enum(PREPACK_SCOPES).default('STYLE'),
  code: code(),
  name: name(),
  lines: lines(),
})
export type CreatePrepackBody = z.output<typeof createPrepackBody>

/** A change to a prepack: its code, its name, or its whole list of lines (kept lines keep their row; others come and go). */
export const updatePrepackBody = input({
  version: version(),
  code: code().optional(),
  name: name().optional(),
  lines: lines().optional(),
})
export type UpdatePrepackBody = z.output<typeof updatePrepackBody>

/** The section's selection (Owner rule 2026-10-29): several prepacks archived or restored, each at the version read; all or none. */
export const prepackStatusBody = input({ prepacks: z.array(input({ id: id(), version: version() })).min(1).max(200), status: z.enum(PREPACK_STATUSES) })
export type PrepackStatusBody = z.output<typeof prepackStatusBody>

export const prepackLineView = output({
  size: z.string(),
  colourwayId: z.string().nullable(),
  colourway: output({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  quantity: z.number().int(),
})

export const prepackView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  scope: z.enum(PREPACK_SCOPES),
  styleId: z.string().nullable(),
  sizeScale: output({ id: z.string(), code: z.string(), name: z.string() }),
  status: z.enum(PREPACK_STATUSES),
  /** In the style's (or the scale's) size order, colourway lines after each other. */
  lines: z.array(prepackLineView),
  /** Pieces per size, every colourway together, in size order. */
  bySize: z.array(output({ size: z.string(), quantity: z.number().int() })),
  /** "2-3-2" (the design's "Ratio per size"). */
  ratio: z.string(),
  pieces: z.number().int(),
  /** Has a colourway line. */
  byColourway: z.boolean(),
  /** The pack's sizes the style in view is not made in (a scale's prepack it cannot sell while any is left). */
  outsideRange: z.array(z.string()),
  /** The style in view can sell it now: ACTIVE and every size in its range. */
  usable: z.boolean(),
  words: z.string(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type PrepackView = z.output<typeof prepackView>

/** A style's prepacks (the section): its own and its scale's, with what a new line may name. */
export const stylePrepacksView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: z.string().nullable(), status: z.enum(STYLE_STATUSES), baseSize: z.string().nullable(), sizes: z.array(z.string()) }),
  sizeScale: output({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), sizes: z.array(z.string()) }),
  colourways: z.array(output({ id: z.string(), code: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'ARCHIVED']) })),
  /** This style's prepacks, then the scale's (every style of the scale), each ACTIVE before ARCHIVED, by code. */
  prepacks: z.array(prepackView),
  /** Why a prepack of THIS style cannot be added or changed now (the style's edit rule, an archived style), or null. */
  styleRefusal: z.string().nullable(),
  words: z.string(),
})
export type StylePrepacksView = z.output<typeof stylePrepacksView>
