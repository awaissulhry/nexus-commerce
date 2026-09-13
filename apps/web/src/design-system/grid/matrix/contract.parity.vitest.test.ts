/**
 * MX.G — the PARITY GATE between the engine's Matrix contract and the wire contract.
 *
 * `design-system/grid/matrix/contract.ts` restates the shapes of
 * `_studio/matrix/contract.ts` because a design-system file may not import an app module and
 * survive its `apps/factory` mirror (the reason is measured in that file's header). A restatement
 * without a gate is a second truth, and this repo has a memory entry for exactly that
 * (`reference_two_column_builders_drift`: put the rule in the engine, assert parity in the gate).
 *
 * This file lives in `apps/web` and is NOT mirrored, so it is the one place that may import both.
 *
 * Two kinds of assertion, both of which must hold:
 *   · **compile-time**, the `assignable` helpers — each one only compiles if the two declarations
 *     are mutually assignable, so a field added on ONE side fails `tsc` before any test runs. They
 *     are not dead code: `tsc` is the assertion, and they are counted at runtime too so a future
 *     refactor cannot delete them and leave a green suite.
 *   · **runtime**, `toEqual` on every constant table — a label, a width or a member order that
 *     moves on one side is red here.
 */
import { describe, expect, it } from 'vitest'

import * as wire from '@/app/products/[id]/edit/_studio/matrix/contract'
import * as matrixCells from '../renderers/matrixCells'
import * as engine from './contract'

/**
 * `A` is assignable to `B` AND `B` is assignable to `A`, decided at the TYPE level.
 *
 * 🔴 The first version wrote this as `function bothWays<A extends B, B extends A>()`, which is
 * TS2313 — "Type parameter 'A' has a circular constraint" — and failed `tsc` on this file (measured
 * 2026-09-13 16:40, the coordinator's reading). A conditional type has no such restriction: each
 * direction is one `[X] extends [Y]` test (tuple-wrapped so a union is compared as a whole rather
 * than distributed), and the call below compiles ONLY when the parameter type resolves to `true` —
 * a field added on one side turns it into `false`, and passing `true` where `false` is expected is
 * a compile error. Value-level so vitest can count that each arm ran.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/* `Mutual<A, B> & true` is `true` when both directions hold and `never` otherwise — so the literal
   `true` at every call site is accepted exactly when the two declarations are equal. */
function bothWays<A, B>(_ok: Mutual<A, B> & true): true {
  return true
}

