/**
 * D.4: parse + validate CSV / XLSX uploads against the field
 * registry. Returns a structured plan that the apply endpoint replays.
 *
 * The plan is written into BulkOperation.changes as a JSON array; the
 * apply endpoint reads it back, no re-parsing.
 *
 * Validation rules:
 *   - SKU column required; rows missing SKU are errored.
 *   - SKU must match an existing Product (by Product.sku).
 *   - Each other column maps to a registry field (case-insensitive on
 *     the header). Unknown columns silently ignored — lets users keep
 *     extra reference columns in their CSVs.
 *   - Empty cells are treated as "no change" (NOT "set to null").
 *   - Per-field type coercion mirrors PATCH /api/products/bulk:
 *     numeric fields accept locale commas, weight/dim accept
 *     "5kg"/"60cm" suffixes (and emit a paired *Unit change), GTIN is
 *     normalised to digits-only and validated for 8–14 length.
 */

import Papa from 'papaparse'
import * as XLSX from 'xlsx'
// Note: papaparse exports default; xlsx is CJS-shaped and works
// fine via the namespace import here since we only call XLSX.read
// and XLSX.utils, both of which sit on the namespace object.
import type { PrismaClient } from '@prisma/client'
import {
  getAvailableFields,
  type FieldDefinition,
} from '../pim/field-registry.service.js'

export interface PlanChange {
  field: string
  oldValue: unknown
  newValue: unknown
}

export interface PlanRowError {
  field?: string
  message: string
}

/** Per-row plan entry — one per row in the source file. Rows with
 *  zero valid changes are still recorded (so the user sees them in
 *  the error list) but are excluded from the apply set. */
export interface PlanRow {
  /** 1-indexed row number from the user's spreadsheet (header is 1). */
  rowIndex: number
  sku: string
  productId: string | null
  changes: PlanChange[]
  errors: PlanRowError[]
}

export interface UploadPlan {
  filename: string
  totalRows: number
  rows: PlanRow[]
}

export interface UploadPreviewSummary {
  filename: string
  totalRows: number
  toUpdate: number
  errorRows: number
  totalChanges: number
  /** First N error entries flattened across rows. */
  errors: Array<{
    row: number
    sku: string
    field?: string
    message: string
  }>
  /** First N change entries flattened across rows. */
  sampleChanges: Array<{
    row: number
    sku: string
    field: string
    oldValue: unknown
    newValue: unknown
  }>
}

const MAX_ROWS = 50000

const WEIGHT_UNITS = new Set(['kg', 'g', 'lb', 'oz'])
const DIM_UNITS = new Set(['cm', 'mm', 'in'])
const STATUS_VALUES = new Set(['ACTIVE', 'DRAFT', 'INACTIVE'])
const FULFILLMENT_VALUES = new Set(['FBA', 'FBM'])

function localeNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (raw == null) return NaN
  const s = String(raw).trim()
  if (s === '') return NaN
  const n =
    s.includes('.') || !s.includes(',') ? Number(s) : Number(s.replace(',', '.'))
  return n
}

function parseUnitSuffixed(
  raw: unknown,
  units: Set<string>,
): { value: number; unit?: string } | null {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (s === '') return null
  const match = s.match(/^([0-9]+(?:[.,][0-9]+)?)\s*([a-z]+)?$/)
  if (!match) return null
  const value = localeNumber(match[1])
  if (Number.isNaN(value) || value < 0) return null
  const unit = match[2]
  if (!unit) return { value }
  if (!units.has(unit)) return null
  return { value, unit }
}

/** Detect file format from the upload's filename + sniffable bytes,
 *  and return a 2D string array (header row + data rows). */
export function parseUploadBuffer(
  filename: string,
  buf: Buffer,
): { rows: Record<string, string>[]; warnings: string[] } {
  const warnings: string[] = []
  const lower = filename.toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = XLSX.read(buf, { type: 'buffer' })
    const sheetName = wb.SheetNames[0]
    if (!sheetName) {
      throw new Error('XLSX file has no sheets')
    }
    const sheet = wb.Sheets[sheetName]
    // defval='' so empty cells come through as empty strings rather
    // than being omitted (otherwise our "empty = no change" rule
    // can't tell empty from "column missing on this row").
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
      defval: '',
      raw: false,
    })
    if (wb.SheetNames.length > 1) {
      warnings.push(
        `Only the first sheet (${sheetName}) was processed; ${
          wb.SheetNames.length - 1
        } other sheet(s) ignored.`,
      )
    }
    return { rows, warnings }
  }
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const text = buf.toString('utf-8')
    const result = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    })
    if (result.errors && result.errors.length > 0) {
      for (const e of result.errors.slice(0, 5)) {
        warnings.push(`CSV parse warning at row ${e.row ?? '?'}: ${e.message}`)
      }
    }
    return { rows: result.data, warnings }
  }
  throw new Error('Unsupported file type — use .csv, .xlsx, or .xls')
}

