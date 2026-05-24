/**
 * PIM D.6 — Payload preview / dry-run.
 *
 * Generates the exact key/value payload a publish would send for one
 * product on one marketplace, given the current Marketplace.schemaMapping
 * rules. Closes the Phase D loop:
 *   - D.2 author mapping rules
 *   - D.5 validate against a product (block-on-missing)
 *   - D.6 preview the actual payload (what would land on Amazon/eBay)
 *
 * Reuses the resolveSourcePath helper from publish-validator so source/
 * fallback semantics stay identical between the validator and preview.
 * Applies transforms here (truncate, case, prepend/append, replace,
 * default) — first transform implementation; D.3 UI builds on top.
 *
 * Returns per-field provenance:
 *   value         — the final value after transforms (or null if skipped)
 *   source        — 'source' | 'fallback' | 'default' | 'missing'
 *   raw           — what the source path resolved to before transforms
 *   appliedTransforms — list of transform types that ran
 *   warnings      — non-blocking notes (e.g. truncated from 250→200)
 */

import prisma from '../../db.js'
import { resolveAttributesFlat } from './attribute-resolver.js'
import {
  getMappingForMarketplace,
  type FieldMappingRule,
  type TransformOp,
} from './schema-mapping.service.js'
import { resolveSourcePath } from './publish-validator.js'

export interface PreviewField {
  fieldKey: string
  rule: FieldMappingRule
  value: unknown
  source: 'source' | 'fallback' | 'default' | 'missing'
  raw: unknown
  appliedTransforms: TransformOp['type'][]
  warnings: string[]
  required: boolean
}

export interface PreviewResult {
  productId: string
  productSku: string
  channel: string
  marketplace: string
  payload: Record<string, unknown>
  fields: PreviewField[]
  /** Field keys that the mapping marks required and that have no
   *  value after resolution + fallback + default — would block publish. */
  missingRequired: string[]
}

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

/** Apply transforms in order. Each transform mutates the value;
 *  warnings collect anything that's worth surfacing without blocking
 *  (e.g. truncated content). Unknown transform types are skipped with
 *  a warning rather than throwing so a partial rule doesn't sink the
 *  whole preview. */
function applyTransforms(
  value: unknown,
  transforms: TransformOp[] | undefined,
  warnings: string[],
): { out: unknown; applied: TransformOp['type'][] } {
  if (!transforms || transforms.length === 0) return { out: value, applied: [] }
  let current: unknown = value
  const applied: TransformOp['type'][] = []
  for (const t of transforms) {
    try {
      switch (t.type) {
        case 'truncate': {
          if (typeof current !== 'string') {
            warnings.push(`truncate skipped — value is not a string`)
            break
          }
          const max = t.max ?? Infinity
          if (current.length > max) {
            warnings.push(`truncated from ${current.length} → ${max}`)
            current = current.slice(0, max)
          }
          applied.push('truncate')
          break
        }
        case 'titleCase':
          if (typeof current !== 'string') {
            warnings.push('titleCase skipped — value is not a string')
            break
          }
          current = current.replace(/\b\w/g, (c) => c.toUpperCase())
          applied.push('titleCase')
          break
        case 'lowerCase':
          if (typeof current !== 'string') {
            warnings.push('lowerCase skipped — value is not a string')
            break
          }
          current = current.toLowerCase()
          applied.push('lowerCase')
          break
        case 'upperCase':
          if (typeof current !== 'string') {
            warnings.push('upperCase skipped — value is not a string')
            break
          }
          current = current.toUpperCase()
          applied.push('upperCase')
          break
        case 'prepend':
          if (typeof current !== 'string') {
            warnings.push('prepend skipped — value is not a string')
            break
          }
          current = String(t.value ?? '') + current
          applied.push('prepend')
          break
        case 'append':
          if (typeof current !== 'string') {
            warnings.push('append skipped — value is not a string')
            break
          }
          current = current + String(t.value ?? '')
          applied.push('append')
          break
        case 'replace':
          if (typeof current !== 'string') {
            warnings.push('replace skipped — value is not a string')
            break
          }
          try {
            const re = new RegExp(t.pattern ?? '', 'g')
            current = current.replace(re, t.replacement ?? '')
            applied.push('replace')
          } catch (e: any) {
            warnings.push(`replace failed — invalid regex: ${e?.message ?? 'unknown'}`)
          }
          break
        case 'default':
          // `default` only fires when the current value is empty.
          if (!isPresent(current)) {
            current = t.value ?? null
            applied.push('default')
          }
          break
        default:
          warnings.push(`unknown transform type "${(t as { type: string }).type}" skipped`)
      }
    } catch (e: any) {
      warnings.push(`transform "${t.type}" threw — ${e?.message ?? 'unknown'}`)
    }
  }
  return { out: current, applied }
}

/**
 * Generate the dry-run payload for one product against one
 * marketplace's mapping rules.
 */
export async function previewPayload(input: {
  productId: string
  channel: string
  marketplace: string
  locale?: string
}): Promise<PreviewResult> {
  const { productId, channel, marketplace, locale = 'en' } = input

  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw new Error(`Product not found: ${productId}`)
  const parent = product.parentId
    ? await prisma.product.findUnique({ where: { id: product.parentId } })
    : null

  const mapping = await getMappingForMarketplace(channel, marketplace)
  const channelListing = await prisma.channelListing.findFirst({
    where: { productId, channel, marketplace },
  })

  const resolved = resolveAttributesFlat({
    product: product as any,
    parent: parent as any,
    channelListing: channelListing as any,
    locale,
  })

  const fields: PreviewField[] = []
  const payload: Record<string, unknown> = {}
  const missingRequired: string[] = []

  const fieldKeys = Object.keys(mapping.fields)
  for (const fieldKey of fieldKeys) {
    const rule = mapping.fields[fieldKey]
    if (!rule) continue

    const sourceRaw = resolveSourcePath(rule.source, resolved, product as any, locale)
    let resolvedValue: unknown = sourceRaw
    let provenance: PreviewField['source'] = 'source'

    if (!isPresent(resolvedValue) && rule.fallback) {
      const fb = resolveSourcePath(rule.fallback, resolved, product as any, locale)
      if (isPresent(fb)) {
        resolvedValue = fb
        provenance = 'fallback'
      }
    }

    const warnings: string[] = []
    const { out, applied } = applyTransforms(resolvedValue, rule.transforms, warnings)
    resolvedValue = out

    // If a `default` transform fired, mark provenance accordingly so
    // the operator knows the value didn't actually come from the product.
    if (applied.includes('default') && !isPresent(sourceRaw)) {
      provenance = provenance === 'source' ? 'default' : provenance
    }

    if (!isPresent(resolvedValue)) {
      provenance = 'missing'
      if (rule.required) missingRequired.push(fieldKey)
    } else {
      payload[fieldKey] = resolvedValue
    }

    fields.push({
      fieldKey,
      rule,
      value: isPresent(resolvedValue) ? resolvedValue : null,
      source: provenance,
      raw: sourceRaw,
      appliedTransforms: applied,
      warnings,
      required: rule.required === true,
    })
  }

  return {
    productId,
    productSku: product.sku,
    channel,
    marketplace,
    payload,
    fields,
    missingRequired,
  }
}
