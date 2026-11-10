import type { Issue } from '../../core/errors'
import { SUB_ASSEMBLY_UOMS, type MaterialApproval } from '../bom-structure/rules'
import type { MaterialStatus } from '../materials/rules'
import { baseFactor, UNITS, type ItemUnits, type Uom } from '../units/units'

/**
 * BOM lines in depth (B-W2b-228; PRD-083, PRD-084, PRD-099, PRD-108; design style.bom.lines "Alternates (W2b)",
 * "Customer-supplied (W2b)", styles.bomLine "Alternates (W2b)"), pure: the rules of B-W2b-211's columns that no earlier step
 * writes, said in words before the database's own refusal (…_bom_options_w2b_guards).
 *
 *   alternates      per line, first choice first (priority 1, 2 …, kept 1..n): another material than the line's own, each once,
 *                   ACTIVE and not BLOCKED when newly named, of the style's company or every company, counted in the line's
 *                   unit (the line's unit converts to its base unit), its colour one of its own; when it may be used
 *                   (ALWAYS, WHEN_SHORT, WITH_APPROVAL; `alternateUse` is the floor's and planning's rule, W2b-5); a
 *                   certificate check whenever the line's material or the alternate is a PPE component (the notified body
 *                   may have to agree: PRD-083), the office's choice otherwise
 *   customer        the material is sent by a customer or a brand (cut-make-trim with the brand's leather, PRD-084): a party
 *                   with the CUSTOMER or BRAND role, not blocked or archived, of the style's company or every company; such
 *                   a line is not bought (no supplier) and has no cost; a sub-assembly (one we make) is never sent by the
 *                   customer
 *   output          what the BOM makes (PRD-099): PCS, PAIR or SET (gloves and sleeves cut in pairs, a protector kit);
 *                   every line's quantity is per that output. The database takes 1 to 1000 units; work orders, costing and
 *                   planning still count one unit per output, so a BOM for more than one unit is refused in words for now
 *   the kit         the lines marked for the workshop make a subcontract order's kit (PRD-108, `kitPlan`); a line tied to a
 *                   routing step goes only with an order that sends that step; a BOM that marks no line keeps W2a's kit
 *                   (every planned material)
 */

/** When an alternate may be used (= factory-db BomAlternateUse). */
export const ALTERNATE_USES = ['ALWAYS', 'WHEN_SHORT', 'WITH_APPROVAL'] as const
export type AlternateUse = (typeof ALTERNATE_USES)[number]

/** At most this many alternates per line. */
export const MAX_ALTERNATES = 10
export const ALTERNATE_NOTE_MAX = 500

/** What a BOM makes (the database's rule: PCS, PAIR or SET). */
export const OUTPUT_UOMS = SUB_ASSEMBLY_UOMS
export type OutputUom = (typeof OUTPUT_UOMS)[number]
/** The database's range of the output quantity. */
export const OUTPUT_LIMITS = { min: 1, max: 1000 } as const
/** What work orders, costing and planning count per output today: one unit (they read one line per garment). */
export const OUTPUT_QUANTITY_COUNTED = 1

/** The roles of a party that sends material (the database's rule). */
export const CUSTOMER_ROLES = ['CUSTOMER', 'BRAND'] as const

const fits = (rowCompany: string | null, companyId: string | null): boolean => rowCompany === null || rowCompany === companyId

// ---- alternates ---------------------------------------------------------------------------------------------------------

/** A material as the alternate rules read it. */
export interface AlternateMaterial {
  readonly id: string
  readonly code: string
  /** FINISHED: a garment, never a material. */
  readonly kind: string
  readonly status: MaterialStatus
  readonly approval: MaterialApproval
  readonly approvalNote: string | null
  readonly isPpeComponent: boolean
  readonly companyId: string | null
  readonly units: ItemUnits
  readonly colours: readonly { readonly id: string; readonly code: string; readonly status: MaterialStatus }[]
}

/** The line an alternate belongs to. */
export interface AlternateLine {
  readonly seq: number
  readonly itemId: string
  readonly uom: Uom
  readonly material: { readonly code: string; readonly isPpeComponent: boolean }
}

