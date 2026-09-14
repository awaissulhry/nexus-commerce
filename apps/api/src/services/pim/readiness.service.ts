/**
 * PES.5 — ONE definition of "is this row ready for this coordinate".
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Before it there were TWO validators. `listing-preflight.service.ts` held the
 * real ones — pure, unit-tested, and used by the flat-file editor and the
 * Amazon cockpit. The sheet's `computeReadiness()` re-implemented a subset
 * inline, and NOTHING in `services/pim/` imported the real ones (verified
 * 2026-09-01). So the sheet's readiness pill and the publish path could — and
 * did — disagree about the same product.
 *
 * What the sheet's copy was missing, measured against the shipped preflight:
 *
 *   • checkGpsrCompliance   — GPSR/DSA. NINE of the twenty active Marketplace
 *                             rows are GPSR EU markets (IT DE FR ES BE NL SE PL,
 *                             + IE/UK non-GPSR). Entirely absent from the sheet.
 *   • validateGtin          — mod-10. A malformed EAN read "ready".
 *   • checkRequiredWithParent — required-if-present sub-attributes.
 *   • checkDeprecatedValues   — present in the sheet, but hand-rolled.
 *
 * This module owns the delegation so there is exactly one answer, and
 * `sheet-rows.computeReadiness()` calls it. MS.5's publish preview reads that
 * same function, so the preview inherits the fix rather than needing its own.
 *
 * ── What is deliberately NOT delegated: the severity policy ─────────────────
 * `checkEnumValues` grades an off-list value on a CLOSED list (`selectionOnly`)
 * as an ERROR. The sheet's long-standing and deliberate policy is the opposite:
 *
 *   "An off-list value on a closed list is a WARNING, never a block — the
 *    operator may know something the cached schema does not, and Amazon is the
 *    one that decides."                       (sheet-rows.service.ts, MS.2)
 *
 * That is a product decision about a CACHED schema's authority, not a bug, and
 * silently flipping it would start blocking publish previews that work today.
 * So the value check is delegated (one implementation of "is this value in the
 * set") and the grading stays here, named and visible, by passing
 * `selectionOnly: false`. If the policy is ever revisited, this is the line.
 *
 * ── Honest scope of the GPSR check on THIS surface ──────────────────────────
 * `checkGpsrCompliance` reads flat-file column ids. The sheet's column keys are
 * the same key space (measured: `item_name`, `gpsr_safety_attestation`,
 * `dsa_responsible_party_address` are all live sheet keys), but the sheet does
 * NOT carry `gpsr_manufacturer_reference` or the `compliance_media__*`
 * sub-columns. `applicableColumns` is therefore passed as the sheet's real key
 * set, and the checker skips what is absent — by its own documented contract
 * ("a check only runs when its fields exist on the type").
 *
 * So this surface gets PARTIAL GPSR coverage, and says so. The remaining checks
 * live where those columns exist, in the flat-file preflight. Claiming full
 * coverage here would be the exact dishonesty this module is fixing.
 */
import { translationMissing } from './content-resolver.js'
import type { ResolvedValue } from './attribute-resolver.js'
import {
  checkDeprecatedValues,
  checkEnumValues,
  checkGpsrCompliance,
  checkLengthLimits,
  findMissingRequired,
  validateGtin,
  type DeprecatedEnumColumn,
  type EnumColumn,
  type LengthColumn,
  type PreflightIssue,
  type RequiredColumn,
} from '../listing-preflight.service.js'
import { columnApplies, columnRequiredHere, columnForCategory, dictionaryCondition } from '@nexus/shared/master-sheet'
import type { SheetColumn, SheetCoordinate } from './sheet-columns.service.js'
import { coerceForShape, isBlankValue, readListValue, readMeasureValue } from './sheet-values.js'

/** The row shape the validators consume: a flat key → value map. */
export type FlatRow = Record<string, unknown>

