import type { BomLineData } from '../bom/rules'
import type { StepData } from '../routing/rules'
import type { Subcontract } from '../routing/subcontract'
import type { ScaleSizes, StyleFields } from './rules'

/**
 * Copying a style (feature PRD-011; design products.styles pop:styles.duplicate "Duplicate style"), pure. A copy is a
 * NEW style with its own code and name, a DRAFT linked to its source; it takes the source's identity (product type,
 * season, brand, size scale and range, PPE classification, customs data, description) and its colourways, and the
 * parts the person picks:
 *
 *   BOM           the lines of the source revision with their size quantities and colour grid (onto the copy's
 *                 colourways), and the planned hide yield
 *   ROUTING       the steps of the source revision with their minutes, scan points, instructions and subcontract details
 *   MEASUREMENTS  the made-to-measure set-up: made to measure allowed and its measurement template
 *   LABELS        the source revision's garment label, when it is a shared one (another style's own label stays its own)
 *   PICTURES      the style's sketches and pictures: the gallery comes in W2b
 *   OPTIONS       the style's options: option groups come in W2b
 *
 * The BOM, routing and label land in the copy's revision 1, a DRAFT (never a released one: the copy is released by its
 * own check). The source revision is the one named, else the source's RELEASED revision, else its newest. A size of the
 * range archived in the scale since is left out of the copy's range (and its BOM quantities with it), never added
 * again; what is left out is said in words.
 */

export const COPY_PARTS = ['BOM', 'ROUTING', 'MEASUREMENTS', 'LABELS', 'PICTURES', 'OPTIONS'] as const
export type CopyPart = (typeof COPY_PARTS)[number]
/** The parts a copy can take now. */
export const COPYABLE_PARTS = ['BOM', 'ROUTING', 'MEASUREMENTS', 'LABELS'] as const satisfies readonly CopyPart[]
export type CopyablePart = (typeof COPYABLE_PARTS)[number]

/** Why a part cannot be picked in this wave, in words. */
export const PART_NOT_YET: Readonly<Partial<Record<CopyPart, string>>> = Object.freeze({
  PICTURES: "The style's sketches and pictures are copied once the gallery arrives (W2b).",
  OPTIONS: 'Style options are copied once option groups arrive (W2b).',
})

/** The parts that put something in the copy's first revision. */
export const REVISION_PARTS: readonly CopyablePart[] = Object.freeze(['BOM', 'ROUTING', 'LABELS'])

export const needsRevision = (parts: readonly CopyablePart[]): boolean => parts.some((part) => REVISION_PARTS.includes(part))

/** The revision a copy takes its parts from: the one named, else the RELEASED one, else the newest. */
export function sourceRevisionOf<Revision extends { readonly id: string; readonly revision: number; readonly status: string }>(revisions: readonly Revision[], named?: string): Revision | null {
  if (named !== undefined) return revisions.find((entry) => entry.id === named) ?? null
  return revisions.find((entry) => entry.status === 'RELEASED') ?? [...revisions].sort((a, b) => b.revision - a.revision)[0] ?? null
}

/** The copy's range: the source's sizes still ACTIVE in the scale (in its order), the base size when kept. */
export function copiedRange(source: Pick<StyleFields, 'sizes' | 'baseSize'>, scale: ScaleSizes): { readonly sizes: string[]; readonly baseSize: string | null; readonly dropped: string[] } {
  const active = new Set(scale.filter((size) => size.status === 'ACTIVE').map((size) => size.code))
  const sizes = source.sizes.filter((size) => active.has(size))
  const dropped = source.sizes.filter((size) => !active.has(size))
  return { sizes, baseSize: source.baseSize !== null && sizes.includes(source.baseSize) ? source.baseSize : null, dropped }
}

/** What the person types for the copy (the rest comes from the source). */
export interface CopyInput {
  readonly code: string
  readonly name: string
  /** Undefined: the source's. */
  readonly season?: string | null | undefined
  /** Undefined: the source's brand. */
  readonly brandPartyId?: string | null | undefined
}

/** The copy's fields: the source's identity under the new code and name, the range as `copiedRange` keeps it. */
export function copiedFields(source: StyleFields, typed: CopyInput, parts: readonly CopyablePart[], range: { readonly sizes: readonly string[]; readonly baseSize: string | null }): StyleFields {
  const measurements = parts.includes('MEASUREMENTS')
  return {
    ...source,
    code: typed.code,
    name: typed.name,
    // The names per language were the source's name: the copy is named anew.
    nameI18n: null,
    season: typed.season === undefined ? source.season : typed.season,
    brandPartyId: typed.brandPartyId === undefined ? source.brandPartyId : typed.brandPartyId,
    sizes: [...range.sizes],
    baseSize: range.baseSize,
    mtmAllowed: measurements ? source.mtmAllowed : false,
    measurementTemplateId: measurements ? source.measurementTemplateId : null,
  }
}

/**
 * The source BOM's lines for the copy: new ids, the colourways mapped to the copy's (by the map; a line or cell of a
 * colourway the map lacks is left out), size quantities only for sizes of the copy's range.
 */
export function copyBomLines(lines: readonly BomLineData[], colourways: ReadonlyMap<string, string>, range: readonly string[], newId: () => string): { readonly lines: BomLineData[]; readonly dropped: number } {
  const inRange = new Set(range)
  let dropped = 0
  const copied = [...lines]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((line) => {
      const colourwayId = line.colourwayId === null ? null : (colourways.get(line.colourwayId) ?? undefined)
      if (colourwayId === undefined) {
        dropped += 1
        return []
      }
      return [
        {
          ...line,
          id: newId(),
          colourwayId,
          sizes: line.sizeDependent ? line.sizes.filter((row) => inRange.has(row.size)).map((row) => ({ ...row })) : [],
          colours: line.colourDependent
            ? line.colours.flatMap((cell) => {
                const mapped = colourways.get(cell.colourwayId)
                return mapped === undefined ? [] : [{ colourwayId: mapped, itemColourId: cell.itemColourId }]
              })
            : [],
        },
      ]
    })
  return { lines: copied, dropped }
}

/** The source routing's steps for the copy: new ids, same places, with their subcontract details (by the old step's id). */
export function copyRoutingSteps(steps: readonly StepData[], subcontracts: ReadonlyMap<string, Subcontract>, newId: () => string): { readonly step: StepData; readonly subcontract: Subcontract | null }[] {
  return [...steps]
    .sort((a, b) => a.seq - b.seq)
    .map((step) => ({ step: { ...step, id: newId(), nameI18n: step.nameI18n ? { ...step.nameI18n } : null }, subcontract: subcontracts.get(step.id) ?? null }))
}

/** The copy's first revision's change note. */
export const copyNote = (source: { readonly code: string }, revision: { readonly revision: number } | null, typed?: string): string =>
  typed ?? (revision ? `Copied from ${source.code} revision ${revision.revision}.` : `Copied from ${source.code}.`)
