import { createElement, Fragment, type ReactNode } from 'react'

/** `EditModeBar`'s words (B-W2b-04). English by default; `message` and `applyLabel` still win over these. */
export interface EditModeBarLabels {
  /** The bar's region name. */
  region: string
  /** The count line: "**3** unsaved changes". */
  unsaved: (count: number) => ReactNode
  /** Without a count. */
  unsavedNoCount: ReactNode
  /** Before the shortcut key: "Save with" ⌘S. */
  saveWith: string
  discard: string
  /** Apply's words when the host passes no `applyLabel`. */
  apply: ReactNode
}

export const EDIT_MODE_BAR_LABELS: EditModeBarLabels = {
  region: 'Edit mode',
  unsaved: (count) => createElement(Fragment, null, createElement('b', null, count), ' unsaved ', count === 1 ? 'change' : 'changes'),
  unsavedNoCount: 'Unsaved changes',
  saveWith: 'Save with',
  discard: 'Discard',
  apply: 'Apply changes',
}
