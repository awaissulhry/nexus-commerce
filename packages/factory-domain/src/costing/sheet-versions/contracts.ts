import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { SHEET_CATEGORIES } from '../sheet-components/components'
import { componentLineView, missingComponentView, sizeSplitView } from '../sheet-components/contracts'
import { WEIGHT_SOURCES } from '../size-weights/rules'
import { LINE_CHANGES } from './compare'
import { COST_SHEET_STATES, FREEZE_REASONS, VERSION_SOURCES } from './rules'
import { WHAT_IF_TARGETS } from './what-if'

/**
 * The contracts of cost sheet versions (B-W2b-420; FIN-014, FIN-015, FIN-016): what apps/factory-api's
 * modules/costing/sheet-versions answers and the web's typed client reads (design products.styles › Cost "Cost sheet versions
 * and approval": Version, Season, Status, Approved by, Cost; Approve and lock; Compare two versions; What-if). Every cost is
 * `money.cost`, the target price `money.price`, a margin `money.margin`: dropped for a caller without the grain (A1 §2.6),
 * and refused when such a caller sends one.
 */

const costText = () => z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Expected a figure above 0, with at most 12 digits and 6 decimals.')
/** A margin percent below 100 (and above −1000), at most 4 decimals. */
const marginText = () => z.string().regex(/^-?\d{1,3}(\.\d{1,4})?$/, 'Expected a percent below 100 with at most 4 decimals.')
const note = () => z.string().trim().min(1).max(2000)
const STATE_FILTER = [...COST_SHEET_STATES, 'ALL'] as const

// ---- the versions of a style ------------------------------------------------------------------------------------------------

export const versionsQuery = input({
  styleId: id(),
  /** The company (a tenant-wide style: left out lists every company the caller sees). */
  companyId: id().optional(),
  /** One season's series (left out: every season and none). */
  seasonId: id().optional(),
  state: z.enum(STATE_FILTER).optional(),
})
export type VersionsQuery = z.output<typeof versionsQuery>

export const versionRow = output({
  id: id(),
  key: z.string(),
  sheetVersion: z.number().int(),
  state: z.enum(COST_SHEET_STATES),
  companyId: id(),
  styleId: id(),
  revision: output({ id: id(), revision: z.number().int() }),
  season: output({ id: id(), code: z.string(), status: z.string() }).nullable(),
  basedOnId: id().nullable(),
  currency: z.string(),
  baseSize: z.string(),
  /** The base size's cost; null while it misses an input. */
  baseCost: money.cost(z.string().nullable()),
  /** The weighted cost of the size mix the version keeps; null without weights or while a weighted size misses an input. */
  weightedCost: money.cost(z.string().nullable()),
  targetPrice: money.price(z.string().nullable()),
  targetMarginPct: money.margin(z.string().nullable()),
  approvedAt: instant().nullable(),
  approvedBy: output({ id: id(), name: z.string() }).nullable(),
  frozenAt: instant().nullable(),
  frozenReason: z.enum(FREEZE_REASONS).nullable(),
  /** The request for its yes: waiting, or the one it was approved on; null when none stands. */
  approval: output({ taskId: id(), status: z.string(), version: z.number().int() }).nullable(),
  createdAt: instant(),
  version: z.number().int(),
})
export type VersionRow = z.infer<typeof versionRow>

export const versionsView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), sizes: z.array(z.string()) }),
  versions: z.array(versionRow),
})

export const weightsView = output({
  /** Where the weights came from when they were kept (null: not said, or none). */
  source: z.enum(WEIGHT_SOURCES).nullable(),
  sizeCurveId: id().nullable(),
  weights: z.record(z.string(), z.string()).nullable(),
  shares: z.array(output({ size: z.string(), weight: z.string(), sharePct: z.string() })),
  weighted: money.cost(z.string().nullable()),
  /** The weighted sizes that miss an input. */
  missing: z.array(z.string()),
})

export const versionRecordView = output({
  sheet: versionRow.extend({ note: z.string().nullable() }),
  sizes: z.array(z.string()),
  lines: z.array(componentLineView.extend({ id: id() })),
  split: z.array(sizeSplitView),
  leftOut: z.array(missingComponentView),
  weights: weightsView,
  can: output({ edit: z.boolean(), remove: z.boolean(), submit: z.boolean(), newVersion: z.boolean(), takeBack: z.boolean() }),
  /** The state in words: what may happen to it now. */
  words: z.string(),
})
export type VersionRecordView = z.infer<typeof versionRecordView>

// ---- a new version ------------------------------------------------------------------------------------------------------------

