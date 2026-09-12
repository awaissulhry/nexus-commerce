import { describe, expect, it } from 'vitest'

import { retiresOnSave, shortcutHintState } from './shortcutHint'

describe('§14.6 — the shortcut hint retires; the way back does not', () => {
  it('shows the hint to an operator who has never saved', () => {
    expect(shortcutHintState(false, null)).toEqual({ showHint: true, showHelp: true })
  })

  it('retires it once they have', () => {
    expect(shortcutHintState(true, null)).toEqual({ showHint: false, showHelp: true })
  })

  it('🔴 shows NOTHING while the stored answer is unread — no flash of unasked-for advice', () => {
    // The third state. A boolean would have to guess, and guessing `false` renders the hint for a
    // tick and then snatches it away.
    expect(shortcutHintState(null, null)).toEqual({ showHint: false, showHelp: true })
  })

  it('🔴 `?` is PERMANENT — it renders in every state, including the unread one', () => {
    // The way back must not depend on the way out.
    for (const r of [true, false, null] as const)
      for (const o of [true, false, null] as const) expect(shortcutHintState(r, o).showHelp).toBe(true)
  })

  it('🔴 an explicit preference wins in BOTH directions — `?` is a toggle, not a one-way door', () => {
    // Caught ON SCREEN, not by a test: with a two-state `manuallyShown` flag, an operator who had
    // not yet retired the hint could never hide it — the default already showed it — while the
    // button announced itself as "Hide the keyboard shortcuts". Every unit test passed. A control
    // that says Hide and does not hide is worse than no control.
    expect(shortcutHintState(true, true).showHint).toBe(true)    // back after retiring
    expect(shortcutHintState(false, false).showHint).toBe(false) // hidden before ever retiring
    expect(shortcutHintState(null, true).showHint).toBe(true)
    expect(shortcutHintState(null, false).showHint).toBe(false)
  })

  it('no preference follows the retirement — three states, not two', () => {
    // `null` is "the operator has said nothing", which every fresh sheet is in and a boolean cannot
    // express. That is the same shape as `retired` itself, and for the same reason.
    expect(shortcutHintState(false, null).showHint).toBe(true)
    expect(shortcutHintState(true, null).showHint).toBe(false)
  })
})

describe('retiresOnSave — a SUCCESSFUL edit, never an attempted one', () => {
  it('retires on a real save', () => {
    expect(retiresOnSave(new Date())).toBe(true)
    expect(retiresOnSave('2026-09-02T04:00:00.000Z')).toBe(true)
    expect(retiresOnSave(0)).toBe(true) // an epoch timestamp is still a save
  })

  it('🔴 does not retire when nothing has saved', () => {
    // A REFUSED write is exactly when the shortcuts become useful. Retiring on "an edit happened"
    // would take the help away at the moment it started earning its line.
    expect(retiresOnSave(null)).toBe(false)
    expect(retiresOnSave(undefined)).toBe(false)
  })
})
