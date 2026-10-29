import { isBusinessDate, type BusinessDate } from '../../core/time'
import type { RowIssue, RowValues } from '../../imports/importer'
import { baseFactor, convertibleUnits, dimensionOf, type ItemUnits, type Uom } from '../../product/units/units'
import {
  CR_VI_EVIDENCE,
  resultEffect,
  resultProblems,
  type CrViEvidence,
  type CrViResultInput,
  type CrViVerdict,
  type EvidenceRule,
  type ResultEffect,
} from '../../quality/lab/rules'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'
import { quantityText, type ItemTracking } from '../ledger/moves'
import { baseQuantityOf } from '../ledger/units'
import { HIDE_AREA_UNITS, lotStart, MAX_THICKNESS_MM, type LotStart } from '../receipts/rules'

/**
 * Opening stock (B-W1-35; SCM-288, QHS-029; PLAN R-14, Q14), pure: what the stock on hand before the factory app is,
 * row by row of an imported sheet, and what one row posts. The importer (./importer.ts) parses the cells; the API
 * (apps/factory-api modules/inventory/opening) reads the facts a row names — its site, location, material, colour,
 * supplier, report file, PPE certificate and the opening lot it joins — and both its dry run (the imports engine's
 * `check`) and its apply (`write`) judge the row here, so a row the dry run accepts is written exactly as planned.
 *
 *   a row      one line of the count: its own reference (`line`, unique among the company's opening stock: a line
 *              imported once is never posted again), the site, location and material, the colour (when the material has
 *              colours), the lot (the supplier's lot or dye batch, for a material tracked by lot or hide), the quantity
 *              and its unit. Leather (tracked hide by hide): one row per hide with its measured area as the quantity,
 *              or one row per lot with every hide's area in `areas` (`5,20; 4,85`); never a count times an average.
 *   the lot    the rows of one site, material, colour and lot code are ONE opening lot (numbered from the company's LOT
 *              series): the first row makes it, the next ones add their hides or quantity (also in a later import, while
 *              the lot is in quarantine). The lot starts as the receipts rules say (lotStart): QUARANTINE when it needs
 *              the chromium VI test or is a certified PPE component, else RELEASED (it needs no quality step).
 *   the report the existing chromium VI test report of the lot (REACH Annex XVII entry 47): the measured value, or "not
 *              detected" with the detection limit, the method, lab, test day, evidence (a lab report on the lot, or the
 *              supplier's report covering the article and a period that holds the lot's receipt day: Q14's rule in
 *              force decides what counts), the report's PDF uploaded beforehand to the company's opening-stock reports.
 *              The lab step's rules judge it (resultProblems, resultEffect); its LabResult is recorded with the lot.
 *              A lot with a PASS stays in QUARANTINE: the import NEVER releases a lot that needs the quality step. A
 *              quality person who did not import it releases it through B-W1-34 (the importer is Lot.createdById, so
 *              the four-eyes check RELEASER stops them). No report: QUARANTINE, Cr VI PENDING.
 *   a PPE      a certified PPE component may name its certificate in the register; it must be a VALID one covering the
 *              material today. The lot still waits in quarantine for the supplier's document (the lab step).
 *   the value  the given unit cost (per the row's unit; the cost grain) as MANUAL, else the material's standard cost
 *              (STANDARD_COST), per base unit; neither: the move stays unvalued, as the ledger allows.
 */

export const OPENING_IMPORTER_KEY = 'inventory.opening'

export const OPENING_LIMITS = Object.freeze({ hidesPerRow: 100, code: 60, text: 200, defects: 1000, fileName: 255 })

/** The record type of the company's opening-stock report files (CERTIFICATE files; record id = the company's id). */
export const OPENING_REPORTS_RECORD = 'OpeningStock'

/** The ledger's idempotency key of a line's n-th move (from 1): a line is posted once, whatever the import. */
export const openingMoveKey = (companyId: string, line: string, n: number): string => `${openingLinePrefix(companyId, line)}${n}`
export const openingLinePrefix = (companyId: string, line: string): string => `inventory.opening:${companyId}:${line}:`

