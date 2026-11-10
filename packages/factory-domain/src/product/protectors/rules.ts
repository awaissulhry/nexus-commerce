import type { Issue } from '../../core/errors'
import type { MaterialApproval } from '../bom-structure/rules'

/**
 * Protector placement (B-W2b-233; PRD-074; design products.styles › Sizes & measurements › Protector placement: "which
 * protector goes in which pocket, per size"; factory-db `ProtectorPlacement`, B-W2b-210): per draft revision of a style,
 * each pocket (shoulder, elbow, back, chest, hip, knee) with the protector material that goes in it, the standard with its
 * edition and the level the certified type asks of it, the sizes it is for (none: every size of the range) and where the
 * pocket sits. A part of the revision: written only while the revision is a DRAFT, frozen once released, copied into the
 * next draft (modules/product/measures/copy.ts). The user information (B-W2b-258) and the tech pack read it.
 *
 * Refused on write (in words, before the database): a material that is not a PROTECTOR or is BLOCKED for use; a size not
 * in the style's range, or twice; a standard of 1 to 60 characters, the level "1" or "2", a note of at most 500; and two
 * placements of ONE pocket for the same size (`overlapProblems`: the database cannot hold that rule, B-W2b-210's note).
 *
 * Pointed out, never blocking (`placementFindings`, "things to look at"): the checks against the revision's BOM (a placed
 * protector the BOM does not have for those sizes; a protector line of the BOM no pocket places), against the protector
 * itself (its own standard and level as its material properties say), against its certificate (a VALID certificate
 * covering the material, granting the standard at the level asked) and against the style's certificate (the performance
 * levels it was granted per pocket: `{ "shoulder": "2" }`).
 */

export const PROTECTOR_POCKETS = ['SHOULDER', 'ELBOW', 'BACK', 'CHEST', 'HIP', 'KNEE'] as const
export type ProtectorPocket = (typeof PROTECTOR_POCKETS)[number]

export const PROTECTOR_LEVELS = ['1', '2'] as const
export type ProtectorLevel = (typeof PROTECTOR_LEVELS)[number]

export const PLACEMENT_LIMITS = Object.freeze({ standard: 60, positionNote: 500, placements: 40 })

/** The standard a pocket's protector is tested to: EN 1621-1 the limbs (shoulder, elbow, hip, knee), -2 the back, -3 the chest. */
export const POCKET_STANDARD: Readonly<Record<ProtectorPocket, string>> = Object.freeze({
  SHOULDER: 'EN 1621-1',
  ELBOW: 'EN 1621-1',
  HIP: 'EN 1621-1',
  KNEE: 'EN 1621-1',
  BACK: 'EN 1621-2',
  CHEST: 'EN 1621-3',
})

/** The pocket in words ("shoulder"), for the API's sentences. */
export const pocketWord = (pocket: ProtectorPocket): string => pocket.toLowerCase()

/** "EN 1621-1:2012" → "EN 1621-1": the standard without its edition, spaces made single, upper case. */
export function standardFamily(standard: string): string {
  return standard.split(':')[0]!.replace(/\s+/g, ' ').trim().toUpperCase()
}

const isLevel = (value: unknown): value is ProtectorLevel => value === '1' || value === '2'

/** Level 2 is the higher protection: a protector of level 2 serves where 1 is asked, not the other way. */
export const levelServes = (have: string | null | undefined, asked: string): boolean => isLevel(have) && isLevel(asked) && Number(have) >= Number(asked)

/** The sizes a placement covers: its own, or every size of the range when it names none. */
export const coveredSizes = (sizes: readonly string[], range: readonly string[]): string[] => (sizes.length === 0 ? [...range] : range.filter((size) => sizes.includes(size)))

/** The sizes as people read them ("every size", "50, 52"). */
export const sizesWords = (sizes: readonly string[]): string => (sizes.length === 0 ? 'every size' : `size${sizes.length === 1 ? '' : 's'} ${sizes.join(', ')}`)

