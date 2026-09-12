/**
 * §14.6 — when the sheet's six-shortcut footer hint is on screen.
 *
 * The hint teaches the sheet's editing model (Enter to edit, Enter again to save, ⌘Z…). It earns
 * its line while an operator has never completed an edit, and stops earning it the moment they
 * have — at which point it is six items of permanent furniture in the one slot a REFUSAL also has
 * to use (§6.5). So it retires after the first successful edit, and `?` is the permanent way back.
 *
 * 🔴 Three states, not two, and the third is why this is a function rather than a boolean.
 * `retired` is `null` while the stored answer has not been read yet. Rendering the hint during that
 * window and hiding it a tick later is a FLASH of advice the operator did not ask for; rendering
 * nothing is honest, because we genuinely do not know yet. The slot holds its height either way
 * (`.nds-grid-sheet-noteslot`), so nothing moves.
 */
export type HintRetirement = boolean | null

export interface HintState {
  /** Render the six shortcuts. */
  showHint: boolean
  /** Render the `?`. It is PERMANENT — the way back must not depend on the way out. */
  showHelp: boolean
}

/**
 * @param override `null` = follow the retirement; `true`/`false` = the operator has said.
 *
 * 🔴 This was a `manuallyShown: boolean` and it was WRONG ON SCREEN while every unit test passed.
 * With `true` meaning "show", an operator who had not yet retired the hint could never hide it —
 * pressing `?` set the flag, the default already showed the hint, and nothing changed. The button
 * meanwhile announced itself as "Hide the keyboard shortcuts". **A control that says Hide and does
 * not hide is worse than no control**, and no assertion about `showHint` catches it, because the
 * defect is the disagreement between the label and the behaviour.
 *
 * A two-state flag cannot express "the operator has expressed no preference", which is the state
 * every fresh sheet is in. Three states, like `retired` itself.
 */
export function shortcutHintState(retired: HintRetirement, override: boolean | null): HintState {
  // An explicit preference wins in BOTH directions — that is what makes `?` a toggle rather than a
  // one-way door, and what makes its label true whichever way it currently reads.
  if (override !== null) return { showHint: override, showHelp: true }
  return { showHint: retired === false, showHelp: true }
}

/**
 * Has this operator completed an edit?
 *
 * 🔴 Keyed on a SUCCESSFUL save, never on "an edit was attempted". A refused write teaches nothing
 * about the shortcuts and is exactly when the operator most needs them — retiring the hint there
 * would remove the help at the moment it became useful.
 */
export function retiresOnSave(lastSavedAt: Date | string | number | null | undefined): boolean {
  return lastSavedAt != null
}

const KEY = 'nexus.studio.sheet.shortcutHint.retired'

/** `null` when nothing is stored, or when storage is unavailable — both mean "not yet known". */
export function readRetired(): HintRetirement {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === '1' ? true : v === '0' ? false : false
  } catch {
    // A private window, cleared site data, or a browser blocking storage. Falling back to `false`
    // shows the hint, which is the safe direction: advice nobody needed beats advice withheld.
    return false
  }
}

export function writeRetired(): void {
  try {
    window.localStorage.setItem(KEY, '1')
  } catch {
    // Not persisting is not a failure worth telling anyone about — the hint simply returns next
    // session, and `?` still works.
  }
}