/** The columns of the existing test report; any of them given means the row brings a report. */
export const REPORT_COLUMNS = ['crViMgKg', 'detectionLimitMgKg', 'crViMethod', 'lab', 'reportNumber', 'testedOn', 'evidence', 'article', 'periodFrom', 'periodTo', 'reportFile'] as const
/** The columns of a hide (leather only). */
export const HIDE_COLUMNS = ['areas', 'hides', 'hideNumber', 'grade', 'thicknessMm', 'defects'] as const
/** What a lot is, as one row says it: the rows of one lot must not say different things. */
export const LOT_LEVEL_COLUMNS = ['supplier', 'dyeBatch', 'shade', 'receivedOn'] as const

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : typeof value === 'number' ? String(value) : null)
const given = (values: RowValues, column: string): boolean => values[column] !== undefined

/** The hide areas of an `areas` cell as the importer stores it ("5.2;4.85"). */
export const areasOf = (values: RowValues): string[] => (text(values.areas) ?? '').split(';').filter((part) => part !== '')

/** One lot of the sheet: site, material, colour and lot code (null: the row has no lot). */
export function lotKeyOf(values: RowValues): string | null {
  const lot = text(values.lot)
  return lot === null ? null : JSON.stringify([text(values.site), text(values.item), text(values.colour), lot])
}

// ---- the facts a row names (read by the API) ----------------------------------------------------------------------------

export interface OpeningItem {
  readonly id: string
  readonly code: string
  readonly active: boolean
  /** Of another company than the import's (a tenant-wide material is the import's own). */
  readonly foreign: boolean
  readonly tracking: ItemTracking
  readonly units: ItemUnits
  readonly requiresCrViTest: boolean
  readonly crViLimitMgKg: string | null
  readonly isPpeComponent: boolean
  /** Per base unit, in the material's currency; null: none. */
  readonly standardCost: string | null
  readonly colours: readonly { readonly id: string; readonly code: string; readonly active: boolean }[]
}

/** A chromium VI result as the lab step stores it (LabResult), for comparing a row's report with a lot's. */
export interface OpeningResult {
  readonly method: string
  readonly valueMgKg: string | null
  readonly belowDetectionLimit: boolean
  readonly detectionLimitMgKg: string | null
  readonly lab: string
  readonly reportNumber: string | null
  readonly testedOn: string
  readonly evidence: CrViEvidence
  readonly article: string | null
  readonly periodFrom: string | null
  readonly periodTo: string | null
  readonly fileId: string
}

/** An opening lot (no receipt line) of the row's site, material, colour and lot code, made by an earlier row. */
export interface OpeningLot {
  readonly id: string
  readonly code: string
  readonly supplierId: string | null
  readonly dyeBatch: string | null
  readonly shade: string | null
  readonly receivedDay: BusinessDate | null
  readonly qualityStatus: 'QUARANTINE' | 'RELEASED' | 'REJECTED' | 'BLOCKED'
  readonly requiresCrViTest: boolean
  readonly crViStatus: 'NOT_REQUIRED' | 'PENDING' | 'PASS' | 'FAIL'
  readonly crViLimitMgKg: string | null
  /** Its newest result (the lab step's history), or null. */
  readonly result: OpeningResult | null
  /** The tannery numbers of its hides. */
  readonly hideNumbers: readonly string[]
}

export interface OpeningFacts {
  /** The site of the row's code in the import's company; `reachable`: the person's role reaches it for opening stock. */
  readonly site: { readonly id: string; readonly code: string; readonly reachable: boolean } | null
  readonly location: { readonly id: string; readonly code: string; readonly active: boolean } | null
  readonly item: OpeningItem | null
  /** The party of the row's supplier code (the import's company or every company); null: none (or not named). */
  readonly supplier: { readonly id: string; readonly code: string; readonly isSupplier: boolean; readonly active: boolean } | null
  /** The report file the row names: one AVAILABLE report of the company, none, or several of that name. */
  readonly report: { readonly id: string } | 'NONE' | 'SEVERAL' | null
  /** The named PPE certificate is VALID today and covers the material (null: not named). */
  readonly certificateCovers: boolean | null
  readonly lot: OpeningLot | null
  readonly rule: EvidenceRule
  readonly today: BusinessDate
}

// ---- what a row posts -----------------------------------------------------------------------------------------------------