// ---- refusals -------------------------------------------------------------------------------------------------------------

/** Why a revision's placement cannot be changed now (a 409 in words before the database's own refusal), or null. */
export function placementEditRefusal(revision: { readonly revision: number; readonly status: string }, styleStatus: string): string | null {
  if (revision.status !== 'DRAFT') return `Revision ${revision.revision} is ${revision.status.toLowerCase()}: its protector placement is frozen. Change it in a new draft revision.`
  if (styleStatus === 'ARCHIVED') return 'This style is archived: reactivate it before changing its protector placement.'
  return null
}

export interface PlacementFields {
  readonly pocket: ProtectorPocket
  readonly standard: string
  readonly level: string
  readonly sizes: readonly string[]
  readonly positionNote: string | null
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** A placement's own fields against the style's range (paths as the body's). */
export function fieldProblems(fields: PlacementFields, range: readonly string[]): Issue[] {
  const problems: Issue[] = []
  if (fields.standard.trim().length === 0 || fields.standard.length > PLACEMENT_LIMITS.standard || CONTROL.test(fields.standard)) {
    problems.push({ path: 'standard', message: `The standard is written with its edition ("EN 1621-1:2012"), in at most ${PLACEMENT_LIMITS.standard} characters.` })
  }
  if (!isLevel(fields.level)) problems.push({ path: 'level', message: 'The level is 1 or 2.' })
  if (fields.positionNote !== null && (fields.positionNote.trim().length === 0 || fields.positionNote.length > PLACEMENT_LIMITS.positionNote || CONTROL.test(fields.positionNote))) {
    problems.push({ path: 'positionNote', message: `Where the pocket sits is said in at most ${PLACEMENT_LIMITS.positionNote} characters (or left empty).` })
  }
  const seen = new Set<string>()
  fields.sizes.forEach((size, index) => {
    if (seen.has(size)) problems.push({ path: `sizes/${index}`, message: `Size ${size} is named twice.` })
    else if (!range.includes(size)) problems.push({ path: `sizes/${index}`, message: `Size ${size} is not one of the style's sizes (${range.join(', ')}).` })
    seen.add(size)
  })
  return problems
}

/** The material a placement names, as the rules read it. */
export interface ProtectorFacts {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly approval: MaterialApproval
  /** Its material properties (B-W2b-206: PROTECTOR { standard, type, level, size }). */
  readonly standard: string | null
  readonly level: string | null
}

/** Why a material cannot go in a pocket (path `protectorItemId`): not a protector, or blocked for use. */
export function protectorProblems(item: ProtectorFacts | null): Issue[] {
  if (!item) return [{ path: 'protectorItemId', message: 'No such material.' }]
  if (item.kind !== 'PROTECTOR') return [{ path: 'protectorItemId', message: `${item.code} is not a protector: a pocket takes a PROTECTOR material.` }]
  if (item.approval === 'BLOCKED') return [{ path: 'protectorItemId', message: `${item.code} is blocked for use: pick another protector, or ask for the material to be approved.` }]
  return []
}

export interface PlacementShape {
  readonly id: string
  readonly seq: number
  readonly pocket: ProtectorPocket
  readonly sizes: readonly string[]
}

/** Two placements of one pocket covering one size: each pair once, with the sizes they share. */
export function overlaps(placements: readonly PlacementShape[], range: readonly string[]): { a: PlacementShape; b: PlacementShape; sizes: string[] }[] {
  const found: { a: PlacementShape; b: PlacementShape; sizes: string[] }[] = []
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i]!
      const b = placements[j]!
      if (a.pocket !== b.pocket) continue
      const covered = coveredSizes(b.sizes, range)
      const shared = coveredSizes(a.sizes, range).filter((size) => covered.includes(size))
      if (shared.length > 0) found.push({ a, b, sizes: shared })
    }
  }
  return found
}

/**
 * The refusal of a write that would leave two placements of one pocket on one size (the placement written is `written`;
 * its path `sizes`), or none. Every placement but `written` is as stored.
 */