/**
 * The per-coordinate validator inputs, derived ONCE per (columns, coordinate)
 * and reused for every row. Deriving these per row is what made the older
 * per-product surfaces unusable at sheet scale.
 */
export interface CoordinateValidators {
  languages?: readonly string[]
  constraints?: SheetColumn[]
  required: RequiredColumn[]
  /**
   * AM.1 — required LISTS, evaluated on the whole list rather than on one cell: a bounded list is
   * served as slot columns (`slotKeys`), an unbounded one as one array-valued column (`slotKeys`
   * holds the single key). Required is satisfied by ≥ `min` non-empty items, never by every slot.
   */
  requiredLists: Array<{ key: string; label: string; slotKeys: string[]; min: number }>
  /** AM.1 — required MEASURES: a value alone or a unit alone is not a measure. */
  requiredMeasures: Array<{ key: string; label: string }>
  /** Per-item length checks for array-valued (unbounded list) columns. */
  listLengths: Array<{ key: string; label: string; maxLength?: number; maxUtf8ByteLength?: number }>
  lengths: LengthColumn[]
  enums: EnumColumn[]
  deprecated: DeprecatedEnumColumn[]
  /** Every key the sheet actually carries — bounds the GPSR check honestly. */
  applicableColumns: Set<string>
  /** Identifier columns to run the mod-10 check over. */
  gtinKeys: string[]
  marketplace: string
  /** e.g. "Amazon · IT" — a required-field message must name WHO demands it. */
  coordinateLabel: string
  /**
   * The row's product type, or null. NULL is a first-class problem, not a
   * neutral absence: without it no channel schema resolves, so every
   * schema-derived required field silently evaluates to "not required" and the
   * row reads as ready when nothing about it has actually been checked.
   * Measured on prod 2026-09-01: 42 products carry a null productType.
   */
  productType: string | null
  requiresCategory?: boolean
}

/** Columns whose value is a GTIN/EAN/UPC and must pass mod-10. */
const GTIN_KEYS = new Set(['gtin', 'ean', 'upc', 'externally_assigned_product_identifier'])

/**
 * Build the validator inputs for one coordinate.
 *
 * `productType` narrows `requiredBy` the same way the grid does, so a row of a
 * type that does not define a column is never told the column is required —
 * the defect that makes an operator stop trusting the readiness pill.
 */
