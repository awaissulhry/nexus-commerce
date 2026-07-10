/**
 * eBay variation-family pre-flight validator (pure, WARN-NEVER-BLOCK).
 *
 * A single, side-effect-free pass over the EXACT resolved axes + `specifications`
 * that `pushVariationGroup` is about to send. It NEVER throws, NEVER mutates its
 * inputs, and NEVER returns anything that blocks a push: every issue is advisory
 * and is surfaced to the operator via the push's `warningsSink` (returned to the
 * flat-file client as `axisWarnings`). Even `block-soft` issues only warn — they
 * name the likely eBay rejection so the operator can fix it, but the push still
 * proceeds (the goal is to turn cryptic eBay errors into legible warnings without
 * regressing a family that would otherwise publish, e.g. the AIREON group).
 *
 * Reuses the same primitives the push uses so what we validate == what we send:
 *   • axisSynonymKey  — canonical axis identity (Colore ≡ Color ≡ Farbe …)
 *   • validateGtin    — the existing mod-10 EAN/GTIN check (listing-preflight)
 */

import { axisSynonymKey } from './ebay-theme-axes.js'
import { validateGtin } from './listing-preflight.service.js'
import type { ResolvedVariationAxes } from './ebay-variation-push.service.js'

export type FamilyIssueSeverity = 'warn' | 'block-soft'

export interface FamilyIssue {
  severity: FamilyIssueSeverity
  code: string
  /** Operator-facing English, names the offending SKU(s)/value(s). */
  message: string
  /** The remedy — what to change in the flat-file / product. */
  fixHint: string
}

export interface ValidateVariationFamilyOptions {
  /** True when at least one variant's brand fell back to 'Xavia' (BRAND_DEFAULTED). */
  brandDefaulted?: boolean
  /** Per-variant clamped quantities (computeSafeQty) — powers ALL_ZERO. */
  safeQtys?: number[]
  /**
   * The axis names eBay ALREADY published for this listing, if known. When
   * supplied and they differ from the current specifications, raise
   * AXIS_STRUCTURE_CHANGE. When undefined the check is SKIPPED — we never
   * fabricate this from the declared/stored axes (which equal the current set by
   * construction and would produce a false negative).
   */
  priorPublishedAxisNames?: string[]
}

interface SpecLike {
  name: string
  values: string[]
}

// eBay variation limits (Inventory API "Managing variations" / aspect limits).
const MAX_VARIANTS = 250
const MAX_ASPECT_VALUE_LEN = 65
const MAX_ASPECT_NAME_LEN = 40

/**
 * Resolve the aspect value a variant carries for a given spec name — mirrors the
 * push's aspectsMap lookup (canonical key, lowercase key, then a synonym scan),
 * so the validator reads exactly the value the group/item PUT will send.
 */
export function variantAxisValue(row: Record<string, unknown>, specName: string): string {
  const canonKey = `aspect_${specName.replace(/\s+/g, '_')}`
  const canonLower = `aspect_${specName.toLowerCase().replace(/\s+/g, '_')}`
  let v = String((row[canonKey] ?? row[canonLower]) ?? '').trim()
  if (!v) {
    const dimKey = axisSynonymKey(specName)
    for (const [rk, rv] of Object.entries(row)) {
      if (!rk.startsWith('aspect_') || !rv) continue
      const an = rk.slice('aspect_'.length).replace(/_/g, ' ')
      if (axisSynonymKey(an) === dimKey) { v = String(rv).trim(); break }
    }
  }
  return v
}

const skuOf = (row: Record<string, unknown>): string =>
  String(row.sku ?? '').trim() || '(no SKU)'