export const createVersionBody = input({
  styleId: id(),
  /** COMPONENTS: the revision costed (required); COPY: the copied version's (left out, or the same). */
  revisionId: id().optional(),
  /** The style's own company; for a tenant-wide style, required. */
  companyId: id().optional(),
  /** An open season of the company; null or left out: no season (a COPY: the copied version's). */
  seasonId: id().nullable().optional(),
  from: z.enum(VERSION_SOURCES),
  /** COPY: the version copied (required); COMPONENTS: the version it follows (its typed lines kept on the same revision). */
  basedOnId: id().optional(),
  /** A size of the style's range (default: the copied version's, else the style's base size). */
  baseSize: z.string().trim().min(1).max(40).optional(),
  targetPrice: money.price(costText().optional()),
  targetMarginPct: money.margin(marginText().optional()),
  /** A size curve of the style's scale, weighting the cost when the style has no size weights of its own. */
  sizeCurveId: id().optional(),
  note: note().optional(),
  /** COMPONENTS: the colourway, the site of the piece rates, the garments per export carton, and whether to leave missing inputs out. */
  colourwayId: id().optional(),
  siteId: id().optional(),
  piecesPerCarton: z.number().int().min(1).max(10000).optional(),
  leaveOutMissing: z.boolean().optional(),
})
export type CreateVersionBody = z.output<typeof createVersionBody>

export const updateVersionBody = input({
  version: z.number().int().min(1),
  targetPrice: money.price(costText().nullable().optional()),
  targetMarginPct: money.margin(marginText().nullable().optional()),
  sizeCurveId: id().nullable().optional(),
  note: note().nullable().optional(),
  /** Read the style's size weights (else the size curve) again. */
  refreshWeights: z.boolean().optional(),
})
export type UpdateVersionBody = z.output<typeof updateVersionBody>

export const removeVersionQuery = input({ version: z.coerce.number().int().min(1) })

export const submitVersionBody = input({
  version: z.number().int().min(1),
  /** Words for the approver (the request's note). */
  note: z.string().trim().min(1).max(4000).optional(),
  /** The typed lines cover what the components left out (a version written leaving inputs out). */
  coveredByTyped: z.boolean().optional(),
})
export type SubmitVersionBody = z.output<typeof submitVersionBody>

export const takeBackBody = input({
  version: z.number().int().min(1),
  /** Why it is taken back (the audit row keeps it). */
  reason: z.string().trim().min(1).max(500),
})
export type TakeBackBody = z.output<typeof takeBackBody>

export const versionAnswer = output({ sheet: versionRow })

// ---- compare two ------------------------------------------------------------------------------------------------------------

export const compareQuery = input({ a: id(), b: id() })

const compareCell = output({ a: money.cost(z.string().nullable()), b: money.cost(z.string().nullable()), difference: money.cost(z.string().nullable()) })
const compareSide = output({ quantity: z.string(), uom: z.string().nullable(), unitCost: money.cost(z.string()), cost: money.cost(z.string()), pct: money.cost(z.string().nullable()) })

export const compareView = output({
  a: versionRow,
  b: versionRow,
  sizes: z.array(z.string()),
  /** false: the two are in different currencies (their figures are not compared). */
  comparable: z.boolean(),
  sizesCompared: z.array(output({ size: z.string(), total: notMoney(compareCell), categories: z.array(compareCell.extend({ category: z.enum(SHEET_CATEGORIES) })) })),
  lines: z.array(
    output({
      key: z.string(),
      category: z.enum(SHEET_CATEGORIES),
      label: z.string().nullable(),
      size: z.string().nullable(),
      a: compareSide.nullable(),
      b: compareSide.nullable(),
      difference: money.cost(z.string()),
      change: z.enum(LINE_CHANGES),
    }),
  ),
  weighted: compareCell,
  words: z.string(),
})

// ---- what-if ------------------------------------------------------------------------------------------------------------------

export const whatIfChange = input({
  target: z.enum(WHAT_IF_TARGETS),
  category: z.enum(SHEET_CATEGORIES).optional(),
  itemId: id().optional(),
  lineId: id().optional(),
  /** −99.9999 to +1000, at most 4 decimals (leather +10 % is "10"). */
  pct: z.string().regex(/^-?\d{1,4}(\.\d{1,4})?$/, 'Expected a percent with at most 4 decimals.'),
})

export const whatIfBody = input({ changes: z.array(whatIfChange).min(1).max(20) })
export type WhatIfBody = z.output<typeof whatIfBody>

export const saveWhatIfBody = input({ changes: z.array(whatIfChange).min(1).max(20), note: note().optional() })
export type SaveWhatIfBody = z.output<typeof saveWhatIfBody>

export const whatIfView = output({
  sheet: versionRow,
  sizes: z.array(z.string()),
  lines: z.array(
    componentLineView.extend({
      fromId: id(),
      before: output({ unitCost: money.cost(z.string()), cost: money.cost(z.string()), pct: money.cost(z.string().nullable()) }),
      changed: z.boolean(),
    }),
  ),
  sizesCompared: z.array(output({ size: z.string(), total: notMoney(compareCell), categories: z.array(compareCell.extend({ category: z.enum(SHEET_CATEGORIES) })) })),
  weighted: compareCell,
  changed: z.number().int(),
  /** The typed percent lines kept at their amount (their base is unknown). */
  kept: z.array(id()),
  /** The changes (by their place in the list) that reached no line. */
  unmatched: z.array(z.number().int()),
  words: z.string(),
})
