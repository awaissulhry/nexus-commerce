import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { REVISION_STATUSES } from '../styles/revisions'
import { SECTION_IDS } from './compare'
import { DISPOSITIONS, DOCUMENT_KINDS, DRIFT_STATES, NEWER_SPEC_STATES } from './drift'

/**
 * Spec versions (B-W2b-220; PRD-085, PRD-166, PRD-167, PRD-168, PRD-194, PRD-195): what apps/factory-api's
 * modules/product/versions answers, and what the screens read (B-W2b-245 Versions & changes and the work order's spec
 * differences, B-W2b-232 the floor's spec-changed banner, B-W2b-244 the change order's redline). Reads only.
 *
 * A compare section is the design part VersionCompare's input as it is (packages/ui patterns/VersionCompare): `fields`,
 * `sizes`, `lines` (id, label, detail, before / after with written fields and quantities per size) and `totals`. Money
 * only by grain: the cost section and every cost of a drift row are `money.cost` (dropped for a caller without the grain).
 */

const written = () => z.string().nullable()
const person = output({ id: id(), name: z.string() })

export const revisionRef = output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) })

/** A revision as a compare's head: VersionCompare's `{ label, note }` ("Rev 2", "RELEASED 2026-11-20") and its facts. */
export const revisionHead = revisionRef.extend({
  label: z.string(),
  note: z.string(),
  changeNote: z.string().nullable(),
  releasedAt: instant().nullable(),
  effectiveFrom: businessDate().nullable(),
  effectiveTo: businessDate().nullable(),
})

export const compareSide = output({ fields: z.record(z.string(), written()), sizes: z.record(z.string(), z.string()).optional() })
export const compareLine = output({ id: id(), label: z.string(), detail: z.string().nullable(), before: compareSide.nullable(), after: compareSide.nullable() })
export const compareField = output({ id: z.string(), label: z.string() })
export const compareTotal = output({ id: z.string(), label: z.string(), before: written(), after: written() })
export const sectionSummary = output({ added: z.number().int(), removed: z.number().int(), changed: z.number().int(), unchanged: z.number().int() })

const sectionShape = {
  label: z.string(),
  fields: z.array(compareField),
  sizes: z.array(z.string()),
  lines: z.array(compareLine),
  /** Counts and minutes (no money; the cost section's totals are under its cost grain). */
  totals: notMoney(z.array(compareTotal)),
  summary: sectionSummary,
}
export const compareSection = output({ id: z.enum(SECTION_IDS), ...sectionShape })
export type CompareSectionView = z.infer<typeof compareSection>

export const differsView = output({ section: z.enum(SECTION_IDS), label: z.string(), added: z.number().int(), removed: z.number().int(), changed: z.number().int() })

/**
 * The cost section (cost grain): both revisions priced with today's standard prices and rates (costing, B-W1-16), one line
 * per colourway with the cost per garment of each size (decimal strings in the currency), the base size's material,
 * labour and overhead as fields. `complete` false: an input is missing on that side (named in `missing`, in words).
 */
export const costSection = output({
  id: z.literal('cost'),
  ...sectionShape,
  currency: z.string(),
  companyId: id().nullable(),
  on: businessDate(),
  computedAt: instant(),
  complete: output({ before: z.boolean(), after: z.boolean() }),
  missing: z.array(output({ code: z.string(), message: z.string() })),
})
export type CostSectionView = z.infer<typeof costSection>

export const compareQuery = input({
  from: id(),
  to: id(),
  /** A tenant-wide style's cost is costed for this company (its rates and currency). */
  companyId: id().optional(),
})
export type CompareQuery = z.output<typeof compareQuery>

export const versionsCompareView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), sizes: z.array(z.string()) }),
  before: revisionHead,
  after: revisionHead,
  sections: z.array(compareSection),
  /** The parts that differ, and the same in words ("BOM: 1 added, 2 changed · …"). */
  differs: z.array(differsView),
  words: z.string(),
  /** Absent without the cost grain; null without costing.view over the style's company or a company to cost it for. */
  cost: money.cost(costSection.nullable()),
})
export type VersionsCompareView = z.infer<typeof versionsCompareView>

// ---- the revisions of a style (PRD-166, PRD-167) -------------------------------------------------------------------------