/** An alternate as it will be stored. */
export interface AlternateDraft {
  readonly itemId: string
  readonly itemColourId: string | null
  /** Per output unit, in the line's unit, above 0; null: the line's quantity. */
  readonly qty: string | null
  readonly allowedWhen: AlternateUse
  readonly certificateCheck: boolean
  readonly note: string | null
}

/** Another alternate of the same line. */
export interface OtherAlternate {
  readonly id: string
  readonly priority: number
  readonly itemId: string
}

/** True when the alternate needs a certificate check before it is used: the line's material or the alternate is a PPE component. */
export const certificateCheckRequired = (line: Pick<AlternateLine, 'material'>, material: Pick<AlternateMaterial, 'isPpeComponent'>): boolean =>
  line.material.isPpeComponent || material.isPpeComponent

/**
 * Every reason `draft` cannot be an alternate of `line` (paths relative to the body). `fresh` says what is newly named (a
 * new alternate: everything): an archived or blocked material, an archived colour, are refused only when newly named (as the
 * database does for a blocked one).
 */
export function alternateProblems(
  line: AlternateLine,
  draft: AlternateDraft,
  material: AlternateMaterial | undefined,
  others: readonly OtherAlternate[],
  context: { readonly companyId: string | null; readonly fresh: { readonly material: boolean; readonly colour: boolean } },
): Issue[] {
  if (!material) return [{ path: 'itemId', message: 'No such material.' }]
  const issues: Issue[] = []
  const { code } = material
  if (context.fresh.material) {
    if (material.kind === 'FINISHED') issues.push({ path: 'itemId', message: `${code} is a finished garment, not a material: it is no alternate.` })
    if (material.id === line.itemId) issues.push({ path: 'itemId', message: `${code} is line ${line.seq}'s own material: an alternate is another one.` })
    const twice = others.find((other) => other.itemId === material.id)
    if (twice) issues.push({ path: 'itemId', message: `${code} is already alternate ${twice.priority} of line ${line.seq}.` })
    if (material.status === 'ARCHIVED') issues.push({ path: 'itemId', message: `${code} is archived: it is no alternate.` })
    if (material.approval === 'BLOCKED') issues.push({ path: 'itemId', message: `${code} is blocked (refused for use): it is no alternate.${material.approvalNote ? ` Why: ${material.approvalNote}` : ''}` })
    if (!fits(material.companyId, context.companyId)) issues.push({ path: 'itemId', message: `${code} belongs to another company than the style's.` })
    if (baseFactor(line.uom, material.units) === null) {
      issues.push({
        path: 'itemId',
        message: `${code} does not convert ${UNITS[line.uom].symbol} (line ${line.seq}'s unit) to its base unit ${UNITS[material.units.baseUom].symbol}: an alternate is counted in the line's unit. Give ${code} that conversion, or choose another material.`,
      })
    }
  }
  if (draft.itemColourId !== null && (context.fresh.material || context.fresh.colour)) {
    const colour = material.colours.find((entry) => entry.id === draft.itemColourId)
    if (!colour) issues.push({ path: 'itemColourId', message: `Not a colour of ${code}.` })
    else if (colour.status === 'ARCHIVED') issues.push({ path: 'itemColourId', message: `Colour ${colour.code} of ${code} is archived.` })
  }
  if (draft.qty !== null && !/[1-9]/.test(draft.qty)) issues.push({ path: 'qty', message: "An alternate's quantity is above 0 (or none: the line's quantity)." })
  if (draft.note !== null && [...draft.note].length > ALTERNATE_NOTE_MAX) issues.push({ path: 'note', message: `A note is at most ${ALTERNATE_NOTE_MAX} characters.` })
  if (!draft.certificateCheck && certificateCheckRequired(line, material)) {
    const which = line.material.isPpeComponent ? `line ${line.seq}'s ${line.material.code} is a PPE component` : `${code} is a PPE component`
    issues.push({ path: 'certificateCheck', message: `${which}, so the alternate needs a certificate check before it is used (the notified body may have to agree).` })
  }
  return issues
}

/** The priority a new alternate takes: after the last. */
export const nextPriority = (others: readonly Pick<OtherAlternate, 'priority'>[]): number => others.reduce((max, other) => Math.max(max, other.priority), 0) + 1

