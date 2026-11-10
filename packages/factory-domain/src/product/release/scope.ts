import type { Issue } from '../../core/errors'

/**
 * What a revision is released for (B-W2b-231; PRD-191 "Release by colourway and size"): some of the style's colourways and
 * some of its sizes, the others waiting for a later release of the same revision. Stored on StyleRevision as
 * `releasedColourwayIds` and `releasedSizes` (B-W2b-212); each list empty means every one ("all"), each independently.
 *
 * The database (StyleRevision_w2b4_release_scope) keeps the shape: colourways of the style and sizes of its range, each once,
 * checked when they change; on a RELEASED revision they only widen; fixed once OBSOLETE. These rules say the same in words
 * first, and add what the database cannot know at a release: a colourway archived or a size dropped from the range since the
 * scope was planned, and a scope that leaves nothing to make.
 *
 * Readers (planning, quotes, the tech pack, the work-order release): `inScope(scope, colourwayId, size)`.
 */

export interface ReleaseScope {
  /** Empty: every colourway of the style. */
  readonly colourwayIds: readonly string[]
  /** Empty: every size of the style's range. */
  readonly sizes: readonly string[]
}

export const WHOLE_SCOPE: ReleaseScope = Object.freeze({ colourwayIds: Object.freeze([]), sizes: Object.freeze([]) })

/** At most this many colourways or sizes in one scope (the style never has more). */
export const SCOPE_LIMIT = 200

export interface ScopeColourway {
  readonly id: string
  readonly code: string
  readonly status: string
}

/** The style as the scope reads it: its colourways (every status) and its size range, in the style's order. */
export interface ScopeStyle {
  readonly colourways: readonly ScopeColourway[]
  readonly sizes: readonly string[]
}

export const SCOPE_PROBLEMS = ['SCOPE_REPEATED', 'SCOPE_COLOURWAY_UNKNOWN', 'SCOPE_COLOURWAY_ARCHIVED', 'SCOPE_SIZE_OUTSIDE', 'SCOPE_EMPTY', 'SCOPE_NARROWS', 'SCOPE_NOT_WIDER'] as const
export type ScopeProblemCode = (typeof SCOPE_PROBLEMS)[number]

export interface ScopeProblem extends Issue {
  readonly code: ScopeProblemCode
  /** The colourway or size it is about (null: the whole scope). */
  readonly colourwayId: string | null
  readonly size: string | null
}

/** Every colourway and every size. */
export const isWhole = (scope: ReleaseScope): boolean => scope.colourwayIds.length === 0 && scope.sizes.length === 0

/** The cell (a colourway in a size) is released by this scope. */
export const inScope = (scope: ReleaseScope, colourwayId: string, size: string): boolean =>
  (scope.colourwayIds.length === 0 || scope.colourwayIds.includes(colourwayId)) && (scope.sizes.length === 0 || scope.sizes.includes(size))

/** The scope in the style's own order (colourways as the style lists them, sizes in range order), duplicates kept for the check. */
export function orderedScope(scope: ReleaseScope, style: ScopeStyle): ReleaseScope {
  const colourwayRank = new Map(style.colourways.map((colourway, index) => [colourway.id, index]))
  const sizeRank = new Map(style.sizes.map((size, index) => [size, index]))
  const by = <T>(rank: ReadonlyMap<T, number>) => (a: T, b: T) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER)
  return { colourwayIds: [...scope.colourwayIds].sort(by(colourwayRank)), sizes: [...scope.sizes].sort(by(sizeRank)) }
}

/** The active colourways and the sizes of the range this scope releases. */
export function scopeCells(scope: ReleaseScope, style: ScopeStyle): { readonly colourwayIds: string[]; readonly sizes: string[] } {
  const active = style.colourways.filter((colourway) => colourway.status === 'ACTIVE').map((colourway) => colourway.id)
  return {
    colourwayIds: active.filter((id) => scope.colourwayIds.length === 0 || scope.colourwayIds.includes(id)),
    sizes: style.sizes.filter((size) => scope.sizes.length === 0 || scope.sizes.includes(size)),
  }
}

