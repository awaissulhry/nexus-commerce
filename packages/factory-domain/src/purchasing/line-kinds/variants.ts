import type { Issue } from '../../core/errors'

/**
 * Colour and size variants of one material (B-W2b-328; SCM-186: "W1 treats each trim colour and size as its own material";
 * factory-db buying-depth.prisma ItemVariant), pure. A zip in 60 cm black and 80 cm black, a protector in S, M and L: one
 * material, its variants each a code, a purchase order line, a lot and (by its size) a BOM size line name the variant.
 * apps/factory-api's modules/product/materials/variants.ts writes them through command(); the …_buying_depth_w2b_guards
 * triggers hold the same rules for every login.
 *
 *   what       a colour of the material (one of its colours), a size as the supplier sells it ("60 cm", "M", "8 mm"), or
 *              both; a code unique for the material (default <material>-<colour>-<size>, no spaces), the supplier's own code
 *              as printed on its documents. Never of a finished garment (its SKUs are the style's).
 *   change     only the supplier's code and the status (archived ⇄ active) change: another colour or size is another
 *              variant. A variant is never deleted; it is not archived while an open purchase order line buys it (its lots
 *              must carry it, and an archived variant takes no new lot).
 *   lines      a line buys an ACTIVE variant of its material in the line's colour (a variant without a colour fits every
 *              colour); a line without a colour takes the variant's.
 *   stock      the variant is kept apart in stock on its lots: a material tracked by lot (or hide, serial) keeps each lot's
 *              variant; a material not tracked keeps one balance for all its variants (named in the answers).
 *   BOM        a size line of a BOM uses the variant whose size is the garment's size (and whose colour, when it has one, is
 *              the line's): the rule below, as no BOM column names a variant yet.
 */

export const VARIANT_LIMITS = { code: 60, size: 40, supplierCode: 60, perCall: 200 } as const

export interface VariantDraft {
  readonly itemColourId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly code?: string | null | undefined
  readonly supplierCode?: string | null | undefined
}

export interface NormalVariant {
  readonly itemColourId: string | null
  readonly size: string | null
  readonly code: string
  readonly supplierCode: string | null
}

const blank = (value: string | null | undefined): boolean => value === undefined || value === null || value.trim() === ''
const CONTROL = /[\u0000-\u001f\u007f]/

/** A size as stored: trimmed, inner spaces one each ("60  cm" → "60 cm"). */
export const normalSize = (size: string | null | undefined): string | null => (blank(size) ? null : size!.trim().replace(/\s+/g, ' '))

const codePart = (value: string): string => value.replace(/\s+/g, '').toUpperCase()

/** The default code: the material's, its colour's and the size, joined by dashes, without spaces ("ZIP-60-BLK-60CM"). */
export function variantCodeOf(materialCode: string, colourCode: string | null, size: string | null): string {
  return [materialCode.replace(/\s+/g, ''), ...(colourCode ? [codePart(colourCode)] : []), ...(size ? [codePart(size)] : [])].join('-')
}

/** The draft as it is written: its size normalised, its code given or the default. */
export function normalVariant(draft: VariantDraft, material: { readonly code: string }, colourCode: string | null): NormalVariant {
  const size = normalSize(draft.size)
  return {
    itemColourId: blank(draft.itemColourId) ? null : draft.itemColourId!,
    size,
    code: blank(draft.code) ? variantCodeOf(material.code, colourCode, size) : draft.code!.trim(),
    supplierCode: blank(draft.supplierCode) ? null : draft.supplierCode!.trim(),
  }
}

/** Why the variant cannot be written (paths under `at`); empty when it can. */
export function variantProblems(variant: NormalVariant, at = 'body/'): Issue[] {
  const problems: Issue[] = []
  if (variant.itemColourId === null && variant.size === null) problems.push({ path: `${at}size`, message: 'A variant is a colour of the material, a size, or both: name at least one.' })
  if (variant.size !== null && (variant.size.length > VARIANT_LIMITS.size || CONTROL.test(variant.size))) problems.push({ path: `${at}size`, message: `The size as the supplier sells it, at most ${VARIANT_LIMITS.size} characters.` })
  if (variant.code.length < 1 || variant.code.length > VARIANT_LIMITS.code || /[\s\u0000-\u001f\u007f]/.test(variant.code)) {
    problems.push({ path: `${at}code`, message: `A code of 1 to ${VARIANT_LIMITS.code} characters without spaces.` })
  }
  if (variant.supplierCode !== null && (variant.supplierCode.length > VARIANT_LIMITS.supplierCode || CONTROL.test(variant.supplierCode))) {
    problems.push({ path: `${at}supplierCode`, message: `The supplier's code, at most ${VARIANT_LIMITS.supplierCode} characters.` })
  }
  return problems
}

export interface VariantFacts {
  readonly code: string
  readonly itemColourId: string | null
  readonly size: string | null
  readonly status: string
}

/** Why a line (or a lot) of this colour may not name the variant, in words; null when it may. */
export function lineVariantProblem(variant: VariantFacts | null, code: string, itemCode: string, lineColourId: string | null): string | null {
  if (!variant) return `${itemCode} has no variant ${code}.`
  if (variant.status !== 'ACTIVE') return `Variant ${code} of ${itemCode} is archived: choose an active one.`
  if (variant.itemColourId !== null && variant.itemColourId !== lineColourId) return `Variant ${code} of ${itemCode} is of another colour than the line.`
  return null
}

/** Is a material's stock kept apart per variant (on its lots)? Not when it is not tracked. */
export const keepsVariantsApart = (tracking: string): boolean => tracking !== 'NONE'

export type SizeMatch = 'ONE' | 'SEVERAL' | 'NONE'

/**
 * The variants a BOM size line uses: the ACTIVE ones whose size is the garment's size (letters and spaces as typed do not
 * count: "m" = "M", "60cm" = "60 cm"), of one of the line's colours when the variant has a colour (colourIds null: any).
 */
export function variantsForSize<V extends VariantFacts>(variants: readonly V[], size: string, colourIds: readonly string[] | null): { readonly match: SizeMatch; readonly variants: V[] } {
  const key = (value: string) => value.replace(/\s+/g, '').toUpperCase()
  const wanted = key(size)
  const found = variants
    .filter((variant) => variant.status === 'ACTIVE' && variant.size !== null && key(variant.size) === wanted)
    .filter((variant) => colourIds === null || variant.itemColourId === null || colourIds.includes(variant.itemColourId))
    .sort((a, b) => a.code.localeCompare(b.code))
  return { match: found.length === 0 ? 'NONE' : found.length === 1 ? 'ONE' : 'SEVERAL', variants: found }
}
