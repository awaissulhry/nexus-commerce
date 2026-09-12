/**
 * VP.3 — what a family's axes COVER, as pure functions.
 *
 * `variantCoverage` is MOVED here from `_studio/variants/coverage.ts` (spec §6: "fold its tuple
 * logic into the new family module — do not lose it"). Its body is unchanged; everything else in
 * this file is new, because the old page only ever asked two questions (which variants are missing
 * an axis value, which share a combination) and the family band asks a third: how many combinations
 * COULD exist, and which ones do not.
 *
 * Pure, and tested — this repo's web vitest is node-only with no JSX transform, so a rule that
 * lives in a `.tsx` cannot be imported by a test at all. Every decision that can be a function is
 * one, and only the drawing is left in the components.
 */

/** The column shape these rules read. `SheetColumn` satisfies it structurally. */
export interface AxisColumnLike {
  key: string
  label?: string
  axis?: boolean
  /**
   * The attribute's declared option list, in the SCHEMA's order.
   *
   * 🔴 This is what "in their defined order" (§3.1/§3.3) means, and the alternative is visibly
   * wrong. The catalogue read returns children `orderBy: { sku: 'asc' }`
   * (`sheet-rows.service.ts:352`), so ordering a size axis by first appearance across the rows
   * gives `3XL, 4XL, 5XL, L, M, S, XL, XS, XXL, XXS` — alphabetical order of size CODES, which is
   * not an order any operator recognises. The canvas shows `XXS, XS, S, M, L, XL, XXL, 3XL, 4XL,
   * 5XL`: the schema's own enum order. So the option list wins where there is one, and first
   * appearance is the fallback for an open axis that has none.
   */
  options?: string[]
  optionLabels?: Record<string, string>
  /** Carried through to the summary; see `AxisSummary.storedKey`. */
  storedKey?: string
}

/** The row shape these rules read. `StudioRow` satisfies it structurally. */
export interface VariantRowLike {
  id: string
  sku: string
  isParent: boolean
  values: Record<string, { value: unknown; mapped?: { status?: string; value?: unknown } | null }>
  /**
   * The row's axis values, keyed by the family's axis keys.
   *
   * 🔴 On the real catalogue this is the ONLY place they are — measured on GALE-JACKET: the family's
   * axes are `Colore` and `Taglia`, and `values` has no entry under either name because the sheet
   * has no column for them. So `axisCode` reads HERE first and falls back to `values`, while
   * `variantCoverage` below keeps reading `values` alone, unchanged from the page it was moved from.
   */
  axisValues?: Record<string, string>
}

/** One axis value, as the band and the generate dialog show it. */
export interface AxisValue {
  code: string
  label: string
  /** How many variants carry it. */
  count: number
}

export interface AxisSummary {
  valueOrder?: string[]
  key: string
  label: string
  /** The ATTRIBUTE key this axis is stored under — the bridge to its sheet column. See `FamilyAxis`. */
  storedKey?: string
  values: AxisValue[]
}

/**
 * The tuple separator.
 *
 * 🔴 An ESCAPE, never a literal NUL typed into the source. A raw NUL makes the whole file `data` to
 * `file(1)` and BLINDS `grep`, which gives up on it without saying so and exits 1 — the same code it
 * uses for "no match" (reference_nul_byte_in_source_blinds_grep). `tsc` is perfectly happy, so
 * nothing warns you. I wrote two of these into this file and VP.1 found them by a byte-level read
 * within the hour; the trap has already cost this programme a cycle when a lane concluded another
 * lane's edit was missing. The CHARACTER was the right choice — it cannot collide with an axis code,
 * where a `-` or a `/` can — the SPELLING was not.
 */
const SEP = '\u0000'

/* ── reading one cell ─────────────────────────────────────────────────────────────────────── */

/**
 * The value this row actually carries on this axis — the MAPPED value when the mapping engine
 * produced one, else the stored value. Lifted verbatim out of the old `variantCoverage` so the two
 * questions cannot start reading the cell differently.
 */
export function axisCellValue(row: VariantRowLike, key: string): unknown {
  const cell = row.values[key]
  return cell?.mapped?.status === 'mapped' ? cell.mapped.value : cell?.value
}

