/**
 * MA.4 — Master completeness (Akeneo-style governance).
 *
 * Given the productType's master attribute schema (MA.1) and the product's
 * current values, computes overall + required-attribute completeness and the
 * missing-required list. Surfaced on the Master tab (governance) and available
 * programmatically (publish-readiness, future grid column).
 */

import prisma from '../../db.js'
import { getMasterAttributeSchema, type MasterAttribute } from './master-schema.service.js'

export interface MasterCompleteness {
  overall: { filled: number; total: number; pct: number }
  required: { filled: number; total: number; missing: { key: string; label: string }[] }
  byGroup: { group: string; filled: number; total: number }[]
}

function isFilled(v: unknown): boolean {
  if (v == null || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  return true
}

/** Pure: fold the schema + current values into completeness. Exposed for tests. */
export function computeMasterCompleteness(
  attributes: MasterAttribute[],
  values: Record<string, unknown>,
): MasterCompleteness {
  let filled = 0
  let reqFilled = 0
  let reqTotal = 0
  const missing: { key: string; label: string }[] = []
  const groups = new Map<string, { filled: number; total: number }>()

  for (const a of attributes) {
    const has = isFilled(values[a.key])
    if (has) filled++
    if (a.required) {
      reqTotal++
      if (has) reqFilled++
      else missing.push({ key: a.key, label: a.label })
    }
    const g = groups.get(a.group) ?? { filled: 0, total: 0 }
    g.total++
    if (has) g.filled++
    groups.set(a.group, g)
  }

  const total = attributes.length
  return {
    overall: { filled, total, pct: total > 0 ? Math.round((filled / total) * 100) : 100 },
    required: { filled: reqFilled, total: reqTotal, missing },
    byGroup: [...groups.entries()].map(([group, v]) => ({ group, ...v })),
  }
}

export async function getMasterCompleteness(
  productId: string,
): Promise<MasterCompleteness & { productId: string; productType: string | null }> {
  const { attributes, productType } = await getMasterAttributeSchema(productId)
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { categoryAttributes: true, parentId: true },
  })
  // The master's effective values: own categoryAttributes, with parent's
  // underneath when this product is a variant (the master it inherits).
  let values = (product?.categoryAttributes as Record<string, unknown> | null) ?? {}
  if (product?.parentId) {
    const parent = await prisma.product.findUnique({
      where: { id: product.parentId },
      select: { categoryAttributes: true },
    })
    values = { ...((parent?.categoryAttributes as Record<string, unknown> | null) ?? {}), ...values }
  }
  return { productId, productType, ...computeMasterCompleteness(attributes, values) }
}