export interface PlannedHide {
  /** As measured, in the row's unit, four decimals. */
  readonly area: string
  /** In the material's base unit. */
  readonly baseArea: string
  readonly supplierCode: string | null
  readonly grade: string | null
  readonly thicknessMm: string | null
  readonly defects: string | null
}

export type PlannedLot =
  | {
      readonly kind: 'NEW'
      readonly start: LotStart
      readonly supplierLotRef: string
      readonly dyeBatch: string | null
      readonly shade: string | null
      readonly supplierId: string | null
      readonly receivedOn: BusinessDate | null
    }
  | { readonly kind: 'JOIN'; readonly lotId: string; readonly code: string }

export interface PlannedResult {
  readonly input: CrViResultInput
  readonly verdict: CrViVerdict
  readonly effect: ResultEffect
  readonly fileId: string
}

export interface OpeningPlan {
  readonly unit: Uom
  /** The day the stock stood there (the moves' day); null: the apply's time. */
  readonly stockDate: BusinessDate | null
  readonly lot: PlannedLot | null
  /** Leather: the hides, each one move. */
  readonly hides: readonly PlannedHide[]
  /** As entered in `unit` (leather: the hides' sum), four decimals. */
  readonly quantity: string
  readonly baseQuantity: string
  /** Per base unit: the given cost (MANUAL) or the standard cost; null: unvalued. */
  readonly cost: { readonly method: 'MANUAL' | 'STANDARD_COST'; readonly unitCost: string } | null
  /** The result to record with the lot; null: no report, or the lot holds this very result already. */
  readonly result: PlannedResult | null
}

const issue = (column: string | undefined, message: string): RowIssue => (column ? { column, message } : { message })

/** The sheet's report columns of a lab-step path (resultProblems' paths). */
const REPORT_PATHS: Readonly<Record<string, string>> = Object.freeze({
  method: 'crViMethod',
  valueMgKg: 'crViMgKg',
  detectionLimitMgKg: 'detectionLimitMgKg',
  lab: 'lab',
  reportNumber: 'reportNumber',
  testedOn: 'testedOn',
  evidence: 'evidence',
  article: 'article',
  periodFrom: 'periodFrom',
  periodTo: 'periodTo',
})

/** The report a row gives, as the lab step reads it. Evidence left blank: a supplier report when it names an article or a period. */
export function reportInputOf(values: RowValues): CrViResultInput {
  const evidence = text(values.evidence) ?? (['article', 'periodFrom', 'periodTo'].some((column) => given(values, column)) ? 'SUPPLIER_REPORT' : 'LOT_REPORT')
  const value = text(values.crViMgKg)
  const lod = text(values.detectionLimitMgKg)
  return {
    method: text(values.crViMethod) ?? '',
    valueMgKg: value,
    belowDetectionLimit: value === null && lod !== null,
    detectionLimitMgKg: lod,
    lab: text(values.lab) ?? '',
    reportNumber: text(values.reportNumber),
    testedOn: text(values.testedOn) ?? '',
    evidence: evidence as CrViEvidence,
    article: text(values.article),
    periodFrom: text(values.periodFrom),
    periodTo: text(values.periodTo),
  }
}

const sameDecimal = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : new Dec(a).equals(new Dec(b)))

/** A row's report is the result a lot holds already (the same report repeated on every row of the lot). */
export function sameResult(result: OpeningResult, input: CrViResultInput, verdict: CrViVerdict, fileId: string): boolean {
  return (
    result.fileId === fileId &&
    result.method === input.method &&
    result.belowDetectionLimit === verdict.belowDetectionLimit &&
    sameDecimal(result.valueMgKg, verdict.valueMgKg) &&
    sameDecimal(result.detectionLimitMgKg, verdict.detectionLimitMgKg) &&
    result.lab === input.lab.trim() &&
    (result.reportNumber ?? null) === (input.reportNumber ?? null) &&
    result.testedOn === input.testedOn &&
    result.evidence === input.evidence &&
    (result.article ?? null) === (input.article ?? null) &&
    (result.periodFrom ?? null) === (input.periodFrom ?? null) &&
    (result.periodTo ?? null) === (input.periodTo ?? null)
  )
}

/**
 * Everything wrong with one row against the facts it names (every problem at once, each on its column), or what it
 * posts. Cells were parsed and checked on their own already (the importer's types and `validateRow`).
 */
