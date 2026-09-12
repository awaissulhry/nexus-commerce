/**
 * The open-gesture rule, pure half.
 *
 * 🔴 WHAT THIS SUITE CANNOT SEE, stated so a green run is not read as more than it is: this
 * workspace's vitest is `environment: 'node'` with no jsdom, so **the DOM walk in `fillHandleHit`
 * — and therefore every AG selector it depends on — is NOT covered here.** That half is verified in
 * a real browser by `scripts/check-editor-open.mjs`, which fails when the walk names nothing.
 * These tests hold the decision the walk feeds, because a wrong answer there does not fail loudly:
 * it edits the WRONG ROW, which is worse than opening nothing.
 */
import { describe, expect, it } from 'vitest'

import { EDITOR_MODE_BY_KIND, FORMULA_EDITOR_MODE, fillHandleHit, hitFromParts } from './openGesture'

describe('hitFromParts', () => {
  it('names the cell by column key and ROW INDEX', () => {
    expect(hitFromParts({ colKey: 'basePrice', rowIndex: '7', pinned: null }))
      .toEqual({ colKey: 'basePrice', rowIndex: 7, rowPinned: null })
  })

  it('carries the pinned section through, both ends', () => {
    expect(hitFromParts({ colKey: 'name', rowIndex: '0', pinned: 'top' })?.rowPinned).toBe('top')
    expect(hitFromParts({ colKey: 'name', rowIndex: '0', pinned: 'bottom' })?.rowPinned).toBe('bottom')
  })

  it('accepts row index 0 — the first row is the one an operator reaches for first', () => {
    expect(hitFromParts({ colKey: 'name', rowIndex: '0', pinned: null })?.rowIndex).toBe(0)
  })

  /* 🔴 THE LOAD-BEARING ARM. `startEditingCell` takes a row INDEX; hand it a row id and AG resolves
     no node and returns silently — the fix would then reproduce the very silence it removes, and
     nothing would say so. A non-integer must abstain, not travel. */
  it('abstains on a row id, on junk, on a negative and on a fraction', () => {
    expect(hitFromParts({ colKey: 'name', rowIndex: 'cmokmy3a40078pm0p1fvnu523', pinned: null })).toBeNull()
    expect(hitFromParts({ colKey: 'name', rowIndex: '', pinned: null })).toBeNull()
    expect(hitFromParts({ colKey: 'name', rowIndex: '-1', pinned: null })).toBeNull()
    expect(hitFromParts({ colKey: 'name', rowIndex: '1.5', pinned: null })).toBeNull()
  })

  it('abstains when either half of the address is missing', () => {
    expect(hitFromParts({ colKey: null, rowIndex: '0', pinned: null })).toBeNull()
    expect(hitFromParts({ colKey: 'name', rowIndex: null, pinned: null })).toBeNull()
    expect(hitFromParts({ colKey: undefined, rowIndex: undefined, pinned: null })).toBeNull()
  })
})

describe('fillHandleHit', () => {
  /* The one thing about the DOM half that IS reachable without a DOM, and it matters: this runs on
     every double-click anywhere in the grid, so a target that cannot be walked must return null
     rather than throw — an exception here would kill the handler for every subsequent gesture and
     turn one wrong corner into a dead sheet. */
  it('is null, never a throw, for a target that cannot be walked', () => {
    expect(fillHandleHit(null)).toBeNull()
    expect(fillHandleHit(undefined)).toBeNull()
    expect(fillHandleHit({})).toBeNull()
    expect(fillHandleHit({ closest: 'not a function' })).toBeNull()
    expect(fillHandleHit(42)).toBeNull()
  })

  it('is null when the target is in the grid but not on a handle', () => {
    // A stand-in for a cell body: `closest` finds no `.ag-fill-handle` above it.
    expect(fillHandleHit({ closest: () => null })).toBeNull()
  })
})

describe('EDITOR_MODE_BY_KIND', () => {
  /* 🔴 The SET, not a spot check. The declaration exists so the browser gate can hold the live grid
     to it; a kind missing from it is a kind the gate silently stops asserting on — the vacuous
     pass at 0/0. The live contract read 2026-09-03 (`/studio/sheet`, master·DE, 96 columns) returns
     exactly text 46, select 23, number 18, longtext 9, boolean 0. */
  it('declares a mode for every kind the sheet can build', () => {
    expect(Object.keys(EDITOR_MODE_BY_KIND).sort()).toEqual(['boolean', 'longtext', 'number', 'select', 'text'])
    for (const mode of Object.values(EDITOR_MODE_BY_KIND)) expect(['inline', 'popup']).toContain(mode)
  })

  it('keeps short text and number INLINE, and long text a popup', () => {
    expect(EDITOR_MODE_BY_KIND.text).toBe('inline')
    expect(EDITOR_MODE_BY_KIND.number).toBe('inline')
    expect(EDITOR_MODE_BY_KIND.longtext).toBe('popup')
  })

  /* ✅ RULED BY THE OWNER, 2026-09-03: "we must keep select as a pop-up." The question was put to
     them with both readings of ruling 2 (its enumeration said inline; its own test — "a popup only
     where the content cannot fit the cell" — said popup for a 268-option list) and this is the
     answer. This test now guards a DECISION rather than holding a lane's judgement open. */
  it('keeps select (and yes/no, which is a select here) a popup — RULED by the Owner 2026-09-03', () => {
    expect(EDITOR_MODE_BY_KIND.select).toBe('popup')
    expect(EDITOR_MODE_BY_KIND.boolean).toBe('popup')
  })

  it('always puts the = editor in a popup, on every kind', () => {
    expect(FORMULA_EDITOR_MODE).toBe('popup')
  })
})
