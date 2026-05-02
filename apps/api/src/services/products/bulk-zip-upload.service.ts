/**
 * D.5: parse + validate a multi-file ZIP upload.
 *
 * Each top-level folder in the archive maps to one product, named by
 * SKU. Per-folder content:
 *
 *   <SKU>/data.json           — JSON with field updates (incl.
 *                               optional categoryAttributes)
 *   <SKU>/description.html    — raw HTML body for Product.description
 *   <SKU>/images/…            — silently ignored in v1, surfaced as a
 *                               warning. Image upload deferred to D.5.5.
 *   <SKU>/<anything else>     — surfaced as a per-folder warning so the
 *                               user knows it was skipped.
 *
 * The plan that comes out reuses the D.4 PlanRow shape so the existing
 * /api/products/bulk-apply endpoint can apply it without changes.
 */

import JSZip from 'jszip'
import type { PrismaClient } from '@prisma/client'
import {
  getAvailableFields,
  type FieldDefinition,
} from '../pim/field-registry.service.js'
import {
  coerceForField,
  decimalToNumber,
  looselyEqual,
  type PlanRow,
  type PlanChange,
  type PlanRowError,
  type UploadPlan,
} from './bulk-upload.service.js'

// ── Defensive limits — guard against zip-bomb-adjacent inputs ──────
const MAX_ENTRIES = 10000
const MAX_PATH_DEPTH = 6
const MAX_DATA_JSON_BYTES = 50 * 1024
const MAX_DESCRIPTION_BYTES = 100 * 1024
const MAX_FOLDERS = 5000

const IMAGE_RE = /\.(jpe?g|png|webp|gif|tiff?|avif)$/i

interface FolderContents {
  sku: string
  dataJson?: { content: string; size: number }
  descriptionHtml?: { content: string; size: number }
  imageCount: number
  unrecognised: string[]
  perFolderError?: string
}

export interface ZipUploadWarnings {
  ignoredImages?: { folders: number; files: number }
  unrecognised?: { folders: number; files: number }
  truncated?: number
}

export interface ZipUploadResult extends UploadPlan {
  warnings: string[]
}

/**
 * Parse and validate a ZIP buffer. Throws on archive-level errors
 * (too many entries, too deep, wholly unreadable). Per-folder
 * problems are recorded as PlanRow errors so the user sees them in
 * the preview alongside successful folders.
 */