/** Is this cell's value absent for coverage purposes? The old rule, unchanged. */
export function isAxisValueEmpty(value: unknown): boolean {
  return value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)
}

/**
 * The axis value as a stable CODE — the key a tuple is built from. `null` when there is none.
 *
 * `axisValues` FIRST, then the cell. Not the other way round: the cell is the sheet's `color`/`size`
 * column, which on GALE-JACKET holds `null` on 19 of 20 children while `axisValues` holds the real
 * `Nero` / `3XL`; preferring the cell would answer "no axis values" for a family that has them.
 */
export function axisCode(row: VariantRowLike, key: string): string | null {
  const stated = row.axisValues?.[key]
  if (typeof stated === 'string' && stated.trim()) return stated
  const value = axisCellValue(row, key)
  if (isAxisValueEmpty(value)) return null
  return Array.isArray(value) ? String(value[0]) : String(value)
}

/* ── the old page's two questions, moved ──────────────────────────────────────────────────── */

/** Diagnose complete tuples without merging listings, translating values, or inventing defaults. */
export function variantCoverage(columns: readonly AxisColumnLike[], rows: readonly VariantRowLike[]) {
  const axes = columns.filter(column => column.axis === true)
  const missing: string[] = [], tuples = new Map<string, string[]>()
  if (!axes.length) return { missing, duplicates: [] as string[][] }
  for (const row of rows) {
    if (row.isParent) continue
    const values = axes.map(axis => axisCellValue(row, axis.key))
    if (values.some(isAxisValueEmpty)) { missing.push(row.sku); continue }
    const key = JSON.stringify(values), members = tuples.get(key) ?? []
    members.push(row.sku); tuples.set(key, members)
  }
  return { missing, duplicates: [...tuples.values()].filter(members => members.length > 1) }
}

/* ── the band's third question ────────────────────────────────────────────────────────────── */

/**
 * The values an axis actually has on this family, in the order §3.1 asks for.
 *
 * The COUNT is variants carrying the value; the chip's "2 values" is the number of entries here.
 */
