import { normalizeLanguage } from '../content-language.js'
import { PRIMARY_CONTENT_LOCALE } from '../content-locale.js'
import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * PES.6 wave-4 §1.6(C) — MASTER field rules.
 *
 * A formula for a master field, applying to every product (optionally of one product type).
 *
 * Why its own store rather than `channel: 'master'` inside `Marketplace.schemaMapping`, which is
 * what §1 originally proposed: `getMappingForMarketplace` does `findUnique({ channel_code })` and
 * throws when it misses, and `@@unique([channel, code])` means a pseudo-marketplace would have to
 * exist as a real row — which would then appear in the mapping page's channel picker
 * (`routes/channel-mapping.routes.ts:69`) and in the coverage matrix
 * (`mapping-coverage.service.ts:81`). A small table avoids all of that.
 *
 * Evaluated ON READ — never materialised, never a job. Master rules go through
 * `resolveAttributes({ product, parent, locale })` (no listing, exactly the call
 * `sheet-rows.service.ts:397` already makes) plus the expression engine, NOT through
 * `resolveChannelField`, whose whole output shape is channel provenance.
 *
 * Precedence, highest first (§1 D16.2): a CELL formula or a pinned literal on the product beats a
 * master rule. This service resolves the rule only; the caller decides whether the product's own
 * value already answers.
 */

import prisma from '../../../db.js'
import { resolveAttributes } from '../attribute-resolver.js'
import { resolveSourcePath } from '../resolve-channel-field.js'
import { evaluateExpr, validateExpr, exprDependenciesDeep } from './expr.js'

const ALL_TYPES = '*'

export interface MasterRuleRow {
  id: string
  /** null = every product type (stored as '*', the convention FieldValueMap already uses). */
  productType: string | null
  fieldKey: string
  expr: string
  version: number
  updatedBy: string | null
  updatedAt: string
}

const toRow = (r: any): MasterRuleRow => ({
  id: r.id,
  productType: r.productType === ALL_TYPES ? null : r.productType,
  fieldKey: r.fieldKey,
  expr: r.expr,
  version: r.version,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
})

export async function listMasterRules(productType?: string | null): Promise<MasterRuleRow[]> {
  const rows = await prisma.masterFieldRule.findMany({
    where: productType ? { productType: { in: [productType, ALL_TYPES] } } : undefined,
    orderBy: [{ productType: 'asc' }, { fieldKey: 'asc' }],
  })
  return rows.map(toRow)
}

/** The effective rule for one field: a productType-specific rule beats the `*` rule. */
export async function effectiveMasterRule(
  fieldKey: string,
  productType: string | null,
): Promise<MasterRuleRow | null> {
  const rows = await prisma.masterFieldRule.findMany({
    where: { fieldKey, productType: { in: productType ? [productType, ALL_TYPES] : [ALL_TYPES] } },
  })
  const specific = rows.find((r) => r.productType !== ALL_TYPES)
  const wildcard = rows.find((r) => r.productType === ALL_TYPES)
  const hit = specific ?? wildcard
  return hit ? toRow(hit) : null
}

export async function upsertMasterRule(input: {
  fieldKey: string
  expr: string
  productType?: string | null
  updatedBy?: string | null
  reason?: string | null
}): Promise<MasterRuleRow> {
  // §1.6(B) — the editor strips a leading '='; one that survives is refused, because '=' is the
  // equality operator and `="a" + $b` parses as a comparison.
  if (input.expr.trimStart().startsWith('=')) {
    throw new Error('Store the formula without its leading "=" — "=" is the equality operator in this language.')
  }
  const expr = input.expr.trim()
  if (!expr) throw new Error('The formula is empty.')
  const bad = validateExpr(expr)
  if (bad) throw new Error(`${bad.message} (at character ${bad.pos + 1})`)

  const deps = exprDependenciesDeep(expr, {})!
  if (deps.attributes.includes(input.fieldKey)) {
    throw new Error(`This rule reads ${input.fieldKey}, which is the field it writes — a rule cannot depend on itself.`)
  }
  if (deps.cycle) throw new Error(`Circular reference: ${deps.cycle.join(' → ')}`)

  const productType = input.productType?.trim() || ALL_TYPES

  // Snapshot BEFORE the change, mirroring MappingRevision, so a master rule is as rollback-able
  // as a channel rule.
  const existing = await prisma.masterFieldRule.findUnique({
    where: { productType_fieldKey: workspaceKey({ productType, fieldKey: input.fieldKey }) },
  })
  if (existing) {
    await prisma.masterFieldRuleRevision
      .create({
        data: {
          productType, fieldKey: input.fieldKey, version: existing.version,
          snapshot: { expr: existing.expr, version: existing.version } as any,
          changedBy: input.updatedBy ?? null, reason: input.reason ?? 'upsert',
        },
      })
      .catch(() => {}) // history is best-effort; never block the edit on it
  }

  const saved = await prisma.masterFieldRule.upsert({
    where: { productType_fieldKey: workspaceKey({ productType, fieldKey: input.fieldKey }) },
    create: { productType, fieldKey: input.fieldKey, expr, updatedBy: input.updatedBy ?? null },
    update: { expr, version: { increment: 1 }, updatedBy: input.updatedBy ?? null },
  })
  return toRow(saved)
}

