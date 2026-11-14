import { z } from 'zod'
import { amountMinor, businessDate, currency, id, input, instant, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { ITEM_KINDS } from '../../product/materials/rules'
import { WORK_CENTRE_KINDS } from '../../product/routing/operations'
import { REVISION_STATUSES } from '../../product/styles/revisions'
import { UOMS } from '../../product/units/units'
import { MARGIN_PARTS } from '../margins/rules'
import { LINE_SOURCES, SHEET_CATEGORIES } from './components'
import { AREA_UNITS, COMPONENT_INPUT_STATUSES, COMPONENT_MISSING, COMPONENT_WARNINGS, LANDED_AS, UPLIFT_SOURCES, UPLIFT_TARGETS } from './rules'
import { LEDGER_GROUPS } from './split'

/**
 * The contracts of the cost sheet's components (B-W2b-418; FIN-003, FIN-006, FIN-008, FIN-009, FIN-011, FIN-020): what
 * apps/factory-api's modules/costing/sheet-components answers and the web's typed client reads. Every cost — a line's unit
 * cost and cost, a size's split and total, a work order's planned and actual, a workshop's transport — is `money.cost`,
 * dropped for a caller without the cost grain (A1 §2.6); the structure, the minutes, quantities, percents and words stay.
 */

const kind = () => z.enum(WORK_CENTRE_KINDS)
const note = () => z.string().trim().min(1).max(1000)
/** A percent with at most 4 decimals, as typed. */
const percent = () => z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Expected a percent with at most 4 decimals.')
const costText = () => z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Expected 0 or more, with at most 12 digits and 6 decimals.')
const STATUS_FILTER = [...COMPONENT_INPUT_STATUSES, 'ALL'] as const

// ---- the components of a revision ---------------------------------------------------------------------------------------

export const componentsQuery = input({
  /** The company costed: the style's own; for a tenant-wide style, required. */
  companyId: id().optional(),
  /** The colourway costed (a colourway-only BOM line counts only in it); left out: the style's first active colourway. */
  colourwayId: id().optional(),
  /** The site whose piece rates are read when piece-rate labour is on (left out: the only site paying piece rates). */
  siteId: id().optional(),
  /** How many garments an export carton holds (the carton's share per garment). */
  piecesPerCarton: z.coerce.number().int().min(1).max(10000).optional(),
})
export type ComponentsQuery = z.output<typeof componentsQuery>

export const componentLineView = output({
  /** The line's place on a written sheet; null on a computation not written. */
  seq: z.number().int().nullable(),
  category: z.enum(SHEET_CATEGORIES),
  source: z.enum(LINE_SOURCES),
  sourceRecordType: z.string().nullable(),
  sourceRecordId: id().nullable(),
  itemId: id().nullable(),
  workCentreKind: kind().nullable(),
  label: z.string().nullable(),
  /** null: every size. */
  size: z.string().nullable(),
  /** In `uom` for a material; minutes on a LABOUR line costed by time (uom null); 1 on a piece-rate, percent or per-garment line. */
  quantity: z.string(),
  uom: z.enum(UOMS).nullable(),
  unitCost: money.cost(z.string()),
  /** quantity × unit cost, rounded once to 6 places. */
  cost: money.cost(z.string()),
  /** The percent of its base on an overhead, freight or duty line. */
  pct: money.cost(z.string().nullable()),
  note: z.string().nullable(),
})
export type ComponentLineView = z.infer<typeof componentLineView>

export const missingComponentView = output({
  key: z.string(),
  code: z.enum(COMPONENT_MISSING),
  itemId: id().nullable(),
  recordType: z.string().nullable(),
  recordId: id().nullable(),
  size: z.string().nullable(),
  workCentreKind: kind().nullable(),
  /** In words, without a figure. */
  message: z.string(),
})

export const componentWarningView = output({ code: z.enum(COMPONENT_WARNINGS), recordId: id().nullable(), message: z.string() })

export const sizeSplitView = output({
  size: z.string(),
  categories: z.array(output({ category: z.enum(SHEET_CATEGORIES), amount: money.cost(z.string()) })),
  knownTotal: money.cost(z.string()),
  total: money.cost(z.string().nullable()),
  complete: z.boolean(),
})

/** Where each category goes: the work order's ledger kind and the margin part (FIN-020). */
export const ledgerMapView = output({ category: z.enum(SHEET_CATEGORIES), source: z.enum(LINE_SOURCES).nullable(), ledgerGroup: z.enum(LEDGER_GROUPS), marginPart: notMoney(z.enum(MARGIN_PARTS).nullable()) })

const styleRef = output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), baseSize: z.string().nullable() })
const revisionRef = output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) })