export function buildCoordinateValidators(
  columns: SheetColumn[],
  coordinate: SheetCoordinate,
  row: { isParent: boolean; productType: string | null; familyId?: string | null },
): CoordinateValidators {
  const applicable = columns.filter((c) => columnApplies(c, row)).map(c => columnForCategory(c, coordinate.label, row.productType))

  const required: RequiredColumn[] = []
  const requiredLists: CoordinateValidators['requiredLists'] = []
  const requiredMeasures: CoordinateValidators['requiredMeasures'] = []
  const listLengths: CoordinateValidators['listLengths'] = []
  const lengths: LengthColumn[] = []
  const enums: EnumColumn[] = []
  const deprecated: DeprecatedEnumColumn[] = []
  const gtinKeys: string[] = []

  // Slots of one list, grouped — the list is required once, through its slots.
  const slotsByList = new Map<string, string[]>()
  for (const c of applicable) if (c.slot) (slotsByList.get(c.slot.of) ?? slotsByList.set(c.slot.of, []).get(c.slot.of)!).push(c.key)

  for (const c of applicable) {
    if (columnRequiredHere(c, coordinate.label, row.productType, row.familyId)) {
      if (c.slot) {
        // Only slot 1 carries `requiredBy` (sheet-columns), so this fires once per list.
        requiredLists.push({ key: c.slot.of, label: c.slot.label, slotKeys: slotsByList.get(c.slot.of) ?? [c.key], min: c.channels?.[coordinate.label]?.cardinality?.min ?? 1 })
      } else if (c.shape === 'list') {
        requiredLists.push({ key: c.key, label: c.label, slotKeys: [c.key], min: c.cardinality?.min ?? 1 })
      } else if (c.shape === 'measure') {
        requiredMeasures.push({ key: c.key, label: c.label })
      } else {
        required.push({ id: c.key, label: c.label })
      }
    }
    if (c.maxLength || c.maxBytes) {
      // Byte cap wins where present: Amazon enforces BYTES, so an accented
      // Italian title inside the character cap can still be refused at submit.
      if (c.shape === 'list' && !c.slot) listLengths.push({ key: c.key, label: c.label, maxLength: c.maxLength, maxUtf8ByteLength: c.maxBytes })
      else lengths.push({ id: c.key, label: c.label, maxLength: c.maxLength, maxUtf8ByteLength: c.maxBytes })
    }
    // ONLY a `strict` list is checked. An OPEN list is the schema offering
    // suggestions, not declaring a set — an off-list value there is normal data
    // and must pass without a word. (Delegating this check to every column with
    // options was caught by pim-sheet-rows.test.ts: "accepts an off-list value
    // on an open list without a word".)
    if (c.mode === 'strict' && c.options && c.options.length > 0) {
      enums.push({
        id: c.key,
        label: c.label,
        // Accept both the schema's option labels and their underlying codes:
        // rows in this catalogue carry either.
        values: [...c.options, ...Object.keys(c.optionLabels ?? {}), ...Object.values(c.optionLabels ?? {})],
        // See the header: the sheet grades a closed-list miss as a WARNING on
        // purpose. `false` is the policy, not an oversight.
        selectionOnly: false,
      })
    }
    if (c.deprecatedOptions?.length) {
      deprecated.push({ id: c.key, label: c.label, values: c.deprecatedOptions })
    }
    if (GTIN_KEYS.has(c.key)) gtinKeys.push(c.key)
  }

  return {
    constraints: applicable.filter(column => column.validation && Object.keys(column.validation).length > 0),
    required,
    requiredLists,
    requiredMeasures,
    listLengths,
    lengths,
    enums,
    deprecated,
    applicableColumns: new Set(applicable.map((c) => c.key)),
    gtinKeys,
    productType: row.productType,
    marketplace: coordinate.marketplace,
    languages: coordinate.languages,
    coordinateLabel: coordinate.label,
    requiresCategory: coordinate.channel === 'AMAZON' || coordinate.channel === 'EBAY',
  }
}

/**
 * Run every validator over one flat row. Pure: no DB, no schema fetch, no
 * channel call — so a whole family across every coordinate stays three queries.
 */
