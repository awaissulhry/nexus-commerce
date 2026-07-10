/**
 * UFX P7 — IME / dead-key composition guard (audit #76).
 *
 * While an Input Method Editor is composing (Japanese/Chinese/Korean input,
 * macOS press-and-hold accents, dead keys), keydown events must not drive the
 * grid: type-to-edit would swallow the first composed keystroke, and
 * Enter/Tab (candidate confirmation) would commit a half-composed value or
 * move the cell.
 *
 * Detection: `isComposing` is true for keydowns fired between
 * compositionstart/compositionend — EXCEPT the very first keystroke that
 * starts the composition, where Chrome/Safari report the legacy
 * `keyCode === 229` ("KeyProcess") instead. Checking both catches the full
 * composition window, including the Safari quirk where the confirming Enter
 * fires with keyCode 229 right after compositionend.
 *
 * Pure predicate — unit-tested in composition.vitest.test.ts.
 */
export function isComposingKeyEvent(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229
}