export async function parseZipUpload(
  prisma: PrismaClient,
  filename: string,
  buf: Buffer,
): Promise<ZipUploadResult> {
  const zip = await JSZip.loadAsync(buf)

  // 1. Defensive shape check.
  const allEntryPaths = Object.keys(zip.files)
  if (allEntryPaths.length === 0) {
    throw new Error('ZIP archive is empty')
  }
  if (allEntryPaths.length > MAX_ENTRIES) {
    throw new Error(
      `Archive contains ${allEntryPaths.length} entries — limit is ${MAX_ENTRIES.toLocaleString()}`,
    )
  }
  for (const p of allEntryPaths) {
    const segments = p.replace(/^\/+|\/+$/g, '').split('/')
    if (segments.length > MAX_PATH_DEPTH) {
      throw new Error(
        `Archive path too deep (max ${MAX_PATH_DEPTH} levels): ${p}`,
      )
    }
  }

  // 2. Group entries by top-level folder. Skip macOS dotfiles + the
  //    ZIP's own directory entries.
  const folderMap = new Map<string, JSZip.JSZipObject[]>()
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    if (path.startsWith('__MACOSX/')) continue
    if (path.split('/').some((s) => s.startsWith('.'))) continue
    const cleaned = path.replace(/^\/+/, '')
    const top = cleaned.split('/')[0]
    if (!top) continue
    let bucket = folderMap.get(top)
    if (!bucket) {
      bucket = []
      folderMap.set(top, bucket)
    }
    bucket.push(entry)
  }
  if (folderMap.size === 0) {
    throw new Error(
      'ZIP archive has no usable top-level folders. Each product needs its own folder named by SKU.',
    )
  }
  let truncated = 0
  if (folderMap.size > MAX_FOLDERS) {
    truncated = folderMap.size - MAX_FOLDERS
    const keep = Array.from(folderMap.keys()).slice(0, MAX_FOLDERS)
    const next = new Map<string, JSZip.JSZipObject[]>()
    for (const k of keep) next.set(k, folderMap.get(k)!)
    folderMap.clear()
    for (const [k, v] of next) folderMap.set(k, v)
  }

  // 3. Walk each folder, classify files, collect raw content under
  //    the size caps. Per-folder failures become perFolderError.
  const folderContents: FolderContents[] = []
  for (const [sku, entries] of folderMap) {
    const fc: FolderContents = { sku, imageCount: 0, unrecognised: [] }
    try {
      for (const entry of entries) {
        const cleaned = entry.name.replace(/^\/+/, '')
        const segments = cleaned.split('/')
        // Folder name is segment 0; first inner level is segment 1.
        const inner1 = segments[1]
        const filename = segments[segments.length - 1]
        if (segments.length >= 3 && inner1 === 'images') {
          if (IMAGE_RE.test(filename)) {
            fc.imageCount++
          } else {
            fc.unrecognised.push(cleaned)
          }
          continue
        }
        if (segments.length === 2 && inner1 === 'data.json') {
          // @ts-ignore — JSZip's typings don't include uncompressed size
          // on the file object directly, so we read into a Uint8Array.
          const arr = await entry.async('uint8array')
          if (arr.byteLength > MAX_DATA_JSON_BYTES) {
            fc.perFolderError = `data.json is ${arr.byteLength.toLocaleString()} bytes — limit is ${MAX_DATA_JSON_BYTES.toLocaleString()}`
            break
          }
          fc.dataJson = {
            content: Buffer.from(arr).toString('utf-8'),
            size: arr.byteLength,
          }
          continue
        }
        if (segments.length === 2 && inner1 === 'description.html') {
          const arr = await entry.async('uint8array')
          if (arr.byteLength > MAX_DESCRIPTION_BYTES) {
            fc.perFolderError = `description.html is ${arr.byteLength.toLocaleString()} bytes — limit is ${MAX_DESCRIPTION_BYTES.toLocaleString()}`
            break
          }
          fc.descriptionHtml = {
            content: Buffer.from(arr).toString('utf-8'),
            size: arr.byteLength,
          }
          continue
        }
        // Anything else inside the folder — track for the warning.
        fc.unrecognised.push(cleaned)
      }
    } catch (err: any) {
      fc.perFolderError = `Failed to read folder: ${err?.message ?? String(err)}`
    }
    folderContents.push(fc)
  }

  // 4. Bulk-fetch existing products by SKU.
  const skus = folderContents.map((f) => f.sku)
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
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
      productType: true,
      categoryAttributes: true,
    },
  })
  const bySku = new Map<string, (typeof products)[number]>()
  for (const p of products) bySku.set(p.sku, p)

  // 5. Field registry by lowercase id (case-insensitive lookup is
  //    nicer for hand-edited JSON).
  const fields = await getAvailableFields({})
  const fieldByLower = new Map<string, FieldDefinition>()
  for (const f of fields) fieldByLower.set(f.id.toLowerCase(), f)

  // 6. Build PlanRow per folder.
  const planRows: PlanRow[] = []
  let totalIgnoredImageFiles = 0
  let foldersWithImages = 0
  let totalUnrecognisedFiles = 0
  let foldersWithUnrecognised = 0

  folderContents.forEach((fc, idx) => {
    const rowIndex = idx + 1
    if (fc.imageCount > 0) {
      totalIgnoredImageFiles += fc.imageCount
      foldersWithImages++
    }
    if (fc.unrecognised.length > 0) {
      totalUnrecognisedFiles += fc.unrecognised.length
      foldersWithUnrecognised++
    }

    if (fc.perFolderError) {
      planRows.push({
        rowIndex,
        sku: fc.sku,
        productId: null,
        changes: [],
        errors: [{ message: fc.perFolderError }],
      })
      return
    }

    const product = bySku.get(fc.sku)
    if (!product) {
      planRows.push({
        rowIndex,
        sku: fc.sku,
        productId: null,
        changes: [],
        errors: [
          {
            message: `SKU "${fc.sku}" not found — add the product via the catalog before updating`,
          },
        ],
      })
      return
    }

    const changes: PlanChange[] = []
    const errors: PlanRowError[] = []

    // 6a. data.json fields.
    if (fc.dataJson) {
      let data: Record<string, unknown>
      try {
        const parsed = JSON.parse(fc.dataJson.content)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('data.json must be a JSON object')
        }
        data = parsed as Record<string, unknown>
      } catch (err: any) {
        errors.push({
          field: 'data.json',
          message: `data.json parse failed: ${err?.message ?? String(err)}`,
        })
        data = {}
      }
      collectFieldChanges(
        product as unknown as Record<string, unknown>,
        data,
        fieldByLower,
        changes,
        errors,
      )
    }

    // 6b. description.html (skip if data.json already wrote it).
    if (
      fc.descriptionHtml &&
      !changes.some((c) => c.field === 'description')
    ) {
      const trimmed = fc.descriptionHtml.content.trim()
      const productAny = product as unknown as Record<string, unknown>
      const oldVal = productAny.description ?? null
      if (!looselyEqual(oldVal, trimmed)) {
        changes.push({
          field: 'description',
          oldValue: oldVal,
          newValue: trimmed,
        })
      }
    }

    planRows.push({
      rowIndex,
      sku: fc.sku,
      productId: product.id,
      changes,
      errors,
    })
  })

  // 7. Build warnings.
  const warnings: string[] = []
  if (totalIgnoredImageFiles > 0) {
    warnings.push(
      `${totalIgnoredImageFiles} image file${
        totalIgnoredImageFiles === 1 ? '' : 's'
      } in ${foldersWithImages} product folder${
        foldersWithImages === 1 ? '' : 's'
      } were ignored — image upload coming in D.5.5.`,
    )
  }
  if (totalUnrecognisedFiles > 0) {
    warnings.push(
      `${totalUnrecognisedFiles} unrecognised file${
        totalUnrecognisedFiles === 1 ? '' : 's'
      } in ${foldersWithUnrecognised} folder${
        foldersWithUnrecognised === 1 ? '' : 's'
      } were skipped (only data.json + description.html are read in v1).`,
    )
  }
  if (truncated > 0) {
    warnings.push(
      `Archive had ${truncated.toLocaleString()} extra folders beyond the ${MAX_FOLDERS.toLocaleString()}-folder cap; only the first ${MAX_FOLDERS.toLocaleString()} were processed.`,
    )
  }

  return {
    filename,
    totalRows: planRows.length,
    rows: planRows,
    warnings,
  }
}