/** "50, 52" or "50–56" for three or more neighbours of the range. */
export function sizeWords(sizes: readonly string[], range: readonly string[]): string {
  const ranked = [...new Set(sizes)].map((size) => ({ size, at: range.indexOf(size) }))
  const known = ranked.filter((entry) => entry.at >= 0).sort((a, b) => a.at - b.at)
  const runs: string[][] = []
  for (const entry of known) {
    const last = runs.at(-1)
    if (last && range.indexOf(last.at(-1)!) === entry.at - 1) last.push(entry.size)
    else runs.push([entry.size])
  }
  const parts = runs.flatMap((run) => (run.length >= 3 ? [`${run[0]}–${run.at(-1)}`] : run))
  return [...parts, ...ranked.filter((entry) => entry.at < 0).map((entry) => entry.size)].join(', ')
}

const codeOf = (style: ScopeStyle, id: string): string => style.colourways.find((colourway) => colourway.id === id)?.code ?? id

/** "every colourway and size", "BLK, RED in every size", "every colourway in 50–54", "BLK in 50, 52". */
export function scopeWords(scope: ReleaseScope, style: ScopeStyle): string {
  if (isWhole(scope)) return 'every colourway and size'
  const colourways = scope.colourwayIds.length === 0 ? 'every colourway' : scope.colourwayIds.map((id) => codeOf(style, id)).join(', ')
  const sizes = scope.sizes.length === 0 ? 'every size' : sizeWords(scope.sizes, style.sizes)
  return `${colourways} in ${sizes}`
}

/** What waits for a later release: the active colourways and the sizes of the range the scope leaves out ("RED and 56–60"); null: nothing. */
export function waitingWords(scope: ReleaseScope, style: ScopeStyle): string | null {
  const cells = scopeCells(scope, style)
  const colourways = style.colourways.filter((colourway) => colourway.status === 'ACTIVE' && !cells.colourwayIds.includes(colourway.id)).map((colourway) => colourway.code)
  const sizes = style.sizes.filter((size) => !cells.sizes.includes(size))
  const parts = [...(colourways.length > 0 ? [colourways.join(', ')] : []), ...(sizes.length > 0 ? [`size${sizes.length === 1 ? '' : 's'} ${sizeWords(sizes, style.sizes)}`] : [])]
  return parts.length === 0 ? null : parts.join(' and ')
}

const problem = (code: ScopeProblemCode, path: string, message: string, at: { colourwayId?: string; size?: string } = {}): ScopeProblem => ({
  code,
  path,
  message,
  colourwayId: at.colourwayId ?? null,
  size: at.size ?? null,
})

/**
 * A scope's own problems against the style as it is now: each once, colourways of the style and active, sizes of the range,
 * and at least one active colourway in one size left to make. Paths are `colourwayIds/<i>` and `sizes/<i>` (a body's), or
 * `scope` for the whole.
 */
export function scopeProblems(scope: ReleaseScope, style: ScopeStyle): ScopeProblem[] {
  const problems: ScopeProblem[] = []
  const seenColourways = new Set<string>()
  scope.colourwayIds.forEach((id, index) => {
    const colourway = style.colourways.find((entry) => entry.id === id)
    if (seenColourways.has(id)) problems.push(problem('SCOPE_REPEATED', `colourwayIds/${index}`, `${colourway?.code ?? id} is named twice: name each colourway once.`, { colourwayId: id }))
    else if (!colourway) problems.push(problem('SCOPE_COLOURWAY_UNKNOWN', `colourwayIds/${index}`, 'Not a colourway of the style.', { colourwayId: id }))
    else if (colourway.status !== 'ACTIVE') {
      problems.push(problem('SCOPE_COLOURWAY_ARCHIVED', `colourwayIds/${index}`, `Colourway ${colourway.code} is archived: it is not made, so it is not released. Take it out of the release.`, { colourwayId: id }))
    }
    seenColourways.add(id)
  })
  const seenSizes = new Set<string>()
  scope.sizes.forEach((size, index) => {
    if (seenSizes.has(size)) problems.push(problem('SCOPE_REPEATED', `sizes/${index}`, `Size ${size} is named twice: name each size once.`, { size }))
    else if (!style.sizes.includes(size)) problems.push(problem('SCOPE_SIZE_OUTSIDE', `sizes/${index}`, `Size ${size} is not in the style's range (${sizeWords(style.sizes, style.sizes) || 'none'}).`, { size }))
    seenSizes.add(size)
  })
  const cells = scopeCells(scope, style)
  if (problems.length === 0 && (cells.colourwayIds.length === 0 || cells.sizes.length === 0)) {
    problems.push(problem('SCOPE_EMPTY', 'scope', 'The release leaves nothing to make: release at least one active colourway in one size of the range.'))
  }
  return problems
}

