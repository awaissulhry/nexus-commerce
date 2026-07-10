/**
 * Safeguard S2 — pre-publish warning issues (WARN, NEVER BLOCK).
 *
 * Pure helpers so vitest can exercise the client-side conflict scan without the
 * React client. The pre-publish modal composes three issue sources:
 *
 *   1. axis-warning  — resolvedAxisWarnings from Layer A (resolveFamilyAxes),
 *                      surfaced via the variation-cells endpoint (server-computed).
 *   2. suppressed    — resolvedAxisSuppressed strays dropped as fingerprint
 *                      duplicates of a declared axis — shown read-only ("no action").
 *   3. conflict      — the ONE signal not already computed server-side: a single
 *                      variant carrying TWO synonym-equivalent aspect keys with
 *                      DIFFERING values (e.g. aspect_Color="Red" + aspect_Colore=
 *                      "Rosso"). eBay honors only one — the operator should drop
 *                      the duplicate. Same-value synonym dupes are harmless (the
 *                      S3 reconcile folds them) and are NOT flagged.
 *
 * None of this blocks the push — the modal always offers "Publish anyway".
 */

import { axisSynonymKey } from './variationValueOrder.pure'

export interface AspectConflict {
  /** Variant SKU the conflict was found on. */
  sku: string
  /** The competing aspect names + their differing values on this variant. */
  entries: Array<{ name: string; value: string }>
}

export interface PrePublishIssue {
  kind: 'axis-warning' | 'suppressed' | 'conflict'
  /** Plain-language description of the issue. */
  message: string
  /** The concrete fix (omitted for read-only "no action needed" notes). */
  fix?: string
  /** Variant SKU, when the issue is row-specific. */
  sku?: string
}

/**
 * Scan variant rows for synonym-conflicting aspect keys. For each row, group its
 * `aspect_*` keys by synonym dimension; a group with ≥2 keys carrying differing
 * trimmed non-empty values is a conflict.
 *
 * Custom axes (no synonym group) fold to their own lowercase name as the key, so
 * two genuinely different axes never collide.
 */
export function scanAspectConflicts(rows: Array<Record<string, unknown>>): AspectConflict[] {
  const out: AspectConflict[] = []
  for (const r of rows) {
    const sku = String((r as { sku?: unknown }).sku ?? '').trim()
    const byDim = new Map<string, Array<{ name: string; value: string }>>()
    for (const [k, v] of Object.entries(r)) {
      if (!k.startsWith('aspect_')) continue
      const value = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()
      if (!value) continue
      // aspect_Colore → "Colore"; aspect_Tipo_di_prodotto → "Tipo di prodotto"
      const name = k.slice('aspect_'.length).replace(/_/g, ' ').trim()
      if (!name) continue
      const dim = axisSynonymKey(name)
      const arr = byDim.get(dim) ?? []
      arr.push({ name, value })
      byDim.set(dim, arr)
    }
    for (const entries of byDim.values()) {
      if (entries.length < 2) continue
      const distinct = new Set(entries.map((e) => e.value))
      if (distinct.size < 2) continue // same value under two synonym keys = harmless dup
      out.push({ sku, entries })
    }
  }
  return out
}

/** One-line, operator-facing description of a synonym conflict. */
export function describeConflict(c: AspectConflict): string {
  const parts = c.entries.map((e) => `${e.name} (${e.value})`).join(' and ')
  const skuLabel = c.sku ? `Variant ${c.sku}` : 'A variant'
  return `${skuLabel} has both ${parts} — eBay uses only one; remove the duplicate aspect.`
}

/**
 * Compose the full ordered issue list for the pre-publish modal from the three
 * sources. Conflicts first (they need an operator edit), then server axis
 * warnings, then the read-only suppressed notes. Empty result → no modal.
 */
export function buildPrePublishIssues(input: {
  conflicts: AspectConflict[]
  axisWarnings: string[]
  suppressed: string[]
}): PrePublishIssue[] {
  const issues: PrePublishIssue[] = []

  for (const c of input.conflicts) {
    issues.push({
      kind: 'conflict',
      sku: c.sku || undefined,
      message: describeConflict(c),
      fix: 'Open the variant and delete the duplicate aspect so only one name/value remains.',
    })
  }

  // Dedupe the server-derived strings — the same warning can arrive from
  // multiple parents pushed together.
  for (const w of dedupe(input.axisWarnings)) {
    issues.push({
      kind: 'axis-warning',
      message: w,
      fix: 'Check the Variation Theme and each axis has ≥2 clean values before publishing.',
    })
  }

  for (const s of dedupe(input.suppressed)) {
    issues.push({
      kind: 'suppressed',
      message: `Dropped "${s}" as a duplicate of a declared axis — no action needed.`,
    })
  }

  return issues
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const v = (raw ?? '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}
