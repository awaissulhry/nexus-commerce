import { goodOf, reportPayload, reworkOf, scrapOf, setGood, type BundleCard, type CardOperation, type Counts } from './model'

/**
 * Several bundles at once on SCR-090 (design floor.operation "Several bundles at once"; MES-100, MES-107): "Scan several, finish
 * once": a stack of scanned bundles with their quantities and a total, counted by size buttons without typing. Each bundle stays
 * its own report under its own client id (`POST /production/several-bundles/finish`; offline one queued report per bundle);
 * a refused one stays on the stack with its words, a held one goes through the team leader's override on its own. Pure.
 */

/** The most bundles one Finish takes (factory-domain production/onbehalf SEVERAL_LIMITS.maxBundles). */
export const MAX_STACK = 20

export interface StackRefusal {
  readonly code: string
  readonly message: string
  readonly fix: string | null
}

export interface StackRow {
  /** Its own client scan id: the same on a resend and on the override. */
  readonly clientScanId: string
  readonly card: BundleCard
  readonly operation: CardOperation
  readonly counts: Counts
  readonly refusal: StackRefusal | null
}

export const expectedOf = (row: Pick<StackRow, 'card' | 'operation'>): number => row.operation.expected ?? row.card.bundle.quantity

export interface StackTotals {
  readonly bundles: number
  readonly good: number
  readonly scrap: number
  readonly rework: number
}

export function stackTotals(rows: readonly StackRow[]): StackTotals {
  return rows.reduce(
    (total, row) => ({ bundles: total.bundles + 1, good: total.good + goodOf(row.counts, expectedOf(row)), scrap: total.scrap + scrapOf(row.counts), rework: total.rework + reworkOf(row.counts) }),
    { bundles: 0, good: 0, scrap: 0, rework: 0 },
  )
}

export type StackAdd = { readonly ok: true; readonly rows: readonly StackRow[] } | { readonly ok: false; readonly why: 'twice' | 'full' }

export function addToStack(rows: readonly StackRow[], row: StackRow): StackAdd {
  if (rows.some((other) => other.card.bundle.id === row.card.bundle.id)) return { ok: false, why: 'twice' }
  if (rows.length >= MAX_STACK) return { ok: false, why: 'full' }
  return { ok: true, rows: [...rows, row] }
}

export const takeOffStack = (rows: readonly StackRow[], clientScanId: string): readonly StackRow[] => rows.filter((row) => row.clientScanId !== clientScanId)

/** One piece more or fewer on a row: no typing (MES-106); never above the bundle's own pieces, never below none. */
export function stepRow(rows: readonly StackRow[], clientScanId: string, delta: 1 | -1): readonly StackRow[] {
  return rows.map((row) => {
    if (row.clientScanId !== clientScanId) return row
    const expected = expectedOf(row)
    const move = setGood(row.counts, Math.max(0, goodOf(row.counts, expected) + delta), row.card.bundle.quantity)
    return move.ok ? { ...row, counts: move.counts, refusal: null } : row
  })
}

export const ALL_SIZES = '*'

export interface StackSize {
  readonly id: string
  readonly label: string
  readonly pieces: number
  readonly bundles: number
}

/** The sizes on the stack in the order first scanned, each with its pieces (the size buttons, MES-107). */
export function sizesOf(rows: readonly StackRow[]): readonly StackSize[] {
  const sizes = new Map<string, StackSize>()
  for (const row of rows) {
    const label = row.card.bundle.size
    const was = sizes.get(label) ?? { id: label, label, pieces: 0, bundles: 0 }
    sizes.set(label, { ...was, pieces: was.pieces + goodOf(row.counts, expectedOf(row)), bundles: was.bundles + 1 })
  }
  return [...sizes.values()]
}

export const rowsOfSize = (rows: readonly StackRow[], size: string | null): readonly StackRow[] => (size === null || size === ALL_SIZES ? rows : rows.filter((row) => row.card.bundle.size === size))

/** The stack's report bodies, in the order scanned. */
export const stackItems = (rows: readonly StackRow[]): readonly Record<string, unknown>[] => rows.map((row) => ({ clientScanId: row.clientScanId, ...reportPayload(row.card, row.operation.id, row.counts, expectedOf(row)) }))

export interface StackOutcome {
  readonly clientScanId: string
  readonly status: 'accepted' | 'duplicate' | 'refused'
  readonly refusal: { readonly code: string; readonly message: string; readonly fix: string } | null
}

/** What stays on the stack after Finish: the refused bundles, with their words. */
export function afterFinish(rows: readonly StackRow[], outcomes: readonly StackOutcome[]): readonly StackRow[] {
  const byId = new Map(outcomes.map((outcome) => [outcome.clientScanId, outcome]))
  return rows.flatMap((row) => {
    const outcome = byId.get(row.clientScanId)
    return outcome?.status === 'refused' && outcome.refusal ? [{ ...row, refusal: { code: outcome.refusal.code, message: outcome.refusal.message, fix: outcome.refusal.fix } }] : []
  })
}

/** Bundles of one work order with different parts are joined here, so their shades must match (MES-078). */
export function joinedBundles(rows: readonly StackRow[]): readonly string[] {
  const byOrder = new Map<string, StackRow[]>()
  for (const row of rows) if (row.card.bundle.part) byOrder.set(row.card.workOrder.id, [...(byOrder.get(row.card.workOrder.id) ?? []), row])
  return [...byOrder.values()].flatMap((group) => (new Set(group.map((row) => row.card.bundle.part)).size >= 2 ? group.map((row) => row.card.bundle.id) : []))
}