/**
 * A later release of a RELEASED revision (the others waited): it only adds colourways or sizes (or all of them), never takes
 * one out, and it adds something. The database refuses a narrowing too; this says it first, in words.
 */
export function widenProblems(released: ReleaseScope, next: ReleaseScope, style: ScopeStyle, revision: number): ScopeProblem[] {
  const problems: ScopeProblem[] = []
  const now = scopeWords(released, style)
  const narrows = (old: readonly string[], wanted: readonly string[]) => (old.length === 0 ? wanted.length > 0 : wanted.length > 0 && old.some((value) => !wanted.includes(value)))
  if (narrows(released.colourwayIds, next.colourwayIds)) {
    const dropped = released.colourwayIds.length === 0 ? 'every colourway' : released.colourwayIds.filter((id) => !next.colourwayIds.includes(id)).map((id) => codeOf(style, id)).join(', ')
    problems.push(problem('SCOPE_NARROWS', 'colourwayIds', `Revision ${revision} is released for ${now}: a later release only adds colourways or sizes, so ${dropped} stays released.`))
  }
  if (narrows(released.sizes, next.sizes)) {
    const dropped = released.sizes.length === 0 ? 'every size' : sizeWords(released.sizes.filter((size) => !next.sizes.includes(size)), style.sizes)
    problems.push(problem('SCOPE_NARROWS', 'sizes', `Revision ${revision} is released for ${now}: a later release only adds colourways or sizes, so ${dropped} stays released.`))
  }
  if (problems.length === 0 && sameScope(released, next)) {
    problems.push(problem('SCOPE_NOT_WIDER', 'scope', `Revision ${revision} is released for ${now} already: add a colourway or a size, or release it for all of them.`))
  }
  return problems
}

/** The same colourways and sizes (in any order). */
export function sameScope(a: ReleaseScope, b: ReleaseScope): boolean {
  const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((value) => y.includes(value))
  return same(a.colourwayIds, b.colourwayIds) && same(a.sizes, b.sizes)
}

/**
 * The scope that leaves out every cell in `outside` (cells the release should not take: not covered by a certificate),
 * by sizes or else by colourways, keeping the most cells; null when neither leaves something to make or nothing is outside.
 */
export function scopeWithout(scope: ReleaseScope, style: ScopeStyle, outside: readonly { readonly colourwayId: string; readonly size: string }[]): ReleaseScope | null {
  if (outside.length === 0) return null
  const cells = scopeCells(scope, style)
  const badSizes = new Set(outside.map((cell) => cell.size))
  const badColourways = new Set(outside.map((cell) => cell.colourwayId))
  const bySizes = cells.sizes.filter((size) => !badSizes.has(size))
  const byColourways = cells.colourwayIds.filter((id) => !badColourways.has(id))
  const keptBySizes = bySizes.length * cells.colourwayIds.length
  const keptByColourways = byColourways.length * cells.sizes.length
  if (keptBySizes === 0 && keptByColourways === 0) return null
  if (keptBySizes >= keptByColourways) return { colourwayIds: [...scope.colourwayIds], sizes: bySizes }
  return { colourwayIds: byColourways, sizes: [...scope.sizes] }
}

/**
 * A work order's cells against the released scope of its revision (the work-order release's CELLS check): the cells it
 * leaves out, each with the words. Nothing for a revision released for every colourway and size.
 */
export function cellsOutsideScope<Cell extends { readonly id: string; readonly label: string; readonly colourwayId: string; readonly size: string }>(
  scope: ReleaseScope,
  cells: readonly Cell[],
): Cell[] {
  return isWhole(scope) ? [] : cells.filter((cell) => !inScope(scope, cell.colourwayId, cell.size))
}