/**
 * Build the validated plan. The first column matched to "sku" (case-
 * insensitive) is the join key. SKUs are looked up against existing
 * products in a single round-trip.
 */
export async function buildUploadPlan(
  prisma: PrismaClient,
  filename: string,
  rows: Record<string, string>[],
): Promise<UploadPlan> {
  if (rows.length === 0) {
    throw new Error('File is empty')
  }
  if (rows.length > MAX_ROWS) {
    throw new Error(
      `Maximum ${MAX_ROWS.toLocaleString()} rows per upload — split into multiple files`,
    )
  }

  // Field index by lowercase id
  const fields = await getAvailableFields({})
  const fieldById = new Map<string, FieldDefinition>()
  for (const f of fields) fieldById.set(f.id.toLowerCase(), f)

  // Header → field map (skip headers we can't resolve)
  const headers = Object.keys(rows[0] ?? {})
  const skuHeader = headers.find((h) => h.trim().toLowerCase() === 'sku')
  if (!skuHeader) {
    throw new Error('Required column "sku" is missing')
  }
  const headerToFieldId: Map<string, string> = new Map()
  for (const h of headers) {
    if (h === skuHeader) continue
    const f = fieldById.get(h.trim().toLowerCase())
    if (f && f.editable) headerToFieldId.set(h, f.id)
  }

  // Bulk-fetch products by SKU. We collect every non-empty SKU first
  // so the lookup is one query instead of one per row.
  const skus = new Set<string>()
  for (const row of rows) {
    const v = row[skuHeader]
    if (v != null && String(v).trim() !== '') {
      skus.add(String(v).trim())
    }
  }
  const products = await prisma.product.findMany({
    where: { sku: { in: Array.from(skus) } },
    select: {
      id: true,
      sku: true,
      name: true,
      basePrice: true,
      costPrice: true,
      minMargin: true,
      minPrice: true,
      maxPrice: true,
      totalStock: true,
      lowStockThreshold: true,
      brand: true,
      manufacturer: true,
      upc: true,
      ean: true,
      gtin: true,
      weightValue: true,
      weightUnit: true,
      dimLength: true,
      dimWidth: true,
      dimHeight: true,
      dimUnit: true,
      status: true,
      fulfillmentChannel: true,
    },
  })
  const bySku = new Map<string, (typeof products)[number]>()
  for (const p of products) bySku.set(p.sku, p)

  const planRows: PlanRow[] = []
  rows.forEach((row, idx) => {
    const rowIndex = idx + 2 // header is row 1; first data row is 2
    const skuRaw = row[skuHeader]
    const sku = skuRaw == null ? '' : String(skuRaw).trim()
    if (sku === '') {
      planRows.push({
        rowIndex,
        sku: '',
        productId: null,
        changes: [],
        errors: [{ message: 'Missing SKU' }],
      })
      return
    }
    const product = bySku.get(sku)
    if (!product) {
      planRows.push({
        rowIndex,
        sku,
        productId: null,
        changes: [],
        errors: [
          {
            message: `SKU "${sku}" not found — add the product via the catalog before updating`,
          },
        ],
      })
      return
    }

    const changes: PlanChange[] = []
    const errors: PlanRowError[] = []
    const productAny = product as unknown as Record<string, unknown>

    for (const [header, fieldId] of headerToFieldId) {
      const cell = row[header]
      const cellStr = cell == null ? '' : String(cell).trim()
      // Empty cell → "no change" rule.
      if (cellStr === '') continue
      const fieldDef = fieldById.get(fieldId.toLowerCase())!
      const result = coerceForField(fieldDef, cellStr)
      if (result.error) {
        errors.push({ field: fieldId, message: result.error })
        continue
      }
      const oldValue = decimalToNumber(productAny[fieldId])
      // Identity-equal old/new is a no-op skip. Otherwise queue.
      if (looselyEqual(oldValue, result.value)) continue
      changes.push({ field: fieldId, oldValue, newValue: result.value })
      // weight/dim text inputs may also carry a unit suffix that
      // implies a paired *Unit change.
      if (result.pairedUnit) {
        const unitField = fieldId === 'weightValue' ? 'weightUnit' : 'dimUnit'
        const currentUnit = productAny[unitField]
        if (currentUnit !== result.pairedUnit.value) {
          changes.push({
            field: unitField,
            oldValue: currentUnit ?? null,
            newValue: result.pairedUnit.value,
          })
        }
      }
    }

    planRows.push({
      rowIndex,
      sku,
      productId: product.id,
      changes,
      errors,
    })
  })

  return {
    filename,
    totalRows: rows.length,
    rows: planRows,
  }
}