export function overlapProblems(placements: readonly PlacementShape[], written: string, range: readonly string[]): Issue[] {
  const clash = overlaps(placements, range).find((pair) => pair.a.id === written || pair.b.id === written)
  if (!clash) return []
  const other = clash.a.id === written ? clash.b : clash.a
  return [{ path: 'sizes', message: `The ${pocketWord(other.pocket)} pocket already takes placement ${other.seq} for ${sizesWords(clash.sizes)}: one protector per pocket and size. Give the sizes to one placement or the other.` }]
}

// ---- things to look at ----------------------------------------------------------------------------------------------------

export const PLACEMENT_FINDINGS = [
  'POCKET_STANDARD',
  'ITEM_STANDARD',
  'ITEM_LEVEL',
  'ITEM_BLOCKED',
  'NOT_IN_BOM',
  'NOT_IN_BOM_SIZES',
  'BOM_NOT_PLACED',
  'NO_ITEM_CERTIFICATE',
  'ITEM_CERTIFICATE_LEVEL',
  'STYLE_CERTIFICATE_LEVEL',
  'STYLE_CERTIFICATE_POCKET',
] as const
export type PlacementFindingCode = (typeof PLACEMENT_FINDINGS)[number]

export interface PlacementFacts extends PlacementShape {
  readonly protectorItemId: string
  readonly standard: string
  readonly level: string
}

/** A protector line of the revision's BOM: a quantity for every size, or (size-dependent) its sizes' quantities. */
export interface BomProtectorLine {
  readonly seq: number
  readonly itemId: string
  readonly sizeDependent: boolean
  /** Decimal strings ("2.0000"); a size-dependent line uses a size only with a quantity above 0. */
  readonly qty: string
  readonly sizes: readonly { readonly size: string; readonly qty: string }[]
}

/** A certificate (VALID, its coverage ACTIVE) covering a protector material or the style. */
export interface CertificateFacts {
  readonly number: string
  readonly standard: string
  /** The class or level it grants (EN 1621: "1" or "2"). */
  readonly ppeClass: string | null
  /** Beyond its class, per property ({ "shoulder": "2" } for a garment type certified with its protectors). */
  readonly performanceLevels: Readonly<Record<string, unknown>> | null
  /** The style's sizes it covers (a style's certificate); empty: every size. */
  readonly sizes: readonly string[]
}

export interface FindingInput {
  readonly range: readonly string[]
  readonly placements: readonly PlacementFacts[]
  readonly protectors: ReadonlyMap<string, ProtectorFacts>
  readonly bomLines: readonly BomProtectorLine[]
  /** By material id: its VALID certificates. */
  readonly itemCertificates: ReadonlyMap<string, readonly CertificateFacts[]>
  /** The style's VALID certificates. */
  readonly styleCertificates: readonly CertificateFacts[]
}

export interface PlacementFinding {
  readonly code: PlacementFindingCode
  readonly placementId: string | null
  readonly itemId: string | null
  readonly sizes: readonly string[]
  /** What the words need (`pocket`, `item`, `seq`, `level`, `asked`, `standard`, `certificate`, `sizes`). */
  readonly params: Readonly<Record<string, string>>
  /** The finding in English (the API's words; a screen says it in its own from the code and the params). */
  readonly message: string
}

const positive = (qty: string): boolean => /^\d+(\.\d+)?$/.test(qty.trim()) && /[1-9]/.test(qty)

/** The sizes of the range a BOM line uses its material in. */
function lineSizes(line: BomProtectorLine, range: readonly string[]): string[] {
  if (!line.sizeDependent) return positive(line.qty) ? [...range] : []
  return range.filter((size) => line.sizes.some((entry) => entry.size === size && positive(entry.qty)))
}