export const versionRow = revisionRef.extend({
  changeNote: z.string().nullable(),
  createdAt: instant(),
  createdBy: person.nullable(),
  releasedAt: instant().nullable(),
  releasedBy: person.nullable(),
  effectiveFrom: businessDate().nullable(),
  effectiveTo: businessDate().nullable(),
  /** The spec is read-only (released or obsolete): every write path refuses it in these words. */
  locked: z.boolean(),
  lockedReason: z.string().nullable(),
  /** Records made from it; null: the caller's role does not reach them. */
  workOrders: z.number().int().nullable(),
  quoteLines: z.number().int().nullable(),
  orderLines: z.number().int().nullable(),
})

export const styleVersionsView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), status: z.string(), companyId: id().nullable() }),
  /** The style's RELEASED revision. */
  current: id().nullable(),
  revisions: z.array(versionRow),
})
export type StyleVersionsView = z.infer<typeof styleVersionsView>

// ---- drift (PRD-194) ------------------------------------------------------------------------------------------------------

/** A line's cost as priced against its cost now on the other revision (cost grain); decimals per garment, amounts in minor units. */
export const driftCost = output({
  currency: z.string(),
  /** Now: every input of the cells was known. */
  complete: z.boolean(),
  unitCostThen: money.cost(z.string().nullable()),
  unitCostNow: money.cost(z.string().nullable()),
  unitCostChange: money.cost(z.string().nullable()),
  costAmountThen: money.cost(z.number().int().nullable()),
  costAmountNow: money.cost(z.number().int().nullable()),
  costAmountChange: money.cost(z.number().int().nullable()),
})

export const driftRow = output({
  kind: z.enum(DOCUMENT_KINDS),
  documentId: id(),
  number: z.string(),
  status: z.string(),
  lineId: id(),
  seq: z.number().int(),
  colourway: z.string().nullable(),
  pieces: z.number().int(),
  /** The revision the line is on (its own, or its quote line's). */
  revision: revisionRef.nullable(),
  /** The revision it is compared with. */
  against: revisionRef.nullable(),
  state: z.enum(DRIFT_STATES),
  differs: z.array(differsView),
  words: z.string(),
  /** Absent without the cost grain; null when the line has no revision to cost from. */
  cost: money.cost(driftCost.nullable()),
})
export type DriftRowView = z.infer<typeof driftRow>

export const styleDriftView = output({
  style: output({ id: id(), code: z.string(), name: z.string() }),
  /** The spec in force (the RELEASED revision). */
  current: revisionRef.nullable(),
  /** Open quotes and orders whose lines are on another revision than the one in force. */
  rows: z.array(driftRow),
  /** Kinds of record the caller's role does not reach (left out of the rows). */
  held: z.array(z.enum(DOCUMENT_KINDS)),
})
export type StyleDriftView = z.infer<typeof styleDriftView>

// ---- a newer spec for a work order (PRD-195, and PRD-194 at release) --------------------------------------------------------

export const decisionView = output({ disposition: z.enum(DISPOSITIONS), changeOrder: z.string() })

export const newerSpecView = output({
  state: z.enum(NEWER_SPEC_STATES),
  banner: z.boolean(),
  newPages: z.boolean(),
  message: z.string(),
  /** The newer released revision (a banner's), with its release day. */
  newer: output({ id: id(), revision: z.number().int(), releasedOn: businessDate().nullable() }).nullable(),
  decision: decisionView.nullable(),
})

export const workOrderSpecView = output({
  workOrder: output({ id: id(), number: z.string(), status: z.string(), styleId: id(), styleCode: z.string() }),
  /** The revision the work order is made to (frozen at its release). */
  revision: revisionRef.nullable(),
  /** The style's RELEASED revision now. */
  released: revisionRef.nullable(),
  newer: newerSpecView,
  /** How the released revision differs from the work order's. */
  differs: z.array(differsView),
  words: z.string(),
  /** Its order lines quoted or ordered on another revision than the work order's (the drift at release), with the cost impact. */
  orders: z.array(driftRow),
})
export type WorkOrderSpecView = z.infer<typeof workOrderSpecView>

/** The tablet's banner: no cost, no change order detail beyond its number and decision. */
export const floorNewerSpecView = output({
  workOrder: output({ id: id(), number: z.string() }),
  revision: output({ revision: z.number().int(), status: z.enum(REVISION_STATUSES) }).nullable(),
  newer: newerSpecView,
})
export type FloorNewerSpecView = z.infer<typeof floorNewerSpecView>