export function summarisePlan(plan: UploadPlan): UploadPreviewSummary {
  const errors: UploadPreviewSummary['errors'] = []
  const sampleChanges: UploadPreviewSummary['sampleChanges'] = []
  let toUpdate = 0
  let errorRows = 0
  let totalChanges = 0
  for (const r of plan.rows) {
    if (r.errors.length > 0) errorRows++
    if (r.changes.length > 0) {
      toUpdate++
      totalChanges += r.changes.length
    }
    for (const e of r.errors) {
      if (errors.length >= 12) break
      errors.push({
        row: r.rowIndex,
        sku: r.sku,
        field: e.field,
        message: e.message,
      })
    }
    for (const c of r.changes) {
      if (sampleChanges.length >= 12) break
      sampleChanges.push({
        row: r.rowIndex,
        sku: r.sku,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
      })
    }
  }
  return {
    filename: plan.filename,
    totalRows: plan.totalRows,
    toUpdate,
    errorRows,
    totalChanges,
    errors,
    sampleChanges,
  }
}

interface CoerceResult {
  value?: unknown
  error?: string
  pairedUnit?: { field: string; value: string }
}

function coerceForField(field: FieldDefinition, raw: string): CoerceResult {
  const v = raw.trim()
  if (v === '') return { value: null }
  // Weight + dimension columns accept "5kg"/"60cm" with optional
  // unit suffix that becomes a paired *Unit change.
  if (field.id === 'weightValue') {
    const parsed = parseUnitSuffixed(v, WEIGHT_UNITS)
    if (!parsed) {
      return { error: 'Invalid weight — try "5", "5kg" or "5.5 lb"' }
    }
    return {
      value: parsed.value,
      pairedUnit: parsed.unit
        ? { field: 'weightUnit', value: parsed.unit }
        : undefined,
    }
  }
  if (
    field.id === 'dimLength' ||
    field.id === 'dimWidth' ||
    field.id === 'dimHeight'
  ) {
    const parsed = parseUnitSuffixed(v, DIM_UNITS)
    if (!parsed) {
      return { error: 'Invalid dimension — try "60", "60cm" or "23.6in"' }
    }
    return {
      value: parsed.value,
      pairedUnit: parsed.unit
        ? { field: 'dimUnit', value: parsed.unit }
        : undefined,
    }
  }
  if (field.id === 'weightUnit') {
    const u = v.toLowerCase()
    if (!WEIGHT_UNITS.has(u)) {
      return {
        error: `Weight unit must be one of ${Array.from(WEIGHT_UNITS).join(', ')}`,
      }
    }
    return { value: u }
  }
  if (field.id === 'dimUnit') {
    const u = v.toLowerCase()
    if (!DIM_UNITS.has(u)) {
      return {
        error: `Dimension unit must be one of ${Array.from(DIM_UNITS).join(', ')}`,
      }
    }
    return { value: u }
  }
  if (field.id === 'gtin') {
    const digits = v.replace(/\D/g, '')
    if (digits.length < 8 || digits.length > 14) {
      return { error: 'GTIN must be 8–14 digits' }
    }
    return { value: digits }
  }
  if (field.id === 'status') {
    const u = v.toUpperCase()
    if (!STATUS_VALUES.has(u)) {
      return {
        error: `Status must be one of ${Array.from(STATUS_VALUES).join(', ')}`,
      }
    }
    return { value: u }
  }
  if (field.id === 'fulfillmentChannel') {
    const u = v.toUpperCase()
    if (!FULFILLMENT_VALUES.has(u)) {
      return {
        error: `Fulfillment must be one of ${Array.from(FULFILLMENT_VALUES).join(', ')}`,
      }
    }
    return { value: u }
  }
  if (
    field.id === 'totalStock' ||
    field.id === 'lowStockThreshold'
  ) {
    const n = parseInt(v.replace(',', '.'), 10)
    if (Number.isNaN(n) || n < 0) {
      return { error: 'Must be a non-negative integer' }
    }
    return { value: n }
  }
  if (field.type === 'number') {
    const n = localeNumber(v)
    if (Number.isNaN(n)) return { error: 'Invalid number' }
    if (n < 0) return { error: 'Must be ≥ 0' }
    return { value: n }
  }
  if (field.type === 'select' && field.options && field.options.length > 0) {
    if (!field.options.includes(v)) {
      return {
        error: `Must be one of: ${field.options.slice(0, 6).join(', ')}${
          field.options.length > 6 ? '…' : ''
        }`,
      }
    }
    return { value: v }
  }
  return { value: v }
}

function decimalToNumber(v: unknown): unknown {
  if (v == null) return v
  // Prisma Decimal exposes a toNumber/toString. We get plain numbers
  // for Float columns and Decimal-instance for Decimal columns. For
  // diffing we want a number on both sides.
  if (typeof v === 'object' && v !== null && 'toNumber' in v) {
    try {
      return (v as { toNumber(): number }).toNumber()
    } catch {
      return v
    }
  }
  return v
}

function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}