/** A certificate's level for a pocket, as written in its performance levels ("shoulder": "2"), or null. */
function pocketLevel(certificate: CertificateFacts, pocket: ProtectorPocket): string | null {
  const levels = certificate.performanceLevels
  if (!levels) return null
  for (const [key, value] of Object.entries(levels)) if (key.trim().toLowerCase() === pocketWord(pocket) && typeof value === 'string' && isLevel(value.trim())) return value.trim()
  return null
}

/** What the placement, the BOM and the certificates do not agree on (never blocking; the order: by placement, then the BOM, then the style's certificate). */
export function placementFindings(input: FindingInput): PlacementFinding[] {
  const { range, placements, protectors, bomLines } = input
  const out: PlacementFinding[] = []
  const add = (code: PlacementFindingCode, placement: PlacementFacts | null, itemId: string | null, sizes: readonly string[], params: Record<string, string>, message: string) =>
    out.push({ code, placementId: placement?.id ?? null, itemId, sizes: [...sizes], params, message })

  for (const placement of placements) {
    const item = protectors.get(placement.protectorItemId)
    const code = item?.code ?? ''
    const pocket = pocketWord(placement.pocket)
    const covered = coveredSizes(placement.sizes, range)
    const base = { pocket: placement.pocket, item: code, seq: String(placement.seq), standard: placement.standard, asked: placement.level, sizes: covered.join(', ') }
    const family = standardFamily(placement.standard)
    if (family !== POCKET_STANDARD[placement.pocket]) {
      add('POCKET_STANDARD', placement, placement.protectorItemId, covered, { ...base, expected: POCKET_STANDARD[placement.pocket] }, `The ${pocket} pocket takes a protector tested to ${POCKET_STANDARD[placement.pocket]}; placement ${placement.seq} names ${placement.standard}.`)
    }
    if (item?.approval === 'BLOCKED') add('ITEM_BLOCKED', placement, item.id, covered, base, `${code} is blocked for use: placement ${placement.seq} (${pocket}) needs another protector.`)
    if (item?.standard && standardFamily(item.standard) !== family) {
      add('ITEM_STANDARD', placement, item.id, covered, { ...base, itemStandard: item.standard }, `${code} is tested to ${item.standard}; placement ${placement.seq} (${pocket}) asks ${placement.standard}.`)
    }
    if (item?.level && isLevel(item.level) && !levelServes(item.level, placement.level)) {
      add('ITEM_LEVEL', placement, item.id, covered, { ...base, level: item.level }, `${code} is a level ${item.level} protector; the ${pocket} pocket asks level ${placement.level}.`)
    }
    // The BOM of the same revision.
    const lines = bomLines.filter((line) => line.itemId === placement.protectorItemId)
    if (lines.length === 0) add('NOT_IN_BOM', placement, placement.protectorItemId, covered, base, `${code} (${pocket}) is not in the BOM of this revision.`)
    else {
      const inBom = new Set(lines.flatMap((line) => lineSizes(line, range)))
      const missing = covered.filter((size) => !inBom.has(size))
      if (missing.length > 0) add('NOT_IN_BOM_SIZES', placement, placement.protectorItemId, missing, { ...base, sizes: missing.join(', ') }, `The BOM has no ${code} for ${sizesWords(missing)}, where the ${pocket} pocket places it.`)
    }
    // The protector's own certificate.
    const certificates = input.itemCertificates.get(placement.protectorItemId) ?? []
    if (certificates.length === 0) add('NO_ITEM_CERTIFICATE', placement, placement.protectorItemId, covered, base, `No valid certificate covers ${code} (placement ${placement.seq}, ${pocket}).`)
    else if (!certificates.some((certificate) => standardFamily(certificate.standard) === family && levelServes(certificate.ppeClass, placement.level))) {
      const nearest = certificates.find((certificate) => standardFamily(certificate.standard) === family) ?? certificates[0]!
      add(
        'ITEM_CERTIFICATE_LEVEL',
        placement,
        placement.protectorItemId,
        covered,
        { ...base, certificate: nearest.number, certificateStandard: nearest.standard, level: nearest.ppeClass ?? '' },
        `Certificate ${nearest.number} covers ${code} to ${nearest.standard}${nearest.ppeClass ? ` level ${nearest.ppeClass}` : ''}; the ${pocket} pocket asks ${family} level ${placement.level}.`,
      )
    }
  }

  // A protector line of the BOM that no pocket places (for some of its sizes).
  const byItem = new Map<string, BomProtectorLine[]>()
  for (const line of bomLines) byItem.set(line.itemId, [...(byItem.get(line.itemId) ?? []), line])
  for (const [itemId, lines] of byItem) {
    const used = new Set(lines.flatMap((line) => lineSizes(line, range)))
    if (used.size === 0) continue
    const placed = new Set(placements.filter((placement) => placement.protectorItemId === itemId).flatMap((placement) => coveredSizes(placement.sizes, range)))
    const unplaced = range.filter((size) => used.has(size) && !placed.has(size))
    if (unplaced.length === 0) continue
    const code = protectors.get(itemId)?.code ?? ''
    const all = placed.size === 0
    add(
      'BOM_NOT_PLACED',
      null,
      itemId,
      unplaced,
      { item: code, seq: lines.map((line) => String(line.seq)).join(', '), sizes: unplaced.join(', '), all: all ? 'yes' : 'no' },
      all ? `${code} is in the BOM (line ${lines.map((line) => line.seq).join(', ')}), but no pocket places it.` : `${code} is in the BOM for ${sizesWords(unplaced)}, but no pocket places it there.`,
    )
  }

  // The style's certificate: the levels it was granted per pocket.
  for (const certificate of input.styleCertificates) {
    for (const pocket of PROTECTOR_POCKETS) {
      const wanted = pocketLevel(certificate, pocket)
      if (!wanted) continue
      const certified = coveredSizes(certificate.sizes, range)
      const ofPocket = placements.filter((placement) => placement.pocket === pocket && coveredSizes(placement.sizes, range).some((size) => certified.includes(size)))
      if (ofPocket.length === 0) {
        add('STYLE_CERTIFICATE_POCKET', null, null, certified, { pocket, certificate: certificate.number, level: wanted }, `Certificate ${certificate.number} was granted with a ${pocketWord(pocket)} protector (level ${wanted}); no pocket places one.`)
        continue
      }
      for (const placement of ofPocket) {
        if (levelServes(placement.level, wanted)) continue
        add(
          'STYLE_CERTIFICATE_LEVEL',
          placement,
          placement.protectorItemId,
          coveredSizes(placement.sizes, range).filter((size) => certified.includes(size)),
          { pocket, certificate: certificate.number, level: wanted, asked: placement.level, seq: String(placement.seq), item: protectors.get(placement.protectorItemId)?.code ?? '' },
          `Certificate ${certificate.number} was granted with a level ${wanted} ${pocketWord(pocket)} protector; placement ${placement.seq} asks level ${placement.level}.`,
        )
      }
    }
  }
  return out
}

/** The section in a sentence (the API's `words`). */
export function placementWords(placements: readonly PlacementShape[], findings: readonly PlacementFinding[]): string {
  if (placements.length === 0) return findings.length > 0 ? `No protector placed · ${findings.length} thing(s) to look at` : 'No protector placed.'
  const pockets = new Set(placements.map((placement) => placement.pocket)).size
  return [`${placements.length} placement(s) in ${pockets} pocket(s)`, findings.length > 0 ? `${findings.length} thing(s) to look at` : 'nothing to look at'].join(' · ')
}

/** The order after moving one placement up or down, or null at an end (ids in their new order). */
export function movedOrder(placements: readonly Pick<PlacementShape, 'id' | 'seq'>[], id: string, delta: -1 | 1): string[] | null {
  const sorted = [...placements].sort((a, b) => a.seq - b.seq)
  const index = sorted.findIndex((placement) => placement.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= sorted.length) return null
  const ids = sorted.map((placement) => placement.id)
  ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
  return ids
}