export const componentsView = output({
  style: styleRef,
  revision: revisionRef,
  companyId: id(),
  currency: z.string(),
  on: businessDate(),
  colourway: output({ id: id(), code: z.string(), name: z.string() }),
  sizes: z.array(z.string()),
  pieceRate: output({ on: z.boolean(), siteId: id().nullable(), words: z.string() }),
  piecesPerCarton: z.number().int().nullable(),
  lines: z.array(componentLineView),
  split: z.array(sizeSplitView),
  complete: z.boolean(),
  missing: z.array(missingComponentView),
  warnings: z.array(componentWarningView),
  ledger: z.array(ledgerMapView),
  unverified: z.string(),
  computedAt: instant(),
})
export type ComponentsView = z.infer<typeof componentsView>

// ---- a draft sheet's lines written from them -----------------------------------------------------------------------------

export const writeComponentsBody = input({
  version: z.number().int().min(1),
  colourwayId: id().optional(),
  siteId: id().optional(),
  piecesPerCarton: z.number().int().min(1).max(10000).optional(),
  /** Write the lines although inputs are missing (they are left out; the sheet's inputs keep the list). */
  leaveOutMissing: z.boolean().optional(),
})
export type WriteComponentsBody = z.output<typeof writeComponentsBody>

export const costSheetRef = output({
  id: id(),
  key: z.string(),
  sheetVersion: z.number().int(),
  state: z.enum(['DRAFT', 'APPROVED', 'FROZEN']),
  companyId: id(),
  styleId: id(),
  revisionId: id(),
  seasonId: id().nullable(),
  currency: z.string(),
  baseSize: z.string(),
  version: z.number().int(),
})

export const writeComponentsAnswer = output({
  sheet: costSheetRef,
  lines: z.array(componentLineView.extend({ id: id() })),
  split: z.array(sizeSplitView),
  /** The inputs left out (with leaveOutMissing). */
  missing: z.array(missingComponentView),
  warnings: z.array(componentWarningView),
  /** The typed lines kept as they were. */
  keptTyped: z.number().int(),
  unverified: z.string(),
})

/** A written sheet's lines and its split by size and category (FIN-020: the split kept from the sheet). */
export const sheetSplitView = output({
  sheet: costSheetRef,
  sizes: z.array(z.string()),
  lines: z.array(componentLineView.extend({ id: id() })),
  split: z.array(sizeSplitView),
  ledger: z.array(ledgerMapView),
  /** What the components left out when they were written (empty when complete or typed by hand). */
  leftOut: z.array(missingComponentView),
})

// ---- a work order: the sheet, the actuals, the margin part ---------------------------------------------------------------