describe('the engine Matrix contract equals the wire Matrix contract', () => {
  it('every cell type is bidirectionally assignable', () => {
    /* Each line fails `npx tsc --noEmit` if the two declarations diverge in EITHER direction. */
    expect(bothWays<engine.MatrixCellKind, wire.MatrixCellKind>(true)).toBe(true)
    expect(bothWays<engine.ListingState, wire.ListingState>(true)).toBe(true)
    expect(bothWays<engine.ListingCell, wire.ListingCell>(true)).toBe(true)
    expect(bothWays<engine.FulfilmentMethod, wire.FulfilmentMethod>(true)).toBe(true)
    expect(bothWays<engine.FulfilmentCell, wire.FulfilmentCell>(true)).toBe(true)
    expect(bothWays<engine.SyncKind, wire.SyncKind>(true)).toBe(true)
    expect(bothWays<engine.SyncMode, wire.SyncMode>(true)).toBe(true)
    expect(bothWays<engine.SyncCell, wire.SyncCell>(true)).toBe(true)
    expect(bothWays<engine.QueueState, wire.QueueState>(true)).toBe(true)
    expect(bothWays<engine.QueueCell, wire.QueueCell>(true)).toBe(true)
    expect(bothWays<engine.PriceSource, wire.PriceSource>(true)).toBe(true)
    expect(bothWays<engine.PriceCell, wire.PriceCell>(true)).toBe(true)
    expect(bothWays<engine.SaleCell, wire.SaleCell>(true)).toBe(true)
    expect(bothWays<engine.MatrixCells, wire.MatrixCells>(true)).toBe(true)
  })

  it('every coordinate, write and verb type is bidirectionally assignable', () => {
    expect(bothWays<engine.CoordinateKind, wire.CoordinateKind>(true)).toBe(true)
    expect(bothWays<engine.MatrixCoordinate, wire.MatrixCoordinate>(true)).toBe(true)
    /* MX.F: the absent slot's widened kind (the eight + the reserved business cells). */
    expect(bothWays<engine.MatrixAbsentCellKind, wire.MatrixAbsentCellKind>(true)).toBe(true)
    expect(bothWays<engine.MatrixWritableKind, wire.MatrixWritableKind>(true)).toBe(true)
    expect(bothWays<engine.MatrixWriteCell, wire.MatrixWriteCell>(true)).toBe(true)
    expect(bothWays<engine.MatrixVerbId, wire.MatrixVerbId>(true)).toBe(true)
    expect(bothWays<engine.MatrixVerbTarget, wire.MatrixVerbTarget>(true)).toBe(true)
    /* The verb-preview shapes the registry adapter (`actions/matrixActions.ts`) types against. */
    expect(bothWays<engine.RefusalKind, wire.RefusalKind>(true)).toBe(true)
    expect(bothWays<engine.VerbChange, wire.VerbChange>(true)).toBe(true)
    expect(bothWays<engine.VerbRefusal, wire.VerbRefusal>(true)).toBe(true)
    expect(bothWays<engine.ConfirmLevel, wire.ConfirmLevel>(true)).toBe(true)
    expect(bothWays<engine.VerbPreview, wire.VerbPreview>(true)).toBe(true)
  })

  it('the app MATRIX_COPY satisfies the engine MatrixCopy requirement', () => {
    /* One direction on purpose: the app's table is WIDER (it carries the banner, the EU notice, the
       absent reasons and the footer note, none of which a cell renderer reads). What must hold is
       that everything the engine asks for is there with the right signature. This line IS the
       assertion — it fails `tsc`, not vitest, if a member is dropped or re-signed. */
    const copy: engine.MatrixCopy = wire.MATRIX_COPY
    expect(typeof copy.amazonManaged).toBe('string')
  })

  it('the engine copy table says the SAME WORDS as the app copy table, member by member', () => {
    /**
     * 🔴 The gate on `MATRIX_CELL_COPY`. The engine carries a default copy table because it must
     * render standalone — it is mirrored into `apps/factory`, where no `_studio` tree exists, and
     * the grid lab renders these cells with no page around them. A default is only honest while it
     * is IDENTICAL to the app's, so every member is exercised here rather than eyeballed.
     *
     * Arguments are chosen to exercise each branch a member has: both `pausedBy` levers, a `null`
     * quantity, an empty location list, both `clamped` sides, both `reported` values.
     */
    const e = matrixCells.MATRIX_CELL_COPY
    const w = wire.MATRIX_COPY
    let checked = 0
    const same = (a: string, b: string) => { expect(a).toBe(b); checked += 1 }

    same(e.amazonManaged, w.amazonManaged)
    same(e.uncounted, w.uncounted)
    same(e.closed, w.closed)
    same(e.notListed, w.notListed)
    same(e.uncountedHint, w.uncountedHint)
    same(e.closedHint, w.closedHint)
    same(e.guardFba, w.guardFba)
    same(e.setHere, w.setHere)
    same(e.sharedEu(['IT', 'DE', 'FR', 'ES']), w.sharedEu(['IT', 'DE', 'FR', 'ES']))
    same(e.followsPool(403, ['IT-MAIN'], 0), w.followsPool(403, ['IT-MAIN'], 0))
    same(e.followsPool(0, [], 3), w.followsPool(0, [], 3))
    same(e.pinnedAt(10), w.pinnedAt(10))
    same(e.pausedBy('POLICY', 7), w.pausedBy('POLICY', 7))
    same(e.pausedBy('LISTING', null), w.pausedBy('LISTING', null))
    same(e.reported('AFN'), w.reported('AFN'))
    same(e.reported('MFN'), w.reported('MFN'))
    same(e.followsBase('€105.00'), w.followsBase('€105.00'))
    same(e.formula('= $basePrice * 0.95'), w.formula('= $basePrice * 0.95'))
    same(e.clamped('floor'), w.clamped('floor'))
    same(e.clamped('ceiling'), w.clamped('ceiling'))

    /* A loop that asserts nothing still goes green. Count the arms, and check the COUNT against the
       interface's own member list so a member added to `MatrixCopy` cannot slip through unchecked. */
    expect(checked).toBe(20)
    expect(Object.keys(e).sort()).toEqual([
      'amazonManaged', 'clamped', 'closed', 'closedHint', 'followsBase', 'followsPool', 'formula',
      'guardFba', 'notListed', 'pausedBy', 'pinnedAt', 'reported', 'setHere', 'sharedEu',
      'uncounted', 'uncountedHint',
    ])
  })

  it('the constant tables are identical, member for member and in the same order', () => {
    expect([...engine.MATRIX_CELL_KINDS]).toEqual([...wire.MATRIX_CELL_KINDS])
    expect([...engine.INVENTORY_CELL_KINDS]).toEqual([...wire.INVENTORY_CELL_KINDS])
    expect([...engine.WRITABLE_CELL_KINDS]).toEqual([...wire.WRITABLE_CELL_KINDS])
    expect(engine.MATRIX_CELL_LABELS).toEqual(wire.MATRIX_CELL_LABELS)
    expect(engine.MATRIX_CELL_WIDTHS).toEqual(wire.MATRIX_CELL_WIDTHS)
    expect(engine.MATRIX_ABSENT_CELL_LABELS).toEqual(wire.MATRIX_ABSENT_CELL_LABELS)
    expect(engine.MATRIX_VERB_LABELS).toEqual(wire.MATRIX_VERB_LABELS)
    /* Key ORDER too — `MATRIX_CELL_KINDS` is the default column order inside a group, so a table
       whose keys reordered would change the grid without changing any value. */
    expect(Object.keys(engine.MATRIX_CELL_LABELS)).toEqual(Object.keys(wire.MATRIX_CELL_LABELS))
    expect(Object.keys(engine.MATRIX_ABSENT_CELL_LABELS)).toEqual(Object.keys(wire.MATRIX_ABSENT_CELL_LABELS))
    expect(Object.keys(engine.MATRIX_VERB_LABELS)).toEqual(Object.keys(wire.MATRIX_VERB_LABELS))
  })

  it('the writable set and the kind set agree with each other', () => {
    /* A positive control on the parity above: if both files were wrong in the same way, this still
       catches a `writable` member that is not a kind, or an inventory member that is not a kind. */
    for (const k of engine.WRITABLE_CELL_KINDS) expect(engine.MATRIX_CELL_KINDS).toContain(k)
    for (const k of engine.INVENTORY_CELL_KINDS) expect(engine.MATRIX_CELL_KINDS).toContain(k)
    expect(engine.MATRIX_CELL_KINDS.length).toBe(8)
    expect(Object.keys(engine.MATRIX_CELL_WIDTHS).sort()).toEqual([...engine.MATRIX_CELL_KINDS].sort())
    /* The absent-capable labels are EXACTLY the eight kinds' labels plus the two reserved business cells, in that order. */
    expect(Object.keys(engine.MATRIX_ABSENT_CELL_LABELS)).toEqual([...engine.MATRIX_CELL_KINDS, 'businessPrice', 'businessTiers'])
    for (const k of engine.MATRIX_CELL_KINDS) expect(engine.MATRIX_ABSENT_CELL_LABELS[k]).toBe(engine.MATRIX_CELL_LABELS[k])
    expect(engine.MATRIX_CELL_WIDTHS.salePrice).toBe(190)
  })
})
