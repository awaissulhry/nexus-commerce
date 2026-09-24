/**
 * R-48 (2026-09-23) — THE ONE KEY LINE every cell editor shows, the same on every kind and every scope.
 *
 * Six wordings said how Enter works before this (`⏎ saves`, `Enter saves`, `Enter applies`, `Enter to apply`, …), one
 * per editor, so the same key read differently depending on which editor happened to open. The value editor
 * (`FormulaCellEditor`, text and number — A-42 step 1 as ruled R-63) shows this line now; the list, axes, sale and
 * Matrix editors move to it as each one moves into the one editor (A-42 steps 2–4).
 *
 * It states the KEYS only. A field's own facts (long text's `Shift+Enter adds a line`, the `=` formula help) stay on
 * that field's help line, so this line can be identical everywhere.
 *
 * 🔴 The words are measured behaviour, not a promise: Enter saves (the editor's own save, `suppressFormulaKeys` gives it
 * the key), Tab saves the reported value and AG moves right, Esc cancels and never writes.
 */
export const EDITOR_KEY_HINT = 'Enter saves · Tab saves and moves right · Esc cancels'
