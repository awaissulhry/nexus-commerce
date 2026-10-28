/**
 * AG.3 — the edit-mode draft diff, shared by both grid engines.
 *
 * This is the half of `editMode` where correctness lives. `onApply` receives `{id, values}` and
 * WRITES them, so a wrong diff is a data bug, not a rendering one: include a field the operator
 * did not touch and the grid overwrites a value nobody chose; drop one they did and the change
 * silently vanishes with the toolbar reporting success either way.
 *
 * The other half — the toolbar, the cell inputs, the hover-edit popover — is rendering, and each
 * engine draws it with its own markup. What must NOT be drawn twice is the answer to "what
 * changed", which is here.
 *
 * ⚠ A field is dirty only when its draft **differs from `initial(row)`**. Typing a value and then
 * typing the original back leaves the row clean. That matters because the toolbar's Apply button
 * is gated on the diff being non-empty: a "dirty" row that is really unchanged makes Apply live
 * for a no-op write, and this codebase treats a write that reports work it did not do as a defect.
 *
 * ⚠ `undefined` in a draft means "never edited" and is NOT the same as `''`. An empty string is a
 * deliberate clearing and must reach `onApply`; that distinction is why the check below is
 * `v !== undefined` and not a truthiness test.
 */
export interface EditField<T> {
  key: string
  initial: (row: T) => string
}

/** `{ [rowId]: { [fieldKey]: draftValue } }` — exactly the shape both engines hold in state. */
export type EditDrafts = Record<string, Record<string, string>>

export interface RowEdit {
  id: string
  values: Record<string, string>
}

/** The value an editor should show: the draft if one exists, otherwise the row's initial. */
export function draftValue<T>(drafts: EditDrafts, id: string, field: EditField<T>, row: T): string {
  return drafts[id]?.[field.key] ?? field.initial(row)
}

/** Every row that has at least one field whose draft differs from its initial. */
export function collectEdits<T>(
  rows: readonly T[],
  rowId: (row: T) => string,
  fields: readonly EditField<T>[],
  drafts: EditDrafts,
): RowEdit[] {
  const out: RowEdit[] = []
  for (const row of rows) {
    const id = rowId(row)
    const d = drafts[id]
    if (!d) continue
    const values: Record<string, string> = {}
    for (const f of fields) {
      const v = d[f.key]
      if (v !== undefined && v !== f.initial(row)) values[f.key] = v
    }
    if (Object.keys(values).length) out.push({ id, values })
  }
  return out
}