/** Why `asked` is not an order of exactly the line's alternates `current` (each once). */
export function orderProblems(current: readonly Pick<OtherAlternate, 'id'>[], asked: readonly string[]): Issue[] {
  const known = new Set(current.map((alternate) => alternate.id))
  const issues: Issue[] = []
  const seen = new Set<string>()
  asked.forEach((id, index) => {
    if (!known.has(id)) issues.push({ path: `alternateIds/${index}`, message: 'Not an alternate of this line.' })
    else if (seen.has(id)) issues.push({ path: `alternateIds/${index}`, message: 'Each alternate once.' })
    seen.add(id)
  })
  const missing = current.filter((alternate) => !seen.has(alternate.id)).length
  if (missing > 0) issues.push({ path: 'alternateIds', message: `Name every alternate of the line in its new order (${missing} left out).` })
  return issues
}

/** The priorities 1..n in the order given (by id). */
export const prioritiesOf = (ids: readonly string[]): Map<string, number> => new Map(ids.map((id, index) => [id, index + 1]))

/** Why an alternate is not used now (the floor's "Use a substitute", planning; MES-139, W2b-5). */
export const ALTERNATE_HELD = ['ONLY_WHEN_SHORT', 'NEEDS_APPROVAL', 'NEEDS_CERTIFICATE_CHECK'] as const
export type AlternateHeld = (typeof ALTERNATE_HELD)[number]

export interface AlternateUseFacts {
  readonly priority: number
  readonly code: string
  readonly allowedWhen: AlternateUse
  readonly certificateCheck: boolean
  /** The line's own material is short for the work order (no stock, or late). */
  readonly ownShort: boolean
  /** A person decided this use (WITH_APPROVAL). */
  readonly approved: boolean
  /** The certificate check of this use was done. */
  readonly certificateChecked: boolean
}

/**
 * Whether an alternate may be used now, and what holds it, in words: WHEN_SHORT only while the line's own material is
 * short; WITH_APPROVAL only with a person's decision; a certificate check first when the alternate needs one. The use itself
 * is logged on the work order by the caller (W2b-5's substitution; no column here).
 */
export function alternateUse(facts: AlternateUseFacts): { readonly may: boolean; readonly held: AlternateHeld[]; readonly message: string } {
  const held: AlternateHeld[] = []
  const words: string[] = []
  if (facts.allowedWhen === 'WHEN_SHORT' && !facts.ownShort) {
    held.push('ONLY_WHEN_SHORT')
    words.push('it is used only when the line’s own material is short')
  }
  if (facts.allowedWhen === 'WITH_APPROVAL' && !facts.approved) {
    held.push('NEEDS_APPROVAL')
    words.push('each use needs a person’s approval')
  }
  if (facts.certificateCheck && !facts.certificateChecked) {
    held.push('NEEDS_CERTIFICATE_CHECK')
    words.push('the certificate check comes first (the notified body may have to agree)')
  }
  const name = `Alternate ${facts.priority} (${facts.code})`
  return held.length === 0 ? { may: true, held, message: `${name} may be used.` } : { may: false, held, message: `${name} is not used now: ${words.join('; ')}.` }
}

// ---- customer-supplied material ----------------------------------------------------------------------------------------

/** A party as the customer rule reads it. */
export interface SupplyParty {
  readonly id: string
  readonly code: string
  readonly roles: readonly string[]
  readonly status: string
  readonly companyId: string | null
}

/** The line a customer would send. */
export interface SupplyLine {
  readonly seq: number
  readonly supplier: { readonly id: string; readonly code: string } | null
  readonly subAssembly: boolean
}