export function axisSummary(column: AxisColumnLike, rows: readonly VariantRowLike[]): AxisSummary {
  const counts = new Map<string, number>()
  const firstSeen: string[] = []
  for (const row of rows) {
    if (row.isParent) continue
    const code = axisCode(row, column.key)
    if (code === null) continue
    if (!counts.has(code)) firstSeen.push(code)
    counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  const declared = column.options ?? []
  const rank = new Map(declared.map((code, i) => [code, i]))
  /* Declared values first, in the schema's order; anything an operator typed that the schema does
     not declare keeps its first-appearance position AFTER them, rather than being dropped or
     silently sorted into the middle of a list it is not part of. */
  const ordered = [
    ...firstSeen.filter(code => rank.has(code)).sort((a, b) => rank.get(a)! - rank.get(b)!),
    ...firstSeen.filter(code => !rank.has(code)),
  ]
  return {
    key: column.key,
    label: column.label ?? column.key,
    storedKey: column.storedKey,
    values: ordered.map(code => ({ code, label: column.optionLabels?.[code] ?? code, count: counts.get(code) ?? 0 })),
  }
}

/** Which case the family is in. `ok` is the only one whose numbers are numbers. */
export type CoverageState = 'ok' | 'no-axes' | 'no-values'

export interface CombinationCoverage {
  /**
   * 🔴 `null` is NOT zero, and these three are nullable for the reason this codebase already rules
   * twice — `ViewChip.count` ("`null` means nobody has counted yet; `0` means counted, and there are
   * none … a renderer must never print `(0)` for it") and `studio-sheet.service.ts:341`
   * ("`null` when the mapping enrichment did not run — never 0 for that").
   *
   * I obeyed that rule where `ViewChip` TYPED it and broke it here, where I wrote the type myself:
   * this returned `combinations: 0` for "the axis values are empty so nothing could be computed",
   * indistinguishable from a real measured zero. Measured consequence on AIREON (40 children, two
   * axes DECLARED, zero values stored): the band printed `0 of 0 combinations exist · 0 missing`
   * while the chip beside it said 40 variants are missing axis values — one bar, two contradictory
   * statements, both from this function. Nullable makes that impossible by construction rather than
   * guarded by an `if` the next branch can forget.
   */
  combinations: number | null
  /** Distinct tuples that exist on a variant. `null` when nothing could be counted. */
  existing: number | null
  /** The tuples that do not exist, as code arrays in axis order. `null` when nothing was counted. */
  missing: string[][] | null
  /** Which of the three cases this is — so a caller branches on the STATE, not on a zero. */
  state: CoverageState
  /** SKUs sharing one tuple. Always real: a duplicate is observed, never derived from a product. */
  duplicates: string[][]
  /** SKUs with at least one axis cell empty. Always real, and the count AIREON's band needs. */
  incomplete: string[]
}

/**
 * The family band's sentence, and the two toolbar counts, from ONE pass.
 *
 * 🔴 `combinations` is the product of the values that are PRESENT, not of the schema's option
 * lists. A size axis whose schema declares 24 sizes while the family uses 10 would otherwise read
 * "20 of 48 combinations exist · 28 missing" and invite an operator to generate 28 variants nobody
 * asked for. The dialog is where new values are added deliberately (§3.4); the band reports what
 * the family HAS.
 */
export function combinationCoverage(axes: readonly AxisSummary[], rows: readonly VariantRowLike[]): CombinationCoverage {
  /* The two degenerate cases count NOTHING and say so. `incomplete` is still real in the second:
     a family with declared axes and no stored values has every variant missing them, which is
     exactly what the operator needs told. */
  const variants = rows.filter(row => !row.isParent)
  if (axes.length === 0) {
    return { combinations: null, existing: null, missing: null, state: 'no-axes', duplicates: [], incomplete: [] }
  }
  if (axes.every(axis => axis.values.length === 0)) {
    return { combinations: null, existing: null, missing: null, state: 'no-values', duplicates: [], incomplete: variants.map(row => row.sku) }
  }
  const combinations = axes.reduce((n, axis) => n * axis.values.length, 1)
  const present = new Map<string, string[]>()
  const incomplete: string[] = []
  for (const row of variants) {
    const codes = axes.map(axis => axisCode(row, axis.key))
    if (codes.some(code => code === null)) { incomplete.push(row.sku); continue }
    const key = (codes as string[]).join(SEP)
    present.set(key, [...(present.get(key) ?? []), row.sku])
  }
  const missing = cartesian(axes.map(axis => axis.values.map(v => v.code)))
    .filter(tuple => !present.has(tuple.join(SEP)))
  return {
    combinations,
    existing: present.size,
    missing,
    state: 'ok',
    duplicates: [...present.values()].filter(skus => skus.length > 1),
    incomplete,
  }
}

/** Every tuple of one value per axis, axis order preserved. */
export function cartesian(lists: readonly (readonly string[])[]): string[][] {
  return lists.reduce<string[][]>((acc, list) => acc.flatMap(prefix => list.map(value => [...prefix, value])), [[]])
}

/* ── row order ────────────────────────────────────────────────────────────────────────────── */

/**
 * Parent first, then by axis-value order (§3.3) — **NOT alphabetical SKU**, which is what the
 * catalogue read hands back and what puts `3XL` above `XS`.
 *
 * A variant with an empty axis cell sorts to the END rather than to the front: it is the exception
 * an operator is looking for, and burying it between complete rows makes the "Missing axis values"
 * chip the only way to find it.
 */
export function orderByAxisValues<T extends VariantRowLike>(rows: readonly T[], axes: readonly AxisSummary[]): T[] {
  const rank = axes.map(axis => new Map((axis.valueOrder ?? axis.values.map(v => v.code)).map((code, i) => [code, i])))
  const keyOf = (row: T) => axes.map((axis, i) => {
    const code = axisCode(row, axis.key)
    /* An unknown or absent code sorts last — `Number.MAX_SAFE_INTEGER`, not -1, which would have
       put exactly the rows an operator must notice at the top of every family. */
    return code === null ? Number.MAX_SAFE_INTEGER : rank[i].get(code) ?? Number.MAX_SAFE_INTEGER
  })
  return [...rows].sort((a, b) => {
    if (a.isParent !== b.isParent) return a.isParent ? -1 : 1
    const ka = keyOf(a), kb = keyOf(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
    return a.sku.localeCompare(b.sku)
  })
}