export function planOpeningRow(values: RowValues, facts: OpeningFacts): { readonly problems: readonly RowIssue[]; readonly plan: OpeningPlan | null } {
  const problems: RowIssue[] = []
  const site = text(values.site)!
  const location = text(values.location)!
  const itemCode = text(values.item)!
  const unit = text(values.unit) as Uom
  const lotCode = text(values.lot)
  const colourCode = text(values.colour)

  if (!facts.site) problems.push(issue('site', `Site ${site} is not a site of this company.`))
  else if (!facts.site.reachable) problems.push(issue('site', `Your role does not reach site ${site} for opening stock (inventory.opening.import).`))
  else if (!facts.location) problems.push(issue('location', `Location ${location} is not a location of site ${site}.`))
  else if (!facts.location.active) problems.push(issue('location', `Location ${location} is archived: it takes no stock.`))

  const stockDate = text(values.stockDate)
  const receivedOn = text(values.receivedOn)
  if (stockDate !== null && stockDate > facts.today) problems.push(issue('stockDate', `The stock date ${stockDate} is after today (${facts.today}).`))
  if (receivedOn !== null && receivedOn > facts.today) problems.push(issue('receivedOn', `The day received ${receivedOn} is after today (${facts.today}).`))

  const item = facts.item
  if (!item) {
    problems.push(issue('item', `Material ${itemCode} does not exist: import it with the materials first.`))
    return { problems, plan: null }
  }
  if (item.foreign) problems.push(issue('item', `Material ${itemCode} is another company's: import its stock with that company.`))
  if (!item.active) problems.push(issue('item', `Material ${itemCode} is archived: reactivate it before importing its stock.`))

  // The colour: a material with colours has one per lot and per stock row; one without has none.
  const activeColours = item.colours.filter((colour) => colour.active)
  const colour = colourCode === null ? null : (item.colours.find((entry) => entry.code === colourCode) ?? null)
  if (colourCode === null && activeColours.length > 0) {
    problems.push(issue('colour', `Material ${itemCode} comes in colours (${activeColours.map((entry) => entry.code).join(', ')}): name the colour.`))
  } else if (colourCode !== null && item.colours.length === 0) {
    problems.push(issue('colour', `Material ${itemCode} has no colours: leave the colour blank.`))
  } else if (colourCode !== null && (!colour || !colour.active)) {
    problems.push(issue('colour', `${colourCode} is not ${colour ? 'an active' : 'a'} colour of material ${itemCode}.`))
  }

  // The tracking decides the row's shape: a lot for LOT and HIDE, hides one by one for HIDE.
  const tracked = item.tracking === 'LOT' || item.tracking === 'HIDE'
  const byHide = item.tracking === 'HIDE'
  if (tracked && lotCode === null) problems.push(issue('lot', `Material ${itemCode} is tracked by ${item.tracking === 'HIDE' ? 'hide' : 'lot'}: give the lot (the supplier's lot or dye batch).`))
  if (!tracked) {
    for (const column of ['lot', 'dyeBatch', 'shade', 'supplier', 'receivedOn'] as const) {
      if (given(values, column)) problems.push(issue(column, `Material ${itemCode} is not tracked by lot: leave ${column === 'lot' ? 'the lot' : 'this column'} blank.`))
    }
  }
  if (!byHide) {
    for (const column of HIDE_COLUMNS) if (given(values, column)) problems.push(issue(column, `Only leather tracked hide by hide has hides: material ${itemCode} is tracked by ${item.tracking}; leave this column blank.`))
  }

  // Quantities in the material's base unit.
  const hides: PlannedHide[] = []
  let quantity = ZERO
  let baseQuantity = ZERO
  const converts = unit === item.units.baseUom || (dimensionOf(unit) !== 'ITEM' && baseFactor(unit, item.units) !== null)
  const notAnArea = byHide && !HIDE_AREA_UNITS.includes(unit)
  if (!converts && !notAnArea) {
    problems.push(
      issue('unit', `${dimensionOf(unit) === 'ITEM' ? `A ${unit} has no fixed size` : `Material ${itemCode} does not convert ${unit} to its stock unit ${item.units.baseUom}`}: give the quantity in ${convertibleUnits(item.units).filter((uom) => uom === item.units.baseUom || dimensionOf(uom) !== 'ITEM').join(', ')}.`),
    )
  }
  const base = (amount: string): string | null => {
    if (!converts) return null
    const result = baseQuantityOf({ quantity: amount, uom: unit }, item.units)
    return result.problem ? null : quantityText(result.baseQuantity)
  }
  if (byHide) {
    if (notAnArea) problems.push(issue('unit', `A hide is measured in m², dm² or ft²: give material ${itemCode}'s areas in M2, DM2 or FT2.`))
    else {
      const areas = given(values, 'areas') ? areasOf(values) : [text(values.quantity)!]
      const hideNumber = text(values.hideNumber)
      if (hideNumber !== null && areas.length > 1) problems.push(issue('hideNumber', 'A hide number goes with one hide per row: give each numbered hide its own row.'))
      const thickness = text(values.thicknessMm)
      if (thickness !== null && (new Dec(thickness).lessThanOrEqualTo(0) || new Dec(thickness).greaterThan(MAX_THICKNESS_MM))) {
        problems.push(issue('thicknessMm', `A thickness above 0 and at most ${MAX_THICKNESS_MM} mm.`))
      }
      for (const area of areas) {
        const baseArea = base(area)
        if (baseArea === null) break
        hides.push({ area: quantityText(area), baseArea, supplierCode: hideNumber, grade: text(values.grade), thicknessMm: thickness === null ? null : new Dec(thickness).toFixed(2), defects: text(values.defects) })
        quantity = quantity.plus(area)
        baseQuantity = baseQuantity.plus(baseArea)
      }
    }
  } else {
    const amount = text(values.quantity)
    if (amount !== null) {
      const baseAmount = base(amount)
      if (baseAmount !== null) {
        quantity = new Dec(amount)
        baseQuantity = new Dec(baseAmount)
        if (baseQuantity.lessThanOrEqualTo(0)) problems.push(issue('quantity', `${quantityText(amount)} ${unit} is 0 ${item.units.baseUom} once in the material's stock unit: give a larger quantity.`))
      }
    }
  }

  // The supplier (the lot's).
  if (tracked && given(values, 'supplier')) {
    const code = text(values.supplier)
    if (!facts.supplier) problems.push(issue('supplier', `${code} is not a party of this company.`))
    else if (!facts.supplier.isSupplier) problems.push(issue('supplier', `${code} is not a supplier.`))
    else if (!facts.supplier.active) problems.push(issue('supplier', `Supplier ${code} is not active.`))
  }

  // The PPE certificate in the register.
  if (given(values, 'certificate')) {
    if (!item.isPpeComponent) problems.push(issue('certificate', `Material ${itemCode} is not a certified PPE component: leave the certificate blank.`))
    else if (facts.certificateCovers !== true) {
      problems.push(issue('certificate', `No valid certificate ${text(values.certificate)} in the register covers material ${itemCode} today (Reg. (EU) 2016/425): register it in Compliance › Certificates, or leave the column blank (the lot then waits in quarantine for it).`))
    }
  }

  // The lot: a new one (lotStart, the receipts rules), or the opening lot an earlier row made.
  let lot: PlannedLot | null = null
  const existing = facts.lot
  if (tracked && lotCode !== null) {
    if (existing) {
      const needsChecks = existing.requiresCrViTest || item.isPpeComponent
      if (existing.qualityStatus !== 'QUARANTINE' && !(existing.qualityStatus === 'RELEASED' && !needsChecks)) {
        problems.push(issue('lot', `Lot ${existing.code} (${lotCode}) is ${existing.qualityStatus.toLowerCase()} already: stock added to it would skip the quality step. Give these goods a lot code of their own.`))
      }
      if (given(values, 'supplier') && facts.supplier && facts.supplier.id !== existing.supplierId) problems.push(issue('supplier', `Lot ${existing.code} (${lotCode}) came ${existing.supplierId ? 'from another supplier' : 'without a supplier'}: one lot has one supplier.`))
      if (given(values, 'dyeBatch') && text(values.dyeBatch) !== existing.dyeBatch) problems.push(issue('dyeBatch', `Lot ${existing.code} (${lotCode}) has ${existing.dyeBatch ? `dye batch ${existing.dyeBatch}` : 'no dye batch'}: one lot is one dye batch.`))
      if (given(values, 'shade') && text(values.shade) !== existing.shade) problems.push(issue('shade', `Lot ${existing.code} (${lotCode}) has ${existing.shade ? `shade ${existing.shade}` : 'no shade'}.`))
      if (receivedOn !== null && receivedOn !== existing.receivedDay) problems.push(issue('receivedOn', `Lot ${existing.code} (${lotCode}) was received on ${existing.receivedDay ?? 'an unknown day'}.`))
      const number = text(values.hideNumber)
      if (number !== null && existing.hideNumbers.includes(number)) problems.push(issue('hideNumber', `Lot ${existing.code} (${lotCode}) has a hide numbered ${number} already.`))
      lot = { kind: 'JOIN', lotId: existing.id, code: existing.code }
    } else {
      lot = {
        kind: 'NEW',
        start: lotStart({ itemRequiresCrViTest: item.requiresCrViTest, itemCrViLimitMgKg: item.crViLimitMgKg, lineRequiresCrViTest: false, isPpeComponent: item.isPpeComponent, holdReason: null }),
        supplierLotRef: lotCode,
        dyeBatch: text(values.dyeBatch),
        shade: text(values.shade),
        supplierId: given(values, 'supplier') ? (facts.supplier?.id ?? null) : null,
        receivedOn: receivedOn ?? stockDate,
      }
    }
  }

  // The existing report.
  let result: PlannedResult | null = null
  const reportColumn = REPORT_COLUMNS.find((column) => given(values, column))
  if (reportColumn !== undefined) {
    if (!item.requiresCrViTest) problems.push(issue(reportColumn, `Material ${itemCode} needs no chromium VI test: leave the report columns blank.`))
    else if (!tracked) problems.push(issue(reportColumn, `Material ${itemCode} has no lots: a chromium VI result belongs to a lot.`))
    else if (lot !== null) {
      const input = reportInputOf(values)
      if (!given(values, 'reportFile')) problems.push(issue('reportFile', "Name the report's file: upload its PDF to the company's opening-stock reports first."))
      else if (facts.report === 'NONE' || facts.report === null) problems.push(issue('reportFile', `No opening-stock report of this company is named ${text(values.reportFile)}: upload it first.`))
      else if (facts.report === 'SEVERAL') problems.push(issue('reportFile', `Several opening-stock reports of this company are named ${text(values.reportFile)}: upload this one again under a name of its own.`))
      if (input.valueMgKg !== null && input.detectionLimitMgKg !== null) {
        problems.push(issue('detectionLimitMgKg', 'Give the measured chromium VI, or the detection limit when it was not detected: not both.'))
      } else if (!(CR_VI_EVIDENCE as readonly string[]).includes(input.evidence)) {
        problems.push(issue('evidence', `Expected ${CR_VI_EVIDENCE.join(' or ')}.`))
      } else {
        const limitMgKg = lot.kind === 'JOIN' ? existing!.crViLimitMgKg : lot.start.crViLimitMgKg
        const receivedDay = lot.kind === 'JOIN' ? existing!.receivedDay : (receivedOn ?? stockDate ?? facts.today)
        const checked = resultProblems(input, { limitMgKg: limitMgKg!, rule: facts.rule, lotCode: lot.kind === 'JOIN' ? `${lot.code} (${lotCode})` : lotCode!, receivedDay: receivedDay && isBusinessDate(receivedDay) ? receivedDay : null, today: facts.today })
        for (const problem of checked.problems) {
          const column = REPORT_PATHS[problem.path.split('/')[0] ?? '']
          problems.push(issue(column, problem.message))
        }
        const verdict = checked.verdict
        const fileId = typeof facts.report === 'object' && facts.report !== null ? facts.report.id : null
        if (verdict && fileId) {
          if (lot.kind === 'JOIN' && existing!.result) {
            if (!sameResult(existing!.result, input, verdict, fileId)) {
              problems.push(issue(reportColumn, `Lot ${existing!.code} (${lotCode}) has another chromium VI result already: give the same report on every row of a lot, or leave the report columns blank.`))
            }
          } else {
            const lotFacts = lot.kind === 'JOIN' ? { code: existing!.code, qualityStatus: existing!.qualityStatus, requiresCrViTest: existing!.requiresCrViTest, crViStatus: existing!.crViStatus } : { code: lotCode!, qualityStatus: lot.start.qualityStatus, requiresCrViTest: lot.start.requiresCrViTest, crViStatus: lot.start.crViStatus }
            const effect = resultEffect(lotFacts, verdict.verdict)
            if (typeof effect === 'string') problems.push(issue(reportColumn, effect))
            else result = { input, verdict, effect, fileId }
          }
        }
      }
    }
  }

  if (problems.length > 0) return { problems, plan: null }

  // The value: the given unit cost per the row's unit, as per base unit; else the standard cost.
  let cost: OpeningPlan['cost'] = null
  const unitCost = text(values.unitCost)
  if (unitCost !== null) {
    const factor = baseFactor(unit, item.units)!
    cost = { method: 'MANUAL', unitCost: new Dec(unitCost).dividedBy(factor).toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6) }
  } else if (item.standardCost !== null) {
    cost = { method: 'STANDARD_COST', unitCost: new Dec(item.standardCost).toFixed(6) }
  }
  return {
    problems: [],
    plan: { unit, stockDate, lot, hides, quantity: quantityText(quantity), baseQuantity: quantityText(baseQuantity), cost, result },
  }
}