export const workOrderSplitView = output({
  workOrder: output({ id: id(), number: z.string(), companyId: id(), styleId: id(), revisionId: id().nullable(), garments: z.number().int() }),
  currency: z.string(),
  /** Where the plan came from: the approved cost sheet of the revision and company, else the components computed now. */
  plan: output({ source: z.enum(['APPROVED_SHEET', 'COMPONENTS']), costSheetId: notMoney(id().nullable()), sheetVersion: z.number().int().nullable(), complete: z.boolean(), words: z.string() }),
  rows: z.array(output({ category: z.enum(SHEET_CATEGORIES), ledgerGroup: z.enum(LEDGER_GROUPS), marginPart: notMoney(z.enum(MARGIN_PARTS).nullable()), planned: money.cost(amountMinor()) })),
  groups: z.array(
    output({
      ledgerGroup: z.enum(LEDGER_GROUPS),
      marginPart: notMoney(z.enum(MARGIN_PARTS).nullable()),
      planned: money.cost(amountMinor()),
      actual: money.cost(amountMinor()),
      difference: money.cost(amountMinor()),
      words: z.string(),
    }),
  ),
  materialActual: output({ leather: money.cost(amountMinor()), material: money.cost(amountMinor()), packaging: money.cost(amountMinor()) }),
  planned: money.cost(amountMinor()),
  actual: money.cost(amountMinor()),
  difference: money.cost(amountMinor()),
  notOnLedger: money.cost(amountMinor()),
  missing: z.array(missingComponentView),
})

// ---- leather cost bases (FIN-003) -----------------------------------------------------------------------------------------

