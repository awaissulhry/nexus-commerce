/**
 * UFX P5 — pure Alt+1..N matcher for the FlatFileMarketStrip market switcher.
 * Matches on the PHYSICAL key (`e.code` Digit1..Digit9) because Option+digit
 * on macOS produces special characters (¡™£¢∞) in `e.key`, so a
 * `parseInt(e.key)` match never fires there. Any other modifier
 * (meta/ctrl/shift) suppresses the shortcut so browser and grid chords are
 * never stomped. Returns the 0-based market index, or null.
 * (Mirrors the Amazon flat file's FF-MS.7 handler.)
 */
export function matchMarketShortcut(
  e: Pick<KeyboardEvent, 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'code'>,
  marketCount: number,
): number | null {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null
  const m = /^Digit([1-9])$/.exec(e.code)
  if (!m) return null
  const idx = Number(m[1]) - 1
  return idx < Math.min(marketCount, 9) ? idx : null
}
