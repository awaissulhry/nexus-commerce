/**
 * Editing correctness (group 3) — one rule for "is this still the same value", shared by the mutation layer's
 * compare-and-set (`expected`) and a person's Undo (rollback.service.ts changedSinceUndo). Pure.
 */

/** A column as compared: a Decimal as a number, a date as ISO, else as it is. */
export function comparable(v: unknown): number | string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') return (v as { toNumber: () => number }).toNumber()
  return v as number | string
}

const cents = (n: number) => Math.round(Number((n * 100).toFixed(6)))

/**
 * Same value to the cent: a budget is "20.00" in one place and 20 in another, and a 3-decimal €1.005 logged before writes
 * were rounded is the €1.01 Nexus holds; 45 and 45.0 are one bid. Anything else compares as it is.
 */
export function sameToTheCent(a: unknown, b: unknown): boolean {
  const x = comparable(a)
  const y = comparable(b)
  if (x === y) return true
  if (x == null || y == null || x === '' || y === '') return false
  const nx = Number(x)
  const ny = Number(y)
  return Number.isFinite(nx) && Number.isFinite(ny) && cents(nx) === cents(ny)
}

/** A budget to the cent, as Amazon keeps it (1.005 is €1.01): written, logged and compared as one value. */
export const budgetToTheCent = (eur: number): number => cents(eur) / 100
