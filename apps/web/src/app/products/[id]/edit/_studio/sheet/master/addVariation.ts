/**
 * PES.2 / F4 — what a new variation needs before anyone is asked to confirm it.
 *
 * `POST /api/catalog/products/:parentId/children` is the endpoint. It validates two things —
 * `sku` and `name` are present, and the SKU is globally unique (409 `DUPLICATE_SKU`) — and nothing
 * else. Everything below is what it does NOT check but an operator would want caught before a
 * product exists.
 *
 * Pure, because this is the COLLECT step of COLLECT → PREFLIGHT → CONFIRM → RUN and a form that
 * decides what is valid by eye is a form nobody can test.
 *
 * 🔴 Two things read out of the handler that its own comments get wrong:
 *
 * 1. The comment above the sanitiser says it lower-cases axis keys "for consistency with how the
 *    read path reads them". **It does not** — it only trims (`const key = String(k).trim()`). So
 *    `Colore` stays `Colore`. Anything relying on lower-cased keys would be relying on a comment.
 * 2. New children are drafts with channel sync disabled. The server validates the parent and
 *    sibling-copy relationship inside the same transaction as creation.
 */

import { familyAxes, type FamilyResponse } from './family'

export interface NewVariationDraft {
  sku: string
  name: string
  /** One entry per family axis — `{ Colore: 'Nero', Taglia: 'L' }`. */
  axisValues: Record<string, string>
  basePrice?: string
  totalStock?: string
  /** Optional: clone this sibling's channel listings (content + attributes, axis fields stripped). */
  copyFromProductId?: string
}

export type ProblemLevel = 'error' | 'warn'

export interface DraftProblem {
  field: 'sku' | 'name' | 'axis' | 'basePrice' | 'totalStock'
  level: ProblemLevel
  message: string
}

const trimmed = (v: string | undefined): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Build a SKU from the parent's and the axis values — `GALE-JACKET` + Nero/L → `GALE-JACKET-NERO-L`.
 *
 * A suggestion only; the operator can always overwrite it. It exists because the alternative is an
 * empty required field, and an operator inventing SKUs by hand is how a family ends up with three
 * naming conventions.
 */
export function suggestSku(parentSku: string | undefined, axisValues: Record<string, string>): string {
  const base = trimmed(parentSku)
  if (!base) return ''
  const parts = Object.values(axisValues)
    .map((v) => trimmed(v).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
  return parts.length > 0 ? `${base}-${parts.join('-')}` : base
}

/**
 * Everything wrong with this draft, worst first.
 *
 * `error` blocks the verb; `warn` is shown and does not. The split follows the same rule as the rest
 * of the lane: block what cannot work, warn about what an operator may have meant.
 */
export function validateNewVariation(draft: NewVariationDraft, family: FamilyResponse | null): DraftProblem[] {
  const problems: DraftProblem[] = []
  const sku = trimmed(draft.sku)
  const name = trimmed(draft.name)
  const axes = familyAxes(family)

  if (!sku) problems.push({ field: 'sku', level: 'error', message: 'A SKU is required' })
  else if (/\s/.test(sku)) problems.push({ field: 'sku', level: 'error', message: 'A SKU cannot contain spaces' })

  if (!name) problems.push({ field: 'name', level: 'error', message: 'A name is required' })

  // The server answers 409 for a global duplicate, but it cannot know about the family on screen —
  // and catching it here means the operator is not told "already exists" about a SKU they can see.
  const clash = [...(family?.children ?? []), ...(family?.self ? [family.self] : [])].find(
    (p) => p.sku.trim().toLowerCase() === sku.toLowerCase() && sku !== '',
  )
  if (clash) problems.push({ field: 'sku', level: 'error', message: `${clash.sku} is already in this family` })

  for (const axis of axes) {
    if (!trimmed(draft.axisValues[axis])) {
      // A WARNING, not a block. A family with an unset axis is a real state the catalogue already
      // contains, and refusing to create one would be this lane inventing a rule the server has not
      // got — but a variation the family cannot tell apart from its siblings is worth saying out loud.
      problems.push({ field: 'axis', level: 'warn', message: `${axis} is not set, so this variation cannot be told apart by it` })
    }
  }
  if (axes.length === 0) {
    problems.push({ field: 'axis', level: 'warn', message: 'This family has no variation axes set, so there is nothing to distinguish variations by' })
  }

  const price = trimmed(draft.basePrice)
  if (price && !Number.isFinite(Number(price))) {
    problems.push({ field: 'basePrice', level: 'error', message: `"${price}" is not a number` })
  }
  const stock = trimmed(draft.totalStock)
  if (stock && !/^\d+$/.test(stock)) {
    problems.push({ field: 'totalStock', level: 'error', message: 'Stock must be a whole number' })
  }

  return problems.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
}

export const blocking = (problems: readonly DraftProblem[]): DraftProblem[] => problems.filter((p) => p.level === 'error')
export const warnings = (problems: readonly DraftProblem[]): DraftProblem[] => problems.filter((p) => p.level === 'warn')
