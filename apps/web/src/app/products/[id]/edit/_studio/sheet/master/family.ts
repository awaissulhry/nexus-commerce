/**
 * PES.2 / F1 — what a family IS, as pure functions.
 *
 * `GET /api/pim/family/:productId` answers three different shapes depending on what you asked
 * about: a PARENT gets its children, a CHILD gets its parent and siblings, a STANDALONE gets
 * neither. The bar has to read all three, and the difference is not cosmetic — the verbs a
 * standalone can offer (promote) are the ones a parent cannot.
 *
 * Pure, so the role rules and the wording are tested rather than eyeballed once.
 */

export type FamilyRole = 'parent' | 'child' | 'standalone'

export interface FamilyMember {
  id: string
  sku: string
  name: string | null
  /**
   * The axis values for this variation — Colore: Nero, Taglia: L.
   *
   * ⚠ `null` on every child in the catalogue today (measured 2026-09-01, GALE-JACKET's 20). The bar
   * therefore does NOT promise per-child axis values; it names the family's AXES, which the parent
   * does carry. Showing an axis column full of blanks would read as a loading failure rather than
   * as an un-backfilled field.
   */
  variantAttributes: Record<string, unknown> | null
}

export interface FamilyResponse {
  role: FamilyRole
  self: { id: string; sku: string; name: string | null; isParent: boolean; parentId: string | null; variationTheme: string | null; variationAxes: string[] | null }
  parent: { id: string; sku: string; name: string | null; variationTheme: string | null; variationAxes?: string[] | null } | null
  children: FamilyMember[]
  siblings: FamilyMember[]
}

/** The family's axes, from the array — never split off `variationTheme`, which is a display string. */
export function familyAxes(family: FamilyResponse | null): string[] {
  const axes = family?.role === 'child' ? family.parent?.variationAxes : family?.self?.variationAxes
  if (Array.isArray(axes) && axes.length > 0) return axes.filter((a) => typeof a === 'string' && a.trim())
  return []
}

/** How many products this family holds INCLUDING the parent — what the sheet shows as rows. */
export function familySize(family: FamilyResponse | null): number {
  if (!family) return 0
  if (family.role === 'parent') return family.children.length + 1
  if (family.role === 'child') return family.siblings.length + 2 // siblings + self + parent
  return 1
}

export interface FamilySummary {
  /** The role word an operator reads: "Parent", "Variation", "Standalone product". */
  role: string
  /** One line under it — counts and axes, or the honest absence of them. */
  detail: string
  /** True when this product could hold variations but has none. */
  childless: boolean
}

/**
 * The bar's two lines.
 *
 * 🔴 A childless parent says so explicitly. There are 22 of them on prod (the EBAY_LISTING_SHELL
 * rows), and drawing one as an ordinary parent with an empty sheet reads as a loading bug — "this
 * parent has no variations yet" is the single most useful thing the bar can say about it.
 */
export function summariseFamily(family: FamilyResponse | null): FamilySummary {
  if (!family) return { role: '—', detail: 'Loading the family…', childless: false }
  const axes = familyAxes(family)
  const axisText = axes.length > 0 ? axes.join(' × ') : 'no variation axes set'

  if (family.role === 'parent') {
    const n = family.children.length
    if (n === 0) return { role: 'Parent', detail: `No children yet · ${axisText}`, childless: true }
    return { role: 'Parent', detail: `${n} ${n === 1 ? 'child' : 'children'} · ${axisText}`, childless: false }
  }
  if (family.role === 'child') {
    const n = family.siblings.length
    const parentSku = family.parent?.sku ?? 'its parent'
    return {
      role: 'Child',
      detail: n > 0 ? `of ${parentSku} · ${n} sibling${n === 1 ? '' : 's'}` : `of ${parentSku} · the only child`,
      childless: false,
    }
  }
  return { role: 'Standalone product', detail: 'Not part of a family', childless: false }
}

/**
 * The role reason for the one verb the registry does not own yet.
 *
 * 🔴 This used to answer for all four verbs. It no longer does, and the trim is the point: once
 * `familyActions` declared promote / attach / unlink / reparent / demote, every one of those had
 * TWO sources for "may this run, and if not why" — and two copies of a rule is exactly what the
 * action registry exists to prevent. The surviving entry is `add-variation`, which is F4 and has
 * no registry definition to be the single source yet; it moves the moment F4 lands and this
 * function goes with it.
 *
 * Returned as a reason rather than a boolean because an unavailable verb explains itself: "promote
 * this product first" teaches the operator the model, a greyed-out button teaches them nothing.
 */
export function familyVerbAvailability(family: FamilyResponse | null): Record<string, string | null> {
  const role = family?.role
  return {
    'add-variation': role === 'parent' ? null : 'Only a parent can hold children — promote this product first',
  }
}