export function validateVariationFamily(
  variantRows: Array<Record<string, unknown>>,
  resolved: Pick<ResolvedVariationAxes, 'validSpecs'>,
  specifications: SpecLike[],
  opts: ValidateVariationFamilyOptions = {},
): FamilyIssue[] {
  const issues: FamilyIssue[] = []
  const add = (
    severity: FamilyIssueSeverity,
    code: string,
    message: string,
    fixHint: string,
  ): void => { issues.push({ severity, code, message, fixHint }) }

  // The Custom Bundle fallback isn't a real axis — exclude it from axis checks.
  const isCustomBundle = specifications.length === 1 && specifications[0]?.name === 'Custom Bundle'
  const realSpecs = isCustomBundle ? [] : specifications

  // ── AXIS_COLLAPSED (block-soft) ──────────────────────────────────────────
  if (!resolved?.validSpecs || resolved.validSpecs.length === 0) {
    add('block-soft', 'AXIS_COLLAPSED',
      'No variation axis survived resolution, so eBay will receive a single "Custom Bundle" pseudo-axis instead of real variations.',
      'Ensure the variants carry differing values for at least one shared aspect (e.g. Colore/Taglia) and that the Variation Theme names it.')
  }

  // ── VARIATION_OVER_LIMIT (block-soft) ────────────────────────────────────
  if (variantRows.length > MAX_VARIANTS) {
    add('block-soft', 'VARIATION_OVER_LIMIT',
      `This family has ${variantRows.length} variants — eBay allows at most ${MAX_VARIANTS} per variation listing.`,
      `Split the family into groups of ${MAX_VARIANTS} or fewer variants.`)
  }

  // ── DUP_VARIATION (block-soft) — two variants, same canonical axis tuple ──
  // THE most important check: a same-size FBA+FBM overlap (GALE) produces two
  // SKUs with an identical Colour+Size tuple; eBay rejects a group with two
  // identical aspect combinations.
  if (realSpecs.length > 0) {
    const seen = new Map<string, string>() // tuple → first SKU
    for (const row of variantRows) {
      // Rows missing any axis value belong to VALUE_ITEM_MISMATCH / the missing-
      // aspect pre-check — don't false-positive them as duplicates here.
      if (realSpecs.some((s) => !variantAxisValue(row, s.name))) continue
      const tuple = realSpecs
        .map((s) => `${axisSynonymKey(s.name)}=${variantAxisValue(row, s.name).toLowerCase()}`)
        .join('|')
      const prior = seen.get(tuple)
      if (prior) {
        const combo = realSpecs.map((s) => `${s.name}=${variantAxisValue(row, s.name)}`).join(', ')
        add('block-soft', 'DUP_VARIATION',
          `Variants "${prior}" and "${skuOf(row)}" resolve to the SAME variation (${combo}) — eBay rejects a group with two identical aspect combinations.`,
          'Give each variant a distinct axis combination, or merge/remove the duplicate (a same-size FBA+FBM overlap should be a single variant).')
      } else {
        seen.set(tuple, skuOf(row))
      }
    }
  }

  // ── VALUE_CASE_COLLISION (warn) + ASPECT_VALUE_LEN (warn) ─────────────────
  for (const spec of realSpecs) {
    if (spec.name.length > MAX_ASPECT_NAME_LEN) {
      add('warn', 'ASPECT_VALUE_LEN',
        `Aspect name "${spec.name}" is ${spec.name.length} characters — eBay caps aspect names at ${MAX_ASPECT_NAME_LEN}.`,
        'Shorten the aspect/axis name.')
    }
    const lowerSeen = new Map<string, string>() // lowered → first-seen original
    for (const raw of spec.values) {
      const val = String(raw)
      const key = val.trim().toLowerCase()
      const prior = lowerSeen.get(key)
      if (prior != null && prior !== val) {
        add('warn', 'VALUE_CASE_COLLISION',
          `Axis "${spec.name}" has case/whitespace-variant duplicate values "${prior}" and "${val}" — eBay treats these as different variations, so buyers see two near-identical options.`,
          'Normalise the values to one canonical spelling/case across every variant.')
      } else if (prior == null) {
        lowerSeen.set(key, val)
      }
      if (val.length > MAX_ASPECT_VALUE_LEN) {
        add('warn', 'ASPECT_VALUE_LEN',
          `Value "${val.slice(0, 40)}…" on axis "${spec.name}" is ${val.length} characters — eBay caps aspect values at ${MAX_ASPECT_VALUE_LEN}.`,
          'Shorten the value.')
      }
    }
  }

  // ── VALUE_ITEM_MISMATCH (block-soft) — variant value not in the axis list ─
  for (const spec of realSpecs) {
    for (const row of variantRows) {
      const v = variantAxisValue(row, spec.name)
      if (!v) continue // missing value → the existing missing-aspect pre-check owns it
      if (!spec.values.some((sv) => sv === v)) {
        add('block-soft', 'VALUE_ITEM_MISMATCH',
          `Variant "${skuOf(row)}" has "${spec.name}" = "${v}", which isn't in that axis's published value list [${spec.values.join(', ')}] — eBay would reject this variant.`,
          "Align the variant's aspect value to one of the axis values (watch for trailing spaces / casing).")
      }
    }
  }

  // ── GTIN_INVALID (block-soft) + GTIN_EXEMPT_ASSUMED (warn) ────────────────
  const noEanSkus: string[] = []
  for (const row of variantRows) {
    const ean = row.ean
    if (ean != null && String(ean).trim() !== '') {
      const r = validateGtin(String(ean))
      if (!r.valid) {
        add('block-soft', 'GTIN_INVALID',
          `Variant "${skuOf(row)}" has an invalid EAN/GTIN "${String(ean).trim()}" (${r.reason ?? 'invalid'}).`,
          'Correct the barcode, or clear the cell to send "Does not apply".')
      }
    } else {
      noEanSkus.push(skuOf(row))
    }
  }
  if (noEanSkus.length > 0) {
    add('warn', 'GTIN_EXEMPT_ASSUMED',
      `${noEanSkus.length} variant(s) have no EAN/GTIN (${noEanSkus.slice(0, 8).join(', ')}${noEanSkus.length > 8 ? '…' : ''}) — eBay will receive "Does not apply".`,
      'Add real barcodes where the products have them; otherwise this is expected for GTIN-exempt items.')
  }

  // ── MIXED_CONDITION (warn) ───────────────────────────────────────────────
  const conditions = new Set(
    variantRows.map((r) => String(r.condition ?? '').trim()).filter(Boolean),
  )
  if (conditions.size > 1) {
    add('warn', 'MIXED_CONDITION',
      `Variants span ${conditions.size} different conditions (${[...conditions].join(', ')}) — a variation listing normally uses one condition for all variants.`,
      'Set a single condition across the family unless mixed conditions are intentional.')
  }

  // ── BRAND_DEFAULTED (warn) ───────────────────────────────────────────────
  if (opts.brandDefaulted) {
    add('warn', 'BRAND_DEFAULTED',
      'At least one variant had no brand set, so the brand aspect fell back to "Xavia".',
      'Set the correct brand on each product if "Xavia" is wrong.')
  }

  // ── ALL_ZERO (warn) ──────────────────────────────────────────────────────
  if (opts.safeQtys && opts.safeQtys.length > 0 && opts.safeQtys.every((q) => q <= 0)) {
    add('warn', 'ALL_ZERO',
      'Every variant resolves to 0 available quantity — eBay needs at least one sellable variation to publish this listing.',
      'Restock (or lower a stock buffer) on at least one variant before publishing.')
  }

  // ── AXIS_STRUCTURE_CHANGE (warn) — only when prior published axes supplied ─
  if (opts.priorPublishedAxisNames && opts.priorPublishedAxisNames.length > 0 && realSpecs.length > 0) {
    const now = realSpecs.map((s) => axisSynonymKey(s.name)).sort()
    const prior = opts.priorPublishedAxisNames.map((n) => axisSynonymKey(n)).sort()
    const differ = now.length !== prior.length || now.some((k, i) => k !== prior[i])
    if (differ) {
      add('warn', 'AXIS_STRUCTURE_CHANGE',
        `The variation axes changed from [${opts.priorPublishedAxisNames.join(', ')}] to [${realSpecs.map((s) => s.name).join(', ')}]. Changing the variation axes on a published listing isn't allowed in place — you'll need to end the listing and re-publish (new ItemID).`,
        'End the current eBay listing and re-publish to apply a different axis structure.')
    }
  }

  return issues
}