export function evaluateRow(row: FlatRow, v: CoordinateValidators, content?: {
  requested: string; fields: Record<string, Pick<ResolvedValue, 'language'> | undefined>
}): PreflightIssue[] {
  // LX.5: a source-language fallback is displayable but cannot fill a translated requirement.
  if (content) row = Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    content.fields[key] && translationMissing(content.fields[key]!, content.requested) ? null : value,
  ]))
  const issues: PreflightIssue[] = []

  // A row with no product type resolves against no schema at all. Reporting it
  // as an ERROR here is the whole point: without this the row's required-field
  // set is empty, so it scores 100% ready while literally nothing has been
  // validated — the most dangerous shape a readiness pill can take
  // (hub ruling #15.3).
  if (!v.productType && v.coordinateLabel !== 'Master' && v.requiresCategory !== false) {
    issues.push({
      field: 'productType',
      severity: 'error',
      message: 'Product type is not set, so no channel schema can be resolved — nothing on this row has been validated',
    })
  }

  for (const miss of findMissingRequired(row, v.required)) {
    // Name the channel. "Brand is required" sends the operator hunting; "Brand
    // is required by Amazon · IT" tells them which scope to fix and why.
    issues.push({ field: miss.id, severity: 'error', message: `${miss.label} is required by ${v.coordinateLabel}` })
  }
  // AM.1 — a required LIST needs ≥ min non-empty items across its slots (or inside its array).
  // Measured 2026-09-04 on GALE, Amazon·IT: the one-cell rule reported "Bullet Point is required"
  // on 21/21 rows while every listing held five bullets in a store the cell never read.
  for (const list of v.requiredLists ?? []) {
    let filled = 0
    for (const k of list.slotKeys) {
      const raw = row[k]
      const items = readListValue(raw)
      if (!items) continue
      filled += items.filter((i) => !isBlankValue(i)).length
    }
    if (filled < list.min) {
      // Anchored on the first slot so the sheet's `⚠ required` lands on a cell that exists.
      issues.push({ field: list.slotKeys[0], severity: 'error', message: `${list.label} is required by ${v.coordinateLabel}` })
    }
  }
  for (const m of v.requiredMeasures ?? []) {
    const val = readMeasureValue(row[m.key])
    if (!val || val.value === null) {
      issues.push({ field: m.key, severity: 'error', message: `${m.label} is required by ${v.coordinateLabel}` })
    } else if (!val.unit) {
      issues.push({ field: m.key, severity: 'error', message: `${m.label} has a value but no unit — ${v.coordinateLabel} needs both` })
    }
  }
  for (const l of v.listLengths ?? []) {
    const items = readListValue(row[l.key]) ?? []
    for (const item of items) {
      if (isBlankValue(item)) continue
      const [issue] = checkLengthLimits({ [l.key]: item }, [{ id: l.key, label: l.label, maxLength: l.maxLength, maxUtf8ByteLength: l.maxUtf8ByteLength }])
      if (issue) { issues.push(issue); break }
    }
  }

  // On the MASTER scope (no coordinate) an over-cap value is a WARNING that names the channel, not
  // an error: the tightest cap across coordinates now reaches master columns (AM.1 joins `name` to
  // Amazon's 200 and eBay's 80), and a listing with its own title is not blocked by the master's
  // length. Measured 2026-09-05: every GALE row errored "Name … exceeds the 80-character limit" on
  // master while eBay·IT publishes its own 76-character title.
  const lengthIssues = checkLengthLimits(row, v.lengths)
  issues.push(...(v.coordinateLabel === 'Master' ? lengthIssues.map((i) => ({ ...i, severity: 'warning' as const })) : lengthIssues))
  issues.push(...checkEnumValues(row, v.enums))
  issues.push(...checkDeprecatedValues(row, v.deprecated))

  // GPSR/DSA — warnings only, and only on the EU marketplaces the checker
  // recognises. Bounded to the columns this surface actually carries.
  issues.push(
    ...checkGpsrCompliance(row, {
      marketplace: v.marketplace,
      languages: v.languages,
      applicableColumns: v.applicableColumns,
    }),
  )

  // Mod-10. A malformed EAN passed readiness and failed at submit before this.
  for (const key of v.gtinKeys) {
    const raw = row[key]
    if (raw === null || raw === undefined || raw === '') continue
    const verdict = validateGtin(String(raw))
    if (!verdict.valid) {
      issues.push({
        field: key,
        severity: 'error',
        message: `${key.toUpperCase()} "${String(raw)}" is not a valid identifier${verdict.reason ? ` — ${verdict.reason}` : ''}`,
      })
    }
  }

  for (const column of v.constraints ?? []) {
    if (v.coordinateLabel === 'Master' && dictionaryCondition(column.validation?.requiredWhen, row) && isBlankValue(row[column.key])) {
      const condition = column.validation!.requiredWhen as { field: string }
      issues.push({ field: column.key, severity: 'error', message: `${column.label} is required by this family when ${condition.field} has its selected value.` })
    }
    // Presence is checked above. An absent optional value has no shape to validate;
    // keeping this here preserves explicit empty lists in the content writer.
    if (isBlankValue(row[column.key])) continue
    const result = coerceForShape(column, row[column.key])
    if (result.ok === false && !issues.some(issue => issue.field === column.key && issue.severity === 'error')) {
      issues.push({ field: column.key, severity: 'error', message: result.error })
    }
  }
  return issues
}
