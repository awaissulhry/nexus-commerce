/**
 * A control rendered inside a cell keeps its native keyboard behavior. In
 * particular, AG must not consume Tab before an input can blur and commit.
 * AG's own selection checkbox still uses the engine's keyboard handling.
 */
export function rendererOwnsKeyboard({ event }: { event: KeyboardEvent }): boolean {
  const target = event.target as Element | null
  if (typeof target?.closest !== 'function' || target.closest('.ag-checkbox-input')) return false
  return target.closest('input, textarea, select, button, a[href], [contenteditable="true"], [role="combobox"]') !== null
}
