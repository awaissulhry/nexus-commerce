import type { ScanOperation } from '../scans/rules'

/**
 * A basket's route (owb- order workflow, S5 fl1; build/briefs/owb-fl2.md step 1 is the spec; LF _owb-fl-common.md § 1 and § 2
 * settle 6): the steps of its work order PLUS its own route edits (BasketRouteEdit rows, oldest first). Pure; ONE of the pair
 * with ./place.ts — every reader that walks a basket's steps (the scan rules, the guards, where, WIP, the basket read) calls it
 * with the work order's operations and gets the basket's own copy.
 *
 *   no edit     the operations array ITSELF (the same array, not a copy): today's answers, byte for byte
 *   SKIP        that operation is not scanned for this basket (`scanRequired: false`, `skipped: true`); the LAST scanned
 *               operation is never skipped (the command refuses it; a SKIP of it here is read as nothing)
 *   PUT_BACK    cancels the newest SKIP of that operation still standing
 *   ADD         an extra operation of the work order (settle 6: today's extra operation, made at the END and not scanned)
 *               becomes a scanned step of this basket right BEFORE its last scanned step (`scanRequired: true`,
 *               `unplanned: false`, `added: true`, a `seq` between the step before the last and the last)
 *   NORMAL      drops every earlier edit: the work order's route again
 *
 * The answer is in route order (by `seq`), as the scan rules read it.
 */

/**
 * What the pair reads of an operation (owb-fl2: a reader's own row type fits — the scan rules' ScanOperation, the bundle
 * tracker's operations — so every reader calls the SAME pair).
 */
export type RouteOperation = Pick<ScanOperation, 'id' | 'seq' | 'scanRequired'> & { readonly unplanned?: boolean | undefined }

/** The scanned operations in route order (scans/rules scannedOperations, for any RouteOperation). */
export const scannedSteps = <Op extends RouteOperation>(operations: readonly Op[]): Op[] => [...operations].filter((operation) => operation.scanRequired).sort((a, b) => a.seq - b.seq)

/** One route edit of ONE basket, as the readers read BasketRouteEdit (oldest first). */
export interface RouteEditFact {
  readonly kind: 'SKIP' | 'PUT_BACK' | 'ADD' | 'NORMAL'
  readonly operationId: string
}

/** What the route adds to an operation of the basket: skipped for it, or added for it. */
export interface RouteMarks {
  readonly skipped?: boolean | undefined
  readonly added?: boolean | undefined
}

/** The edits that still count: everything after the newest NORMAL, a SKIP cancelled by a later PUT_BACK left out. */
export function standingEdits(edits: readonly RouteEditFact[]): { readonly skipped: ReadonlySet<string>; readonly added: readonly string[] } {
  const lastNormal = edits.map((edit) => edit.kind).lastIndexOf('NORMAL')
  const counted = edits.slice(lastNormal + 1)
  const skips = new Map<string, number>()
  const added: string[] = []
  for (const edit of counted) {
    if (edit.kind === 'SKIP') skips.set(edit.operationId, (skips.get(edit.operationId) ?? 0) + 1)
    if (edit.kind === 'PUT_BACK' && (skips.get(edit.operationId) ?? 0) > 0) skips.set(edit.operationId, skips.get(edit.operationId)! - 1)
    if (edit.kind === 'ADD' && !added.includes(edit.operationId)) added.push(edit.operationId)
  }
  return { skipped: new Set([...skips].flatMap(([operationId, count]) => (count > 0 ? [operationId] : []))), added }
}

/** The basket's own route (see the file's head). */
export function basketRoute<Op extends RouteOperation>(operations: readonly Op[], edits: readonly RouteEditFact[]): (Op & RouteMarks)[] {
  if (edits.length === 0) return operations as (Op & RouteMarks)[]
  const { skipped, added } = standingEdits(edits)
  const scanned = scannedSteps(operations)
  const last = scanned.at(-1) ?? null
  const before = scanned.at(-2) ?? null
  // An added step stands just before the last scanned step: between the step before it and it (fractions keep the order).
  const addedSeq = (index: number): number => {
    if (!last) return Number.MAX_SAFE_INTEGER - added.length + index
    const low = before ? before.seq : last.seq - 1
    return low + ((last.seq - low) * (index + 1)) / (added.length + 1)
  }
  const route = operations.map((operation): Op & RouteMarks => {
    const at = added.indexOf(operation.id)
    let step: Op & RouteMarks = { ...operation }
    if (at >= 0 && operation.id !== last?.id) step = { ...step, scanRequired: true, unplanned: false, added: true, seq: addedSeq(at) }
    // A SKIP of an added step (after its ADD) skips it again; the last scanned step stays.
    if (skipped.has(operation.id) && step.scanRequired && operation.id !== last?.id) step = { ...step, scanRequired: false, skipped: true }
    return step
  })
  return route.sort((a, b) => a.seq - b.seq)
}

/** Whether the basket has a route of its own (an edit still standing). */
export function ownRoute(edits: readonly RouteEditFact[]): boolean {
  const { skipped, added } = standingEdits(edits)
  return skipped.size > 0 || added.length > 0
}
