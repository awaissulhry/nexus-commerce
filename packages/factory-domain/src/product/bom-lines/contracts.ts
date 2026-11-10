import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { fitsDecimal } from '../../core/money'
import { MAX_BOM_LINES } from '../bom/rules'
import { MATERIAL_APPROVALS } from '../bom-structure/rules'
import { ITEM_KINDS, ITEM_TRACKINGS, MATERIAL_STATUSES } from '../materials/rules'
import { MASTER_STATUSES } from '../sizes/rules'
import { REVISION_STATUSES } from '../styles/revisions'
import { STYLE_STATUSES } from '../styles/rules'
import { UOMS } from '../units/units'
import { ALTERNATE_HELD, ALTERNATE_NOTE_MAX, ALTERNATE_USES, KIT_SOURCES, MAX_ALTERNATES, OUTPUT_LIMITS, OUTPUT_UOMS } from './rules'

/**
 * BOM lines in depth (B-W2b-228; PRD-083, PRD-084, PRD-099, PRD-108; design style.bom.lines "Alternates (W2b)",
 * "Customer-supplied (W2b)", styles.bomLine "Alternates (W2b)"): what apps/factory-api's modules/product/bom-lines accepts
 * and answers. No money (a cost is the cost sheet's; a customer's material simply has none). Every write sends the
 * revision's `version` (COL-078): the BOM of a revision is one versioned record, as W1's lines.
 */

const version = () => z.number().int().min(1)
/** A quantity per output unit, above 0: Decimal(18,4). */
const positive = () =>
  z.string().refine((value) => /^\d+(?:\.\d+)?$/.test(value) && fitsDecimal(value, 18, 4) && /[1-9]/.test(value), {
    message: 'Expected a number above 0 with at most 14 digits and 4 decimals.',
  })
const note = () => z.string().trim().min(1).max(ALTERNATE_NOTE_MAX)

/** A new alternate of a line, after its last one. certificateCheck left out: true when a PPE component is involved, else false. */
export const addAlternateBody = input({
  version: version(),
  itemId: id(),
  itemColourId: id().nullish(),
  /** In the line's unit, per output unit; null or left out: the line's quantity. */
  qty: positive().nullish(),
  allowedWhen: z.enum(ALTERNATE_USES).optional(),
  certificateCheck: z.boolean().optional(),
  note: note().nullish(),
})
export type AddAlternateBody = z.output<typeof addAlternateBody>

/** A change to an alternate: only what it names; null clears an optional field. The order is `orderAlternatesBody`'s. */
export const updateAlternateBody = input({
  version: version(),
  itemId: id().optional(),
  itemColourId: id().nullish(),
  qty: positive().nullish(),
  allowedWhen: z.enum(ALTERNATE_USES).optional(),
  certificateCheck: z.boolean().optional(),
  note: note().nullish(),
}).refine((body) => Object.keys(body).some((key) => key !== 'version'), { message: 'Send what changes.' })
export type UpdateAlternateBody = z.output<typeof updateAlternateBody>

/** An alternate out of the line: the revision's version in the query. */
export const removeAlternateQuery = input({ version: z.coerce.number().int().min(1) })
export type RemoveAlternateQuery = z.output<typeof removeAlternateQuery>

/** Every alternate of the line in its new order: the first is priority 1. */
export const orderAlternatesBody = input({ version: version(), alternateIds: z.array(id()).min(1).max(MAX_ALTERNATES) })
export type OrderAlternatesBody = z.output<typeof orderAlternatesBody>

const supplyFields = {
  /** The customer or brand that sends the material (null: we buy it). */
  customerSuppliedByPartyId: id().nullable().optional(),
  /** The line goes in the kit a workshop receives for a subcontracted job. */
  issueToSubcontract: z.boolean().optional(),
}

/** One line's supply: who sends it, whether it goes to the workshop. What is left out stays. */
export const setSupplyBody = input({ version: version(), ...supplyFields }).refine((body) => body.customerSuppliedByPartyId !== undefined || body.issueToSubcontract !== undefined, {
  message: 'Send the customer or the workshop mark.',
})
export type SetSupplyBody = z.output<typeof setSupplyBody>

/** The list's selection (Owner rule 2026-10-29): several lines given one customer and/or one workshop mark at once. */
export const changeSupplyBody = input({ version: version(), lineIds: z.array(id()).min(1).max(MAX_BOM_LINES), ...supplyFields }).refine(
  (body) => body.customerSuppliedByPartyId !== undefined || body.issueToSubcontract !== undefined,
  { message: 'Send the customer or the workshop mark.' },
)
export type ChangeSupplyBody = z.output<typeof changeSupplyBody>

