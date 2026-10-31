import type { BomLineData } from '../bom/rules'
import type { StepData } from '../routing/rules'
import type { Subcontract } from '../routing/subcontract'
import type { ScaleSizes, StyleFields } from './rules'

/**
 * Copying a style (feature PRD-011; design products.styles pop:styles.duplicate "Duplicate style"), pure. A copy is a
 * NEW style with its own code and name, a DRAFT linked to its source (W2b: Style.copiedFromStyleId and the revision it
 * took the parts from, copiedFromRevisionId); it takes the source's identity (product type, season, brand, size scale
 * and range, PPE classification, customs data and gender, description) and its colourways, and the parts the person
 * picks:
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

/** A part named in words (refusals and reasons). */
export const PART_NAME: Readonly<Record<CopyPart, string>> = Object.freeze({
  BOM: 'the BOM',
  ROUTING: 'the routing',
  MEASUREMENTS: 'the made-to-measure set-up',
  LABELS: 'the garment label',
  PICTURES: 'the pictures',
  OPTIONS: 'the options',
})

// ---- why a part cannot be picked, and what a copy left out, as codes (B-W2b-25) -----------------------------------------

/**
 * Why the Duplicate dialog cannot offer a part, as a code a screen says in its own words (B-W2a-37 matched the English
 * sentences by their shape); the answer keeps the sentence beside it (`reason`).
 *
 *   NOT_YET              PICTURES and OPTIONS: their pages come later (W2b)
 *   NOT_MADE_TO_MEASURE  MEASUREMENTS: the source is not made to measure
 *   NO_REVISION          the source has no revision to take a BOM, routing or label from
 *   NO_BOM_LINES         the revision has no BOM line
 *   NO_ROUTING_STEPS     the revision has no routing step
 *   NO_LABEL             the revision has no garment label
 *   OWN_LABEL            the revision's label is the source style's own (compliance's rule: a copy gets its own)
 *   LABEL_RETIRED        the revision's shared label is retired
 *   NEEDS_PERMISSION     the caller may not write that part (the permission, over every company for a tenant-wide style)
 */
export const OFFER_REASONS = ['NOT_YET', 'NOT_MADE_TO_MEASURE', 'NO_REVISION', 'NO_BOM_LINES', 'NO_ROUTING_STEPS', 'NO_LABEL', 'OWN_LABEL', 'LABEL_RETIRED', 'NEEDS_PERMISSION'] as const
export type OfferReasonCode = (typeof OFFER_REASONS)[number]

/** A reason with the facts its words need (null where a code needs none). */
export interface OfferReason {
  readonly code: OfferReasonCode
  /** The source style's code. */
  readonly style: string
  /** The source revision's number (NO_BOM_LINES, NO_ROUTING_STEPS, NO_LABEL, OWN_LABEL, LABEL_RETIRED). */
  readonly revision: number | null
  /** The label's code and revision (OWN_LABEL, LABEL_RETIRED). */
  readonly label: string | null
  readonly labelRevision: number | null
  /** The permission the part needs (NEEDS_PERMISSION), and whether over every company (a tenant-wide style). */
  readonly permission: string | null
  readonly everyCompany: boolean
}

/** A reason's facts, the ones its code does not use left null. */
export const offerReason = (code: OfferReasonCode, style: string, facts: Partial<Omit<OfferReason, 'code' | 'style'>> = {}): OfferReason => ({
  code,
  style,
  revision: facts.revision ?? null,
  label: facts.label ?? null,
  labelRevision: facts.labelRevision ?? null,
  permission: facts.permission ?? null,
  everyCompany: facts.everyCompany ?? false,
})

/** A reason in English words (the answer's `reason`; the screens say the code in theirs). */
export function offerReasonWords(part: CopyPart, reason: OfferReason): string {
  const label = `Label ${reason.label ?? ''} r${reason.labelRevision ?? ''}`
  switch (reason.code) {
    case 'NOT_YET':
      return PART_NOT_YET[part] ?? `${PART_NAME[part]} cannot be copied yet.`
    case 'NOT_MADE_TO_MEASURE':
      return `${reason.style} is not made to measure.`
    case 'NO_REVISION':
      return `${reason.style} has no revision yet.`
    case 'NO_BOM_LINES':
      return `Revision ${reason.revision} has no BOM lines.`
    case 'NO_ROUTING_STEPS':
      return `Revision ${reason.revision} has no routing steps.`
    case 'NO_LABEL':
      return `Revision ${reason.revision} has no garment label.`
    case 'OWN_LABEL':
      return `${label} is ${reason.style}'s own label: make one for the copy in Compliance.`
    case 'LABEL_RETIRED':
      return `${label} is retired.`
    case 'NEEDS_PERMISSION':
      return `Copying ${PART_NAME[part]} needs ${reason.permission}${reason.everyCompany ? ' over every company' : ''}.`
  }
}

/**
 * What a copy left out, as a code with its facts (the answer's `noteCodes`; `notes` keeps the English sentences):
 *
 *   SIZES_ARCHIVED       sizes of the range archived in the scale since (`sizes`)
 *   COLOURWAYS_ARCHIVED  archived colourways, not copied (`count`)
 *   COLOUR_LEFT_OUT      a colourway whose library colour is archived or another company's: the copy's has none (`colourway`)
 *   BOM_LINES_LEFT_OUT   BOM lines of archived colourways, not copied (`count`)
 */
export const COPY_NOTES = ['SIZES_ARCHIVED', 'COLOURWAYS_ARCHIVED', 'COLOUR_LEFT_OUT', 'BOM_LINES_LEFT_OUT'] as const
export type CopyNoteCode = (typeof COPY_NOTES)[number]

export interface CopyNote {
  readonly code: CopyNoteCode
  readonly sizes: readonly string[]
  readonly count: number | null
  readonly colourway: string | null
}

export const leftOutNote = (code: CopyNoteCode, facts: Partial<Omit<CopyNote, 'code'>> = {}): CopyNote => ({ code, sizes: [...(facts.sizes ?? [])], count: facts.count ?? null, colourway: facts.colourway ?? null })

/** A note in English words. */
export function copyNoteWords(note: CopyNote): string {
  switch (note.code) {
    case 'SIZES_ARCHIVED':
      return `Size(s) ${note.sizes.join(', ')} are archived in the scale: the copy's range leaves them out.`
    case 'COLOURWAYS_ARCHIVED':
      return `${note.count} archived colourway(s) are not copied.`
    case 'COLOUR_LEFT_OUT':
      return `Colourway ${note.colourway}: its library colour is archived or another company's; the copy has none.`
    case 'BOM_LINES_LEFT_OUT':
      return `${note.count} BOM line(s) of archived colourways are not copied.`
  }
}

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