export const leatherBasisView = output({
  id: id(),
  companyId: id().nullable(),
  itemId: id(),
  item: output({ code: z.string(), name: z.string() }),
  styleId: id().nullable(),
  key: z.string(),
  areaUnit: z.enum(AREA_UNITS),
  expectedYieldPct: z.string(),
  gradeMix: z.record(z.string(), z.string()),
  validFrom: businessDate(),
  status: z.enum(COMPONENT_INPUT_STATUSES),
  note: z.string().nullable(),
  /** ACTIVE and its first day today or before. */
  inForce: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type LeatherBasisView = z.infer<typeof leatherBasisView>

export const leatherBasesQuery = input({
  companyId: id().optional(),
  itemId: id().optional(),
  styleId: id().optional(),
  status: z.enum(STATUS_FILTER).default('ACTIVE'),
})
export type LeatherBasesQuery = z.output<typeof leatherBasesQuery>

export const createLeatherBasisBody = input({
  /** Left out or null: every company (a role over every company). */
  companyId: id().nullish(),
  itemId: id(),
  /** Left out or null: every style. */
  styleId: id().nullish(),
  areaUnit: z.enum(AREA_UNITS),
  expectedYieldPct: percent(),
  gradeMix: z.record(z.string().trim().min(1).max(20), percent()),
  validFrom: businessDate(),
  note: note().nullish(),
})
export type CreateLeatherBasisBody = z.output<typeof createLeatherBasisBody>

export const updateLeatherBasisBody = input({
  version: z.number().int().min(1),
  areaUnit: z.enum(AREA_UNITS).optional(),
  expectedYieldPct: percent().optional(),
  gradeMix: z.record(z.string().trim().min(1).max(20), percent()).optional(),
  note: note().nullable().optional(),
})
export type UpdateLeatherBasisBody = z.output<typeof updateLeatherBasisBody>

export const archiveBody = input({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(500).optional() })
export type ArchiveBody = z.output<typeof archiveBody>

// ---- uplifts (FIN-008, FIN-009) --------------------------------------------------------------------------------------------

export const upliftView = output({
  id: id(),
  companyId: id().nullable(),
  target: z.enum(UPLIFT_TARGETS),
  itemId: id().nullable(),
  itemKind: z.enum(ITEM_KINDS).nullable(),
  partyId: id().nullable(),
  key: z.string(),
  source: z.enum(UPLIFT_SOURCES),
  freightPct: z.string().nullable(),
  dutyPct: z.string().nullable(),
  insurancePct: z.string().nullable(),
  transportOutPerPiece: money.cost(z.string().nullable()),
  transportBackPerPiece: money.cost(z.string().nullable()),
  currency: z.string().nullable(),
  landedFrom: businessDate().nullable(),
  landedTo: businessDate().nullable(),
  validFrom: businessDate(),
  status: z.enum(COMPONENT_INPUT_STATUSES),
  note: z.string().nullable(),
  inForce: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type UpliftView = z.infer<typeof upliftView>

export const upliftsQuery = input({
  companyId: id().optional(),
  target: z.enum(UPLIFT_TARGETS).optional(),
  itemId: id().optional(),
  itemKind: z.enum(ITEM_KINDS).optional(),
  partyId: id().optional(),
  status: z.enum(STATUS_FILTER).default('ACTIVE'),
})
export type UpliftsQuery = z.output<typeof upliftsQuery>

export const createUpliftBody = input({
  companyId: id().nullish(),
  target: z.enum(UPLIFT_TARGETS),
  /** MATERIAL: the material. */
  itemId: id().nullish(),
  /** CATEGORY: the kind of material. */
  itemKind: z.enum(ITEM_KINDS).nullish(),
  /** WORKSHOP: the workshop (a party with the SUBCONTRACTOR role). */
  partyId: id().nullish(),
  /** LANDED_COST (a material or a kind): the percent is read from the landed cost of the receipts of landedFrom … landedTo. */
  source: z.enum(UPLIFT_SOURCES).default('TYPED'),
  freightPct: percent().nullish(),
  dutyPct: percent().nullish(),
  insurancePct: percent().nullish(),
  transportOutPerPiece: money.cost(costText().nullish()),
  transportBackPerPiece: money.cost(costText().nullish()),
  currency: currency().nullish(),
  landedFrom: businessDate().nullish(),
  landedTo: businessDate().nullish(),
  /** LANDED_COST: which percent the landed cost fills (default FREIGHT: a charge line has no freight / duty split). */
  landedAs: z.enum(LANDED_AS).optional(),
  validFrom: businessDate(),
  note: note().nullish(),
})
export type CreateUpliftBody = z.output<typeof createUpliftBody>

export const updateUpliftBody = input({
  version: z.number().int().min(1),
  freightPct: percent().nullable().optional(),
  dutyPct: percent().nullable().optional(),
  insurancePct: percent().nullable().optional(),
  transportOutPerPiece: money.cost(costText().nullable().optional()),
  transportBackPerPiece: money.cost(costText().nullable().optional()),
  currency: currency().nullable().optional(),
  note: note().nullable().optional(),
})
export type UpdateUpliftBody = z.output<typeof updateUpliftBody>

/** What the landed cost of a window of receipts comes to, before an uplift is made from it. */
export const landedQuery = input({
  companyId: id(),
  itemId: id().optional(),
  itemKind: z.enum(ITEM_KINDS).optional(),
  from: businessDate(),
  to: businessDate(),
})
export type LandedQuery = z.output<typeof landedQuery>

export const landedView = output({
  companyId: id(),
  itemId: id().nullable(),
  itemKind: z.enum(ITEM_KINDS).nullable(),
  from: businessDate(),
  to: businessDate(),
  currency: z.string(),
  lots: z.number().int(),
  receivedAmount: money.cost(amountMinor()),
  landedAmount: money.cost(amountMinor()),
  /** landed ÷ received × 100, 4 places; null when nothing was received. */
  pct: money.cost(z.string().nullable()),
  words: z.string(),
})

// ---- piece-rate labour (FIN-006, GATE-PIECE-PAY) ---------------------------------------------------------------------------

export const pieceRateLabourQuery = input({ companyId: id() })

export const pieceRateLabourView = output({
  companyId: id(),
  on: z.boolean(),
  onAt: instant().nullable(),
  /** The sites of the company that pay piece rates today (GATE-PIECE-PAY). */
  payingSites: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  settingsVersion: z.number().int().nullable(),
  can: output({ manage: z.boolean(), switchOn: z.boolean() }),
  words: z.string(),
})

export const setPieceRateLabourBody = input({
  companyId: id(),
  on: z.boolean(),
  /** The company's own settings row's version (left out when it has none yet). */
  version: z.number().int().min(1).optional(),
})
export type SetPieceRateLabourBody = z.output<typeof setPieceRateLabourBody>