/** What the BOM makes: every line's quantity is per this output. */
export const setOutputBody = input({
  version: version(),
  outputQuantity: z.number().int().min(OUTPUT_LIMITS.min).max(OUTPUT_LIMITS.max),
  outputUom: z.enum(OUTPUT_UOMS),
})
export type SetOutputBody = z.output<typeof setOutputBody>

// ---- answers ------------------------------------------------------------------------------------------------------------

const partyRef = output({ id: id(), code: z.string(), name: z.string() })
const colourRef = output({ id: id(), code: z.string(), name: z.string(), status: z.enum(MASTER_STATUSES) })
const materialRef = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  kind: z.enum([...ITEM_KINDS, 'FINISHED']),
  status: z.enum(MATERIAL_STATUSES),
  approval: z.enum(MATERIAL_APPROVALS),
  isPpeComponent: z.boolean(),
  tracking: z.enum(ITEM_TRACKINGS),
  baseUom: z.enum(UOMS),
})

export const alternateView = output({
  id: id(),
  /** 1 = the first choice after the line's own material. */
  priority: z.number().int(),
  item: materialRef,
  itemColour: colourRef.nullable(),
  /** In the line's unit, per output unit; null: the line's quantity. */
  qty: z.string().nullable(),
  allowedWhen: z.enum(ALTERNATE_USES),
  certificateCheck: z.boolean(),
  /** A PPE component is involved: the check cannot be switched off. */
  certificateRequired: z.boolean(),
  /**
   * For a PPE component alternate: the certificate in the register that covers it today (VALID, in its validity, an ACTIVE
   * coverage; the company's own or one a brand or supplier holds); null: none does (the notified body may have to agree).
   */
  certificate: output({ id: id(), number: z.string(), standard: z.string(), validTo: z.string() }).nullable(),
  /**
   * What a use of it needs (rules `alternateUse` with nothing known yet): the line's own material short, a person's approval,
   * a certificate check; empty: it is used like the line's own. W2b-5's substitution asks with the facts of the work order.
   */
  needs: z.array(z.enum(ALTERNATE_HELD)),
  note: z.string().nullable(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type AlternateView = z.infer<typeof alternateView>

export const depthLineView = output({
  id: id(),
  seq: z.number().int(),
  item: materialRef,
  placement: z.string().nullable(),
  qty: z.string(),
  uom: z.enum(UOMS),
  /** Bought from this supplier (not the material's default); null with a customer. */
  supplier: partyRef.nullable(),
  /** The customer or brand that sends it (no cost, no purchase); null: we buy it. */
  customerSupplied: partyRef.nullable(),
  /** It goes in a workshop's kit; `kit` says how (KIT: a kit line; CUT: leather tracked by the hide goes cut, as bundles). */
  issueToSubcontract: z.boolean(),
  kit: z.enum(['KIT', 'CUT']).nullable(),
  /** The routing step that uses it: a kit line goes only with an order that sends this step. */
  routingStep: output({ seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
  /** It takes a sub-assembly (a revision of another style): never sent by the customer. */
  subAssembly: z.boolean(),
  alternates: z.array(alternateView),
})
export type DepthLineView = z.infer<typeof depthLineView>

/**
 * The lines of one revision in depth (design style.bom.lines: Alternates and Customer-supplied columns; styles.bomLine
 * Alternates; the output): each line's alternates first choice first, who sends it, whether it goes to the workshop; what
 * the BOM makes; the kit a workshop gets; what each customer sends.
 */
export const bomDepthView = output({
  revision: output({ id: id(), styleId: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES), version: z.number().int() }),
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES), ppe: z.boolean() }),
  /** A draft of a style that is not archived: the lines can be changed. */
  editable: z.boolean(),
  output: output({ quantity: z.number().int(), uom: z.enum(UOMS) }),
  lines: z.array(depthLineView),
  /** A subcontract order's kit from this revision: BOM (the marked lines), ALL (none marked: every planned material). */
  kit: output({ from: z.enum(KIT_SOURCES), lineIds: z.array(id()), cutLineIds: z.array(id()) }),
  /** What each customer or brand sends, with its lines. */
  customers: z.array(output({ party: partyRef, lineIds: z.array(id()) })),
  counts: output({ lines: z.number().int(), alternates: z.number().int(), customerSupplied: z.number().int(), forWorkshop: z.number().int() }),
})
export type BomDepthView = z.infer<typeof bomDepthView>