/** For each key in `data`, look up the registry field and route to
 *  the right validator (scalar field, weight/dim with unit, attr_*). */
function collectFieldChanges(
  product: Record<string, unknown>,
  data: Record<string, unknown>,
  fieldByLower: Map<string, FieldDefinition>,
  changes: PlanChange[],
  errors: PlanRowError[],
): void {
  for (const [key, rawValue] of Object.entries(data)) {
    // categoryAttributes is a nested object — each attr.<name> maps
    // to the registry's attr_<name> field. Reuse the same coercer
    // logic per attribute.
    if (key === 'categoryAttributes') {
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        errors.push({
          field: 'categoryAttributes',
          message: 'categoryAttributes must be an object',
        })
        continue
      }
      const productAttrs =
        (product.categoryAttributes as Record<string, unknown> | null) ?? {}
      for (const [attrKey, attrValue] of Object.entries(
        rawValue as Record<string, unknown>,
      )) {
        const fieldId = `attr_${attrKey}`
        const fieldDef = fieldByLower.get(fieldId.toLowerCase())
        if (!fieldDef || !fieldDef.editable) {
          errors.push({
            field: fieldId,
            message: `Unknown or read-only category attribute "${attrKey}"`,
          })
          continue
        }
        const stringified = stringifyJsonValue(attrValue)
        if (stringified === '') continue
        const result = coerceForField(fieldDef, stringified)
        if (result.error) {
          errors.push({ field: fieldId, message: result.error })
          continue
        }
        const oldVal = productAttrs[attrKey] ?? null
        if (looselyEqual(oldVal, result.value)) continue
        changes.push({ field: fieldId, oldValue: oldVal, newValue: result.value })
      }
      continue
    }

    // Top-level scalar field. Synthetic "weight" maps to weightValue;
    // any other key matches the registry directly.
    const lookupKey = key.toLowerCase()
    const targetId =
      lookupKey === 'weight' ? 'weightvalue' : lookupKey
    const fieldDef = fieldByLower.get(targetId)
    if (!fieldDef || !fieldDef.editable) {
      // Silently skip unknown keys — keeps user-added reference data
      // (notes, tags, etc.) from blocking otherwise-valid uploads.
      continue
    }
    const stringified = stringifyJsonValue(rawValue)
    if (stringified === '') continue
    const result = coerceForField(fieldDef, stringified)
    if (result.error) {
      errors.push({ field: fieldDef.id, message: result.error })
      continue
    }
    const oldValue = decimalToNumber(product[fieldDef.id])
    if (!looselyEqual(oldValue, result.value)) {
      changes.push({
        field: fieldDef.id,
        oldValue,
        newValue: result.value,
      })
    }
    if (result.pairedUnit) {
      const unitField =
        fieldDef.id === 'weightValue' ? 'weightUnit' : 'dimUnit'
      const currentUnit = product[unitField]
      if (currentUnit !== result.pairedUnit.value) {
        changes.push({
          field: unitField,
          oldValue: currentUnit ?? null,
          newValue: result.pairedUnit.value,
        })
      }
    }
  }
}

function stringifyJsonValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  // For nested objects we don't currently support beyond
  // categoryAttributes, return JSON to surface a clear error in the
  // coercer.
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}