export async function removeMasterRule(input: {
  fieldKey: string
  productType?: string | null
  updatedBy?: string | null
}): Promise<{ removed: boolean }> {
  const productType = input.productType?.trim() || ALL_TYPES
  const existing = await prisma.masterFieldRule.findUnique({
    where: { productType_fieldKey: workspaceKey({ productType, fieldKey: input.fieldKey }) },
  })
  if (!existing) return { removed: false }
  await prisma.masterFieldRuleRevision
    .create({
      data: {
        productType, fieldKey: input.fieldKey, version: existing.version,
        snapshot: { expr: existing.expr, version: existing.version } as any,
        changedBy: input.updatedBy ?? null, reason: 'delete',
      },
    })
    .catch(() => {})
  await prisma.masterFieldRule.delete({ where: { id: existing.id } })
  return { removed: true }
}

export async function listMasterRuleRevisions(fieldKey: string, productType?: string | null) {
  return prisma.masterFieldRuleRevision.findMany({
    where: { fieldKey, productType: productType?.trim() || ALL_TYPES },
    orderBy: { version: 'desc' },
    take: 30,
  })
}

// ────────────────────────────────────────────────────────────────────
// Read-time evaluation
// ────────────────────────────────────────────────────────────────────

export interface MasterRuleValue {
  fieldKey: string
  value: unknown
  error: string | null
  warnings: string[]
  /** Which rule produced it, so the UI can name it. */
  productType: string | null
}

/**
 * Evaluate every master rule that applies to a product, on read. ~10 lines of composition, as
 * §1.6(C) said: resolve the master row's attributes once, then run each rule's expression against
 * them. No listing, no `resolveChannelField`.
 */
export async function evaluateMasterRulesForProduct(input: {
  productId: string
  locale?: string
  fieldKeys?: string[]
}): Promise<MasterRuleValue[]> {
  const product = await prisma.product.findUnique({ where: { id: input.productId }, include: { translations: true } })
  if (!product) throw new Error(`Product not found: ${input.productId}`)
  const rules = await listMasterRules(product.productType)
  if (rules.length === 0) return []

  // A productType-specific rule beats the '*' rule for the same field.
  const byField = new Map<string, MasterRuleRow>()
  for (const r of rules) {
    const cur = byField.get(r.fieldKey)
    if (!cur || (cur.productType === null && r.productType !== null)) byField.set(r.fieldKey, r)
  }

  const wanted = input.fieldKeys?.length ? new Set(input.fieldKeys) : null
  const parent = product.parentId
    ? await prisma.product.findUnique({ where: { id: product.parentId }, include: { translations: true } })
    : null
  const locale = normalizeLanguage(input.locale ?? PRIMARY_CONTENT_LOCALE)
  const resolved = resolveAttributes({ product: product as any, parent: parent as any, locale })
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(resolved)) flat[k] = v.value

  const out: MasterRuleValue[] = []
  for (const rule of byField.values()) {
    if (wanted && !wanted.has(rule.fieldKey)) continue
    const res = evaluateExpr(rule.expr, {
      lookup: (path) => {
        if (!path.includes('.') && !(path in flat)) return undefined
        return resolveSourcePath(path, flat, { ...product, parent } as any, locale)
      },
    })
    out.push({
      fieldKey: rule.fieldKey,
      value: res.error ? null : res.value,
      error: res.error ?? null,
      warnings: res.warnings,
      productType: rule.productType,
    })
  }
  return out.sort((a, b) => a.fieldKey.localeCompare(b.fieldKey))
}