/** Why `party` cannot send the material of `line` (path `customerSuppliedByPartyId`); `fresh`: the party is newly named. */
export function customerProblems(line: SupplyLine, party: SupplyParty | undefined, context: { readonly companyId: string | null; readonly fresh: boolean }): Issue[] {
  const at = 'customerSuppliedByPartyId'
  if (!party) return [{ path: at, message: 'No such party.' }]
  const issues: Issue[] = []
  if (context.fresh) {
    if (!party.roles.some((role) => (CUSTOMER_ROLES as readonly string[]).includes(role))) {
      issues.push({ path: at, message: `${party.code} is neither a customer nor a brand: the material is sent by a party with the CUSTOMER or BRAND role.` })
    }
    if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') issues.push({ path: at, message: `${party.code} is ${party.status.toLowerCase()}.` })
    if (!fits(party.companyId, context.companyId)) issues.push({ path: at, message: `${party.code} belongs to another company than the style's.` })
  }
  if (line.supplier) issues.push({ path: at, message: `Line ${line.seq} is bought from ${line.supplier.code}: clear its supplier first (a material the customer sends is not bought).` })
  if (line.subAssembly) issues.push({ path: at, message: `Line ${line.seq} is a sub-assembly we make: the customer does not send it. Clear the sub-assembly first.` })
  return issues
}

// ---- the output ---------------------------------------------------------------------------------------------------------

/** Why a BOM cannot make `quantity` units of `uom` (paths relative to the body). */
export function outputProblems(quantity: number, uom: Uom): Issue[] {
  const issues: Issue[] = []
  if (!(OUTPUT_UOMS as readonly Uom[]).includes(uom)) issues.push({ path: 'outputUom', message: 'A BOM makes pieces, pairs or sets (PCS, PAIR or SET).' })
  if (!Number.isInteger(quantity) || quantity < OUTPUT_LIMITS.min || quantity > OUTPUT_LIMITS.max) {
    issues.push({ path: 'outputQuantity', message: `A BOM makes ${OUTPUT_LIMITS.min} to ${OUTPUT_LIMITS.max} units.` })
  } else if (quantity !== OUTPUT_QUANTITY_COUNTED) {
    issues.push({
      path: 'outputQuantity',
      message: `A BOM for more than one unit (here ${quantity} ${UNITS[uom].symbol}) is not counted by work orders, costing and planning yet: write its lines for 1 ${UNITS[uom].symbol}.`,
    })
  }
  return issues
}

// ---- the subcontract kit ------------------------------------------------------------------------------------------------

/** A line of the work order's revision, as the kit reads it. */
export interface KitBomLine {
  readonly id: string
  readonly seq: number
  readonly issueToSubcontract: boolean
  /** The routing step that uses it (RoutingOperation.seq); null: not tied to one step. */
  readonly routingSeq: number | null
}

/** Where a subcontract order's kit comes from. */
export const KIT_SOURCES = ['BOM', 'ALL'] as const
export type KitSource = (typeof KIT_SOURCES)[number]

export interface KitPlan {
  /** BOM: the lines the BOM marks for the workshop; ALL: it marks none, every planned material goes (W2a's kit). */
  readonly from: KitSource
  /** The lines whose planned materials go (every line when ALL). */
  readonly lineIds: ReadonlySet<string>
  /** Marked lines that stay: tied to a routing step the order does not send. */
  readonly leftOut: readonly { readonly lineId: string; readonly seq: number; readonly routingSeq: number }[]
}

/**
 * The BOM lines a subcontract order's kit takes (PRD-108): the lines marked for the workshop, a line tied to a routing step
 * only when the order sends that step (`sentRoutingSeqs`: the routing steps of the order's operations); none marked: every
 * line (W2a's kit, from every planned material).
 */
export function kitPlan(lines: readonly KitBomLine[], sentRoutingSeqs: ReadonlySet<number>): KitPlan {
  const marked = lines.filter((line) => line.issueToSubcontract)
  if (marked.length === 0) return { from: 'ALL', lineIds: new Set(lines.map((line) => line.id)), leftOut: [] }
  const goes = marked.filter((line) => line.routingSeq === null || sentRoutingSeqs.has(line.routingSeq))
  const leftOut = marked.filter((line) => line.routingSeq !== null && !sentRoutingSeqs.has(line.routingSeq)).map((line) => ({ lineId: line.id, seq: line.seq, routingSeq: line.routingSeq! }))
  return { from: 'BOM', lineIds: new Set(goes.map((line) => line.id)), leftOut }
}

/** The note a planned kit line carries: where it came from. */
export const kitNote = (from: KitSource): string => (from === 'BOM' ? 'From the BOM’s lines for the workshop.' : 'From the work order’s planned materials.')