/**
 * Problems between the rows of one batch: the rows of one lot (site, material, colour, lot code) must not say different
 * things about the lot (supplier, dye batch, shade, day received, the report), and its hides have different numbers.
 * The later row is the one refused (the first one that says it stands). Answers one list per row, in order.
 */
export function lotGroupProblems(rows: readonly { readonly rowNumber: number; readonly values: RowValues }[]): RowIssue[][] {
  const groups = new Map<string, { said: Map<string, { value: string; rowNumber: number }>; numbers: Map<string, number> }>()
  return rows.map(({ rowNumber, values }) => {
    const key = lotKeyOf(values)
    if (key === null) return []
    const group = groups.get(key) ?? { said: new Map(), numbers: new Map() }
    groups.set(key, group)
    const problems: RowIssue[] = []
    const lot = text(values.lot)
    const check = (name: string, value: string | null, column: string, what: string) => {
      if (value === null) return
      const first = group.said.get(name)
      if (!first) group.said.set(name, { value, rowNumber })
      else if (first.value !== value) problems.push(issue(column, `Row ${first.rowNumber} gives lot ${lot} ${what}: the rows of one lot say the same.`))
    }
    for (const column of LOT_LEVEL_COLUMNS) check(column, text(values[column]), column, `another ${column === 'receivedOn' ? 'day received' : column === 'dyeBatch' ? 'dye batch' : column}`)
    const reportColumn = REPORT_COLUMNS.find((column) => given(values, column))
    if (reportColumn !== undefined) check('$report', JSON.stringify(REPORT_COLUMNS.map((column) => text(values[column]))), reportColumn, 'another chromium VI report')
    const number = text(values.hideNumber)
    if (number !== null) {
      const first = group.numbers.get(number)
      if (first !== undefined) problems.push(issue('hideNumber', `Row ${first} has hide ${number} of lot ${lot} already.`))
      else group.numbers.set(number, rowNumber)
    }
    return problems
  })
}

/** "37 hides · 412.5 m²", or "120 m": what a set of opening rows or lots holds, never across units. */
export function stockWords(totals: readonly { readonly baseUom: string; readonly quantity: Decimal | string; readonly hides: number }[]): string {
  const byUnit = new Map<string, { quantity: Decimal; hides: number }>()
  for (const total of totals) {
    const entry = byUnit.get(total.baseUom) ?? { quantity: ZERO, hides: 0 }
    byUnit.set(total.baseUom, { quantity: entry.quantity.plus(total.quantity), hides: entry.hides + total.hides })
  }
  return [...byUnit.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([uom, entry]) => `${entry.hides > 0 ? `${entry.hides} hide${entry.hides === 1 ? '' : 's'} · ` : ''}${entry.quantity.toFixed()} ${UNIT_WORDS[uom] ?? uom}`)
    .join(' · ')
}

const UNIT_WORDS: Readonly<Record<string, string>> = Object.freeze({ M2: 'm²', DM2: 'dm²', FT2: 'ft²', M: 'm', CM: 'cm', MM: 'mm', PCS: 'pcs', KG: 'kg', G: 'g', L: 'l' })
