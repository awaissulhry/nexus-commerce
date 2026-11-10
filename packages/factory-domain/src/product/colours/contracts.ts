import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { COLOUR_SYSTEMS, COLOUR_VIEWS, NOTICE_KINDS } from './rules'

/**
 * The contracts of the colour library (B-W2b-247; PRD-041; design products.colours, SCR-118). No money, no person. A filter
 * the API cannot apply (an unknown system, a family no colour has) is not refused: the list answers without it and names
 * it in `ignored` (design sec:colours.notices "Server-ignored filters").
 */

const MASTER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
const version = () => z.number().int().min(1)
const reason = () => z.string().trim().min(1).max(500)

export const colourParams = input({ colourId: id() })

/** The list (`?view=&q=&system=&family=`): pages of 50 by code. */
export const colourLibraryQuery = input({
  view: z.enum(COLOUR_VIEWS).default('active'),
  /** Over code, name, the it/en names, the reference and the hex. */
  q: z.string().trim().max(100).optional(),
  /** A colour system (PANTONE, RAL, NCS, OWN); another value is ignored and named. */
  system: z.string().trim().max(20).optional(),
  /** A family ("black"); one no colour has is ignored and named. */
  family: z.string().trim().max(40).optional(),
  /** Exactly this company's colours and the tenant-wide ones. */
  companyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(400).optional(),
})
export type ColourLibraryQuery = z.output<typeof colourLibraryQuery>

const names = () => z.strictObject({ it: z.string().max(200).nullable().optional(), en: z.string().max(200).nullable().optional() })

export const createColourBody = input({
  /** null: a colour of every company (a grant over every company). */
  companyId: id().nullable(),
  code: z.string().max(60),
  name: z.string().max(200),
  names: names().optional(),
  system: z.enum(COLOUR_SYSTEMS).nullable().optional(),
  reference: z.string().max(80).nullable().optional(),
  family: z.string().max(80).nullable().optional(),
  hex: z.string().max(20).nullable().optional(),
  reason: reason().optional(),
})
export type CreateColourBody = z.output<typeof createColourBody>

/** A colour changed at its version (its code and company never change). */
export const updateColourBody = input({
  version: version(),
  name: z.string().max(200).optional(),
  names: names().optional(),
  system: z.enum(COLOUR_SYSTEMS).nullable().optional(),
  reference: z.string().max(80).nullable().optional(),
  family: z.string().max(80).nullable().optional(),
  hex: z.string().max(20).nullable().optional(),
  reason: reason().optional(),
})
export type UpdateColourBody = z.output<typeof updateColourBody>

export const colourStatusBody = input({ version: version(), reason: reason().optional() })
export type ColourStatusBody = z.output<typeof colourStatusBody>

// ---- answers ----------------------------------------------------------------------------------------------------------

/** What names the colour: counts over what the reader may see (null: not in the reader's role), and anything in the tenant. */
export const colourUseView = output({
  materialColours: z.number().int().nullable(),
  colourways: z.number().int().nullable(),
  brandingSets: z.number().int().nullable(),
  inUse: z.boolean(),
})

/** A colour's photo: a picture file of the colour, drawn from the API's own address (never a presigned store address). */
export const colourPhotoView = output({ fileId: id(), name: z.string(), url: z.string() })

export const colourLibraryRow = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  names: z.object({ it: z.string().optional(), en: z.string().optional() }),
  system: z.enum(COLOUR_SYSTEMS).nullable(),
  reference: z.string().nullable(),
  family: z.string().nullable(),
  hex: z.string().nullable(),
  photo: colourPhotoView.nullable(),
  use: colourUseView,
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
})
export type ColourLibraryRow = z.infer<typeof colourLibraryRow>

export const colourLibraryView = output({
  colours: z.array(colourLibraryRow),
  nextCursor: z.string().nullable(),
  /** The rows under these filters (every page). */
  count: z.number().int(),
  /** The filters of the address the API could not apply (`system=XYZ`, `family=…`), as they came. */
  ignored: z.array(z.string()),
  /** Every family of the colours the reader sees, for the filter. */
  families: z.array(z.string()),
})
export type ColourLibraryView = z.infer<typeof colourLibraryView>

/** A brand that makes private-label styles and has no branding set in use (the data the page lacks). */
/** `companyId` null: styles of every company (the brand has no set in use in any company). */
export const brandWithoutSetView = output({ partyId: id(), code: z.string(), name: z.string(), companyId: id().nullable(), styles: z.number().int() })

/** The page's tiles and facts: each tile's number is its list's total under that filter (design sec:colours.tiles). */
export const colourCountsView = output({
  tiles: output({ unused: z.number().int(), brandingSets: z.number().int() }),
  /** Brands with active private-label styles and no active set (at most 10 named; `count` all). */
  brandsWithoutSet: output({ count: z.number().int(), brands: z.array(brandWithoutSetView) }),
  /** Active colours in use without a hex. */
  noHex: z.number().int(),
})
export type ColourCountsView = z.infer<typeof colourCountsView>

export const colourNoticeView = output({ kind: z.enum(NOTICE_KINDS), tone: z.enum(['danger', 'warning', 'info']), value: z.string(), count: z.number().int() })
